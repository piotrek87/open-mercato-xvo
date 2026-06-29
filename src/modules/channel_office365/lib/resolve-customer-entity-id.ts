import type { EntityManager } from '@mikro-orm/postgresql'

/**
 * Customers CRUD events (`customers.person.*`, `customers.company.*`) carry the PROFILE id
 * (`customer_people.id` / `customer_companies.id`), not the `customer_entity` id — core emits
 * `profile.id ?? entity.id`. Every piece of our linkage (ActivityLink.entity_id,
 * CustomerInteraction.entity_id, customer_person_company_links) keys on the customer_entity id, so
 * we must translate the profile id from the event into the entity id.
 *
 * Returns the resolved customer_entity id. Falls back to the input id when it already is an entity
 * id (e.g. a direct CLI call) or when no profile row matches.
 */
export async function resolveCustomerEntityId(
  em: EntityManager,
  payloadId: string,
  kind: 'person' | 'company',
): Promise<string> {
  if (!payloadId) return payloadId
  const profileTable = kind === 'person' ? 'customer_people' : 'customer_companies'
  try {
    const rows = (await em.getConnection('read').execute(
      `SELECT entity_id FROM ${profileTable} WHERE id = ? LIMIT 1`,
      [payloadId],
    )) as Array<{ entity_id: string | null }>
    return rows[0]?.entity_id ?? payloadId
  } catch {
    return payloadId
  }
}
