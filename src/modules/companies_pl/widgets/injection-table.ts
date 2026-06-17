import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

const injectionTable: ModuleInjectionTable = {
  // Company detail page (v2) — NIP/KRS/REGON lookup as a tab
  'detail:customers.company:tabs': [
    {
      widgetId: 'companies_pl.injection.company-lookup',
      kind: 'tab',
      priority: 50,
    },
  ],
  // Company detail page (v2) — Addresses section on the left side
  // The detail CrudForm uses injectionSpotId="customers.company", resolvedInjectionSpotId = "customers.company"
  'customers.company': [
    {
      widgetId: 'companies_pl.injection.company-addresses',
      kind: 'stack',
      priority: 60,
    },
  ],
  // Company CREATE form — inject as inline stack sections
  // Slot derived from first entityId: customers:customer_entity → crud-form:customers.customer_entity
  'crud-form:customers.customer_entity': [
    {
      widgetId: 'companies_pl.injection.company-lookup',
      kind: 'stack',
      priority: 50,
    },
    {
      widgetId: 'companies_pl.injection.company-addresses',
      kind: 'stack',
      priority: 60,
    },
  ],
}

export { injectionTable }
export default injectionTable
