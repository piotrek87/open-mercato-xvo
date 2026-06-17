/**
 * Mail Sync Worker — polls Microsoft 365 Mail Delta API every 15 minutes.
 *
 * Only runs for channels where capabilities.mail.enabled === true (default: false).
 * Users must explicitly enable email sync via the capability toggle in admin UI.
 *
 * For each eligible channel:
 *   1. Resolve credentials, refresh if expiring
 *   2. Drain Inbox delta (capabilities.mail.deltaToken cursor)
 *   3. Drain SentItems delta (capabilities.mail.sentItemsDeltaToken cursor)
 *   4. Batch upsert Activity records (email type, fact lifecycle) — withAtomicFlush
 *   5. Update channelState with new delta cursors + lastSyncedAt
 *
 * Sprint 5 Phase 2 decisions:
 *   - P2-1: bodyPreview stored in notes (no full body)
 *   - P2-2: attachments not synced
 *   - P2-3: 7-day bootstrap window (enforced by graph-mail-client)
 *   - P2-4: Inbox + SentItems, two independent delta cursors
 *   - P2-5: auto-link to CRM customers by participant email (implemented in customer-linker)
 *
 * Activity mapping:
 *   activityType: 'email', lifecycleMode: 'fact', status: 'fact'
 *   externalProvider: 'office365_mail' (O365_EXTERNAL_PROVIDER_MAIL — NEVER changes)
 *   sourceType: 'inbox' | 'sent' to distinguish direction
 *   occurredAt: receivedDateTime (inbox) or sentDateTime (sent)
 *   visibility: 'team' — synced email is shared CRM history, visible to all users with customer access
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import type { FilterQuery } from '@mikro-orm/core'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { Activity } from '../../activities/data/entities'
import { drainMailDelta, GraphApiError, type GraphMailMessage } from '../lib/graph-mail-client'
import { buildEmailCustomerMap, autoLinkActivityToCustomers } from '../lib/customer-linker'
import {
  o365UserCredentialsSchema,
  o365ChannelStateSchema,
  type O365ChannelState,
  O365_EXTERNAL_PROVIDER_MAIL,
  O365_INTEGRATION_ID,
  O365_PROVIDER_KEY,
} from '../lib/credentials'
import { getO365CalendarAdapter } from '../lib/adapter'

export type MailSyncJobPayload = {
  channelId?: string
}

export const metadata: WorkerMeta = {
  queue: 'channel-office365-mail-sync',
  id: 'channel_office365:mail-sync',
  concurrency: 2,
}

type CredentialsServiceLike = {
  resolve: (
    integrationId: string,
    scope: { tenantId: string; organizationId: string; userId?: string | null },
  ) => Promise<Record<string, unknown> | null>
  save?: (
    integrationId: string,
    credentials: Record<string, unknown>,
    scope: { tenantId: string; organizationId: string; userId?: string | null },
  ) => Promise<void>
}

type HandlerCtx = JobContext & { resolve: <T = unknown>(name: string) => T }

export default async function handle(
  job: QueuedJob,
  ctx: HandlerCtx,
): Promise<void> {
  const em = (ctx.resolve('em') as EntityManager).fork()

  let credentialsService: CredentialsServiceLike | null = null
  try {
    credentialsService = ctx.resolve<CredentialsServiceLike>('integrationCredentialsService')
  } catch {
    console.warn('[channel_office365:mail-sync] integrationCredentialsService not available — skipping')
    return
  }

  const payload = (job.payload ?? {}) as MailSyncJobPayload
  const targetChannelId = typeof payload.channelId === 'string' ? payload.channelId : undefined

  const channelFilter: FilterQuery<CommunicationChannel> = {
    providerKey: O365_PROVIDER_KEY,
    isActive: true,
    deletedAt: null,
    ...(targetChannelId ? { id: targetChannelId } : {}),
  }
  const channels = await em.find(CommunicationChannel, channelFilter)

  const adapter = getO365CalendarAdapter()

  for (const channel of channels.filter((c) => c.status === 'connected' || c.status === 'error')) {
    try {
      await syncChannelMail(channel, em, credentialsService, adapter)
    } catch (err) {
      console.error(
        `[channel_office365:mail-sync] channel ${channel.id} failed:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

async function syncChannelMail(
  channel: CommunicationChannel,
  em: EntityManager,
  credentialsService: CredentialsServiceLike,
  adapter: ReturnType<typeof getO365CalendarAdapter>,
): Promise<void> {
  const scope = {
    tenantId: channel.tenantId,
    organizationId: channel.organizationId ?? channel.tenantId,
    userId: channel.userId ?? null,
  }

  const rawChannelState = (channel.channelState as Record<string, unknown> | null) ?? {}
  const parsedState = o365ChannelStateSchema.safeParse(rawChannelState)
  const channelState: O365ChannelState = parsedState.success ? parsedState.data : {}

  // Skip channels that haven't explicitly enabled mail sync
  if (channelState.capabilities?.mail?.enabled !== true) {
    return
  }

  let rawCreds = await credentialsService.resolve(O365_INTEGRATION_ID, scope)
  if (!rawCreds) {
    console.warn(`[channel_office365:mail-sync] no credentials for channel ${channel.id} — skipping`)
    return
  }

  const parsed = o365UserCredentialsSchema.safeParse(rawCreds)
  if (!parsed.success) {
    console.warn(`[channel_office365:mail-sync] invalid credentials for channel ${channel.id} — skipping`)
    return
  }
  const creds = parsed.data
  const expiresAt = creds.expiresAt ? new Date(creds.expiresAt) : null
  const needsRefresh = expiresAt && (expiresAt.getTime() - Date.now()) < 60_000
  if (needsRefresh && creds.refreshToken) {
    try {
      const tenantClientRaw = await credentialsService.resolve(O365_INTEGRATION_ID, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        userId: null,
      })
      const oauthClient = tenantClientRaw as { clientId?: string; clientSecret?: string; tenantId?: string } | null
      if (oauthClient?.clientId && oauthClient?.clientSecret) {
        const refreshed = await adapter.refreshCredentials({
          channelId: channel.id,
          credentials: rawCreds,
          scope: { tenantId: scope.tenantId, organizationId: scope.organizationId },
          oauthClient: {
            clientId: oauthClient.clientId,
            clientSecret: oauthClient.clientSecret,
            ...(oauthClient.tenantId ? { tenantId: oauthClient.tenantId } : {}),
          },
        })
        rawCreds = refreshed.credentials
        if (credentialsService.save) {
          await credentialsService.save(O365_INTEGRATION_ID, rawCreds, scope)
        }
      }
    } catch (refreshErr) {
      console.warn(
        `[channel_office365:mail-sync] token refresh failed for channel ${channel.id}:`,
        refreshErr instanceof Error ? refreshErr.message : refreshErr,
      )
      if (refreshErr instanceof Error && refreshErr.message === 'requires_reauth') {
        channel.status = 'requires_reauth' as typeof channel.status
        await em.flush()
        return
      }
    }
  }

  const accessToken = (rawCreds.accessToken as string | undefined) ?? ''
  if (!accessToken) return

  const mailCap = channelState.capabilities?.mail ?? {}
  const inboxDeltaToken = mailCap.deltaToken
  const sentItemsDeltaToken = mailCap.sentItemsDeltaToken
  const syncFromDate = typeof mailCap.syncFromDate === 'string'
    ? new Date(mailCap.syncFromDate)
    : undefined

  // Drain both folders — separate cursors, separate passes
  let inboxMessages: GraphMailMessage[] = []
  let nextInboxToken: string | undefined
  let sentMessages: GraphMailMessage[] = []
  let nextSentToken: string | undefined

  try {
    const inboxResult = await drainMailDelta(accessToken, 'inbox', inboxDeltaToken, syncFromDate)
    inboxMessages = inboxResult.messages
    nextInboxToken = inboxResult.nextDeltaToken
  } catch (err) {
    if (err instanceof GraphApiError && err.status === 401) {
      channel.status = 'requires_reauth' as typeof channel.status
      await em.flush()
      return
    }
    throw err
  }

  try {
    const sentResult = await drainMailDelta(accessToken, 'sentItems', sentItemsDeltaToken)
    sentMessages = sentResult.messages
    nextSentToken = sentResult.nextDeltaToken
  } catch (err) {
    if (err instanceof GraphApiError && err.status === 401) {
      channel.status = 'requires_reauth' as typeof channel.status
      await em.flush()
      return
    }
    throw err
  }

  // Filter out drafts and server-side deletes (Phase 2 — deletions not acted upon)
  const validInbox = inboxMessages.filter((m) => !m['@removed'] && !m.isDraft)
  const validSent = sentMessages.filter((m) => !m['@removed'] && !m.isDraft)

  // Batch-load existing activities for all incoming messages (single query)
  const allExternalIds = [
    ...validInbox.map((m) => m.id),
    ...validSent.map((m) => m.id),
  ]
  const existingActivities = allExternalIds.length > 0
    ? await em.find(Activity, {
        externalId: { $in: allExternalIds },
        externalProvider: O365_EXTERNAL_PROVIDER_MAIL,
        organizationId: scope.organizationId,
        deletedAt: null,
      })
    : []
  const existingMap = new Map(existingActivities.map((a) => [a.externalId, a]))

  // Collect (entity, participants) pairs during the flush — IDs of new entities are
  // populated after withAtomicFlush returns (via RETURNING in the INSERT).
  const pendingLinks: Array<{
    entity: Activity
    participants: Array<{ email: string; name?: string; status: string }>
  }> = []

  // Apply all upserts in a single transaction
  if (validInbox.length > 0 || validSent.length > 0) {
    await withAtomicFlush(em, [
      () => {
        for (const msg of validInbox) {
          const result = upsertMailActivity(msg, 'inbox', channel, em, scope, existingMap)
          pendingLinks.push(result)
        }
        for (const msg of validSent) {
          const result = upsertMailActivity(msg, 'sent', channel, em, scope, existingMap)
          pendingLinks.push(result)
        }
      },
    ], { transaction: true, label: 'channel_office365.mail-sync' })
  }

  // Auto-link synced activities to CRM customers by matching participant emails.
  // Built once per channel sync; emailMap is discarded after this block.
  if (pendingLinks.length > 0) {
    const emailMap = await buildEmailCustomerMap(em, scope)
    if (emailMap.size > 0) {
      await autoLinkActivityToCustomers(
        em,
        pendingLinks.map(({ entity, participants }) => ({ activityId: entity.id, participants })),
        emailMap,
        scope,
      )
    }
  }

  // Persist updated cursors + lastSyncedAt in channelState
  const hasUpdates =
    nextInboxToken || nextSentToken || validInbox.length > 0 || validSent.length > 0
  if (hasUpdates) {
    const existingCaps = (rawChannelState.capabilities as Record<string, unknown> | undefined) ?? {}
    const existingMailCap = (existingCaps.mail as Record<string, unknown> | undefined) ?? {}
    channel.channelState = {
      capabilities: {
        ...existingCaps,
        mail: {
          ...existingMailCap,
          enabled: true,
          ...(nextInboxToken ? { deltaToken: nextInboxToken } : {}),
          ...(nextSentToken ? { sentItemsDeltaToken: nextSentToken } : {}),
          lastSyncedAt: new Date().toISOString(),
          bootstrapped: true,
        },
      },
      grantedScopes: channelState.grantedScopes ?? [],
    }
    channel.lastPolledAt = new Date()
    await em.flush()
  }
}

function upsertMailActivity(
  msg: GraphMailMessage,
  folder: 'inbox' | 'sent',
  channel: CommunicationChannel,
  em: EntityManager,
  scope: { tenantId: string; organizationId: string; userId?: string | null },
  existingMap: Map<string | undefined | null, Activity>,
): { entity: Activity; participants: Array<{ email: string; name?: string; status: string }> } {
  const subject = msg.subject?.trim() || '(no subject)'
  const notes = msg.bodyPreview ?? null

  const occurredAt = folder === 'inbox'
    ? (msg.receivedDateTime ? new Date(msg.receivedDateTime) : null)
    : (msg.sentDateTime ? new Date(msg.sentDateTime) : null)

  const participants = buildParticipants(msg, folder)

  // Email metadata — hasAttachments + replyTo (if different from from-address)
  const emailMetadata: Record<string, unknown> = {}
  if (msg.hasAttachments != null) emailMetadata.hasAttachments = msg.hasAttachments
  const replyToList = (msg.replyTo ?? [])
    .map((r) => ({ email: r.emailAddress.address, name: r.emailAddress.name ?? undefined }))
    .filter((r) => r.email !== msg.from?.emailAddress?.address)
  if (replyToList.length > 0) emailMetadata.replyTo = replyToList
  const metadata = Object.keys(emailMetadata).length > 0 ? emailMetadata : null

  const existing = existingMap.get(msg.id)
  if (existing) {
    existing.subject = subject
    existing.notes = notes
    existing.occurredAt = occurredAt
    existing.participants = participants.length > 0 ? participants : null
    existing.metadata = metadata
    existing.visibility = 'team'
    existing.lastSyncedAt = new Date()
    existing.updatedAt = new Date()
    return { entity: existing, participants }
  } else {
    const newActivity = em.create(Activity, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      activityType: 'email',
      lifecycleMode: 'fact',
      subject,
      notes,
      status: 'fact',
      occurredAt,
      dueAt: null,
      participants: participants.length > 0 ? participants : null,
      metadata,
      ownerUserId: channel.userId ?? null,
      allDay: false,
      visibility: 'team',
      externalId: msg.id,
      externalProvider: O365_EXTERNAL_PROVIDER_MAIL,
      syncDirection: 'import',
      sourceType: folder,
      lastSyncedAt: new Date(),
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    em.persist(newActivity)
    return { entity: newActivity, participants }
  }
}

function buildParticipants(
  msg: GraphMailMessage,
  folder: 'inbox' | 'sent',
): Array<{ email: string; name?: string; status: string }> {
  const MAX_TO = 10
  const MAX_CC = 5
  const MAX_BCC = 5

  const fromEntry = msg.from?.emailAddress
    ? [{ email: msg.from.emailAddress.address, name: msg.from.emailAddress.name ?? undefined, status: 'sender' }]
    : []

  const toEntries = (msg.toRecipients ?? []).slice(0, MAX_TO).map((r) => ({
    email: r.emailAddress.address,
    name: r.emailAddress.name ?? undefined,
    status: 'recipient',
  }))

  const ccEntries = (msg.ccRecipients ?? []).slice(0, MAX_CC).map((r) => ({
    email: r.emailAddress.address,
    name: r.emailAddress.name ?? undefined,
    status: 'cc',
  }))

  // BCC populated by Graph only for sent items — hidden from inbox recipients by design
  const bccEntries = folder === 'sent'
    ? (msg.bccRecipients ?? []).slice(0, MAX_BCC).map((r) => ({
        email: r.emailAddress.address,
        name: r.emailAddress.name ?? undefined,
        status: 'bcc',
      }))
    : []

  return [...fromEntry, ...toEntries, ...ccEntries, ...bccEntries]
}
