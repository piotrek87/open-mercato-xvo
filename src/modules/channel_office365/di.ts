import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import {
  hasChannelAdapter,
  registerChannelAdapter,
} from '@open-mercato/core/modules/communication_channels/lib/adapter-registry-singleton'
import { getO365CalendarAdapter } from './lib/adapter'
import { channelOffice365HealthCheck } from './lib/health'
import { O365_PROVIDER_KEY } from './lib/credentials'

export function register(container: AppContainer): void {
  if (!hasChannelAdapter(O365_PROVIDER_KEY)) {
    registerChannelAdapter(getO365CalendarAdapter())
  }
  container.register({
    channelOffice365Adapter: asValue(getO365CalendarAdapter()),
    channelOffice365HealthCheck: asValue(channelOffice365HealthCheck),
  })
}
