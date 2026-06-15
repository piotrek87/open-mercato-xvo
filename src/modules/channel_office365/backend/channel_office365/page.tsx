'use client'
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Page, PageHeader, PageBody } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Calendar, CheckCircle, AlertCircle, RefreshCw, ExternalLink } from 'lucide-react'

type ChannelRow = {
  id: string
  displayName: string
  externalIdentifier?: string | null
  status: string
  lastPolledAt?: string | null
  channelState?: Record<string, unknown> | null
}

export default function Office365CalendarPage() {
  const t = useT()
  const [connecting, setConnecting] = React.useState(false)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['channel_office365_channels'],
    queryFn: async () => {
      const r = await apiCall<{ items: ChannelRow[]; total: number }>(
        '/api/communication_channels/me/channels?providerKey=office365_calendar',
      )
      return r.result
    },
    refetchInterval: 30_000,
  })

  const channels = data?.items ?? []

  async function handleConnect() {
    setConnecting(true)
    try {
      const r = await apiCall<{ authorizeUrl: string }>(
        '/api/communication_channels/oauth/office365_calendar/initiate',
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
    if (!confirm(t('channel_office365.disconnect.confirm', 'Disconnect this calendar? Calendar sync will stop.'))) return
    try {
      const r = await apiCall(`/api/communication_channels/channels/${channelId}`, { method: 'DELETE' })
      if (r.ok) {
        flash(t('channel_office365.disconnect.success', 'Calendar disconnected'), 'success')
        void refetch()
      } else {
        flash(t('channel_office365.disconnect.error', 'Failed to disconnect calendar'), 'error')
      }
    } catch {
      flash(t('channel_office365.disconnect.error', 'Failed to disconnect calendar'), 'error')
    }
  }

  return (
    <Page>
      <PageHeader
        title={t('channel_office365.page.title', 'Office 365 Calendar')}
        actions={
          <Button size="sm" onClick={() => void handleConnect()} disabled={connecting}>
            <Calendar className="size-4 mr-1.5" />
            {connecting
              ? t('channel_office365.connect.connecting', 'Connecting…')
              : t('channel_office365.connect.button', 'Connect calendar')}
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
              <span>{t('channel_office365.error.load', 'Failed to load calendar connections')}</span>
            </Alert>
          )}
          {!isLoading && channels.length === 0 && (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <Calendar className="size-8 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm font-medium">
                {t('channel_office365.empty.title', 'No calendar connected')}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {t(
                  'channel_office365.empty.description',
                  'Connect your Microsoft 365 account to sync calendar events to Activities.',
                )}
              </p>
            </div>
          )}
          {channels.map((channel) => (
            <div
              key={channel.id}
              className="flex items-start justify-between gap-4 rounded-lg border p-4"
            >
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
                      ? t('channel_office365.status.connected', 'Connected — syncing calendar events')
                      : channel.status === 'requires_reauth'
                        ? t('channel_office365.status.reauth', 'Reconnect required')
                        : t('channel_office365.status.error', 'Sync error')}
                  </p>
                  {channel.lastPolledAt && (
                    <p className="text-xs text-muted-foreground">
                      {t('channel_office365.lastSync', 'Last sync:')} {new Date(channel.lastPolledAt).toLocaleString()}
                    </p>
                  )}
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
          ))}

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
                    'Configure Client ID and Secret in Settings → Integrations → Office 365 Calendar before connecting.',
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
