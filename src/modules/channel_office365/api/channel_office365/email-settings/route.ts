import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { O365_MAIL_PROVIDER_KEY } from '../../../lib/credentials'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['channel_office365.view'] },
  PATCH: { requireAuth: true, requireFeatures: ['channel_office365.manage'] },
}

const emailSettingsSchema = z.object({
  syncAttachments: z.boolean().optional(),
  maxAttachmentSizeMb: z.number().int().min(1).max(25).optional(),
  syncInlineImages: z.boolean().optional(),
})

type EmailSettings = z.infer<typeof emailSettingsSchema>

function readSettings(channelState: Record<string, unknown> | null | undefined): EmailSettings {
  const raw = (channelState?.settings ?? {}) as Record<string, unknown>
  return {
    syncAttachments: typeof raw.syncAttachments === 'boolean' ? raw.syncAttachments : false,
    maxAttachmentSizeMb: typeof raw.maxAttachmentSizeMb === 'number' ? raw.maxAttachmentSizeMb : 10,
    syncInlineImages: typeof raw.syncInlineImages === 'boolean' ? raw.syncInlineImages : false,
  }
}

/**
 * GET /api/channel_office365/channel_office365/email-settings
 * Returns attachment sync settings for the current user's email channel (office365_mail).
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()

  const channel = await em.findOne(CommunicationChannel, {
    tenantId: auth.tenantId as string,
    userId: auth.sub as string,
    providerKey: O365_MAIL_PROVIDER_KEY,
    deletedAt: null,
  })

  if (!channel) {
    return NextResponse.json({ settings: null })
  }

  return NextResponse.json({ settings: readSettings(channel.channelState) })
}

/**
 * PATCH /api/channel_office365/channel_office365/email-settings
 * Updates attachment sync settings on the email channel.
 */
export async function PATCH(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({})) as unknown
  const parsed = emailSettingsSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()

  const channel = await em.findOne(CommunicationChannel, {
    tenantId: auth.tenantId as string,
    userId: auth.sub as string,
    providerKey: O365_MAIL_PROVIDER_KEY,
    deletedAt: null,
  })

  if (!channel) {
    return NextResponse.json({ error: 'no_email_channel', message: 'Email channel not provisioned' }, { status: 404 })
  }

  const existing = readSettings(channel.channelState)
  const next: EmailSettings = { ...existing, ...parsed.data }

  const newChannelState = {
    ...(channel.channelState ?? {}),
    settings: next,
  }

  await em.nativeUpdate(
    CommunicationChannel,
    { id: channel.id },
    { channelState: newChannelState },
  )

  return NextResponse.json({ settings: next })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    GET: {
      summary: 'Get email channel attachment-sync settings',
      tags: ['channel_office365'],
      responses: [
        { status: 200, description: 'Current settings', schema: z.object({ settings: emailSettingsSchema.nullable() }) },
        { status: 401, description: 'Unauthorized' },
      ],
    },
    PATCH: {
      summary: 'Update email channel attachment-sync settings',
      tags: ['channel_office365'],
      responses: [
        { status: 200, description: 'Updated settings', schema: z.object({ settings: emailSettingsSchema }) },
        { status: 400, description: 'Invalid body' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Email channel not provisioned' },
      ],
    },
  },
}
