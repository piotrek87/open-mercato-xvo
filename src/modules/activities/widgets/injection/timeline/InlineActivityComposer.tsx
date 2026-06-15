'use client'

import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ActivityTypeDefinition } from '../../../activity-types'
import type { ActivityResponseDto } from './LogActivityDrawer'
import ActivityTypePicker from './ActivityTypePicker'

interface InlineActivityComposerProps {
  entityType: string
  entityId: string
  availableTypes: ActivityTypeDefinition[]
  onActivityCreated: (draft: { entityType: string; entityId: string; typeId: string; tempId: string }) => void
  onActivitySaved: (tempId: string, activity: ActivityResponseDto) => void
  onActivityFailed: (tempId: string) => void
  onOpenDrawer: (typeId: string) => void
}

function isInlineType(typeDef: ActivityTypeDefinition | undefined): boolean {
  if (!typeDef) return false
  return typeDef.lifecycleMode === 'fact' && !!typeDef.capabilities.hasBody
}

export default function InlineActivityComposer({
  entityType,
  entityId,
  availableTypes,
  onActivityCreated,
  onActivitySaved,
  onActivityFailed,
  onOpenDrawer,
}: InlineActivityComposerProps) {
  const t = useT()
  const [selectedTypeId, setSelectedTypeId] = React.useState<string>(
    availableTypes.find((tp) => tp.id === 'note')?.id ?? availableTypes[0]?.id ?? 'note',
  )
  const [text, setText] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  const currentTypeDef = availableTypes.find((tp) => tp.id === selectedTypeId)
  const showInline = isInlineType(currentTypeDef)

  function handleTypeSelect(typeId: string) {
    const typeDef = availableTypes.find((tp) => tp.id === typeId)
    if (!typeDef) return

    if (isInlineType(typeDef)) {
      setSelectedTypeId(typeId)
      setTimeout(() => textareaRef.current?.focus(), 50)
    } else {
      // Delegate to parent — opens Drawer
      onOpenDrawer(typeId)
    }
  }

  async function handleAdd() {
    const trimmed = text.trim()
    if (!trimmed) {
      setError(t('activities.compose.noSubject', 'Note content is required'))
      return
    }
    setError(null)
    setIsSubmitting(true)

    const subject = trimmed.length <= 100 ? trimmed : trimmed.slice(0, 97) + '…'
    const notes = trimmed.length > 100 ? trimmed : null
    const tempId = `optimistic-${selectedTypeId}-${String(Date.now())}`

    // Notify parent to add optimistic placeholder
    onActivityCreated({ entityType, entityId, typeId: selectedTypeId, tempId })
    setText('')

    try {
      const { apiCallOrThrow } = await import('@open-mercato/ui/backend/utils/apiCall')
      const response = await apiCallOrThrow<{ data: ActivityResponseDto }>('/api/activities', {
        method: 'POST',
        body: JSON.stringify({
          activityType: selectedTypeId,
          lifecycleMode: currentTypeDef?.lifecycleMode ?? 'fact',
          subject,
          notes,
          visibility: 'team',
          occurredAt: new Date().toISOString(),
          linkedEntityType: entityType,
          linkedEntityId: entityId,
        }),
      })
      onActivitySaved(tempId, response.result!.data)
    } catch {
      onActivityFailed(tempId)
      setText(trimmed)  // restore text
      const { flash } = await import('@open-mercato/ui/backend/FlashMessages')
      flash(t('activities.create.error', 'Failed to log activity'), 'error')
    } finally {
      setIsSubmitting(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleAdd()
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <ActivityTypePicker
        types={availableTypes}
        selected={selectedTypeId}
        onSelect={handleTypeSelect}
      />

      {showInline && (
        <div className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            placeholder={t('activities.compose.placeholder', 'Add a note…')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            className="resize-none flex-1"
            disabled={isSubmitting}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void handleAdd()}
            disabled={isSubmitting || !text.trim()}
            aria-label={t('activities.compose.add', 'Add')}
          >
            {t('activities.compose.add', 'Add')}
          </Button>
        </div>
      )}

      {error && <p className="text-xs text-status-error-text">{error}</p>}
    </div>
  )
}
