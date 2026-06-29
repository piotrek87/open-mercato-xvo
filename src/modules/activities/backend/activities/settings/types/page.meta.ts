import React from 'react'
import { Tag } from 'lucide-react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['activities.manage_types'],
  pageTitle: 'Activity Types',
  pageTitleKey: 'activities.type.definitions.page.title',
  pageGroup: 'Activities',
  pageGroupKey: 'activities.nav.group',
  pageContext: 'settings' as const,
  navHidden: true,
  icon: React.createElement(Tag, { className: 'size-4' }),
  breadcrumb: [
    { label: 'Activities', labelKey: 'activities.nav.title', href: '/backend/activities' },
    { label: 'Activity Types', labelKey: 'activities.type.definitions.page.title' },
  ],
}
