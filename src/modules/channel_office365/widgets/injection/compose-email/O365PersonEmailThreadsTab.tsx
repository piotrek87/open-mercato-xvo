'use client'

import * as React from 'react'
import Link from 'next/link'
import { Mail } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  EmailThreadsPanel,
  type EmailThread,
} from '@open-mercato/ui/backend/messages'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useAppEvent } from '@open-mercato/ui/backend/injection/useAppEvent'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { O365_MAIL_PROVIDER_KEY } from '../../../lib/credentials'
import { O365ComposeDialog, type O365ComposeChannel, type O365ComposeReply } from './O365ComposeDialog'

/**
 * O365 fork of the core `PersonEmailThreadsTab`.
 *
 * WHY THIS EXISTS (read before touching): the core emails tab renders core's `ComposeEmailDialog`,
 * which has no attachment support, and the core compose route (`/customers/people/[id]/emails`) does
 * not carry attachment refs. Neither the tab, the panel, nor the dialog expose a registered component
 * handle or injection spot, so there is no non-invasive way to swap in our attachment-capable dialog
 * (the framework authors flagged this exact gap as a future "v2 upgrade path" in
 * `communication_channels/widgets/components.ts`). We therefore inject our own emails tab and hide the
 * built-in one (see `hide-core-emails-tab`).
 *
 * This is a deliberate, lighter re-implementation of the core orchestration against the SAME stable
 * APIs (`/customers/people/[id]/email-threads`, `/communication_channels/me/channels`,
 * `/communication_channels/channels/[id]/poll-now`). It drops the optimistic-send placeholder dance
 * and relies on a short post-send burst poll + the DOM event bridge for freshness. On framework
 * upgrades, diff the core `PersonEmailThreadsTab` and port any behavioural changes here.
 *
 * Compose is O365-only: "Send as" lists connected Microsoft 365 mail channels, because attachment
 * refs only flow through our O365 Graph adapter. This app is O365-first; if another provider is added
 * later, the resolver is already provider-agnostic — extend the dialog/route then.
 */

const BACKGROUND_POLL_MS = 20000
const BURST_INTERVAL_MS = 3000
const BURST_DURATION_MS = 36000
const MAX_REFERENCES = 40

/** Picks the external address to reply to: latest inbound sender, else a known participant. */
function resolveReplyRecipient(thread: EmailThread, fallback: string | null): string | null {
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) {
    const message = thread.messages[i]
    if (message.direction === 'inbound' && message.fromEmail) return message.fromEmail
  }
  return thread.participants[0] ?? fallback
}

