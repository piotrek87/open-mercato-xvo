import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { resolveNotificationService } from '@open-mercato/core/modules/notifications/lib/notificationService'
import { buildNotificationFromType } from '@open-mercato/core/modules/notifications/lib/notificationBuilder'
import { notificationTypes } from '../notifications'

/**
 * Daily worker — sends due-soon and overdue notifications for task Activities.
 *
 * Due-soon:  tasks with dueAt between now and now + 24h
 * Overdue:   tasks with dueAt between now − 25h and now  (newly-overdue window;
 *            the 25h buffer avoids re-notifying tasks caught in the previous run)
 *
 * Notifications are sent per-task to ownerUserId with a stable groupKey so the
 * notification service can deduplicate across repeated runs.
 *
 * Enqueue this worker from the scheduler module with a daily CRON trigger.
 */
export const metadata: WorkerMeta = {
  queue: 'activities-due-date-notify',
  id: 'activities:due-date-notify',
  concurrency: 1,
}

const DUE_SOON_HOURS = 24
const OVERDUE_WINDOW_HOURS = 25

type WorkerCtx = JobContext & { resolve: <T = unknown>(name: string) => T }

type DueRow = {
  id: string
  tenant_id: string
  organization_id: string | null
  owner_user_id: string
  subject: string | null
  due_at: string
}

export default async function handle(_job: QueuedJob, ctx: WorkerCtx): Promise<void> {
  const em = ctx.resolve<EntityManager>('em')
  const notificationService = resolveNotificationService(ctx)
  const conn = em.getConnection()

  const now = new Date()
  const dueSoonCutoff = new Date(now.getTime() + DUE_SOON_HOURS * 60 * 60 * 1000)
  const overdueWindowStart = new Date(now.getTime() - OVERDUE_WINDOW_HOURS * 60 * 60 * 1000)

  const dueSoonType = notificationTypes.find((t) => t.type === 'activities.task_due_soon')
  const overdueType = notificationTypes.find((t) => t.type === 'activities.task_overdue')
  if (!dueSoonType || !overdueType) return

  const dueSoonRows = await conn.execute<DueRow[]>(
    `SELECT id, tenant_id, organization_id, owner_user_id, subject, due_at
       FROM activities
      WHERE lifecycle_mode = 'task'
        AND status NOT IN ('completed', 'cancelled')
        AND deleted_at IS NULL
        AND owner_user_id IS NOT NULL
        AND due_at >= ? AND due_at <= ?`,
    [now, dueSoonCutoff],
    'all',
  )

  for (const row of dueSoonRows ?? []) {
    try {
      const input = buildNotificationFromType(dueSoonType, {
        recipientUserId: row.owner_user_id,
        bodyVariables: { subject: row.subject ?? '' },
        sourceEntityType: 'activities:activity',
        sourceEntityId: row.id,
        groupKey: `activities.task_due_soon:${row.id}`,
        linkHref: `/backend/activities`,
      })
      await notificationService.create(input, {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
      })
    } catch (err) {
      console.error(`[activities:due-date-notify] due_soon failed for activity ${row.id}:`, err)
    }
  }

  const overdueRows = await conn.execute<DueRow[]>(
    `SELECT id, tenant_id, organization_id, owner_user_id, subject, due_at
       FROM activities
      WHERE lifecycle_mode = 'task'
        AND status NOT IN ('completed', 'cancelled')
        AND deleted_at IS NULL
        AND owner_user_id IS NOT NULL
        AND due_at >= ? AND due_at < ?`,
    [overdueWindowStart, now],
    'all',
  )

  for (const row of overdueRows ?? []) {
    try {
      const input = buildNotificationFromType(overdueType, {
        recipientUserId: row.owner_user_id,
        bodyVariables: { subject: row.subject ?? '' },
        sourceEntityType: 'activities:activity',
        sourceEntityId: row.id,
        groupKey: `activities.task_overdue:${row.id}`,
        linkHref: `/backend/activities`,
      })
      await notificationService.create(input, {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
      })
    } catch (err) {
      console.error(`[activities:due-date-notify] overdue failed for activity ${row.id}:`, err)
    }
  }
}
