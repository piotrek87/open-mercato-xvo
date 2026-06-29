/**
 * When a new CRM company is added, retroactively surface the historical O365 emails/meetings of its
 * already-linked people on the company card.
 *
 * The person.created subscriber already creates company CustomerInteractions when the person is
 * linked to a company at the moment that person is added. This handler covers the reverse ordering:
 * a company created (or imported) AFTER its people already exist. For every person currently linked
 * to the new company we run the shared person backfill, which resolves that person's companies
 * (now including this one) and writes the company's ActivityLinks + CustomerInteractions.
 *
 * If no people are linked yet (the common "create company first, add people later" flow), this is a
 * no-op — those people will be covered by person.created when they are added/linked. All writes are
 * idempotent, so overlap between the two triggers is safe.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { backfillO365HistoryForPerson } from '../lib/o365-history-backfill'

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
}

type CompanyCreatedPayload = {
  id: string
  tenantId: string
  organizationId: string
}

export const metadata = {
  event: 'customers.company.created',
  persistent: true,
  id: 'channel_office365.customer-company-activity-backfill',
}

export default async function handler(
  payload: CompanyCreatedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  const { id: companyId, tenantId, organizationId } = payload
  if (!tenantId || !organizationId || !companyId) return

  const em = (ctx.resolve('em') as EntityManager).fork()

  // People already linked to this company.
  let personIds: string[] = []
  try {
    const rows = (await em.getConnection('read').execute(
      `SELECT DISTINCT person_entity_id AS person_id
       FROM customer_person_company_links
       WHERE company_entity_id = ? AND person_entity_id IS NOT NULL AND deleted_at IS NULL`,
      [companyId],
    )) as Array<{ person_id: string }>
    personIds = rows.map((r) => r.person_id)
  } catch { /* no links table row — nothing to backfill */ }

  if (personIds.length === 0) return

  // Decrypt the linked persons' primary emails (no hash field → SQL equality impossible).
  const persons = await findWithDecryption(
    em,
    CustomerEntity,
    { id: { $in: personIds }, tenantId, organizationId, kind: 'person', deletedAt: null },
    undefined,
    { tenantId, organizationId },
  )

  const now = new Date()
  for (const person of persons) {
    if (!person.primaryEmail) continue
    await backfillO365HistoryForPerson(
      em,
      { tenantId, organizationId },
      person.id,
      person.primaryEmail,
      now,
    )
  }
}
