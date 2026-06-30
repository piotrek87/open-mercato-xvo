import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['companies_pl.*'],
    employee: ['companies_pl.lookup'],
  },
}

export default setup
