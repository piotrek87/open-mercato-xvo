/**
 * ConflictLogger — detect and record sync conflicts between OM and O365.
 *
 * Sprint 8A strategy: last-write-wins + log to conflict_meta.
 * Architecture supports future: 'pending' resolution + UI for manual override.
 */

import type { ConflictMeta, ConflictResolution, SyncRegistryRow } from './sync-types'

export interface ConflictDetectionInput {
  registryRow: SyncRegistryRow
  trigger: 'inbound' | 'outbound'
  /** Current O365 changeKey fetched from Graph */
  currentO365Etag: string
  /** O365 lastModifiedDateTime (ISO) */
  o365ModifiedAt?: string
  /** OM activity updatedAt */
  omUpdatedAt: Date
  /** OM activity subject for snapshot */
  omSubject?: string
  /** OM activity occurredAt for snapshot */
  omOccurredAt?: Date | null
}

export interface ConflictDetectionResult {
  isConflict: boolean
  resolution: ConflictResolution
  meta: ConflictMeta | null
}

/**
 * Detect whether a conflict exists between OM and O365 states.
 *
 * Conflict conditions:
 * - Inbound: changeKey differs from registry.etag AND last sync was from 'om'
 *   (meaning OM pushed a change, but O365 has a DIFFERENT changeKey now — someone else edited)
 * - Outbound: current O365 changeKey differs from registry.etag
 *   (O365 was modified externally since last sync)
 *
 * Non-conflict:
 * - changeKey == registry.etag → our own echo → no conflict, skip
 * - registry.etag is null → first sync → no conflict
 */
export function detectConflict(input: ConflictDetectionInput): ConflictDetectionResult {
  const { registryRow, trigger, currentO365Etag, o365ModifiedAt, omUpdatedAt, omSubject, omOccurredAt } = input

  // No stored etag → first time seeing this event, not a conflict
  if (!registryRow.etag) {
    return { isConflict: false, resolution: 'last_write_wins_om', meta: null }
  }

  // Etag matches → our own change echoed back from O365, not a conflict
  if (currentO365Etag === registryRow.etag) {
    return { isConflict: false, resolution: 'last_write_wins_om', meta: null }
  }

  // For inbound: only a conflict if OM was the last one to sync (we pushed, then O365 changed)
  if (trigger === 'inbound' && registryRow.lastSyncedFrom !== 'om') {
    return { isConflict: false, resolution: 'last_write_wins_external', meta: null }
  }

  // Conflict detected — determine resolution by comparing timestamps
  let resolution: ConflictResolution = 'last_write_wins_om'
  if (o365ModifiedAt && registryRow.lastSyncedAt) {
    const o365Time = new Date(o365ModifiedAt).getTime()
    const omTime = omUpdatedAt.getTime()
    resolution = o365Time > omTime ? 'last_write_wins_external' : 'last_write_wins_om'
  }

  const meta: ConflictMeta = {
    detectedAt: new Date().toISOString(),
    resolution,
    trigger,
    omSnapshot: {
      updatedAt: omUpdatedAt.toISOString(),
      ...(omSubject ? { subject: omSubject } : {}),
      ...(omOccurredAt ? { occurredAt: omOccurredAt.toISOString() } : {}),
    },
    externalSnapshot: {
      etag: currentO365Etag,
      ...(o365ModifiedAt ? { modifiedAt: o365ModifiedAt } : {}),
    },
  }

  console.warn(
    `[channel_office365:sync-conflict] Conflict detected (${trigger}): ` +
    `entity=${registryRow.entityType}:${registryRow.entityId} ` +
    `external=${registryRow.provider}:${registryRow.externalId} ` +
    `resolution=${resolution} ` +
    `storedEtag=${registryRow.etag} currentEtag=${currentO365Etag}`,
  )

  return { isConflict: true, resolution, meta }
}
