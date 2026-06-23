import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'

export const notificationTypes: NotificationTypeDefinition[] = [
  {
    type: 'activities.task_due_soon',
    module: 'activities',
    titleKey: 'activities.notifications.taskDueSoon.title',
    bodyKey: 'activities.notifications.taskDueSoon.body',
    icon: 'clock',
    severity: 'warning',
    actions: [
      {
        id: 'open',
        labelKey: 'common.open',
        variant: 'outline',
        icon: 'external-link',
        href: '/backend/activities',
      },
      {
        id: 'dismiss',
        labelKey: 'notifications.actions.dismiss',
        variant: 'ghost',
      },
    ],
    primaryActionId: 'open',
    linkHref: '/backend/activities',
    expiresAfterHours: 24,
  },
  {
    type: 'activities.task_overdue',
    module: 'activities',
    titleKey: 'activities.notifications.taskOverdue.title',
    bodyKey: 'activities.notifications.taskOverdue.body',
    icon: 'alert-circle',
    severity: 'error',
    actions: [
      {
        id: 'open',
        labelKey: 'common.open',
        variant: 'outline',
        icon: 'external-link',
        href: '/backend/activities',
      },
      {
        id: 'dismiss',
        labelKey: 'notifications.actions.dismiss',
        variant: 'ghost',
      },
    ],
    primaryActionId: 'open',
    linkHref: '/backend/activities',
    expiresAfterHours: 48,
  },
]

export default notificationTypes
