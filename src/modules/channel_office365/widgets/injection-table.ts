import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

export const injectionTable: ModuleInjectionTable = {
  'profile:communication-channels:connect': [
    {
      widgetId: 'channel_office365.injection.connect',
      priority: 110,
    },
  ],
  'menu:topbar:profile-dropdown': [
    {
      widgetId: 'channel_office365.injection.profile-menu',
      priority: 110,
    },
  ],
  'detail:customers.person:footer': [
    {
      widgetId: 'channel_office365.injection.meeting-manager',
      priority: 100,
    },
  ],
  'detail:customers.company:footer': [
    {
      widgetId: 'channel_office365.injection.meeting-manager',
      priority: 100,
    },
  ],
}

export default injectionTable
