/**
 * Auto-linking helpers: match activity participant emails against CRM CustomerEntity
 * primary emails and create ActivityLink records for persons AND their companies.
 * Also creates CustomerInteraction records so synced O365 activities appear in the
 * built-in "Aktywności" tab on CRM person/company profiles.
 *
 * CustomerEntity.primaryEmail is encrypted at rest with no hash field, so SQL
 * equality lookup is impossible. Strategy: decrypt all customer emails once per
 * sync run, build an in-memory Map<email, customerId[]>, then batch-insert links
 * via INSERT ... ON CONFLICT DO NOTHING (no prior SELECT needed per link).
 *
 * Company linking: after person links are inserted, a raw SQL lookup on
 * customer_person_profiles retrieves the company_entity_id for each matched person.
 * This ensures the activity also appears on the company timeline.
 *
 * Primary link: sets linkedEntityType/linkedEntityId on the Activity itself (the
 * "primary" CRM association) so built-in CRM widgets that query only by primary link
 * also show synced activities. Uses the first matched person per activity heuristic
 * (sender for inbox, first recipient for sent) — only when no primary link is set yet.
 *
 * CustomerInteraction (Phase 3): creates one CustomerInteraction per (activity, person)
 * pair so that synced O365 emails/meetings are visible in the built-in "Aktywności"
 * tab on the CRM person detail page. Uses an ON CONFLICT ... DO UPDATE to keep data
 * fresh on re-sync. Dedup key: (entity_id, source, organization_id) with source =
 * 'office365:mail:<externalId>' | 'office365:calendar:<externalId>'.
 */

import { randomUUID } from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'

// Mirrors SOFT_LIMIT_LINKS_PER_ACTIVITY = 10 from the Activities API route.
// One consistent cap across manual and auto-created links.
const AUTO_LINK_CAP = 10

type Scope = { tenantId: string; organizationId: string }

type LinkRow = {
  id: string
  activityId: string
  entityType: string
  entityId: string
  isPrimary: boolean
  organizationId: string
  tenantId: string
  createdAt: Date
  createdByUserId: null
}

export type ActivityLinkPair = {
  activityId: string
  participants: Array<{ email?: string; name?: string; status?: string }> | null | undefined
  // Optional: when provided, Phase 3 creates CustomerInteraction records.
  // Workers always supply these; the backfill subscriber omits them.
  externalId?: string | null         // O365 message/event ID — dedup key in CustomerInteraction.source
  interactionType?: 'email' | 'meeting'
  subject?: string | null
  notes?: string | null
  occurredAt?: Date | null           // email: received/sent datetime; meeting: nil (use dueAt)
  dueAt?: Date | null                // meeting: start datetime; email: nil
  allDay?: boolean
  ownerUserId?: string | null
  durationMinutes?: number | null
  location?: string | null
}

/**
 * Loads all non-deleted person CustomerEntity records for the scope and builds
 * Map<lowercase_email, customerId[]>. Multiple customers can share an email
 * (no DB unique constraint on encrypted columns), so the value is an array.
 *
 * Uses findWithDecryption — primary_email has no hashField, SQL WHERE is impossible.
 * Returns an empty map on any error so callers continue the sync run without linking.
 */
export async function buildEmailCustomerMap(
  em: EntityManager,
  scope: Scope,
): Promise<Map<string, string[]>> {
  try {
    const customers = await findWithDecryption(
      em,
      CustomerEntity,
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        kind: 'person',
        deletedAt: null,
      },
      undefined,
      scope,
    )
    const map = new Map<string, string[]>()
    for (const c of customers) {
      if (!c.primaryEmail) continue
      const key = c.primaryEmail.toLowerCase()
      const bucket = map.get(key)
      if (bucket) {
        bucket.push(c.id)
      } else {
        map.set(key, [c.id])
      }
    }
    return map
  } catch (err) {
    console.warn(
      '[channel_office365] buildEmailCustomerMap failed — auto-linking skipped:',
      err instanceof Error ? err.message : err,
    )
    return new Map()
  }
}

