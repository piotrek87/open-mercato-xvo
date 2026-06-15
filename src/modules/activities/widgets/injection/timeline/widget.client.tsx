'use client'

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { LoadingMessage } from '@open-mercato/ui/backend/detail'
import { EmptyState } from '@open-mercato/ui/backend/EmptyState'
import { Button } from '@open-mercato/ui/primitives/button'
import { EnumBadge } from '@open-mercato/ui/backend/ValueIcons'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { CalendarIcon, ClockIcon, ActivityIcon } from 'lucide-react'

type ActivityItem = {
  id: string
  subject: string
  activityType: string
  status: string
  dueAt: string | null
  createdAt: string
}

type ActivitiesResponse = {
  items?: ActivityItem[]
  data?: ActivityItem[]
}

type WidgetContext = {
  entityType?: string
  entityId?: string
  record?: Record<string, unknown>
}

const STATUS_SEVERITY: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  not_started: 'default',
  in_progress: 'info',
  completed: 'success',
  cancelled: 'error',
}

const STATUS_LABELS: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

function resolveEntityContext(context: unknown): { entityType: string | null; entityId: string | null } {
  const ctx = context && typeof context === 'object' ? (context as Record<string, unknown>) : {}
  const entityType = typeof ctx.entityType === 'string' ? ctx.entityType : null
  const entityId = typeof ctx.entityId === 'string' ? ctx.entityId : null
  return { entityType, entityId }
}

export default function ActivityTimelineWidget({ context }: InjectionWidgetComponentProps<WidgetContext>) {
  const t = useT()
  const { entityType, entityId } = React.useMemo(() => resolveEntityContext(context), [context])

  const [items, setItems] = React.useState<ActivityItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const loadActivities = React.useCallback(async () => {
    if (!entityType || !entityId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        linkedEntityType: entityType,
        linkedEntityId: entityId,
        pageSize: '20',
      })
      const payload = await readApiResultOrThrow<ActivitiesResponse>(
        `/api/activities?${params.toString()}`,
        undefined,
        { allowNullResult: true },
      )
      const list = Array.isArray(payload?.items)
        ? payload.items
        : Array.isArray((payload as ActivitiesResponse | null)?.data)
          ? (payload as ActivitiesResponse).data ?? []
          : []
      setItems(
        list.map((item) => ({
          id: String((item as ActivityItem).id ?? ''),
          subject: String((item as ActivityItem).subject ?? ''),
          activityType: String((item as ActivityItem).activityType ?? ''),
          status: String((item as ActivityItem).status ?? 'not_started'),
          dueAt: (item as ActivityItem).dueAt ?? null,
          createdAt: String((item as ActivityItem).createdAt ?? ''),
        })),
      )
    } catch (err) {
      console.error('activities.timeline.load', err)
      setError(t('activities.timeline.error.load', 'Failed to load activities'))
    } finally {
      setLoading(false)
    }
  }, [entityType, entityId, t])

  React.useEffect(() => {
    void loadActivities()
  }, [loadActivities])

  if (loading) {
    return <LoadingMessage message={t('activities.timeline.loading', 'Loading activities…')} />
  }

  if (error) {
    return (
      <div className="rounded-md border border-border p-4 text-sm text-status-error-text">
        {error}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title={t('activities.timeline.empty.title', 'No activities yet')}
        description={t(
          'activities.timeline.empty.description',
          'Log an activity to start tracking calls, tasks, and meetings for this record.',
        )}
        action={
          <Button href="/backend/activities" size="sm" variant="outline">
            {t('activities.timeline.action.log', 'Log Activity')}
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">
          {t('activities.timeline.title', 'Activity Timeline')}
        </span>
        <Button href="/backend/activities" size="sm" variant="outline">
          {t('activities.timeline.action.log', 'Log Activity')}
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="rounded-md border border-border bg-card p-3 flex flex-col gap-1.5"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <ActivityIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="text-sm font-medium text-foreground truncate">{item.subject}</span>
              </div>
              <EnumBadge
                value={item.status}
                label={STATUS_LABELS[item.status] ?? item.status}
                severity={STATUS_SEVERITY[item.status] ?? 'default'}
              />
            </div>
            <div className="flex items-center gap-4 pl-6">
              <span className="text-xs text-muted-foreground">{item.activityType}</span>
              {item.dueAt ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <CalendarIcon className="size-3" aria-hidden="true" />
                  {new Date(item.dueAt).toLocaleDateString()}
                </span>
              ) : null}
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <ClockIcon className="size-3" aria-hidden="true" />
                {item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '—'}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
