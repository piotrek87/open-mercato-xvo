import type { EntityManager } from '@mikro-orm/postgresql'
import type { ResponseEnricher } from '@open-mercato/shared/lib/crud/response-enricher'
import { Activity } from './entities'

type CiRecord = Record<string, unknown> & { id: string }

function buildEnrichment(match: Activity | null) {
  return {
    _activities: {
      linkedActivity: match
        ? {
            id: match.id,
            subject: match.subject,
            activityType: match.activityType,
            status: match.status,
            occurredAt: match.occurredAt ?? null,
            dueAt: match.dueAt ?? null,
          }
        : null,
    },
  }
}

const ciBridgeEnricher: ResponseEnricher<CiRecord> = {
  id: 'activities.ci-bridge',
  targetEntity: 'customers.interaction',
  features: ['activities.view'],
  priority: 10,
  timeout: 1500,
  fallback: { _activities: { linkedActivity: null } },

  async enrichOne(record, ctx) {
    const em = ctx.em as EntityManager
    const [match] = await em.find(Activity, {
      externalId: record.id,
      sourceType: 'customer_interaction_import',
      deletedAt: null,
    })
    return { ...record, ...buildEnrichment(match ?? null) }
  },

  async enrichMany(records, ctx) {
    if (!records.length) return records
    const em = ctx.em as EntityManager
    const ids = records.map((r) => r.id)
    const activities = await em.find(Activity, {
      externalId: { $in: ids },
      sourceType: 'customer_interaction_import',
      deletedAt: null,
    })
    const byExternalId = new Map(activities.map((a) => [a.externalId!, a]))
    return records.map((r) => ({ ...r, ...buildEnrichment(byExternalId.get(r.id) ?? null) }))
  },
}

export const enrichers: ResponseEnricher[] = [ciBridgeEnricher]
