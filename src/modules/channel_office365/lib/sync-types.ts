/**
 * Shared TypeScript types for the OM ↔ O365 bidirectional sync layer (Sprint 8A).
 * Reused by SyncRegistryService, SyncOutboundService, ConflictLogger, and future
 * provider integrations (Task sync 8B, Contact sync 8D, Google future).
 */

export const SYNC_PROVIDER_O365 = 'office365'
export const SYNC_TYPE_CALENDAR_EVENT = 'calendar_event'
export const SYNC_ENTITY_ACTIVITY = 'activity'

export type SyncDirection = 'import' | 'export' | 'bidirectional'
export type SyncFrom = 'om' | 'external'
export type ConflictResolution =
  | 'last_write_wins_om'
  | 'last_write_wins_external'
  | 'manual'
  | 'pending'

export interface ConflictMeta {
  detectedAt: string
  resolvedAt?: string
  resolution: ConflictResolution
  trigger: 'inbound' | 'outbound'
  omSnapshot: {
    updatedAt: string
    subject?: string
    occurredAt?: string
  }
  externalSnapshot: {
    etag: string
    modifiedAt?: string
  }
  notes?: string
}

export interface SyncRegistryRow {
  id: string
  entityType: string
  entityId: string
  provider: string
  externalType: string
  externalId: string
  etag?: string | null
  syncDirection: SyncDirection
  lastSyncedAt?: Date | null
  lastSyncedFrom?: SyncFrom | null
  conflictMeta?: ConflictMeta | null
  channelId?: string | null
  tenantId: string
  organizationId?: string | null
}

export interface UpsertSyncStateInput {
  entityType: string
  entityId: string
  provider: string
  externalType: string
  externalId: string
  etag?: string | null
  syncDirection?: SyncDirection
  lastSyncedFrom: SyncFrom
  channelId?: string | null
  tenantId: string
  organizationId?: string | null
  conflictMeta?: ConflictMeta | null
}
