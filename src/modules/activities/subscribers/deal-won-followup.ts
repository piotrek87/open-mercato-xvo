import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { Activity } from '../data/entities'

/**
 * Subscribes to customers.deal.won and auto-creates a follow-up task Activity
 * linked to the won deal. The task is assigned to the deal's owner and due the
 * following day so it surfaces in the Activities inbox immediately.
 */
export const metadata = {
  event: 'customers.deal.won',
  persistent: true,
  id: 'activities:deal-won-followup',
}

type DealWonPayload = {
  id: string
  tenantId: string
  organizationId: string | null
  ownerUserId: string | null
  title: string | null
  valueAmount: number | null
  valueCurrency: string | null
}

export default async function handle(payload: DealWonPayload): Promise<void> {
  if (!payload.id || !payload.tenantId) return

  try {
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em').fork()

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(9, 0, 0, 0)

    const activity = new Activity()
    activity.id = crypto.randomUUID()
    activity.tenantId = payload.tenantId
    activity.organizationId = payload.organizationId ?? ''
    activity.activityType = 'follow_up'
    activity.lifecycleMode = 'task'
    activity.subject = `Follow up on deal: ${payload.title ?? 'untitled'}`
    activity.notes = null
    activity.status = 'not_started'
    activity.priority = null
    activity.dueAt = tomorrow
    activity.completedAt = null
    activity.occurredAt = null
    activity.durationMinutes = null
    activity.location = null
    activity.allDay = false
    activity.recurrenceRule = null
    activity.authorUserId = null
    activity.ownerUserId = payload.ownerUserId ?? null
    activity.participants = null
    activity.visibility = 'team'
    activity.linkedEntityType = 'customers.deal'
    activity.linkedEntityId = payload.id
    activity.externalId = null
    activity.externalProvider = null
    activity.syncDirection = null
    activity.sourceType = 'deal_won_automation'
    activity.sourceId = payload.id
    activity.isActive = true

    em.persist(activity)
    await em.flush()
  } catch (err) {
    console.error('[activities:deal-won-followup] Failed to create follow-up activity:', err)
  }
}
