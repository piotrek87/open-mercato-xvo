/**
 * Retroactive O365 history backfill (Fix #2) — shared by the person.created and company.created
 * subscribers.
 *
 * When a CRM contact is added AFTER their O365 emails were synced, those emails either:
 *   (a) already have an Activity (another participant matched at sync time) but no link/CI for the
 *       new contact — found by the `activities` participant scan; or
 *   (b) have NO Activity at all (no participant matched at sync time, so crm-email-linker
 *       early-returned) and live only in `message_channel_links` — rebuilt here from the hub.
 *
 * `backfillO365HistoryForPerson` closes both gaps for one person and their linked companies. The
 * company.created subscriber simply runs it for each person already linked to the new company, so a
 * company added after its people still picks up their shared history. Everything is idempotent
 * (NOT EXISTS gate + ON CONFLICT DO NOTHING), so re-delivery and overlap between the two triggers
 * are safe.
 */

import { randomUUID } from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CommunicationChannel,
  ExternalMessage,
} from '@open-mercato/core/modules/communication_channels/data/entities'
import { autoLinkActivityToCustomers } from './customer-linker'
import {
  O365_EXTERNAL_PROVIDER_CALENDAR,
  O365_EXTERNAL_PROVIDER_MAIL,
  O365_MAIL_PROVIDER_KEY,
} from './credentials'
import {
  type EmailChannelPayload,
  buildEmailParticipants,
  extractEmailBody,
  parseReceivedAt,
  participantsToJson,
} from './email-activity-shape'

export type BackfillScope = { tenantId: string; organizationId: string }

type ActivityRow = {
  id: string
  external_id: string | null
  external_provider: string | null
  activity_type: string | null
  subject: string | null
  notes: string | null
  occurred_at: Date | null
  due_at: Date | null
  duration_minutes: number | null
  location: string | null
  all_day: boolean | null
  owner_user_id: string | null
  participants: Array<{ email?: string; name?: string; status?: string }> | null
}

const CI_COLS = [
  'id', 'organization_id', 'tenant_id', 'entity_id',
  'interaction_type', 'title', 'body', 'occurred_at',
  'author_user_id', 'owner_user_id', 'visibility', 'status',
  'source', 'duration_minutes', 'location', 'all_day',
  'participants', 'channel_provider_key', 'pinned', 'created_at', 'updated_at',
] as const

// Columns for the per-message "extMsg-CI" rows that drive the built-in "E-maile" threads tab.
// Distinct from CI_COLS (the "source-CI" rows that drive "Aktywności"): here `source` is NULL and
// `external_message_id` carries the MessageChannelLink PK — the anchor buildPersonEmailThreads reads.
const EMAIL_CI_COLS = [
  'id', 'organization_id', 'tenant_id', 'entity_id',
  'interaction_type', 'title', 'body', 'occurred_at',
  'author_user_id', 'visibility', 'status',
  'external_message_id', 'channel_provider_key', 'created_at', 'updated_at',
] as const

// Mirrors crm-email-linker.ACTIVITY_COLS so a backfilled Activity is indistinguishable from a
// live-synced one (same external_id dedup key, same lifecycle).
const ACTIVITY_COLS = [
  'id', 'organization_id', 'tenant_id',
  'activity_type', 'lifecycle_mode', 'subject', 'notes', 'status',
  'occurred_at', 'visibility', 'participants',
  'external_id', 'external_provider', 'source_type',
  'is_active', 'all_day', 'owner_user_id', 'author_user_id', 'created_at', 'updated_at',
] as const

type HubLinkRow = {
  external_message_id: string
  channel_payload: EmailChannelPayload | null
}

type HubEmailLinkRow = {
  id: string
  direction: string | null
  provider_key: string | null
  channel_payload: EmailChannelPayload | null
  created_at: Date | null
}

