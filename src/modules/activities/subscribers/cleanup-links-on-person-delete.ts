/**
 * When a CRM person is deleted, sweep orphaned ActivityLinks (links pointing at a now-deleted
 * entity) for the tenant/org. CustomerInteractions are cascade-removed by the customers delete;
 * activity_links are not, so without this they linger. See lib/entity-link-cleanup.ts for why this
 * is a scoped orphan sweep rather than a per-id delete (the delete event only carries the profile
 * id, and the profile row is already gone).
 */

import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sweepOrphanActivityLinks } from '../lib/entity-link-cleanup'

export const metadata = {
  event: 'customers.person.deleted',
  persistent: true,
  id: 'activities:cleanup-links-on-person-delete',
}

type PersonDeletedPayload = { id: string; tenantId: string; organizationId?: string | null }

export default async function handle(payload: PersonDeletedPayload): Promise<void> {
  if (!payload?.tenantId) return
  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()
  const { deletedLinks } = await sweepOrphanActivityLinks(em, {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId ?? null,
  })
  if (deletedLinks > 0) {
    console.info(`[activities:cleanup-links] person delete — removed ${deletedLinks} orphaned activity link(s)`)
  }
}
