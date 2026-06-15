import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import {
  hasChannelAdapter,
  registerChannelAdapter,
} from '@open-mercato/core/modules/communication_channels/lib/adapter-registry-singleton'
import { getO365CalendarAdapter } from './lib/adapter'
import { channelOffice365HealthCheck } from './lib/health'

export function register(container: AppContainer): void {
  if (!hasChannelAdapter('office365_calendar')) {
    registerChannelAdapter(getO365CalendarAdapter())
  }
  container.register({
    channelOffice365CalendarAdapter: asValue(getO365CalendarAdapter()),
    channelOffice365CalendarHealthCheck: asValue(channelOffice365HealthCheck),
  })
}
