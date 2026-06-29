import type { EntityManager } from '@mikro-orm/postgresql'
import { O365_MAIL_PROVIDER_KEY, O365_PROVIDER_KEY } from '../lib/credentials'

type SubscriberContext = { resolve: <T = unknown>(name: string) => T }

type ChannelDeletedPayload = {
  channelId: string
  providerKey?: string
  userId?: string
  tenantId: string
  organizationId?: string | null
}

export const metadata = {
  event: 'communication_channels.channel.deleted',
  persistent: false,
  id: 'channel_office365.channel-disconnect-cascade',
}

/**
 * When the office365 calendar channel is disconnected, cascade to the sibling
 * office365_mail email channel so the next M365 OAuth connect flow can proceed
 * without hitting the "mailbox_already_connected" guard.
 *
 * Also clears pending communication-channels-poll queue jobs for the deleted
 * channel so the worker stops importing emails immediately.
 */
export default async function handler(
  payload: ChannelDeletedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  // Resolve providerKey from payload or look it up from the DB
  let providerKey = payload.providerKey
  let userId = payload.userId

  if (!providerKey || !userId) {
    const em = (ctx.resolve('em') as EntityManager).fork()
    const rows = (await em.getConnection().execute(
      `SELECT provider_key, user_id FROM communication_channels WHERE id = ? LIMIT 1`,
      [payload.channelId],
    )) as Array<{ provider_key: string; user_id: string }>
    if (!rows[0]) return
    providerKey = rows[0].provider_key
    userId = rows[0].user_id
  }

  // Cascade in both directions: calendar↔email are siblings
  const siblingProviderKey =
    providerKey === O365_PROVIDER_KEY ? O365_MAIL_PROVIDER_KEY : O365_PROVIDER_KEY

  const em = (ctx.resolve('em') as EntityManager).fork()
  const now = new Date()

  // Soft-delete the sibling channel for the same user/tenant
  const result = (await em.getConnection().execute(
    `UPDATE communication_channels
     SET deleted_at = ?, is_active = false, updated_at = ?
     WHERE provider_key = ?
       AND user_id = ?
       AND tenant_id = ?
       AND deleted_at IS NULL`,
    [now, now, siblingProviderKey, userId, payload.tenantId],
  )) as { affectedRows?: number; rowCount?: number }

  const affected = result.affectedRows ?? result.rowCount ?? 0
  if (affected > 0) {
    console.log(
      `[channel_office365:channel-disconnect-cascade] Cascade-deleted ${affected} ${siblingProviderKey} channel(s) for user ${userId}`,
    )
  }

  // Clear pending poll jobs for this channel from the file-based queue
  // so the worker stops importing emails immediately after disconnect.
  try {
    const { readFileSync, writeFileSync, existsSync } = await import('fs')
    const queuePath = '.mercato/queue/communication-channels-poll/queue.json'
    if (existsSync(queuePath)) {
      const jobs = JSON.parse(readFileSync(queuePath, 'utf-8')) as Array<{ data?: { channelId?: string } }>
      const remaining = jobs.filter((j) => j.data?.channelId !== payload.channelId)
      if (remaining.length < jobs.length) {
        writeFileSync(queuePath, JSON.stringify(remaining, null, 2), 'utf-8')
        console.log(
          `[channel_office365:channel-disconnect-cascade] Removed ${jobs.length - remaining.length} queued poll job(s) for channel ${payload.channelId}`,
        )
      }
    }
  } catch {
    // Non-critical — the worker skips deleted channels anyway
  }
}
