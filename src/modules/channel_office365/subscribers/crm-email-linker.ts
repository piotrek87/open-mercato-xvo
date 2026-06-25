/**
 * CRM auto-linker for hub-ingested O365 emails.
 *
 * Listens to communication_channels.message.received for providerKey='office365_mail'.
 * Extracts participant emails from the MessageChannelLink.channelPayload, looks them up
 * against CRM person primaryEmail (via findWithDecryption — no hash field), and creates:
 *
 *  • CustomerInteraction(email) rows in customer_interactions → appear in CRM person/company
 *    detail tabs (via interactions-get-override.ts)
 *  • Activity(email) + ActivityLink rows in activities/activity_links → appear in
 *    /backend/activities (the unified activities list)
 *
 * Dedup keys:
 *  • CI:       source = 'office365:mail:{externalMessageId}' (ExternalMessage UUID, stable)
 *  • Activity: external_id = externalMessageId + external_provider = 'office365_mail' + org
 *
 * Both use ON CONFLICT DO NOTHING so re-delivery of the hub event is fully idempotent.
 */

import { randomUUID } from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CommunicationChannel,
  ExternalMessage,
  MessageChannelLink,
} from '@open-mercato/core/modules/communication_channels/data/entities'
import { buildEmailCustomerMap } from '../lib/customer-linker'
import { O365_MAIL_PROVIDER_KEY } from '../lib/credentials'

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
}

type MessageReceivedPayload = {
  messageId: string
  externalMessageId: string
  channelLinkId: string
  conversationId: string
  channelId: string
  providerKey: string
  channelType: string
  direction: string
  tenantId: string
  organizationId: string | null
}

const AUTO_LINK_CAP = 10

/**
 * Derive a human-readable display name from an email address local-part, e.g.
 * "piotr.kowalczyk@xentivo.pl" → "Piotr Kowalczyk". Used as a fallback so every
 * participant carries a non-empty `name` (core renderers call `name.charAt(0)`
 * without a null guard — a name-less participant crashes the interaction view).
 */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email
  const words = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  return words.length > 0 ? words.join(' ') : email
}

export const metadata = {
  event: 'communication_channels.message.received',
  persistent: true,
  id: 'channel_office365.crm-email-linker',
}

const CI_COLS = [
  'id', 'organization_id', 'tenant_id', 'entity_id',
  'interaction_type', 'title', 'body', 'occurred_at',
  'author_user_id', 'owner_user_id', 'visibility', 'status',
  'source', 'duration_minutes', 'location', 'all_day',
  'participants', 'channel_provider_key', 'pinned', 'created_at', 'updated_at',
] as const

const ACTIVITY_COLS = [
  'id', 'organization_id', 'tenant_id',
  'activity_type', 'lifecycle_mode', 'subject', 'notes', 'status',
  'occurred_at', 'visibility', 'participants',
  'external_id', 'external_provider', 'source_type',
  'is_active', 'all_day', 'owner_user_id', 'author_user_id', 'created_at', 'updated_at',
] as const

const ACTIVITY_LINK_COLS = [
  'id', 'activity_id', 'entity_type', 'entity_id',
  'is_primary', 'organization_id', 'tenant_id', 'created_at',
] as const

