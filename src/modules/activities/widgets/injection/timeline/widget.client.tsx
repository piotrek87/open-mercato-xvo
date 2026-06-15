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
import InlineActivityComposer from './InlineActivityComposer'
import LogActivityDrawer from './LogActivityDrawer'
import type { ActivityResponseDto } from './LogActivityDrawer'
import { mergeWithFresh, type OptimisticActivity } from './utils'

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

function dtoToCardData(dto: ActivityResponseDto): ActivityCardData {
  return {
    id: String(dto.id ?? ''),
    subject: String(dto.subject ?? ''),
    activityType: String(dto.activityType ?? ''),
    status: String(dto.status ?? 'not_started'),
    dueAt: (dto.dueAt as string | null | undefined) ?? null,
    occurredAt: (dto.occurredAt as string | null | undefined) ?? null,
    createdAt: String(dto.createdAt ?? ''),
    ownerUserId: (dto.ownerUserId as string | null | undefined) ?? null,
  }
}

export default function ActivityTimelineWidget({ context }: InjectionWidgetComponentProps) {
  const t = useT()
  const { entityType, entityId } = React.useMemo(() => resolveEntityContext(context), [context])

  const [items, setItems] = React.useState<OptimisticActivity[]>([])
  const [typeRegistry, setTypeRegistry] = React.useState<ActivityTypeDefinition[]>([])
  const [activeFilter, setActiveFilter] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [drawerInitialType, setDrawerInitialType] = React.useState<string | undefined>(undefined)

  // Load activity type registry (once)
  React.useEffect(() => {
    readApiResultOrThrow<RegistryResponse>('/api/activity-types', undefined, { allowNullResult: true })
      .then((res) => {
        if (Array.isArray(res?.data)) setTypeRegistry(res.data)
      })
      .catch(() => {
        // Registry failure is non-fatal — activities still render with DefaultActivityCard
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
      setItems((prev) =>
        mergeWithFresh(
          prev,
          list.map((item) => ({
            id: String(item.id ?? ''),
            subject: String(item.subject ?? ''),
            activityType: String(item.activityType ?? ''),
            status: String(item.status ?? 'not_started'),
            dueAt: item.dueAt ?? null,
            occurredAt: item.occurredAt ?? null,
            createdAt: String(item.createdAt ?? ''),
            ownerUserId: item.ownerUserId ?? null,
          })),
        ),
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

  // Refresh on tab visibility change
  React.useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible') void loadActivities()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [loadActivities])

  // ── Optimistic update handlers ──────────────────────────────────────────────

  function handleActivityCreated(draft: {
    entityType: string
    entityId: string
    typeId: string
    tempId: string
  }) {
    const placeholder: OptimisticActivity = {
      id: draft.tempId,
      subject: t('activities.optimistic.saving', 'Saving…'),
      activityType: draft.typeId,
      status: 'not_started',
      dueAt: null,
      occurredAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      ownerUserId: null,
      _isOptimistic: true,
      _tempId: draft.tempId,
    }
    setItems((prev) => [placeholder, ...prev])
  }

  function handleActivitySaved(tempId: string, activity: ActivityResponseDto) {
    setItems((prev) => {
      const withoutPlaceholder = prev.filter((a) => a._tempId !== tempId)
      return [dtoToCardData(activity), ...withoutPlaceholder]
    })
  }

  function handleActivityFailed(tempId: string) {
    setItems((prev) => prev.filter((a) => a._tempId !== tempId))
  }

  function handleDrawerCreated(activity: ActivityResponseDto) {
    setItems((prev) => [dtoToCardData(activity), ...prev])
  }

  function openDrawer(typeId?: string) {
    setDrawerInitialType(typeId)
    setDrawerOpen(true)
  }

  // ── Derived: filter bar ────────────────────────────────────────────────────

  const presentTypeIds = React.useMemo(
    () => new Set(items.filter((i) => !i._isOptimistic).map((i) => i.activityType)),
    [items],
  )
  const availableFilterTypes = React.useMemo(
    () => typeRegistry.filter((tp) => presentTypeIds.has(tp.id)),
    [typeRegistry, presentTypeIds],
  )

  const filteredItems = React.useMemo(
    () => (activeFilter ? items.filter((i) => i.activityType === activeFilter) : items),
    [items, activeFilter],
  )

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading && items.length === 0) {
    return <LoadingMessage label={t('activities.timeline.loading', 'Loading activities…')} />
  }

  if (error) {
    return (
      <div className="rounded-md border border-border p-4 text-sm text-status-error-text">
        {error}
      </div>
    )
  }

  const nonOptimisticEmpty = items.filter((i) => !i._isOptimistic).length === 0 && !loading

  return (
    <div className="flex flex-col gap-3">
      {/* Log activity header row */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-sm font-medium text-foreground">
          {t('activities.timeline.title', 'Activity Timeline')}
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => openDrawer()}>
          {t('activities.timeline.action.log', 'Log Activity')}
        </Button>
      </div>

      {/* Inline composer — only when entity context is known */}
      {entityType && entityId && (
        <InlineActivityComposer
          entityType={entityType}
          entityId={entityId}
          availableTypes={typeRegistry}
          onActivityCreated={handleActivityCreated}
          onActivitySaved={handleActivitySaved}
          onActivityFailed={handleActivityFailed}
          onOpenDrawer={openDrawer}
        />
      )}

      {/* Filter bar */}
      {availableFilterTypes.length > 1 && (
        <ActivityFilterBar
          availableTypes={availableFilterTypes}
          activeFilter={activeFilter}
          onChange={setActiveFilter}
        />
      )}

      {/* Empty state */}
      {nonOptimisticEmpty && items.length === 0 && (
        <EmptyState
          title={t('activities.timeline.empty.title', 'No activities yet')}
          description={t(
            'activities.timeline.empty.description',
            'Log an activity to start tracking calls, tasks, and meetings for this record.',
          )}
          actions={
            <Button type="button" asChild size="sm" variant="outline">
              <Link href="/backend/activities">
                {t('activities.timeline.action.log', 'Log Activity')}
              </Link>
            </Button>
          }
        />
      )}

      {/* Activity list */}
      {filteredItems.length > 0 && (
        <ul className="flex flex-col gap-2">
          {filteredItems.map((item) => {
            const typeDef = typeRegistry.find((td) => td.id === item.activityType)
            return (
              <li
                key={item._tempId ?? item.id}
                className={item._isOptimistic ? 'opacity-60 pointer-events-none' : undefined}
              >
                <React.Suspense
                  fallback={<DefaultActivityCard activity={item} typeDef={typeDef} />}
                >
                  <DefaultActivityCard activity={item} typeDef={typeDef} />
                </React.Suspense>
              </li>
            )
          })}
        </ul>
      )}

      {/* Full-form drawer */}
      {entityType && entityId && (
        <LogActivityDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          types={typeRegistry}
          initialType={drawerInitialType}
          entityType={entityType}
          entityId={entityId}
          onActivityCreated={handleDrawerCreated}
        />
      )}
    </div>
  )
}
