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
  // Company detail page (v2) — Addresses section on the left side (below ContactDetails)
  // The detail page uses a bespoke layout (not CrudForm); spot ID from page.tsx line 970
  'customers.company.detail:details': [
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
