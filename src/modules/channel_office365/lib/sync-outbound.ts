/**
 * SyncOutboundService — push OM Activity changes to O365 Calendar.
 *
 * Sprint 8A: Meeting ↔ Calendar Event outbound direction.
 *
 * PATCH guarantee: if registry row exists for this activity, always PATCH the
 * existing O365 event — never POST a new one. This is enforced in pushMeeting().
 *
 * Conflict detection: before PATCH, fetch current O365 changeKey and compare
 * with registry.etag. If they differ, O365 was modified externally → log conflict
 * and apply last-write-wins (OM wins in Sprint 8A).
 *
 * Attendees (outbound): resolve activity_links for person entities, decrypt their
 * emails via findWithDecryption, add as O365 attendees.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { Activity, ActivityLink } from '../../activities/data/entities'
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getCalendarEventChangeKey,
  GraphApiError,
  type GraphEventPayload,
} from './graph-client'
import { SyncRegistryService } from './sync-registry'
import { detectConflict } from './sync-conflict'
import {
  O365_PROVIDER_KEY,
  O365_INTEGRATION_ID,
  o365UserCredentialsSchema,
} from './credentials'
import {
  SYNC_PROVIDER_O365,
  SYNC_TYPE_CALENDAR_EVENT,
  SYNC_ENTITY_ACTIVITY,
  type ConflictMeta,
} from './sync-types'

type CredentialsServiceLike = {
  resolve: (
    integrationId: string,
    scope: { tenantId: string; organizationId: string; userId?: string | null },
  ) => Promise<Record<string, unknown> | null>
}

/** Resolve access token for a channel, return null if unavailable/expired. */
export async function resolveAccessToken(
  channel: CommunicationChannel,
  credentialsService: CredentialsServiceLike,
): Promise<string | null> {
  const scope = {
    tenantId: channel.tenantId,
    organizationId: channel.organizationId ?? channel.tenantId,
    userId: channel.userId ?? null,
  }
  const rawCreds = await credentialsService.resolve(O365_INTEGRATION_ID, scope)
  if (!rawCreds) return null
  const parsed = o365UserCredentialsSchema.safeParse(rawCreds)
  if (!parsed.success) return null
  const { accessToken, expiresAt } = parsed.data
  if (!accessToken) return null
  if (expiresAt && new Date(expiresAt).getTime() - Date.now() < -30_000) {
    // Token expired more than 30s ago — don't attempt (subscriber will retry)
    return null
  }
  return accessToken
}

/** Find an active O365 channel for a given user. Returns null if not connected. */
export async function resolveUserChannel(
  em: EntityManager,
  userId: string,
  tenantId: string,
): Promise<CommunicationChannel | null> {
  return em.findOne(CommunicationChannel, {
    userId,
    tenantId,
    providerKey: O365_PROVIDER_KEY,
    isActive: true,
    status: 'connected',
    deletedAt: null,
  })
}

/** Resolve person entity emails for activity_links — used for attendees. */
async function resolveAttendeeEmails(
  em: EntityManager,
  activityId: string,
  tenantId: string,
  organizationId: string,
): Promise<Array<{ address: string; name?: string }>> {
  const links = await em.find(ActivityLink, {
    activityId,
    entityType: 'customer',
    tenantId,
    organizationId,
  })
  if (links.length === 0) return []

  const personIds = links.map((l) => l.entityId)
  const persons = await findWithDecryption(
    em,
    CustomerEntity,
    { id: { $in: personIds }, kind: 'person', tenantId, organizationId, deletedAt: null },
    { limit: 50 },
    { tenantId, organizationId },
  )

  return persons
    .filter((p) => !!p.primaryEmail)
    .map((p) => ({
      address: p.primaryEmail!,
      name: p.displayName ?? undefined,
    }))
}

/** Map an OM Activity to a Graph event payload. */
function buildEventPayload(
  activity: Activity,
  attendees: Array<{ address: string; name?: string }>,
): GraphEventPayload {
  const start = activity.occurredAt ?? activity.dueAt ?? new Date()
  const durationMs = (activity.durationMinutes ?? 60) * 60_000
  const end = new Date(start.getTime() + durationMs)

  const payload: GraphEventPayload = {
    subject: activity.subject,
    body: {
      contentType: 'text',
      content: activity.notes ?? '',
    },
    start: {
      dateTime: start.toISOString().replace(/\.\d{3}Z$/, ''),
      timeZone: 'UTC',
    },
    end: {
      dateTime: end.toISOString().replace(/\.\d{3}Z$/, ''),
      timeZone: 'UTC',
    },
  }

  if (activity.location) {
    payload.location = { displayName: activity.location }
  }

  if (attendees.length > 0) {
    payload.attendees = attendees.map((a) => ({
      emailAddress: { address: a.address, name: a.name },
      type: 'required' as const,
    }))
  }

  return payload
}

/**
 * Push an activity (create or update) to O365 Calendar.
 * - No registry row → POST (create) → store registry row
 * - Registry row exists → conflict check → PATCH (update) → update registry
 */
