'use client'

import * as React from 'react'
import { Mail } from 'lucide-react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { O365_MAIL_PROVIDER_KEY } from '../../../lib/credentials'
import { O365ComposeDialog, type O365ComposeChannel } from './O365ComposeDialog'

/** Read the person id + best-known recipient email from the injection context/data. */
function readPerson(context: unknown, data: unknown): { personId: string; email: string | null } | null {
  const c = (context ?? {}) as Record<string, unknown>
  const personId = typeof c.personId === 'string' && c.personId
    ? c.personId
    : (typeof c.resourceId === 'string' && c.resourceKind === 'person' ? c.resourceId : null)
  if (!personId) return null
  const d = (data ?? {}) as Record<string, unknown>
  const email =
    [d.primaryEmail, d.email, d.contactEmail, (c.data as Record<string, unknown> | undefined)?.primaryEmail]
      .find((v): v is string => typeof v === 'string' && v.includes('@')) ?? null
  return { personId, email }
}

/**
 * "New email" action on the person detail header. Opens our own O365 compose dialog (with
 * attachments) — the core ComposeEmailDialog stays untouched. Shown only when the operator has a
 * connected Microsoft 365 mail channel to send from.
 */
export default function O365ComposeTriggerWidget(
  { context, data }: InjectionWidgetComponentProps<Record<string, unknown>, Record<string, unknown>>,
) {
  const t = useT()
  const person = readPerson(context, data)
  const [open, setOpen] = React.useState(false)
  const [channels, setChannels] = React.useState<O365ComposeChannel[]>([])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await apiCall<{ items?: unknown[] }>(
          '/api/communication_channels/me/channels',
          { method: 'GET', headers: { 'x-om-forbidden-redirect': '0', 'x-om-unauthorized-redirect': '0' } },
        )
        const items = Array.isArray(res.result?.items) ? res.result!.items! : []
        const mail = items.filter((it) => {
          if (!it || typeof it !== 'object') return false
          const r = it as Record<string, unknown>
          return r.providerKey === O365_MAIL_PROVIDER_KEY && r.status === 'connected'
        }) as O365ComposeChannel[]
        if (!cancelled) setChannels(mail)
      } catch {
        if (!cancelled) setChannels([])
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (!person || channels.length === 0) return null

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Mail className="size-4" />
        {t('channel_office365.compose.newEmail', 'New email')}
      </Button>
      <O365ComposeDialog
        open={open}
        onOpenChange={setOpen}
        personId={person.personId}
        defaultRecipient={person.email}
        channels={channels}
      />
    </>
  )
}
