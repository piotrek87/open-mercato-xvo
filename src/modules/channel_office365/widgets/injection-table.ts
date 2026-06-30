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
    // Our O365 "E-maile" tab — replaces the built-in emails tab (hidden by the
    // emails-tab-hide-core widget below) so conversations + compose/reply use our
    // attachment-capable dialog. Higher priority keeps it ahead of "Załączniki e-mail"
    // among injected tabs. groupLabel is rendered raw (no t()), so it is a literal.
    {
      widgetId: 'channel_office365.injection.compose-email',
      priority: 100,
      groupId: 'office365-emails',
      groupLabel: 'E-maile',
    },
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
  // Headless: hides the built-in "Emails" tab so our injected "E-maile" tab is the single entry point.
  'detail:customers.person:header': [
    {
      widgetId: 'channel_office365.injection.emails-tab-hide-core',
      priority: 10,
    },
  ],
}

export default injectionTable
