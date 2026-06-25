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
  ResolveContactInput,
  SendMessageInput,
  SendMessageResult,
  VerifyWebhookInput,
} from '@open-mercato/core/modules/communication_channels/lib/adapter'
import { o365UserCredentialsSchema, O365_MAIL_PROVIDER_KEY } from './credentials'
import { GraphApiError } from './graph-client'

// ── Constants ─────────────────────────────────────────────────

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const DEFAULT_TIMEOUT_MS = 30_000
const MAIL_MAX_PAGES = 100
const IMPORT_HISTORY_DEFAULT_DAYS = 30

// Well-known folders to EXCLUDE from the mailbox-wide scan. We sync the whole mailbox
// (Inbox + Sent + Archive + every user-created subfolder, since incoming mail is often
// filed by rules into subfolders) but skip system folders that are not real correspondence.
const EXCLUDED_WELL_KNOWN_FOLDERS = [
  'drafts',
  'deleteditems',
  'junkemail',
  'outbox',
  'conversationhistory',
] as const

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
  parentFolderId?: string | null
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
  'parentFolderId',
].join(',')

// ── Cursor state (JSON-encoded in HistoryPage.nextCursor) ──────

interface MailCursorState {
  /** Watermark: highest receivedDateTime ingested so far (ISO). Incremental scans start here. */
  lastReceivedDateTime?: string
  /** ISO since-cutoff for the FIRST (bootstrap) scan. Set at provisioning (now − 7 days). */
  syncFromDate?: string
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

// ── Mailbox-wide scan ─────────────────────────────────────────

/**
 * Resolve the mailbox owner's email (lowercased) so we can label each message's direction
 * (sender === owner → outbound, else inbound). Folder no longer determines direction now that
 * we scan the whole mailbox (a custom subfolder may hold both received and sent mail).
 */
async function fetchMailboxOwnerEmail(accessToken: string): Promise<string | null> {
  try {
    const r = (await graphMailFetch(`${GRAPH_BASE}/me?$select=mail,userPrincipalName`, accessToken)) as {
      mail?: string | null
      userPrincipalName?: string | null
    }
    const email = r.mail ?? r.userPrincipalName ?? null
    return email ? email.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Resolve the folder IDs of the excluded well-known folders. `/me/messages` returns mail from
 * every folder (including Drafts/Deleted Items/Junk), so we filter those out by parentFolderId.
 * Folders that don't exist in a mailbox (e.g. conversationhistory) just 404 and are skipped.
 */
async function fetchExcludedFolderIds(accessToken: string): Promise<Set<string>> {
  const ids = new Set<string>()
  await Promise.all(
    EXCLUDED_WELL_KNOWN_FOLDERS.map(async (name) => {
      try {
        const r = (await graphMailFetch(`${GRAPH_BASE}/me/mailFolders/${name}?$select=id`, accessToken)) as { id?: string }
        if (r?.id) ids.add(r.id)
      } catch {
        /* folder not present in this mailbox — ignore */
      }
    }),
  )
  return ids
}

/**
 * Drain ALL mailbox messages with receivedDateTime >= sinceCutoff, across every folder, skipping
 * messages that live in an excluded system folder. Returns the messages plus the highest
 * receivedDateTime seen (the incremental watermark for the next scan).
 *
 * Uses `/me/messages` (mailbox-wide) rather than per-folder delta: delta is only available
 * per mailFolder, but incoming mail is routinely filed by rules into user subfolders, so a
 * two-folder (Inbox + Sent) delta misses most received correspondence. Exchange stamps a
 * receivedDateTime on sent items too, so this single filter bounds both directions.
 */
async function drainMailboxMessagesSince(
  accessToken: string,
  sinceCutoff: Date,
  excludedFolderIds: Set<string>,
): Promise<{ messages: GraphMailMessageFull[]; maxReceivedDateTime?: string }> {
  const messages: GraphMailMessageFull[] = []
  let maxReceivedDateTime: string | undefined
  const sinceIso = sinceCutoff.toISOString().replace(/\.\d{3}Z$/, 'Z')

  let url: string | undefined =
    `${GRAPH_BASE}/me/messages?$filter=receivedDateTime ge ${sinceIso}&$select=${MAIL_SELECT_FULL}`
  let maxPages = MAIL_MAX_PAGES

  while (url && maxPages-- > 0) {
    const raw = (await graphMailFetch(url, accessToken)) as {
      value?: GraphMailMessageFull[]
      '@odata.nextLink'?: string
    }

    for (const m of raw.value ?? []) {
      if (m.parentFolderId && excludedFolderIds.has(m.parentFolderId)) continue
      messages.push(m)
      // ISO-8601 timestamps compare lexicographically — safe to track the max as a string.
      if (m.receivedDateTime && (!maxReceivedDateTime || m.receivedDateTime > maxReceivedDateTime)) {
        maxReceivedDateTime = m.receivedDateTime
      }
    }

    url = raw['@odata.nextLink']
  }

  return { messages, maxReceivedDateTime }
}

// ── HTML → plain-text helper ──────────────────────────────────

function escapeHtmlEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function plainTextToHtml(text: string): string {
  // Wrap plain-text email content in <pre> so renderers treat it as HTML
  // rather than passing it through a markdown/MDX parser.
  // Escaping < and > prevents "<user@domain.com>" from being parsed as JSX tags.
  return `<pre style="white-space:pre-wrap;word-wrap:break-word;font-family:inherit;margin:0">${escapeHtmlEntities(text)}</pre>`
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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
  // Hub requires a non-empty body — fall back to subject for emails with no body content
  // (e.g. meeting invites, read-receipts, blank messages).
  const bodyContent = msg.body?.content?.trim()
    ? msg.body.content
    : (msg.subject ? `[${msg.subject}]` : '(no body)')

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
      receivedAt: timestamp.toISOString(),
      // Always include both html and text so ChannelPayloadRendererWidget uses html.
      // For plain-text emails, wrap in <pre> with HTML-escaped content so the renderer
      // never passes raw text through the MDX parser (which chokes on <user@domain.com>
      // angle-bracket email addresses, treating them as JSX member expressions).
      ...(bodyFormat === 'html'
        ? { html: bodyContent, text: htmlToPlainText(bodyContent) }
        : { html: plainTextToHtml(bodyContent), text: bodyContent }),
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
  // Back-compat: channels persisted before the mailbox-wide rewrite carried { inbox, sentItems }
  // delta tokens. Those keys are ignored now — with no lastReceivedDateTime the next scan simply
  // re-bootstraps from syncFromDate, which is harmless (re-ingested rows dedupe on externalMessageId).
  return {
    lastReceivedDateTime:
      typeof channelState.lastReceivedDateTime === 'string' ? channelState.lastReceivedDateTime : undefined,
    syncFromDate: typeof channelState.syncFromDate === 'string' ? channelState.syncFromDate : undefined,
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

    // Hub replays HistoryPage.nextCursor as channelState (base64-decoded JSON).
    const cs = parseCursorState(input.channelState ?? {})

    // Incremental scans resume from the highest receivedDateTime ingested so far. The first
    // (bootstrap) scan starts at syncFromDate (set at provisioning = now − 7 days); default to
    // now so we never pull history unless a window was configured.
    const sinceIso = cs.lastReceivedDateTime ?? cs.syncFromDate
    const since = sinceIso ? new Date(sinceIso) : new Date()

    const [ownerEmail, excludedFolderIds] = await Promise.all([
      fetchMailboxOwnerEmail(creds.accessToken),
      fetchExcludedFolderIds(creds.accessToken),
    ])

    const { messages: raw, maxReceivedDateTime } = await drainMailboxMessagesSince(
      creds.accessToken,
      since,
      excludedFolderIds,
    )

    const messages = raw
      .filter(m => !m['@removed'] && !m.isDraft)
      .map(m => {
        const from = m.from?.emailAddress?.address?.toLowerCase() ?? ''
        const direction: 'inbound' | 'outbound' = ownerEmail && from === ownerEmail ? 'outbound' : 'inbound'
        return normalizeGraphMessage(m, direction)
      })

    const newState: MailCursorState = {
      // Advance the watermark; keep the previous one when this scan returned nothing new.
      lastReceivedDateTime: maxReceivedDateTime ?? cs.lastReceivedDateTime ?? cs.syncFromDate,
      syncFromDate: cs.syncFromDate,
    }

    return {
      messages,
      // The hub poll-channel worker persists nextCursor into channelState via
      // decodeChannelStateCursor() = JSON.parse(Buffer.from(cursor, 'base64')). It expects
      // base64-encoded JSON (same contract as the Gmail history adapter). Returning raw JSON
      // here makes the base64 decode produce garbage → JSON.parse throws → the cursor is
      // silently dropped and every poll re-bootstraps from syncFromDate. Encode to base64.
      nextCursor: Buffer.from(JSON.stringify(newState)).toString('base64'),
      hasMore: false,
    }
  }

  async importHistory(input: ImportHistoryInput): Promise<ImportHistoryPage> {
    const creds = o365UserCredentialsSchema.parse(input.credentials)
    const sinceDays = Math.min(input.sinceDays, 365)
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)

    const [ownerEmail, excludedFolderIds] = await Promise.all([
      fetchMailboxOwnerEmail(creds.accessToken),
      fetchExcludedFolderIds(creds.accessToken),
    ])

    // Mailbox-wide drain in one shot (bounded by MAIL_MAX_PAGES). The import worker stops when
    // hasMore is false; the regular poll then keeps the channel current from the watermark.
    const { messages: raw } = await drainMailboxMessagesSince(creds.accessToken, since, excludedFolderIds)

    const messages = raw
      .filter(m => !m['@removed'] && !m.isDraft)
      .map(m => {
        const from = m.from?.emailAddress?.address?.toLowerCase() ?? ''
        const direction: 'inbound' | 'outbound' = ownerEmail && from === ownerEmail ? 'outbound' : 'inbound'
        return normalizeGraphMessage(m, direction)
      })

    return { messages, nextCursor: undefined, hasMore: false }
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

}
// refreshCredentials intentionally omitted: the email channel delegates token refresh
// to the calendar channel (office365). Credentials are always resolved via bundleId
// fallback (channel_office365_mail → channel_office365), so the calendar channel's
// refresh cycle keeps both channels current without a rotating-refresh-token race.

// ── Factory ───────────────────────────────────────────────────

let cachedEmailAdapter: O365EmailChannelAdapter | null = null

export function getO365EmailAdapter(): O365EmailChannelAdapter {
  if (!cachedEmailAdapter) cachedEmailAdapter = new O365EmailChannelAdapter()
  return cachedEmailAdapter
}

export { GraphApiError, O365_MAIL_PROVIDER_KEY, IMPORT_HISTORY_DEFAULT_DAYS }
