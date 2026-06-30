/**
 * TTL cleanup for unsent outbound uploads (decision 11 — TTL, no drafts).
 *
 * A file uploaded for a compose that was never sent stays in partition `email_outbound_attachments`
 * with `entityId = 'mail_attachments:pending_upload'` (the link-sent subscriber re-homes it to the
 * MessageChannelLink on send). This sweep deletes pending uploads older than the TTL — files first
 * (best-effort), then rows. Idempotent and tenant-scopable. Scheduling is an ops concern (cron /
 * scheduler module invoking the `cleanup-uploads` CLI).
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import type { FilterQuery } from '@mikro-orm/core'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import { deletePartitionFile } from '@open-mercato/core/modules/attachments/lib/storage'

export const OUTBOUND_UPLOAD_PARTITION = 'email_outbound_attachments'
export const PENDING_UPLOAD_ENTITY_ID = 'mail_attachments:pending_upload'

export type SweepOptions = {
  olderThanMs: number
  tenantId?: string
  /** Injectable clock for tests. */
  now?: Date
}

export async function sweepUnsentUploads(em: EntityManager, opts: SweepOptions): Promise<number> {
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - opts.olderThanMs)

  const where: Record<string, unknown> = {
    partitionCode: OUTBOUND_UPLOAD_PARTITION,
    entityId: PENDING_UPLOAD_ENTITY_ID,
    createdAt: { $lt: cutoff },
  }
  if (opts.tenantId) where.tenantId = opts.tenantId

  const rows = await em.find(Attachment, where as FilterQuery<Attachment>)
  if (rows.length === 0) return 0

  for (const row of rows) {
    try {
      await deletePartitionFile(row.partitionCode, row.storagePath, row.storageDriver ?? undefined)
    } catch {
      // best-effort: a missing file must not block row cleanup
    }
  }
  await em.nativeDelete(Attachment, { id: { $in: rows.map((r) => r.id) } } as FilterQuery<Attachment>)
  return rows.length
}
