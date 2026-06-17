import { createModuleQueue, type Queue } from '@open-mercato/queue'

export const O365_CALENDAR_SYNC_QUEUE = 'channel-office365-calendar-sync'
export const O365_MAIL_SYNC_QUEUE = 'channel-office365-mail-sync'

const GLOBAL_KEY = '__channel_office365_queues__' as const

function getQueueCache(): Map<string, Queue<Record<string, unknown>>> {
  const g = globalThis as Record<string, unknown>
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, Queue<Record<string, unknown>>>()
  }
  return g[GLOBAL_KEY] as Map<string, Queue<Record<string, unknown>>>
}

export function getO365CalendarSyncQueue<T extends Record<string, unknown>>(): Queue<T> {
  const queues = getQueueCache()
  const existing = queues.get(O365_CALENDAR_SYNC_QUEUE)
  if (existing) return existing as Queue<T>

  const created = createModuleQueue<T>(O365_CALENDAR_SYNC_QUEUE, { concurrency: 3 })
  queues.set(O365_CALENDAR_SYNC_QUEUE, created as Queue<Record<string, unknown>>)
  return created
}

export function getO365MailSyncQueue<T extends Record<string, unknown>>(): Queue<T> {
  const queues = getQueueCache()
  const existing = queues.get(O365_MAIL_SYNC_QUEUE)
  if (existing) return existing as Queue<T>

  const created = createModuleQueue<T>(O365_MAIL_SYNC_QUEUE, { concurrency: 2 })
  queues.set(O365_MAIL_SYNC_QUEUE, created as Queue<Record<string, unknown>>)
  return created
}
