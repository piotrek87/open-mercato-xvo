/**
 * Suppresses outbound email delivery for inbound O365 mail messages.
 *
 * When the hub ingests an email it creates a Message with visibility='public',
 * which forces messages.js to set send_via_email=true regardless of the
 * sendViaEmail:false flag passed by ingest-inbound-message. The send-email
 * worker then tries to relay the email back to the contact (who already sent
 * it) and fails with RESEND_API_KEY errors.
 *
 * This subscriber fires immediately after ingestion, sets send_via_email=false
 * and pre-fills external_email_sent_at so the worker's claim check fails
 * (WHERE external_email_sent_at IS NULL) and the job is silently skipped.
 * It also pre-fills message_recipients.email_sent_at for any assigned users.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { O365_MAIL_PROVIDER_KEY } from '../lib/credentials'

interface MessageReceivedPayload {
  messageId: string
  direction: string
  providerKey: string
  tenantId: string
  organizationId: string | null
}

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
}

export const metadata = {
  event: 'communication_channels.message.received',
  // persistent: false = runs synchronously in-process when the event fires,
  // without going through the events queue. This gives us a chance to set
  // external_email_sent_at BEFORE the messages-email queue worker picks up the job.
  persistent: false,
  id: 'channel_office365:suppress-inbound-email-send',
}

export default async function handler(
  payload: MessageReceivedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  if (payload.direction !== 'inbound' || payload.providerKey !== O365_MAIL_PROVIDER_KEY) {
    return
  }

  const em = (ctx.resolve('em') as EntityManager).fork()
  const conn = em.getConnection()

  // Poison the external email delivery claim so the worker finds
  // external_email_sent_at IS NOT NULL and returns early without sending.
  // Also clear send_via_email for data model correctness.
  await conn.execute(
    `UPDATE messages
     SET send_via_email = false,
         external_email_sent_at = NOW()
     WHERE id = ?
       AND tenant_id = ?
       AND external_email_sent_at IS NULL`,
    [payload.messageId, payload.tenantId],
  )

  // Poison recipient delivery claims for any assigned users.
  await conn.execute(
    `UPDATE message_recipients
     SET email_sent_at = NOW()
     WHERE message_id = ?
       AND email_sent_at IS NULL`,
    [payload.messageId],
  )
}
