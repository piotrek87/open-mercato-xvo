import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import HideCoreEmailsTabWidget from './widget.client'

const widget: InjectionWidgetModule<Record<string, unknown>, Record<string, unknown>> = {
  metadata: {
    id: 'channel_office365.injection.emails-tab-hide-core',
    title: 'Hide built-in emails tab',
    description: 'Headless widget that hides the core "Emails" tab so the O365 emails tab is the single entry point.',
    features: ['customers.email.compose'],
    priority: 10,
    enabled: true,
  },
  Widget: HideCoreEmailsTabWidget,
}

export default widget
