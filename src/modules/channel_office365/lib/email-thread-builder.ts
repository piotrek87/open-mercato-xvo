/**
 * Sprint 7B — E-maile tab support for O365 sync.
 *
 * Creates the full chain required by buildPersonEmailThreads (core):
 *   ExternalConversation → Message → MessageChannelLink → CustomerInteraction(externalMessageId)
 *
 * The "E-maile" tab on the CRM person detail page reads:
 *   CustomerInteraction WHERE entity_id = personId AND externalMessageId IS NOT NULL
 *   → MessageChannelLink (via externalMessageId)
 *   → Message (via messageId, grouped by threadId)
 *
 * One CustomerInteraction per (email, CRM person) pair — so if one email matches
 * two CRM contacts, each gets their own CI pointing to the same MessageChannelLink.
 *
 * Deduplication:
 *   ExternalConversation: ON CONFLICT ON CONSTRAINT external_conversations_channel_external_uq
 *   Message: ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
 *   MessageChannelLink: ON CONFLICT ON CONSTRAINT message_channel_links_message_uq
 *   CustomerInteraction: ON CONFLICT (entity_id, source, organization_id) WHERE source LIKE 'office365:%'
 *
 * All ON CONFLICT branches use DO UPDATE to force RETURNING to return the existing row's ID,
 * allowing downstream steps to use the correct UUID even on re-sync.
 */

import { randomUUID } from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'

type Scope = { tenantId: string; organizationId: string }

export type EmailThreadEntry = {
  activityId: string
  externalId: string                   // O365 message ID (unique per email)
  conversationId: string | null        // O365 conversation thread ID (groups emails in E-maile tab)
  subject: string | null
  bodyPreview: string | null
  occurredAt: Date | null
  direction: 'inbound' | 'outbound'
  ownerUserId: string | null
  participants: Array<{ email: string; name?: string; status: string }> | null
}

/**
 * Creates ExternalConversation + Message + MessageChannelLink records for each email,
 * then creates/updates CustomerInteraction with externalMessageId populated.
 *
 * Called after autoLinkActivityToCustomers so we know which CRM persons matched.
 * matchedPersonsByActivity: Map<activityId, personId[]> — from autoLinkActivityToCustomers return value.
 * channelId: the CommunicationChannel UUID (for ExternalConversation.channelId).
 */
