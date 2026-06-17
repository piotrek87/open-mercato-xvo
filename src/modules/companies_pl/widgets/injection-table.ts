import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

const injectionTable: ModuleInjectionTable = {
  // Company detail page (v2) — inject as dedicated tab
  'detail:customers.company:tabs': [
    {
      widgetId: 'companies_pl.injection.company-lookup',
      kind: 'tab',
      priority: 50,
    },
  ],
  // Company create/edit form — inject as inline stack section
  'crud-form:customers.company': [
    {
      widgetId: 'companies_pl.injection.company-lookup',
      kind: 'stack',
      priority: 50,
    },
  ],
}

export { injectionTable }
export default injectionTable
