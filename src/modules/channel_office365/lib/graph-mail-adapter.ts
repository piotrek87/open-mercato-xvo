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
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { o365UserCredentialsSchema, O365_MAIL_PROVIDER_KEY } from './credentials'
import { GraphApiError } from './graph-client'
import { attachFilesToGraphDraft } from './graph-mail-attachments'
// Provider-agnostic attachment contract (type-only + a pure parser). The resolver IMPLEMENTATION
// is resolved at runtime via DI ('mailAttachmentResolver'), so there is no runtime cross-module
// coupling — only the shared contract.
import {
  parseMailAttachmentRefs,
  type MailAttachmentResolver,
  type ResolvedMailAttachment,
} from '../../mail_attachments/lib/types'

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
  /**
   * Carried through unchanged so attachment-sync settings survive polling. The hub persists
   * fetchHistory()'s nextCursor as the channel's entire channelState via preservePushState(),
   * whose preservation whitelist only covers Gmail push keys — anything else in the previous
   * channelState (notably `settings`, written by the email-settings PATCH route and read by the
   * email-attachment-fetcher subscriber) is dropped on every poll unless the adapter echoes it
   * back here. The adapter never interprets it; it just round-trips it.
   */
  settings?: Record<string, unknown>
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

/**
 * Fetch a SINGLE page of mailbox messages. `url` is either the first-page query (built from
 * sinceCutoff) or an `@odata.nextLink` from a previous page. Returns that page's messages plus
 * the next link. Used by importHistory so the import worker advances one page at a time —
 * reporting progress and emitting a heartbeat between pages (a single full-mailbox drain in one
 * call blew past the worker's 60s no-heartbeat watchdog and was marked "stale").
 */
async function fetchMailboxPage(
  accessToken: string,
  url: string,
  excludedFolderIds: Set<string>,
): Promise<{ messages: GraphMailMessageFull[]; nextLink?: string }> {
  const raw = (await graphMailFetch(url, accessToken)) as {
    value?: GraphMailMessageFull[]
    '@odata.nextLink'?: string
  }
  const messages = (raw.value ?? []).filter(
    (m) => !(m.parentFolderId && excludedFolderIds.has(m.parentFolderId)),
  )
  return { messages, nextLink: raw['@odata.nextLink'] }
}

function buildMailboxQueryUrl(sinceCutoff: Date, pageSize?: number): string {
  const sinceIso = sinceCutoff.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const top = pageSize && pageSize > 0 ? `&$top=${pageSize}` : ''
  return `${GRAPH_BASE}/me/messages?$filter=receivedDateTime ge ${sinceIso}&$select=${MAIL_SELECT_FULL}${top}`
}

/**
 * Total mailbox messages matching the since-window — used to give the import progress bar a real
 * denominator instead of the maxMessages cap (the user rarely has 1000; showing "14/1000" reads as
 * stuck when it is really e.g. 14/40). Counts across ALL folders (including excluded system ones),
 * so it can slightly over-count — still far closer to reality than the cap. Best-effort; returns
 * undefined on any error so the worker falls back to the cap.
 */
async function fetchMailboxCountSince(accessToken: string, sinceCutoff: Date): Promise<number | undefined> {
  const sinceIso = sinceCutoff.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(
      `${GRAPH_BASE}/me/messages?$filter=receivedDateTime ge ${sinceIso}&$count=true&$top=1&$select=id`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          // $count on the messages collection requires the eventual-consistency header.
          ConsistencyLevel: 'eventual',
        },
        signal: controller.signal,
      },
    )
    if (!res.ok) return undefined
    const body = (await res.json()) as { '@odata.count'?: number }
    return typeof body['@odata.count'] === 'number' ? body['@odata.count'] : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

// Import pages are intentionally tiny. The hub import worker only updates progress (and its
// heartbeat) AFTER ingesting a whole page, and ingesting one message — Message + thread match +
// CRM fan-out — is surprisingly slow here (observed ~10-15s/message). A larger page exceeds the
// worker's 60s no-heartbeat watchdog and gets marked "stale". 2/page heartbeats every ~20-30s,
// well under the watchdog, and shows real incremental progress.
const IMPORT_PAGE_SIZE = 2

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

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
}

// The customers interaction editor renders the body as markdown/MDX, which throws on angle-bracket
// tokens ("<user@domain.com>" reads as a malformed JSX tag) and on stray curly braces (read as JS
// expressions). Strip the brackets around bare emails, then drop any residual <>/{} so the body
// never breaks the parser. Markdown itself needs none of these characters.
function stripMdxUnsafe(s: string): string {
  return s.replace(/<([^<>\s]+@[^<>\s]+)>/g, '$1').replace(/[<>{}]/g, '')
}

