import React from 'react'
import { BarChart2 } from 'lucide-react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['activities.view'],
  pageTitle: 'Activity Analytics',
  pageTitleKey: 'activities.stats.page.title',
  pageGroup: 'Activities',
  pageGroupKey: 'activities.nav.group',
  pageOrder: 120,
  icon: React.createElement(BarChart2, { className: 'size-4' }),
  breadcrumb: [
    { label: 'Activities', labelKey: 'activities.nav.title', href: '/backend/activities' },
    { label: 'Analytics', labelKey: 'activities.stats.page.title' },
  ],
}
