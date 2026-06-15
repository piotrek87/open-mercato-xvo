'use client'

import * as React from 'react'
import { useForm } from 'react-hook-form'
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerBody,
  DrawerFooter,
  DrawerTitle,
} from '@open-mercato/ui/primitives/drawer'
import { Button } from '@open-mercato/ui/primitives/button'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { activityCreateSchema } from '../../../data/validators'
import type { ActivityTypeDefinition } from '../../../activity-types'
import ActivityTypePicker from './ActivityTypePicker'
import ActivityFormFields from './ActivityFormFields'

// Raw form shape — flat, coerced by Zod on submit
export interface ActivityFormData {
  activityType: string
  lifecycleMode: 'fact' | 'task'
  subject: string
  notes?: string | null
  status?: string
  dueAt?: string | null
  occurredAt?: string | null
  durationMinutes?: number | null
  location?: string | null
  participantsRaw?: string   // comma-sep emails; parsed on submit
  recurrenceRule?: string | null
  ownerUserId?: string | null
  visibility: string
}

export interface ActivityResponseDto {
  id: string
  activityType: string
  lifecycleMode: string
  subject: string
  notes: string | null
  status: string
  dueAt: string | null
  occurredAt: string | null
  createdAt: string
  updatedAt: string
  links: { id: string; entityType: string; entityId: string; isPrimary: boolean }[]
  [key: string]: unknown
}

interface LogActivityDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  types: ActivityTypeDefinition[]
  initialType?: string
  entityType?: string
  entityId?: string
  onActivityCreated?: (activity: ActivityResponseDto) => void
}

function endOfDay(): string {
  const d = new Date()
  d.setHours(23, 59, 0, 0)
  return d.toISOString().slice(0, 16)  // datetime-local format
}

function nowIso(): string {
  return new Date().toISOString().slice(0, 16)
}

function resolveDefaults(typeDef: ActivityTypeDefinition): Partial<ActivityFormData> {
  const dv = typeDef.defaultValues ?? {}
  return {
    activityType: typeDef.id,
    lifecycleMode: typeDef.lifecycleMode,
    visibility: dv.visibility ?? 'team',
    status: dv.status ?? (typeDef.lifecycleMode === 'task' ? 'not_started' : undefined),
    durationMinutes: dv.durationMinutes ?? null,
    dueAt: dv.dueAt === 'end_of_day' ? endOfDay() : null,
    occurredAt: dv.occurredAt === 'now' ? nowIso() : null,
  }
}

import { parseParticipants } from './utils'

function extractFieldErrors(err: unknown): Record<string, string[]> | null {
  if (err && typeof err === 'object' && 'fieldErrors' in err) {
    return (err as { fieldErrors: Record<string, string[]> }).fieldErrors
  }
  if (err && typeof err === 'object' && 'details' in err) {
    const details = (err as { details: Array<{ path: (string | number)[]; message: string }> }).details
    if (Array.isArray(details)) {
      const map: Record<string, string[]> = {}
      for (const issue of details) {
        const field = String(issue.path?.[0] ?? '')
        if (field) {
          map[field] = [...(map[field] ?? []), issue.message]
        }
      }
      return Object.keys(map).length > 0 ? map : null
    }
  }
  return null
}

