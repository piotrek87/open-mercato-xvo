/**
 * When a CRM company is deleted, remove its orphaned ActivityLinks (and any dangling primary-link
 * reference). Mirrors the person-delete cleanup.
 */

import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { cleanupActivityLinksForEntity } from '../lib/entity-link-cleanup'

export const metadata = {
  event: 'customers.company.deleted',
  persistent: true,
  id: 'activities:cleanup-links-on-company-delete',
}

type CompanyDeletedPayload = { id: string; tenantId: string; organizationId?: string | null }

export default async function handle(payload: CompanyDeletedPayload): Promise<void> {
  if (!payload?.id || !payload.tenantId) return
  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()
  await cleanupActivityLinksForEntity(em, {
    entityType: 'customers:company',
    entityId: payload.id,
    tenantId: payload.tenantId,
  })
}
