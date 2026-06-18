import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import MeetingManagerWidget from './widget.client'

const widget: InjectionWidgetModule<Record<string, unknown>, Record<string, unknown>> = {
  metadata: {
    id: 'channel_office365.injection.meeting-manager',
    title: 'Microsoft 365 Meetings',
    description: 'Lists meetings synced to/from Microsoft 365 with a delete action.',
    features: ['customers.interactions.manage'],
    priority: 100,
    enabled: true,
  },
  Widget: MeetingManagerWidget,
}

export default widget
