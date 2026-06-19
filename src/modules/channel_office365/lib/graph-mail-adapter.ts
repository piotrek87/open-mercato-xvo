/**
 * O365 Email ChannelAdapter.
 *
 * Implements the hub's ChannelAdapter contract for Microsoft Graph mail.
 * Replaces the standalone mail-sync worker (Phase 3 cleanup).
 *
 * providerKey: 'office365_mail'  — distinct from calendar adapter ('office365')
 * channelType: 'email'
 * realtimePush: false            — hub schedules polling via fetchHistory()
 *
 * fetchHistory() drains both inbox and sentItems delta streams in parallel
 * and returns a JSON-encoded cursor with separate deltaLinks for each folder.
 *
 * sendMessage() uses 2-step send (POST /me/messages → POST /me/messages/{id}/send)
 * so we get the O365 message ID for dedup when sentItems polling finds the same mail.
 */

import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelNativeContent,
  ContactHint,
  ConvertOutboundInput,
  FetchHistoryInput,
  GetMessageStatusInput,
  HistoryPage,
  ImportHistoryInput,
  ImportHistoryPage,
  InboundMessage,
  MessageStatus,
  NormalizedInboundMessage,
  RefreshCredentialsInput,
  RefreshedCredentials,
  ResolveContactInput,
  SendMessageInput,
  SendMessageResult,
  VerifyWebhookInput,
} from '@open-mercato/core/modules/communication_channels/lib/adapter'
import { o365UserCredentialsSchema, O365_MAIL_PROVIDER_KEY } from './credentials'
import { getMsOAuthClient, tokenResponseToExpiresAt } from './oauth'
import { o365ClientCredentialsSchema } from './credentials'
import { GraphApiError } from './graph-client'

// ── Constants ─────────────────────────────────────────────────

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const DEFAULT_TIMEOUT_MS = 30_000
const MAIL_BOOTSTRAP_DAYS = 7
const MAIL_MAX_PAGES = 100
const IMPORT_HISTORY_DEFAULT_DAYS = 30

// ── Graph mail types (full body, not bodyPreview) ─────────────

interface GraphMailBody {
  contentType: 'html' | 'text' | 'HTML' | 'Text'
  content: string
}

interface GraphMailAddress {
  address: string
  name?: string
}

interface GraphMailRecipient {
  emailAddress: GraphMailAddress
}

interface GraphMailMessageFull {
  id: string
  conversationId?: string | null
  subject?: string | null
  body?: GraphMailBody | null
  from?: GraphMailRecipient | null
  toRecipients?: GraphMailRecipient[] | null
  ccRecipients?: GraphMailRecipient[] | null
  bccRecipients?: GraphMailRecipient[] | null
  replyTo?: GraphMailRecipient[] | null
  receivedDateTime?: string | null
  sentDateTime?: string | null
  isDraft?: boolean | null
  hasAttachments?: boolean | null
  internetMessageId?: string | null
  '@removed'?: { reason: string } | null
}

const MAIL_SELECT_FULL = [
  'id',
  'conversationId',
  'subject',
  'body',
  'from',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'receivedDateTime',
  'sentDateTime',
  'isDraft',
  'hasAttachments',
  'internetMessageId',
].join(',')

// ── Cursor state (JSON-encoded in HistoryPage.nextCursor) ──────

interface MailCursorState {
  inbox?: { deltaToken?: string }
  sentItems?: { deltaToken?: string }
}

// ── Capabilities ──────────────────────────────────────────────

const o365EmailCapabilities: ChannelCapabilities = {
  threading: true,
  richText: true,
  fileSharing: false,
  maxFileSize: 25_000_000,
  readReceipts: false,
  deliveryReceipts: false,
  typingIndicators: false,
  reactions: false,
  multiReactionPerUser: false,
  editMessage: false,
  deleteMessage: false,
  presence: false,
  richBlocks: false,
  interactiveComponents: false,
  inlineImages: true,
  conversationHistory: true,
  contactCards: false,
  locationSharing: false,
  voiceNotes: false,
  stickers: false,
  supportedBodyFormats: ['html', 'text'],
  maxBodyLength: 50_000,
  realtimePush: false,
}

// ── Low-level fetch helpers ───────────────────────────────────

