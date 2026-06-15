import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['activities.*'],
    admin: [
      'activities.view',
      'activities.manage',
      'activities.complete',
      'activities.cancel',
      'activities.view_private',
    ],
    employee: [
      'activities.view',
      'activities.manage',
      'activities.complete',
      'activities.cancel',
    ],
    viewer: ['activities.view'],
  },
}

export default setup
