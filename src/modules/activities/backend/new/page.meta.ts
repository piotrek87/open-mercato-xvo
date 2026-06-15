import React from 'react'
import { FilePlus } from 'lucide-react'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['activities.manage'],
  pageTitle: 'New Activity',
  pageTitleKey: 'activities.new.title',
  pageGroup: 'Activities',
  pageGroupKey: 'activities.nav.group',
  pageOrder: 101,
  navHidden: true,
  icon: React.createElement(FilePlus, { className: 'size-4' }),
  breadcrumb: [
    { label: 'Activities', labelKey: 'activities.nav.title', href: '/backend/activities' },
    { label: 'New Activity', labelKey: 'activities.new.title' },
  ],
}
