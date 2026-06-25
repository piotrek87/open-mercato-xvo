'use client'
import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Page, PageHeader, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { TruncatedCell } from '@open-mercato/ui/backend/TruncatedCell'
import { EnumBadge, type EnumBadgeMap } from '@open-mercato/ui/backend/ValueIcons'
import { EmptyState } from '@open-mercato/ui/backend/EmptyState'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { ColumnDef } from '@tanstack/react-table'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PlusIcon, ChevronLeft, ChevronRight, Search, X, AlertCircle, User } from 'lucide-react'
import { activityTypes } from '../activity-types'

const PAGE_SIZE = 25

type ActivityRow = {
  id: string
  subject: string
  activityType: string
  status: string
  ownerUserId: string | null
  dueAt: string | null
  occurredAt: string | null
  createdAt: string
}

type ActivitiesListResponse = {
  data: ActivityRow[]
  hasMore?: boolean
  nextCursor?: string | null
  total?: number
}

const STATUS_MAP: EnumBadgeMap = {
  not_started: { label: 'Not started', className: 'border-muted text-muted-foreground bg-muted/30' },
  in_progress: { label: 'In progress', className: 'border-status-info-border text-status-info-text bg-status-info-bg' },
  completed: { label: 'Completed', className: 'border-status-success-border text-status-success-text bg-status-success-bg' },
  cancelled: { label: 'Cancelled', className: 'border-status-error-border text-status-error-text bg-status-error-bg' },
  snoozed: { label: 'Snoozed', className: 'border-status-warning-border text-status-warning-text bg-status-warning-bg' },
  fact: { label: 'Fact', className: 'border-muted text-muted-foreground bg-muted/30' },
}