export async function pushMeetingToO365(
  activity: Activity,
  channel: CommunicationChannel,
  accessToken: string,
  em: EntityManager,
): Promise<void> {
  const registry = new SyncRegistryService(em)
  const attendees = await resolveAttendeeEmails(
    em,
    activity.id,
    channel.tenantId,
    channel.organizationId ?? channel.tenantId,
  )
  const payload = buildEventPayload(activity, attendees)

  const existing = await registry.findByEntityId(
    SYNC_ENTITY_ACTIVITY,
    activity.id,
    SYNC_PROVIDER_O365,
    SYNC_TYPE_CALENDAR_EVENT,
  )

  if (!existing) {
    // CREATE — no prior sync link for this activity
    const created = await createCalendarEvent(accessToken, payload)
    await registry.upsertSyncState({
      entityType: SYNC_ENTITY_ACTIVITY,
      entityId: activity.id,
      provider: SYNC_PROVIDER_O365,
      externalType: SYNC_TYPE_CALENDAR_EVENT,
      externalId: created.id,
      etag: created.changeKey,
      syncDirection: 'bidirectional',
      lastSyncedFrom: 'om',
      channelId: channel.id,
      tenantId: channel.tenantId,
      organizationId: channel.organizationId ?? null,
    })
    // Keep activity columns in sync (backwards compat)
    activity.externalId = created.id
    activity.externalProvider = 'office365_calendar'
    activity.syncDirection = 'bidirectional'
    activity.lastSyncedAt = new Date()
    await em.flush()

    console.info(
      `[channel_office365:sync-outbound] Created O365 event ${created.id} for activity ${activity.id}`,
    )
    return
  }

  // UPDATE — registry row exists, enforce PATCH guarantee
  // Conflict check: fetch current O365 changeKey
  let currentEtag: string | null = null
  try {
    currentEtag = await getCalendarEventChangeKey(accessToken, existing.externalId)
  } catch (err) {
    if (err instanceof GraphApiError && err.status === 404) {
      // Event deleted from O365 — re-create
      console.warn(
        `[channel_office365:sync-outbound] O365 event ${existing.externalId} not found, re-creating`,
      )
      const created = await createCalendarEvent(accessToken, payload)
      await registry.upsertSyncState({
        entityType: SYNC_ENTITY_ACTIVITY,
        entityId: activity.id,
        provider: SYNC_PROVIDER_O365,
        externalType: SYNC_TYPE_CALENDAR_EVENT,
        externalId: created.id,
        etag: created.changeKey,
        syncDirection: 'bidirectional',
        lastSyncedFrom: 'om',
        channelId: channel.id,
        tenantId: channel.tenantId,
        organizationId: channel.organizationId ?? null,
      })
      activity.externalId = created.id
      activity.lastSyncedAt = new Date()
      await em.flush()
      return
    }
    throw err
  }

  let conflictMeta: ConflictMeta | null = null
  if (currentEtag) {
    const conflictResult = detectConflict({
      registryRow: existing,
      trigger: 'outbound',
      currentO365Etag: currentEtag,
      omUpdatedAt: activity.updatedAt,
      omSubject: activity.subject,
      omOccurredAt: activity.occurredAt,
    })
    if (conflictResult.isConflict) {
      conflictMeta = conflictResult.meta
      // Sprint 8A: OM wins — continue with PATCH regardless
    }
  }

  const updated = await updateCalendarEvent(accessToken, existing.externalId, payload)
  await registry.upsertSyncState({
    entityType: SYNC_ENTITY_ACTIVITY,
    entityId: activity.id,
    provider: SYNC_PROVIDER_O365,
    externalType: SYNC_TYPE_CALENDAR_EVENT,
    externalId: existing.externalId,
    etag: updated.changeKey,
    syncDirection: 'bidirectional',
    lastSyncedFrom: 'om',
    channelId: channel.id,
    tenantId: channel.tenantId,
    organizationId: channel.organizationId ?? null,
    conflictMeta,
  })
  activity.lastSyncedAt = new Date()
  await em.flush()

  console.info(
    `[channel_office365:sync-outbound] Updated O365 event ${existing.externalId} for activity ${activity.id}`,
  )
}

/**
 * Delete an O365 Calendar event when the corresponding OM activity is deleted.
 * Idempotent — 404 from O365 is treated as success.
 */
export async function deleteMeetingFromO365(
  activity: Activity,
  accessToken: string,
  em: EntityManager,
): Promise<void> {
  const registry = new SyncRegistryService(em)
  const existing = await registry.findByEntityId(
    SYNC_ENTITY_ACTIVITY,
    activity.id,
    SYNC_PROVIDER_O365,
    SYNC_TYPE_CALENDAR_EVENT,
  )

  // Fall back to activity.externalId for activities synced before Sprint 8A
  const o365Id = existing?.externalId ?? activity.externalId
  if (!o365Id) return

  try {
    await deleteCalendarEvent(accessToken, o365Id)
  } catch (err) {
    if (err instanceof GraphApiError && err.status === 404) {
      // Already gone — that's fine
    } else {
      throw err
    }
  }

  if (existing) {
    await registry.deleteByEntityId(
      SYNC_ENTITY_ACTIVITY,
      activity.id,
      SYNC_PROVIDER_O365,
      SYNC_TYPE_CALENDAR_EVENT,
    )
    await em.flush()
  }

  console.info(
    `[channel_office365:sync-outbound] Deleted O365 event ${o365Id} for activity ${activity.id}`,
  )
}
