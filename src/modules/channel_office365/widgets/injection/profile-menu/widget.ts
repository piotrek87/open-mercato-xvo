import { InjectionPosition } from '@open-mercato/shared/modules/widgets/injection-position'
import type { InjectionMenuItemWidget } from '@open-mercato/shared/modules/widgets/injection'

const widget: InjectionMenuItemWidget = {
  metadata: {
    id: 'channel_office365.injection.profile-menu',
    title: 'Microsoft 365 profile menu item',
  },
  menuItems: [
    {
      id: 'channel-office365-profile-link',
      labelKey: 'channel_office365.nav.group',
      label: 'Microsoft 365',
      icon: 'Calendar',
      href: '/backend/profile/microsoft-365',
      features: ['channel_office365.view'],
      placement: { position: InjectionPosition.After, relativeTo: 'communication-channels-profile-link' },
    },
  ],
}

export default widget