/**
 * Rebuild the per-message CustomerInteraction rows that drive the built-in "E-maile" (Gmail-style
 * threads) tab on a Person card — the missing half of Fix #2.
 *
 * That tab (core `buildPersonEmailThreads`) reads ONLY interactions whose `external_message_id`
 * points at a `MessageChannelLink` row. Those "extMsg-CI" rows are produced live by the core
 * `link-channel-message-handler` when an inbound/outbound email matches an ALREADY-existing Person.
 * Emails synced before this Person existed never got that match, so the tab stays empty even though
 * the "Aktywności" tab (source-CI rows, `external_message_id` NULL) is populated.
 *
 * We rebuild the exact shape `persistInteractions` writes live: `source` NULL, `external_message_id`
 * = MessageChannelLink.id, `channel_provider_key` = 'office365_mail' (so our timeline dedup filter
 * still hides it from "Aktywności"), `visibility` = 'private' + `author_user_id` = mailbox owner for
 * a user-scoped channel. Idempotent via the partial unique index
 * `customer_interactions_email_dedupe_uq (entity_id, external_message_id)`.
 */
async function createPersonEmailInteractionsFromHub(
  em: EntityManager,
  scope: BackfillScope,
  personId: string,
  email: string,
  channelUserId: string | null,
  now: Date,
): Promise<number> {
  const { tenantId, organizationId } = scope

  const links = (await em.getConnection('read').execute(
    `SELECT mcl.id, mcl.direction, mcl.provider_key, mcl.channel_payload, mcl.created_at
     FROM message_channel_links mcl
     WHERE mcl.tenant_id = ?
       AND mcl.organization_id = ?
       AND mcl.provider_key = ?
       AND mcl.id IS NOT NULL
       AND (
         lower(mcl.channel_payload->>'from') = ?
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(mcl.channel_payload->'to') = 'array'
                  THEN mcl.channel_payload->'to' ELSE '[]'::jsonb END) AS t(addr)
           WHERE lower(t.addr) = ?)
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(mcl.channel_payload->'cc') = 'array'
                  THEN mcl.channel_payload->'cc' ELSE '[]'::jsonb END) AS c(addr)
           WHERE lower(c.addr) = ?)
       )`,
    [tenantId, organizationId, O365_MAIL_PROVIDER_KEY, email, email, email],
  )) as HubEmailLinkRow[]

  if (links.length === 0) return 0

  // Mirror core resolveVisibility: user-scoped channel → 'private' (visible to the mailbox owner,
  // i.e. its author), tenant-scoped → 'shared'. The owner-only v1 rule lives in the read filter.
  const visibility = channelUserId ? 'private' : 'shared'
  const values: unknown[][] = []
  for (const link of links) {
    const cp = link.channel_payload
    if (!cp) continue
    const occurredAt = parseReceivedAt(cp) ?? link.created_at ?? null
    values.push([
      randomUUID(), organizationId, tenantId, personId,
      'email', cp.subject ?? null, extractEmailBody(cp), occurredAt,
      channelUserId, visibility, 'done',
      link.id, link.provider_key ?? O365_MAIL_PROVIDER_KEY, now, now,
    ])
  }
  if (values.length === 0) return 0

  const valueClauses = values.map(() => '(' + EMAIL_CI_COLS.map(() => '?').join(', ') + ')').join(', ')
  await em.getConnection().execute(
    `INSERT INTO customer_interactions (${EMAIL_CI_COLS.join(', ')})
     VALUES ${valueClauses}
     ON CONFLICT (entity_id, external_message_id)
       WHERE external_message_id IS NOT NULL AND deleted_at IS NULL
     DO NOTHING`,
    values.flat(),
  )
  return values.length
}

/**
 * Rebuild Activities for emails that were synced before this person existed in CRM. Such emails
 * never produced an Activity (crm-email-linker early-returns when no participant matches a CRM
 * person), so they are invisible to the activities-table scan. We find this person's office365_mail
 * hub links that still have no Activity, INSERT one Activity each (same shape as the live linker),
 * and return them as ActivityRows so the caller's existing link + CI logic picks them up. A
 * NOT EXISTS gate plus ON CONFLICT DO NOTHING on the partial unique index make this safe under both
 * re-delivery and concurrent deliveries.
 */
