/**
 * When a new CRM person is added, retroactively link matching O365 activities AND surface their
 * historical emails/meetings on the CRM card.
 *
 * Problem: O365 activities are synced (with participant emails) BEFORE the person exists in CRM.
 * The delta cursor advances, so future syncs never re-process those historical events. This
 * subscriber closes the gap on every new person:
 *   1. ActivityLink rows  → the activity shows in /backend/activities for the person.
 *   2. CustomerInteraction rows (email + meeting) → the activity shows in the person's (and their
 *      companies') built-in "Aktywności" / "E-maile" tabs, which read customer_interactions.
 *      Without (2) a newly-added person saw nothing on their CRM card until a full re-sync.
 *
 * All inserts are idempotent (ON CONFLICT DO NOTHING), so re-delivery of the event is safe.
 */

import { randomUUID } from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { autoLinkActivityToCustomers } from '../lib/customer-linker'
import {
  O365_EXTERNAL_PROVIDER_CALENDAR,
  O365_EXTERNAL_PROVIDER_MAIL,
  O365_MAIL_PROVIDER_KEY,
} from '../lib/credentials'

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
}

type PersonCreatedPayload = {
  id: string
  tenantId: string
  organizationId: string
}

export const metadata = {
  event: 'customers.person.created',
  persistent: true,
  id: 'channel_office365.customer-activity-backfill',
}

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

export default async function handler(
  payload: PersonCreatedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  const { id: customerId, tenantId, organizationId } = payload
  if (!tenantId || !organizationId || !customerId) return

  const em = (ctx.resolve('em') as EntityManager).fork()

  const customers = await findWithDecryption(
    em,
    CustomerEntity,
    { id: customerId, tenantId, organizationId, kind: 'person', deletedAt: null },
    { limit: 1 },
    { tenantId, organizationId },
  )
  const person = customers[0]
  if (!person?.primaryEmail) return

  const email = person.primaryEmail.toLowerCase()

  // Raw SQL for JSONB containment — MikroORM has no @> helper. Fetch the full activity row so we
  // can rebuild CustomerInteraction records (subject/body/time/source) for this person.
  const conn = em.getConnection('read')
  const rows: ActivityRow[] = await conn.execute(
    `SELECT id, external_id, external_provider, activity_type, subject, notes,
            occurred_at, due_at, duration_minutes, location, all_day, owner_user_id, participants
     FROM activities
     WHERE tenant_id = ? AND organization_id = ? AND deleted_at IS NULL
       AND participants IS NOT NULL
       AND participants @> CAST(? AS jsonb)`,
    [tenantId, organizationId, JSON.stringify([{ email }])],
  )

  if (rows.length === 0) return

  console.info(
    `[channel_office365:customer-activity-backfill] person ${customerId} (${email}) — backfilling ${rows.length} activit${rows.length === 1 ? 'y' : 'ies'}`,
  )

  // 1) ActivityLink rows (person + their companies) via the shared linker.
  const emailMap = new Map<string, string[]>([[email, [customerId]]])
  await autoLinkActivityToCustomers(
    em,
    rows.map((r) => ({ activityId: r.id, participants: r.participants })),
    emailMap,
    { tenantId, organizationId },
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
      [customerId],
    )) as Array<{ company_id: string }>
    companyIds = [...new Set(companyRows.map((r) => r.company_id))]
  } catch { /* no company links — person CIs only */ }

  const now = new Date()
  const entityIds = [customerId, ...companyIds]
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
      '[channel_office365:customer-activity-backfill] CustomerInteraction backfill failed:',
      err instanceof Error ? err.message : err,
    )
  }
}
