import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { o365ChannelStateSchema, O365_PROVIDER_KEY, O365_MAIL_READ_SCOPE } from '../../../lib/credentials'

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
      const grantedScopes = state.grantedScopes ?? []
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

    channel.channelState = {
      ...rawState,
      capabilities: {
        ...existingCaps,
        [body.capability]: {
          ...existingCapForKey,
          enabled: body.enabled,
        },
      },
      grantedScopes: currentState.grantedScopes ?? [],
    }
    await em.flush()

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
