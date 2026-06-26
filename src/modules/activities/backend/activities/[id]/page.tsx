'use client'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Page, PageHeader, PageBody } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  ArrowLeft, Mail, CalendarDays, Phone, FileText, CheckSquare,
  AlertCircle, ExternalLink, Video, MapPin, Users, Paperclip, Download,
} from 'lucide-react'
import { getActivityTypeById } from '../../../activity-types'

type Participant = {
  email: string
  name?: string
  status?: string
}

type ActivityMetadata = {
  // meeting
  isOnlineMeeting?: boolean
  onlineMeetingProvider?: string
  teamsJoinUrl?: string
  webLink?: string
  // email
  hasAttachments?: boolean
  replyTo?: Array<{ email: string; name?: string }>
  [key: string]: unknown
}

type ActivityDetail = {
  id: string
  activityType: string
  lifecycleMode: string
  subject: string
  notes: string | null
  status: string
  priority: number | null
  dueAt: string | null
  completedAt: string | null
  occurredAt: string | null
  durationMinutes: number | null
  location: string | null
  allDay: boolean
  participants: Participant[] | null
  visibility: string
  ownerUserId: string | null
  externalId: string | null
  externalProvider: string | null
  sourceType: string | null
  lastSyncedAt: string | null
  metadata: ActivityMetadata | null
  createdAt: string
  updatedAt: string
}

const TYPE_ICONS: Record<string, React.ReactNode> = {
  email: React.createElement(Mail, { className: 'size-4' }),
  meeting: React.createElement(CalendarDays, { className: 'size-4' }),
  call: React.createElement(Phone, { className: 'size-4' }),
  note: React.createElement(FileText, { className: 'size-4' }),
  task: React.createElement(CheckSquare, { className: 'size-4' }),
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  )
}

function isMeetingTeams(meta: ActivityMetadata | null): boolean {
  return meta?.isOnlineMeeting === true && meta?.onlineMeetingProvider === 'teamsForBusiness'
}

