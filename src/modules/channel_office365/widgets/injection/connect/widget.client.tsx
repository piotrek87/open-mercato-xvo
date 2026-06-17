'use client'

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Calendar } from 'lucide-react'
import { useConnectChannel } from '@open-mercato/core/modules/communication_channels/lib/use-connect-channel'
import { O365_PROVIDER_KEY } from '../../../lib/credentials'

export default function ConnectOffice365Widget(
  _props: InjectionWidgetComponentProps<Record<string, unknown>, Record<string, unknown>>,
) {
  const t = useT()
  const { connect, pending } = useConnectChannel({ providerKey: O365_PROVIDER_KEY })

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
