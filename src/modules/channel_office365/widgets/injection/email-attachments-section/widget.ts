import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import EmailAttachmentsSectionWidget from './widget.client'

const widget: InjectionWidgetModule<Record<string, unknown>, Record<string, unknown>> = {
  metadata: {
    id: 'channel_office365.injection.email-attachments-section',
    title: 'Email attachments',
    description: 'Lists downloadable Microsoft 365 email attachments for the customer, grouped per email.',
    features: ['channel_office365.view'],
    priority: 50,
    enabled: true,
  },
  Widget: EmailAttachmentsSectionWidget,
}

export default widget
