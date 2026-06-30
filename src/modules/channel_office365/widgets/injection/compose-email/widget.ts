import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import O365ComposeTriggerWidget from './widget.client'

const widget: InjectionWidgetModule<Record<string, unknown>, Record<string, unknown>> = {
  metadata: {
    id: 'channel_office365.injection.compose-email',
    title: 'Compose O365 email',
    description: 'Opens our own Microsoft 365 compose dialog (with attachments) from the customer detail header.',
    features: ['customers.email.compose'],
    priority: 60,
    enabled: true,
  },
  Widget: O365ComposeTriggerWidget,
}

export default widget