async function graphMailFetch(url: string, accessToken: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'odata.maxpagesize=50',
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { error?: { message?: string } }
        detail = body?.error?.message ?? ''
      } catch { /* ignore */ }
      throw new GraphApiError(res.status, `Graph Mail ${res.status}: ${detail || res.statusText}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function graphMailPost(
  path: string,
  accessToken: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(`${GRAPH_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: payload !== null ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    })
    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { error?: { message?: string } }
        detail = body?.error?.message ?? ''
      } catch { /* ignore */ }
      throw new GraphApiError(res.status, `Graph Mail POST ${path} ${res.status}: ${detail || res.statusText}`)
    }
    if (res.status === 202 || res.status === 204) return {}
    return await res.json() as Record<string, unknown>
  } finally {
    clearTimeout(timer)
  }
}

// ── Delta drain ───────────────────────────────────────────────

async function drainMailDeltaFull(
  accessToken: string,
  folder: 'inbox' | 'sentItems',
  deltaToken?: string,
  sinceCutoff?: Date,
): Promise<{ messages: GraphMailMessageFull[]; nextDeltaToken?: string }> {
  const messages: GraphMailMessageFull[] = []
  let nextDeltaToken: string | undefined
  let currentToken = deltaToken
  let maxPages = MAIL_MAX_PAGES

  while (maxPages-- > 0) {
    let url: string
    if (currentToken) {
      url = currentToken
    } else {
      const folderPath = folder === 'inbox' ? 'inbox' : 'sentItems'
      if (folder === 'inbox') {
        const since = sinceCutoff ?? new Date(Date.now() - MAIL_BOOTSTRAP_DAYS * 24 * 60 * 60 * 1000)
        const sinceIso = since.toISOString().replace(/\.\d{3}Z$/, 'Z')
        url = `${GRAPH_BASE}/me/mailFolders/${folderPath}/messages/delta?$filter=receivedDateTime ge ${sinceIso}&$select=${MAIL_SELECT_FULL}`
      } else {
        // sentItems: receivedDateTime filter not supported — no date filter
        url = `${GRAPH_BASE}/me/mailFolders/${folderPath}/messages/delta?$select=${MAIL_SELECT_FULL}`
      }
    }

    const raw = (await graphMailFetch(url, accessToken)) as {
      value?: GraphMailMessageFull[]
      '@odata.nextLink'?: string
      '@odata.deltaLink'?: string
    }

    messages.push(...(raw.value ?? []))

    if (raw['@odata.deltaLink']) {
      nextDeltaToken = raw['@odata.deltaLink']
      break
    }
    if (raw['@odata.nextLink']) {
      currentToken = raw['@odata.nextLink']
    } else {
      break
    }
  }

  return { messages, nextDeltaToken }
}

// ── Normalization ─────────────────────────────────────────────

function normalizeGraphMessage(
  msg: GraphMailMessageFull,
  direction: 'inbound' | 'outbound',
): NormalizedInboundMessage {
  const fromAddress = msg.from?.emailAddress?.address ?? ''
  const fromName = msg.from?.emailAddress?.name
  const toAddrs = (msg.toRecipients ?? []).map(r => r.emailAddress.address)
  const ccAddrs = (msg.ccRecipients ?? []).map(r => r.emailAddress.address)
  const bccAddrs = (msg.bccRecipients ?? []).map(r => r.emailAddress.address)

  const rawContentType = msg.body?.contentType?.toLowerCase() ?? 'text'
  const bodyFormat: 'html' | 'text' = rawContentType === 'html' ? 'html' : 'text'
  const bodyContent = msg.body?.content ?? ''

  const timestamp = msg.receivedDateTime
    ? new Date(msg.receivedDateTime)
    : msg.sentDateTime
      ? new Date(msg.sentDateTime)
      : new Date()

  return {
    externalMessageId: msg.id,
    externalConversationId: msg.conversationId ?? msg.id,
    senderIdentifier: fromAddress,
    senderDisplayName: fromName,
    subject: msg.subject ?? '(no subject)',
    body: bodyContent,
    bodyFormat,
    timestamp,
    channelPayload: {
      from: fromAddress,
      fromName: fromName ?? null,
      to: toAddrs,
      cc: ccAddrs,
      bcc: bccAddrs,
      subject: msg.subject ?? null,
      hasAttachments: msg.hasAttachments ?? false,
      direction,
    },
    channelContentType: `email/${bodyFormat}`,
    channelMetadata: {
      // RFC 5322 Message-ID used by hub thread matcher for JWZ dedup
      messageId: msg.internetMessageId ?? msg.id,
      direction,
      folder: direction === 'inbound' ? 'inbox' : 'sentItems',
    },
  }
}

