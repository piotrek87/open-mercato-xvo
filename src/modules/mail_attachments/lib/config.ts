/**
 * Configurable attachment limits (decision 10 — limits are config, not hard-coded).
 * Overridable via env; sensible defaults match the spec (10 files / 25 MB total).
 */

export type MailAttachmentLimits = {
  /** Max number of attachments per message. */
  maxFiles: number
  /** Max combined size of all attachments on one message, in bytes. */
  maxTotalBytes: number
  /** Max size of a single attachment, in bytes. */
  maxFileBytes: number
}

const MB = 1024 * 1024

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function resolveMailAttachmentLimits(): MailAttachmentLimits {
  return {
    maxFiles: positiveNumber(process.env.MAIL_ATTACHMENTS_MAX_FILES, 10),
    maxTotalBytes: positiveNumber(process.env.MAIL_ATTACHMENTS_MAX_TOTAL_MB, 25) * MB,
    maxFileBytes: positiveNumber(process.env.MAIL_ATTACHMENTS_MAX_FILE_MB, 25) * MB,
  }
}

export type LimitViolation =
  | { code: 'too_many_files'; max: number; actual: number }
  | { code: 'file_too_large'; max: number; actual: number; fileName?: string }
  | { code: 'total_too_large'; max: number; actual: number }

/** Pure validation used by both the upload route (per-file) and the compose route (count + total). */
export function checkAttachmentLimits(
  files: Array<{ size: number; fileName?: string }>,
  limits: MailAttachmentLimits,
): LimitViolation | null {
  if (files.length > limits.maxFiles) {
    return { code: 'too_many_files', max: limits.maxFiles, actual: files.length }
  }
  let total = 0
  for (const f of files) {
    if (f.size > limits.maxFileBytes) {
      return { code: 'file_too_large', max: limits.maxFileBytes, actual: f.size, fileName: f.fileName }
    }
    total += f.size
  }
  if (total > limits.maxTotalBytes) {
    return { code: 'total_too_large', max: limits.maxTotalBytes, actual: total }
  }
  return null
}
