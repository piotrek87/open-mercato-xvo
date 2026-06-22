'use client'

import * as React from 'react'
import Link from 'next/link'
import * as Icons from 'lucide-react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { LoadingMessage } from '@open-mercato/ui/backend/detail'
import { EmptyState } from '@open-mercato/ui/backend/EmptyState'
import { Button } from '@open-mercato/ui/primitives/button'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ActivityTypeDefinition } from '../../../activity-types'
import DefaultActivityCard, { type ActivityCardData } from './DefaultActivityCard'
import ActivityFilterBar, { type QuickFilter } from './ActivityFilterBar'
import InlineActivityComposer from './InlineActivityComposer'
import LogActivityDrawer from './LogActivityDrawer'
import type { ActivityResponseDto } from './LogActivityDrawer'
import { type OptimisticActivity } from './utils'

type ActivitiesResponse = {
  data?: ActivityCardData[]
  items?: ActivityCardData[]
  hasMore?: boolean
  nextCursor?: string | null
  total?: number
}

type RegistryResponse = {
  data?: ActivityTypeDefinition[]
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay() // 0=Sun
  const diff = day === 0 ? -6 : 1 - day // shift to Monday
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function addWeeks(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + 7 * n)
  return d
}

function getWeekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    return d
  })
}

function toDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getEffectiveDate(item: { occurredAt: string | null; dueAt: string | null; createdAt: string }): Date {
  return new Date(item.occurredAt ?? item.dueAt ?? item.createdAt)
}

// ─── Timeline grouping ───────────────────────────────────────────────────────

type DateGroup = { key: string; label: string; dateItems: OptimisticActivity[] }

function groupByEffectiveDate(items: OptimisticActivity[]): DateGroup[] {
  const groups = new Map<string, DateGroup>()
  for (const item of items) {
    const date = getEffectiveDate(item)
    const key = toDateKey(date)
    if (!groups.has(key)) {
      const label = date.toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
      groups.set(key, { key, label, dateItems: [] })
    }
    groups.get(key)!.dateItems.push(item)
  }
  return Array.from(groups.values()).sort((a, b) => b.key.localeCompare(a.key))
}

// ─── Context resolver ────────────────────────────────────────────────────────

