import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import CompanyLookupWidget from './widget.client'

const widget: InjectionWidgetModule<{ companyId: string | null; data?: unknown }, unknown> = {
  metadata: {
    id: 'companies_pl.injection.company-lookup',
    title: 'Dane rejestrowe (NIP/KRS/REGON)',
    description: 'Pobierz NIP/KRS/REGON z polskiego rejestru WL MF',
    priority: 50,
    enabled: true,
  },
  Widget: CompanyLookupWidget,
}

export default widget
