/**
 * Calendar Sync Worker — polls Office 365 Calendar Delta API every 5 minutes.
 *
 * For each active CommunicationChannel with providerKey='office365_calendar':
 *   1. Resolve decrypted credentials via integrationCredentialsService
 *   2. Refresh access token if expiring (delegates to adapter.refreshCredentials)
 *   3. Call Graph Calendar Delta API (drainCalendarDelta)
 *   4. UPSERT Activity records (meeting type) for each calendar event
 *   5. Update channel.channelState.deltaToken with the new delta cursor
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import type { FilterQuery } from '@mikro-orm/core'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { Activity } from '../../activities/data/entities'
import { drainCalendarDelta, GraphApiError, type GraphCalendarEvent } from '../lib/graph-client'
import { o365UserCredentialsSchema, O365_EXTERNAL_PROVIDER, O365_INTEGRATION_ID, O365_PROVIDER_KEY } from '../lib/credentials'
import { getO365CalendarAdapter } from '../lib/adapter'

export const metadata: WorkerMeta = {
  queue: 'channel-office365-calendar-sync',
  id: 'channel_office365:calendar-sync',
  concurrency: 3,
}

type CredentialsServiceLike = {
  resolve: (
    integrationId: string,
    scope: { tenantId: string; organizationId: string; userId?: string | null },
  ) => Promise<Record<string, unknown> | null>
  save?: (
    integrationId: string,
    credentials: Record<string, unknown>,
    scope: { tenantId: string; organizationId: string; userId?: string | null },
  ) => Promise<void>
}

type HandlerCtx = JobContext & { resolve: <T = unknown>(name: string) => T }

export default async function handle(
  _job: QueuedJob,
  ctx: HandlerCtx,
): Promise<void> {
  const em = (ctx.resolve('em') as EntityManager).fork()

  let credentialsService: CredentialsServiceLike | null = null
  try {
    credentialsService = ctx.resolve<CredentialsServiceLike>('integrationCredentialsService')
  } catch {
    console.warn('[channel_office365:calendar-sync] integrationCredentialsService not available — skipping')
    return
  }

  const channelFilter: FilterQuery<CommunicationChannel> = {
    providerKey: O365_PROVIDER_KEY,
    isActive: true,
    deletedAt: null,
  }
  const channels = await em.find(CommunicationChannel, channelFilter)

  const activeChannels = channels.filter((c) => c.status === 'connected' || c.status === 'error')
  if (activeChannels.length === 0) return

  const adapter = getO365CalendarAdapter()

  for (const channel of activeChannels) {
    try {
      await syncChannel(channel, em, credentialsService, adapter)
    } catch (err) {
      console.error(
        `[channel_office365:calendar-sync] channel ${channel.id} failed:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

async function syncChannel(
  channel: CommunicationChannel,
  em: EntityManager,
  credentialsService: CredentialsServiceLike,
  adapter: ReturnType<typeof getO365CalendarAdapter>,
): Promise<void> {
  const scope = {
    tenantId: channel.tenantId,
    organizationId: channel.organizationId ?? channel.tenantId,
    userId: channel.userId ?? null,
  }

  let rawCreds = await credentialsService.resolve(O365_INTEGRATION_ID, scope)
  if (!rawCreds) {
    console.warn(`[channel_office365:calendar-sync] no credentials for channel ${channel.id} — skipping`)
    return
  }

  // Refresh token if needed (within 60-second expiry window)
  const parsed = o365UserCredentialsSchema.safeParse(rawCreds)
  if (!parsed.success) {
    console.warn(`[channel_office365:calendar-sync] invalid credentials for channel ${channel.id} — skipping`)
    return
  }
  const creds = parsed.data
  const expiresAt = creds.expiresAt ? new Date(creds.expiresAt) : null
  const needsRefresh = expiresAt && (expiresAt.getTime() - Date.now()) < 60_000
  if (needsRefresh && creds.refreshToken) {
    try {
      // Resolve tenant-level OAuth client config
      const tenantClientRaw = await credentialsService.resolve(O365_INTEGRATION_ID, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        userId: null,
      })
      const oauthClient = tenantClientRaw as { clientId?: string; clientSecret?: string } | null
      if (oauthClient?.clientId && oauthClient?.clientSecret) {
        const refreshed = await adapter.refreshCredentials({
          channelId: channel.id,
          credentials: rawCreds,
          scope: { tenantId: scope.tenantId, organizationId: scope.organizationId },
          oauthClient: { clientId: oauthClient.clientId, clientSecret: oauthClient.clientSecret },
        })
        rawCreds = refreshed.credentials
        if (credentialsService.save) {
          await credentialsService.save(O365_INTEGRATION_ID, rawCreds, scope)
        }
      }
    } catch (refreshErr) {
      console.warn(
        `[channel_office365:calendar-sync] token refresh failed for channel ${channel.id}:`,
        refreshErr instanceof Error ? refreshErr.message : refreshErr,
      )
      if (refreshErr instanceof Error && refreshErr.message === 'requires_reauth') {
        channel.status = 'requires_reauth' as typeof channel.status
        await em.flush()
        return
      }
    }
  }

  const accessToken = (rawCreds.accessToken as string | undefined) ?? ''
  if (!accessToken) return

  const channelState = (channel.channelState as Record<string, unknown> | null) ?? {}
  const deltaToken = typeof channelState.deltaToken === 'string' ? channelState.deltaToken : undefined

  let events: GraphCalendarEvent[]
  let nextDeltaToken: string | undefined
  try {
    const result = await drainCalendarDelta(accessToken, deltaToken)
    events = result.events
    nextDeltaToken = result.nextDeltaToken
  } catch (err) {
    if (err instanceof GraphApiError && err.status === 401) {
      channel.status = 'requires_reauth' as typeof channel.status
      await em.flush()
      return
    }
    throw err
  }

  // UPSERT Activities for each calendar event
  for (const event of events) {
    if (event.isCancelled) continue
    await upsertActivity(event, channel, em, scope)
  }

  // Persist new delta cursor
  if (nextDeltaToken) {
    channel.channelState = {
      ...channelState,
      deltaToken: nextDeltaToken,
      lastSyncedAt: new Date().toISOString(),
      bootstrapped: true,
    }
    channel.lastPolledAt = new Date()
    await em.flush()
  } else if (events.length > 0) {
    channel.lastPolledAt = new Date()
    await em.flush()
  }
}

async function upsertActivity(
  event: GraphCalendarEvent,
  channel: CommunicationChannel,
  em: EntityManager,
  scope: { tenantId: string; organizationId: string; userId?: string | null },
): Promise<void> {
  const existing = await em.findOne(Activity, {
    externalId: event.id,
    externalProvider: O365_EXTERNAL_PROVIDER,
    organizationId: scope.organizationId,
    deletedAt: null,
  })

  const startDate = event.start?.dateTime ? new Date(event.start.dateTime) : null
  const endDate = event.end?.dateTime ? new Date(event.end.dateTime) : null
  const durationMinutes =
    startDate && endDate
      ? Math.round((endDate.getTime() - startDate.getTime()) / 60_000)
      : null

  const participants = (event.attendees ?? []).map((a) => ({
    email: a.emailAddress.address,
    name: a.emailAddress.name ?? undefined,
    status: mapAttendeeStatus(a.status.response),
  }))

  const subject = event.subject?.trim() || '(no title)'

  if (existing) {
    existing.subject = subject
    existing.dueAt = startDate
    existing.durationMinutes = durationMinutes
    existing.location = event.location?.displayName ?? null
    existing.allDay = event.isAllDay ?? false
    existing.participants = participants.length > 0 ? participants : null
    existing.lastSyncedAt = new Date()
    existing.updatedAt = new Date()
    await em.flush()
  } else {
    const activity = em.create(Activity, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      activityType: 'meeting',
      lifecycleMode: 'task',
      subject,
      status: 'not_started',
      dueAt: startDate,
      durationMinutes,
      location: event.location?.displayName ?? null,
      allDay: event.isAllDay ?? false,
      participants: participants.length > 0 ? participants : null,
      ownerUserId: channel.userId ?? null,
      visibility: 'team',
      externalId: event.id,
      externalProvider: O365_EXTERNAL_PROVIDER,
      syncDirection: 'import',
      lastSyncedAt: new Date(),
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    em.persist(activity)
    await em.flush()
  }
}

function mapAttendeeStatus(response: string): string {
  switch (response?.toLowerCase()) {
    case 'accepted': return 'accepted'
    case 'declined': return 'declined'
    case 'tentativelyaccepted': return 'tentative'
    default: return 'pending'
  }
}