function buildReplyState(thread: EmailThread, fallbackRecipient: string | null): O365ComposeReply {
  const last = thread.messages[thread.messages.length - 1]
  if (!last) return null
  const recipient = resolveReplyRecipient(thread, fallbackRecipient)
  const references = Array.from(
    new Set([...(last.references ?? []), ...(last.rfcMessageId ? [last.rfcMessageId] : [])]),
  ).slice(-MAX_REFERENCES)
  const baseSubject = thread.subject ?? ''
  const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`.trim()
  return {
    inReplyTo: last.rfcMessageId ?? undefined,
    references: references.length > 0 ? references : undefined,
    to: recipient ? [recipient] : [],
    subject,
    parentMessageId: last.messageId ?? undefined,
  }
}

export type O365PersonEmailThreadsTabProps = {
  personId: string
  defaultRecipient?: string | null
}

export function O365PersonEmailThreadsTab({ personId, defaultRecipient }: O365PersonEmailThreadsTabProps) {
  const t = useT()
  const [threads, setThreads] = React.useState<EmailThread[]>([])
  const [channels, setChannels] = React.useState<O365ComposeChannel[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [replyTo, setReplyTo] = React.useState<O365ComposeReply>(null)
  const burstTimer = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const channelsRef = React.useRef<O365ComposeChannel[]>([])
  channelsRef.current = channels

  const loadThreads = React.useCallback(
    async (opts?: { showLoading?: boolean }) => {
      if (opts?.showLoading) setLoading(true)
      try {
        const response = await apiCall<{ threads?: EmailThread[] }>(
          `/api/customers/people/${encodeURIComponent(personId)}/email-threads`,
          { method: 'GET', headers: { 'x-om-forbidden-redirect': '0', 'x-om-unauthorized-redirect': '0' } },
        )
        if (!response.ok) {
          const err = response.result as { error?: string } | null
          throw new Error(err?.error ?? t('customers.email.threads.loadFailed', 'Failed to load emails'))
        }
        setThreads(Array.isArray(response.result?.threads) ? response.result!.threads! : [])
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : t('customers.email.threads.loadFailed', 'Failed to load emails'))
      } finally {
        if (opts?.showLoading) setLoading(false)
      }
    },
    [personId, t],
  )

  const loadChannels = React.useCallback(async () => {
    try {
      const response = await apiCall<{ items?: unknown[] }>(
        '/api/communication_channels/me/channels',
        { method: 'GET', headers: { 'x-om-forbidden-redirect': '0', 'x-om-unauthorized-redirect': '0' } },
      )
      const items: unknown[] = Array.isArray(response.result?.items) ? response.result!.items! : []
      const mail = items.filter((item) => {
        if (!item || typeof item !== 'object') return false
        const r = item as Record<string, unknown>
        return r.providerKey === O365_MAIL_PROVIDER_KEY && r.status === 'connected'
      }) as O365ComposeChannel[]
      setChannels(mail)
    } catch {
      setChannels([])
    }
  }, [])

  // Poll every connected mailbox now (fetches new mail server-side). Inbound ingest + CRM linking
  // happen on workers, so callers should burst-poll after.
  const triggerSync = React.useCallback(async () => {
    await Promise.allSettled(
      channelsRef.current.map((channel) => {
        const channelId = channel.id
        if (!channelId) return Promise.resolve()
        return apiCall(
          `/api/communication_channels/channels/${encodeURIComponent(channelId)}/poll-now`,
          { method: 'POST', headers: { 'x-om-forbidden-redirect': '0', 'x-om-unauthorized-redirect': '0' } },
        )
      }),
    )
  }, [])

  const startBurst = React.useCallback(() => {
    if (burstTimer.current) clearInterval(burstTimer.current)
    const startedAt = Date.now()
    burstTimer.current = setInterval(() => {
      if (Date.now() - startedAt > BURST_DURATION_MS) {
        if (burstTimer.current) {
          clearInterval(burstTimer.current)
          burstTimer.current = null
        }
        return
      }
      void loadThreads()
    }, BURST_INTERVAL_MS)
  }, [loadThreads])

  // Initial load.
  React.useEffect(() => {
    void loadThreads({ showLoading: true })
    void loadChannels()
  }, [loadThreads, loadChannels])

  // Background heartbeat — surfaces inbound replies without a page reload.
  React.useEffect(() => {
    const id = setInterval(() => { void loadThreads() }, BACKGROUND_POLL_MS)
    return () => clearInterval(id)
  }, [loadThreads])

  // Clean up the burst timer on unmount.
  React.useEffect(() => () => {
    if (burstTimer.current) clearInterval(burstTimer.current)
  }, [])

  // Live reconciliation via the DOM event bridge; polling above is the fallback.
  useAppEvent('customers.email.linked', () => { void loadThreads() }, [loadThreads])
  useAppEvent('messages.message.sent', () => { void loadThreads() }, [loadThreads])
  useAppEvent('communication_channels.message.received', () => { void loadThreads() }, [loadThreads])
  useAppEvent('communication_channels.message.sent', () => { void loadThreads() }, [loadThreads])

  const onComposeNew = React.useCallback(() => {
    setReplyTo(null)
    setDialogOpen(true)
  }, [])

  const onReply = React.useCallback(
    (thread: EmailThread) => {
      setReplyTo(buildReplyState(thread, defaultRecipient ?? null))
      setDialogOpen(true)
    },
    [defaultRecipient],
  )

  const onRefresh = React.useCallback(async () => {
    setLoading(true)
    try {
      await triggerSync()
      await loadThreads()
    } finally {
      setLoading(false)
    }
    startBurst()
  }, [triggerSync, loadThreads, startBurst])

  const handleSent = React.useCallback(() => {
    void loadThreads()
    startBurst()
  }, [loadThreads, startBurst])

  const canCompose = channels.length > 0

  const composeDisabledHint = (
    <Button asChild variant="outline" size="sm" className="gap-2">
      <Link href="/backend/profile/communication-channels">
        <Mail className="h-4 w-4" />
        {t('customers.email.compose.noChannel.cta', 'Connect your mailbox')}
      </Link>
    </Button>
  )

  return (
    <>
      <EmailThreadsPanel
        threads={threads}
        loading={loading}
        error={error}
        canCompose={canCompose}
        composeDisabledHint={composeDisabledHint}
        onComposeNew={onComposeNew}
        onReply={onReply}
        onRefresh={() => { void onRefresh() }}
      />
      <O365ComposeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        personId={personId}
        defaultRecipient={defaultRecipient}
        channels={channels}
        replyTo={replyTo}
        onSent={handleSent}
      />
    </>
  )
}

export default O365PersonEmailThreadsTab
