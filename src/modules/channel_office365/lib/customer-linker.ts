/**
 * Auto-linking helpers: match activity participant emails against CRM CustomerEntity
 * primary emails and create ActivityLink records for persons AND their companies.
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
 */

import { randomUUID } from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { ActivityLink } from '../../activities/data/entities'

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
  participants: Array<{ email?: string }> | null | undefined
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
 * participant emails match entries in emailMap.
 *
 * Phase 1: Links for matched persons (customers:person).
 * Phase 1b: Sets linkedEntityType/linkedEntityId on the Activity itself (primary link)
 *   so CRM widgets that query by primary link (not includeLinked) also show the activity.
 *   Only applied where linked_entity_id IS NULL (never overwrites existing primary links).
 *   Uses the first matched person per activity — ordering preserves participant list order
 *   so sender (inbox) or first recipient (sent) takes precedence.
 * Phase 2: Links for companies of matched persons (customers:company) — resolved
 *   via a single raw SQL lookup on customer_person_profiles.company_entity_id.
 *
 * Uses em.upsertMany with onConflictAction: 'ignore' →
 *   INSERT ... ON CONFLICT DO NOTHING
 * so existing links are silently skipped without a prior SELECT.
 *
 * Cap: up to AUTO_LINK_CAP (10) person links per activity.
 */
export async function autoLinkActivityToCustomers(
  em: EntityManager,
  pairs: ActivityLinkPair[],
  emailMap: Map<string, string[]>,
  scope: Scope,
): Promise<void> {
  if (emailMap.size === 0 || pairs.length === 0) return

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

  if (personLinks.length === 0) return

  // Phase 1: insert person links
  try {
    await em.upsertMany(ActivityLink, personLinks, {
      onConflictAction: 'ignore',
      disableIdentityMap: true,
    })
  } catch (err) {
    console.warn(
      '[channel_office365] autoLinkActivityToCustomers (persons) failed:',
      err instanceof Error ? err.message : err,
    )
    return
  }

  // Phase 1b: set primary link on activities that don't have one yet.
  // Builds a VALUES table and does a single batch UPDATE — no N+1.
  try {
    const pairs = [...firstPersonByActivity.entries()]
    if (pairs.length > 0) {
      const valuePlaceholders = pairs
        .map((_, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}::uuid)`)
        .join(', ')
      await em.getConnection().execute(
        `UPDATE activities AS a
         SET linked_entity_type = 'customers:person',
             linked_entity_id    = d.person_id
         FROM (VALUES ${valuePlaceholders}) AS d(activity_id, person_id)
         WHERE a.id = d.activity_id
           AND a.linked_entity_id IS NULL`,
        pairs.flat(),
      )
    }
  } catch (err) {
    console.warn(
      '[channel_office365] autoLinkActivityToCustomers (primary link update) failed:',
      err instanceof Error ? err.message : err,
    )
  }

  // Phase 2: insert company links — one SQL lookup for all matched persons
  try {
    const personIds = [...new Set(personLinks.map(l => l.entityId))]

    const rows = await em.getConnection().execute(
      `SELECT customer_entity_id AS person_id, company_entity_id AS company_id
       FROM customer_person_profiles
       WHERE customer_entity_id = ANY($1)
         AND company_entity_id IS NOT NULL`,
      [personIds],
    ) as Array<{ person_id: string; company_id: string }>

    if (rows.length === 0) return

    const personToCompany = new Map(rows.map(r => [r.person_id, r.company_id]))

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

    if (companyLinks.length === 0) return

    await em.upsertMany(ActivityLink, companyLinks, {
      onConflictAction: 'ignore',
      disableIdentityMap: true,
    })
  } catch (err) {
    console.warn(
      '[channel_office365] autoLinkActivityToCustomers (companies) failed:',
      err instanceof Error ? err.message : err,
    )
  }
}
