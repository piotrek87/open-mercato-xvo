import type { EntityManager } from '@mikro-orm/postgresql'

/**
 * Remove orphaned ActivityLinks left behind when a CRM person/company is deleted.
 *
 * Deleting a person/company hard-deletes the row and cascade-removes its CustomerInteractions, but
 * NOT the activities module's own `activity_links`, which then point at a non-existent entity.
 *
 * The delete EVENT only carries the profile id (customer_people / customer_companies id), and the
 * profile row is already gone by the time we run — so we can't translate it to the entity id. We
 * therefore do a tenant/org-scoped orphan sweep instead: delete every activity_link (and clear every
 * dangling primary-link reference) whose target entity no longer exists as a live customer_entity.
 * This catches the just-deleted entity's links plus any other orphans.
 *
 * Activity rows themselves are intentionally kept — a synced email/meeting is a real record (usually
 * linked to other contacts too) and is re-linked by the O365 backfill if the contact is re-added.
 */
export async function sweepOrphanActivityLinks(
  em: EntityManager,
  scope: { tenantId: string; organizationId?: string | null },
): Promise<{ deletedLinks: number; clearedRefs: number }> {
  const { tenantId } = scope
  if (!tenantId) return { deletedLinks: 0, clearedRefs: 0 }
  const organizationId = scope.organizationId ?? null

  const conn = em.getConnection()
  const orgClause = organizationId ? ' AND organization_id = ?' : ''
  const params = organizationId ? [tenantId, organizationId] : [tenantId]

  const del = await conn.execute(
    `DELETE FROM activity_links al
     WHERE al.tenant_id = ?${orgClause}
       AND al.entity_type IN ('customers:person', 'customers:company')
       AND NOT EXISTS (
         SELECT 1 FROM customer_entities e WHERE e.id = al.entity_id AND e.deleted_at IS NULL
       )`,
    params,
  )
  const upd = await conn.execute(
    `UPDATE activities a
     SET linked_entity_id = NULL, linked_entity_type = NULL
     WHERE a.tenant_id = ?${orgClause}
       AND a.linked_entity_id IS NOT NULL
       AND a.linked_entity_type IN ('customers:person', 'customers:company')
       AND NOT EXISTS (
         SELECT 1 FROM customer_entities e WHERE e.id = a.linked_entity_id AND e.deleted_at IS NULL
       )`,
    params,
  )

  const affected = (r: unknown): number => {
    const n = (r as { affectedRows?: number } | null)?.affectedRows
    return typeof n === 'number' ? n : 0
  }
  return { deletedLinks: affected(del), clearedRefs: affected(upd) }
}
