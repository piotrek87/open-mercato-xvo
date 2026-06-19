import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  hasChannelAdapter,
  registerChannelAdapter,
} from '@open-mercato/core/modules/communication_channels/lib/adapter-registry-singleton'
import { AttachmentPartition } from '@open-mercato/core/modules/attachments/data/entities'
import { getO365CalendarAdapter } from './lib/adapter'
import { O365_PROVIDER_KEY } from './lib/credentials'

const EMAIL_ATTACHMENTS_PARTITION = 'email_attachments'

async function ensureEmailAttachmentsPartition(em: EntityManager): Promise<void> {
  const existing = await em.findOne(AttachmentPartition, { code: EMAIL_ATTACHMENTS_PARTITION })
  if (existing) return
  const partition = em.create(AttachmentPartition, {
    code: EMAIL_ATTACHMENTS_PARTITION,
    title: 'Email Attachments',
    description: 'Attachments downloaded from Microsoft 365 emails.',
    storageDriver: 'local',
    isPublic: false,
    requiresOcr: false,
  })
  em.persist(partition)
  await em.flush()
}

// Stable UUIDs for scheduler upserts — must be valid UUIDs (ScheduledJob.id is uuid type)
const CALENDAR_SYNC_SCHEDULE_ID = '3b8f7e4a-2c1d-4e5f-8a9b-0c1d2e3f4a5b'

function ensureO365AdapterRegistered(): void {
  if (hasChannelAdapter(O365_PROVIDER_KEY)) return
  registerChannelAdapter(getO365CalendarAdapter())
}

ensureO365AdapterRegistered()

async function ensureCalendarSyncSchedule(
  container: import('awilix').AwilixContainer | undefined,
): Promise<void> {
  if (!container) return
  let schedulerService: { register: (r: Record<string, unknown>) => Promise<void> } | undefined
  try {
    schedulerService = container.resolve('schedulerService')
  } catch {
    schedulerService = undefined
  }
  if (!schedulerService) return
  try {
    await schedulerService.register({
      id: CALENDAR_SYNC_SCHEDULE_ID,
      name: 'Microsoft 365 Calendar Sync',
      description: 'Sync Microsoft 365 calendar events to Activities every 5 minutes via Graph Calendar Delta API.',
      scopeType: 'system',
      scheduleType: 'interval',
      scheduleValue: '5m',
      timezone: 'UTC',
      targetType: 'queue',
      targetQueue: 'channel-office365-calendar-sync',
      targetPayload: {},
      sourceType: 'module',
      sourceModule: 'channel_office365',
      isEnabled: true,
    })
  } catch (error) {
    console.warn(
      '[channel_office365] Failed to register calendar-sync schedule:',
      error instanceof Error ? error.message : error,
    )
  }
}

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['channel_office365.view', 'channel_office365.configure'],
    admin: ['channel_office365.view', 'channel_office365.configure'],
  },
  async onTenantCreated() {
    ensureO365AdapterRegistered()
  },
  async seedDefaults({ em, container }) {
    await ensureCalendarSyncSchedule(container)
    await ensureEmailAttachmentsPartition(em)
  },
}

export default setup