export async function buildEmailThreadRecords(
  em: EntityManager,
  emails: EmailThreadEntry[],
  matchedPersonsByActivity: Map<string, string[]>,
  channelId: string,
  scope: Scope,
): Promise<void> {
  // Only process emails that matched at least one CRM person
  const relevant = emails.filter(e => matchedPersonsByActivity.has(e.activityId))
  if (relevant.length === 0) return

  try {
    const now = new Date()

    // ─── Phase A: ExternalConversations (one per unique O365 conversationId) ─────────
    //
    // O365 conversationId is a string like 'AAQkADhi...'; we store it in
    // external_conversation_id (text) and let the DB generate the UUID PK.
    // For emails without conversationId we use 'msg:<externalId>' as a synthetic key
    // so each standalone email forms its own "conversation".
    //
    // RETURNING id, external_conversation_id lets us build the lookup map without
    // knowing which UUID the DB chose for pre-existing rows.

    const uniqueConversationKeys = [...new Set(
      relevant.map(e => e.conversationId ?? `msg:${e.externalId}`)
    )]

    // Subject for the conversation = subject of the first email in the thread
    const subjectByConvKey = new Map<string, string | null>()
    for (const e of relevant) {
      const key = e.conversationId ?? `msg:${e.externalId}`
      if (!subjectByConvKey.has(key)) subjectByConvKey.set(key, e.subject ?? null)
    }

    const ecCols = [
      'id', 'channel_id', 'external_conversation_id', 'subject',
      'tenant_id', 'organization_id', 'created_at', 'updated_at',
    ]
    const ecN = ecCols.length
    const ecValueClauses = uniqueConversationKeys
      .map((_, i) => '(' + ecCols.map((_, j) => `$${i * ecN + j + 1}`).join(', ') + ')')
      .join(', ')
    const ecParams: unknown[] = uniqueConversationKeys.flatMap(key => [
      randomUUID(),
      channelId,
      key,
      subjectByConvKey.get(key) ?? null,
      scope.tenantId,
      scope.organizationId,
      now,
      now,
    ])

    const ecRows = await em.getConnection().execute(
      `INSERT INTO external_conversations (${ecCols.join(', ')})
       VALUES ${ecValueClauses}
       ON CONFLICT ON CONSTRAINT external_conversations_channel_external_uq
       DO UPDATE SET subject = EXCLUDED.subject, updated_at = NOW()
       RETURNING id, external_conversation_id`,
      ecParams,
    ) as Array<{ id: string; external_conversation_id: string }>

    // Map: O365 conversationKey → ExternalConversation UUID
    const ecIdByKey = new Map(ecRows.map(r => [r.external_conversation_id, r.id]))

    // ─── Phase B: Messages (one per email) ───────────────────────────────────────────
    //
    // idempotency_key = O365 message ID ensures we don't create duplicate Message
    // records on re-sync. threadId = ExternalConversation.id so emails in the same
    // O365 conversation are grouped in the E-maile tab thread view.
    // senderUserId = channel.userId (the OM user who owns the O365 channel) — required
    // by the Message entity; external senders don't have OM user IDs.

    const msgCols = [
      'id', 'thread_id', 'sender_user_id', 'subject', 'body',
      'status', 'is_draft', 'sent_at',
      'tenant_id', 'organization_id', 'idempotency_key', 'created_at', 'updated_at',
    ]
    const msgN = msgCols.length
    const msgValueClauses = relevant
      .map((_, i) => '(' + msgCols.map((_, j) => `$${i * msgN + j + 1}`).join(', ') + ')')
      .join(', ')
    const msgParams: unknown[] = relevant.flatMap(e => {
      const convKey = e.conversationId ?? `msg:${e.externalId}`
      const threadId = ecIdByKey.get(convKey) ?? null
      return [
        randomUUID(),
        threadId,
        e.ownerUserId ?? null,   // senderUserId — channel owner as proxy
        e.subject ?? '',
        e.bodyPreview ?? '',
        'sent',
        false,
        e.occurredAt,
        scope.tenantId,
        scope.organizationId,
        e.externalId,            // idempotencyKey = O365 message ID
        now,
        now,
      ]
    })

    const msgRows = await em.getConnection().execute(
      `INSERT INTO messages (${msgCols.join(', ')})
       VALUES ${msgValueClauses}
       ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, updated_at = NOW()
       RETURNING id, idempotency_key`,
      msgParams,
    ) as Array<{ id: string; idempotency_key: string }>

    // Map: O365 externalId → Message UUID
    const msgIdByExternalId = new Map(msgRows.map(r => [r.idempotency_key, r.id]))

    // ─── Phase C: MessageChannelLinks (one per Message) ──────────────────────────────
    //
    // channelPayload (inbound) / channelMetadata (outbound) carry from/to/cc so the
    // E-maile tab can render email headers. buildPersonEmailThreads reads these fields.

    const mclCols = [
      'id', 'message_id', 'external_conversation_id',
      'provider_key', 'channel_type', 'direction',
      'channel_payload', 'channel_metadata',
      'delivery_status', 'tenant_id', 'organization_id', 'created_at',
    ]
    const mclN = mclCols.length
    const mclValueClauses = relevant
      .map((_, i) => '(' + mclCols.map((_, j) => `$${i * mclN + j + 1}`).join(', ') + ')')
      .join(', ')

    const mclParams: unknown[] = relevant.flatMap(e => {
      const msgId = msgIdByExternalId.get(e.externalId) ?? null
      const convKey = e.conversationId ?? `msg:${e.externalId}`
      const ecId = ecIdByKey.get(convKey) ?? null

      const sender = e.participants?.find(p => p.status === 'sender')
      const recipients = e.participants?.filter(p => p.status === 'recipient') ?? []
      const cc = e.participants?.filter(p => p.status === 'cc') ?? []

      const addrFrom = sender ? { email: sender.email, name: sender.name } : null
      const addrTo = recipients.map(p => ({ email: p.email, name: p.name }))
      const addrCc = cc.map(p => ({ email: p.email, name: p.name }))

      // inbound → channelPayload; outbound → channelMetadata (mirrors core channel conventions)
      const channelPayload = e.direction === 'inbound' ? JSON.stringify({
        from: addrFrom,
        to: addrTo.length > 0 ? addrTo : undefined,
        cc: addrCc.length > 0 ? addrCc : undefined,
        subject: e.subject,
        text: e.bodyPreview,
      }) : null

      const channelMetadata = e.direction === 'outbound' ? JSON.stringify({
        from: addrFrom,
        to: addrTo.length > 0 ? addrTo : undefined,
        cc: addrCc.length > 0 ? addrCc : undefined,
        subject: e.subject,
        bodyText: e.bodyPreview,
      }) : null

      return [
        randomUUID(),
        msgId,
        ecId,
        'office365',
        'email',
        e.direction,
        channelPayload,
        channelMetadata,
        'delivered',
        scope.tenantId,
        scope.organizationId,
        now,
      ]
    })

    const mclRows = await em.getConnection().execute(
      `INSERT INTO message_channel_links (${mclCols.join(', ')})
       VALUES ${mclValueClauses}
       ON CONFLICT ON CONSTRAINT message_channel_links_message_uq
       DO UPDATE SET delivery_status = EXCLUDED.delivery_status
       RETURNING id, message_id`,
      mclParams,
    ) as Array<{ id: string; message_id: string }>

    // Map: Message UUID → MessageChannelLink UUID
    const mclIdByMsgId = new Map(mclRows.map(r => [r.message_id, r.id]))

    // Map: O365 externalId → MessageChannelLink UUID
    const mclIdByExternalId = new Map(
      relevant
        .map(e => {
          const msgId = msgIdByExternalId.get(e.externalId)
          const mclId = msgId ? mclIdByMsgId.get(msgId) : undefined
          return mclId ? ([e.externalId, mclId] as [string, string]) : null
        })
        .filter((x): x is [string, string] => x !== null)
    )

    // ─── Phase D: CustomerInteractions (one per email × person) ─────────────────────
    //
    // externalMessageId = MessageChannelLink.id — this is what the E-maile tab joins on.
    // ON CONFLICT DO UPDATE also updates existing Sprint-7A CI records that had
    // externalMessageId = NULL, so a single resync after Sprint 7B deploy is enough.

    const ciCols = [
      'id', 'organization_id', 'tenant_id', 'entity_id',
      'interaction_type', 'title', 'body', 'occurred_at',
      'author_user_id', 'owner_user_id', 'visibility', 'status',
      'source', 'external_message_id', 'channel_provider_key',
      'pinned', 'created_at', 'updated_at',
    ] as const
    const ciN = ciCols.length

    const seenCiKeys = new Set<string>()
    const ciData: Array<Parameters<typeof Array.prototype.push>[0][]> = []

    for (const e of relevant) {
      const mclId = mclIdByExternalId.get(e.externalId)
      if (!mclId) continue

      const personIds = matchedPersonsByActivity.get(e.activityId) ?? []
      const source = `office365:mail:${e.externalId}`

      for (const personId of personIds) {
        const ciKey = `${personId}:${source}`
        if (seenCiKeys.has(ciKey)) continue
        seenCiKeys.add(ciKey)

        ciData.push([
          randomUUID(),
          scope.organizationId,
          scope.tenantId,
          personId,
          'email',
          e.subject ?? null,
          e.bodyPreview ?? null,
          e.occurredAt,
          e.ownerUserId ?? null,  // author_user_id
          e.ownerUserId ?? null,  // owner_user_id
          'shared',               // email visibility vocabulary
          'done',
          source,
          mclId,
          'office365',
          false,                  // pinned
          now,
          now,
        ])
      }
    }

    if (ciData.length === 0) return

    const ciValueClauses = ciData
      .map((_, i) => '(' + ciCols.map((_, j) => `$${i * ciN + j + 1}`).join(', ') + ')')
      .join(', ')
    const ciParams = ciData.flat()

    await em.getConnection().execute(
      `INSERT INTO customer_interactions (${ciCols.join(', ')})
       VALUES ${ciValueClauses}
       ON CONFLICT (entity_id, source, organization_id)
       WHERE source LIKE 'office365:%' AND deleted_at IS NULL
       DO UPDATE SET
         external_message_id  = EXCLUDED.external_message_id,
         channel_provider_key = EXCLUDED.channel_provider_key,
         title                = EXCLUDED.title,
         body                 = EXCLUDED.body,
         occurred_at          = EXCLUDED.occurred_at,
         updated_at           = NOW()`,
      ciParams,
    )
  } catch (err) {
    console.warn(
      '[channel_office365] buildEmailThreadRecords failed:',
      err instanceof Error ? err.message : err,
    )
  }
}
