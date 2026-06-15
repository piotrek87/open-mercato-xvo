import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import ActivityTimelineWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'activities.injection.timeline',
    title: 'Activity Timeline',
    description: 'Shows activities linked to the parent entity.',
    features: ['activities.view'],
    priority: 20,
  },
  Widget: ActivityTimelineWidget as InjectionWidgetModule['Widget'],
}

export default widget
