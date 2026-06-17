import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { o365ChannelStateSchema, O365_PROVIDER_KEY } from '../../../lib/credentials'
import { getO365MailSyncQueue } from '../../../lib/queue'
import type { MailSyncJobPayload } from '../../../workers/mail-sync'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['channel_office365.view'] },
}

const mailSyncBodySchema = z.object({
  channelId: z.string().uuid(),
  syncFromDate: z.string().datetime({ offset: true }).optional(),
  resetDelta: z.boolean().optional(),
})

export async function POST(request: Request): Promise<Response> {
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
    const body = mailSyncBodySchema.parse(rawBody)

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
    if (!channel.isActive) {
      return NextResponse.json(
        { error: translate('channel_office365.errors.channelDisabled', 'Channel is disabled') },
        { status: 409 },
      )
    }
    if (channel.status === 'requires_reauth') {
      return NextResponse.json(
        { error: translate('channel_office365.errors.requiresReauth', 'Channel requires reauthentication') },
        { status: 409 },
      )
    }

    // Verify mail capability is enabled before queuing
    const parsedState = o365ChannelStateSchema.safeParse(channel.channelState ?? {})
    const state = parsedState.success ? parsedState.data : {}
    if (state.capabilities?.mail?.enabled !== true) {
      return NextResponse.json(
        { error: translate('channel_office365.errors.channelDisabled', 'Email sync is not enabled for this channel') },
        { status: 409 },
      )
    }

    // Reset delta cursors + apply syncFromDate when requested
    if (body.resetDelta || body.syncFromDate) {
      const rawState = (channel.channelState as Record<string, unknown> | null) ?? {}
      const existingCaps = (rawState.capabilities as Record<string, unknown> | undefined) ?? {}
      const existingMailCap = (existingCaps.mail as Record<string, unknown> | undefined) ?? {}
      channel.channelState = {
        ...rawState,
        capabilities: {
          ...existingCaps,
          mail: {
            ...existingMailCap,
            ...(body.resetDelta ? { deltaToken: undefined, sentItemsDeltaToken: undefined } : {}),
            ...(body.syncFromDate ? { syncFromDate: body.syncFromDate } : {}),
          },
        },
      }
      await em.flush()
    }

    const queue = getO365MailSyncQueue<MailSyncJobPayload>()
    await queue.enqueue({ channelId: body.channelId } as unknown as Record<string, unknown>)

    return NextResponse.json({ queued: 1 }, { status: 202 })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.issues }, { status: 400 })
    }
    console.error('[channel_office365] mail-sync.post failed', error)
    return NextResponse.json(
      { error: translate('channel_office365.errors.mailSyncFailed', 'Failed to enqueue mail sync job') },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    POST: {
      summary: 'Manually trigger email sync for a connected Office 365 channel',
      tags: ['channel_office365'],
      requestBody: {
        schema: mailSyncBodySchema,
      },
      responses: [
        {
          status: 202,
          description: 'Mail sync job accepted',
          schema: z.object({ queued: z.number().int().nonnegative() }),
        },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Channel not found' },
        { status: 409, description: 'Channel disabled, requires reauth, or mail not enabled' },
      ],
    },
  },
}
