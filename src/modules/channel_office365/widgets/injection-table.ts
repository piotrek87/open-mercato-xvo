import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

export const injectionTable: ModuleInjectionTable = {
  'profile:communication-channels:connect': [
    {
      widgetId: 'channel_office365.injection.connect',
      priority: 130,
    },
  ],
  'menu:topbar:profile-dropdown': [
    {
      widgetId: 'channel_office365.injection.profile-menu',
      priority: 90,
    },
  ],

}

export default injectionTable