async function createMissingMailActivitiesFromHub(
  em: EntityManager,
  scope: BackfillScope,
  email: string,
  now: Date,
): Promise<ActivityRow[]> {
  const { tenantId, organizationId } = scope

  // Candidate hub links: this email appears in from/to/cc (case-insensitive) AND no Activity exists
  // yet for the external message. message_channel_links has no soft-delete column.
  const links = (await em.getConnection('read').execute(
    `SELECT mcl.external_message_id, mcl.channel_payload
     FROM message_channel_links mcl
     WHERE mcl.tenant_id = ?
       AND mcl.organization_id = ?
       AND mcl.provider_key = ?
       AND mcl.external_message_id IS NOT NULL
       AND (
         lower(mcl.channel_payload->>'from') = ?
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(mcl.channel_payload->'to') = 'array'
                  THEN mcl.channel_payload->'to' ELSE '[]'::jsonb END) AS t(addr)
           WHERE lower(t.addr) = ?)
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(mcl.channel_payload->'cc') = 'array'
                  THEN mcl.channel_payload->'cc' ELSE '[]'::jsonb END) AS c(addr)
           WHERE lower(c.addr) = ?)
       )
       AND NOT EXISTS (
         SELECT 1 FROM activities a
         WHERE a.external_id = mcl.external_message_id::text
           AND a.external_provider = ?
           AND a.organization_id = mcl.organization_id
           AND a.deleted_at IS NULL
       )`,
    [tenantId, organizationId, O365_MAIL_PROVIDER_KEY, email, email, email, O365_EXTERNAL_PROVIDER_MAIL],
  )) as HubLinkRow[]

  if (links.length === 0) return []

  // Mailbox owner = the staff user who connected this org's O365 mail channel. Stamping it (as the
  // live linker does) makes the backfilled activity count under that user in the leaderboard.
  const channel = await em.findOne(CommunicationChannel, {
    providerKey: O365_MAIL_PROVIDER_KEY,
    tenantId,
    organizationId,
  })
  const ownerUserId = channel?.userId ?? null

  // Fallback timestamps for links whose payload lacks receivedAt (older messages).
  const msgIds = links.map((l) => l.external_message_id)
  const extMsgs = await em.find(ExternalMessage, { id: { $in: msgIds } })
  const providerTimestampById = new Map<string, Date | null>(
    extMsgs.map((m) => [m.id, m.providerTimestamp ?? null]),
  )

  const candidates: Array<{ row: ActivityRow; values: unknown[] }> = []

  for (const link of links) {
    const cp = link.channel_payload
    if (!cp) continue
    const extMsgId = link.external_message_id
    const title = cp.subject ?? null
    const bodyText = extractEmailBody(cp)
    const occurredAt = parseReceivedAt(cp) ?? providerTimestampById.get(extMsgId) ?? null
    const { all: participantsList } = buildEmailParticipants(cp)
    const participantsJson = participantsToJson(participantsList)
    const activityId = randomUUID()

    candidates.push({
      row: {
        id: activityId,
        external_id: extMsgId,
        external_provider: O365_EXTERNAL_PROVIDER_MAIL,
        activity_type: 'email',
        subject: title,
        notes: bodyText,
        occurred_at: occurredAt,
        due_at: null,
        duration_minutes: null,
        location: null,
        all_day: false,
        owner_user_id: ownerUserId,
        participants: participantsList,
      },
      values: [
        activityId, organizationId, tenantId,
        'email', 'fact', title ?? '(no subject)', bodyText, 'fact',
        occurredAt, 'team', participantsJson,
        extMsgId, O365_EXTERNAL_PROVIDER_MAIL, O365_EXTERNAL_PROVIDER_MAIL,
        true, false, ownerUserId, ownerUserId, now, now,
      ],
    })
  }

  if (candidates.length === 0) return []

  // ON CONFLICT DO NOTHING (partial unique index activities_external_dedup_idx) + RETURNING makes
  // the insert safe under concurrent deliveries: only the rows we actually inserted come back, so we
  // never hand a phantom activityId to the downstream linker. Any email skipped here already has an
  // Activity (created concurrently) and is picked up by the activities scan.
  const valueClauses = candidates
    .map(() => '(' + ACTIVITY_COLS.map(() => '?').join(', ') + ')')
    .join(', ')
  const inserted = (await em.getConnection().execute(
    `INSERT INTO activities (${ACTIVITY_COLS.join(', ')}) VALUES ${valueClauses}
     ON CONFLICT (external_id, external_provider, organization_id)
       WHERE external_id IS NOT NULL AND deleted_at IS NULL
     DO NOTHING
     RETURNING id`,
    candidates.flatMap((c) => c.values),
  )) as Array<{ id: string }>

  const insertedIds = new Set(inserted.map((r) => r.id))
  return candidates.filter((c) => insertedIds.has(c.row.id)).map((c) => c.row)
}

