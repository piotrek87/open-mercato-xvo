import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { o365ChannelStateSchema, o365UserCredentialsSchema, O365_PROVIDER_KEY, O365_INTEGRATION_ID } from '../../../lib/credentials'

type CredentialsServiceLike = {
  resolve: (integrationId: string, scope: { tenantId: string; organizationId: string; userId: string | null }) => Promise<unknown>
}

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['channel_office365.view'] },
}

/**
 * Returns M365-specific channel state for the current user's connected channels.
 * Used by the admin page to check grantedScopes and capability state without
 * decrypting user credentials.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()
  let credentialsService: CredentialsServiceLike | null = null
  try {
    credentialsService = container.resolve<CredentialsServiceLike>('integrationCredentialsService')
  } catch { /* optional — graceful degradation if not registered */ }

  const channels = await em.find(CommunicationChannel, {
    tenantId: auth.tenantId as string,
    userId: auth.sub as string,
    providerKey: O365_PROVIDER_KEY,
    deletedAt: null,
  })

  const items = await Promise.all(channels.map(async (channel) => {
    const parsed = o365ChannelStateSchema.safeParse(channel.channelState ?? {})
    const state = parsed.success ? parsed.data : {}
    let grantedScopes = state.grantedScopes ?? []
    const capabilities = state.capabilities ?? {
      calendar: { enabled: true },
      mail: { enabled: false },
    }

    // If grantedScopes is absent from channelState (e.g. before the first calendar sync
    // has run after a fresh OAuth connect), fall back to reading directly from credentials.
    if (grantedScopes.length === 0 && credentialsService) {
      try {
        const rawCreds = await credentialsService.resolve(O365_INTEGRATION_ID, {
          tenantId: auth.tenantId as string,
          organizationId: (auth as { orgId?: string | null }).orgId ?? auth.tenantId as string,
          userId: auth.sub as string,
        })
        const credParsed = o365UserCredentialsSchema.safeParse(rawCreds)
        if (credParsed.success) {
          const rawScopes = (credParsed.data as Record<string, unknown>).grantedScopes
          if (Array.isArray(rawScopes)) {
            grantedScopes = rawScopes as string[]
          }
        }
      } catch { /* non-fatal */ }
    }

    return {
      id: channel.id,
      grantedScopes,
      capabilities,
    }
  }))

  return NextResponse.json({ items })
}

const capabilityStateSchema = z.object({
  enabled: z.boolean().optional(),
  deltaToken: z.string().optional(),
  lastSyncedAt: z.string().optional(),
  bootstrapped: z.boolean().optional(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    GET: {
      summary: 'Get Microsoft 365 channel state (grantedScopes, capabilities) for the current user',
      tags: ['channel_office365'],
      responses: [
        {
          status: 200,
          description: 'Channel state items',
          schema: z.object({
            items: z.array(z.object({
              id: z.string().uuid(),
              grantedScopes: z.array(z.string()),
              capabilities: z.object({
                calendar: capabilityStateSchema.optional(),
                mail: capabilityStateSchema.optional(),
              }),
            })),
          }),
        },
        { status: 401, description: 'Unauthorized' },
      ],
    },
  },
}
