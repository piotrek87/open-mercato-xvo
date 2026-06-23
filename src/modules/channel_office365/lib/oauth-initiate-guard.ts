import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { O365_PROVIDER_KEY, O365_MAIL_PROVIDER_KEY } from './credentials'

/**
 * Wraps POST /api/communication_channels/oauth/[provider]/initiate.
 *
 * For non-office365 providers: delegates immediately to the framework handler.
 *
 * For office365:
 *  1. If user already has an active office365 channel → redirect to M365 settings
 *     (avoids mailbox_already_connected from the generic channels page).
 *  2. If not connected → soft-delete any stale office365_mail sibling channel
 *     (it shares the external email address; leaving it causes the OAuth callback
 *     to return mailbox_already_connected), then delegate to the framework handler.
 *
 * NOTE: Uses createRequestContainer + direct ORM query (not the me/channels route
 * handler) so tenant filtering works regardless of organizationId mismatches or
 * the me-channels-filtered route override that strips office365_mail from responses.
 */
export async function POST(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin

  // Extract provider from path: /api/communication_channels/oauth/{provider}/initiate
  const pathParts = new URL(req.url).pathname.split('/')
  const oauthIdx = pathParts.indexOf('oauth')
  const provider = oauthIdx >= 0 ? (pathParts[oauthIdx + 1] ?? '') : ''

  // Only guard office365 — pass through everything else unchanged
  if (provider !== O365_PROVIDER_KEY) {
    return delegateToFramework(req, provider)
  }

  try {
    const auth = await getAuthFromRequest(req)
    if (auth?.sub && auth?.tenantId) {
      const container = await createRequestContainer()
      const em = (container.resolve('em') as EntityManager).fork()
      const tenantId = auth.tenantId as string
      const userId = auth.sub as string

      // Find ALL non-deleted calendar channels (active or not) so we can clean
      // up inactive/stale records that me/channels hides but that would block OAuth.
      const [calendarChannels, emailChannels] = await Promise.all([
        em.find(CommunicationChannel, {
          tenantId,
          userId,
          providerKey: O365_PROVIDER_KEY,
          deletedAt: null,
        }),
        em.find(CommunicationChannel, {
          tenantId,
          userId,
          providerKey: O365_MAIL_PROVIDER_KEY,
          deletedAt: null,
        }),
      ])

      // Redirect to M365 settings only when there is a genuinely active + connected channel.
      const activeConnected = calendarChannels.find(
        (c) => c.isActive && c.status === 'connected',
      )
      if (activeConnected) {
        return NextResponse.json({ authorizeUrl: `${origin}/backend/profile/microsoft-365` })
      }

      // No active+connected channel — soft-delete all stale records (inactive, reauth,
      // error, disconnected) so the OAuth callback starts with a clean slate and won't
      // hit mailbox_already_connected on the email sibling.
      const now = new Date()
      const stale = [...calendarChannels, ...emailChannels]
      stale.forEach((c) => { c.deletedAt = now })
      if (stale.length > 0) await em.flush()
    }
  } catch {
    // Non-fatal — fall through to the original initiate handler
  }

  return delegateToFramework(req, O365_PROVIDER_KEY)
}

async function delegateToFramework(req: Request, provider: string): Promise<Response> {
  const original = await import(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — deep import into core package; valid at runtime
    '@open-mercato/core/modules/communication_channels/api/post/oauth/[provider]/initiate/route'
  )
  const handler: (req: Request, ctx: { params: Promise<{ provider: string }> }) => Promise<Response> =
    original.POST ?? original.default
  return handler(req, { params: Promise.resolve({ provider }) })
}
