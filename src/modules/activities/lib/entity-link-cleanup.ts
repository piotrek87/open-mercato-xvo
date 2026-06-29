import type { EntityManager } from '@mikro-orm/postgresql'

export type LinkedEntityType = 'customers:person' | 'customers:company'

/**
 * Remove an entity's ActivityLinks when that CRM entity (person/company) is deleted.
 *
 * Deleting a person/company hard-deletes the row and cascade-removes its CustomerInteractions, but
 * NOT the activities module's own `activity_links` — those linger as orphans pointing at a record
 * that no longer exists. This cleans them up:
 *   - delete activity_links from this entity to any activity;
 *   - clear the dangling primary-link reference (activities.linked_entity_id/_type) where it pointed
 *     at this entity.
 *
 * The Activity rows themselves are intentionally kept — a synced email/meeting is a real record
 * (often linked to other contacts too), and if the contact is re-added the backfill re-links it.
 */
export async function cleanupActivityLinksForEntity(
  em: EntityManager,
  params: { entityType: LinkedEntityType; entityId: string; tenantId: string },
): Promise<void> {
  const { entityType, entityId, tenantId } = params
  if (!entityId || !tenantId) return

  const conn = em.getConnection()
  await conn.execute(
    `DELETE FROM activity_links WHERE entity_id = ? AND entity_type = ? AND tenant_id = ?`,
    [entityId, entityType, tenantId],
  )
  await conn.execute(
    `UPDATE activities
     SET linked_entity_id = NULL, linked_entity_type = NULL
     WHERE linked_entity_id = ? AND linked_entity_type = ? AND tenant_id = ?`,
    [entityId, entityType, tenantId],
  )
}
