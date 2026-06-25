'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Calendar, CheckCircle2, Settings } from 'lucide-react'
import { useConnectChannel } from '@open-mercato/core/modules/communication_channels/lib/use-connect-channel'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useQuery } from '@tanstack/react-query'
import { O365_PROVIDER_KEY } from '../../../lib/credentials'

type Channel = { id: string; providerKey: string; status: string; externalIdentifier?: string }

export default function ConnectOffice365Widget(
  _props: InjectionWidgetComponentProps<Record<string, unknown>, Record<string, unknown>>,
) {
  const t = useT()
  const router = useRouter()
  const { connect, pending } = useConnectChannel({ providerKey: O365_PROVIDER_KEY })

  const { data } = useQuery({
    queryKey: ['channel_office365.connect.widget'],
    queryFn: async () => {
      // includeCalendar=1: this widget detects the O365 calendar channel, which is hidden from the
      // default /me/channels response (kept out of the CRM compose "Send as" picker).
      const r = await apiCall<{ items: Channel[] }>('/api/communication_channels/me/channels?includeCalendar=1')
      return r.result
    },
    staleTime: 30_000,
  })

  const connected = (data?.items ?? []).find(
    (c) => c.providerKey === O365_PROVIDER_KEY && c.status === 'connected',
  )

  if (connected) {
    return (
      <div className="flex items-center gap-2 self-center">
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-status-success-text" />
          {t('channel_office365.status.connected', 'Connected')}
          {connected.externalIdentifier ? ` · ${connected.externalIdentifier}` : ''}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => router.push('/backend/profile/microsoft-365')}
        >
          <Settings className="size-4" />
          {t('channel_office365.connect.manage', 'Manage Microsoft 365')}
        </Button>
      </div>
    )
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="self-center"
      onClick={() => void connect()}
      disabled={pending}
    >
      <Calendar className="size-4" />
      {pending
        ? t('channel_office365.connect.connecting', 'Connecting…')
        : t('channel_office365.connect.button', 'Connect Microsoft 365')}
    </Button>
  )
}
