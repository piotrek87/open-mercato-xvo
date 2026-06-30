/**
 * `MailAttachmentSource` for `kind: 'attachment'` — resolves a CRM `Attachment` (the attachments
 * module is the single source of truth for fileName/MIME/size) into a `ResolvedMailAttachment`.
 *
 * This is the only place that knows the `Attachment` entity + storage driver. The channel adapter
 * stays provider-agnostic and entity-free. Tenant/org scope is applied to every lookup, and a ref
 * that resolves to no row (missing or out of scope) fails closed.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import type { FilterQuery } from '@mikro-orm/core'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import type { StorageDriverFactory } from '@open-mercato/core/modules/attachments/lib/drivers/driverFactory'
import type {
  MailAttachmentRef,
  MailAttachmentSource,
  ResolvedMailAttachment,
  ResolveScope,
} from './types'

export class AttachmentMailSource implements MailAttachmentSource {
  readonly kind = 'attachment' as const

  constructor(
    private readonly em: EntityManager,
    private readonly storage: StorageDriverFactory,
  ) {}

  async resolve(refs: MailAttachmentRef[], scope: ResolveScope): Promise<ResolvedMailAttachment[]> {
    const ids = refs.filter((r) => r.kind === 'attachment').map((r) => r.id)
    if (ids.length === 0) return []

    const where: Record<string, unknown> = { id: { $in: ids }, tenantId: scope.tenantId }
    if (scope.organizationId) where.organizationId = scope.organizationId
    const rows = await this.em.find(Attachment, where as FilterQuery<Attachment>)
    const byId = new Map(rows.map((row) => [row.id, row]))

    const storage = this.storage
    const out: ResolvedMailAttachment[] = []
    for (const ref of refs) {
      if (ref.kind !== 'attachment') continue
      const row = byId.get(ref.id)
      // Fail closed: never silently drop an attachment the caller asked for.
      if (!row) throw new Error(`[mail_attachments] attachment not found or out of scope: ${ref.id}`)

      const driverKey = row.storageDriver ?? 'local'
      const partitionCode = row.partitionCode
      const storagePath = row.storagePath
      out.push({
        fileName: row.fileName,
        contentType: row.mimeType ?? 'application/octet-stream',
        size: row.fileSize ?? 0,
        inline: false,
        read: async (): Promise<Buffer> => {
          const driver = storage.resolveForAttachment(driverKey, null)
          const { buffer } = await driver.read(partitionCode, storagePath)
          return buffer
        },
      })
    }
    return out
  }
}