function MeetingSection({ data, t }: { data: ActivityDetail; t: (k: string, d: string) => string }) {
  const meta = data.metadata
  const isTeams = isMeetingTeams(meta)
  const joinUrl = meta?.teamsJoinUrl ?? null
  const outlookUrl = meta?.webLink ?? null

  const organizer = data.participants?.find((p) => p.status === 'organizer') ?? null
  const attendees = data.participants?.filter((p) => p.status !== 'organizer') ?? []

  return (
    <div className="rounded-lg border p-5 space-y-4">
      {/* Meeting type badge + join button */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {isTeams ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
              <Video className="size-3" />
              {t('activities.detail.meeting.teams', 'Microsoft Teams')}
            </span>
          ) : meta?.isOnlineMeeting ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground border">
              <Video className="size-3" />
              {t('activities.detail.meeting.online', 'Online meeting')}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {joinUrl && (
            <Button variant="default" size="sm" asChild>
              <a href={joinUrl} target="_blank" rel="noopener noreferrer">
                <Video className="size-4 mr-1.5" />
                {t('activities.detail.meeting.join', 'Join meeting')}
                <ExternalLink className="size-3 ml-1.5 opacity-70" />
              </a>
            </Button>
          )}
          {outlookUrl && !joinUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={outlookUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4 mr-1.5" />
                {t('activities.detail.meeting.openOutlook', 'Open in Outlook')}
              </a>
            </Button>
          )}
          {outlookUrl && joinUrl && (
            <Button variant="ghost" size="sm" asChild>
              <a href={outlookUrl} target="_blank" rel="noopener noreferrer" aria-label={t('activities.detail.meeting.openOutlook', 'Open in Outlook')}>
                <ExternalLink className="size-4" />
              </a>
            </Button>
          )}
        </div>
      </div>

      {/* Subject */}
      <Field label={t('activities.detail.field.subject', 'Subject')}>
        <p className="font-medium">{data.subject?.trim() || t('activities.detail.subject.empty', '(no title)')}</p>
      </Field>

      {/* Date + duration */}
      {data.dueAt && (
        <Field label={t('activities.detail.field.dueAt', 'Starts')}>
          <p>
            {new Date(data.dueAt).toLocaleString()}
            {data.durationMinutes != null && (
              <span className="text-muted-foreground ml-2">
                · {data.durationMinutes >= 60
                  ? `${Math.floor(data.durationMinutes / 60)}h${data.durationMinutes % 60 ? ` ${data.durationMinutes % 60}m` : ''}`
                  : `${data.durationMinutes}m`}
              </span>
            )}
          </p>
        </Field>
      )}

      {/* Location */}
      {data.location && (
        <Field label={t('activities.detail.field.location', 'Location')}>
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="size-3.5 text-muted-foreground" />
            {data.location}
          </span>
        </Field>
      )}

      {/* Organizer */}
      {organizer && (
        <Field label={t('activities.detail.meeting.organizer', 'Organizer')}>
          <p className="font-medium">
            {organizer.name ? `${organizer.name}` : organizer.email}
            {organizer.name && (
              <span className="text-muted-foreground font-normal ml-1">&lt;{organizer.email}&gt;</span>
            )}
          </p>
        </Field>
      )}

      {/* Attendees */}
      {attendees.length > 0 && (
        <Field label={t('activities.detail.field.participants', 'Attendees')}>
          <ul className="space-y-0.5">
            {attendees.map((p, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <Users className="size-3.5 text-muted-foreground shrink-0" />
                <span>
                  {p.name ?? p.email}
                  {p.name && <span className="text-muted-foreground ml-1 text-xs">&lt;{p.email}&gt;</span>}
                </span>
                {p.status && p.status !== 'pending' && (
                  <span className="text-xs text-muted-foreground">({p.status})</span>
                )}
              </li>
            ))}
          </ul>
        </Field>
      )}

      {/* Body preview / notes */}
      {data.notes && (
        <Field label={t('activities.detail.field.notes', 'Description')}>
          <p className="whitespace-pre-wrap text-muted-foreground">{data.notes}</p>
        </Field>
      )}
    </div>
  )
}

function EmailSection({ data, t }: { data: ActivityDetail; t: (k: string, d: string) => string }) {
  const meta = data.metadata
  const isInbox = data.sourceType === 'inbox'

  const sender = data.participants?.find((p) => p.status === 'sender') ?? null
  const recipients = data.participants?.filter((p) => p.status === 'recipient') ?? []
  const ccList = data.participants?.filter((p) => p.status === 'cc') ?? []
  const bccList = data.participants?.filter((p) => p.status === 'bcc') ?? []

  function formatAddress(p: Participant) {
    return p.name ? `${p.name} <${p.email}>` : p.email
  }

  return (
    <div className="rounded-lg border p-5 space-y-4">
      {/* Direction badge */}
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${isInbox ? 'bg-muted text-muted-foreground' : 'bg-blue-50 text-blue-700 border-blue-200'}`}>
          <Mail className="size-3" />
          {isInbox
            ? t('activities.detail.email.inbox', 'Inbox')
            : t('activities.detail.email.sent', 'Sent')}
        </span>
        {meta?.hasAttachments && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Paperclip className="size-3" />
            {t('activities.detail.email.hasAttachments', 'Attachments')}
          </span>
        )}
      </div>

      {/* Subject */}
      <Field label={t('activities.detail.field.subject', 'Subject')}>
        <p className="font-medium">{data.subject?.trim() || t('activities.detail.subject.empty', '(no subject)')}</p>
      </Field>

      {/* Date */}
      {data.occurredAt && (
        <Field label={isInbox
          ? t('activities.detail.email.received', 'Received')
          : t('activities.detail.email.sent', 'Sent')}>
          <p>{new Date(data.occurredAt).toLocaleString()}</p>
        </Field>
      )}

      {/* From */}
      {sender && (
        <Field label={t('activities.detail.email.from', 'From')}>
          <p>{formatAddress(sender)}</p>
        </Field>
      )}

      {/* To */}
      {recipients.length > 0 && (
        <Field label={t('activities.detail.email.to', 'To')}>
          <p className="space-y-0.5">
            {recipients.map((p, i) => (
              <span key={i} className="block">{formatAddress(p)}</span>
            ))}
          </p>
        </Field>
      )}

      {/* CC */}
      {ccList.length > 0 && (
        <Field label={t('activities.detail.email.cc', 'CC')}>
          <p className="space-y-0.5">
            {ccList.map((p, i) => (
              <span key={i} className="block">{formatAddress(p)}</span>
            ))}
          </p>
        </Field>
      )}

      {/* BCC */}
      {bccList.length > 0 && (
        <Field label={t('activities.detail.email.bcc', 'BCC')}>
          <p className="space-y-0.5">
            {bccList.map((p, i) => (
              <span key={i} className="block">{formatAddress(p)}</span>
            ))}
          </p>
        </Field>
      )}

      {/* Reply-To — only shown when different from sender (set by mailing lists etc.) */}
      {meta?.replyTo && meta.replyTo.length > 0 && (
        <Field label={t('activities.detail.email.replyTo', 'Reply-To')}>
          <p className="space-y-0.5">
            {meta.replyTo.map((r, i) => (
              <span key={i} className="block">
                {r.name ? `${r.name} <${r.email}>` : r.email}
              </span>
            ))}
          </p>
        </Field>
      )}

      {/* Attachments — downloadable list resolved from the hub message link */}
      {data.externalProvider === 'office365_mail' && data.externalId && (
        <EmailAttachments externalMessageId={data.externalId} t={t} />
      )}

      {/* Body preview */}
      {data.notes && (
        <Field label={t('activities.detail.field.notes', 'Preview')}>
          <p className="whitespace-pre-wrap text-muted-foreground">{data.notes}</p>
        </Field>
      )}
    </div>
  )
}

type EmailAttachmentFile = { id: string; fileName: string; mimeType: string; fileSize: number; url: string }
type EmailAttachmentSkipped = { fileName: string; fileSizeBytes: number; status: string }

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function EmailAttachments({
  externalMessageId,
  t,
}: {
  externalMessageId: string
  t: (k: string, d: string) => string
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['o365-email-attachments', externalMessageId],
    queryFn: async () => {
      const r = await apiCall<{ files: EmailAttachmentFile[]; skipped: EmailAttachmentSkipped[] }>(
        `/api/channel_office365/channel_office365/email-attachments?externalMessageId=${encodeURIComponent(externalMessageId)}`,
      )
      return r.result ?? { files: [], skipped: [] }
    },
  })

  const files = data?.files ?? []
  const skipped = data?.skipped ?? []
  if (!isLoading && files.length === 0 && skipped.length === 0) return null

  const skippedLabel = (status: string): string => {
    if (status === 'too_large') return t('activities.detail.email.attachments.tooLarge', 'too large to sync')
    if (status === 'skipped_inline') return t('activities.detail.email.attachments.inline', 'inline image (skipped)')
    if (status === 'fetch_error') return t('activities.detail.email.attachments.fetchError', 'failed to download')
    return status
  }

  return (
    <Field label={t('activities.detail.email.attachments', 'Attachments')}>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('activities.detail.email.attachments.loading', 'Loading…')}</p>
      ) : (
        <div className="space-y-1.5">
          {files.map((f) => (
            <a
              key={f.id}
              href={f.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
            >
              <Paperclip className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 min-w-0 truncate">{f.fileName}</span>
              <span className="text-xs text-muted-foreground shrink-0">{formatBytes(f.fileSize)}</span>
              <Download className="size-4 shrink-0 text-muted-foreground" />
            </a>
          ))}
          {skipped.map((s, i) => (
            <div
              key={`skipped-${i}`}
              className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
            >
              <Paperclip className="size-4 shrink-0" />
              <span className="flex-1 min-w-0 truncate">{s.fileName}</span>
              <span className="text-xs shrink-0">{skippedLabel(s.status)}</span>
            </div>
          ))}
        </div>
      )}
    </Field>
  )
}

function GenericSection({ data, t }: { data: ActivityDetail; t: (k: string, d: string) => string }) {
  const dateValue = data.occurredAt ?? data.dueAt ?? null

  return (
    <div className="rounded-lg border p-5 space-y-4">
      <Field label={t('activities.detail.field.subject', 'Subject')}>
        <p className="font-medium">{data.subject?.trim() || t('activities.detail.subject.empty', '(no title)')}</p>
      </Field>

      {data.notes && (
        <Field label={t('activities.detail.field.notes', 'Notes')}>
          <p className="whitespace-pre-wrap text-muted-foreground">{data.notes}</p>
        </Field>
      )}

      {dateValue && (
        <Field label={data.occurredAt
          ? t('activities.detail.field.occurredAt', 'Date')
          : t('activities.detail.field.dueAt', 'Due date')}>
          <p>{new Date(dateValue).toLocaleString()}</p>
        </Field>
      )}

      {data.location && (
        <Field label={t('activities.detail.field.location', 'Location')}>
          <p>{data.location}</p>
        </Field>
      )}

      {data.participants && data.participants.length > 0 && (
        <Field label={t('activities.detail.field.participants', 'Participants')}>
          <ul className="space-y-0.5">
            {data.participants.map((p, i) => (
              <li key={i} className="text-sm">
                {p.name ? `${p.name} <${p.email}>` : p.email}
                {p.status && <span className="text-muted-foreground ml-1">({p.status})</span>}
              </li>
            ))}
          </ul>
        </Field>
      )}
    </div>
  )
}

export default function ActivityDetailPage({ params }: { params: { id: string } }) {
  const t = useT()
  const router = useRouter()
  const id = params?.id ?? ''

  const { data, isLoading, error } = useQuery({
    queryKey: ['activity', id],
    queryFn: async () => {
      const r = await apiCall<ActivityDetail>(`/api/activities/${id}`)
      if (!r.ok) throw new Error(r.status === 404 ? 'Activity not found' : 'Failed to load activity')
      return r.result
    },
    enabled: !!id,
  })

  const typeDef = data ? getActivityTypeById(data.activityType) : null
  const typeIcon = data ? (TYPE_ICONS[data.activityType] ?? null) : null
  const subjectDisplay = data?.subject?.trim() || t('activities.detail.title', 'Activity')

  return (
    <Page>
      <PageHeader
        title={data ? subjectDisplay : t('activities.detail.title', 'Activity')}
        actions={
          <Button variant="outline" size="sm" onClick={() => router.back()}>
            <ArrowLeft className="size-4 mr-1" />
            {t('activities.detail.back', 'Back')}
          </Button>
        }
      />
      <PageBody>
        {isLoading && (
          <p className="text-sm text-muted-foreground">{t('activities.detail.loading', 'Loading…')}</p>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <span>{t('activities.detail.error', 'Failed to load activity')}</span>
          </Alert>
        )}
        {data && (
          <div className="max-w-2xl space-y-6">
            {/* Type + status header */}
            <div className="flex items-center gap-2 text-muted-foreground">
              {typeIcon}
              <span className="text-xs uppercase tracking-wide">
                {typeDef ? t(typeDef.label, typeDef.id) : data.activityType}
              </span>
              <span className="text-xs">·</span>
              <span className="text-xs">{data.status}</span>
              {data.visibility === 'private' && (
                <span className="text-xs text-muted-foreground">(private)</span>
              )}
            </div>

            {/* Type-specific detail card */}
            {data.activityType === 'meeting' ? (
              <MeetingSection data={data} t={t} />
            ) : data.activityType === 'email' ? (
              <EmailSection data={data} t={t} />
            ) : (
              <GenericSection data={data} t={t} />
            )}

            {/* Sync info */}
            {(data.externalProvider ?? data.lastSyncedAt) && (
              <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t('activities.detail.sync.title', 'Sync info')}
                </p>
                {data.externalProvider && (
                  <p className="text-xs text-muted-foreground">
                    {t('activities.detail.sync.provider', 'Source')}: {data.externalProvider}
                    {data.sourceType && ` · ${data.sourceType}`}
                  </p>
                )}
                {data.lastSyncedAt && (
                  <p className="text-xs text-muted-foreground">
                    {t('activities.detail.sync.lastSynced', 'Last synced')}: {new Date(data.lastSyncedAt).toLocaleString()}
                  </p>
                )}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {t('activities.detail.created', 'Created')}: {new Date(data.createdAt).toLocaleString()}
              {' · '}
              {t('activities.detail.updated', 'Updated')}: {new Date(data.updatedAt).toLocaleString()}
            </p>
          </div>
        )}
      </PageBody>
    </Page>
  )
}
