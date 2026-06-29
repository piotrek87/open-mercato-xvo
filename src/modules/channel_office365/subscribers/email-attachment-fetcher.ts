/**
 * Deferred attachment fetcher for hub-ingested O365 emails.
 *
 * Runs after communication_channels.message.received for office365_mail messages
 * that have hasAttachments: true. Downloads each attachment from Graph API and
 * stores it via the attachments module (partition 'email_attachments').
 *
 * Only active when channelState.settings.syncAttachments === true on the email
 * channel. Default is false — users must opt in consciously because attachments
 * consume storage.
 *
 * Dedup: idempotent on retry (subscriber persistent: true) because
 * MessageChannelLink.channelPayload is updated atomically via nativeUpdate.
 * On retry the payload already has attachments[] if the first run succeeded.
 */

import { randomUUID } from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CommunicationChannel,
  MessageChannelLink,
} from '@open-mercato/core/modules/communication_channels/data/entities'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import { storePartitionFile } from '@open-mercato/core/modules/attachments/lib/storage'
import { o365UserCredentialsSchema, O365_INTEGRATION_ID, O365_MAIL_PROVIDER_KEY } from '../lib/credentials'
import { GraphApiError } from '../lib/graph-client'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const EMAIL_ATTACHMENTS_PARTITION = 'email_attachments'
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024   // 10 MB
const GRAPH_INLINE_MAX_BYTES = 4 * 1024 * 1024           // 4 MB — Graph includes contentBytes inline below this

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

type CredentialsServiceLike = {
  resolve: (
    integrationId: string,
    scope: { tenantId: string; organizationId: string; userId?: string | null },
  ) => Promise<Record<string, unknown> | null>
}

// Shape returned by GET /me/messages/{id}/attachments
interface GraphAttachment {
  id: string
  name: string
  contentType: string
  size: number
  isInline: boolean
  contentBytes: string | null   // base64; null for large attachments (>4 MB on batch endpoint)
}

export type AttachmentSyncRecord = {
  graphAttachmentId: string
  fileName: string
  mimeType: string
  fileSizeBytes: number
  inline: boolean
  status: 'stored' | 'too_large' | 'fetch_error' | 'skipped_inline'
  omAttachmentId?: string   // present when status === 'stored'
}

export const metadata = {
  event: 'communication_channels.message.received',
  persistent: true,
  id: 'channel_office365.email-attachment-fetcher',
}

/**
 * Resolve a Graph immutable message id from an RFC 5322 internetMessageId (the `<...@...>` form
 * stored in channelMetadata.messageId). Used as a fallback for links synced before graphId was
 * persisted. Returns null when the message can't be found or the lookup fails.
 */
