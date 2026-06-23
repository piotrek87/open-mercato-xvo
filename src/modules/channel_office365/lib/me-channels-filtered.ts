import { O365_MAIL_PROVIDER_KEY } from './credentials'

/**
 * Wraps GET /api/communication_channels/me/channels to filter out the
 * office365_mail sibling channel. That channel is an implementation detail
 * managed via M365 settings — exposing it on the generic channels page lets
 * users accidentally delete it and break email sync.
 */
export async function GET(req: Request): Promise<Response> {
  const original = await import(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — deep import into core package; valid at runtime
    '@open-mercato/core/modules/communication_channels/api/get/me/channels/route'
  )
  const handler: (req: Request) => Promise<Response> = original.GET ?? original.default
  const res: Response = await handler(req)

  const data = (await res.json()) as { items: Array<{ providerKey: string }>; total: number }
  const items = (data.items ?? []).filter((c) => c.providerKey !== O365_MAIL_PROVIDER_KEY)

  return new Response(JSON.stringify({ ...data, items, total: items.length }), {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  })
}