// Trim each line, then collapse 3+ consecutive newlines down to a single blank line.
function collapseBlankLines(s: string): string {
  return s
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function htmlToPlainText(html: string): string {
  const stripped = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<\/(tr|table)>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|section|article|header|footer)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
  return stripMdxUnsafe(decodeHtmlEntities(stripped))
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    // Markdown collapses single newlines into spaces, so re-join every content line as its own
    // paragraph (blank line between) — that is what makes the line breaks ("entery") render.
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

/**
 * Convert email HTML to lightweight Markdown so the customers interaction editor (which renders
 * the body as markdown) shows it like a real email: paragraph breaks, **bold**, _italic_, bullet
 * lists and [text](url) links — instead of a flat, run-on plain-text blob.
 */
function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  // Links → [text](url) (before tags are stripped).
  s = s.replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
    const text = String(inner).replace(/<[^>]+>/g, '').trim()
    return text ? `[${text}](${href})` : String(href)
  })
  // Bold / italic.
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => {
    const t = String(inner).replace(/<[^>]+>/g, '').trim()
    return t ? `**${t}**` : ''
  })
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => {
    const t = String(inner).replace(/<[^>]+>/g, '').trim()
    return t ? `_${t}_` : ''
  })
  // Headings → bold paragraph.
  s = s.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_m, inner) => {
    const t = String(inner).replace(/<[^>]+>/g, '').trim()
    return t ? `\n\n**${t}**\n\n` : '\n\n'
  })
  // Lists.
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '')
  // Breaks + block elements → paragraph break (a single newline would collapse in markdown).
  s = s
    .replace(/<br\s*\/?>/gi, '\n\n')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<\/(tr|table|p|div|ul|ol|blockquote|section|article|header|footer)>/gi, '\n\n')
  // Strip remaining tags, decode entities, make MDX-safe, normalise.
  s = s.replace(/<[^>]+>/g, '')
  s = stripMdxUnsafe(decodeHtmlEntities(s)).replace(/[ \t]+/g, ' ')
  return collapseBlankLines(s)
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
      // Always include html, text and markdown:
      //  - html     → ChannelPayloadRendererWidget / E-maile tab (full fidelity)
      //  - text     → plain-text fallback
      //  - markdown → CRM interaction body (the customers editor renders markdown, so this gives
      //               paragraph breaks + **bold** + lists + links instead of a run-on blob)
      // For plain-text emails, wrap in <pre> with HTML-escaped content so the html renderer never
      // passes raw text through the MDX parser (which chokes on <user@domain.com> angle brackets).
      ...(bodyFormat === 'html'
        ? { html: bodyContent, text: htmlToPlainText(bodyContent), markdown: htmlToMarkdown(bodyContent) }
        : { html: plainTextToHtml(bodyContent), text: bodyContent, markdown: stripMdxUnsafe(bodyContent) }),
    },
    channelContentType: `email/${bodyFormat}`,
    channelMetadata: {
      // RFC 5322 Message-ID used by hub thread matcher for JWZ dedup
      messageId: msg.internetMessageId ?? msg.id,
      // Graph immutable id (opaque, e.g. "AAMk…"). Needed to call /me/messages/{id}/attachments;
      // messageId above is the RFC Message-ID which Graph rejects as malformed for that endpoint.
      graphId: msg.id,
      direction,
      folder: direction === 'inbound' ? 'inbox' : 'sentItems',
    },
  }
}

