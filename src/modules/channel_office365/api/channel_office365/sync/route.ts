import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { O365_PROVIDER_KEY } from '../../../lib/credentials'
import { getO365CalendarSyncQueue } from '../../../lib/queue'
import type { CalendarSyncJobPayload } from '../../../workers/calendar-sync'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['channel_office365.view'] },
}

const syncBodySchema = z.object({
  channelId: z.string().uuid(),
  syncFromDate: z.string().datetime({ offset: true }).optional(),
  resetDelta: z.boolean().optional(),
})

export async function POST(request: Request) {
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
    const body = syncBodySchema.parse(rawBody)

    // Verify the channel belongs to the current user and is an O365 calendar channel
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

    // Reset delta + apply syncFromDate when requested
    if (body.resetDelta || body.syncFromDate) {
      const rawState = (channel.channelState as Record<string, unknown> | null) ?? {}
      const existingCaps = (rawState.capabilities as Record<string, unknown> | undefined) ?? {}
      const existingCalCap = (existingCaps.calendar as Record<string, unknown> | undefined) ?? {}
      channel.channelState = {
        ...rawState,
        capabilities: {
          ...existingCaps,
          calendar: {
            ...existingCalCap,
            ...(body.resetDelta ? { deltaToken: undefined } : {}),
            ...(body.syncFromDate ? { syncFromDate: body.syncFromDate } : {}),
          },
        },
      }
      await em.flush()
    }

    const queue = getO365CalendarSyncQueue<CalendarSyncJobPayload>()
    await queue.enqueue({ channelId: body.channelId } as unknown as Record<string, unknown>)

    return NextResponse.json({ queued: 1 }, { status: 202 })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.issues }, { status: 400 })
    }
    console.error('[channel_office365] sync.post failed', error)
    return NextResponse.json(
      { error: translate('channel_office365.errors.syncFailed', 'Failed to enqueue sync job') },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    POST: {
      summary: 'Manually trigger calendar sync for a connected Office 365 channel',
      tags: ['channel_office365'],
      requestBody: {
        schema: syncBodySchema,
      },
      responses: [
        {
          status: 202,
          description: 'Sync job accepted',
          schema: z.object({ queued: z.number().int().nonnegative() }),
        },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Channel not found' },
        { status: 409, description: 'Channel disabled or requires reauth' },
      ],
    },
  },
}
