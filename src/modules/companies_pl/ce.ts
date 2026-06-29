import type { CustomEntitySpec, CustomFieldDefinition } from '@open-mercato/shared/modules/entities'

const polishCompanyIdFields: CustomFieldDefinition[] = [
  {
    key: 'nip',
    kind: 'text',
    label: 'NIP',
    description: 'Numer Identyfikacji Podatkowej (10 cyfr, opcjonalnie 000-000-00-00)',
    filterable: true,
    formEditable: false,
    validation: [
      {
        rule: 'regex',
        param: '^(\\d{3}[-]?\\d{3}[-]?\\d{2}[-]?\\d{2}|\\d{10})$',
        message: 'NIP musi składać się z 10 cyfr (dozwolone myślniki: 000-000-00-00)',
      },
    ],
  },
  {
    key: 'krs',
    kind: 'text',
    label: 'KRS',
    description: 'Numer w Krajowym Rejestrze Sądowym (10 cyfr)',
    filterable: true,
    formEditable: false,
    validation: [
      {
        rule: 'regex',
        param: '^\\d{10}$',
        message: 'KRS musi składać się z 10 cyfr',
      },
    ],
  },
  {
    key: 'regon',
    kind: 'text',
    label: 'REGON',
    description: 'Numer REGON (9 lub 14 cyfr)',
    filterable: true,
    formEditable: false,
    validation: [
      {
        rule: 'regex',
        param: '^(\\d{9}|\\d{14})$',
        message: 'REGON musi składać się z 9 lub 14 cyfr',
      },
    ],
  },
] satisfies CustomFieldDefinition[]

export const entities: CustomEntitySpec[] = [
  {
    id: 'customers:customer_company_profile',
    fields: polishCompanyIdFields,
  },
]

export default entities
