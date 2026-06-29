'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownLeft, ArrowUpRight, Download, Paperclip } from 'lucide-react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { EmptyState } from '@open-mercato/ui/backend/EmptyState'
import { LoadingMessage } from '@open-mercato/ui/backend/detail'

type AttachmentFile = { id: string; fileName: string; mimeType: string; fileSize: number; url: string }
type AttachmentGroup = {
  externalMessageId: string | null
  linkId: string
  subject: string | null
  occurredAt: string | null
  direction: string | null
  files: AttachmentFile[]
}
type AttachmentsResponse = { groups: AttachmentGroup[]; totalFiles: number; emailsWithAttachments: number }

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Resolve the scope (person/company) the detail page is rendering. */
function readScope(context: unknown): { param: 'personId' | 'companyId'; id: string } | null {
  const c = (context ?? {}) as Record<string, unknown>
  if (typeof c.personId === 'string' && c.personId) return { param: 'personId', id: c.personId }
  if (typeof c.companyId === 'string' && c.companyId) return { param: 'companyId', id: c.companyId }
  return null
}

/**
 * "Email attachments" tab on the customer (person/company) detail. Lists every
 * synced Microsoft 365 email that carries a downloadable attachment, grouped per
 * email, newest first. Reuses the shared email-attachments endpoint
 * (entity-scoped + visibility-filtered server-side). Shown as a dedicated tab so
 * it is discoverable next to "E-maile"; renders an empty state when the contact
 * has no email attachments.
 */
export default function EmailAttachmentsSectionWidget(
  { context }: InjectionWidgetComponentProps<Record<string, unknown>, Record<string, unknown>>,
) {
  const t = useT()
  const scope = readScope(context)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['channel_office365.email-attachments', scope?.param, scope?.id],
    enabled: !!scope,
    staleTime: 30_000,
    queryFn: async () => {
      const r = await apiCall<AttachmentsResponse>(
        `/api/channel_office365/channel_office365/email-attachments?${scope!.param}=${encodeURIComponent(scope!.id)}`,
      )
      return r.result ?? { groups: [], totalFiles: 0, emailsWithAttachments: 0 }
    },
  })

  if (!scope) return null

  if (isLoading) {
    return <LoadingMessage label={t('channel_office365.attachments.section.loading', 'Loading attachments…')} />
  }

  const groups = data?.groups ?? []
  const totalFiles = data?.totalFiles ?? 0

  if (isError || totalFiles === 0) {
    return (
      <EmptyState
        icon={<Paperclip className="h-6 w-6" />}
        title={t('channel_office365.attachments.section.emptyTitle', 'No email attachments')}
        description={t(
          'channel_office365.attachments.section.emptyDescription',
          'Attachments from this contact’s synced emails will appear here.',
        )}
      />
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('channel_office365.attachments.section.summary', '{files} attachment(s) across {emails} email(s)', {
          files: totalFiles,
          emails: groups.length,
        })}
      </p>
      {groups.map((group) => (
        <div key={group.linkId} className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {group.direction === 'outbound' ? (
              <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <ArrowDownLeft className="size-3.5 shrink-0" aria-hidden />
            )}
            <span className="truncate font-medium text-foreground">
              {group.subject || t('channel_office365.attachments.section.noSubject', '(no subject)')}
            </span>
            {group.occurredAt ? <span className="shrink-0">· {formatDate(group.occurredAt)}</span> : null}
          </div>
          <div className="space-y-1.5">
            {group.files.map((f) => (
              <a
                key={f.id}
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/50"
              >
                <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{f.fileName}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.fileSize)}</span>
                <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
