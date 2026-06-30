import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['mail_attachments.*'],
    employee: ['mail_attachments.upload'],
  },
}

export default setup
