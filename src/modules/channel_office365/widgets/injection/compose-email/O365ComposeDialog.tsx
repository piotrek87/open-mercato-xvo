'use client'

import * as React from 'react'
import { Paperclip, Plus, Download, X, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@open-mercato/ui/primitives/dialog'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { RadioGroup } from '@open-mercato/ui/primitives/radio'
import { RadioField } from '@open-mercato/ui/primitives/radio-field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { LoadingMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'

export interface O365ComposeChannel {
  id: string
  displayName?: string
  externalIdentifier?: string | null
  providerKey?: string | null
  status?: string | null
}

/** A staged attachment in the dialog — a durable ref id (`{kind:'attachment', id}`) + display meta. */
type StagedAttachment = { id: string; fileName: string; size: number; source: 'upload' | 'crm' }

/**
 * Reply context, mirrors the core `ReplyState`. When present the dialog prefills To/Cc/Subject and
 * threads the outgoing message (the compose route already accepts inReplyTo/references/parentMessageId).
 */
export type O365ComposeReply = {
  inReplyTo?: string
  references?: string[]
  parentMessageId?: string
  to: string[]
  cc?: string[]
  subject: string
} | null

type UploadResponse = { attachmentId: string; fileName: string; mimeType: string; size: number }
type CrmAttachmentFile = { id: string; fileName: string; fileSize: number }
type CrmAttachmentGroup = { subject: string | null; files: CrmAttachmentFile[] }
type CrmAttachmentsResponse = { groups: CrmAttachmentGroup[] }
type RecordFilesResponse = { items?: Array<{ id: string; fileName: string; fileSize?: number }> }

/**
 * Frozen entity id for the customers person record (see entities.ids.generated). Used to list the
 * contact's "Files" tab attachments in the picker, alongside their email attachments. Both are plain
 * `Attachment` rows, so the same `kind: 'attachment'` ref + resolver handles either source.
 */
const CUSTOMER_ENTITY_ID = 'customers:customer_entity'

export interface O365ComposeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  personId: string
  defaultRecipient?: string | null
  channels: O365ComposeChannel[]
  /** When set, the dialog opens in reply mode: prefilled To/Cc/Subject + RFC threading headers. */
  replyTo?: O365ComposeReply
  onSent?: () => void
}