/**
 * Batch-inserts ActivityLink rows for (activityId, participants) pairs where
 * participant emails match entries in emailMap. Also creates CustomerInteraction
 * records so synced activities appear in the built-in "Aktywności" tab.
 *
 * Phase 1: Links for matched persons (customers:person).
 * Phase 1b: Sets linkedEntityType/linkedEntityId on the Activity itself (primary link)
 *   so CRM widgets that query by primary link (not includeLinked) also show the activity.
 *   Only applied where linked_entity_id IS NULL (never overwrites existing primary links).
 *   Uses the first matched person per activity — ordering preserves participant list order
 *   so sender (inbox) or first recipient (sent) takes precedence.
 * Phase 2: Links for companies of matched persons (customers:company) — resolved
 *   via a single raw SQL lookup on customer_person_profiles.company_entity_id.
 * Phase 3: CustomerInteraction records for each (activity, person) pair — one CI per
 *   combination so the activity appears in the built-in Aktywności tab. ON CONFLICT
 *   DO UPDATE refreshes stale data on re-sync.
 *
 * Uses em.upsertMany with onConflictAction: 'ignore' for ActivityLink →
 *   INSERT ... ON CONFLICT DO NOTHING
 * Uses raw SQL ON CONFLICT DO UPDATE for CustomerInteraction (partial unique index).
 *
 * Cap: up to AUTO_LINK_CAP (10) person links per activity.
 */
export type AutoLinkResult = {
  /** activityId → personIds[] — for all activity types */
  persons: Map<string, string[]>
  /** activityId → companyIds[] — companies associated with matched persons */
  companies: Map<string, string[]>
}

/**
 * Returns AutoLinkResult with persons and companies maps for all (activity, entity) pairs linked.
 * Email CIs are NOT created here — email-thread-builder.ts creates them with externalMessageId.
 * Meeting CIs (persons + companies) are created in Phase 3.
 */