async function resolveGraphIdByInternetMessageId(
  accessToken: string,
  internetMessageId: string,
): Promise<string | null> {
  const filter = encodeURIComponent(`internetMessageId eq '${internetMessageId.replace(/'/g, "''")}'`)
  try {
    const res = await fetch(
      `${GRAPH_BASE}/me/messages?$filter=${filter}&$select=id&$top=1`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { value?: Array<{ id?: string }> }
    return data.value?.[0]?.id ?? null
  } catch {
    return null
  }
}

export default async function handler(
  payload: MessageReceivedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  if (payload.providerKey !== O365_MAIL_PROVIDER_KEY) return
  if (!payload.tenantId || !payload.organizationId) return

  const em = (ctx.resolve('em') as EntityManager).fork()

  // Load hub link to check hasAttachments flag and get the O365 message ID
  const link = await em.findOne(MessageChannelLink, { id: payload.channelLinkId })
  if (!link?.channelPayload) return

  const cp = link.channelPayload as {
    hasAttachments?: boolean
    attachments?: AttachmentSyncRecord[]
    [k: string]: unknown
  }

  // Skip if no attachments or already processed
  if (!cp.hasAttachments) return
  if (cp.attachments && cp.attachments.length > 0) return

  // Load email channel to read syncAttachments setting
  const channel = await em.findOne(CommunicationChannel, {
    id: payload.channelId,
    tenantId: payload.tenantId,
    deletedAt: null,
  })
  if (!channel) return

  const settings = (channel.channelState as Record<string, unknown> | null)?.settings as
    | { syncAttachments?: boolean; maxAttachmentSizeMb?: number; syncInlineImages?: boolean }
    | undefined

  // Attachments sync is ON by default — fetch unless the user explicitly disabled
  // it (settings.syncAttachments === false). Inline images are still skipped by
  // default (syncInlineImages), so this stores real attachments only, not signature
  // logos. Unset/undefined → treated as enabled (covers channels provisioned before
  // the toggle existed, with no migration).
  if (settings?.syncAttachments === false) return

  const maxBytes = typeof settings?.maxAttachmentSizeMb === 'number'
    ? settings.maxAttachmentSizeMb * 1024 * 1024
    : DEFAULT_MAX_ATTACHMENT_BYTES

  const syncInlineImages = settings?.syncInlineImages === true

  // Resolve credentials
  let credentialsService: CredentialsServiceLike | null = null
  try {
    credentialsService = ctx.resolve<CredentialsServiceLike>('integrationCredentialsService')
  } catch {
    console.warn('[channel_office365:email-attachment-fetcher] integrationCredentialsService not available — skipping')
    return
  }

  const scope = {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    userId: channel.userId ?? null,
  }

  const rawCreds = await credentialsService.resolve(O365_INTEGRATION_ID, scope)
  if (!rawCreds) {
    console.warn(`[channel_office365:email-attachment-fetcher] no credentials for channel ${channel.id}`)
    return
  }
  const parsedCreds = o365UserCredentialsSchema.safeParse(rawCreds)
  if (!parsedCreds.success) {
    console.warn(`[channel_office365:email-attachment-fetcher] invalid credentials for channel ${channel.id}`)
    return
  }
  const accessToken = parsedCreds.data.accessToken

  // Resolve the Graph immutable message id. `channelMetadata.graphId` carries it for messages
  // synced after the graphId fix; `channelMetadata.messageId` is the RFC 5322 Message-ID (used
  // for thread dedup) which Graph rejects as malformed on /messages/{id}/attachments. For older
  // links that only have messageId, resolve the Graph id via an internetMessageId filter.
  const meta = link.channelMetadata as { messageId?: string; graphId?: string } | null
  let graphMessageId = meta?.graphId ?? null
  if (!graphMessageId && meta?.messageId) {
    graphMessageId = await resolveGraphIdByInternetMessageId(accessToken, meta.messageId)
  }
  if (!graphMessageId) {
    console.warn(`[channel_office365:email-attachment-fetcher] no graphMessageId for link ${link.id}`)
    return
  }

  // Fetch attachment list from Graph
  let graphAttachments: GraphAttachment[] = []
  try {
    const res = await fetch(
      `${GRAPH_BASE}/me/messages/${encodeURIComponent(graphMessageId)}/attachments?$top=50`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: { message?: string } }
      if (res.status === 404 || res.status === 403) {
        console.warn(`[channel_office365:email-attachment-fetcher] Graph ${res.status} for message ${graphMessageId} — treating as fetch_error`)
        await em.nativeUpdate(MessageChannelLink, { id: link.id }, {
          channelPayload: { ...cp, attachments: [] },
        })
        return
      }
      throw new GraphApiError(res.status, body?.error?.message ?? res.statusText)
    }
    const data = await res.json() as { value?: GraphAttachment[] }
    graphAttachments = data.value ?? []
  } catch (err) {
    if (err instanceof GraphApiError && (err.status === 429 || err.status >= 500)) {
      throw err  // transient — let persistent subscriber retry
    }
    console.warn(`[channel_office365:email-attachment-fetcher] failed to list attachments for ${graphMessageId}:`, err instanceof Error ? err.message : err)
    return
  }

  const syncRecords: AttachmentSyncRecord[] = []

  for (const att of graphAttachments) {
    const record: AttachmentSyncRecord = {
      graphAttachmentId: att.id,
      fileName: att.name ?? 'attachment',
      mimeType: att.contentType || 'application/octet-stream',
      fileSizeBytes: att.size ?? 0,
      inline: att.isInline,
      status: 'fetch_error',
    }

    if (att.isInline && !syncInlineImages) {
      record.status = 'skipped_inline'
      syncRecords.push(record)
      continue
    }

    if (att.size > maxBytes) {
      record.status = 'too_large'
      syncRecords.push(record)
      continue
    }

    // Download content
    let buffer: Buffer
    try {
      let base64: string | null = att.contentBytes

      if (!base64) {
        // Large attachment (>4 MB) — fetch raw bytes
        const dlRes = await fetch(
          `${GRAPH_BASE}/me/messages/${encodeURIComponent(graphMessageId)}/attachments/${encodeURIComponent(att.id)}/$value`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        if (!dlRes.ok) {
          record.status = 'fetch_error'
          syncRecords.push(record)
          continue
        }
        const arrayBuf = await dlRes.arrayBuffer()
        buffer = Buffer.from(arrayBuf)
      } else {
        buffer = Buffer.from(base64, 'base64')
      }
    } catch {
      record.status = 'fetch_error'
      syncRecords.push(record)
      continue
    }

    // Store file
    try {
      const stored = await storePartitionFile({
        partitionCode: EMAIL_ATTACHMENTS_PARTITION,
        orgId: payload.organizationId,
        tenantId: payload.tenantId,
        fileName: att.name ?? 'attachment',
        buffer,
      })

      const attachmentId = randomUUID()
      const omAttachment = em.create(Attachment, {
        id: attachmentId,
        entityId: 'communication_channels:message_channel_link',
        recordId: link.id,
        organizationId: payload.organizationId ?? null,
        tenantId: payload.tenantId,
        partitionCode: EMAIL_ATTACHMENTS_PARTITION,
        fileName: att.name ?? 'attachment',
        mimeType: att.contentType || 'application/octet-stream',
        fileSize: buffer.length,
        storageDriver: 'local',
        storagePath: stored.storagePath,
        url: `/api/attachments/file/${attachmentId}`,
        content: null,
      })
      em.persist(omAttachment)

      record.status = 'stored'
      record.omAttachmentId = attachmentId
    } catch (err) {
      console.warn(`[channel_office365:email-attachment-fetcher] store failed for ${att.name}:`, err instanceof Error ? err.message : err)
      record.status = 'fetch_error'
    }

    syncRecords.push(record)
  }

  // Flush Attachment rows
  try {
    await em.flush()
  } catch (err) {
    console.warn('[channel_office365:email-attachment-fetcher] flush failed:', err instanceof Error ? err.message : err)
    return
  }

  // Update MessageChannelLink.channelPayload with attachment sync results
  await em.nativeUpdate(MessageChannelLink, { id: link.id }, {
    channelPayload: { ...cp, attachments: syncRecords },
  })
}
