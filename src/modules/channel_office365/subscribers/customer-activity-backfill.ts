/**
 * When a new CRM person is added, retroactively surface their historical O365 emails/meetings on
 * the CRM card. See lib/o365-history-backfill.ts for the full mechanism (hub-link rebuild +
 * ActivityLink + CustomerInteraction), which is shared with the company.created subscriber.
 *
 * IMPORTANT: the `customers.person.created` event payload `id` is the customer_people (profile) id,
 * NOT the customer_entity id (core emits `profile.id ?? entity.id`). All our linkage uses the
 * customer_entity id, so we resolve it via customer_people.entity_id first.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { backfillO365HistoryForPerson } from '../lib/o365-history-backfill'
import { resolveCustomerEntityId } from '../lib/resolve-customer-entity-id'

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
  const { id: payloadId, tenantId, organizationId } = payload
  if (!tenantId || !organizationId || !payloadId) return

  const em = (ctx.resolve('em') as EntityManager).fork()

  // payloadId is the profile id; resolve the real customer_entity id.
  const entityId = await resolveCustomerEntityId(em, payloadId, 'person')

  const customers = await findWithDecryption(
    em,
    CustomerEntity,
    { id: entityId, tenantId, organizationId, kind: 'person', deletedAt: null },
    { limit: 1 },
    { tenantId, organizationId },
  )
  const person = customers[0]
  if (!person?.primaryEmail) return

  await backfillO365HistoryForPerson(
    em,
    { tenantId, organizationId },
    entityId,
    person.primaryEmail,
    new Date(),
  )
}
