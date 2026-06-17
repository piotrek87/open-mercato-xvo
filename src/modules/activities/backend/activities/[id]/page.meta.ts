import React from 'react'
import { Activity } from 'lucide-react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['activities.view'],
  pageTitle: 'Activity',
  pageTitleKey: 'activities.detail.title',
  pageGroup: 'Activities',
  pageGroupKey: 'activities.nav.group',
  pageOrder: 102,
  navHidden: true,
  icon: React.createElement(Activity, { className: 'size-4' }),
  breadcrumb: [
    { label: 'Activities', labelKey: 'activities.nav.title', href: '/backend/activities' },
    { label: 'Activity', labelKey: 'activities.detail.title' },
  ],
}
