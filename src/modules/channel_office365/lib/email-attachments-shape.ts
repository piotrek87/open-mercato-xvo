/**
 * Pure, dependency-free shaping logic for the email-attachments surfaces.
 *
 * Kept free of ORM / Next imports so it is cheap to unit test and reusable by
 * both the route (single-email + person/company modes) and the activities
 * interceptor (per-row count). The DB access lives in `email-attachments.ts`.
 */

export type EmailAttachmentFile = {
  id: string
  fileName: string
  mimeType: string
  fileSize: number
  url: string
}

export type SkippedRecord = { fileName: string; fileSizeBytes: number; status: string }

export type EmailAttachmentGroup = {
  externalMessageId: string | null
  linkId: string
  subject: string | null
  occurredAt: string | null
  direction: string | null
  files: EmailAttachmentFile[]
  skipped: SkippedRecord[]
}

/** CI `source` for a synced O365 email is `office365:mail:<externalMessageId>`. */
export const O365_MAIL_SOURCE_PREFIX = 'office365:mail:'

/** Extract `<externalMessageId>` from a CI `source`, or null when it is not an O365 mail source. */
export function parseO365MailSource(source: unknown): string | null {
  if (typeof source !== 'string') return null
  if (!source.startsWith(O365_MAIL_SOURCE_PREFIX)) return null
  const ext = source.slice(O365_MAIL_SOURCE_PREFIX.length)
  return ext.length > 0 ? ext : null
}

export function toIsoOrNull(value: unknown): string | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value as string)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Non-stored sync records (too_large / fetch_error / skipped_inline) for transparency. */
export function extractSkippedRecords(channelPayload: unknown): SkippedRecord[] {
  const cp = (channelPayload ?? {}) as {
    attachments?: Array<{ fileName?: string; fileSizeBytes?: number; status?: string }>
  }
  return (cp.attachments ?? [])
    .filter((r) => r.status && r.status !== 'stored')
    .map((r) => ({
      fileName: r.fileName ?? 'attachment',
      fileSizeBytes: typeof r.fileSizeBytes === 'number' ? r.fileSizeBytes : 0,
      status: r.status ?? 'unknown',
    }))
}

export function summarizeAttachmentGroups(
  groups: EmailAttachmentGroup[],
): { totalFiles: number; emailsWithAttachments: number } {
  return {
    totalFiles: groups.reduce((n, g) => n + g.files.length, 0),
    emailsWithAttachments: groups.length,
  }
}

/**
 * Dedupe O365-mail CI rows by external message id, keeping the first occurrence's
 * subject/occurredAt. A person + their linked company can both link the same
 * email (company expansion), so this collapses those into one entry.
 */
export function dedupeCiMetaBySource(
  rows: Array<{ source: string | null; title: string | null; occurredAt: unknown }>,
): Map<string, { subject: string | null; occurredAt: string | null }> {
  const map = new Map<string, { subject: string | null; occurredAt: string | null }>()
  for (const r of rows) {
    const ext = parseO365MailSource(r.source)
    if (!ext || map.has(ext)) continue
    map.set(ext, { subject: r.title ?? null, occurredAt: toIsoOrNull(r.occurredAt) })
  }
  return map
}

/**
 * Build the scoped (person/company) groups: one group per email that has at
 * least one downloadable file, newest first. Emails without stored files are
 * omitted so the consolidated list stays clutter-free.
 */
export function buildScopedAttachmentGroups(
  metaByExternalMessageId: Map<string, { subject: string | null; occurredAt: string | null }>,
  linkInfoByExternalMessageId: Map<string, { linkId: string; direction: string | null }>,
  filesByLinkId: Map<string, EmailAttachmentFile[]>,
): EmailAttachmentGroup[] {
  const groups: EmailAttachmentGroup[] = []
  for (const [ext, meta] of metaByExternalMessageId) {
    const link = linkInfoByExternalMessageId.get(ext)
    if (!link) continue
    const files = filesByLinkId.get(link.linkId) ?? []
    if (files.length === 0) continue
    groups.push({
      externalMessageId: ext,
      linkId: link.linkId,
      subject: meta.subject,
      occurredAt: meta.occurredAt,
      direction: link.direction,
      files,
      skipped: [],
    })
  }
  groups.sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''))
  return groups
}

/**
 * Build the single-email group (Faza 0). Returns null when the email has neither
 * downloadable files nor a skipped note — preserving "render nothing when truly
 * empty".
 */
export function buildSingleAttachmentGroup(
  link: { id: string; externalMessageId: string | null; channelPayload: unknown },
  files: EmailAttachmentFile[],
): EmailAttachmentGroup | null {
  const skipped = extractSkippedRecords(link.channelPayload)
  if (files.length === 0 && skipped.length === 0) return null
  const cp = (link.channelPayload ?? {}) as {
    subject?: string | null
    receivedAt?: string | null
    direction?: string | null
  }
  return {
    externalMessageId: link.externalMessageId ?? null,
    linkId: link.id,
    subject: cp.subject ?? null,
    occurredAt: toIsoOrNull(cp.receivedAt),
    direction: cp.direction ?? null,
    files,
    skipped,
  }
}

/**
 * Add `emailAttachmentCount` to office365_mail activity rows (interceptor core).
 * Non-O365 rows pass through untouched.
 */
export function applyEmailAttachmentCounts(
  rows: Array<Record<string, unknown>>,
  countByExternalMessageId: Map<string, number>,
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    if (r.externalProvider === 'office365_mail' && typeof r.externalId === 'string') {
      return { ...r, emailAttachmentCount: countByExternalMessageId.get(r.externalId) ?? 0 }
    }
    return r
  })
}