export default function LogActivityDrawer({
  open,
  onOpenChange,
  types,
  initialType,
  entityType,
  entityId,
  onActivityCreated,
}: LogActivityDrawerProps) {
  const t = useT()
  const [selectedTypeId, setSelectedTypeId] = React.useState<string>(
    initialType ?? types[0]?.id ?? 'note',
  )
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  const currentTypeDef = types.find((tp) => tp.id === selectedTypeId)
  const lifecycleMode: 'fact' | 'task' = currentTypeDef?.lifecycleMode ?? 'task'

  const form = useForm<ActivityFormData>({
    defaultValues: currentTypeDef ? resolveDefaults(currentTypeDef) : { visibility: 'team' },
  })

  // Sync initial type when drawer opens
  React.useEffect(() => {
    if (open) {
      const typeId = initialType ?? types[0]?.id ?? 'note'
      setSelectedTypeId(typeId)
      const typeDef = types.find((tp) => tp.id === typeId)
      if (typeDef) {
        form.reset(resolveDefaults(typeDef))
      }
    }
  }, [open, initialType, types, form])

  function handleTypeChange(typeId: string) {
    const typeDef = types.find((tp) => tp.id === typeId)
    if (!typeDef) return
    const subject = form.getValues('subject')
    const ownerUserId = form.getValues('ownerUserId')
    form.reset({ ...resolveDefaults(typeDef), subject, ownerUserId })
    setSelectedTypeId(typeId)
  }

  async function handleSubmit(data: ActivityFormData) {
    setIsSubmitting(true)
    try {
      const payload = {
        activityType: data.activityType,
        lifecycleMode: data.lifecycleMode,
        subject: data.subject,
        notes: data.notes || null,
        status: data.status || undefined,
        dueAt: data.dueAt ? new Date(data.dueAt).toISOString() : null,
        occurredAt: data.occurredAt ? new Date(data.occurredAt).toISOString() : null,
        durationMinutes: data.durationMinutes || null,
        location: data.location || null,
        recurrenceRule: data.recurrenceRule || null,
        ownerUserId: data.ownerUserId || null,
        participants: parseParticipants(data.participantsRaw),
        visibility: data.visibility,
        linkedEntityType: entityType ?? null,
        linkedEntityId: entityId ?? null,
      }

      // Client-side Zod validation before hitting the server
      const result = activityCreateSchema.safeParse(payload)
      if (!result.success) {
        const fieldErrors = result.error.flatten().fieldErrors
        Object.entries(fieldErrors).forEach(([field, messages]) => {
          form.setError(field as keyof ActivityFormData, {
            type: 'client',
            message: messages?.[0] ?? 'Invalid value',
          })
        })
        setIsSubmitting(false)
        return
      }

      const response = await apiCallOrThrow<{ data: ActivityResponseDto }>('/api/activities', {
        method: 'POST',
        body: JSON.stringify(result.data),
      })

      onActivityCreated?.(response.result!.data)
      onOpenChange(false)
      flash(t('activities.create.success', 'Activity logged'), 'success')
    } catch (err) {
      setIsSubmitting(false)
      const fieldErrors = extractFieldErrors(err)
      if (fieldErrors) {
        Object.entries(fieldErrors).forEach(([field, messages]) => {
          form.setError(field as keyof ActivityFormData, { type: 'server', message: messages[0] })
        })
      } else {
        flash(t('activities.create.error', 'Failed to log activity'), 'error')
      }
      // Drawer stays open with data preserved
    }
  }

  // Cmd/Ctrl+Enter shortcut
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        void form.handleSubmit(handleSubmit)()
      }
    }
    if (open) document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form])

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent side="right">
        <DrawerHeader>
          <DrawerTitle>{t('activities.drawer.title', 'Log Activity')}</DrawerTitle>
        </DrawerHeader>

        <DrawerBody className="flex flex-col gap-4">
          <ActivityTypePicker
            types={types}
            selected={selectedTypeId}
            onSelect={handleTypeChange}
          />

          {entityType && entityId && (
            <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground self-start">
              {t('activities.form.linkedTo', 'Linked to')}: {entityType}
            </div>
          )}

          <div className="h-px bg-border" role="separator" />

          <ActivityFormFields
            typeDef={currentTypeDef}
            register={form.register}
            errors={form.formState.errors}
            lifecycleMode={lifecycleMode}
          />
        </DrawerBody>

        <DrawerFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            {t('activities.form.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => void form.handleSubmit(handleSubmit)()}
            disabled={isSubmitting}
          >
            {isSubmitting ? <Spinner size="sm" /> : t('activities.form.submit', 'Log Activity')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