export default function ActivitiesListPage() {
  const t = useT()
  const [activityTypeFilter, setActivityTypeFilter] = React.useState('')
  const [fromFilter, setFromFilter] = React.useState('')
  const [searchQuery, setSearchQuery] = React.useState('')
  const [overdueFilter, setOverdueFilter] = React.useState(false)
  const [myFilter, setMyFilter] = React.useState(false)
  const [currentUserId, setCurrentUserId] = React.useState<string | null>(null)
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined])
  const [pageIdx, setPageIdx] = React.useState(0)

  const currentCursor = cursorStack[pageIdx]

  React.useEffect(() => {
    apiCall<{ id: string }>('/api/auth/profile')
      .then((r) => { if (r.result?.id) setCurrentUserId(r.result.id) })
      .catch(() => {})
  }, [])

  const { data: response, isLoading, error } = useQuery({
    queryKey: ['activities', 'list', currentCursor, activityTypeFilter, fromFilter, searchQuery, overdueFilter, myFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (currentCursor) params.set('cursor', currentCursor)
      if (activityTypeFilter) params.set('activityType', activityTypeFilter)
      if (fromFilter) {
        params.set('from', new Date(fromFilter).toISOString())
        params.set('dateField', 'occurredAt')
      }
      if (searchQuery.trim()) params.set('q', searchQuery.trim())
      if (overdueFilter) params.set('overdue', 'true')
      if (myFilter && currentUserId) params.set('ownerUserId', currentUserId)
      const result = await apiCall<ActivitiesListResponse>(`/api/activities?${params}`)
      return result.result
    },
  })

  const rows: ActivityRow[] = response?.data ?? []
  const hasNext = response?.hasMore ?? false
  const nextCursor = response?.nextCursor ?? null
  const total = response?.total ?? null

  function resetPagination() {
    setCursorStack([undefined])
    setPageIdx(0)
  }

  function handleTypeFilter(value: string) {
    setActivityTypeFilter(value)
    resetPagination()
  }

  function handleFromFilter(value: string) {
    setFromFilter(value)
    resetPagination()
  }

  function handleSearchQuery(value: string) {
    setSearchQuery(value)
    resetPagination()
  }

  function handleOverdueFilter(val: boolean) {
    setOverdueFilter(val)
    resetPagination()
  }

  function handleMyFilter(val: boolean) {
    setMyFilter(val)
    resetPagination()
  }

  function handleNext() {
    if (!nextCursor) return
    setCursorStack((prev) => {
      const updated = prev.slice(0, pageIdx + 1)
      updated.push(nextCursor)
      return updated
    })
    setPageIdx((p) => p + 1)
  }

  function handlePrev() {
    if (pageIdx === 0) return
    setPageIdx((p) => p - 1)
  }

  const typeOptions = React.useMemo(
    () => activityTypes.map((tp) => ({ value: tp.id, label: t(tp.label, tp.id) })),
    [t],
  )

  const columns: ColumnDef<ActivityRow>[] = React.useMemo(
    () => [
      {
        accessorKey: 'subject',
        header: t('activities.list.column.subject', 'Subject'),
        cell: ({ row, getValue }) => {
          const subject = String(getValue() ?? '').trim() || t('activities.list.subject.empty', '(no title)')
          return (
            <TruncatedCell maxWidth="max-w-[600px]">
              <Link
                href={`/backend/activities/${row.original.id}`}
                className="text-sm hover:underline underline-offset-2"
              >
                {subject}
              </Link>
            </TruncatedCell>
          )
        },
      },
      {
        accessorKey: 'activityType',
        header: t('activities.list.column.activityType', 'Type'),
        cell: ({ getValue }) => (
          <span className="text-sm">{String(getValue() ?? '')}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: t('activities.list.column.status', 'Status'),
        cell: ({ getValue }) => (
          <EnumBadge value={String(getValue() ?? '')} map={STATUS_MAP} />
        ),
      },
      {
        accessorKey: 'occurredAt',
        header: t('activities.list.column.occurredAt', 'Date'),
        cell: ({ row, getValue }) => {
          const val = (getValue() as string | null) ?? row.original.dueAt
          if (!val) return <span className="text-muted-foreground text-sm">—</span>
          return <span className="text-sm">{new Date(val).toLocaleDateString()}</span>
        },
      },
      {
        accessorKey: 'createdAt',
        header: t('activities.list.column.createdAt', 'Created'),
        cell: ({ getValue }) => (
          <span className="text-sm">
            {new Date(String(getValue() ?? '')).toLocaleDateString()}
          </span>
        ),
      },
    ],
    [t],
  )

  const toolbar = (
    <Button asChild size="sm">
      <Link href="/backend/activities/new">
        <PlusIcon className="size-4 mr-1" />
        {t('activities.list.action.create', 'New activity')}
      </Link>
    </Button>
  )

  return (
    <Page>
      <PageHeader
        title={t('activities.list.page.title', 'Activities')}
        actions={toolbar}
      />
      <PageBody>
        <div className="mb-3 flex items-center gap-3 flex-wrap">
          <div className="relative flex items-center">
            <Search className="absolute left-2.5 size-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchQuery(e.target.value)}
              placeholder={t('activities.list.filter.search', 'Search activities…')}
              className="text-sm border rounded-md pl-8 pr-3 py-1.5 bg-background w-52"
              aria-label={t('activities.list.filter.search', 'Search activities…')}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => handleSearchQuery('')}
                className="absolute right-2 text-muted-foreground hover:text-foreground"
                aria-label={t('activities.list.filter.clearSearch', 'Clear search')}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <select
            value={activityTypeFilter}
            onChange={(e) => handleTypeFilter(e.target.value)}
            className="text-sm border rounded-md px-2 py-1.5 bg-background"
          >
            <option value="">{t('activities.list.filter.allTypes', 'All types')}</option>
            {typeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground whitespace-nowrap">
              {t('activities.list.filter.fromDate', 'Email date from')}
            </label>
            <input
              type="date"
              value={fromFilter}
              onChange={(e) => handleFromFilter(e.target.value)}
              className="text-sm border rounded-md px-2 py-1.5 bg-background"
            />
            {fromFilter && (
              <button
                type="button"
                onClick={() => handleFromFilter('')}
                className="text-xs text-muted-foreground hover:text-foreground"
                aria-label={t('activities.list.filter.clearDate', 'Clear date filter')}
              >
                ✕
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleOverdueFilter(!overdueFilter)}
              className={[
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                overdueFilter
                  ? 'border-status-error-border bg-status-error-bg text-status-error-text'
                  : 'border-border bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              ].join(' ')}
            >
              <AlertCircle className="size-3" />
              {t('activities.filter.overdue', 'Overdue')}
            </button>
            {currentUserId && (
              <button
                type="button"
                onClick={() => handleMyFilter(!myFilter)}
                className={[
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                  myFilter
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                ].join(' ')}
              >
                <User className="size-3" />
                {t('activities.filter.mine', 'My activities')}
              </button>
            )}
          </div>
          {total !== null && (
            <span className="ml-auto text-xs text-muted-foreground">
              {t('activities.list.stats.total', 'Total')}: <strong>{total}</strong>
            </span>
          )}
        </div>
        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading}
          error={error ? t('activities.list.error.load', 'Failed to load activities') : null}
          extensionTableId="activities.list"
          emptyState={
            <EmptyState
              title={t('activities.list.empty.title', 'No activities yet')}
              description={t(
                'activities.list.empty.description',
                'Create your first activity to start tracking tasks, calls, and meetings.',
              )}
            />
          }
        />
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t('activities.list.pagination.page', 'Page')} {pageIdx + 1}
            {rows.length > 0 && ` · ${rows.length} ${t('activities.list.pagination.rows', 'rows')}`}
            {total !== null && ` · ${total} ${t('activities.list.pagination.total', 'total')}`}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrev}
              disabled={pageIdx === 0 || isLoading}
              aria-label={t('activities.list.pagination.prev', 'Previous page')}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleNext}
              disabled={!hasNext || isLoading}
              aria-label={t('activities.list.pagination.next', 'Next page')}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </PageBody>
    </Page>
  )
}
