import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * Activities module injection table
 * Injects the ActivityTimeline widget as a tab into customer and sales order detail pages.
 */
const injectionTable: ModuleInjectionTable = {
  // Customer person detail page (people route) — Activities tab
  'customers.person.detail:tabs': [
    {
      widgetId: 'activities.injection.timeline',
      kind: 'tab',
      groupLabel: 'Microsoft 365',
      priority: 20,
    },
  ],

  // Customer person detail page (people-v2 route) — Activities tab
  'detail:customers.person:tabs': [
    {
      widgetId: 'activities.injection.timeline',
      kind: 'tab',
      groupLabel: 'Microsoft 365',
      priority: 20,
    },
  ],

  // Customer company detail page — Activities tab
  'detail:customers.company:tabs': [
    {
      widgetId: 'activities.injection.timeline',
      kind: 'tab',
      groupLabel: 'Microsoft 365',
      priority: 20,
    },
  ],

  // Sales order detail page — Activities tab
  'sales.document.detail.order:tabs': [
    {
      widgetId: 'activities.injection.timeline',
      kind: 'tab',
      groupLabel: 'Microsoft 365',
      priority: 20,
    },
  ],
}

export { injectionTable }
export default injectionTable
