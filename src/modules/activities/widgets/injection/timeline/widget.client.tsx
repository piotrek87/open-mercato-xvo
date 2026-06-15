'use client'

import * as React from 'react'
import Link from 'next/link'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { LoadingMessage } from '@open-mercato/ui/backend/detail'
import { EmptyState } from '@open-mercato/ui/backend/EmptyState'
import { Button } from '@open-mercato/ui/primitives/button'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ActivityTypeDefinition } from '../../../activity-types'
import DefaultActivityCard, { type ActivityCardData } from './DefaultActivityCard'
import ActivityFilterBar from './ActivityFilterBar'

type ActivitiesResponse = {
  data?: ActivityCardData[]
  items?: ActivityCardData[]
  hasMore?: boolean
}

type RegistryResponse = {
  data?: ActivityTypeDefinition[]
}

function resolveEntityContext(context: unknown): { entityType: string | null; entityId: string | null } {
  const ctx = context && typeof context === 'object' ? (context as Record<string, unknown>) : {}
  return {
    entityType: typeof ctx.entityType === 'string' ? ctx.entityType : null,
    entityId: typeof ctx.entityId === 'string' ? ctx.entityId : null,
  }
}

export default function ActivityTimelineWidget({ context }: InjectionWidgetComponentProps) {
  const t = useT()
  const { entityType, entityId } = React.useMemo(() => resolveEntityContext(context), [context])

  const [items, setItems] = React.useState<ActivityCardData[]>([])
  const [typeRegistry, setTypeRegistry] = React.useState<ActivityTypeDefinition[]>([])
  const [activeFilter, setActiveFilter] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  // Load activity type registry (once)
  React.useEffect(() => {
    readApiResultOrThrow<RegistryResponse>('/api/activity-types', undefined, { allowNullResult: true })
      .then((res) => {
        if (Array.isArray(res?.data)) setTypeRegistry(res.data)
      })
      .catch(() => {
        // Registry failure is non-fatal — we still show activities with default rendering
      })
  }, [])

  const loadActivities = React.useCallback(async () => {
    if (!entityType || !entityId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        entityType,
        entityId,
        limit: '50',
        includeLinked: 'true',
      })
      const payload = await readApiResultOrThrow<ActivitiesResponse>(
        `/api/activities?${params.toString()}`,
        undefined,
        { allowNullResult: true },
      )
      const list: ActivityCardData[] = Array.isArray(payload?.data)
        ? (payload.data as ActivityCardData[])
        : Array.isArray(payload?.items)
          ? (payload.items as ActivityCardData[])
          : []
      setItems(list.map((item) => ({
        id: String(item.id ?? ''),
        subject: String(item.subject ?? ''),
        activityType: String(item.activityType ?? ''),
        status: String(item.status ?? 'not_started'),
        dueAt: item.dueAt ?? null,
        occurredAt: item.occurredAt ?? null,
        createdAt: String(item.createdAt ?? ''),
        ownerUserId: item.ownerUserId ?? null,
      })))
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

  // Derived: types that actually appear in the current context
  const presentTypeIds = React.useMemo(
    () => new Set(items.map((i) => i.activityType)),
    [items],
  )
  const availableFilterTypes = React.useMemo(
    () => typeRegistry.filter((t) => presentTypeIds.has(t.id)),
    [typeRegistry, presentTypeIds],
  )

  // Filtered items
  const filteredItems = React.useMemo(
    () => (activeFilter ? items.filter((i) => i.activityType === activeFilter) : items),
    [items, activeFilter],
  )

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
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-sm font-medium text-foreground">
          {t('activities.timeline.title', 'Activity Timeline')}
        </span>
        <Button asChild size="sm" variant="outline">
          <Link href="/backend/activities">
            {t('activities.timeline.action.log', 'Log Activity')}
          </Link>
        </Button>
      </div>

      {availableFilterTypes.length > 1 && (
        <ActivityFilterBar
          availableTypes={availableFilterTypes}
          activeFilter={activeFilter}
          onChange={setActiveFilter}
        />
      )}

      <ul className="flex flex-col gap-2">
        {filteredItems.map((item) => {
          const typeDef = typeRegistry.find((td) => td.id === item.activityType)
          return (
            <li key={item.id}>
              <React.Suspense
                fallback={<DefaultActivityCard activity={item} typeDef={typeDef} />}
              >
                <DefaultActivityCard activity={item} typeDef={typeDef} />
              </React.Suspense>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
