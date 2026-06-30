/**
 * Provider-agnostic mail-attachment contracts.
 *
 * These types carry NO assumptions about any mail provider (Microsoft Graph, Gmail, IMAP, …).
 * A channel adapter consumes `ResolvedMailAttachment` (a plain file: name/MIME/size/bytes) and
 * never sees a `MailAttachmentRef`, a CRM `Attachment`, or any other domain entity. The mapping
 * reference → file is the job of a `MailAttachmentSource`; the `MailAttachmentResolver` fans a
 * mixed batch of refs out to the right source and returns files in the original order.
 *
 * A `MailAttachmentRef` is a durable pointer to an already-stored file: the SAME ref can be
 * attached to many messages with no re-upload — the resolver always reads current bytes from the
 * source at send time.
 */

/** Reference that travels in `channelMetadata` — references ONLY, never duplicated file metadata. */
export type MailAttachmentRef =
  | { kind: 'attachment'; id: string }
  // Reserved for later phases (no adapter/transport change needed to add these):
  // | { kind: 'generated-document'; documentId: string; format?: 'pdf' }
  // | { kind: 'onedrive'; driveItemId: string }

export type MailAttachmentKind = MailAttachmentRef['kind']

/** Tenant/org scope + optional actor, passed explicitly so sources never rely on ambient context. */
export type ResolveScope = {
  tenantId: string
  organizationId: string | null
  actorUserId?: string | null
}

/** A resolved file ready for a channel adapter to attach. `read()` is lazy so large files only
 *  materialize at upload time. No provider-specific fields. */
export interface ResolvedMailAttachment {
  fileName: string
  contentType: string
  size: number
  /** Reserved for cid: inline images; Phase 1 always false. */
  inline?: boolean
  read(): Promise<Buffer>
}

/** Resolves refs of exactly one `kind` into files. Register one per supported source. */
export interface MailAttachmentSource {
  readonly kind: MailAttachmentKind
  resolve(refs: MailAttachmentRef[], scope: ResolveScope): Promise<ResolvedMailAttachment[]>
}

/** Façade used by channel adapters: picks the source by `kind`, preserves ref order, fails closed. */
export interface MailAttachmentResolver {
  resolve(refs: MailAttachmentRef[], scope: ResolveScope): Promise<ResolvedMailAttachment[]>
}

/** Narrowing guard for the channelMetadata.attachments payload (which is `unknown` at the boundary). */
export function isMailAttachmentRef(value: unknown): value is MailAttachmentRef {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.kind === 'attachment' && typeof v.id === 'string' && v.id.length > 0
}

/** Parse an arbitrary `channelMetadata.attachments` value into a clean, typed ref list. */
export function parseMailAttachmentRefs(value: unknown): MailAttachmentRef[] {
  if (!Array.isArray(value)) return []
  return value.filter(isMailAttachmentRef)
}
