import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import ConnectOffice365Widget from './widget.client'

const widget: InjectionWidgetModule<Record<string, unknown>, Record<string, unknown>> = {
  metadata: {
    id: 'channel_office365.injection.connect',
    title: 'Connect Office 365 Calendar',
    description: 'Starts the per-user Microsoft 365 OAuth connection flow.',
    features: ['communication_channels.connect_user_channel'],
    priority: 130,
    enabled: true,
  },
  Widget: ConnectOffice365Widget,
}

export default widget
