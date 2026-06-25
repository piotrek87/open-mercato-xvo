import { O365_PROVIDER_KEY } from './credentials'

/**
 * Wraps GET /api/communication_channels/me/channels.
 *
 * The O365 connection creates TWO channels: the calendar channel (providerKey 'office365') and the
 * mail channel (providerKey 'office365_mail'). The CRM "compose / reply" dialog builds its
 * "Send as" picker from this endpoint and lists EVERY connected channel — so the calendar channel
 * showed up as a send option even though it cannot send email (no sendMessage), confusing the user
 * with two near-identical entries.
 *
 * Default behavior: hide the O365 calendar channel from this list — it is not an email sender and
 * is managed from the Microsoft 365 settings page. The mail channel stays (compose needs it).
 * Our own surfaces that genuinely need the calendar channel (the M365 settings page, the connect
 * widget) pass `?includeCalendar=1` to get the unfiltered list.
 */
export async function GET(req: Request): Promise<Response> {
  const original = await import(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — deep import into core package; valid at runtime
    '@open-mercato/core/modules/communication_channels/api/get/me/channels/route'
  )
  const handler: (req: Request) => Promise<Response> = original.GET ?? original.default
  const res: Response = await handler(req)

  if (new URL(req.url).searchParams.get('includeCalendar') === '1') return res

  let data: { items?: Array<{ providerKey?: string }>; total?: number }
  try {
    data = await res.json()
  } catch {
    return res
  }
  const items = (data.items ?? []).filter((c) => c.providerKey !== O365_PROVIDER_KEY)
  return new Response(JSON.stringify({ ...data, items, total: items.length }), {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  })
}
