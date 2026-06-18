/**
 * POST /api/channel_office365/channel_office365/reset-data
 *
 * Deletes all O365-synced calendar and mail data for a single channel:
 *   - Activities (external_provider = office365_calendar | office365_mail)
 *   - ActivityLinks for those activities
 *   - CustomerInteractions (source LIKE 'office365:%')
 *   - MessageChannelLinks → Messages → ExternalConversations for this channel
 *   - Resets delta token cursors in channel_state so next sync starts fresh
 *
 * Does NOT touch persons, companies, deals, or any other CRM records.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { O365_PROVIDER_KEY, O365_EXTERNAL_PROVIDER_CALENDAR, O365_EXTERNAL_PROVIDER_MAIL } from '../../../lib/credentials'

const bodySchema = z.object({
  channelId: z.string().uuid(),
})

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['channel_office365.view'] },
}

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
    const body = bodySchema.parse(rawBody)

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

    const conn = em.getConnection()
    const tenantId = auth.tenantId as string
    const userId = auth.sub as string

    // 1. Delete MessageChannelLinks for messages in this channel's conversations
    await conn.execute(
      `DELETE FROM message_channel_links
       WHERE message_id IN (
         SELECT m.id FROM messages m
         JOIN external_conversations ec ON ec.id = m.thread_id
         WHERE ec.channel_id = ? AND ec.tenant_id = ?
       )`,
      [body.channelId, tenantId],
    )

    // 2. Delete Messages in this channel's conversations
    await conn.execute(
      `DELETE FROM messages
       WHERE thread_id IN (
         SELECT id FROM external_conversations
         WHERE channel_id = ? AND tenant_id = ?
       )`,
      [body.channelId, tenantId],
    )

    // 3. Delete ExternalConversations for this channel
    await conn.execute(
      `DELETE FROM external_conversations
       WHERE channel_id = ? AND tenant_id = ?`,
      [body.channelId, tenantId],
    )

    // 4. Delete CustomerInteractions synced by O365 for this user
    // owner_user_id + tenant_id + source pattern is sufficient for safe scoping
    await conn.execute(
      `DELETE FROM customer_interactions
       WHERE source LIKE 'office365:%'
         AND owner_user_id = ?
         AND tenant_id = ?`,
      [userId, tenantId],
    )

    // 5. Delete ActivityLinks for O365 activities owned by this user
    await conn.execute(
      `DELETE FROM activity_links
       WHERE activity_id IN (
         SELECT id FROM activities
         WHERE external_provider IN (?, ?)
           AND owner_user_id = ?
           AND tenant_id = ?
       )`,
      [O365_EXTERNAL_PROVIDER_CALENDAR, O365_EXTERNAL_PROVIDER_MAIL, userId, tenantId],
    )

    // 6. Delete Activities synced by O365 for this user
    await conn.execute(
      `DELETE FROM activities
       WHERE external_provider IN (?, ?)
         AND owner_user_id = ?
         AND tenant_id = ?`,
      [O365_EXTERNAL_PROVIDER_CALENDAR, O365_EXTERNAL_PROVIDER_MAIL, userId, tenantId],
    )

    // 7. Reset delta token cursors so next sync fetches from scratch
    const rawState = (channel.channelState as Record<string, unknown> | null) ?? {}
    const existingCaps = (rawState.capabilities as Record<string, unknown> | undefined) ?? {}
    const calCap = (existingCaps.calendar as Record<string, unknown> | undefined) ?? {}
    const mailCap = (existingCaps.mail as Record<string, unknown> | undefined) ?? {}

    channel.channelState = {
      ...rawState,
      capabilities: {
        ...existingCaps,
        calendar: {
          ...calCap,
          deltaToken: undefined,
        },
        mail: {
          ...mailCap,
          deltaToken: undefined,
          sentItemsDeltaToken: undefined,
        },
      },
    }
    await em.flush()

    return NextResponse.json({ cleared: true }, { status: 200 })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.issues }, { status: 400 })
    }
    console.error('[channel_office365] reset-data.post failed', error)
    return NextResponse.json(
      { error: translate('channel_office365.errors.resetFailed', 'Failed to reset sync data') },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    POST: {
      summary: 'Delete all O365-synced calendar/mail data and reset delta cursors for a channel',
      tags: ['channel_office365'],
      requestBody: { schema: bodySchema },
      responses: [
        { status: 200, description: 'Sync data cleared', schema: z.object({ cleared: z.boolean() }) },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Channel not found' },
      ],
    },
  },
}
