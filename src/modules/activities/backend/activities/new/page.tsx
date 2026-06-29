"use client"
import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm, type CrudField, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { activityTypes } from '../../../activity-types'

const LIFECYCLE_BY_TYPE: Record<string, 'fact' | 'task'> = Object.fromEntries(
  activityTypes.map((tp) => [tp.id, tp.lifecycleMode]),
)

function toIso(val: unknown): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString()
  if (typeof val === 'string') {
    try { return new Date(val).toISOString() } catch { return null }
  }
  return null
}

export default function NewActivityPage() {
  const t = useT()

  const typeOptions = React.useMemo(
    () => activityTypes.map((tp) => ({ value: tp.id, label: t(tp.label, tp.id) })),
    [t],
  )

  const fields = React.useMemo<CrudField[]>(() => [
    {
      id: 'activityType',
      label: t('activities.form.type', 'Type'),
      type: 'select',
      required: true,
      options: typeOptions,
      defaultValue: 'note',
    },
    {
      id: 'subject',
      label: t('activities.form.subject', 'Subject'),
      type: 'text',
      required: true,
      placeholder: t('activities.form.subject.placeholder', 'Brief description'),
      maxLength: 500,
    },
    {
      id: 'notes',
      label: t('activities.form.notes', 'Notes'),
      type: 'textarea',
      rows: 4,
      maxLength: 10000,
    },
    {
      id: 'visibility',
      label: t('activities.form.visibility', 'Visibility'),
      type: 'select',
      options: [
        { value: 'team', label: t('activities.visibility.team', 'Team') },
        { value: 'public', label: t('activities.visibility.public', 'Public') },
        { value: 'private', label: t('activities.visibility.private', 'Private') },
      ],
      defaultValue: 'team',
    },
    {
      id: 'status',
      label: t('activities.form.status', 'Status'),
      type: 'select',
      options: [
        { value: 'not_started', label: t('activities.status.not_started', 'Not started') },
        { value: 'in_progress', label: t('activities.status.in_progress', 'In progress') },
        { value: 'completed', label: t('activities.status.completed', 'Completed') },
        { value: 'cancelled', label: t('activities.status.cancelled', 'Cancelled') },
      ],
      defaultValue: 'not_started',
    },
    {
      id: 'dueAt',
      label: t('activities.form.dueAt', 'Due date'),
      type: 'datetime',
    },
    {
      id: 'occurredAt',
      label: t('activities.form.occurredAt', 'Occurred at'),
      type: 'datetime',
    },
    {
      id: 'location',
      label: t('activities.form.location', 'Location'),
      type: 'text',
      maxLength: 500,
    },
    {
      id: 'durationMinutes',
      label: t('activities.form.durationMinutes', 'Duration (min)'),
      type: 'number',
    },
  ], [t, typeOptions])

  const groups = React.useMemo<CrudFormGroup[]>(() => [
    { id: 'main', title: t('activities.form.group.main', 'Activity'), column: 1, fields: ['activityType', 'subject', 'notes'] },
    { id: 'scheduling', title: t('activities.form.group.scheduling', 'Scheduling'), column: 2, fields: ['dueAt', 'occurredAt', 'durationMinutes'] },
    { id: 'meta', title: t('activities.form.group.meta', 'Details'), column: 2, fields: ['status', 'visibility', 'location'] },
  ], [t])

  const successRedirect = `/backend/activities?flash=${encodeURIComponent('Activity created')}&type=success`

  return (
    <Page>
      <PageBody>
        <CrudForm
          title={t('activities.new.title', 'New Activity')}
          backHref="/backend/activities"
          entityId="activities:activity"
          fields={fields}
          groups={groups}
          submitLabel={t('activities.new.submit', 'Create Activity')}
          cancelHref="/backend/activities"
          successRedirect={successRedirect}
          onSubmit={async (vals) => {
            const typeId = String(vals.activityType ?? 'note')
            const lifecycleMode = LIFECYCLE_BY_TYPE[typeId] ?? 'task'

            await apiCallOrThrow('/api/activities', {
              method: 'POST',
              body: JSON.stringify({
                activityType: typeId,
                lifecycleMode,
                subject: String(vals.subject ?? ''),
                notes: vals.notes ? String(vals.notes) : null,
                visibility: vals.visibility ? String(vals.visibility) : 'team',
                status: vals.status ? String(vals.status) : undefined,
                dueAt: toIso(vals.dueAt),
                occurredAt: toIso(vals.occurredAt),
                location: vals.location ? String(vals.location) : null,
                durationMinutes: vals.durationMinutes ? Number(vals.durationMinutes) : null,
              }),
            })
          }}
        />
      </PageBody>
    </Page>
  )
}
