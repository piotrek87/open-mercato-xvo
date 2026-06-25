import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { O365_MAIL_PROVIDER_KEY } from './credentials'

/**
 * Guards DELETE /api/communication_channels/channels/[id].
 *
 * The office365_mail channel is now visible on the generic channels list (so the CRM compose/reply
 * dialog can pick it as the send channel), but it is an implementation detail of the Microsoft 365
 * connection — deleting it from the generic list would break email sync. Block such a delete and
 * point the user at the "Disconnect" button on the Microsoft 365 settings page, which removes the
 * whole connection (calendar + mail) cleanly. All other channels delegate to the core handler.
 */
export async function DELETE(req: Request): Promise<Response> {
  const { translate } = await resolveTranslations()
  const match = new URL(req.url).pathname.match(/\/channels\/([^/?#]+)/)
  const id = match?.[1]

  if (id) {
    try {
      const auth = await getAuthFromRequest(req)
      if (auth?.tenantId) {
        const container = await createRequestContainer()
        const em = (container.resolve('em') as EntityManager).fork()
        const channel = await em.findOne(CommunicationChannel, {
          id,
          tenantId: auth.tenantId as string,
          deletedAt: null,
        })
        if (channel?.providerKey === O365_MAIL_PROVIDER_KEY) {
          return NextResponse.json(
            {
              error: translate(
                'channel_office365.errors.mailChannelDeleteBlocked',
                'Tym kanałem zarządzasz w ustawieniach Microsoft 365. Aby go usunąć, użyj przycisku „Rozłącz" na stronie Microsoft 365.',
              ),
            },
            { status: 409 },
          )
        }
      }
    } catch {
      /* fall through to the core handler on any lookup error */
    }
  }

  const original = await import(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — deep import into core package; valid at runtime
    '@open-mercato/core/modules/communication_channels/api/delete/channels/[id]/route'
  )
  const handler: (req: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> =
    original.DELETE ?? original.default
  return handler(req, { params: Promise.resolve({ id: id ?? '' }) })
}
