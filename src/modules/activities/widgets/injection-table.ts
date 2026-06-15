import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * Activities module injection table
 * Injects the ActivityTimeline widget as a tab into customer and sales order detail pages.
 */
const injectionTable: ModuleInjectionTable = {
  // Customer person detail page — Activities tab
  'customers.person.detail:tabs': [
    {
      widgetId: 'activities.injection.timeline',
      kind: 'tab',
      groupLabel: 'activities:timeline.tab.label',
      priority: 20,
    },
  ],

  // Customer company detail page — Activities tab
  'detail:customers.company:tabs': [
    {
      widgetId: 'activities.injection.timeline',
      kind: 'tab',
      groupLabel: 'activities:timeline.tab.label',
      priority: 20,
    },
  ],

  // Sales order detail page — Activities tab
  'sales.document.detail.order:tabs': [
    {
      widgetId: 'activities.injection.timeline',
      kind: 'tab',
      groupLabel: 'activities:timeline.tab.label',
      priority: 20,
    },
  ],
}

export { injectionTable }
export default injectionTable
