'use client'
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Page, PageHeader, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { TruncatedCell } from '@open-mercato/ui/backend/TruncatedCell'
import { EnumBadge, type EnumBadgeMap } from '@open-mercato/ui/backend/ValueIcons'
import { EmptyState } from '@open-mercato/ui/backend/EmptyState'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { ColumnDef } from '@tanstack/react-table'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PlusIcon } from 'lucide-react'

type ActivityRow = {
  id: string
  subject: string
  activityType: string
  status: string
  ownerUserId: string | null
  dueAt: string | null
  createdAt: string
}

type ActivitiesListResponse = {
  data: ActivityRow[]
  hasMore?: boolean
  nextCursor?: string | null
}

const STATUS_MAP: EnumBadgeMap = {
  not_started: { label: 'Not started', className: 'border-muted text-muted-foreground bg-muted/30' },
  in_progress: { label: 'In progress', className: 'border-blue-200 text-blue-700 bg-blue-50' },
  completed: { label: 'Completed', className: 'border-emerald-200 text-emerald-700 bg-emerald-50' },
  cancelled: { label: 'Cancelled', className: 'border-red-200 text-red-700 bg-red-50' },
  snoozed: { label: 'Snoozed', className: 'border-amber-200 text-amber-700 bg-amber-50' },
}

export default function ActivitiesListPage() {
  const t = useT()

  const { data: response, isLoading, error } = useQuery({
    queryKey: ['activities', 'list'],
    queryFn: async () => {
      const result = await apiCall<ActivitiesListResponse>('/api/activities?limit=100')
      return result.result
    },
  })

  const rows: ActivityRow[] = response?.data ?? []

  const columns: ColumnDef<ActivityRow>[] = React.useMemo(
    () => [
      {
        accessorKey: 'subject',
        header: t('activities.list.column.subject', 'Subject'),
        cell: ({ getValue }) => (
          <TruncatedCell maxWidth="max-w-[320px]">
            <span className="text-sm">{String(getValue() ?? '')}</span>
          </TruncatedCell>
        ),
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
        accessorKey: 'ownerUserId',
        header: t('activities.list.column.owner', 'Owner'),
        cell: ({ getValue }) => {
          const val = getValue()
          if (!val) return <span className="text-muted-foreground text-sm">—</span>
          return <span className="text-sm font-mono text-xs">{String(val)}</span>
        },
      },
      {
        accessorKey: 'dueAt',
        header: t('activities.list.column.dueAt', 'Due date'),
        cell: ({ getValue }) => {
          const val = getValue()
          if (!val) return <span className="text-muted-foreground text-sm">—</span>
          return (
            <span className="text-sm">
              {new Date(String(val)).toLocaleDateString()}
            </span>
          )
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
      </PageBody>
    </Page>
  )
}
