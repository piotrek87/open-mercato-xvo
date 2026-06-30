/**
 * Discard outbound upload attachments once the message is sent (dedup — supersedes decision 12's
 * re-home).
 *
 * When an O365 email composed via our compose route is delivered, the hub emits
 * `communication_channels.message.sent` for the outbound MessageChannelLink. The link's
 * `channelMetadata.attachments` carries the refs we sent. The Microsoft 365 "Sent Items" sync then
 * re-ingests that sent message and stores the CANONICAL attachment copy (partition
 * `email_attachments`) linked to the message — so re-homing our own pending upload would leave TWO
 * rows + two files for one sent attachment (the duplication the user hit). Instead we DELETE our
 * pending upload (file best-effort, then row) and let the sync be the single source of truth.
 *
 * Scope: only OUR pending uploads (partition `email_outbound_attachments` + `pending_upload`
 * entity). Refs that point at existing CRM attachments (the "Attach from OM" picker) are not pending
 * uploads, so they are left untouched. Keeping this in a subscriber preserves the dumb-adapter
 * boundary. Idempotent: a retry simply finds nothing to delete.
 *
 * Trade-off (accepted): the attachment surfaces in the "Załączniki e-mail" tab after the next Sent
 * Items sync (seconds–minutes), not instantly.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import type { FilterQuery } from '@mikro-orm/core'
import { MessageChannelLink } from '@open-mercato/core/modules/communication_channels/data/entities'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import { deletePartitionFile } from '@open-mercato/core/modules/attachments/lib/storage'
import { O365_MAIL_PROVIDER_KEY } from '../lib/credentials'
import { EMAIL_OUTBOUND_ATTACHMENTS_PARTITION } from '../lib/email-attachments'
import { PENDING_UPLOAD_ENTITY_ID } from '../../mail_attachments/lib/cleanup'
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

  // Delete only OUR still-pending outbound uploads (scoped by partition + pending entity + tenant) so
  // we never touch inbound/synced attachments, the "Attach from OM" picker's existing rows, or
  // another tenant's data. The Sent Items sync owns the canonical copy.
  for (const ref of refs) {
    const att = await em.findOne(Attachment, {
      id: ref.id,
      tenantId: payload.tenantId,
      partitionCode: EMAIL_OUTBOUND_ATTACHMENTS_PARTITION,
      entityId: PENDING_UPLOAD_ENTITY_ID,
    } as FilterQuery<Attachment>)
    if (!att) continue
    try {
      await deletePartitionFile(att.partitionCode, att.storagePath, att.storageDriver ?? undefined)
    } catch {
      // best-effort: a missing file must not block row cleanup
    }
    await em.nativeDelete(Attachment, { id: att.id } as FilterQuery<Attachment>)
  }
}
