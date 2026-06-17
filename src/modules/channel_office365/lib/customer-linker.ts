/**
 * Auto-linking helpers: match activity participant emails against CRM CustomerEntity
 * primary emails and create ActivityLink records.
 *
 * CustomerEntity.primaryEmail is encrypted at rest with no hash field, so SQL
 * equality lookup is impossible. Strategy: decrypt all customer emails once per
 * sync run, build an in-memory Map<email, customerId[]>, then batch-insert links
 * via INSERT ... ON CONFLICT DO NOTHING (no prior SELECT needed per link).
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
 * Uses em.upsertMany with onConflictAction: 'ignore' →
 *   INSERT ... ON CONFLICT DO NOTHING
 * so existing links (e.g. from a previous sync or manual creation) are silently
 * skipped without a prior SELECT. The UNIQUE constraint on (activity_id,
 * entity_type, entity_id) is the authoritative dedup guard.
 *
 * Cap: up to AUTO_LINK_CAP (10) customer links per activity, consistent with
 * the Activities API soft limit.
 */
export async function autoLinkActivityToCustomers(
  em: EntityManager,
  pairs: ActivityLinkPair[],
  emailMap: Map<string, string[]>,
  scope: Scope,
): Promise<void> {
  if (emailMap.size === 0 || pairs.length === 0) return

  const now = new Date()
  const linksToCreate: Array<{
    id: string
    activityId: string
    entityType: string
    entityId: string
    isPrimary: boolean
    organizationId: string
    tenantId: string
    createdAt: Date
    createdByUserId: null
  }> = []

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
        linksToCreate.push({
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

  if (linksToCreate.length === 0) return

  try {
    await em.upsertMany(ActivityLink, linksToCreate, {
      onConflictAction: 'ignore',
      disableIdentityMap: true,
    })
  } catch (err) {
    console.warn(
      '[channel_office365] autoLinkActivityToCustomers failed:',
      err instanceof Error ? err.message : err,
    )
  }
}
