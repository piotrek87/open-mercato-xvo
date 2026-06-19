/**
 * CRM auto-linker for hub-ingested O365 emails.
 *
 * Listens to communication_channels.message.received for providerKey='office365_mail'.
 * Extracts participant emails from the MessageChannelLink.channelPayload, looks them up
 * against CRM person primaryEmail (via findWithDecryption — no hash field), and creates
 * CustomerInteraction(email) projection rows so hub emails appear in the built-in
 * "Aktywności" tab on CRM person and company detail pages.
 *
 * Source dedup key: 'office365:mail:{channelLinkId}' — matches the partial unique index
 * customer_interactions_o365_dedup_idx (source LIKE 'office365:%' AND deleted_at IS NULL).
 * ON CONFLICT DO NOTHING means re-delivery of the hub event is fully idempotent.
 *
 * Company linking: after person CIs are created, looks up company_entity_id for each matched
 * person via customer_person_profiles and creates company CIs as well.
 */

import { randomUUID } from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  ExternalMessage,
  MessageChannelLink,
} from '@open-mercato/core/modules/communication_channels/data/entities'
import { buildEmailCustomerMap } from '../lib/customer-linker'
import { O365_MAIL_PROVIDER_KEY } from '../lib/credentials'

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
}

type MessageReceivedPayload = {
  messageId: string
  externalMessageId: string
  channelLinkId: string
  conversationId: string
  channelId: string
  providerKey: string
  channelType: string
  direction: string
  tenantId: string
  organizationId: string | null
}

// Mirrors AUTO_LINK_CAP in customer-linker.ts
const AUTO_LINK_CAP = 10

export const metadata = {
  event: 'communication_channels.message.received',
  persistent: true,
  id: 'channel_office365.crm-email-linker',
}

export default async function handler(
  payload: MessageReceivedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  if (payload.providerKey !== O365_MAIL_PROVIDER_KEY) return
  if (!payload.tenantId || !payload.organizationId) return

  const scope = {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
  }

  const em = (ctx.resolve('em') as EntityManager).fork()

  // Load hub link to access channelPayload (participant emails, subject)
  const link = await em.findOne(MessageChannelLink, { id: payload.channelLinkId })
  if (!link?.channelPayload) return

  const cp = link.channelPayload as {
    from?: string | null
    to?: string[]
    cc?: string[]
    bcc?: string[]
    subject?: string | null
    direction?: string
  }

  // Collect all participant email addresses and deduplicate
  const rawEmails: string[] = [
    ...(cp.from ? [cp.from] : []),
    ...(cp.to ?? []),
    ...(cp.cc ?? []),
  ]
  const uniqueEmails = [...new Set(rawEmails.map(e => e.toLowerCase()).filter(Boolean))]
  if (uniqueEmails.length === 0) return

  // Load provider timestamp from ExternalMessage for occurredAt
  let occurredAt: Date | null = null
  if (payload.externalMessageId) {
    const extMsg = await em.findOne(ExternalMessage, { id: payload.externalMessageId })
    occurredAt = extMsg?.providerTimestamp ?? null
  }

  // Build email → customerId[] map for the entire org (decrypts primaryEmail in memory)
  const emailMap = await buildEmailCustomerMap(em, scope)
  if (emailMap.size === 0) return

  // Find which participant emails match CRM persons
  const now = new Date()
  const seenPersonIds = new Set<string>()
  const matchedPersonIds: string[] = []

  for (const email of uniqueEmails) {
    const ids = emailMap.get(email)
    if (!ids) continue
    for (const id of ids) {
      if (seenPersonIds.has(id) || matchedPersonIds.length >= AUTO_LINK_CAP) break
      seenPersonIds.add(id)
      matchedPersonIds.push(id)
    }
  }

  if (matchedPersonIds.length === 0) return

  const source = `office365:mail:${link.id}`
  const title = cp.subject ?? null
  const ciStatus = occurredAt && occurredAt <= now ? 'done' : 'planned'

  const COLS = [
    'id', 'organization_id', 'tenant_id', 'entity_id',
    'interaction_type', 'title', 'body', 'occurred_at',
    'author_user_id', 'owner_user_id', 'visibility', 'status',
    'source', 'duration_minutes', 'location', 'all_day',
    'participants', 'channel_provider_key', 'pinned', 'created_at', 'updated_at',
  ] as const

  // Phase 1: person CustomerInteraction rows
  try {
    const personRows = matchedPersonIds.map(personId => [
      randomUUID(),
      scope.organizationId,
      scope.tenantId,
      personId,
      'email',
      title,
      null,           // body
      occurredAt,
      null,           // author_user_id
      null,           // owner_user_id
      'team',
      ciStatus,
      source,
      null,           // duration_minutes
      null,           // location
      false,          // all_day
      null,           // participants
      O365_MAIL_PROVIDER_KEY,
      false,          // pinned
      now,
      now,
    ])

    const valueClauses = personRows.map(() => '(' + COLS.map(() => '?').join(', ') + ')').join(', ')
    await em.getConnection().execute(
      `INSERT INTO customer_interactions (${COLS.join(', ')})
       VALUES ${valueClauses}
       ON CONFLICT (entity_id, source, organization_id)
       WHERE source LIKE 'office365:%' AND deleted_at IS NULL
       DO NOTHING`,
      personRows.flat(),
    )
  } catch (err) {
    console.warn(
      '[channel_office365:crm-email-linker] person CI insert failed:',
      err instanceof Error ? err.message : err,
    )
    return
  }

  // Phase 2: company CustomerInteraction rows — look up company_entity_id for each person
  try {
    const personPlaceholders = matchedPersonIds.map(() => '?').join(', ')
    const companyRows: Array<{ person_id: string; company_id: string }> = await em.getConnection().execute(
      `SELECT customer_entity_id AS person_id, company_entity_id AS company_id
       FROM customer_person_profiles
       WHERE customer_entity_id IN (${personPlaceholders})
         AND company_entity_id IS NOT NULL`,
      matchedPersonIds,
    )

    if (companyRows.length === 0) return

    const seenCompanyIds = new Set<string>()
    const companyValues: unknown[][] = []
    for (const row of companyRows) {
      if (seenCompanyIds.has(row.company_id)) continue
      seenCompanyIds.add(row.company_id)
      companyValues.push([
        randomUUID(),
        scope.organizationId,
        scope.tenantId,
        row.company_id,
        'email',
        title,
        null,
        occurredAt,
        null,
        null,
        'team',
        ciStatus,
        source,
        null,
        null,
        false,
        null,
        O365_MAIL_PROVIDER_KEY,
        false,
        now,
        now,
      ])
    }

    if (companyValues.length === 0) return

    const companyValueClauses = companyValues.map(() => '(' + COLS.map(() => '?').join(', ') + ')').join(', ')
    await em.getConnection().execute(
      `INSERT INTO customer_interactions (${COLS.join(', ')})
       VALUES ${companyValueClauses}
       ON CONFLICT (entity_id, source, organization_id)
       WHERE source LIKE 'office365:%' AND deleted_at IS NULL
       DO NOTHING`,
      companyValues.flat(),
    )
  } catch (err) {
    console.warn(
      '[channel_office365:crm-email-linker] company CI insert failed:',
      err instanceof Error ? err.message : err,
    )
  }
}
