/**
 * Re-link outbound upload attachments to the sent message (decision 12).
 *
 * When an O365 email composed via our compose route is delivered, the hub emits
 * `communication_channels.message.sent` for the outbound MessageChannelLink. The link's
 * `channelMetadata.attachments` carries the same refs we sent. Here we move those uploaded
 * `Attachment` rows from the pending state to the message link (entityId + recordId), so they
 * surface in the existing communication history + "Załączniki e-mail" tab via the shared loader —
 * no separate outbound mechanism.
 *
 * Keeping this in a subscriber (not the adapter) preserves the dumb-adapter boundary. Idempotent:
 * the update is keyed by attachment id and writes the same target on retry.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { MessageChannelLink } from '@open-mercato/core/modules/communication_channels/data/entities'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import { O365_MAIL_PROVIDER_KEY } from '../lib/credentials'
import { MESSAGE_LINK_ENTITY_ID, EMAIL_OUTBOUND_ATTACHMENTS_PARTITION } from '../lib/email-attachments'
import { parseMailAttachmentRefs } from '../../mail_attachments/lib/types'

type SubscriberContext = { resolve: <T = unknown>(name: string) => T }

type MessageSentPayload = {
  channelLinkId?: string
  providerKey?: string
  tenantId?: string
  organizationId?: string | null
}

export const metadata = {
  event: 'communication_channels.message.sent',
  persistent: true,
  id: 'channel_office365.link-sent-attachments',
}

export default async function handler(payload: MessageSentPayload, ctx: SubscriberContext): Promise<void> {
  if (payload.providerKey !== O365_MAIL_PROVIDER_KEY) return
  if (!payload.channelLinkId || !payload.tenantId) return

  const em = (ctx.resolve('em') as EntityManager).fork()
  const link = await em.findOne(MessageChannelLink, { id: payload.channelLinkId })
  if (!link) return

  const meta = (link.channelMetadata ?? null) as Record<string, unknown> | null
  const refs = parseMailAttachmentRefs(meta?.attachments)
  if (refs.length === 0) return

  // Re-home only OUR pending outbound uploads (scoped by partition + tenant), so we never touch
  // inbound synced attachments or another tenant's rows.
  for (const ref of refs) {
    await em.nativeUpdate(
      Attachment,
      { id: ref.id, tenantId: payload.tenantId, partitionCode: EMAIL_OUTBOUND_ATTACHMENTS_PARTITION },
      { entityId: MESSAGE_LINK_ENTITY_ID, recordId: link.id },
    )
  }
}
