'use client'

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { Button } from '@open-mercato/ui/primitives/button'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ActivityResponseDto } from './LogActivityDrawer'

interface QuickNoteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  entityType: string
  entityId: string
  onNoteCreated?: (activity: ActivityResponseDto) => void
}

import { deriveSubjectAndNotes } from './utils'

export default function QuickNoteDialog({
  open,
  onOpenChange,
  entityType,
  entityId,
  onNoteCreated,
}: QuickNoteDialogProps) {
  const t = useT()
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const [text, setText] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  // Focus textarea when dialog opens
  React.useEffect(() => {
    if (open) {
      setText('')
      setError(null)
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }, [open])

  async function handleSubmit() {
    const trimmed = text.trim()
    if (!trimmed) {
      setError(t('activities.compose.noSubject', 'Note content is required'))
      return
    }
    setError(null)
    setIsSubmitting(true)

    const { subject, notes } = deriveSubjectAndNotes(trimmed)

    try {
      const response = await apiCallOrThrow<{ data: ActivityResponseDto }>('/api/activities', {
        method: 'POST',
        body: JSON.stringify({
          activityType: 'note',
          lifecycleMode: 'fact',
          subject,
          notes,
          visibility: 'team',
          occurredAt: new Date().toISOString(),
          linkedEntityType: entityType,
          linkedEntityId: entityId,
        }),
      })

      onNoteCreated?.(response.result!.data)
      onOpenChange(false)
      flash(t('activities.create.success', 'Activity logged'), 'success')
    } catch {
      setIsSubmitting(false)
      flash(t('activities.create.error', 'Failed to log activity'), 'error')
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('activities.quicknote.title', 'Quick Note')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          <Textarea
            ref={textareaRef}
            placeholder={t('activities.compose.placeholder', 'Add a note…')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-[100px] resize-none"
            disabled={isSubmitting}
          />
          {error && <p className="text-sm text-status-error-text">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('activities.form.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting}>
            {isSubmitting ? <Spinner size="sm" /> : t('activities.compose.add', 'Add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
