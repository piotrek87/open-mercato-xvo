/**
 * Minimal Microsoft Graph API client for Mail messages.
 * Uses raw fetch — no SDK dependency.
 * Reference: https://learn.microsoft.com/en-us/graph/api/message-delta
 *
 * Decisions (Sprint 5 Phase 2):
 *   - P2-1: bodyPreview only (no full body fetch)
 *   - P2-2: no attachments
 *   - P2-3: 7-day bootstrap window via receivedDateTime ge (inbox only; sentItems uses no filter)
 *   - P2-4: Inbox + SentItems — two separate delta streams, two cursors
 */

import { GraphApiError } from './graph-client'

export { GraphApiError }

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const DEFAULT_TIMEOUT_MS = 30_000
const MAIL_BOOTSTRAP_DAYS = 7
const MAIL_MAX_PAGES = 100

export type MailFolder = 'inbox' | 'sentItems'

export interface GraphMailAddress {
  address: string
  name?: string
}

export interface GraphMailMessage {
  id: string
  subject?: string | null
  bodyPreview?: string | null
  from?: { emailAddress: GraphMailAddress } | null
  toRecipients?: Array<{ emailAddress: GraphMailAddress }> | null
  ccRecipients?: Array<{ emailAddress: GraphMailAddress }> | null
  /** BCC recipients — populated by Graph only for sent items (hidden from inbox by design) */
  bccRecipients?: Array<{ emailAddress: GraphMailAddress }> | null
  /** Reply-To override addresses — present when sender configured a custom reply-to */
  replyTo?: Array<{ emailAddress: GraphMailAddress }> | null
  receivedDateTime?: string | null
  sentDateTime?: string | null
  isDraft?: boolean | null
  hasAttachments?: boolean | null
  '@removed'?: { reason: string } | null
}

const MAIL_SELECT = [
  'id',
  'subject',
  'bodyPreview',
  'from',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'receivedDateTime',
  'sentDateTime',
  'isDraft',
  'hasAttachments',
].join(',')

async function graphMailFetch(url: string, accessToken: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
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
      } catch {
        /* ignore */
      }
      throw new GraphApiError(
        res.status,
        `Graph Mail API ${res.status}: ${detail || res.statusText}`,
      )
    }
    return await res.json()
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Drain all pages from the Graph Mail Delta API for a single folder.
 *
 * On first call (no deltaToken): bootstraps from now-7d using receivedDateTime ge (inbox only).
 * SentItems does not support receivedDateTime filter — bootstraps without filter (all sent mail).
 * On subsequent calls: resumes from the cursor (deltaLink URL).
 *
 * Returns all messages and the final deltaLink (cursor for next poll).
 * Messages with '@removed' key indicate server-side deletes — caller decides whether to act.
 */
export async function drainMailDelta(
  accessToken: string,
  folder: MailFolder,
  deltaToken?: string,
  syncFromDate?: Date,
): Promise<{ messages: GraphMailMessage[]; nextDeltaToken?: string }> {
  const messages: GraphMailMessage[] = []
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
        // Use user-configured syncFromDate or fallback to now-MAIL_BOOTSTRAP_DAYS
        const since = syncFromDate ?? new Date(Date.now() - MAIL_BOOTSTRAP_DAYS * 24 * 60 * 60 * 1000)
        const sinceIso = since.toISOString().replace(/\.\d{3}Z$/, 'Z')
        url = `${GRAPH_BASE}/me/mailFolders/${folderPath}/messages/delta?$filter=receivedDateTime ge ${sinceIso}&$select=${MAIL_SELECT}`
      } else {
        // sentItems: receivedDateTime filter not supported — no bootstrap filter
        url = `${GRAPH_BASE}/me/mailFolders/${folderPath}/messages/delta?$select=${MAIL_SELECT}`
      }
    }

    const raw = (await graphMailFetch(url, accessToken)) as {
      value?: GraphMailMessage[]
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
