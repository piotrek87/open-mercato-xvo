/**
 * SyncRegistryService — read/write the external_sync_registry table.
 *
 * The registry is the canonical sync-state store for all OM ↔ external provider
 * mappings. It tracks etag (for conflict detection), timestamps, and conflict
 * metadata. It does NOT duplicate business data from the entity tables.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { ExternalSyncRegistry } from '../data/entities'
import type {
  UpsertSyncStateInput,
  SyncRegistryRow,
  ConflictMeta,
  SyncDirection,
  SyncFrom,
} from './sync-types'

function toRow(r: ExternalSyncRegistry): SyncRegistryRow {
  return {
    id: r.id,
    entityType: r.entityType,
    entityId: r.entityId,
    provider: r.provider,
    externalType: r.externalType,
    externalId: r.externalId,
    etag: r.etag,
    syncDirection: r.syncDirection as SyncDirection,
    lastSyncedAt: r.lastSyncedAt,
    lastSyncedFrom: r.lastSyncedFrom as SyncFrom | null,
    conflictMeta: r.conflictMeta as ConflictMeta | null,
    channelId: r.channelId,
    tenantId: r.tenantId,
    organizationId: r.organizationId,
  }
}

export class SyncRegistryService {
  constructor(private readonly em: EntityManager) {}

  /** Find registry row by OM entity — primary lookup for outbound sync. */
  async findByEntityId(
    entityType: string,
    entityId: string,
    provider: string,
    externalType: string,
  ): Promise<SyncRegistryRow | null> {
    const row = await this.em.findOne(ExternalSyncRegistry, {
      entityType,
      entityId,
      provider,
      externalType,
    })
    return row ? toRow(row) : null
  }

  /** Find registry row by external ID — used by inbound worker to locate OM entity. */
  async findByExternalId(
    provider: string,
    externalType: string,
    externalId: string,
    tenantId: string,
  ): Promise<SyncRegistryRow | null> {
    const row = await this.em.findOne(ExternalSyncRegistry, {
      provider,
      externalType,
      externalId,
      tenantId,
    })
    return row ? toRow(row) : null
  }

  /**
   * Create or update a registry row after a successful sync operation.
   * Uses the MikroORM entity manager — caller must flush.
   */
  async upsertSyncState(input: UpsertSyncStateInput): Promise<SyncRegistryRow> {
    let row = await this.em.findOne(ExternalSyncRegistry, {
      entityType: input.entityType,
      entityId: input.entityId,
      provider: input.provider,
      externalType: input.externalType,
    })

    if (row) {
      row.externalId = input.externalId
      if (input.etag !== undefined) row.etag = input.etag
      if (input.syncDirection) row.syncDirection = input.syncDirection
      row.lastSyncedAt = new Date()
      row.lastSyncedFrom = input.lastSyncedFrom
      if (input.channelId !== undefined) row.channelId = input.channelId
      if (input.organizationId !== undefined) row.organizationId = input.organizationId
      if (input.conflictMeta !== undefined) row.conflictMeta = input.conflictMeta as unknown as Record<string, unknown>
      row.updatedAt = new Date()
    } else {
      row = this.em.create(ExternalSyncRegistry, {
        entityType: input.entityType,
        entityId: input.entityId,
        provider: input.provider,
        externalType: input.externalType,
        externalId: input.externalId,
        etag: input.etag ?? null,
        syncDirection: input.syncDirection ?? 'bidirectional',
        lastSyncedAt: new Date(),
        lastSyncedFrom: input.lastSyncedFrom,
        channelId: input.channelId ?? null,
        tenantId: input.tenantId,
        organizationId: input.organizationId ?? null,
        conflictMeta: (input.conflictMeta as unknown as Record<string, unknown>) ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      this.em.persist(row)
    }

    return toRow(row)
  }

  /** Remove registry row when an entity is deleted or unlinked from external. */
  async deleteByEntityId(
    entityType: string,
    entityId: string,
    provider: string,
    externalType: string,
  ): Promise<void> {
    const row = await this.em.findOne(ExternalSyncRegistry, {
      entityType,
      entityId,
      provider,
      externalType,
    })
    if (row) {
      this.em.remove(row)
    }
  }

  /**
   * Batch upsert for inbound sync — handles multiple activities in one shot.
   * Does NOT flush — caller is responsible for flushing inside withAtomicFlush.
   */
  async batchUpsertInbound(
    entries: Array<{
      entityId: string
      externalId: string
      etag?: string | null
      channelId: string
      tenantId: string
      organizationId?: string | null
    }>,
    entityType: string,
    provider: string,
    externalType: string,
  ): Promise<void> {
    if (entries.length === 0) return

    const existingRows = await this.em.find(ExternalSyncRegistry, {
      entityType,
      entityId: { $in: entries.map((e) => e.entityId) },
      provider,
      externalType,
    })
    const existingByEntityId = new Map(existingRows.map((r) => [r.entityId, r]))

    for (const entry of entries) {
      const existing = existingByEntityId.get(entry.entityId)
      if (existing) {
        existing.externalId = entry.externalId
        if (entry.etag !== undefined) existing.etag = entry.etag
        existing.lastSyncedAt = new Date()
        existing.lastSyncedFrom = 'external'
        existing.updatedAt = new Date()
      } else {
        const row = this.em.create(ExternalSyncRegistry, {
          entityType,
          entityId: entry.entityId,
          provider,
          externalType,
          externalId: entry.externalId,
          etag: entry.etag ?? null,
          syncDirection: 'bidirectional',
          lastSyncedAt: new Date(),
          lastSyncedFrom: 'external',
          channelId: entry.channelId,
          tenantId: entry.tenantId,
          organizationId: entry.organizationId ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        this.em.persist(row)
      }
    }
  }
}