function parseCursorState(channelState: Record<string, unknown>): MailCursorState {
  return {
    inbox: (channelState.inbox as MailCursorState['inbox']) ?? undefined,
    sentItems: (channelState.sentItems as MailCursorState['sentItems']) ?? undefined,
  }
}

// ── Graph mail payload builder ─────────────────────────────────

interface GraphSendPayload {
  subject: string
  body: { contentType: 'HTML' | 'Text'; content: string }
  toRecipients: GraphMailRecipient[]
  ccRecipients?: GraphMailRecipient[]
}

function buildMailPayload(input: SendMessageInput): GraphSendPayload {
  const meta = (input.metadata ?? {}) as Record<string, unknown>
  const toRaw = (meta.to ?? []) as string[]
  const ccRaw = (meta.cc ?? []) as string[]
  const subject = (meta.subject as string) ?? '(no subject)'

  const toRecipients = toRaw.map(addr => ({ emailAddress: { address: addr } }))
  const ccRecipients = ccRaw.map(addr => ({ emailAddress: { address: addr } }))

  const hasHtml = typeof input.content.html === 'string'
  const bodyContent = hasHtml ? (input.content.html ?? '') : (input.content.text ?? '')
  const contentType = hasHtml ? 'HTML' : 'Text'

  return {
    subject,
    body: { contentType, content: bodyContent },
    toRecipients,
    ...(ccRecipients.length > 0 ? { ccRecipients } : {}),
  }
}

// ── Adapter class ─────────────────────────────────────────────

class O365EmailChannelAdapter implements ChannelAdapter {
  readonly providerKey = O365_MAIL_PROVIDER_KEY
  readonly channelType = 'email'
  readonly capabilities = o365EmailCapabilities

  // ── Polling ─────────────────────────────────────────────────

  async fetchHistory(input: FetchHistoryInput): Promise<HistoryPage> {
    const creds = o365UserCredentialsSchema.parse(input.credentials)

    // Hub replays HistoryPage.nextCursor as channelState (parsed from JSON).
    // channelState holds separate deltaLinks for inbox and sentItems.
    const cs = parseCursorState(input.channelState ?? {})
    const inboxDelta = cs.inbox?.deltaToken
    const sentItemsDelta = cs.sentItems?.deltaToken

    // Drain both folders in parallel — independent delta streams
    const [inboxResult, sentResult] = await Promise.all([
      drainMailDeltaFull(creds.accessToken, 'inbox', inboxDelta),
      drainMailDeltaFull(creds.accessToken, 'sentItems', sentItemsDelta),
    ])

    const inboxMessages = inboxResult.messages
      .filter(m => !m['@removed'] && !m.isDraft)
      .map(m => normalizeGraphMessage(m, 'inbound'))

    const sentMessages = sentResult.messages
      .filter(m => !m['@removed'] && !m.isDraft)
      .map(m => normalizeGraphMessage(m, 'outbound'))

    const newState: MailCursorState = {
      inbox: { deltaToken: inboxResult.nextDeltaToken ?? inboxDelta },
      sentItems: { deltaToken: sentResult.nextDeltaToken ?? sentItemsDelta },
    }

    return {
      messages: [...inboxMessages, ...sentMessages],
      nextCursor: JSON.stringify(newState),
      hasMore: false,
    }
  }

  async importHistory(input: ImportHistoryInput): Promise<ImportHistoryPage> {
    const creds = o365UserCredentialsSchema.parse(input.credentials)
    const sinceDays = Math.min(input.sinceDays, 365)
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)

    // Parse resumption cursor from a previous importHistory page
    let inboxCursor: string | undefined
    let sentCursor: string | undefined
    if (input.cursor) {
      try {
        const parsed = JSON.parse(input.cursor) as { inbox?: string; sentItems?: string }
        inboxCursor = parsed.inbox
        sentCursor = parsed.sentItems
      } catch { /* ignore — first page */ }
    }

    const [inboxResult, sentResult] = await Promise.all([
      drainMailDeltaFull(creds.accessToken, 'inbox', inboxCursor, since),
      drainMailDeltaFull(creds.accessToken, 'sentItems', sentCursor),
    ])

    const messages = [
      ...inboxResult.messages.filter(m => !m['@removed'] && !m.isDraft).map(m => normalizeGraphMessage(m, 'inbound')),
      ...sentResult.messages.filter(m => !m['@removed'] && !m.isDraft).map(m => normalizeGraphMessage(m, 'outbound')),
    ]

