import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import CompanyAddressesWidget from './widget.client'

const widget: InjectionWidgetModule<{ companyId?: string | null }, unknown> = {
  metadata: {
    id: 'companies_pl.injection.company-addresses',
    title: 'Adresy',
    description: 'Adresy przypisane do firmy',
    priority: 60,
    enabled: true,
  },
  Widget: CompanyAddressesWidget,
}

export default widget
