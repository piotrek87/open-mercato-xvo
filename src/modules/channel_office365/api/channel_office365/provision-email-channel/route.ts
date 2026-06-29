import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { provisionEmailChannel } from '../../../lib/email-channel-provisioner'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['channel_office365.manage'] },
}

/**
 * POST /api/channel_office365/channel_office365/provision-email-channel
 *
 * Creates or updates the email channel (providerKey='office365_mail') for the
 * current user by copying credentials from their existing O365 calendar channel.
 *
 * Idempotent — safe to call multiple times. Called by the settings page after
 * OAuth callback (flash=connected) to auto-provision the email channel without
 * requiring a second OAuth flow.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()

  const scope = {
    tenantId: auth.tenantId as string,
    // Use auth.orgId (same field used by poll-now and me/channels) so the stored
    // organizationId matches what other routes expect when looking up this channel.
    organizationId: (auth as { orgId?: string | null }).orgId ?? null,
  }

  let result
  try {
    result = await provisionEmailChannel({
      em,
      userId: auth.sub as string,
      scope,
    })
  } catch (err) {
    console.error('[channel_office365] provision-email-channel error:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'provision_failed', message: 'Failed to provision email channel' },
      { status: 500 },
    )
  }

  if (!result) {
    return NextResponse.json(
      { error: 'no_calendar_channel', message: 'No Microsoft 365 calendar channel found. Connect M365 first.' },
      { status: 422 },
    )
  }

  // NOTE: we intentionally do NOT delete the channel_office365_mail credential row here anymore.
  // The calendar-sync worker mirrors the freshly-refreshed OAuth token into the
  // channel_office365_mail integration scope on every run, so the hub mail poll resolves a
  // DIRECT, always-fresh credential row (no reliance on the bundleId fallback, which needs the
  // integration registry loaded in the poll-channel worker process — not guaranteed). Deleting
  // the row here would race with that mirror and reintroduce the "accessToken undefined" error.

  return NextResponse.json({
    channelId: result.channelId,
    created: result.created,
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    POST: {
      summary: 'Provision email channel (office365_mail) from existing O365 calendar channel credentials',
      tags: ['channel_office365'],
      responses: [
        {
          status: 200,
          description: 'Email channel created or updated',
          schema: z.object({
            channelId: z.string().uuid(),
            created: z.boolean(),
          }),
        },
        { status: 401, description: 'Unauthorized' },
        { status: 422, description: 'No calendar channel found — M365 not connected' },
      ],
    },
  },
}