function resolveEntityContext(context: unknown): { entityType: string | null; entityId: string | null } {
  const ctx = context && typeof context === 'object' ? (context as Record<string, unknown>) : {}
  const rawKind = typeof ctx.entityType === 'string'
    ? ctx.entityType
    : typeof ctx.resourceKind === 'string'
      ? (ctx.resourceKind as string).replace('.', ':')
      : null
  const rawId = typeof ctx.entityId === 'string'
    ? ctx.entityId
    : typeof ctx.resourceId === 'string'
      ? ctx.resourceId
      : null
  return { entityType: rawKind, entityId: rawId }
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

// ─── Calendar strip ──────────────────────────────────────────────────────────

interface CalendarStripProps {
  anchorDate: Date
  selectedDay: string | null
  activityTypesByDay: Map<string, string[]>  // dateKey → [typeIds]
  onPrevWeek: () => void
  onNextWeek: () => void
  onSelectDay: (key: string | null) => void
}

// Fixed palette per type — used for calendar dots
const TYPE_DOT_COLORS: Record<string, string> = {
  email:   'bg-amber-400',
  meeting: 'bg-blue-500',
  call:    'bg-green-500',
  note:    'bg-violet-500',
  task:    'bg-gray-400',
}

function typeDotColor(typeId: string): string {
  return TYPE_DOT_COLORS[typeId] ?? 'bg-muted-foreground/40'
}

function CalendarStrip({
  anchorDate,
  selectedDay,
  activityTypesByDay,
  onPrevWeek,
  onNextWeek,
  onSelectDay,
}: CalendarStripProps) {
  const days = getWeekDays(anchorDate)
  const todayKey = toDateKey(new Date())
  const monthLabel = anchorDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-2">
      {/* Month header + navigation */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onPrevWeek}
          className="rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Previous week"
        >
          <Icons.ChevronLeft className="size-3.5" aria-hidden="true" />
        </button>
        <span className="text-xs font-semibold text-foreground capitalize">{monthLabel}</span>
        <button
          type="button"
          onClick={onNextWeek}
          className="rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Next week"
        >
          <Icons.ChevronRight className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Day tiles */}
      <div className="grid grid-cols-7 gap-0.5">
        {days.map((day) => {
          const key = toDateKey(day)
          const types = activityTypesByDay.get(key) ?? []
          const isSelected = selectedDay === key
          const isToday = key === todayKey
          const hasActivities = types.length > 0

          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelectDay(isSelected ? null : key)}
              className={[
                'flex flex-col items-center rounded-md py-1.5 px-0.5 transition-colors',
                isSelected
                  ? 'bg-primary text-primary-foreground'
                  : isToday
                    ? 'bg-background border border-border text-foreground'
                    : 'hover:bg-muted/60 text-muted-foreground',
              ].join(' ')}
            >
              <span className="text-[9px] font-medium uppercase leading-none mb-0.5 opacity-70">
                {day.toLocaleDateString(undefined, { weekday: 'short' })}
              </span>
              <span className={`text-sm font-semibold leading-none${isToday && !isSelected ? ' text-primary' : ''}`}>
                {day.getDate()}
              </span>
              {/* Activity type dots */}
              <div className="flex gap-0.5 mt-1 min-h-[6px] justify-center">
                {hasActivities && types.slice(0, 3).map((typeId, i) => (
                  <div
                    key={`${typeId}-${i}`}
                    className={[
                      'w-1.5 h-1.5 rounded-full shrink-0',
                      isSelected ? 'bg-primary-foreground/70' : typeDotColor(typeId),
                    ].join(' ')}
                  />
                ))}
              </div>
            </button>
          )
        })}
      </div>

      {/* Selected day label or "all" hint */}
      {selectedDay && (
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-xs text-muted-foreground">
            {new Date(selectedDay + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </span>
          <button
            type="button"
            onClick={() => onSelectDay(null)}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5"
          >
            <Icons.X className="size-3" aria-hidden="true" />
            Wszystkie
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Main widget ─────────────────────────────────────────────────────────────

export default function ActivityTimelineWidget({ context }: InjectionWidgetComponentProps) {
  const t = useT()
  const { entityType, entityId } = React.useMemo(() => resolveEntityContext(context), [context])

  const [items, setItems] = React.useState<OptimisticActivity[]>([])
  const [typeRegistry, setTypeRegistry] = React.useState<ActivityTypeDefinition[]>([])

  // Calendar navigation state
  const [anchorDate, setAnchorDate] = React.useState<Date>(() => startOfWeek(new Date()))
  const [selectedDay, setSelectedDay] = React.useState<string | null>(null)

  // Filters
  const [activityTypeFilter, setActivityTypeFilter] = React.useState<string | null>(null)
  const [quickFilter, setQuickFilter] = React.useState<QuickFilter>(null)
  const [dateFrom, setDateFrom] = React.useState('')
  const [dateTo, setDateTo] = React.useState('')
  const [currentUserId, setCurrentUserId] = React.useState<string | null>(null)
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('desc')

  const [total, setTotal] = React.useState<number | null>(null)
  const [hasMore, setHasMore] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [drawerInitialType, setDrawerInitialType] = React.useState<string | undefined>(undefined)
  const nextCursorRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    readApiResultOrThrow<RegistryResponse>('/api/activity-types', undefined, { allowNullResult: true })
      .then((res) => { if (Array.isArray(res?.data)) setTypeRegistry(res.data) })
      .catch(() => {})
  }, [])

  React.useEffect(() => {
    readApiResultOrThrow<{ id: string }>('/api/auth/profile', undefined, { allowNullResult: true })
      .then((res) => { if (res?.id) setCurrentUserId(res.id) })
      .catch(() => {})
  }, [])

  const loadActivities = React.useCallback(async (opts: { append?: boolean } = {}) => {
    if (!entityType || !entityId) { setLoading(false); return }
    if (opts.append) { setLoadingMore(true) } else { setLoading(true); nextCursorRef.current = null }
    setError(null)
    try {
      const params = new URLSearchParams({
        entityType,
        entityId,
        limit: '100',    // load enough for the whole calendar view client-side
        includeLinked: 'true',
        sort: sortDir,
      })
      if (opts.append && nextCursorRef.current) params.set('cursor', nextCursorRef.current)
      if (activityTypeFilter) params.set('activityType', activityTypeFilter)

      const payload = await readApiResultOrThrow<ActivitiesResponse>(
        `/api/activities?${params.toString()}`,
        undefined,
        { allowNullResult: true },
      )
      const list: ActivityCardData[] = Array.isArray(payload?.data)
        ? (payload.data as ActivityCardData[])
        : Array.isArray(payload?.items) ? (payload.items as ActivityCardData[]) : []

      const mapped = list.map((item) => ({
        id: String(item.id ?? ''),
        subject: String(item.subject ?? ''),
        activityType: String(item.activityType ?? ''),
        status: String(item.status ?? 'not_started'),
        dueAt: item.dueAt ?? null,
        occurredAt: item.occurredAt ?? null,
        createdAt: String(item.createdAt ?? ''),
        ownerUserId: item.ownerUserId ?? null,
      }))

      if (opts.append) {
        setItems((prev) => {
          const existingIds = new Set(prev.filter((i) => !i._isOptimistic).map((i) => i.id))
          return [...prev, ...mapped.filter((m) => !existingIds.has(m.id))]
        })
      } else {
        setItems((prev) => [...prev.filter((i) => i._isOptimistic), ...mapped])
      }

      nextCursorRef.current = payload?.nextCursor ?? null
      setHasMore(payload?.hasMore ?? false)
      setTotal(payload?.total ?? null)
    } catch (err) {
      console.error('activities.timeline.load', err)
      setError(t('activities.timeline.error.load', 'Failed to load activities'))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [entityType, entityId, sortDir, activityTypeFilter, t])

  React.useEffect(() => { void loadActivities() }, [loadActivities])

  React.useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible') void loadActivities()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [loadActivities])

  // ── Optimistic handlers ────────────────────────────────────────────────────

  function handleActivityCreated(draft: { entityType: string; entityId: string; typeId: string; tempId: string }) {
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
    setItems((prev) => [dtoToCardData(activity), ...prev.filter((a) => a._tempId !== tempId)])
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

  // ── Calendar helpers ───────────────────────────────────────────────────────

  // Map each day to list of unique type ids present (for dots)
  const activityTypesByDay = React.useMemo(() => {
    const map = new Map<string, string[]>()
    for (const item of items) {
      if (item._isOptimistic) continue
      const key = toDateKey(getEffectiveDate(item))
      if (!map.has(key)) map.set(key, [])
      const types = map.get(key)!
      if (!types.includes(item.activityType)) types.push(item.activityType)
    }
    return map
  }, [items])

  // Navigate calendar — anchor changes only (no API reload)
  function handlePrevWeek() {
    setAnchorDate((d) => addWeeks(d, -1))
    setSelectedDay(null)
  }

  function handleNextWeek() {
    setAnchorDate((d) => addWeeks(d, 1))
    setSelectedDay(null)
  }

  function handleSelectDay(key: string | null) {
    setSelectedDay(key)
  }

  // ── Derived display items ──────────────────────────────────────────────────

  const displayItems = React.useMemo(() => {
    let result = activityTypeFilter
      ? items.filter((i) => !i._isOptimistic || i.activityType === activityTypeFilter)
      : items
    if (selectedDay) {
      result = result.filter((i) => toDateKey(getEffectiveDate(i)) === selectedDay)
    }
    if (quickFilter === 'due_today') {
      const today = toDateKey(new Date())
      result = result.filter((i) => i._isOptimistic || (i.dueAt ? toDateKey(new Date(i.dueAt)) === today : false))
    } else if (quickFilter === 'overdue') {
      const now = new Date()
      result = result.filter((i) => {
        if (i._isOptimistic) return true
        if (!i.dueAt) return false
        return new Date(i.dueAt) < now && !['completed', 'cancelled'].includes(i.status)
      })
    } else if (quickFilter === 'mine' && currentUserId) {
      result = result.filter((i) => i._isOptimistic || i.ownerUserId === currentUserId)
    }
    if (dateFrom) {
      result = result.filter((i) => i._isOptimistic || toDateKey(getEffectiveDate(i)) >= dateFrom)
    }
    if (dateTo) {
      result = result.filter((i) => i._isOptimistic || toDateKey(getEffectiveDate(i)) <= dateTo)
    }
    return result
  }, [items, activityTypeFilter, selectedDay, quickFilter, currentUserId, dateFrom, dateTo])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading && items.length === 0) {
    return <LoadingMessage label={t('activities.timeline.loading', 'Loading activities…')} />
  }

  if (error) {
    return (
      <div className="rounded-md border border-border p-4 text-sm text-status-error-text">{error}</div>
    )
  }

  const noResults = displayItems.filter((i) => !i._isOptimistic).length === 0 && !loading

  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {t('activities.timeline.title', 'Activity Timeline')}
          </span>
          {total !== null && (
            <span className="text-xs text-muted-foreground bg-muted/60 rounded-full px-2 py-0.5">
              {total}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1.5 py-1 hover:bg-muted/60"
            aria-label={sortDir === 'desc' ? 'Sort oldest first' : 'Sort newest first'}
          >
            <Icons.ArrowUpDown className="size-3" aria-hidden="true" />
            {sortDir === 'desc' ? t('activities.sort.newest', 'Najnowsze') : t('activities.sort.oldest', 'Najstarsze')}
          </button>
          <Button type="button" size="sm" variant="outline" onClick={() => openDrawer()}>
            {t('activities.timeline.action.log', 'Log Activity')}
          </Button>
        </div>
      </div>

      {/* Inline composer */}
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

      {/* Calendar strip — week navigation with type dots */}
      <CalendarStrip
        anchorDate={anchorDate}
        selectedDay={selectedDay}
        activityTypesByDay={activityTypesByDay}
        onPrevWeek={handlePrevWeek}
        onNextWeek={handleNextWeek}
        onSelectDay={handleSelectDay}
      />

      {/* Filter bar — type chips + quick filters + date range */}
      {typeRegistry.length > 0 && (
        <ActivityFilterBar
          availableTypes={typeRegistry}
          activeFilter={activityTypeFilter}
          onChange={setActivityTypeFilter}
          quickFilter={quickFilter}
          onQuickFilterChange={setQuickFilter}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateRangeChange={(from, to) => { setDateFrom(from); setDateTo(to) }}
          currentUserId={currentUserId}
        />
      )}

      {/* "Load more for full history" notice */}
      {hasMore && !selectedDay && (
        <p className="text-xs text-muted-foreground text-center">
          Załadowano {items.filter(i => !i._isOptimistic).length} z {total ?? '?'} — starsze aktywności mogą nie być widoczne na kalendarzu.{' '}
          <button type="button" onClick={() => void loadActivities({ append: true })} className="underline hover:text-foreground">
            {t('activities.timeline.loadMore', 'Wczytaj więcej')}
          </button>
        </p>
      )}

      {/* Empty state */}
      {noResults && (
        <EmptyState
          title={selectedDay ? 'Brak aktywności w tym dniu' : t('activities.timeline.empty.title', 'No activities yet')}
          description={selectedDay
            ? 'Wybierz inny dzień lub wyczyść filtr.'
            : t('activities.timeline.empty.description', 'Log an activity to start tracking calls, tasks, and meetings for this record.')
          }
          actions={!selectedDay ? (
            <Button type="button" asChild size="sm" variant="outline">
              <Link href="/backend/activities">{t('activities.timeline.action.log', 'Log Activity')}</Link>
            </Button>
          ) : undefined}
        />
      )}

      {/* Timeline grouped by date */}
      {displayItems.length > 0 && (
        <div className="flex flex-col">
          {groupByEffectiveDate(displayItems).map(({ key, label, dateItems }) => (
            <div key={key}>
              <div className="flex items-center gap-2 mt-2 mb-1.5">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs font-medium text-muted-foreground capitalize whitespace-nowrap px-1">
                  {label}
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
              <div className="flex flex-col">
                {dateItems.map((item, idx) => {
                  const typeDef = typeRegistry.find((td) => td.id === item.activityType)
                  const isLast = idx === dateItems.length - 1
                  return (
                    <div
                      key={item._tempId ?? item.id}
                      className={`flex gap-3 items-stretch${item._isOptimistic ? ' opacity-60 pointer-events-none' : ''}`}
                    >
                      {/* Gutter: line + dot */}
                      <div className="flex flex-col items-center w-5 shrink-0" aria-hidden="true">
                        <div className="w-px bg-border grow" />
                        <div className="w-2.5 h-2.5 shrink-0 rounded-full border-2 border-muted-foreground/50 bg-background" />
                        {!isLast && <div className="w-px bg-border grow" />}
                      </div>
                      {/* Card */}
                      <div className="flex-1 min-w-0 py-1.5">
                        <DefaultActivityCard activity={item} typeDef={typeDef} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Load more (append) */}
      {hasMore && !loadingMore && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-center text-muted-foreground"
          onClick={() => void loadActivities({ append: true })}
        >
          {t('activities.timeline.loadMore', 'Wczytaj więcej')}
        </Button>
      )}
      {loadingMore && (
        <div className="flex justify-center py-2">
          <Icons.Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      )}

      {/* Drawer */}
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
