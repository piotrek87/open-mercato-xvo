/**
 * When a CRM person is deleted, remove its orphaned ActivityLinks (and any dangling primary-link
 * reference). CustomerInteractions are cascade-removed by the customers delete; activity_links are
 * not, so without this they linger pointing at a non-existent person.
 */

import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { cleanupActivityLinksForEntity } from '../lib/entity-link-cleanup'

export const metadata = {
  event: 'customers.person.deleted',
  persistent: true,
  id: 'activities:cleanup-links-on-person-delete',
}

type PersonDeletedPayload = { id: string; tenantId: string; organizationId?: string | null }

export default async function handle(payload: PersonDeletedPayload): Promise<void> {
  if (!payload?.id || !payload.tenantId) return
  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()
  await cleanupActivityLinksForEntity(em, {
    entityType: 'customers:person',
    entityId: payload.id,
    tenantId: payload.tenantId,
  })
}
