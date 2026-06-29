/**
 * When a new CRM person is added, retroactively surface their historical O365 emails/meetings on
 * the CRM card. See lib/o365-history-backfill.ts for the full mechanism (hub-link rebuild +
 * ActivityLink + CustomerInteraction), which is shared with the company.created subscriber.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { backfillO365HistoryForPerson } from '../lib/o365-history-backfill'

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

  await backfillO365HistoryForPerson(
    em,
    { tenantId, organizationId },
    customerId,
    person.primaryEmail,
    new Date(),
  )
}
