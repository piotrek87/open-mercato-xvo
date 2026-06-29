import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { backfillO365HistoryForPerson } from './lib/o365-history-backfill'

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
 * Retroactively surface O365 emails/meetings on CRM contacts that already exist.
 *
 * The customers.person.created subscriber only fires for newly-added contacts, so people created
 * before the feature shipped (or before the events worker reloaded the new code) never got their
 * historical O365 mail linked. This command re-runs the exact same backfill on demand for one
 * person (--person / --email) or every person in the org. Idempotent — safe to re-run.
 *
 * Usage:
 *   yarn mercato channel_office365 backfill-history --tenant <id> --org <id>
 *   yarn mercato channel_office365 backfill-history --tenant <id> --org <id> --email a@b.pl
 *   yarn mercato channel_office365 backfill-history --tenant <id> --org <id> --person <uuid>
 */
const backfillHistory: ModuleCli = {
  command: 'backfill-history',
  async run(rest) {
    const args = parseArgs(rest)
    const tenantId = (args.tenant || args.tenantId) as string | undefined
    const organizationId = (args.org || args.organizationId) as string | undefined
    if (!tenantId || !organizationId) {
      console.error('Usage: mercato channel_office365 backfill-history --tenant <id> --org <id> [--person <uuid> | --email <addr>]')
      return
    }

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager

    const where: Record<string, unknown> = { tenantId, organizationId, kind: 'person', deletedAt: null }
    if (typeof args.person === 'string') where.id = args.person

    const persons = await findWithDecryption(
      em,
      CustomerEntity,
      where,
      undefined,
      { tenantId, organizationId },
    )

    const emailFilter = typeof args.email === 'string' ? args.email.toLowerCase() : null
    const targets = persons.filter((p) =>
      p.primaryEmail && (!emailFilter || p.primaryEmail.toLowerCase() === emailFilter),
    )

    if (targets.length === 0) {
      console.log('No matching persons with a primary email — nothing to backfill.')
      return
    }

    const now = new Date()
    let done = 0
    for (const person of targets) {
      try {
        await backfillO365HistoryForPerson(
          em.fork(),
          { tenantId, organizationId },
          person.id,
          person.primaryEmail as string,
          now,
        )
        done++
      } catch (err) {
        console.warn(`[backfill-history] person ${person.id} failed:`, err instanceof Error ? err.message : err)
      }
    }

    console.log(`Backfilled O365 history for ${done}/${targets.length} person(s) in org ${organizationId}.`)
  },
}

export default [backfillHistory]
