'use client'

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { Trash2, Calendar } from 'lucide-react'
import { EmptyState } from '@open-mercato/ui/backend/EmptyState'

type MeetingRow = {
  id: string
  title: string | null
  scheduledAt: string | null
  occurredAt: string | null
  durationMinutes: number | null
  status: string | null
}

type ListResponse = {
  items: MeetingRow[]
}

interface HostContext {
  resourceId?: string
  personId?: string
  companyId?: string
}

function resolveEntityId(context: HostContext | undefined): string | null {
  if (!context) return null
  return context.resourceId ?? context.personId ?? context.companyId ?? null
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export default function MeetingManagerWidget({
  context: rawContext,
}: InjectionWidgetComponentProps<Record<string, unknown>, Record<string, unknown>>) {
  const t = useT()
  const context = rawContext as HostContext | undefined
  const entityId = resolveEntityId(context)
  const [meetings, setMeetings] = React.useState<MeetingRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [deleting, setDeleting] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    if (!entityId) return
    setLoading(true)
    setError(null)
    try {
      const r = await apiCall<ListResponse>(
        `/api/customers/interactions?entityId=${encodeURIComponent(entityId)}&interactionType=meeting&limit=50&sortField=scheduledAt&sortDir=desc`,
      )
      if (r.ok && r.result) {
        setMeetings(r.result.items ?? [])
      } else {
        setError(t('channel_office365.meetings.loadError', 'Could not load meetings.'))
      }
    } catch {
      setError(t('channel_office365.meetings.loadError', 'Could not load meetings.'))
    } finally {
      setLoading(false)
    }
  }, [entityId, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleDelete = React.useCallback(
    async (id: string) => {
      setDeleting(id)
      setError(null)
      try {
        const r = await apiCall('/api/customers/interactions', {
          method: 'DELETE',
          body: JSON.stringify({ id }),
        })
        if (r.ok) {
          setMeetings((prev) => prev.filter((m) => m.id !== id))
        } else {
          setError(t('channel_office365.meetings.deleteError', 'Could not delete meeting.'))
        }
      } catch {
        setError(t('channel_office365.meetings.deleteError', 'Could not delete meeting.'))
      } finally {
        setDeleting(null)
      }
    },
    [t],
  )

  if (!entityId) return null

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        {t('channel_office365.meetings.loading', 'Loading meetings…')}
      </div>
    )
  }

  if (error) {
    return <p className="py-4 text-sm text-status-error-text">{error}</p>
  }

  if (meetings.length === 0) {
    return (
      <EmptyState
        title={t('channel_office365.meetings.empty.title', 'No meetings yet')}
        description={t(
          'channel_office365.meetings.empty.description',
          'Meetings scheduled from this record will appear here and sync to Microsoft 365.',
        )}
        icon={<Calendar className="size-6" />}
      />
    )
  }

  return (
    <div className="space-y-1">
      {meetings.map((m) => (
        <div
          key={m.id}
          className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3"
        >
          <Calendar className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {m.title ?? t('channel_office365.meetings.untitled', '(no title)')}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatDateTime(m.scheduledAt ?? m.occurredAt)}
              {m.durationMinutes ? ` · ${m.durationMinutes} min` : ''}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('channel_office365.meetings.deleteAriaLabel', 'Delete meeting')}
            disabled={deleting === m.id}
            onClick={() => void handleDelete(m.id)}
            className="shrink-0 text-muted-foreground hover:text-status-error-text"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
    </div>
  )
}
