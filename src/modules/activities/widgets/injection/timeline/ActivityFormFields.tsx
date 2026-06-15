'use client'

import * as React from 'react'
import type { Control, FieldErrors, UseFormRegister } from 'react-hook-form'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ActivityTypeDefinition } from '../../../activity-types'
import type { ActivityFormData } from './LogActivityDrawer'

const VISIBILITY_OPTIONS = ['private', 'team', 'public'] as const
const STATUS_OPTIONS = ['not_started', 'in_progress', 'completed'] as const

const RECURRENCE_PRESETS = [
  { value: '', labelKey: 'activities.form.recurrence.none' },
  { value: 'FREQ=DAILY', labelKey: 'activities.form.recurrence.daily' },
  { value: 'FREQ=WEEKLY', labelKey: 'activities.form.recurrence.weekly' },
  { value: 'FREQ=WEEKLY;INTERVAL=2', labelKey: 'activities.form.recurrence.biweekly' },
  { value: 'FREQ=MONTHLY', labelKey: 'activities.form.recurrence.monthly' },
]

interface ActivityFormFieldsProps {
  typeDef: ActivityTypeDefinition | undefined
  register: UseFormRegister<ActivityFormData>
  errors: FieldErrors<ActivityFormData>
  lifecycleMode: 'fact' | 'task'
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="mt-1 text-xs text-status-error-text">{message}</p>
}

function Label({ htmlFor, children, required }: { htmlFor: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
      {children}
      {required && <span className="ml-0.5 text-status-error-text" aria-hidden="true">*</span>}
    </label>
  )
}

function inputClass(hasError: boolean) {
  return [
    'w-full rounded-md border px-3 py-2 text-sm bg-background text-foreground placeholder:text-muted-foreground',
    'focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent',
    hasError ? 'border-destructive' : 'border-input',
  ].join(' ')
}

export default function ActivityFormFields({ typeDef, register, errors, lifecycleMode }: ActivityFormFieldsProps) {
  const t = useT()
  const cap = typeDef?.capabilities ?? {}

  return (
    <div className="flex flex-col gap-4">
      {/* Subject — always required */}
      <div className="flex flex-col gap-1">
        <Label htmlFor="subject" required>{t('activities.form.subject', 'Subject')}</Label>
        <input
          id="subject"
          type="text"
          placeholder={t('activities.form.subject.placeholder', 'What happened or what needs to be done?')}
          className={inputClass(!!errors.subject)}
          {...register('subject')}
        />
        <FieldError message={errors.subject?.message} />
      </div>

      {/* Notes — hasBody */}
      {cap.hasBody && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="notes">{t('activities.form.notes', 'Notes')}</Label>
          <textarea
            id="notes"
            rows={4}
            placeholder={t('activities.form.notes.placeholder', 'Additional details…')}
            className={inputClass(!!errors.notes)}
            {...register('notes')}
          />
          <FieldError message={errors.notes?.message} />
        </div>
      )}

      {/* Date field — occurredAt (fact) or dueAt (task) */}
      {lifecycleMode === 'fact' ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="occurredAt">{t('activities.form.occurredAt', 'When')}</Label>
          <input
            id="occurredAt"
            type="datetime-local"
            className={inputClass(!!errors.occurredAt)}
            {...register('occurredAt')}
          />
          <FieldError message={errors.occurredAt?.message} />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <Label htmlFor="dueAt">{t('activities.form.dueAt', 'Due date')}</Label>
          <input
            id="dueAt"
            type="datetime-local"
            className={inputClass(!!errors.dueAt)}
            {...register('dueAt')}
          />
          <FieldError message={errors.dueAt?.message} />
        </div>
      )}

      {/* Status — task mode only */}
      {lifecycleMode === 'task' && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="status">{t('activities.form.status', 'Status')}</Label>
          <select id="status" className={inputClass(!!errors.status)} {...register('status')}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{t(`activities.status.${s}`, s)}</option>
            ))}
          </select>
          <FieldError message={errors.status?.message} />
        </div>
      )}

      {/* Duration — hasDueDate AND hasBody */}
      {cap.hasDueDate && cap.hasBody && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="durationMinutes">{t('activities.form.duration', 'Duration (minutes)')}</Label>
          <input
            id="durationMinutes"
            type="number"
            min={0}
            max={1440}
            className={inputClass(!!errors.durationMinutes)}
            {...register('durationMinutes', { valueAsNumber: true })}
          />
          <FieldError message={errors.durationMinutes?.message} />
        </div>
      )}

      {/* Location — hasLocation */}
      {cap.hasLocation && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="location">{t('activities.form.location', 'Location')}</Label>
          <input
            id="location"
            type="text"
            className={inputClass(!!errors.location)}
            {...register('location')}
          />
          <FieldError message={errors.location?.message} />
        </div>
      )}

      {/* Participants — hasParticipants */}
      {cap.hasParticipants && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="participantsRaw">{t('activities.form.participants', 'Participants')}</Label>
          <input
            id="participantsRaw"
            type="text"
            placeholder={t('activities.form.participants.placeholder', 'email@example.com, email2@example.com')}
            className={inputClass(false)}
            {...register('participantsRaw')}
          />
        </div>
      )}

      {/* Recurrence — hasRecurrence */}
      {cap.hasRecurrence && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="recurrenceRule">{t('activities.form.recurrence', 'Recurrence')}</Label>
          <select id="recurrenceRule" className={inputClass(!!errors.recurrenceRule)} {...register('recurrenceRule')}>
            {RECURRENCE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{t(p.labelKey, p.labelKey)}</option>
            ))}
          </select>
          <FieldError message={errors.recurrenceRule?.message} />
        </div>
      )}

      {/* Owner — hasOwner */}
      {cap.hasOwner && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="ownerUserId">{t('activities.form.owner', 'Owner')}</Label>
          <input
            id="ownerUserId"
            type="text"
            placeholder="User ID"
            className={inputClass(!!errors.ownerUserId)}
            {...register('ownerUserId')}
          />
          <FieldError message={errors.ownerUserId?.message} />
        </div>
      )}

      {/* Visibility — always */}
      <div className="flex flex-col gap-1">
        <Label htmlFor="visibility">{t('activities.form.visibility', 'Visibility')}</Label>
        <select id="visibility" className={inputClass(!!errors.visibility)} {...register('visibility')}>
          {VISIBILITY_OPTIONS.map((v) => (
            <option key={v} value={v}>{t(`activities.visibility.${v}`, v)}</option>
          ))}
        </select>
        <FieldError message={errors.visibility?.message} />
      </div>
    </div>
  )
}
