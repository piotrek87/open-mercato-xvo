import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { o365ChannelStateSchema, o365UserCredentialsSchema, O365_PROVIDER_KEY, O365_MAIL_PROVIDER_KEY, O365_MAIL_READ_SCOPE, O365_INTEGRATION_ID } from '../../../lib/credentials'
import { provisionEmailChannel } from '../../../lib/email-channel-provisioner'

type CredentialsServiceLike = {
  resolve: (integrationId: string, scope: { tenantId: string; organizationId: string; userId: string | null }) => Promise<unknown>
}

export const metadata = {
  PATCH: { requireAuth: true, requireFeatures: ['channel_office365.configure'] },
}

const capabilitiesBodySchema = z.object({
  channelId: z.string().uuid(),
  capability: z.enum(['calendar', 'mail']),
  enabled: z.boolean(),
})

export async function PATCH(request: Request): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const auth = await getAuthFromRequest(request)
    if (!auth?.sub || !auth?.tenantId) {
      return NextResponse.json(
        { error: translate('channel_office365.errors.unauthorized', 'Unauthorized') },
        { status: 401 },
      )
    }

    const text = await request.text()
    const rawBody = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {}
    const body = capabilitiesBodySchema.parse(rawBody)

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    let credentialsService: CredentialsServiceLike | null = null
    try {
      credentialsService = container.resolve<CredentialsServiceLike>('integrationCredentialsService')
    } catch { /* optional — graceful degradation if not registered */ }

    const channel = await em.findOne(CommunicationChannel, {
      id: body.channelId,
      tenantId: auth.tenantId as string,
      userId: auth.sub as string,
      providerKey: O365_PROVIDER_KEY,
      deletedAt: null,
    })
    if (!channel) {
      return NextResponse.json(
        { error: translate('channel_office365.errors.channelNotFound', 'Channel not found') },
        { status: 404 },
      )
    }

    // Guard: enabling mail requires Mail.ReadWrite scope in grantedScopes
    if (body.capability === 'mail' && body.enabled) {
      const parsed = o365ChannelStateSchema.safeParse(channel.channelState ?? {})
      const state = parsed.success ? parsed.data : {}
      let grantedScopes = state.grantedScopes ?? []

      // grantedScopes is only written to channelState after the first calendar sync.
      // Fall back to reading from credentials so the Enable button works immediately
      // after a fresh OAuth connect, before any sync has run.
      if (grantedScopes.length === 0 && credentialsService) {
        try {
          const rawCreds = await credentialsService.resolve(O365_INTEGRATION_ID, {
            tenantId: auth.tenantId as string,
            organizationId: (auth as { orgId?: string | null }).orgId ?? auth.tenantId as string,
            userId: auth.sub as string,
          })
          const credParsed = o365UserCredentialsSchema.safeParse(rawCreds)
          if (credParsed.success) {
            const rawScopes = (credParsed.data as Record<string, unknown>).grantedScopes
            if (Array.isArray(rawScopes)) {
              grantedScopes = rawScopes as string[]
            }
          }
        } catch { /* non-fatal */ }
      }

      if (!grantedScopes.includes(O365_MAIL_READ_SCOPE)) {
        return NextResponse.json(
          { error: translate('channel_office365.errors.missingMailScope', 'Mail.ReadWrite scope not granted — reconnect first') },
          { status: 422 },
        )
      }
    }

    // Apply capability toggle to channelState
    const rawState = (channel.channelState as Record<string, unknown> | null) ?? {}
    const parsedState = o365ChannelStateSchema.safeParse(rawState)
    const currentState = parsedState.success ? parsedState.data : {}
    const existingCaps = (rawState.capabilities as Record<string, unknown> | undefined) ?? {}
    const existingCapForKey = (existingCaps[body.capability] as Record<string, unknown> | undefined) ?? {}

    // When enabling calendar for the first time (no syncFromDate set), default to 1 day back so
    // the worker syncs recent events only. The user widens the window via the date picker + Sync.
    const CALENDAR_LOOKBACK_DAYS = 1
    const syncFromDatePatch: Record<string, unknown> = {}
    if (body.capability === 'calendar' && body.enabled && !existingCapForKey.syncFromDate) {
      syncFromDatePatch.syncFromDate = new Date(Date.now() - CALENDAR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
    }

    const newCapabilities = {
      ...existingCaps,
      [body.capability]: {
        ...existingCapForKey,
        ...syncFromDatePatch,
        enabled: body.enabled,
      },
    }
    channel.channelState = {
      ...rawState,
      capabilities: newCapabilities,
      grantedScopes: currentState.grantedScopes ?? [],
    }

    // Keep the calendar channel polling (isActive=true) as long as any capability is active.
    // The poll cycle refreshes OAuth tokens via calendarAdapter.refreshCredentials — when only
    // mail sync is on, calendar polling is still required so email credentials (resolved via
    // bundleId fallback channel_office365_mail → channel_office365) stay current.
    const calCap = (newCapabilities.calendar as { enabled?: boolean } | undefined)?.enabled ?? false
    const mailCap = (newCapabilities.mail as { enabled?: boolean } | undefined)?.enabled ?? false
    channel.isActive = calCap || mailCap
    // If we are re-activating the calendar channel after it was marked requires_reauth,
    // reset status to 'connected' so poll-tick includes it in normal polling.
    // (poll-tick skips requires_reauth channels — they need OAuth reconnect otherwise.)
    if (channel.isActive && channel.status === 'requires_reauth') {
      channel.status = 'connected'
    }

    await em.flush()

    // When toggling mail capability, sync the email channel's isActive state.
    // The hub only polls channels where isActive=true, so this is the canonical on/off switch.
    if (body.capability === 'mail' && channel.userId) {
      const mailScope = {
        tenantId: auth.tenantId as string,
        organizationId: (auth as { orgId?: string | null }).orgId ?? null,
      }
      try {
        if (body.enabled) {
          // Provision if not yet created, then activate
          await provisionEmailChannel({ em, userId: channel.userId, scope: mailScope })
        }
        // Find the email channel and set isActive accordingly
        const emailChannel = await em.findOne(CommunicationChannel, {
          tenantId: auth.tenantId as string,
          userId: channel.userId,
          providerKey: O365_MAIL_PROVIDER_KEY,
          deletedAt: null,
        })
        if (emailChannel) {
          emailChannel.isActive = body.enabled
          emailChannel.status = body.enabled ? 'connected' : 'disconnected'
          await em.flush()
        }
      } catch (mailErr) {
        console.warn(
          '[channel_office365] mail channel isActive sync failed:',
          mailErr instanceof Error ? mailErr.message : mailErr,
        )
      }
    }

    const updatedParsed = o365ChannelStateSchema.safeParse(channel.channelState)
    const capabilities = updatedParsed.success
      ? (updatedParsed.data.capabilities ?? {})
      : {}

    return NextResponse.json({ capabilities }, { status: 200 })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.issues }, { status: 400 })
    }
    console.error('[channel_office365] capabilities.patch failed', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    PATCH: {
      summary: 'Toggle a capability (calendar/mail) on a connected Microsoft 365 channel',
      tags: ['channel_office365'],
      requestBody: {
        schema: capabilitiesBodySchema,
      },
      responses: [
        {
          status: 200,
          description: 'Capability updated',
          schema: z.object({
            capabilities: z.record(z.string(), z.unknown()),
          }),
        },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Channel not found' },
        { status: 422, description: 'Missing required OAuth scope' },
      ],
    },
  },
}
