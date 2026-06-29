import type { EntityManager } from '@mikro-orm/postgresql'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import type { EmailAttachmentFile } from './email-attachments-shape'

export type { EmailAttachmentFile } from './email-attachments-shape'

/** Entity key the email-attachment-fetcher uses when persisting downloaded files. */
export const MESSAGE_LINK_ENTITY_ID = 'communication_channels:message_channel_link'
export const EMAIL_ATTACHMENTS_PARTITION = 'email_attachments'

/**
 * Batch-load stored (downloadable) email attachments for a set of
 * MessageChannelLink ids, keyed by linkId.
 *
 * Only files the fetcher actually stored exist as `Attachment` rows (it persists
 * a row only for `status='stored'`), so inline images / too-large / failed
 * fetches are naturally excluded — the caller gets exactly the downloadable,
 * non-inline files with no extra filtering.
 */
export async function loadAttachmentsForLinkIds(
  em: EntityManager,
  linkIds: string[],
  scope: { tenantId: string },
): Promise<Map<string, EmailAttachmentFile[]>> {
  const map = new Map<string, EmailAttachmentFile[]>()
  if (linkIds.length === 0) return map
  const rows = await em.find(
    Attachment,
    {
      entityId: MESSAGE_LINK_ENTITY_ID,
      recordId: { $in: linkIds },
      partitionCode: EMAIL_ATTACHMENTS_PARTITION,
      tenantId: scope.tenantId,
    },
    { orderBy: { fileName: 'asc' } },
  )
  for (const a of rows) {
    const list = map.get(a.recordId) ?? []
    list.push({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      fileSize: a.fileSize,
      url: `/api/attachments/file/${a.id}`,
    })
    map.set(a.recordId, list)
  }
  return map
}
