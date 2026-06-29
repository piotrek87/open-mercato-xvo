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
import {
  O365_PROVIDER_KEY,
  O365_MAIL_PROVIDER_KEY,
  O365_EXTERNAL_PROVIDER_CALENDAR,
  O365_EXTERNAL_PROVIDER_MAIL,
} from '../../../lib/credentials'

const bodySchema = z.object({
  channelId: z.string().uuid(),
  // Which synced data to wipe. Defaults to 'all' for backward compatibility with callers
  // that omit it. 'calendar' clears only meetings; 'mail' clears only emails — so resetting
  // one channel no longer destroys the other's synced data.
  target: z.enum(['calendar', 'mail', 'all']).optional().default('all'),
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

    // Accept a calendar OR mail channel id; find the anchor channel (may be deleted)
    const channel = await em.findOne(
      CommunicationChannel,
      {
        id: body.channelId,
        tenantId: auth.tenantId as string,
        userId: auth.sub as string,
        providerKey: { $in: [O365_PROVIDER_KEY, O365_MAIL_PROVIDER_KEY] as string[] },
      },
      { filters: { softDelete: false } },
    )
    if (!channel) {
      return NextResponse.json(
        { error: translate('channel_office365.errors.channelNotFound', 'Channel not found') },
        { status: 404 },
      )
    }

    const conn = em.getConnection()
    const tenantId = auth.tenantId as string
    const userId = auth.sub as string
    const wipeMail = body.target === 'all' || body.target === 'mail'
    const wipeCalendar = body.target === 'all' || body.target === 'calendar'

    // Collect ALL O365 channel ids for this user (calendar + mail, including deleted)
    // so we can wipe messages from both channel_thread_mappings paths.
    const allChannels = await em.find(
      CommunicationChannel,
      {
        tenantId,
        userId,
        providerKey: { $in: [O365_PROVIDER_KEY, O365_MAIL_PROVIDER_KEY] as string[] },
      },
      { filters: { softDelete: false } },
    )
    const allChannelIds = allChannels.map(c => c.id)

    // ── Mail-only artifacts (messages, conversations, mappings) ─────────────────
    if (wipeMail) {
      // 1. Delete MessageChannelLinks directly by provider_key (catches orphans too)
      await conn.execute(
        `DELETE FROM message_channel_links
         WHERE provider_key IN (?, ?) AND tenant_id = ?`,
        [O365_PROVIDER_KEY, O365_MAIL_PROVIDER_KEY, tenantId],
      )

      if (allChannelIds.length > 0) {
        const placeholders = allChannelIds.map(() => '?').join(', ')

        // 2. Delete Messages linked via channel_thread_mappings (hub email path)
        await conn.execute(
          `DELETE FROM messages
           WHERE thread_id IN (
             SELECT DISTINCT message_thread_id FROM channel_thread_mappings
             WHERE channel_id IN (${placeholders}) AND tenant_id = ?
           )`,
          [...allChannelIds, tenantId],
        )

        // 3. Delete ChannelThreadMappings
        await conn.execute(
          `DELETE FROM channel_thread_mappings
           WHERE channel_id IN (${placeholders}) AND tenant_id = ?`,
          [...allChannelIds, tenantId],
        )

        // 4. Delete ExternalMessages
        await conn.execute(
          `DELETE FROM external_messages
           WHERE channel_id IN (${placeholders}) AND tenant_id = ?`,
          [...allChannelIds, tenantId],
        )

        // 5. Delete ExternalConversations
        await conn.execute(
          `DELETE FROM external_conversations
           WHERE channel_id IN (${placeholders}) AND tenant_id = ?`,
          [...allChannelIds, tenantId],
        )
      }
    }

    // 6. Delete CustomerInteractions synced by O365, scoped to the target.
    // owner_user_id can be NULL (email CIs from crm-email-linker) — do NOT filter by it.
    // Source patterns ('office365:mail:%' / 'office365:calendar:%') precisely partition the
    // two kinds so a scoped reset never touches the other.
    if (wipeMail && wipeCalendar) {
      await conn.execute(
        `DELETE FROM customer_interactions
         WHERE tenant_id = ?
           AND (source LIKE 'office365:%' OR channel_provider_key IN (?, ?))`,
        [tenantId, O365_PROVIDER_KEY, O365_MAIL_PROVIDER_KEY],
      )
    } else if (wipeMail) {
      await conn.execute(
        `DELETE FROM customer_interactions
         WHERE tenant_id = ? AND source LIKE 'office365:mail:%'`,
        [tenantId],
      )
    } else if (wipeCalendar) {
      await conn.execute(
        `DELETE FROM customer_interactions
         WHERE tenant_id = ? AND source LIKE 'office365:calendar:%'`,
        [tenantId],
      )
    }

    // 7-8. Delete Activities (+ their ActivityLinks) for the targeted provider(s).
    const activityProviders: string[] = []
    if (wipeCalendar) activityProviders.push(O365_EXTERNAL_PROVIDER_CALENDAR)
    if (wipeMail) activityProviders.push(O365_EXTERNAL_PROVIDER_MAIL)
    if (activityProviders.length > 0) {
      const provPlaceholders = activityProviders.map(() => '?').join(', ')
      await conn.execute(
        `DELETE FROM activity_links
         WHERE activity_id IN (
           SELECT id FROM activities
           WHERE external_provider IN (${provPlaceholders})
             AND tenant_id = ?
         )`,
        [...activityProviders, tenantId],
      )
      await conn.execute(
        `DELETE FROM activities
         WHERE external_provider IN (${provPlaceholders})
           AND tenant_id = ?`,
        [...activityProviders, tenantId],
      )
    }

    // 9. Reset delta cursors so the next sync re-bootstraps. The two providers store their
    // cursor in DIFFERENT places, so reset each in its own shape:
    //   - calendar channel (office365): cursor lives in channelState.capabilities.calendar.deltaToken
    //   - mail channel (office365_mail): the hub adapter (graph-mail-adapter) keeps its cursor at
    //     TOP LEVEL — channelState.inbox / .sentItems / .syncFromDate. Clearing capabilities.mail
    //     here (the previous behavior) left the real delta token untouched, so a re-enabled mailbox
    //     polled with the stale delta and re-fetched nothing. Strip inbox/sentItems, keep syncFromDate.
    for (const ch of allChannels) {
      const rawState = (ch.channelState as Record<string, unknown> | null) ?? {}
      if (ch.providerKey === O365_MAIL_PROVIDER_KEY) {
        if (wipeMail) {
          // Full wipe = fresh start: clear the cursor AND syncFromDate so the next enable
          // applies the default look-back window (provisioner sets now − 7 days) instead of
          // re-using a stale syncFromDate. The page healing re-provision preserves syncFromDate
          // only when it already exists, so dropping it here is what lets "re-enable" mean
          // "sync the last 7 days" as agreed.
          ch.channelState = {}
        }
        continue
      }
      // Calendar channel — reset only the targeted capability(ies); keep the other's state intact.
      const existingCaps = (rawState.capabilities as Record<string, unknown> | undefined) ?? {}
      const newCaps: Record<string, unknown> = { ...existingCaps }
      if (wipeCalendar) newCaps.calendar = { enabled: false, deltaToken: undefined }
      if (wipeMail) newCaps.mail = { enabled: false, deltaToken: undefined, sentItemsDeltaToken: undefined }
      ch.channelState = { ...rawState, capabilities: newCaps }
    }

    // 10. Deactivate the email channel so the hub stops polling — only when wiping mail.
    if (wipeMail) {
      const mailChannels = await em.find(
        CommunicationChannel,
        {
          tenantId,
          userId,
          providerKey: O365_MAIL_PROVIDER_KEY,
          deletedAt: null,
        },
      )
      for (const mc of mailChannels) {
        mc.isActive = false
        mc.status = 'disconnected' as typeof mc.status
      }
    }

    await em.flush()

    return NextResponse.json({ cleared: true, target: body.target }, { status: 200 })
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
        { status: 200, description: 'Sync data cleared', schema: z.object({ cleared: z.boolean(), target: z.enum(['calendar', 'mail', 'all']) }) },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Channel not found' },
      ],
    },
  },
}
