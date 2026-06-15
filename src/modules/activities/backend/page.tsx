'use client'
import * as React from 'react'
import { Page, PageHeader, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { TruncatedCell } from '@open-mercato/ui/backend/TruncatedCell'
import { EnumBadge } from '@open-mercato/ui/backend/ValueIcons'
import { Button } from '@open-mercato/ui/primitives/button'
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

const STATUS_LABELS: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  snoozed: 'Snoozed',
}

const STATUS_SEVERITY: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  not_started: 'default',
  in_progress: 'info',
  completed: 'success',
  cancelled: 'error',
  snoozed: 'warning',
}

export default function ActivitiesListPage() {
  const t = useT()

  const columns: ColumnDef<ActivityRow>[] = React.useMemo(
    () => [
      {
        accessorKey: 'subject',
        header: t('activities.list.column.subject', 'Subject'),
        cell: ({ getValue }) => (
          <TruncatedCell value={String(getValue() ?? '')} meta={{ maxWidth: 320 }} />
        ),
        meta: { maxWidth: 320 },
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
        cell: ({ getValue }) => {
          const val = String(getValue() ?? '')
          return (
            <EnumBadge
              value={val}
              label={STATUS_LABELS[val] ?? val}
              severity={STATUS_SEVERITY[val] ?? 'default'}
            />
          )
        },
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
    <Button href="/backend/activities/new" size="sm">
      <PlusIcon className="size-4 mr-1" />
      {t('activities.list.action.create', 'New activity')}
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
          entityId="activities:activity"
          apiPath="/api/activities"
          extensionTableId="activities.list"
          columns={columns}
          emptyState={{
            title: t('activities.list.empty.title', 'No activities yet'),
            description: t(
              'activities.list.empty.description',
              'Create your first activity to start tracking tasks, calls, and meetings.',
            ),
          }}
        />
      </PageBody>
    </Page>
  )
}
