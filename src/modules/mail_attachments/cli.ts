import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sweepUnsentUploads } from './lib/cleanup'

function parseArgs(rest: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a) continue
    if (a.startsWith('--')) {
      const [k, v] = a.replace(/^--/, '').split('=')
      if (v !== undefined) args[k] = v
      else if (rest[i + 1] && !rest[i + 1]!.startsWith('--')) { args[k] = rest[i + 1]!; i++ }
      else args[k] = true
    }
  }
  return args
}

/**
 * Delete unsent outbound mail uploads older than a TTL. Wire to cron / the scheduler module.
 *
 * Usage:
 *   yarn mercato mail_attachments cleanup-uploads [--older-than-hours 24] [--tenant <id>]
 */
const cleanupUploads: ModuleCli = {
  command: 'cleanup-uploads',
  async run(rest) {
    const args = parseArgs(rest)
    const hoursRaw = (args['older-than-hours'] ?? args.hours) as string | boolean | undefined
    const hours = typeof hoursRaw === 'string' && Number.isFinite(Number(hoursRaw)) && Number(hoursRaw) > 0
      ? Number(hoursRaw)
      : 24
    const tenantId = typeof args.tenant === 'string' ? args.tenant : undefined

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const removed = await sweepUnsentUploads(em.fork(), { olderThanMs: hours * 60 * 60 * 1000, tenantId })
    console.log(`Removed ${removed} unsent outbound upload(s) older than ${hours}h${tenantId ? ` (tenant ${tenantId})` : ''}.`)
  },
}

export default [cleanupUploads]
