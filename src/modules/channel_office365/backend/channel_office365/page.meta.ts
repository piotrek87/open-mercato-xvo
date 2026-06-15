import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireAuth: true,
  requireFeatures: ['channel_office365.view'],
  pageGroup: 'Office 365',
  pageGroupKey: 'channel_office365.nav.group',
  pageOrder: 10,
  pageContext: 'settings' as const,
  navHidden: true,
}
