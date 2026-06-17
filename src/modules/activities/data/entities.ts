import { Entity, PrimaryKey, Property, Index, Unique } from '@mikro-orm/decorators/legacy'

export type ActivityTypeCapabilitiesMap = {
  hasBody?: boolean
  hasDueDate?: boolean
  hasStatus?: boolean
  hasOwner?: boolean
  hasParticipants?: boolean
  hasLocation?: boolean
  hasRecurrence?: boolean
}

// Note: A partial unique index on (external_id, external_provider, organization_id) WHERE external_id IS NOT NULL
// must be added manually to the migration SQL — MikroORM decorators do not support partial indexes.

@Entity({ tableName: 'activities' })
@Index({ name: 'activities_entity_timeline_idx', properties: ['organizationId', 'tenantId', 'linkedEntityType', 'linkedEntityId', 'dueAt', 'occurredAt', 'createdAt'] })
@Index({ name: 'activities_owner_idx', properties: ['organizationId', 'tenantId', 'ownerUserId', 'status', 'dueAt'] })
@Index({ name: 'activities_type_status_idx', properties: ['organizationId', 'tenantId', 'activityType', 'status', 'deletedAt'] })
@Index({ name: 'activities_overdue_idx', properties: ['organizationId', 'tenantId', 'dueAt', 'status'] })
@Index({ name: 'activities_org_tenant_idx', properties: ['organizationId', 'tenantId', 'createdAt'] })
export class Activity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'activity_type', type: 'varchar', length: 100 })
  activityType!: string

  @Property({ name: 'lifecycle_mode', type: 'varchar', length: 10, default: 'task' })
  lifecycleMode: 'fact' | 'task' = 'task'

  @Property({ type: 'text' })
  subject!: string

  @Property({ type: 'text', nullable: true })
  notes?: string | null

  @Property({ type: 'varchar', length: 20, default: 'not_started' })
  status: string = 'not_started'

  @Property({ type: 'smallint', nullable: true })
  priority?: number | null

  @Property({ name: 'due_at', type: Date, nullable: true })
  dueAt?: Date | null

  @Property({ name: 'completed_at', type: Date, nullable: true })
  completedAt?: Date | null

  @Property({ name: 'occurred_at', type: Date, nullable: true })
  occurredAt?: Date | null

  @Property({ name: 'duration_minutes', type: 'integer', nullable: true })
  durationMinutes?: number | null

  @Property({ type: 'varchar', length: 500, nullable: true })
  location?: string | null

  @Property({ name: 'all_day', type: 'boolean', default: false })
  allDay: boolean = false

  @Property({ name: 'recurrence_rule', type: 'varchar', length: 500, nullable: true })
  recurrenceRule?: string | null

  @Property({ name: 'author_user_id', type: 'uuid', nullable: true })
  authorUserId?: string | null

  @Property({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId?: string | null

  @Property({ type: 'jsonb', nullable: true })
  participants?: Array<{ userId?: string; name?: string; email?: string; status?: string }> | null

  @Property({ type: 'varchar', length: 10, default: 'team' })
  visibility: string = 'team'

  @Property({ name: 'linked_entity_type', type: 'varchar', length: 100, nullable: true })
  linkedEntityType?: string | null

  @Property({ name: 'linked_entity_id', type: 'uuid', nullable: true })
  linkedEntityId?: string | null

  @Property({ name: 'external_id', type: 'varchar', length: 500, nullable: true })
  externalId?: string | null

  @Property({ name: 'external_provider', type: 'varchar', length: 100, nullable: true })
  externalProvider?: string | null

  @Property({ name: 'sync_direction', type: 'varchar', length: 20, nullable: true })
  syncDirection?: string | null

  @Property({ name: 'last_synced_at', type: Date, nullable: true })
  lastSyncedAt?: Date | null

  @Property({ name: 'source_type', type: 'varchar', length: 100, nullable: true })
  sourceType?: string | null

  @Property({ name: 'source_id', type: 'uuid', nullable: true })
  sourceId?: string | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  // GENERATED ALWAYS STORED — COALESCE(occurred_at, due_at, created_at). Never assign manually.
  @Property({ name: 'effective_date', type: 'timestamptz', nullable: true })
  effectiveDate?: Date | null

  // Provider-specific extra data — populated by sync workers only, never by manual creation.
  @Property({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown> | null
}

@Entity({ tableName: 'activity_links' })
@Index({ name: 'activity_links_activity_idx', properties: ['activityId'] })
@Index({ name: 'activity_links_entity_idx', properties: ['entityType', 'entityId', 'organizationId'] })
@Index({ name: 'activity_links_timeline_idx', properties: ['organizationId', 'entityType', 'entityId', 'createdAt'] })
@Unique({ name: 'activity_links_unique_entity', properties: ['activityId', 'entityType', 'entityId'] })
export class ActivityLink {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'activity_id', type: 'uuid' })
  activityId!: string

  @Property({ name: 'entity_type', type: 'varchar', length: 100 })
  entityType!: string

  @Property({ name: 'entity_id', type: 'uuid' })
  entityId!: string

  @Property({ name: 'is_primary', type: 'boolean', default: false })
  isPrimary: boolean = false

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null
}

@Entity({ tableName: 'activity_type_definitions' })
@Index({ name: 'activity_type_defs_org_idx', properties: ['organizationId', 'tenantId', 'isActive', 'sortOrder'] })
@Unique({ name: 'activity_type_defs_type_org_unique', properties: ['typeId', 'organizationId'] })
export class ActivityTypeDefinitionRecord {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'type_id', type: 'varchar', length: 100 })
  typeId!: string

  @Property({ name: 'module_id', type: 'varchar', length: 100, default: 'activities' })
  moduleId: string = 'activities'

  @Property({ type: 'varchar', length: 200 })
  label!: string

  @Property({ type: 'varchar', length: 100, default: 'Activity' })
  icon: string = 'Activity'

  @Property({ type: 'varchar', length: 50, nullable: true })
  color?: string | null

  @Property({ name: 'lifecycle_mode', type: 'varchar', length: 10, default: 'task' })
  lifecycleMode: 'fact' | 'task' = 'task'

  @Property({ type: 'jsonb', default: '{}' })
  capabilities: ActivityTypeCapabilitiesMap = {}

  @Property({ name: 'view_feature', type: 'varchar', length: 200, nullable: true })
  viewFeature?: string | null

  @Property({ name: 'create_feature', type: 'varchar', length: 200, nullable: true })
  createFeature?: string | null

  @Property({ name: 'filter_label', type: 'varchar', length: 200, nullable: true })
  filterLabel?: string | null

  @Property({ name: 'filter_group', type: 'varchar', length: 100, nullable: true })
  filterGroup?: string | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'sort_order', type: 'smallint', default: 0 })
  sortOrder: number = 0

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