function parseCursorState(channelState: Record<string, unknown>): MailCursorState {
  // Back-compat: channels persisted before the mailbox-wide rewrite carried { inbox, sentItems }
  // delta tokens. Those keys are ignored now — with no lastReceivedDateTime the next scan simply
  // re-bootstraps from syncFromDate, which is harmless (re-ingested rows dedupe on externalMessageId).
  const settings =
    channelState.settings && typeof channelState.settings === 'object' && !Array.isArray(channelState.settings)
      ? (channelState.settings as Record<string, unknown>)
      : undefined
  return {
    lastReceivedDateTime:
      typeof channelState.lastReceivedDateTime === 'string' ? channelState.lastReceivedDateTime : undefined,
    syncFromDate: typeof channelState.syncFromDate === 'string' ? channelState.syncFromDate : undefined,
    ...(settings ? { settings } : {}),
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
      // Echo settings back so the hub's push-state whitelist doesn't drop them (see MailCursorState).
      ...(cs.settings ? { settings: cs.settings } : {}),
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

    // Paginate ONE Graph page per call. The import worker loops on hasMore/nextCursor, updating
    // progress and emitting a heartbeat between calls — a single full-mailbox drain here exceeded
    // the worker's 60s no-heartbeat watchdog ("Job stale") and never reported progress.
    // The cursor carries the next @odata.nextLink plus the resolved owner email + excluded folder
    // ids so we don't re-resolve them on every page. It is opaque JSON round-tripped by the worker
    // (NOT the base64 channelState cursor used by fetchHistory).
    type ImportCursor = { nextLink?: string; ownerEmail?: string | null; excludedFolderIds?: string[] }
    let cursor: ImportCursor | null = null
    if (input.cursor) {
      try { cursor = JSON.parse(input.cursor) as ImportCursor } catch { cursor = null }
    }

    let ownerEmail: string | null
    let excludedFolderIds: Set<string>
    let pageUrl: string
    let totalCandidates: number | undefined
    if (cursor?.nextLink) {
      ownerEmail = cursor.ownerEmail ?? null
      excludedFolderIds = new Set(cursor.excludedFolderIds ?? [])
      pageUrl = cursor.nextLink
    } else {
      const sinceDays = Math.min(input.sinceDays, 365)
      const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
      const [resolvedOwner, resolvedExcluded, count] = await Promise.all([
        fetchMailboxOwnerEmail(creds.accessToken),
        fetchExcludedFolderIds(creds.accessToken),
        fetchMailboxCountSince(creds.accessToken, since),
      ])
      ownerEmail = resolvedOwner
      excludedFolderIds = resolvedExcluded
      totalCandidates = count
      pageUrl = buildMailboxQueryUrl(since, IMPORT_PAGE_SIZE)
    }

    const { messages: raw, nextLink } = await fetchMailboxPage(creds.accessToken, pageUrl, excludedFolderIds)

    const messages = raw
      .filter(m => !m['@removed'] && !m.isDraft)
      .map(m => {
        const from = m.from?.emailAddress?.address?.toLowerCase() ?? ''
        const direction: 'inbound' | 'outbound' = ownerEmail && from === ownerEmail ? 'outbound' : 'inbound'
        return normalizeGraphMessage(m, direction)
      })

    const hasMore = !!nextLink
    const nextCursor = hasMore
      ? JSON.stringify({ nextLink, ownerEmail, excludedFolderIds: [...excludedFolderIds] } satisfies ImportCursor)
      : undefined

    // totalCandidates (first page only) gives the worker a realistic progress denominator instead
    // of the maxMessages cap. The hub worker reads it on the first page (typeof === 'number').
    return { messages, nextCursor, hasMore, ...(totalCandidates !== undefined ? { totalCandidates } : {}) }
  }

  // ── Send ────────────────────────────────────────────────────

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const creds = o365UserCredentialsSchema.parse(input.credentials)
    const payload = buildMailPayload(input)

    // Resolve attachment REFERENCES carried in channelMetadata (provider-agnostic; refs only —
    // no filename/MIME/size duplicated). Zero-overhead when there are none: the historical
    // no-attachment send path below is unchanged. The adapter never touches CRM models — it hands
    // refs to the DI-resolved `mailAttachmentResolver` and receives plain files back.
    const refs = parseMailAttachmentRefs((input.metadata as Record<string, unknown> | undefined)?.attachments)
    let files: ResolvedMailAttachment[] = []
    if (refs.length > 0) {
      const container = await createRequestContainer()
      const resolver = container.resolve('mailAttachmentResolver') as MailAttachmentResolver
      files = await resolver.resolve(refs, {
        tenantId: input.scope.tenantId,
        organizationId: input.scope.organizationId ?? null,
        actorUserId: null,
      })
    }

    // 2-step send: create draft → (attach files) → send. The draft response already carries the
    // RFC internetMessageId, which is STABLE across folders.
    const draft = await graphMailPost('/me/messages', creds.accessToken, payload)
    const draftId = draft.id as string | undefined
    if (!draftId) {
      throw new Error('[graph-mail-adapter] POST /me/messages did not return message id')
    }

    if (files.length > 0) {
      await attachFilesToGraphDraft(creds.accessToken, draftId, files)
    }

    await graphMailPost(`/me/messages/${draftId}/send`, creds.accessToken, null)

    // Return the RFC internetMessageId (not the mutable Graph item id) as externalMessageId.
    // The hub persists it as the outbound link's channelMetadata.messageId, and the hub's
    // sent-folder dedup compares exactly that against newly-polled messages. The copy that
    // sentItems polling later ingests carries the SAME internetMessageId, so it dedupes instead
    // of creating a second message/conversation. Returning the Graph item id (which changes when
    // the message moves Drafts → Sent Items) made the sent email show up twice.
    const internetMessageId = typeof draft.internetMessageId === 'string' ? draft.internetMessageId : null

    return {
      externalMessageId: internetMessageId ?? draftId,
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
