'use client'

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { Calendar, Trash2 } from 'lucide-react'

type MeetingRow = {
  id: string
  title: string | null
  scheduledAt: string | null
  occurredAt: string | null
  durationMinutes: number | null
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
        `/api/customers/interactions?entityId=${encodeURIComponent(entityId)}&interactionType=meeting&limit=25&sortField=scheduledAt&sortDir=desc`,
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
  if (loading) return null
  if (meetings.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Calendar className="size-4 text-muted-foreground" />
        <span>{t('channel_office365.meetings.sectionTitle', 'Microsoft 365 Meetings')}</span>
      </div>
      {error ? (
        <p className="text-xs text-status-error-text">{error}</p>
      ) : null}
      <ul className="space-y-1">
        {meetings.map((m) => (
          <li
            key={m.id}
            className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{m.title ?? t('channel_office365.meetings.untitled', '(no title)')}</p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(m.scheduledAt ?? m.occurredAt)}
                {m.durationMinutes ? ` · ${m.durationMinutes} min` : ''}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('channel_office365.meetings.delete', 'Delete meeting')}
              disabled={deleting === m.id}
              onClick={() => void handleDelete(m.id)}
              className="shrink-0 text-muted-foreground hover:text-status-error-text"
            >
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
