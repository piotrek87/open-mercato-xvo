import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import {
  hasChannelAdapter,
  registerChannelAdapter,
} from '@open-mercato/core/modules/communication_channels/lib/adapter-registry-singleton'
import { getO365CalendarAdapter } from './lib/adapter'

function ensureO365AdapterRegistered(): void {
  if (hasChannelAdapter('office365_calendar')) return
  registerChannelAdapter(getO365CalendarAdapter())
}

ensureO365AdapterRegistered()

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['channel_office365.view', 'channel_office365.configure'],
    admin: ['channel_office365.view', 'channel_office365.configure'],
  },
  async onTenantCreated() {
    ensureO365AdapterRegistered()
  },
}

export default setup
