import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import O365EmailsTabWidget from './widget.client'

const widget: InjectionWidgetModule<Record<string, unknown>, Record<string, unknown>> = {
  metadata: {
    id: 'channel_office365.injection.compose-email',
    title: 'Microsoft 365 emails',
    description: 'O365 emails tab (conversations + compose/reply with attachments) that replaces the built-in emails tab on the person detail.',
    features: ['customers.email.compose'],
    priority: 60,
    enabled: true,
  },
  Widget: O365EmailsTabWidget,
}

export default widget