export async function autoLinkActivityToCustomers(
  em: EntityManager,
  pairs: ActivityLinkPair[],
  emailMap: Map<string, string[]>,
  scope: Scope,
): Promise<AutoLinkResult> {
  const emptyResult: AutoLinkResult = { persons: new Map(), companies: new Map() }
  if (emailMap.size === 0 || pairs.length === 0) return emptyResult

  const now = new Date()
  const personLinks: LinkRow[] = []
  // First matched person per activity — used for primary link (Phase 1b)
  const firstPersonByActivity = new Map<string, string>()

  for (const { activityId, participants } of pairs) {
    if (!participants?.length) continue

    const seen = new Set<string>()
    let count = 0

    for (const p of participants) {
      if (count >= AUTO_LINK_CAP) break
      const email = p.email?.toLowerCase()
      if (!email) continue
      const customerIds = emailMap.get(email)
      if (!customerIds) continue
      for (const customerId of customerIds) {
        if (count >= AUTO_LINK_CAP) break
        if (seen.has(customerId)) continue
        seen.add(customerId)
        count++
        if (!firstPersonByActivity.has(activityId)) {
          firstPersonByActivity.set(activityId, customerId)
        }
        personLinks.push({
          id: randomUUID(),
          activityId,
          entityType: 'customers:person',
          entityId: customerId,
          isPrimary: false,
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          createdAt: now,
          createdByUserId: null,
        })
      }
    }
  }

  if (personLinks.length === 0) return emptyResult

  // Build matched-persons map for callers (e.g. email-thread-builder)
  const personsByActivity = new Map<string, string[]>()
  for (const link of personLinks) {
    const existing = personsByActivity.get(link.activityId)
    if (existing) existing.push(link.entityId)
    else personsByActivity.set(link.activityId, [link.entityId])
  }

  // Phase 1: insert person links — raw SQL so ON CONFLICT DO NOTHING is guaranteed.
  // em.upsertMany with onConflictAction:'ignore' throws on duplicates in this MikroORM version.
  try {
    const alCols = [
      'id', 'activity_id', 'entity_type', 'entity_id',
      'is_primary', 'organization_id', 'tenant_id', 'created_at', 'created_by_user_id',
    ]
    const alPlaceholders = personLinks
      .map(() => '(' + alCols.map(() => '?').join(', ') + ')')
      .join(', ')
    const alParams = personLinks.flatMap(l => [
      l.id, l.activityId, l.entityType, l.entityId,
      l.isPrimary, l.organizationId, l.tenantId, l.createdAt, l.createdByUserId,
    ])
    await em.getConnection().execute(
      `INSERT INTO activity_links (${alCols.join(', ')})
       VALUES ${alPlaceholders}
       ON CONFLICT DO NOTHING`,
      alParams,
    )
  } catch (err) {
    console.warn(
      '[channel_office365] autoLinkActivityToCustomers (persons) failed:',
      err instanceof Error ? err.message : err,
    )
    return emptyResult
  }

  // Phase 1b: set primary link on activities that don't have one yet.
  // Builds a VALUES table and does a single batch UPDATE — no N+1.
  try {
    const primaryLinkEntries = [...firstPersonByActivity.entries()]
    if (primaryLinkEntries.length > 0) {
      const valuePlaceholders = primaryLinkEntries.map(() => '(?, ?)').join(', ')
      await em.getConnection().execute(
        `UPDATE activities AS a
         SET linked_entity_type = 'customers:person',
             linked_entity_id    = d.person_id::uuid
         FROM (VALUES ${valuePlaceholders}) AS d(activity_id, person_id)
         WHERE a.id = d.activity_id::uuid
           AND a.linked_entity_id IS NULL`,
        primaryLinkEntries.flat(),
      )
    }
  } catch (err) {
    console.warn(
      '[channel_office365] autoLinkActivityToCustomers (primary link update) failed:',
      err instanceof Error ? err.message : err,
    )
  }

  // Phase 2: insert company links — one SQL lookup for all matched persons
  let personToCompany = new Map<string, string>()
  try {
    const personIds = [...new Set(personLinks.map(l => l.entityId))]

    const personPlaceholders = personIds.map(() => '?').join(', ')
    const rows = await em.getConnection().execute(
      `SELECT customer_entity_id AS person_id, company_entity_id AS company_id
       FROM customer_person_profiles
       WHERE customer_entity_id IN (${personPlaceholders})
         AND company_entity_id IS NOT NULL`,
      personIds,
    ) as Array<{ person_id: string; company_id: string }>

    if (rows.length > 0) {
      personToCompany = new Map(rows.map(r => [r.person_id, r.company_id]))
      const seenCompanyKeys = new Set<string>()
      const companyLinks: LinkRow[] = []

      for (const link of personLinks) {
        const companyId = personToCompany.get(link.entityId)
        if (!companyId) continue
        const key = `${link.activityId}:${companyId}`
        if (seenCompanyKeys.has(key)) continue
        seenCompanyKeys.add(key)
        companyLinks.push({
          id: randomUUID(),
          activityId: link.activityId,
          entityType: 'customers:company',
          entityId: companyId,
          isPrimary: false,
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          createdAt: now,
          createdByUserId: null,
        })
      }

      if (companyLinks.length > 0) {
        const alCols2 = [
          'id', 'activity_id', 'entity_type', 'entity_id',
          'is_primary', 'organization_id', 'tenant_id', 'created_at', 'created_by_user_id',
        ]
        const alPlaceholders2 = companyLinks
          .map(() => '(' + alCols2.map(() => '?').join(', ') + ')')
          .join(', ')
        const alParams2 = companyLinks.flatMap(l => [
          l.id, l.activityId, l.entityType, l.entityId,
          l.isPrimary, l.organizationId, l.tenantId, l.createdAt, l.createdByUserId,
        ])
        await em.getConnection().execute(
          `INSERT INTO activity_links (${alCols2.join(', ')})
           VALUES ${alPlaceholders2}
           ON CONFLICT DO NOTHING`,
          alParams2,
        )
      }
    }
  } catch (err) {
    console.warn(
      '[channel_office365] autoLinkActivityToCustomers (companies) failed:',
      err instanceof Error ? err.message : err,
    )
  }

  // Build companiesByActivity from the resolved personToCompany map
  const companiesByActivity = new Map<string, string[]>()
  for (const link of personLinks) {
    const companyId = personToCompany.get(link.entityId)
    if (!companyId) continue
    const existing = companiesByActivity.get(link.activityId)
    if (existing) {
      if (!existing.includes(companyId)) existing.push(companyId)
    } else {
      companiesByActivity.set(link.activityId, [companyId])
    }
  }

  // Phase 3: create/update CustomerInteraction for each (activity, person) pair.
  // Source key embeds the O365 ID so re-syncs hit the ON CONFLICT branch and update
  // rather than inserting duplicates. The partial unique index
  // customer_interactions_o365_dedup_idx covers (entity_id, source, organization_id)
  // WHERE source LIKE 'office365:%' AND deleted_at IS NULL.
  try {
    const pairByActivityId = new Map(pairs.map(p => [p.activityId, p]))

    // Build one CI row per (personLink, activity) combination — deduplicated by seen set.
    const seenCiKeys = new Set<string>()
    type CiRow = {
      id: string
      entityId: string
      interactionType: string
      title: string | null
      body: string | null
      occurredAt: Date | null
      ownerUserId: string | null
      visibility: string
      status: string
      source: string
      durationMinutes: number | null
      location: string | null
      allDay: boolean
      participants: string | null    // JSON-serialised for JSONB insert
      channelProviderKey: string | null
    }
    const ciRows: CiRow[] = []

    for (const link of personLinks) {
      const pair = pairByActivityId.get(link.activityId)
      // Skip CI creation for pairs without full metadata (e.g. backfill subscriber)
      // Skip emails — email-thread-builder.ts creates their CIs with externalMessageId populated
      if (!pair?.externalId || !pair.interactionType || pair.interactionType === 'email') continue

      // After the guard above, interactionType is always 'meeting' — email CIs are handled by email-thread-builder
      const source = `office365:calendar:${pair.externalId}`

      const ciKey = `${link.entityId}:${source}`
      if (seenCiKeys.has(ciKey)) continue
      seenCiKeys.add(ciKey)

      const eventTime = pair.occurredAt ?? pair.dueAt ?? null
      const status = (eventTime && eventTime <= now) ? 'done' : 'planned'

      ciRows.push({
        id: randomUUID(),
        entityId: link.entityId,
        interactionType: pair.interactionType,
        title: pair.subject ?? null,
        body: pair.notes ?? null,
        occurredAt: eventTime,
        ownerUserId: pair.ownerUserId ?? null,
        visibility: 'team',
        status,
        source,
        durationMinutes: pair.durationMinutes ?? null,
        location: pair.location ?? null,
        allDay: pair.allDay ?? false,
        participants: pair.participants != null ? JSON.stringify(pair.participants) : null,
        channelProviderKey: null,
      })
    }

    if (ciRows.length === 0) return { persons: personsByActivity, companies: companiesByActivity }

    // Batch INSERT with ON CONFLICT DO UPDATE — refreshes title/body/time on re-sync.
    // Uses the partial unique index: (entity_id, source, organization_id)
    // WHERE source LIKE 'office365:%' AND deleted_at IS NULL.
    const COLS = [
      'id', 'organization_id', 'tenant_id', 'entity_id',
      'interaction_type', 'title', 'body', 'occurred_at',
      'author_user_id', 'owner_user_id', 'visibility', 'status',
      'source', 'duration_minutes', 'location', 'all_day',
      'participants', 'channel_provider_key', 'pinned', 'created_at', 'updated_at',
    ] as const

    const valueClauses = ciRows
      .map(() => '(' + COLS.map(() => '?').join(', ') + ')')
      .join(', ')

    const params: unknown[] = ciRows.flatMap(r => [
      r.id,
      scope.organizationId,
      scope.tenantId,
      r.entityId,
      r.interactionType,
      r.title,
      r.body,
      r.occurredAt,
      r.ownerUserId,  // author_user_id = same as owner
      r.ownerUserId,
      r.visibility,
      r.status,
      r.source,
      r.durationMinutes,
      r.location,
      r.allDay,
      r.participants,
      r.channelProviderKey,
      false,          // pinned
      now,
      now,
    ])

    await em.getConnection().execute(
      `INSERT INTO customer_interactions (${COLS.join(', ')})
       VALUES ${valueClauses}
       ON CONFLICT (entity_id, source, organization_id)
       WHERE source LIKE 'office365:%' AND deleted_at IS NULL
       DO UPDATE SET
         title              = EXCLUDED.title,
         body               = EXCLUDED.body,
         occurred_at        = EXCLUDED.occurred_at,
         participants       = EXCLUDED.participants,
         status             = EXCLUDED.status,
         updated_at         = NOW()`,
      params,
    )
  } catch (err) {
    console.warn(
      '[channel_office365] autoLinkActivityToCustomers (CustomerInteraction) failed:',
      err instanceof Error ? err.message : err,
    )
  }

  return { persons: personsByActivity, companies: companiesByActivity }
}
