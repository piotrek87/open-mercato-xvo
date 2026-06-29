/**
 * Shared, ORM-free shaping helpers that turn an O365 mail `MessageChannelLink.channelPayload`
 * into the fields of an Activity / CustomerInteraction.
 *
 * Used by both code paths so they produce identical participant/body/timestamp shapes:
 *   - crm-email-linker.ts          — live hub ingest (Activity + CI on message.received)
 *   - customer-activity-backfill.ts — retroactive: an email synced BEFORE the contact existed
 *                                     never produced an Activity (the linker early-returns when no
 *                                     CRM person matched), so the backfill rebuilds it from the
 *                                     hub link and reuses the normal link + CI path.
 *
 * Keeping these pure (no DB, no DI) makes them unit-testable in isolation and guarantees a single
 * source of truth for the participant/body conventions both paths depend on.
 */

export type EmailChannelPayload = {
  from?: string | null
  fromName?: string | null
  to?: string[] | null
  cc?: string[] | null
  bcc?: string[] | null
  subject?: string | null
  direction?: string | null
  receivedAt?: string | null
  text?: string | null
  html?: string | null
  markdown?: string | null
}

export type EmailParticipant = { email: string; name: string; status: string }

const DEFAULT_BODY_CAP = 20000

/**
 * Derive a human-readable display name from an email local-part, e.g.
 * "piotr.kowalczyk@xentivo.pl" → "Piotr Kowalczyk".
 *
 * Every participant MUST carry a non-empty `name`: some core renderers call
 * `participant.name.charAt(0)` with no null guard, so a name-less participant crashes the
 * whole interaction view.
 */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email
  const words = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  return words.length > 0 ? words.join(' ') : email
}

/**
 * Lowercased, de-duplicated from + to + cc addresses — the set matched against CRM person emails.
 */
export function collectParticipantEmails(cp: EmailChannelPayload): string[] {
  const raw: string[] = [
    ...(cp.from ? [cp.from] : []),
    ...(cp.to ?? []),
    ...(cp.cc ?? []),
  ]
  return [...new Set(raw.map((e) => (e || '').toLowerCase()).filter(Boolean))]
}

/**
 * Build the two participant views used everywhere, deduplicated by lowercased email (first wins,
 * so sender > recipient > cc):
 *   - `all`        sender + recipients + cc → Activity.participants. Keeps the sender so a person
 *                  added later still matches an email they SENT.
 *   - `recipients` recipients + cc only → CustomerInteraction.participants. The core "DO" dialog
 *                  has no From concept, so the sender must not appear there.
 */
export function buildEmailParticipants(cp: EmailChannelPayload): {
  all: EmailParticipant[]
  recipients: EmailParticipant[]
} {
  const all: EmailParticipant[] = []
  const push = (email: string | null | undefined, status: string, displayName?: string | null): void => {
    if (!email) return
    const lower = email.toLowerCase()
    if (all.some((p) => p.email.toLowerCase() === lower)) return
    all.push({ email, name: displayName?.trim() || nameFromEmail(email), status })
  }
  if (cp.from) push(cp.from, 'sender', cp.fromName)
  for (const email of (cp.to ?? [])) push(email, 'recipient')
  for (const email of (cp.cc ?? [])) push(email, 'cc')
  return { all, recipients: all.filter((p) => p.status !== 'sender') }
}

/** JSON for a participant list, or null when empty (so the column stays NULL rather than `[]`). */
export function participantsToJson(list: EmailParticipant[]): string | null {
  return list.length > 0 ? JSON.stringify(list) : null
}

/**
 * Email body for Activity.notes / CustomerInteraction.body. Prefers the Markdown rendition
 * (graph-mail-adapter derives it from the HTML; the interaction editor renders markdown →
 * paragraphs, **bold**, lists, links), falls back to plain text. Trimmed + capped for safety.
 */
export function extractEmailBody(cp: EmailChannelPayload, cap: number = DEFAULT_BODY_CAP): string | null {
  const raw = typeof cp.markdown === 'string' && cp.markdown.trim()
    ? cp.markdown.trim()
    : (typeof cp.text === 'string' ? cp.text.trim() : '')
  return raw ? raw.slice(0, cap) : null
}

/** Parse `channelPayload.receivedAt` into a Date, or null when absent/invalid. */
export function parseReceivedAt(cp: EmailChannelPayload): Date | null {
  if (!cp.receivedAt) return null
  const parsed = new Date(cp.receivedAt)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
