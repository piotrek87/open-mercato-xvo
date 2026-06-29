/**
 * When a CRM company is deleted, sweep orphaned ActivityLinks for the tenant/org. Mirrors the
 * person-delete cleanup. See lib/entity-link-cleanup.ts for why this is a scoped orphan sweep.
 */

import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sweepOrphanActivityLinks } from '../lib/entity-link-cleanup'

export const metadata = {
  event: 'customers.company.deleted',
  persistent: true,
  id: 'activities:cleanup-links-on-company-delete',
}

type CompanyDeletedPayload = { id: string; tenantId: string; organizationId?: string | null }

export default async function handle(payload: CompanyDeletedPayload): Promise<void> {
  if (!payload?.tenantId) return
  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()
  const { deletedLinks } = await sweepOrphanActivityLinks(em, {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId ?? null,
  })
  if (deletedLinks > 0) {
    console.info(`[activities:cleanup-links] company delete — removed ${deletedLinks} orphaned activity link(s)`)
  }
}
