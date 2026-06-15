'use client'

import * as React from 'react'
import Link from 'next/link'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { LoadingMessage } from '@open-mercato/ui/backend/detail'
import { EmptyState } from '@open-mercato/ui/backend/EmptyState'
import { Button } from '@open-mercato/ui/primitives/button'
import { EnumBadge, type EnumBadgeMap } from '@open-mercato/ui/backend/ValueIcons'
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

const STATUS_MAP: EnumBadgeMap = {
  not_started: { label: 'Not started', className: 'border-muted text-muted-foreground bg-muted/30' },
  in_progress: { label: 'In progress', className: 'border-blue-200 text-blue-700 bg-blue-50' },
  completed: { label: 'Completed', className: 'border-emerald-200 text-emerald-700 bg-emerald-50' },
  cancelled: { label: 'Cancelled', className: 'border-red-200 text-red-700 bg-red-50' },
}

function resolveEntityContext(context: unknown): { entityType: string | null; entityId: string | null } {
  const ctx = context && typeof context === 'object' ? (context as Record<string, unknown>) : {}
  const entityType = typeof ctx.entityType === 'string' ? ctx.entityType : null
  const entityId = typeof ctx.entityId === 'string' ? ctx.entityId : null
  return { entityType, entityId }
}

export default function ActivityTimelineWidget({ context }: InjectionWidgetComponentProps) {
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
    return <LoadingMessage label={t('activities.timeline.loading', 'Loading activities…')} />
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
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/backend/activities">
              {t('activities.timeline.action.log', 'Log Activity')}
            </Link>
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
        <Button asChild size="sm" variant="outline">
          <Link href="/backend/activities">
            {t('activities.timeline.action.log', 'Log Activity')}
          </Link>
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
              <EnumBadge value={item.status} map={STATUS_MAP} />
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
