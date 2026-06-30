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
  // Downloadable email-attachments shown as a dedicated tab on the customer
  // (person + company) detail, next to "E-maile" — discoverable without scrolling.
  // groupLabel is rendered raw by PersonDetailTabs/CompanyDetailTabs (no t()), so
  // it must be a literal display string.
  'detail:customers.person:tabs': [
    {
      widgetId: 'channel_office365.injection.email-attachments-section',
      priority: 50,
      groupId: 'office365-email-attachments',
      groupLabel: 'Załączniki e-mail',
    },
  ],
  'detail:customers.company:tabs': [
    {
      widgetId: 'channel_office365.injection.email-attachments-section',
      priority: 50,
      groupId: 'office365-email-attachments',
      groupLabel: 'Załączniki e-mail',
    },
  ],
  // "New email" action (our own compose dialog with attachments) on the person detail header.
  'detail:customers.person:header': [
    {
      widgetId: 'channel_office365.injection.compose-email',
      priority: 60,
    },
  ],
}

export default injectionTable
