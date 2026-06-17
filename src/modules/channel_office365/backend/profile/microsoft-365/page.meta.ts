import React from 'react'
import { Calendar } from 'lucide-react'
import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireAuth: true,
  requireFeatures: ['channel_office365.view'],
  pageTitle: 'Microsoft 365',
  pageTitleKey: 'channel_office365.page.title',
  pageGroup: 'Profile',
  pageGroupKey: 'channel_office365.nav.group',
  pageOrder: 30,
  icon: React.createElement(Calendar, { className: 'size-4' }),
  pageContext: 'profile' as const,
  breadcrumb: [
    { label: 'Microsoft 365', labelKey: 'channel_office365.page.title' },
  ],
}