/**
 * Surface a person's historical O365 emails/meetings on their (and their companies') CRM card:
 *   0. rebuild Activities for hub-only emails (no Activity yet);
 *   1. ActivityLink rows for the person + their companies (via the shared linker);
 *   2. CustomerInteraction rows (email + meeting) so the activity shows in the built-in
 *      "Aktywności" / "E-maile" tabs, which read customer_interactions.
 *
 * `primaryEmail` is matched case-insensitively. All writes are idempotent.
 */
export async function backfillO365HistoryForPerson(
  em: EntityManager,
  scope: BackfillScope,
  personId: string,
  primaryEmail: string,
  now: Date,
): Promise<void> {
  const { tenantId, organizationId } = scope
  const email = primaryEmail.toLowerCase()

  // Step 0 (Fix #2): rebuild Activities for emails synced before this person existed (hub-link only,
  // no Activity yet). These are INSERTed here and returned so the link + CI steps below process them.
  // Non-fatal: if hub rebuild fails (e.g. a transient DB error), still link + CI the emails that
  // already have an Activity — never let the hub step block the rest of the backfill.
  let hubRows: ActivityRow[] = []
  try {
    hubRows = await createMissingMailActivitiesFromHub(em, scope, email, now)
  } catch (err) {
    console.warn(
      '[channel_office365:o365-history-backfill] hub rebuild failed (continuing with existing activities):',
      err instanceof Error ? err.message : err,
    )
  }

  // E-maile tab (Fix #2 second half): rebuild the per-message extMsg-CI rows the built-in
  // threads tab reads. Independent of the Activity/source-CI work below (those drive "Aktywności"),
  // and runs regardless of whether any Activity exists. Non-fatal — never block the rest.
  try {
    const mailChannel = await em.findOne(CommunicationChannel, {
      providerKey: O365_MAIL_PROVIDER_KEY,
      tenantId,
      organizationId,
    })
    const emailThreadCis = await createPersonEmailInteractionsFromHub(
      em, scope, personId, email, mailChannel?.userId ?? null, now,
    )
    if (emailThreadCis > 0) {
      console.info(
        `[channel_office365:o365-history-backfill] person ${personId} (${email}) — linked ${emailThreadCis} email(s) to the E-maile threads tab`,
      )
    }
  } catch (err) {
    console.warn(
      '[channel_office365:o365-history-backfill] E-maile thread CI backfill failed (continuing):',
      err instanceof Error ? err.message : err,
    )
  }

  // Raw SQL for JSONB containment — MikroORM has no @> helper. Fetch the full activity row so we can
  // rebuild CustomerInteraction records (subject/body/time/source). Includes the activities just
  // created from the hub above (so they get linked + a CI in one pass).
  const conn = em.getConnection('read')
  const activityRows: ActivityRow[] = await conn.execute(
    `SELECT id, external_id, external_provider, activity_type, subject, notes,
            occurred_at, due_at, duration_minutes, location, all_day, owner_user_id, participants
     FROM activities
     WHERE tenant_id = ? AND organization_id = ? AND deleted_at IS NULL
       AND participants IS NOT NULL
       AND participants @> CAST(? AS jsonb)`,
    [tenantId, organizationId, JSON.stringify([{ email }])],
  )

  // De-dup: the hub rows were just inserted, so the scan above already returns them. Prefer the
  // scanned copy and append only hub rows the scan missed (e.g. an email where the address case in
  // the JSONB participants doesn't match the lowercased containment probe).
  const scannedIds = new Set(activityRows.map((r) => r.id))
  const rows: ActivityRow[] = [...activityRows, ...hubRows.filter((r) => !scannedIds.has(r.id))]

  if (rows.length === 0) return

  console.info(
    `[channel_office365:o365-history-backfill] person ${personId} (${email}) — backfilling ${rows.length} activit${rows.length === 1 ? 'y' : 'ies'} (${hubRows.length} rebuilt from hub)`,
  )

  // 1) ActivityLink rows (person + their companies) via the shared linker.
  const emailMap = new Map<string, string[]>([[email, [personId]]])
  await autoLinkActivityToCustomers(
    em,
    rows.map((r) => ({ activityId: r.id, participants: r.participants })),
    emailMap,
    scope,
  )

  // 2) CustomerInteraction rows so the activity appears on the CRM "Aktywności"/"E-maile" tabs.
  // Resolve the person's companies so the same emails/meetings also surface on the company card.
  const writeConn = em.getConnection()
  let companyIds: string[] = []
  try {
    const companyRows = (await writeConn.execute(
      `SELECT company_entity_id AS company_id
       FROM customer_person_company_links
       WHERE person_entity_id = ? AND company_entity_id IS NOT NULL AND deleted_at IS NULL`,
      [personId],
    )) as Array<{ company_id: string }>
    companyIds = [...new Set(companyRows.map((r) => r.company_id))]
  } catch { /* no company links — person CIs only */ }

  const entityIds = [personId, ...companyIds]
  const ciValues: unknown[][] = []

  for (const row of rows) {
    // Only O365-synced activities map to a CustomerInteraction (stable dedup source).
    if (!row.external_id || !row.external_provider) continue
    const isMail = row.external_provider === O365_EXTERNAL_PROVIDER_MAIL
    const isCalendar = row.external_provider === O365_EXTERNAL_PROVIDER_CALENDAR
    if (!isMail && !isCalendar) continue

    const source = isMail
      ? `office365:mail:${row.external_id}`
      : `office365:calendar:${row.external_id}`
    const interactionType = isMail ? 'email' : 'meeting'
    const channelProviderKey = isMail ? O365_MAIL_PROVIDER_KEY : null
    const eventTime = row.occurred_at ?? row.due_at ?? null
    const status = interactionType === 'email'
      ? 'done'
      : (eventTime && eventTime <= now ? 'done' : 'planned')
    // CustomerInteraction "DO" (core dialog) excludes the email sender — it has no From concept,
    // so the sender would wrongly appear as a recipient. Keep recipients + cc only here. (The
    // Activity row this was read from still carries the sender for matching/our own viewer.)
    const ciParticipants = Array.isArray(row.participants)
      ? row.participants.filter((p) => p?.status !== 'sender')
      : null
    const participantsJson = ciParticipants && ciParticipants.length > 0 ? JSON.stringify(ciParticipants) : null

    for (const entityId of entityIds) {
      ciValues.push([
        randomUUID(),
        organizationId,
        tenantId,
        entityId,
        interactionType,
        row.subject ?? null,
        row.notes ?? null,
        eventTime,
        null,                 // author_user_id
        row.owner_user_id ?? null,
        'team',
        status,
        source,
        row.duration_minutes ?? null,
        row.location ?? null,
        row.all_day ?? false,
        participantsJson,
        channelProviderKey,
        false,                // pinned
        now,
        now,
      ])
    }
  }

  if (ciValues.length === 0) return

  try {
    const valueClauses = ciValues.map(() => '(' + CI_COLS.map(() => '?').join(', ') + ')').join(', ')
    await writeConn.execute(
      `INSERT INTO customer_interactions (${CI_COLS.join(', ')})
       VALUES ${valueClauses}
       ON CONFLICT (entity_id, source, organization_id)
       WHERE source LIKE 'office365:%' AND deleted_at IS NULL
       DO NOTHING`,
      ciValues.flat(),
    )
  } catch (err) {
    console.warn(
      '[channel_office365:o365-history-backfill] CustomerInteraction backfill failed:',
      err instanceof Error ? err.message : err,
    )
  }
}
