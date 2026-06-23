'use client'
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams, useRouter } from 'next/navigation'
import { Page, PageHeader, PageBody } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Calendar, Mail, CheckCircle, AlertCircle, RefreshCw, ExternalLink, Info, Trash2 } from 'lucide-react'
import { O365_MAIL_READ_SCOPE, O365_PROVIDER_KEY, O365_MAIL_PROVIDER_KEY } from '../../../lib/credentials'

type ChannelRow = {
  id: string
  providerKey: string
  displayName: string
  externalIdentifier?: string | null
  status: string
  lastPolledAt?: string | null
}

type CapabilityState = {
  enabled?: boolean
  deltaToken?: string
  sentItemsDeltaToken?: string
  lastSyncedAt?: string
  bootstrapped?: boolean
  syncFromDate?: string
}

type ChannelStateRow = {
  id: string
  grantedScopes: string[]
  capabilities: {
    calendar?: CapabilityState
    mail?: CapabilityState
  }
}

export default function Office365Page() {
  const t = useT()
  const queryClient = useQueryClient()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [connecting, setConnecting] = React.useState(false)
  const [syncingId, setSyncingId] = React.useState<string | null>(null)
  const [mailSyncingId, setMailSyncingId] = React.useState<string | null>(null)
  const [togglingId, setTogglingId] = React.useState<string | null>(null)
  const [togglingAttachments, setTogglingAttachments] = React.useState(false)
  const [importingHistory, setImportingHistory] = React.useState(false)
  const [calendarSyncFrom, setCalendarSyncFrom] = React.useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toISOString().slice(0, 10)
  })
  const [emailSyncFrom, setEmailSyncFrom] = React.useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toISOString().slice(0, 10)
  })
  const [resettingId, setResettingId] = React.useState<string | null>(null)

  // After OAuth callback the hub redirects here with ?flash=connected&channelId=<uuid>.
  // Provision the sibling email channel (office365_mail) and trigger immediate
  // calendar sync (instead of waiting up to 5 min for the scheduler).
  React.useEffect(() => {
    if (searchParams.get('flash') !== 'connected') return
    const channelId = searchParams.get('channelId')
    void (async () => {
      const tasks: Promise<unknown>[] = [
        apiCall('/api/channel_office365/channel_office365/provision-email-channel', {
          method: 'POST',
          body: JSON.stringify({}),
        }).then((r) => {
          if (!r.ok && r.status !== 422) {
            console.warn('[channel_office365] email channel provisioning failed', r.status)
          }
        }),
      ]
      if (channelId) {
        tasks.push(
          apiCall('/api/channel_office365/channel_office365/sync-now', {
            method: 'POST',
            body: JSON.stringify({ channelId }),
          }).then((r) => {
            if (!r.ok) {
              console.warn('[channel_office365] initial calendar sync failed', r.status)
            }
          }),
        )
      }
      await Promise.allSettled(tasks)
      // Remove ?flash and ?channelId params from URL without adding a history entry
      const url = new URL(window.location.href)
      url.searchParams.delete('flash')
      url.searchParams.delete('channelId')
      router.replace(url.pathname + (url.search || ''))
    })()
  // Run once per flash=connected landing
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['channel_office365_channels'],
    queryFn: async () => {
      const r = await apiCall<{ items: ChannelRow[]; total: number }>(
        '/api/communication_channels/me/channels',
      )
      return r.result
    },
    refetchInterval: 30_000,
  })

  const { data: stateData } = useQuery({
    queryKey: ['channel_office365_state'],
    queryFn: async () => {
      const r = await apiCall<{ items: ChannelStateRow[] }>('/api/channel_office365/channel_office365/channels')
      return r.result
    },
    refetchInterval: 30_000,
  })

  const { data: emailSettingsData, refetch: refetchEmailSettings } = useQuery({
    queryKey: ['channel_office365_email_settings'],
    queryFn: async () => {
      const r = await apiCall<{ settings: { syncAttachments: boolean; maxAttachmentSizeMb: number } | null }>(
        '/api/channel_office365/channel_office365/email-settings',
      )
      return r.result?.settings ?? null
    },
    refetchInterval: 60_000,
  })

  // Healing: if calendar channel exists, silently provision the email sibling on first load.
  // office365_mail is filtered from me/channels (interceptor), so we can't detect its
  // presence from data.items — instead we always provision once per mount (idempotent).
  const emailProvisionedRef = React.useRef(false)
  React.useEffect(() => {
    if (!data || emailProvisionedRef.current) return
    const hasCalendar = data.items.some((c) => c.providerKey === O365_PROVIDER_KEY)
    if (!hasCalendar) return
    emailProvisionedRef.current = true
    void apiCall('/api/channel_office365/channel_office365/provision-email-channel', {
      method: 'POST',
      body: JSON.stringify({}),
    }).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const channels = (data?.items ?? []).filter((c) => c.providerKey === O365_PROVIDER_KEY)
  // Email channel (hub-managed, office365_mail) — at most 1 per user
  const emailChannel = (data?.items ?? []).find((c) => c.providerKey === O365_MAIL_PROVIDER_KEY) ?? null
  const syncAttachments = emailSettingsData?.syncAttachments === true

  const stateById = React.useMemo(() => {
    const map = new Map<string, ChannelStateRow>()
    for (const row of stateData?.items ?? []) {
      map.set(row.id, row)
    }
    return map
  }, [stateData])

  function hasMailScope(channelId: string): boolean {
    const scopes = stateById.get(channelId)?.grantedScopes ?? []
    return scopes.includes(O365_MAIL_READ_SCOPE)
  }

  function getCalendarCap(channelId: string): CapabilityState | undefined {
    return stateById.get(channelId)?.capabilities?.calendar
  }

  function getMailCap(channelId: string): CapabilityState | undefined {
    return stateById.get(channelId)?.capabilities?.mail
  }

  async function handleConnect() {
    setConnecting(true)
    try {
      // Remove the sibling email channel before (re-)connecting so the framework's
      // mailbox_already_connected guard does not block the OAuth callback.
      // The email channel is re-provisioned automatically after successful OAuth.
      if (emailChannel) {
        await apiCall(`/api/communication_channels/channels/${emailChannel.id}`, { method: 'DELETE' }).catch(() => {})
      }

      const r = await apiCall<{ authorizeUrl: string }>(
        `/api/communication_channels/oauth/${O365_PROVIDER_KEY}/initiate`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      if (r.result?.authorizeUrl) {
        window.location.href = r.result.authorizeUrl
      } else {
        flash(t('channel_office365.connect.error', 'Could not start OAuth flow'), 'error')
      }
    } catch {
      flash(t('channel_office365.connect.error', 'Could not start OAuth flow'), 'error')
    } finally {
      setConnecting(false)
    }
  }

  async function handleDisconnect(channelId: string) {
    const confirmMessage = syncAttachments
      ? t(
          'channel_office365.disconnect.confirm.withAttachments',
          'Odłączasz konto Microsoft 365.\n\nPobrane wcześniej załączniki emaili pozostają dostępne w Open Mercato.\nNowe załączniki nie będą synchronizowane po odłączeniu.',
        )
      : t('channel_office365.disconnect.confirm', 'Disconnect Microsoft 365? All sync will stop.')
    if (!confirm(confirmMessage)) return
    try {
      const r = await apiCall(`/api/communication_channels/channels/${channelId}`, { method: 'DELETE' })
      if (r.ok) {
        // Cascade: deactivate sibling email channel (office365_mail) if provisioned
        if (emailChannel) {
          await apiCall(`/api/communication_channels/channels/${emailChannel.id}`, { method: 'DELETE' }).catch(() => {
            // Non-fatal — email channel may already be gone or hub handles it
          })
        }
        flash(t('channel_office365.disconnect.success', 'Microsoft 365 disconnected'), 'success')
        void refetch()
      } else {
        flash(t('channel_office365.disconnect.error', 'Failed to disconnect'), 'error')
      }
    } catch {
      flash(t('channel_office365.disconnect.error', 'Failed to disconnect'), 'error')
    }
  }

  async function handleSyncNow(channelId: string, syncFromDate?: string) {
    setSyncingId(channelId)
    try {
      const body: Record<string, unknown> = { channelId }
      if (syncFromDate) {
        body.syncFromDate = new Date(syncFromDate).toISOString()
        body.resetDelta = true
      }
      const r = await apiCall('/api/channel_office365/channel_office365/sync-now', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (r.ok) {
        flash(t('channel_office365.sync.success', 'Calendar synced — events will appear shortly'), 'success')
        setTimeout(() => void refetch(), 3000)
      } else {
        flash(t('channel_office365.sync.error', 'Failed to start sync'), 'error')
      }
    } catch {
      flash(t('channel_office365.sync.error', 'Failed to start sync'), 'error')
    } finally {
      setSyncingId(null)
    }
  }

  async function handleMailSyncNow(calendarChannelId: string) {
    setMailSyncingId(calendarChannelId)
    try {
      // Auto-provision the email channel if it is missing — avoids "reconnect" error
      // when the user arrives on the page before the healing effect completes.
      let mailChannelId = emailChannel?.id ?? null
      if (!mailChannelId) {
        const provR = await apiCall<{ channelId: string; created: boolean }>(
          '/api/channel_office365/channel_office365/provision-email-channel',
          { method: 'POST', body: JSON.stringify({}) },
        )
        if (!provR.ok || !provR.result?.channelId) {
          flash(t('channel_office365.mailSync.noChannel', 'Email channel not provisioned — reconnect Microsoft 365'), 'error')
          return
        }
        mailChannelId = provR.result.channelId
        void refetch()
      }
      const r = await apiCall(`/api/communication_channels/channels/${mailChannelId}/poll-now`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      if (r.ok) {
        flash(t('channel_office365.mailSync.success', 'Email sync queued — messages will appear shortly'), 'success')
        setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ['channel_office365_state'] })
        }, 3000)
      } else {
        flash(t('channel_office365.mailSync.error', 'Failed to start email sync'), 'error')
      }
    } catch {
      flash(t('channel_office365.mailSync.error', 'Failed to start email sync'), 'error')
    } finally {
      setMailSyncingId(null)
    }
  }

  async function handleToggleAttachments(enable: boolean) {
    setTogglingAttachments(true)
    try {
      const r = await apiCall('/api/channel_office365/channel_office365/email-settings', {
        method: 'PATCH',
        body: JSON.stringify({ syncAttachments: enable }),
      })
      if (r.ok) {
        flash(
          enable
            ? t('channel_office365.attachments.enabled', 'Synchronizacja załączników włączona')
            : t('channel_office365.attachments.disabled', 'Synchronizacja załączników wyłączona'),
          'success',
        )
        void refetchEmailSettings()
      } else if (r.status === 404) {
        flash(t('channel_office365.mailSync.noChannel', 'Email channel not provisioned — reconnect Microsoft 365'), 'error')
      } else {
        flash(t('channel_office365.attachments.error', 'Nie udało się zmienić ustawień'), 'error')
      }
    } catch {
      flash(t('channel_office365.attachments.error', 'Nie udało się zmienić ustawień'), 'error')
    } finally {
      setTogglingAttachments(false)
    }
  }

  async function handleImportHistory(sinceDays?: number) {
    setImportingHistory(true)
    try {
      // Re-provision to reset channel status to 'connected' — poll workers may have
      // set status='error' after a transient failure, which would cause import-history
      // to return 409 even when credentials are valid and poll-now succeeds.
      let mailChannelId = emailChannel?.id ?? null
      const provR = await apiCall<{ channelId: string; created: boolean }>(
        '/api/channel_office365/channel_office365/provision-email-channel',
        { method: 'POST', body: JSON.stringify({}) },
      )
      if (provR.ok && provR.result?.channelId) {
        mailChannelId = provR.result.channelId
      } else if (!mailChannelId) {
        flash(t('channel_office365.mailSync.noChannel', 'Email channel not provisioned — reconnect Microsoft 365'), 'error')
        return
      }

      const r = await apiCall(`/api/communication_channels/channels/${mailChannelId}/import-history`, {
        method: 'POST',
        body: JSON.stringify(sinceDays !== undefined ? { sinceDays } : {}),
      })
      if (r.ok) {
        flash(t('channel_office365.importHistory.success', 'Import historii emaili uruchomiony — może potrwać kilka minut'), 'success')
      } else {
        flash(t('channel_office365.importHistory.error', 'Nie udało się uruchomić importu historii'), 'error')
      }
    } catch {
      flash(t('channel_office365.importHistory.error', 'Nie udało się uruchomić importu historii'), 'error')
    } finally {
      setImportingHistory(false)
    }
  }

  async function handleResetSyncData(channelId: string) {
    if (!confirm(t(
      'channel_office365.resetData.confirm',
      'Wyczyścić wszystkie dane synchronizacji M365? Usunie aktywności, e-maile i spotkania pobrane z Office 365. Rekordy CRM (osoby, firmy, szanse) nie zostaną usunięte.',
    ))) return
    setResettingId(channelId)
    try {
      const r = await apiCall('/api/channel_office365/channel_office365/reset-data', {
        method: 'POST',
        body: JSON.stringify({ channelId }),
      })
      if (r.ok) {
        flash(t('channel_office365.resetData.success', 'Dane synchronizacji wyczyszczone — możesz teraz uruchomić sync od nowa'), 'success')
        void queryClient.invalidateQueries({ queryKey: ['channel_office365_state'] })
        setTimeout(() => void refetch(), 1000)
      } else {
        flash(t('channel_office365.resetData.error', 'Nie udało się wyczyścić danych synchronizacji'), 'error')
      }
    } catch {
      flash(t('channel_office365.resetData.error', 'Nie udało się wyczyścić danych synchronizacji'), 'error')
    } finally {
      setResettingId(null)
    }
  }

  async function handleToggleCapability(
    channelId: string,
    capability: 'calendar' | 'mail',
    enabled: boolean,
  ) {
    setTogglingId(channelId)
    try {
      const r = await apiCall('/api/channel_office365/channel_office365/capabilities', {
        method: 'PATCH',
        body: JSON.stringify({ channelId, capability, enabled }),
      })
      if (r.ok) {
        flash(t('channel_office365.capability.toggle.success', 'Capability updated'), 'success')
        void queryClient.invalidateQueries({ queryKey: ['channel_office365_state'] })
      } else {
        const msg = r.status === 422
          ? t('channel_office365.capability.mail.requiresScope', 'Aby włączyć synchronizację e-mail, kliknij „Połącz ponownie" i zatwierdź dostęp do skrzynki pocztowej w Microsoft 365.')
          : t('channel_office365.capability.toggle.error', 'Failed to update capability')
        flash(msg, 'error')
      }
    } catch {
      flash(t('channel_office365.capability.toggle.error', 'Failed to update capability'), 'error')
    } finally {
      setTogglingId(null)
    }
  }

  return (
    <Page>
      <PageHeader
        title={t('channel_office365.page.title', 'Microsoft 365')}
        actions={
          channels.length === 0 ? (
            <Button size="sm" onClick={() => void handleConnect()} disabled={connecting}>
              <Calendar className="size-4 mr-1.5" />
              {connecting
                ? t('channel_office365.connect.connecting', 'Connecting…')
                : t('channel_office365.connect.button', 'Connect Microsoft 365')}
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        <div className="max-w-2xl space-y-4">
          {isLoading && (
            <p className="text-sm text-muted-foreground">
              {t('channel_office365.loading', 'Loading connected accounts…')}
            </p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <span>{t('channel_office365.error.load', 'Failed to load connections')}</span>
            </Alert>
          )}
          {!isLoading && channels.length === 0 && (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <Calendar className="size-8 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm font-medium">
                {t('channel_office365.empty.title', 'No Microsoft 365 account connected')}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {t(
                  'channel_office365.empty.description',
                  'Connect your Microsoft 365 account to sync calendar events and emails to Activities.',
                )}
              </p>
            </div>
          )}
          {channels.map((channel) => {
            const calCap = getCalendarCap(channel.id)
            const mailCap = getMailCap(channel.id)
            const mailEnabled = mailCap?.enabled === true
            const isToggling = togglingId === channel.id

            return (
              <div key={channel.id} className="rounded-lg border p-4 space-y-3">
                {/* Connection header */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5">
                      {channel.status === 'connected' ? (
                        <CheckCircle className="size-5 text-status-success-text" />
                      ) : channel.status === 'requires_reauth' ? (
                        <AlertCircle className="size-5 text-status-warning-text" />
                      ) : (
                        <AlertCircle className="size-5 text-status-error-text" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{channel.displayName}</p>
                      {channel.externalIdentifier && (
                        <p className="text-xs text-muted-foreground">{channel.externalIdentifier}</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {channel.status === 'connected'
                          ? t('channel_office365.status.connected', 'Connected')
                          : channel.status === 'requires_reauth'
                            ? t('channel_office365.status.reauth', 'Reconnect required')
                            : t('channel_office365.status.error', 'Connection error')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {channel.status === 'requires_reauth' && (
                      <Button size="sm" variant="outline" onClick={() => void handleConnect()}>
                        <RefreshCw className="size-3.5 mr-1" />
                        {t('channel_office365.reauth.button', 'Reconnect')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => void handleDisconnect(channel.id)}
                    >
                      {t('channel_office365.disconnect.button', 'Disconnect')}
                    </Button>
                  </div>
                </div>

                {channel.status === 'connected' && (
                  <>
                    {/* Calendar sync capability row */}
                    <div className="rounded-md bg-muted/30 px-3 py-2 space-y-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div>
                          <p className="text-xs font-medium">
                            {t('channel_office365.capability.calendar.label', 'Calendar Sync')}
                          </p>
                          {calCap?.lastSyncedAt ? (
                            <p className="text-xs text-muted-foreground">
                              {t('channel_office365.lastSync', 'Last sync:')} {new Date(calCap.lastSyncedAt).toLocaleString()}
                            </p>
                          ) : channel.lastPolledAt ? (
                            <p className="text-xs text-muted-foreground">
                              {t('channel_office365.lastSync', 'Last sync:')} {new Date(channel.lastPolledAt).toLocaleString()}
                            </p>
                          ) : null}
                          {calCap?.syncFromDate && (
                            <p className="text-xs text-muted-foreground">
                              {t('channel_office365.syncFrom.label', 'Sync from:')} {new Date(calCap.syncFromDate).toLocaleDateString()}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0 flex-wrap">
                          <input
                            type="date"
                            value={calendarSyncFrom}
                            onChange={(e) => setCalendarSyncFrom(e.target.value)}
                            max={new Date().toISOString().slice(0, 10)}
                            className="text-xs border rounded px-1.5 py-1 bg-background"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleSyncNow(channel.id, calendarSyncFrom)}
                            disabled={!calendarSyncFrom || syncingId === channel.id}
                            aria-label={t('channel_office365.resetSync.button', 'Sync calendar from selected date')}
                          >
                            <RefreshCw className={`size-3.5 mr-1 ${syncingId === channel.id ? 'animate-spin' : ''}`} />
                            {syncingId === channel.id
                              ? t('channel_office365.sync.syncing', 'Syncing…')
                              : t('channel_office365.resetSync.button', 'Sync')}
                          </Button>
                        </div>
                      </div>
                    </div>

                    {/* Attachments disabled alert — shown when email sync is on but attachments off */}
                    {mailEnabled && !syncAttachments && (
                      <Alert variant="default" className="py-2">
                        <Info className="size-4 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium">
                            {t('channel_office365.attachments.disabled.title', 'Synchronizacja załączników jest wyłączona')}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {t('channel_office365.attachments.disabled.description', 'Załączniki z emaili nie są kopiowane do Open Mercato.')}
                            {' '}
                            <button
                              type="button"
                              className="underline underline-offset-2 hover:text-foreground transition-colors"
                              onClick={() => void handleToggleAttachments(true)}
                              disabled={togglingAttachments}
                            >
                              {t('channel_office365.attachments.disabled.cta', 'Włącz synchronizację załączników →')}
                            </button>
                          </p>
                        </div>
                      </Alert>
                    )}

                    {/* Email sync capability row */}
                    <div className="rounded-md bg-muted/30 px-3 py-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div>
                          <p className="text-xs font-medium">
                            {t('channel_office365.capability.mail.label', 'Email Sync')}
                          </p>
                          {mailEnabled && mailCap?.lastSyncedAt ? (
                            <p className="text-xs text-muted-foreground">
                              {t('channel_office365.lastSync', 'Last sync:')} {new Date(mailCap.lastSyncedAt).toLocaleString()}
                            </p>
                          ) : !mailEnabled ? (
                            <p className="text-xs text-muted-foreground">
                              {t('channel_office365.capability.mail.disabled.hint', 'Enable to sync Inbox + Sent Items to Activities.')}
                            </p>
                          ) : null}
                          {mailCap?.syncFromDate && (
                            <p className="text-xs text-muted-foreground">
                              {t('channel_office365.syncFrom.label', 'Sync from:')} {new Date(mailCap.syncFromDate).toLocaleDateString()}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0 flex-wrap">
                          {mailEnabled && (
                            <>
                              <input
                                type="date"
                                value={emailSyncFrom}
                                onChange={(e) => setEmailSyncFrom(e.target.value)}
                                max={new Date().toISOString().slice(0, 10)}
                                className="text-xs border rounded px-1.5 py-1 bg-background"
                              />
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const daysDiff = Math.ceil((Date.now() - new Date(emailSyncFrom).getTime()) / 86400000)
                                  void handleImportHistory(Math.max(1, Math.min(365, daysDiff)))
                                }}
                                disabled={!emailSyncFrom || importingHistory}
                                aria-label={t('channel_office365.emailSyncFrom.button', 'Sync email from selected date')}
                              >
                                <RefreshCw className={`size-3.5 mr-1 ${importingHistory ? 'animate-spin' : ''}`} />
                                {importingHistory
                                  ? t('channel_office365.mailSync.syncing', 'Syncing…')
                                  : t('channel_office365.emailSyncFrom.button', 'Sync')}
                              </Button>
                            </>
                          )}
                          <Button
                            size="sm"
                            variant={mailEnabled ? 'outline' : 'default'}
                            onClick={() => void handleToggleCapability(channel.id, 'mail', !mailEnabled)}
                            disabled={isToggling}
                            aria-label={mailEnabled
                              ? t('channel_office365.capability.mail.disable', 'Disable Email Sync')
                              : t('channel_office365.capability.mail.enable', 'Enable Email Sync')}
                          >
                            <Mail className="size-3.5 mr-1" />
                            {isToggling
                              ? t('channel_office365.capability.mail.updating', 'Updating…')
                              : mailEnabled
                                ? t('channel_office365.capability.mail.disable', 'Disable')
                                : t('channel_office365.capability.mail.enable', 'Enable')}
                          </Button>
                        </div>
                      </div>
                    </div>

                    {/* Migration notice — emails via hub adapter since 2026-06-19; older records live in activity timeline */}
                    {mailEnabled && (
                      <Alert variant="default" className="py-2">
                        <Info className="size-4 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium">
                            {t('channel_office365.migration.title', 'Synchronizacja emaili przez nową ścieżkę od 2026-06-19')}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {t(
                              'channel_office365.migration.description',
                              'Starsze wiadomości są widoczne w Osi czasu aktywności. Nowe emaile trafiają do zakładki E-maile.',
                            )}
                          </p>
                          <button
                            type="button"
                            className="mt-1 text-xs underline underline-offset-2 hover:text-foreground transition-colors disabled:opacity-50"
                            onClick={() => {
                              const daysDiff = Math.ceil((Date.now() - new Date(emailSyncFrom).getTime()) / 86400000)
                              void handleImportHistory(Math.max(1, Math.min(365, daysDiff)))
                            }}
                            disabled={importingHistory}
                          >
                            {importingHistory
                              ? t('channel_office365.mailSync.syncing', 'Syncing…')
                              : t('channel_office365.importHistory.cta', 'Synchronizuj od wybranej daty →')}
                          </button>
                        </div>
                      </Alert>
                    )}

                    {/* Attachments toggle — only shown when email sync is enabled */}
                    {mailEnabled && (
                      <div className="rounded-md bg-muted/30 px-3 py-2 space-y-1">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="text-xs font-medium">
                              {t('channel_office365.attachments.label', 'Synchronizacja załączników')}
                              {syncAttachments && (
                                <span className="ml-2 inline-flex items-center rounded-full bg-status-success-bg px-1.5 py-0.5 text-[10px] font-medium text-status-success-text">
                                  {t('channel_office365.attachments.active', 'aktywna')}
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {t(
                                'channel_office365.attachments.description',
                                'Kiedy włączona, załączniki z emaili będą kopiowane do Open Mercato i zajmować miejsce na dysku. Domyślny limit: 10 MB na plik.',
                              )}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant={syncAttachments ? 'outline' : 'default'}
                            onClick={() => void handleToggleAttachments(!syncAttachments)}
                            disabled={togglingAttachments}
                            aria-label={syncAttachments
                              ? t('channel_office365.attachments.disable', 'Wyłącz synchronizację załączników')
                              : t('channel_office365.attachments.enable', 'Włącz synchronizację załączników')}
                          >
                            {togglingAttachments
                              ? t('channel_office365.attachments.updating', 'Aktualizacja…')
                              : syncAttachments
                                ? t('channel_office365.attachments.disable', 'Wyłącz')
                                : t('channel_office365.attachments.enable', 'Włącz')}
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Reset sync data — destroys O365-synced calendar/mail data, not CRM records */}
                    <div className="flex items-center justify-between rounded-md border border-status-error-border/40 bg-status-error-bg/30 px-3 py-2">
                      <div>
                        <p className="text-xs font-medium text-status-error-text">
                          {t('channel_office365.resetData.label', 'Wyczyść dane sync')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t('channel_office365.resetData.hint', 'Usuwa aktywności, e-maile i spotkania z M365. Nie usuwa osób, firm ani szans.')}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => void handleResetSyncData(channel.id)}
                        disabled={resettingId === channel.id}
                        aria-label={t('channel_office365.resetData.label', 'Wyczyść dane sync')}
                      >
                        <Trash2 className="size-3.5 mr-1" />
                        {resettingId === channel.id
                          ? t('channel_office365.resetData.clearing', 'Czyszczenie…')
                          : t('channel_office365.resetData.label', 'Wyczyść dane sync')}
                      </Button>
                    </div>

                    {/* Mail scope hint — shown when Mail.ReadWrite not yet granted */}
                    {!hasMailScope(channel.id) && (
                      <Alert variant="default" className="py-2">
                        <Info className="size-4 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium">
                            {t('channel_office365.scope.mailReadHint.title', 'Wymagane ponowne połączenie')}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {t(
                              'channel_office365.scope.mailReadHint',
                              'Synchronizacja e-mail wymaga zgody na dostęp do skrzynki pocztowej. Kliknij przycisk poniżej — zostaniesz przekierowany do Microsoft, aby zatwierdzić uprawnienia.',
                            )}
                          </p>
                          <button
                            type="button"
                            className="mt-1.5 text-xs font-medium underline underline-offset-2 hover:text-foreground transition-colors"
                            onClick={() => void handleConnect()}
                          >
                            {t('channel_office365.scope.reconnectLink', 'Połącz ponownie →')}
                          </button>
                        </div>
                      </Alert>
                    )}
                  </>
                )}
              </div>
            )
          })}

          {/* Azure setup instructions */}
          <div className="rounded-lg border bg-muted/30 p-4">
            <div className="flex items-start gap-2">
              <ExternalLink className="size-4 mt-0.5 text-muted-foreground shrink-0" />
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  {t('channel_office365.setup.title', 'Azure App Registration required')}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t(
                    'channel_office365.setup.description',
                    'Configure Client ID and Secret in Settings → Integrations → Microsoft 365 before connecting.',
                  )}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t(
                    'channel_office365.setup.scopes',
                    'Required API permissions: Calendars.ReadWrite, Mail.ReadWrite, User.Read, offline_access.',
                  )}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t(
                    'channel_office365.setup.redirectUri',
                    'Redirect URI: <yourdomain>/api/communication_channels/oauth/office365/callback',
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>
      </PageBody>
    </Page>
  )
}
