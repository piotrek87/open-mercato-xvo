import { Activity } from 'lucide-react'
import React from 'react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['activities.view'],
  pageTitle: 'Activities',
  pageTitleKey: 'activities.nav.title',
  pageGroup: 'Activities',
  pageGroupKey: 'activities.nav.group',
  pageOrder: 100,
  icon: React.createElement(Activity, { className: 'size-4' }),
  breadcrumb: [{ label: 'Activities', labelKey: 'activities.nav.title' }],
}
