/**
 * Calendar Sync Worker — polls Microsoft 365 Calendar Delta API every 5 minutes.
 *
 * For each active CommunicationChannel with providerKey='office365':
 *   1. Resolve decrypted credentials via integrationCredentialsService
 *   2. Refresh access token if expiring (delegates to adapter.refreshCredentials)
 *   3. Call Graph Calendar Delta API (drainCalendarDelta)
 *   4. UPSERT Activity records (meeting type) — batch load + withAtomicFlush (no N+1)
 *   5. Write/update external_sync_registry rows (Sprint 8A)
 *   6. Update channel.channelState.capabilities.calendar with new delta cursor
 *
 * Sprint 8A additions:
 *   - Ping-pong prevention: events whose changeKey matches registry.etag AND
 *     registry.lastSyncedFrom='om' are skipped (our own outbound write echoed back)
 *   - registry rows written/updated after each inbound upsert
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
import { ExternalSyncRegistry } from '../data/entities'
import { drainCalendarDelta, GraphApiError, type GraphCalendarEvent } from '../lib/graph-client'
import { buildEmailCustomerMap, autoLinkActivityToCustomers } from '../lib/customer-linker'
import {
  o365UserCredentialsSchema,
  o365ChannelStateSchema,
  type O365ChannelState,
  O365_EXTERNAL_PROVIDER_CALENDAR,
  O365_INTEGRATION_ID,
  O365_PROVIDER_KEY,
  O365_MAIL_PROVIDER_KEY,
} from '../lib/credentials'
import { getO365CalendarAdapter } from '../lib/adapter'
import {
  SYNC_PROVIDER_O365,
  SYNC_TYPE_CALENDAR_EVENT,
  SYNC_ENTITY_ACTIVITY,
} from '../lib/sync-types'

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

export async function syncChannel(
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

  // Resolve + refresh the shared OAuth token FIRST — BEFORE the calendar-capability gate.
  // The email channel (office365_mail) has no refreshCredentials of its own; it delegates
  // token refresh to THIS worker via the bundleId credential fallback
  // (channel_office365_mail → channel_office365). So whenever this channel is active we must
  // keep the access token fresh here, even if ONLY mail sync (not calendar) is enabled.
  // Gating refresh behind the calendar capability is what made email "work for an hour then
  // break": with calendar off, nobody refreshed the shared token, it expired after ~1h, and
  // the mail poll had no way to recover.
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
  // Refresh window (10 min) MUST exceed the 5-min sync schedule interval so the token is
  // always refreshed proactively before expiry. A tight 60s window could let the token
  // expire between two scheduled runs — fatal for email, which cannot self-refresh.
  const REFRESH_WINDOW_MS = 10 * 60_000
  const needsRefresh = expiresAt && (expiresAt.getTime() - Date.now()) < REFRESH_WINDOW_MS
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

  // Mirror the (possibly-refreshed) credentials into the email channel's integration scope.
  // The hub mail poll (poll-channel worker) resolves `channel_office365_mail`; give it a DIRECT,
  // always-fresh credential row here instead of relying on the bundleId fallback — that fallback
  // needs the integration registry (registered in channel_office365/setup.ts) loaded in the
  // poll-channel worker process, which is NOT guaranteed and yields `accessToken undefined`.
  // calendar-sync is the SOLE token refresher (the mail adapter has no refreshCredentials), so
  // writing the mail row here introduces no rotating-refresh-token race.
  if (credentialsService.save && (rawCreds.accessToken as string | undefined)) {
    try {
      await credentialsService.save(`channel_${O365_MAIL_PROVIDER_KEY}`, rawCreds, scope)

      // The mail channel has no self-refresh: when its access token expired (e.g. the server
      // was offline overnight) the hub poll marked it `requires_reauth` and emitted a reauth
      // notification. We just refreshed + mirrored a VALID token into its scope, so the channel
      // is healthy again — but nothing else clears that flag, leaving mail sync stuck and the
      // user staring at a stale "requires re-auth" warning. Heal it here: flip any
      // requires_reauth/error mail channel for this user back to connected so the hub resumes
      // polling on the next tick.
      const mailChannels = await em.find(CommunicationChannel, {
        providerKey: O365_MAIL_PROVIDER_KEY,
        isActive: true,
        deletedAt: null,
        ...(channel.userId ? { userId: channel.userId } : {}),
        ...(channel.organizationId ? { organizationId: channel.organizationId } : {}),
      })
      const healed = mailChannels.filter(
        (mc) => mc.status === 'requires_reauth' || mc.status === 'error',
      )
      if (healed.length > 0) {
        for (const mc of healed) {
          mc.status = 'connected' as typeof mc.status
          mc.lastError = null
        }
        await em.flush()
        console.info(
          `[channel_office365:calendar-sync] healed ${healed.length} mail channel(s) from requires_reauth → connected after token refresh`,
        )
      }
    } catch (mirrorErr) {
      console.warn(
        `[channel_office365:calendar-sync] mirror creds to mail scope failed for channel ${channel.id}:`,
        mirrorErr instanceof Error ? mirrorErr.message : mirrorErr,
      )
    }
  }

  // Calendar EVENT sync runs only when the calendar capability is enabled. The token refresh
  // above already ran, so email delegation (office365_mail → office365) stays healthy even
  // when calendar sync is turned off.
  if (channelState.capabilities?.calendar?.enabled !== true) {
    console.info(`[channel_office365:calendar-sync] channel ${channel.id} — calendar not enabled; token refreshed, skipping event sync`)
    return
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
  const allExternalIds = events.filter((e) => e.type !== 'seriesMaster').map((e) => e.id)
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

  // Sprint 8A: Batch-load registry rows for ping-pong detection
  // An event is a ping-pong echo if changeKey == registry.etag AND lastSyncedFrom='om'
  const existingRegistryRows = allExternalIds.length > 0
    ? await em.find(ExternalSyncRegistry, {
        provider: SYNC_PROVIDER_O365,
        externalType: SYNC_TYPE_CALENDAR_EVENT,
        externalId: { $in: allExternalIds },
        tenantId: scope.tenantId,
      })
    : []
  const registryByExternalId = new Map(existingRegistryRows.map((r) => [r.externalId, r]))

  // Filter out ping-pong echoes: our own outbound writes reflected back via delta
  const processableEvents = validEvents.filter((event) => {
    if (!event.changeKey) return true
    const reg = registryByExternalId.get(event.id)
    if (!reg?.etag) return true
    if (event.changeKey === reg.etag && reg.lastSyncedFrom === 'om') {
      console.info(
        `[channel_office365:calendar-sync] skipping ping-pong echo for event ${event.id} (changeKey=${event.changeKey})`,
      )
      return false
    }
    return true
  })

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

  // Collect registry entries to write after activity flush (IDs populated via RETURNING)
  const pendingRegistryEntries: Array<{
    entity: Activity
    externalId: string
    etag?: string | null
  }> = []

  // Apply all mutations in a single transaction — no em.flush() inside
  if (processableEvents.length > 0 || toDelete.length > 0) {
    await withAtomicFlush(em, [
      () => {
        for (const event of processableEvents) {
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

          // Calendar events can lack a subject; fall back to a meaningful identifier so the
          // Activities list never shows a blank "(no title)" in its first column.
          const organizerLabel = event.organizer?.emailAddress?.name || event.organizer?.emailAddress?.address
          const firstAttendeeLabel = event.attendees?.[0]?.emailAddress?.name || event.attendees?.[0]?.emailAddress?.address
          const meetingWith = organizerLabel || firstAttendeeLabel
          const startLabel = startDate ? startDate.toISOString().slice(0, 16).replace('T', ' ') : null
          const subject = event.subject?.trim()
            || (meetingWith ? `Spotkanie: ${meetingWith}` : startLabel ? `Spotkanie ${startLabel}` : 'Spotkanie')
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
            // CRM is master: if the activity was edited in CRM after the last sync,
            // keep the CRM version. Only update the registry etag to avoid re-triggering.
            const registryRow = registryByExternalId.get(event.id)
            const crmEditedSinceLastSync = registryRow?.lastSyncedAt
              ? existing.updatedAt > registryRow.lastSyncedAt
              : false
            if (crmEditedSinceLastSync) {
              console.info(
                `[channel_office365:calendar-sync] crm-master: keeping CRM version of activity ${existing.id} ` +
                `(crmUpdatedAt=${existing.updatedAt.toISOString()}, lastSyncedAt=${registryRow?.lastSyncedAt?.toISOString()})`,
              )
              pendingRegistryEntries.push({ entity: existing, externalId: event.id, etag: event.changeKey })
            } else {
              existing.subject = subject
              existing.notes = notes
              existing.dueAt = startDate
              existing.durationMinutes = durationMinutes
              existing.location = event.location?.displayName ?? null
              existing.allDay = event.isAllDay ?? false
              existing.participants = participants.length > 0 ? participants : null
              existing.metadata = metadata
              existing.visibility = 'team'
              existing.lastSyncedAt = new Date()
              // updatedAt is intentionally NOT updated during inbound sync —
              // only user edits should set it so that conflict detection
              // (updatedAt > registryRow.lastSyncedAt) works correctly.
              pendingLinks.push({ entity: existing, participants })
              pendingRegistryEntries.push({ entity: existing, externalId: event.id, etag: event.changeKey })
            }
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
              visibility: 'team',
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
            pendingRegistryEntries.push({ entity: newActivity, externalId: event.id, etag: event.changeKey })
          }
        }

        for (const act of toDelete) {
          act.deletedAt = new Date()
        }
      },
    ], { transaction: true, label: 'channel_office365.calendar-sync' })
  }

  // Sprint 8A: Write/update registry rows now that activity IDs are populated (via RETURNING).
  // New activity UUIDs are server-generated — they're only available after the first flush.
  if (pendingRegistryEntries.length > 0 || cancelledExternalIds.length > 0) {
    await withAtomicFlush(em, [
      () => {
        const now = new Date()
        for (const entry of pendingRegistryEntries) {
          const existingReg = registryByExternalId.get(entry.externalId)
          if (existingReg) {
            if (entry.etag !== undefined) existingReg.etag = entry.etag ?? null
            existingReg.lastSyncedAt = now
            existingReg.lastSyncedFrom = 'external'
            existingReg.updatedAt = now
          } else {
            const reg = em.create(ExternalSyncRegistry, {
              entityType: SYNC_ENTITY_ACTIVITY,
              entityId: entry.entity.id,
              provider: SYNC_PROVIDER_O365,
              externalType: SYNC_TYPE_CALENDAR_EVENT,
              externalId: entry.externalId,
              etag: entry.etag ?? null,
              syncDirection: 'bidirectional',
              lastSyncedAt: now,
              lastSyncedFrom: 'external',
              channelId: channel.id,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              createdAt: now,
              updatedAt: now,
            })
            em.persist(reg)
          }
        }
        for (const reg of existingRegistryRows) {
          if (cancelledExternalIds.includes(reg.externalId)) {
            em.remove(reg)
          }
        }
      },
    ], { transaction: true, label: 'channel_office365.calendar-sync.registry' })
  }

  // Auto-link synced activities to CRM customers by matching participant emails.
  // Built once per channel sync; emailMap is discarded after this block.
  if (pendingLinks.length > 0) {
    const emailMap = await buildEmailCustomerMap(em, scope)
    if (emailMap.size > 0) {
      await autoLinkActivityToCustomers(
        em,
        pendingLinks.map(({ entity, participants }) => ({
          activityId: entity.id,
          externalId: entity.externalId!,
          interactionType: 'meeting' as const,
          subject: entity.subject,
          notes: entity.notes,
          occurredAt: entity.occurredAt,
          dueAt: entity.dueAt,
          allDay: entity.allDay ?? false,
          ownerUserId: entity.ownerUserId,
          durationMinutes: entity.durationMinutes,
          location: entity.location,
          participants,
        })),
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
