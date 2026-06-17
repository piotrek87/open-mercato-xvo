/**
 * Calendar Sync Worker — polls Microsoft 365 Calendar Delta API every 5 minutes.
 *
 * For each active CommunicationChannel with providerKey='office365':
 *   1. Resolve decrypted credentials via integrationCredentialsService
 *   2. Refresh access token if expiring (delegates to adapter.refreshCredentials)
 *   3. Call Graph Calendar Delta API (drainCalendarDelta)
 *   4. UPSERT Activity records (meeting type) — batch load + withAtomicFlush (no N+1)
 *   5. Update channel.channelState.capabilities.calendar with new delta cursor
 *
 * channelState backward compat:
 *   Sprint 4A-4C stored deltaToken at top level (flat structure).
 *   Sprint 5 stores it under capabilities.calendar.deltaToken (nested).
 *   This worker reads capabilities.calendar.deltaToken first and falls back
 *   to the legacy top-level deltaToken if capabilities are absent.
 *   On write, the new nested structure is always used — this self-migrates
 *   channels that haven't been through the SQL migration yet.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import type { FilterQuery } from '@mikro-orm/core'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { Activity } from '../../activities/data/entities'
import { drainCalendarDelta, GraphApiError, type GraphCalendarEvent } from '../lib/graph-client'
import { buildEmailCustomerMap, autoLinkActivityToCustomers } from '../lib/customer-linker'
import {
  o365UserCredentialsSchema,
  o365ChannelStateSchema,
  type O365ChannelState,
  O365_EXTERNAL_PROVIDER_CALENDAR,
  O365_INTEGRATION_ID,
  O365_PROVIDER_KEY,
} from '../lib/credentials'
import { getO365CalendarAdapter } from '../lib/adapter'

export type CalendarSyncJobPayload = {
  channelId?: string
}

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
  job: QueuedJob,
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

  const payload = (job.payload ?? {}) as CalendarSyncJobPayload
  const targetChannelId = typeof payload.channelId === 'string' ? payload.channelId : undefined

  const channelFilter: FilterQuery<CommunicationChannel> = {
    providerKey: O365_PROVIDER_KEY,
    isActive: true,
    deletedAt: null,
    ...(targetChannelId ? { id: targetChannelId } : {}),
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

  const rawChannelState = (channel.channelState as Record<string, unknown> | null) ?? {}
  const parsedState = o365ChannelStateSchema.safeParse(rawChannelState)
  const channelState: O365ChannelState = parsedState.success ? parsedState.data : {}

  if (channelState.capabilities?.calendar?.enabled === false) {
    console.info(`[channel_office365:calendar-sync] channel ${channel.id} — calendar disabled, skipping`)
    return
  }

  let rawCreds = await credentialsService.resolve(O365_INTEGRATION_ID, scope)
  if (!rawCreds) {
    console.warn(`[channel_office365:calendar-sync] no credentials for channel ${channel.id} — skipping`)
    return
  }

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
      const tenantClientRaw = await credentialsService.resolve(O365_INTEGRATION_ID, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        userId: null,
      })
      const oauthClient = tenantClientRaw as { clientId?: string; clientSecret?: string; tenantId?: string } | null
      if (oauthClient?.clientId && oauthClient?.clientSecret) {
        const refreshed = await adapter.refreshCredentials({
          channelId: channel.id,
          credentials: rawCreds,
          scope: { tenantId: scope.tenantId, organizationId: scope.organizationId },
          oauthClient: {
            clientId: oauthClient.clientId,
            clientSecret: oauthClient.clientSecret,
            ...(oauthClient.tenantId ? { tenantId: oauthClient.tenantId } : {}),
          },
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

  const calendarCap = channelState.capabilities?.calendar ?? {}
  const deltaToken = calendarCap.deltaToken ?? channelState.deltaToken
  const syncFromDate = typeof calendarCap.syncFromDate === 'string'
    ? new Date(calendarCap.syncFromDate)
    : undefined

  let events: GraphCalendarEvent[]
  let nextDeltaToken: string | undefined
  try {
    const result = await drainCalendarDelta(accessToken, deltaToken, syncFromDate)
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

  // Separate valid events from cancelled ones
  const validEvents = events.filter((e) => e.type !== 'seriesMaster' && !e.isCancelled)
  const cancelledExternalIds = events
    .filter((e) => e.type !== 'seriesMaster' && e.isCancelled)
    .map((e) => e.id)

  // Batch-load existing activities for all valid events (single query — no N+1)
  const validExternalIds = validEvents.map((e) => e.id)
  const existingActivities = validExternalIds.length > 0
    ? await em.find(Activity, {
        externalId: { $in: validExternalIds },
        externalProvider: O365_EXTERNAL_PROVIDER_CALENDAR,
        organizationId: scope.organizationId,
        deletedAt: null,
      })
    : []
  const existingMap = new Map(existingActivities.map((a) => [a.externalId, a]))

  // Batch-load activities to soft-delete
  const toDelete = cancelledExternalIds.length > 0
    ? await em.find(Activity, {
        externalId: { $in: cancelledExternalIds },
        externalProvider: O365_EXTERNAL_PROVIDER_CALENDAR,
        organizationId: scope.organizationId,
        deletedAt: null,
      })
    : []

  // Collect (entity, participants) pairs during the flush — IDs of new entities are
  // populated after withAtomicFlush returns (via RETURNING in the INSERT).
  const pendingLinks: Array<{
    entity: Activity
    participants: Array<{ email: string; name?: string; status: string }>
  }> = []

  // Apply all mutations in a single transaction — no em.flush() inside
  if (validEvents.length > 0 || toDelete.length > 0) {
    await withAtomicFlush(em, [
      () => {
        for (const event of validEvents) {
          const startDate = event.start?.dateTime ? new Date(event.start.dateTime) : null
          const endDate = event.end?.dateTime ? new Date(event.end.dateTime) : null
          const rawDuration =
            startDate && endDate
              ? Math.round((endDate.getTime() - startDate.getTime()) / 60_000)
              : null
          const durationMinutes = rawDuration !== null && rawDuration <= 1440 ? rawDuration : null

          // Organizer prepended to attendees list with status 'organizer'
          const organizerEntry = event.organizer?.emailAddress
            ? [{
                email: event.organizer.emailAddress.address,
                name: event.organizer.emailAddress.name ?? undefined,
                status: 'organizer',
              }]
            : []

          const attendeeEntries = (event.attendees ?? []).map((a) => ({
            email: a.emailAddress.address,
            name: a.emailAddress.name ?? undefined,
            status: mapAttendeeStatus(a.status.response),
          }))

          const participants = [...organizerEntry, ...attendeeEntries]

          const subject = event.subject?.trim() || '(no title)'
          const notes = event.bodyPreview?.trim() || null

          // Teams / online meeting metadata
          const teamsJoinUrl = event.isOnlineMeeting && event.onlineMeetingUrl
            ? event.onlineMeetingUrl
            : null
          const meetingMetadata: Record<string, unknown> = {}
          if (event.isOnlineMeeting !== undefined) meetingMetadata.isOnlineMeeting = event.isOnlineMeeting
          if (event.onlineMeetingProvider) meetingMetadata.onlineMeetingProvider = event.onlineMeetingProvider
          if (teamsJoinUrl) meetingMetadata.teamsJoinUrl = teamsJoinUrl
          if (event.webLink) meetingMetadata.webLink = event.webLink
          const metadata = Object.keys(meetingMetadata).length > 0 ? meetingMetadata : null

          const existing = existingMap.get(event.id)
          if (existing) {
            existing.subject = subject
            existing.notes = notes
            existing.dueAt = startDate
            existing.durationMinutes = durationMinutes
            existing.location = event.location?.displayName ?? null
            existing.allDay = event.isAllDay ?? false
            existing.participants = participants.length > 0 ? participants : null
            existing.metadata = metadata
            existing.lastSyncedAt = new Date()
            existing.updatedAt = new Date()
            pendingLinks.push({ entity: existing, participants })
          } else {
            const newActivity = em.create(Activity, {
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              activityType: 'meeting',
              lifecycleMode: 'task',
              subject,
              notes,
              status: 'not_started',
              dueAt: startDate,
              durationMinutes,
              location: event.location?.displayName ?? null,
              allDay: event.isAllDay ?? false,
              participants: participants.length > 0 ? participants : null,
              metadata,
              ownerUserId: channel.userId ?? null,
              visibility: 'private',
              externalId: event.id,
              externalProvider: O365_EXTERNAL_PROVIDER_CALENDAR,
              syncDirection: 'import',
              lastSyncedAt: new Date(),
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            })
            em.persist(newActivity)
            pendingLinks.push({ entity: newActivity, participants })
          }
        }

        for (const act of toDelete) {
          act.deletedAt = new Date()
        }
      },
    ], { transaction: true, label: 'channel_office365.calendar-sync' })
  }

  // Auto-link synced activities to CRM customers by matching participant emails.
  // Built once per channel sync; emailMap is discarded after this block.
  if (pendingLinks.length > 0) {
    const emailMap = await buildEmailCustomerMap(em, scope)
    if (emailMap.size > 0) {
      await autoLinkActivityToCustomers(
        em,
        pendingLinks.map(({ entity, participants }) => ({ activityId: entity.id, participants })),
        emailMap,
        scope,
      )
    }
  }

  // Propagate grantedScopes from credentials to channelState
  const rawGrantedScopes = Array.isArray(rawCreds.grantedScopes)
    ? rawCreds.grantedScopes as string[]
    : undefined

  // Persist new delta cursor — always write nested structure (self-migrates legacy flat state)
  if (nextDeltaToken || events.length > 0 || rawGrantedScopes) {
    const existingCaps = (rawChannelState.capabilities as Record<string, unknown> | undefined) ?? {}
    const existingCalCap = (existingCaps.calendar as Record<string, unknown> | undefined) ?? {}
    channel.channelState = {
      capabilities: {
        ...existingCaps,
        calendar: {
          ...existingCalCap,
          enabled: channelState.capabilities?.calendar?.enabled ?? true,
          ...(nextDeltaToken ? { deltaToken: nextDeltaToken } : {}),
          lastSyncedAt: new Date().toISOString(),
          bootstrapped: true,
        },
        mail: existingCaps.mail ?? { enabled: false },
      },
      ...(rawGrantedScopes
        ? { grantedScopes: rawGrantedScopes }
        : { grantedScopes: channelState.grantedScopes ?? [] }),
    }
    channel.lastPolledAt = new Date()
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