function parseRecipients(raw: string): string[] {
  return raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

export function O365ComposeDialog({
  open,
  onOpenChange,
  personId,
  defaultRecipient,
  channels,
  replyTo,
  onSent,
}: O365ComposeDialogProps) {
  const t = useT()
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const [to, setTo] = React.useState('')
  const [showCc, setShowCc] = React.useState(false)
  const [cc, setCc] = React.useState('')
  const [subject, setSubject] = React.useState('')
  const [body, setBody] = React.useState('')
  const [visibility, setVisibility] = React.useState<'private' | 'shared'>('private')
  const [channelId, setChannelId] = React.useState('')
  const [attachments, setAttachments] = React.useState<StagedAttachment[]>([])
  const [uploading, setUploading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // OM picker state (contact's email attachments + the contact's "Files" tab)
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [crmLoading, setCrmLoading] = React.useState(false)
  const [crmGroups, setCrmGroups] = React.useState<CrmAttachmentGroup[]>([])
  const [recordFiles, setRecordFiles] = React.useState<CrmAttachmentFile[]>([])

  // Reset on (re)open. In reply mode prefill To/Cc/Subject from the thread context.
  React.useEffect(() => {
    if (!open) return
    const replyCc = replyTo?.cc?.filter(Boolean) ?? []
    setTo(replyTo ? replyTo.to.join(', ') : (defaultRecipient ?? ''))
    setShowCc(replyCc.length > 0)
    setCc(replyCc.join(', '))
    setSubject(replyTo?.subject ?? '')
    setBody('')
    setVisibility('private')
    setChannelId(channels[0]?.id ?? '')
    setAttachments([])
    setUploading(false)
    setBusy(false)
    setError(null)
    setPickerOpen(false)
  }, [open, defaultRecipient, channels, replyTo])

  const toList = React.useMemo(() => parseRecipients(to), [to])
  const isSendDisabled =
    busy || uploading || toList.length === 0 || subject.trim().length === 0 || body.trim().length === 0 || !channelId

  // Dedup by id AND by content proxy (fileName + size): the same file added twice (upload twice, or
  // upload + "Attach from OM") collapses to one staged entry, so we never send/store duplicates.
  const addStaged = React.useCallback((item: StagedAttachment) => {
    setAttachments((prev) =>
      prev.some((a) => a.id === item.id || (a.fileName === item.fileName && a.size === item.size))
        ? prev
        : [...prev, item],
    )
  }, [])

  const removeStaged = React.useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const handleFilesPicked = React.useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setError(null)
    setUploading(true)
    try {
      // Skip files already staged (same name + size) BEFORE uploading, so a re-pick never creates a
      // throwaway pending upload on disk. `seen` also dedups duplicates within this same batch.
      const seen = new Set(attachments.map((a) => `${a.fileName}|${a.size}`))
      for (const file of Array.from(files)) {
        const key = `${file.name}|${file.size}`
        if (seen.has(key)) continue
        seen.add(key)
        const form = new FormData()
        form.append('file', file)
        const res = await apiCall<UploadResponse>('/api/mail_attachments/mail_attachments/upload', { method: 'POST', body: form })
        if (!res.ok || !res.result?.attachmentId) {
          const err = res.result as { error?: string } | null
          throw new Error(err?.error ?? t('channel_office365.compose.uploadFailed', 'Upload failed'))
        }
        addStaged({ id: res.result.attachmentId, fileName: res.result.fileName, size: res.result.size, source: 'upload' })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [attachments, addStaged, t])

  const openCrmPicker = React.useCallback(async () => {
    setPickerOpen((v) => !v)
    if (crmGroups.length > 0 || recordFiles.length > 0 || crmLoading) return
    setCrmLoading(true)
    try {
      // Two sources, fetched together: the contact's synced email attachments and the contact's
      // "Files" tab. Both yield Attachment ids that resolve through the same mail-attachment resolver.
      const [emailsRes, filesRes] = await Promise.all([
        apiCall<CrmAttachmentsResponse>(
          `/api/channel_office365/channel_office365/email-attachments?personId=${encodeURIComponent(personId)}`,
        ),
        apiCall<RecordFilesResponse>(
          `/api/attachments?entityId=${encodeURIComponent(CUSTOMER_ENTITY_ID)}&recordId=${encodeURIComponent(personId)}&page=1&pageSize=100`,
        ),
      ])
      setCrmGroups(emailsRes.result?.groups ?? [])
      setRecordFiles(
        (filesRes.result?.items ?? []).map((f) => ({ id: f.id, fileName: f.fileName, fileSize: f.fileSize ?? 0 })),
      )
    } catch {
      setCrmGroups([])
      setRecordFiles([])
    } finally {
      setCrmLoading(false)
    }
  }, [crmGroups.length, recordFiles.length, crmLoading, personId])

  const handleSend = React.useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const ccList = showCc ? parseRecipients(cc) : undefined
      const payload = {
        personId,
        userChannelId: channelId,
        to: toList,
        cc: ccList && ccList.length > 0 ? ccList : undefined,
        subject: subject.trim(),
        body: body.trim(),
        bodyFormat: 'text' as const,
        visibility,
        inReplyTo: replyTo?.inReplyTo,
        references: replyTo?.references && replyTo.references.length > 0 ? replyTo.references : undefined,
        parentMessageId: replyTo?.parentMessageId,
        attachments: attachments.length > 0 ? attachments.map((a) => ({ kind: 'attachment' as const, id: a.id })) : undefined,
      }
      const res = await apiCall<{ messageId?: string }>('/api/channel_office365/channel_office365/compose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = res.result as { error?: string; message?: string } | null
        throw new Error(err?.message ?? err?.error ?? t('channel_office365.compose.sendFailed', 'Send failed'))
      }
      onSent?.()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [showCc, cc, personId, channelId, toList, subject, body, visibility, attachments, replyTo, onSent, onOpenChange, t])

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !isSendDisabled) {
      void handleSend()
    }
  }, [isSendDisabled, handleSend])

  // One picker row, shared by the "Contact files" and per-email sections.
  const renderPickerFile = (f: CrmAttachmentFile) => {
    const added = attachments.some((a) => a.id === f.id)
    return (
      <button
        key={f.id}
        type="button"
        disabled={added}
        onClick={() => addStaged({ id: f.id, fileName: f.fileName, size: f.fileSize, source: 'crm' })}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/50 disabled:opacity-50"
      >
        <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{f.fileName}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.fileSize)}</span>
        {added ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t('channel_office365.compose.added', 'Added')}
          </span>
        ) : (
          <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>
            {replyTo
              ? t('channel_office365.compose.replyTitle', 'Reply')
              : t('channel_office365.compose.title', 'New email')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* To */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="o365-compose-to">{t('channel_office365.compose.to', 'To')}</Label>
              {!showCc && (
                <Button
                  type="button"
                  variant="link"
                  size="2xs"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setShowCc(true)}
                  aria-label={t('channel_office365.compose.addCc.ariaLabel', 'Add Cc recipients')}
                >
                  {t('channel_office365.compose.addCc', '+ Cc')}
                </Button>
              )}
            </div>
            <Input
              id="o365-compose-to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={t('channel_office365.compose.toPlaceholder', 'recipient@example.com')}
              autoComplete="off"
            />
          </div>

          {showCc && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="o365-compose-cc">{t('channel_office365.compose.cc', 'Cc')}</Label>
              <Input id="o365-compose-cc" value={cc} onChange={(e) => setCc(e.target.value)} autoComplete="off" />
            </div>
          )}

          {/* Subject */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="o365-compose-subject">{t('channel_office365.compose.subject', 'Subject')}</Label>
            <Input
              id="o365-compose-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t('channel_office365.compose.subjectPlaceholder', 'Email subject')}
            />
          </div>

          {/* Body */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="o365-compose-body">{t('channel_office365.compose.body', 'Body')}</Label>
            <Textarea
              id="o365-compose-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('channel_office365.compose.bodyPlaceholder', 'Write your message…')}
              rows={8}
            />
          </div>

          {/* Attachments */}
          <div className="flex flex-col gap-2">
            <Label>{t('channel_office365.compose.attachments', 'Attachments')}</Label>
            {attachments.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {attachments.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{a.fileName}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(a.size)}</span>
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-label={t('channel_office365.compose.removeAttachment', 'Remove attachment')}
                      onClick={() => removeStaged(a.id)}
                    >
                      <X className="size-4" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => void handleFilesPicked(e.target.files)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {t('channel_office365.compose.addFile', 'Add file')}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => void openCrmPicker()}>
                <Download className="size-4" />
                {t('channel_office365.compose.attachFromCrm', 'Attach from CRM')}
              </Button>
            </div>

            {/* CRM picker (existing email attachments on this contact) */}
            {pickerOpen && (
              <div className="rounded-md border p-3">
                {crmLoading ? (
                  <LoadingMessage label={t('channel_office365.compose.crmLoading', 'Loading attachments…')} />
                ) : crmGroups.length === 0 && recordFiles.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('channel_office365.compose.crmEmpty', 'No existing attachments for this contact.')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {recordFiles.length > 0 && (
                      <div className="space-y-1">
                        <p className="truncate text-xs font-medium text-muted-foreground">
                          {t('channel_office365.compose.crmRecordFiles', 'Contact files')}
                        </p>
                        {recordFiles.map((f) => renderPickerFile(f))}
                      </div>
                    )}
                    {crmGroups.map((group, gi) => (
                      <div key={gi} className="space-y-1">
                        <p className="truncate text-xs font-medium text-muted-foreground">
                          {group.subject || t('channel_office365.compose.crmNoSubject', '(no subject)')}
                        </p>
                        {group.files.map((f) => renderPickerFile(f))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Visibility */}
          <div className="flex flex-col gap-2">
            <Label>{t('channel_office365.compose.visibility', 'Visibility')}</Label>
            <RadioGroup
              value={visibility}
              onValueChange={(val) => setVisibility(val as 'private' | 'shared')}
              className="flex flex-row gap-4"
            >
              <RadioField value="private" label={t('channel_office365.compose.visibilityPrivate', 'Private to me')} />
              <RadioField value="shared" label={t('channel_office365.compose.visibilityShared', 'Visible to teammates')} />
            </RadioGroup>
          </div>

          {/* Send as */}
          {channels.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="o365-compose-channel">{t('channel_office365.compose.sendAs', 'Send as')}</Label>
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger id="o365-compose-channel">
                  <SelectValue placeholder={t('channel_office365.compose.selectChannel', 'Select account')} />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((ch) => (
                    <SelectItem key={ch.id} value={ch.id}>
                      {ch.displayName ?? ch.externalIdentifier ?? ch.id}
                      {ch.externalIdentifier ? ` (${ch.externalIdentifier})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {error && (
            <p className="text-sm text-status-error-text" role="alert">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('channel_office365.compose.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={() => void handleSend()} disabled={isSendDisabled}>
            {busy ? t('channel_office365.compose.sending', 'Sending…') : t('channel_office365.compose.send', 'Send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default O365ComposeDialog
