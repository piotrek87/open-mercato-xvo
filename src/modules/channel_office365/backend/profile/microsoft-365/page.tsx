'use client'
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Page, PageHeader, PageBody } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Calendar, Mail, CheckCircle, AlertCircle, RefreshCw, ExternalLink, Info } from 'lucide-react'
import { O365_MAIL_READ_SCOPE, O365_PROVIDER_KEY } from '../../../lib/credentials'

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
  const [connecting, setConnecting] = React.useState(false)
  const [syncingId, setSyncingId] = React.useState<string | null>(null)
  const [mailSyncingId, setMailSyncingId] = React.useState<string | null>(null)
  const [togglingId, setTogglingId] = React.useState<string | null>(null)
  const [calendarSyncFrom, setCalendarSyncFrom] = React.useState('')
  const [mailSyncFrom, setMailSyncFrom] = React.useState('')

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

  const channels = (data?.items ?? []).filter((c) => c.providerKey === O365_PROVIDER_KEY)

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
    if (!confirm(t('channel_office365.disconnect.confirm', 'Disconnect Microsoft 365? All sync will stop.'))) return
    try {
      const r = await apiCall(`/api/communication_channels/channels/${channelId}`, { method: 'DELETE' })
      if (r.ok) {
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
      const r = await apiCall('/api/channel_office365/channel_office365/sync', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (r.ok) {
        flash(t('channel_office365.sync.success', 'Sync started — events will appear in a moment'), 'success')
        if (syncFromDate) setCalendarSyncFrom('')
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

  async function handleMailSyncNow(channelId: string, syncFromDate?: string) {
    setMailSyncingId(channelId)
    try {
      const body: Record<string, unknown> = { channelId }
      if (syncFromDate) {
        body.syncFromDate = new Date(syncFromDate).toISOString()
        body.resetDelta = true
      }
      const r = await apiCall('/api/channel_office365/channel_office365/mail-sync', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (r.ok) {
        flash(t('channel_office365.mailSync.success', 'Email sync started — emails will appear in a moment'), 'success')
        if (syncFromDate) setMailSyncFrom('')
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
          ? t('channel_office365.capability.mail.requiresScope', 'Reconnect to enable email sync (Mail.ReadWrite scope required).')
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
          <Button size="sm" onClick={() => void handleConnect()} disabled={connecting}>
            <Calendar className="size-4 mr-1.5" />
            {connecting
              ? t('channel_office365.connect.connecting', 'Connecting…')
              : t('channel_office365.connect.button', 'Connect Microsoft 365')}
          </Button>
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
                      <div className="flex items-center justify-between">
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
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleSyncNow(channel.id)}
                          disabled={syncingId === channel.id}
                          aria-label={t('channel_office365.sync.button', 'Sync now')}
                        >
                          <RefreshCw className={`size-3.5 mr-1 ${syncingId === channel.id ? 'animate-spin' : ''}`} />
                          {syncingId === channel.id
                            ? t('channel_office365.sync.syncing', 'Syncing…')
                            : t('channel_office365.sync.button', 'Sync now')}
                        </Button>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {t('channel_office365.resetSync.from', 'Reset & sync from:')}
                        </span>
                        <input
                          type="date"
                          value={calendarSyncFrom}
                          onChange={(e) => setCalendarSyncFrom(e.target.value)}
                          className="text-xs border rounded px-1.5 py-1 bg-background"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleSyncNow(channel.id, calendarSyncFrom)}
                          disabled={!calendarSyncFrom || syncingId === channel.id}
                          aria-label={t('channel_office365.resetSync.button', 'Reset and sync from selected date')}
                        >
                          <RefreshCw className="size-3.5 mr-1" />
                          {t('channel_office365.resetSync.button', 'Reset & sync')}
                        </Button>
                      </div>
                    </div>

                    {/* Email sync capability row */}
                    <div className="rounded-md bg-muted/30 px-3 py-2 space-y-2">
                      <div className="flex items-center justify-between">
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
                        <div className="flex items-center gap-2 shrink-0">
                          {mailEnabled && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleMailSyncNow(channel.id)}
                              disabled={mailSyncingId === channel.id}
                              aria-label={t('channel_office365.mailSync.button', 'Sync email now')}
                            >
                              <RefreshCw className={`size-3.5 mr-1 ${mailSyncingId === channel.id ? 'animate-spin' : ''}`} />
                              {mailSyncingId === channel.id
                                ? t('channel_office365.mailSync.syncing', 'Syncing…')
                                : t('channel_office365.sync.button', 'Sync now')}
                            </Button>
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
                      {mailEnabled && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {t('channel_office365.resetSync.from', 'Reset & sync from:')}
                          </span>
                          <input
                            type="date"
                            value={mailSyncFrom}
                            onChange={(e) => setMailSyncFrom(e.target.value)}
                            className="text-xs border rounded px-1.5 py-1 bg-background"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleMailSyncNow(channel.id, mailSyncFrom)}
                            disabled={!mailSyncFrom || mailSyncingId === channel.id}
                            aria-label={t('channel_office365.resetSync.button', 'Reset and sync from selected date')}
                          >
                            <RefreshCw className="size-3.5 mr-1" />
                            {t('channel_office365.resetSync.button', 'Reset & sync')}
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* Mail scope hint — shown when Mail.ReadWrite not yet granted */}
                    {!hasMailScope(channel.id) && (
                      <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2">
                        <Info className="size-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        <p className="text-xs text-muted-foreground">
                          {t(
                            'channel_office365.scope.mailReadHint',
                            'Reconnect to enable future email sync (Mail.ReadWrite scope).',
                          )}
                          {' '}
                          <button
                            type="button"
                            className="underline underline-offset-2 hover:text-foreground transition-colors"
                            onClick={() => void handleConnect()}
                          >
                            {t('channel_office365.scope.reconnectLink', 'Reconnect now')}
                          </button>
                        </p>
                      </div>
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
