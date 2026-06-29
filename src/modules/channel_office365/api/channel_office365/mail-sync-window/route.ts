import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { O365_MAIL_PROVIDER_KEY } from '../../../lib/credentials'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['channel_office365.manage'] },
}

const bodySchema = z
  .object({
    sinceDate: z.string().datetime().optional(),
    sinceDays: z.number().int().min(1).max(3650).optional(),
  })
  .refine((b) => b.sinceDate || typeof b.sinceDays === 'number', {
    message: 'sinceDate or sinceDays is required',
  })

/**
 * POST /api/channel_office365/channel_office365/mail-sync-window
 *
 * Rewinds the email channel's sync cursor to bootstrap from a chosen date, then
 * leaves it to the reliable poll path (poll-now) to drain the window. This is the
 * robust replacement for the fragile bulk "import history" worker: the regular
 * poll has no user-facing progress job (so no "stale" abort), drains the whole
 * window in one background run, and is idempotent (ingest dedupes by external
 * message id), so re-syncing an overlapping range is safe.
 *
 * Drops the incremental watermark (`lastReceivedDateTime`) and any per-folder
 * delta so `fetchHistory` re-bootstraps from `syncFromDate`. Preserves `settings`
 * (e.g. `syncAttachments`) across the rewind.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const raw = await request.json().catch(() => ({})) as unknown
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 })
  }

  const sinceIso = parsed.data.sinceDate
    ? new Date(parsed.data.sinceDate).toISOString()
    : new Date(Date.now() - (parsed.data.sinceDays as number) * 24 * 60 * 60 * 1000).toISOString()
  if (Number.isNaN(new Date(sinceIso).getTime())) {
    return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
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
    return NextResponse.json(
      { error: 'no_email_channel', message: 'Email channel not provisioned' },
      { status: 404 },
    )
  }

  const prev = (channel.channelState as Record<string, unknown> | null) ?? {}
  const settings = prev.settings
  // Rebuild channel_state from scratch (no watermark/delta) so the next poll
  // re-drains from the chosen date; keep `settings` so syncAttachments survives.
  channel.channelState = {
    ...(settings !== undefined ? { settings } : {}),
    syncFromDate: sinceIso,
  }
  // Ensure the channel is pollable (clear a prior transient error so poll-now runs).
  channel.isActive = true
  if (channel.status !== 'connected') {
    channel.status = 'connected' as typeof channel.status
    channel.lastError = null
  }
  await em.flush()

  return NextResponse.json({ channelId: channel.id, syncFromDate: sinceIso })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    POST: {
      summary: 'Rewind the Microsoft 365 email sync window to a chosen date (reliable poll backfill)',
      tags: ['channel_office365'],
      responses: [
        { status: 200, description: 'Window rewound', schema: z.object({ channelId: z.string(), syncFromDate: z.string() }) },
        { status: 400, description: 'Invalid body/date' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Email channel not provisioned' },
      ],
    },
  },
}
