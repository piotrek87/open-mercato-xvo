/**
 * When a new CRM person is added, retroactively link matching O365 activities.
 *
 * Problem: activities are synced (with participants) BEFORE the person exists in CRM.
 * The delta token advances, so future syncs never re-process those historical events.
 * This subscriber closes the gap: on every new person → scan participants JSONB for
 * their email and create missing ActivityLink rows (ON CONFLICT DO NOTHING).
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { autoLinkActivityToCustomers } from '../lib/customer-linker'

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
}

type PersonCreatedPayload = {
  id: string
  tenantId: string
  organizationId: string
}

export const metadata = {
  event: 'customers.person.created',
  persistent: true,
  id: 'channel_office365.customer-activity-backfill',
}

export default async function handler(
  payload: PersonCreatedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  const { id: customerId, tenantId, organizationId } = payload
  if (!tenantId || !organizationId || !customerId) return

  const em = (ctx.resolve('em') as EntityManager).fork()

  const customers = await findWithDecryption(
    em,
    CustomerEntity,
    { id: customerId, tenantId, organizationId, kind: 'person', deletedAt: null },
    { limit: 1 },
    { tenantId, organizationId },
  )
  const person = customers[0]
  if (!person?.primaryEmail) return

  const email = person.primaryEmail.toLowerCase()

  // Raw SQL for JSONB containment — MikroORM has no @> helper
  const conn = em.getConnection('read')
  const rows: Array<{ id: string; participants: Array<{ email?: string }> }> = await conn.execute(
    `SELECT id, participants FROM activities
     WHERE tenant_id = ? AND organization_id = ? AND deleted_at IS NULL
     AND participants IS NOT NULL
     AND participants @> ?::jsonb`,
    [tenantId, organizationId, JSON.stringify([{ email }])],
  )

  if (rows.length === 0) return

  console.info(
    `[channel_office365:customer-activity-backfill] person ${customerId} (${email}) — backfilling ${rows.length} activit${rows.length === 1 ? 'y' : 'ies'}`,
  )

  const emailMap = new Map<string, string[]>([[email, [customerId]]])
  await autoLinkActivityToCustomers(
    em,
    rows.map((r) => ({ activityId: r.id, participants: r.participants })),
    emailMap,
    { tenantId, organizationId },
  )
}