    const hasMore = !!(inboxResult.nextDeltaToken || sentResult.nextDeltaToken)
    const nextCursor = hasMore
      ? JSON.stringify({
          inbox: inboxResult.nextDeltaToken,
          sentItems: sentResult.nextDeltaToken,
        })
      : undefined

    return { messages, nextCursor, hasMore }
  }

  // ── Send ────────────────────────────────────────────────────

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const creds = o365UserCredentialsSchema.parse(input.credentials)
    const payload = buildMailPayload(input)

    // 2-step send: create draft → send. Gives us the O365 message ID for
    // dedup when sentItems polling finds the same message (Sent Items paritet).
    const draft = await graphMailPost('/me/messages', creds.accessToken, payload)
    const draftId = draft.id as string | undefined
    if (!draftId) {
      throw new Error('[graph-mail-adapter] POST /me/messages did not return message id')
    }
    await graphMailPost(`/me/messages/${draftId}/send`, creds.accessToken, null)

    return {
      externalMessageId: draftId,
      status: 'sent',
    }
  }

  async convertOutbound(input: ConvertOutboundInput): Promise<ChannelNativeContent> {
    const hasHtml = input.bodyFormat === 'html'
    return {
      content: {
        html: hasHtml ? input.body : undefined,
        text: !hasHtml ? input.body : undefined,
        bodyFormat: input.bodyFormat,
      },
      metadata: input.channelMetadata,
    }
  }

  // ── Webhook (polling — no-op) ─────────────────────────────────

  async verifyWebhook(_input: VerifyWebhookInput): Promise<InboundMessage> {
    // Email adapter uses hub polling (fetchHistory); not webhook-driven.
    return { raw: {}, eventType: 'other', metadata: { reason: 'office365-email-uses-polling' } }
  }

  async normalizeInbound(_raw: InboundMessage): Promise<NormalizedInboundMessage> {
    // Hub polling path uses fetchHistory() which returns NormalizedInboundMessage[] directly.
    // normalizeInbound() is only called from the push/webhook path — not used for this adapter.
    throw new Error('[graph-mail-adapter] normalizeInbound() is not used — adapter uses polling via fetchHistory()')
  }

  // ── Status / contact ──────────────────────────────────────────

  async getStatus(_input: GetMessageStatusInput): Promise<MessageStatus> {
    return { status: 'sent' }
  }

  async resolveContact(input: ResolveContactInput): Promise<ContactHint | null> {
    const meta = (input.channelMetadata ?? {}) as Record<string, unknown>
    return {
      email: input.senderIdentifier,
      displayName: input.senderDisplayName ?? (meta.fromName as string | undefined),
    }
  }

  // ── Credential refresh ─────────────────────────────────────────

  async refreshCredentials(input: RefreshCredentialsInput): Promise<RefreshedCredentials> {
    const current = o365UserCredentialsSchema.parse(input.credentials)
    if (!current.refreshToken) {
      throw new Error('requires_reauth')
    }
    const oauthClient = input.oauthClient
    if (!oauthClient?.clientId || !oauthClient?.clientSecret) {
      throw new Error('[internal] O365 OAuth client credentials (clientId/clientSecret) required for refresh')
    }
    const clientParsed = o365ClientCredentialsSchema.safeParse(oauthClient)
    const token = await getMsOAuthClient().refreshToken({
      clientId: oauthClient.clientId,
      clientSecret: oauthClient.clientSecret,
      refreshToken: current.refreshToken,
      tenantId: clientParsed.success ? clientParsed.data.tenantId : undefined,
    })
    const expiresAt = tokenResponseToExpiresAt(token)
    return {
      credentials: {
        ...current,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? current.refreshToken,
        expiresAt: expiresAt?.toISOString(),
      },
      expiresAt: expiresAt ?? undefined,
    }
  }
}

// ── Factory ───────────────────────────────────────────────────

let cachedEmailAdapter: O365EmailChannelAdapter | null = null

export function getO365EmailAdapter(): O365EmailChannelAdapter {
  if (!cachedEmailAdapter) cachedEmailAdapter = new O365EmailChannelAdapter()
  return cachedEmailAdapter
}

export { GraphApiError, O365_MAIL_PROVIDER_KEY, IMPORT_HISTORY_DEFAULT_DAYS }
