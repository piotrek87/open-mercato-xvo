/**
 * TEST-ONLY channel seeding for O365 integration tests.
 *
 * Gated by `OM_ENABLE_TEST_CHANNEL_SEEDING` — same flag as the hub's test-seed.
 * Returns 404 in production. Never set the flag outside dev/CI.
 *
 * Actions:
 *   connect-office365   — inserts a fake office365 calendar channel + office365_mail
 *                         email channel for the current user (no real OAuth needed).
 *                         Sets channelState.capabilities.mail.enabled = true so the
 *                         settings page shows the full email-enabled UI.
 *   cleanup             — hard-deletes test channels created by connect-office365
 *                         for the current user (safe to call in afterEach).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { isTestChannelSeedingEnabled } from '@open-mercato/core/modules/communication_channels/lib/test-seed'
import { O365_PROVIDER_KEY, O365_MAIL_PROVIDER_KEY } from '../../../lib/credentials'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['channel_office365.view'] },
}

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect-office365') }),
  z.object({ action: z.literal('cleanup') }),
])

export async function POST(request: Request): Promise<Response> {
  if (!isTestChannelSeedingEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!body.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 422 })
  }

  const tenantId = auth.tenantId as string
  const organizationId = (auth as { orgId?: string | null }).orgId ?? null
  const userId = auth.sub as string

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()

  if (body.data.action === 'cleanup') {
    // Hard-delete all test O365 channels for this user (by external_identifier prefix)
    await em.getConnection().execute(
      `DELETE FROM communication_channels
       WHERE user_id = ? AND tenant_id = ?
         AND provider_key IN (?, ?)
         AND external_identifier LIKE '__test_o365_%'`,
      [userId, tenantId, O365_PROVIDER_KEY, O365_MAIL_PROVIDER_KEY],
    )
    return NextResponse.json({ cleaned: true })
  }

  // action === 'connect-office365'
  const stamp = Date.now()
  const fakeIdentifier = `__test_o365_${stamp}@test.local`
  const calendarChannelId = randomUUID()
  const emailChannelId = randomUUID()

  // Insert calendar channel (office365)
  await em.getConnection().execute(
    `INSERT INTO communication_channels
       (id, provider_key, channel_type, display_name, external_identifier,
        is_active, user_id, status, channel_state, tenant_id, organization_id,
        created_at, updated_at)
     VALUES (?, ?, 'calendar', ?, ?, true, ?, 'connected',
       ?::jsonb, ?, ?, now(), now())`,
    [
      calendarChannelId,
      O365_PROVIDER_KEY,
      `Test M365 Calendar ${stamp}`,
      fakeIdentifier,
      userId,
      JSON.stringify({
        grantedScopes: ['Calendars.ReadWrite', 'Mail.ReadWrite', 'User.Read', 'offline_access'],
        capabilities: {
          calendar: { enabled: true, bootstrapped: true, lastSyncedAt: new Date().toISOString() },
          mail: { enabled: true, bootstrapped: true, lastSyncedAt: new Date().toISOString() },
        },
      }),
      tenantId,
      organizationId,
    ],
  )

  // Insert email channel (office365_mail) with mail.enabled = true
  await em.getConnection().execute(
    `INSERT INTO communication_channels
       (id, provider_key, channel_type, display_name, external_identifier,
        is_active, user_id, status, channel_state, tenant_id, organization_id,
        created_at, updated_at)
     VALUES (?, ?, 'email', ?, ?, true, ?, 'connected',
       ?::jsonb, ?, ?, now(), now())`,
    [
      emailChannelId,
      O365_MAIL_PROVIDER_KEY,
      `Test M365 Email ${stamp}`,
      fakeIdentifier,
      userId,
      JSON.stringify({
        capabilities: { mail: { enabled: true } },
        settings: { syncAttachments: false, maxAttachmentSizeMb: 10 },
      }),
      tenantId,
      organizationId,
    ],
  )

  return NextResponse.json(
    { calendarChannelId, emailChannelId, externalIdentifier: fakeIdentifier },
    { status: 201 },
  )
}

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    POST: {
      summary: 'Test-only: seed O365 channels without OAuth (env-gated)',
      tags: ['channel_office365'],
      responses: [
        { status: 201, description: 'Channels seeded' },
        { status: 404, description: 'Test seeding disabled' },
      ],
    },
  },
}
