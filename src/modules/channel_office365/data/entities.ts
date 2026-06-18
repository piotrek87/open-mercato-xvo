import { Entity, PrimaryKey, Property, Index, Unique } from '@mikro-orm/decorators/legacy'

/**
 * External Sync Registry — provider-agnostic sync state store.
 *
 * Maps one OM entity (entity_type + entity_id) to one external object
 * (provider + external_type + external_id) and tracks full sync metadata:
 * etag for conflict detection, timestamps, conflict snapshots.
 *
 * Designed to be reused for Tasks (8B), Contacts (8D), and future providers
 * (Google) without further migrations on business entity tables.
 *
 * Sprint 8A: used for Activity ↔ O365 Calendar Event bidirectional sync.
 */
@Entity({ tableName: 'external_sync_registry' })
@Unique({
  name: 'external_sync_registry_entity_provider_uq',
  properties: ['entityType', 'entityId', 'provider', 'externalType'],
})
@Index({
  name: 'external_sync_registry_reverse_lookup_idx',
  properties: ['provider', 'externalType', 'externalId', 'tenantId'],
})
@Index({
  name: 'external_sync_registry_entity_idx',
  properties: ['entityType', 'entityId'],
})
@Index({
  name: 'external_sync_registry_tenant_idx',
  properties: ['tenantId', 'provider'],
})
export class ExternalSyncRegistry {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  // ── OM side ──────────────────────────────────────────────────────────────
  @Property({ name: 'entity_type', type: 'varchar', length: 100 })
  entityType!: string

  @Property({ name: 'entity_id', type: 'uuid' })
  entityId!: string

  // ── External side ─────────────────────────────────────────────────────────
  @Property({ type: 'varchar', length: 100 })
  provider!: string

  @Property({ name: 'external_type', type: 'varchar', length: 100 })
  externalType!: string

  @Property({ name: 'external_id', type: 'varchar', length: 1000 })
  externalId!: string

  // ── Sync state ────────────────────────────────────────────────────────────
  /** Provider's version identifier — O365 changeKey, Google ETag, etc. */
  @Property({ type: 'varchar', length: 1000, nullable: true })
  etag?: string | null

  @Property({ name: 'sync_direction', type: 'varchar', length: 20, default: 'bidirectional' })
  syncDirection: string = 'bidirectional'

  @Property({ name: 'last_synced_at', type: 'timestamptz', nullable: true })
  lastSyncedAt?: Date | null

  /** 'om' = OM initiated last sync, 'external' = provider initiated */
  @Property({ name: 'last_synced_from', type: 'varchar', length: 20, nullable: true })
  lastSyncedFrom?: string | null

  /**
   * Conflict metadata — null if no conflict. Stores enough for diagnostics:
   * { detectedAt, resolvedAt, resolution, trigger, omSnapshot, o365Snapshot, notes }
   */
  @Property({ name: 'conflict_meta', type: 'jsonb', nullable: true })
  conflictMeta?: Record<string, unknown> | null

  // ── Channel / tenant scoping ──────────────────────────────────────────────
  /** Which communication channel (user's O365 account) owns this sync link */
  @Property({ name: 'channel_id', type: 'uuid', nullable: true })
  channelId?: string | null

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
