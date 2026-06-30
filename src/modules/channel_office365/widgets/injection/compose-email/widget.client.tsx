'use client'

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { O365PersonEmailThreadsTab } from './O365PersonEmailThreadsTab'

/** Read the person id + best-known recipient email from the injection context/data. */
function readPerson(context: unknown, data: unknown): { personId: string; email: string | null } | null {
  const c = (context ?? {}) as Record<string, unknown>
  const personId = typeof c.personId === 'string' && c.personId
    ? c.personId
    : (typeof c.resourceId === 'string' && c.resourceKind === 'person' ? c.resourceId : null)
  if (!personId) return null
  const d = (data ?? {}) as Record<string, unknown>
  const person = (d.person ?? {}) as Record<string, unknown>
  const email =
    [person.primaryEmail, d.primaryEmail, d.email, d.contactEmail]
      .find((v): v is string => typeof v === 'string' && v.includes('@')) ?? null
  return { personId, email }
}

/**
 * Our O365 "E-maile" tab on the person detail. Replaces the built-in emails tab (which is hidden by
 * the `hide-core-emails-tab` widget) so the conversation list + compose/reply use OUR attachment-capable
 * dialog. See `O365PersonEmailThreadsTab` for the why and the upgrade note.
 */
export default function O365EmailsTabWidget(
  { context, data }: InjectionWidgetComponentProps<Record<string, unknown>, Record<string, unknown>>,
) {
  const person = readPerson(context, data)
  if (!person) return null
  return <O365PersonEmailThreadsTab personId={person.personId} defaultRecipient={person.email} />
}