export default async function handler(
  payload: MessageReceivedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  if (payload.providerKey !== O365_MAIL_PROVIDER_KEY) return
  if (!payload.tenantId || !payload.organizationId) return

  const scope = {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
  }

  const em = (ctx.resolve('em') as EntityManager).fork()

  // Load hub link to access channelPayload (participant emails, subject, direction)
  const link = await em.findOne(MessageChannelLink, { id: payload.channelLinkId })
  if (!link?.channelPayload) return

  // The synced email's owner = the mailbox owner (the staff user who connected this O365 channel).
  // Stamping it on the Activity/CI makes the activity show up under that user in the team
  // leaderboard / analytics (synced mail previously had no owner, so it never counted).
  const channel = payload.channelId
    ? await em.findOne(CommunicationChannel, { id: payload.channelId })
    : null
  const ownerUserId = channel?.userId ?? null

  const cp = link.channelPayload as {
    from?: string | null
    fromName?: string | null
    to?: string[]
    cc?: string[]
    bcc?: string[]
    subject?: string | null
    direction?: string
    receivedAt?: string | null
    text?: string | null
    html?: string | null
    markdown?: string | null
  }

  // Collect participant email addresses and deduplicate
  const rawEmails: string[] = [
    ...(cp.from ? [cp.from] : []),
    ...(cp.to ?? []),
    ...(cp.cc ?? []),
  ]
  const uniqueEmails = [...new Set(rawEmails.map(e => e.toLowerCase()).filter(Boolean))]
  if (uniqueEmails.length === 0) return

  // Get email timestamp.
  // Prefer receivedAt from channelPayload (set by graph-mail-adapter from Graph API receivedDateTime).
  // Fall back to ExternalMessage.providerTimestamp if channelPayload doesn't have it (older messages).
  let occurredAt: Date | null = null
  if (cp.receivedAt) {
    const parsed = new Date(cp.receivedAt)
    if (!Number.isNaN(parsed.getTime())) occurredAt = parsed
  }
  if (!occurredAt) {
    let extMsg = await em.findOne(ExternalMessage, { id: payload.externalMessageId })
    if (!extMsg && payload.externalMessageId) {
      extMsg = await em.findOne(ExternalMessage, { externalMessageId: payload.externalMessageId })
    }
    occurredAt = extMsg?.providerTimestamp ?? null
  }

  // Correct Message.sentAt to the original email receive time.
  // ingest-inbound-message.ts always stores sentAt = now(); fix it here via raw SQL
  // so the E-maile tab shows the real received date instead of the sync timestamp.
  if (occurredAt && payload.messageId) {
    try {
      await em.getConnection().execute(
        `UPDATE messages SET sent_at = ? WHERE id = ? AND tenant_id = ?`,
        [occurredAt, payload.messageId, payload.tenantId],
      )
    } catch (err) {
      console.warn(
        '[channel_office365:crm-email-linker] Message.sentAt correction failed:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  // Build email → customerId[] map for the entire org (decrypts primaryEmail in memory)
  const emailMap = await buildEmailCustomerMap(em, scope)
  if (emailMap.size === 0) return

  // Find which participant emails match CRM persons
  const now = new Date()
  const seenPersonIds = new Set<string>()
  const matchedPersonIds: string[] = []

  for (const email of uniqueEmails) {
    const ids = emailMap.get(email)
    if (!ids) continue
    for (const id of ids) {
      if (seenPersonIds.has(id) || matchedPersonIds.length >= AUTO_LINK_CAP) break
      seenPersonIds.add(id)
      matchedPersonIds.push(id)
    }
  }

  if (matchedPersonIds.length === 0) return

  // Stable dedup key: ExternalMessage UUID (one per unique external message)
  const source = `office365:mail:${payload.externalMessageId}`
  const title = cp.subject ?? null
  // Email body for the Activity (notes) and CustomerInteraction (body). Prefer the Markdown
  // rendition (graph-mail-adapter derives it from the HTML): the customers interaction editor
  // renders markdown, so this yields paragraph breaks + **bold** + lists + links instead of a
  // run-on plain-text blob. Fall back to plain text. Capped for safety.
  const rawBody = typeof cp.markdown === 'string' && cp.markdown.trim()
    ? cp.markdown.trim()
    : (typeof cp.text === 'string' ? cp.text.trim() : '')
  const bodyText = rawBody ? rawBody.slice(0, 20000) : null
  const ciStatus = occurredAt && occurredAt <= now ? 'done' : 'planned'

  // Build participants JSON for display in UI.
  // status values must match what the Activities detail page expects:
  // 'sender' → from, 'recipient' → to, 'cc' → cc, 'bcc' → bcc
  //
  // EVERY participant MUST have a non-empty `name`. Some core renderers (e.g. the customers
  // ParticipantsField avatar) call `participant.name.charAt(0)` with no null guard, so a
  // name-less recipient crashes the whole interaction view. Graph only gives us a display name
  // for the sender (fromName); for to/cc we derive a readable name from the email local-part.
  const participantsList: Array<{ email: string; name: string; status: string }> = []
  const pushParticipant = (email: string, status: string, displayName?: string | null): void => {
    if (!email) return
    const lower = email.toLowerCase()
    if (participantsList.some(p => p.email.toLowerCase() === lower)) return
    participantsList.push({ email, name: displayName?.trim() || nameFromEmail(email), status })
  }
  if (cp.from) pushParticipant(cp.from, 'sender', cp.fromName)
  for (const email of (cp.to ?? [])) pushParticipant(email, 'recipient')
  for (const email of (cp.cc ?? [])) pushParticipant(email, 'cc')

  // Two participant views:
  // - Activity (our /backend/activities table + the person-created backfill matcher) keeps EVERY
  //   participant incl. the sender, so a person added later still matches an email they SENT.
  // - CustomerInteraction (what the core "Edytuj aktywność" dialog renders as its "DO" field)
  //   excludes the sender: that dialog lists all participants as recipients with no From/sender
  //   concept, so showing the sender there is wrong. "DO" = recipients + cc only.
  const participantsJson = participantsList.length > 0 ? JSON.stringify(participantsList) : null
  const ciParticipants = participantsList.filter((p) => p.status !== 'sender')
  const ciParticipantsJson = ciParticipants.length > 0 ? JSON.stringify(ciParticipants) : null

  // Phase 1: person CustomerInteraction rows (for CRM detail tabs)
  try {
    const personRows = matchedPersonIds.map(personId => [
      randomUUID(),
      scope.organizationId,
      scope.tenantId,
      personId,
      'email',
      title,
      bodyText,         // body
      occurredAt,
      null,             // author_user_id
      ownerUserId,      // owner_user_id = mailbox owner
      'team',
      ciStatus,
      source,
      null,             // duration_minutes
      null,             // location
      false,            // all_day
      ciParticipantsJson,
      O365_MAIL_PROVIDER_KEY,
      false,            // pinned
      now,
      now,
    ])

    const valueClauses = personRows.map(() => '(' + CI_COLS.map(() => '?').join(', ') + ')').join(', ')
    await em.getConnection().execute(
      `INSERT INTO customer_interactions (${CI_COLS.join(', ')})
       VALUES ${valueClauses}
       ON CONFLICT (entity_id, source, organization_id)
       WHERE source LIKE 'office365:%' AND deleted_at IS NULL
       DO NOTHING`,
      personRows.flat(),
    )
  } catch (err) {
    console.warn(
      '[channel_office365:crm-email-linker] person CI insert failed:',
      err instanceof Error ? err.message : err,
    )
    return
  }

  // Phase 2: resolve linked companies and create company CI rows
  let companyIds: string[] = []
  try {
    const personPlaceholders = matchedPersonIds.map(() => '?').join(', ')
    const companyRows: Array<{ person_id: string; company_id: string }> = await em.getConnection().execute(
      `SELECT person_entity_id AS person_id, company_entity_id AS company_id
       FROM customer_person_company_links
       WHERE person_entity_id IN (${personPlaceholders})
         AND company_entity_id IS NOT NULL
         AND deleted_at IS NULL`,
      matchedPersonIds,
    )

    const seenCompanyIds = new Set<string>()
    const companyValues: unknown[][] = []
    for (const row of companyRows) {
      if (seenCompanyIds.has(row.company_id)) continue
      seenCompanyIds.add(row.company_id)
      companyIds.push(row.company_id)
      companyValues.push([
        randomUUID(),
        scope.organizationId,
        scope.tenantId,
        row.company_id,
        'email',
        title,
        bodyText,
        occurredAt,
        null,             // author_user_id
        ownerUserId,      // owner_user_id = mailbox owner
        'team',
        ciStatus,
        source,
        null,
        null,
        false,
        ciParticipantsJson,
        O365_MAIL_PROVIDER_KEY,
        false,
        now,
        now,
      ])
    }

    if (companyValues.length > 0) {
      const companyClauses = companyValues.map(() => '(' + CI_COLS.map(() => '?').join(', ') + ')').join(', ')
      await em.getConnection().execute(
        `INSERT INTO customer_interactions (${CI_COLS.join(', ')})
         VALUES ${companyClauses}
         ON CONFLICT (entity_id, source, organization_id)
         WHERE source LIKE 'office365:%' AND deleted_at IS NULL
         DO NOTHING`,
        companyValues.flat(),
      )
    }
  } catch (err) {
    console.warn(
      '[channel_office365:crm-email-linker] company CI insert failed:',
      err instanceof Error ? err.message : err,
    )
  }

  // Phase 3: Activity + ActivityLink rows (for /backend/activities unified list)
  try {
    // Check if an Activity for this external message already exists (idempotent)
    const existingActivity = (await em.getConnection().execute(
      `SELECT id FROM activities
       WHERE external_id = ? AND external_provider = ? AND organization_id = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [payload.externalMessageId, 'office365_mail', scope.organizationId],
    )) as Array<{ id: string }>

    const activityId = existingActivity[0]?.id ?? randomUUID()

    if (!existingActivity[0]) {
      await em.getConnection().execute(
        `INSERT INTO activities (${ACTIVITY_COLS.join(', ')})
         VALUES (${ACTIVITY_COLS.map(() => '?').join(', ')})`,
        [
          activityId,
          scope.organizationId,
          scope.tenantId,
          'email',
          'fact',
          title ?? '(no subject)',
          bodyText,         // notes
          'fact',           // status for fact lifecycle
          occurredAt,
          'team',
          participantsJson,
          payload.externalMessageId,  // external_id for dedup
          'office365_mail',           // external_provider
          'office365_mail',           // source_type
          true,             // is_active
          false,            // all_day
          ownerUserId,      // owner_user_id = mailbox owner (drives the activity leaderboard)
          ownerUserId,      // author_user_id
          now,
          now,
        ],
      )
    }

    // Create ActivityLink for each matched person
    for (const [i, personId] of matchedPersonIds.entries()) {
      await em.getConnection().execute(
        `INSERT INTO activity_links (${ACTIVITY_LINK_COLS.join(', ')})
         VALUES (${ACTIVITY_LINK_COLS.map(() => '?').join(', ')})
         ON CONFLICT (activity_id, entity_type, entity_id) DO NOTHING`,
        [randomUUID(), activityId, 'customers:person', personId, i === 0, scope.organizationId, scope.tenantId, now],
      )
    }

    // Create ActivityLink for each matched company
    for (const companyId of companyIds) {
      await em.getConnection().execute(
        `INSERT INTO activity_links (${ACTIVITY_LINK_COLS.join(', ')})
         VALUES (${ACTIVITY_LINK_COLS.map(() => '?').join(', ')})
         ON CONFLICT (activity_id, entity_type, entity_id) DO NOTHING`,
        [randomUUID(), activityId, 'customers:company', companyId, false, scope.organizationId, scope.tenantId, now],
      )
    }
  } catch (err) {
    console.warn(
      '[channel_office365:crm-email-linker] activity insert failed:',
      err instanceof Error ? err.message : err,
    )
  }
}
