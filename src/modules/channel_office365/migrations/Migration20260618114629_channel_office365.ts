import { Migration } from '@mikro-orm/migrations';

export class Migration20260618114629_channel_office365 extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "external_sync_registry" ("id" uuid not null default gen_random_uuid(), "entity_type" varchar(100) not null, "entity_id" uuid not null, "provider" varchar(100) not null, "external_type" varchar(100) not null, "external_id" varchar(1000) not null, "etag" varchar(1000) null, "sync_direction" varchar(20) not null default 'bidirectional', "last_synced_at" timestamptz null, "last_synced_from" varchar(20) null, "conflict_meta" jsonb null, "channel_id" uuid null, "tenant_id" uuid not null, "organization_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "external_sync_registry_tenant_idx" on "external_sync_registry" ("tenant_id", "provider");`);
    this.addSql(`create index "external_sync_registry_entity_idx" on "external_sync_registry" ("entity_type", "entity_id");`);
    this.addSql(`create index "external_sync_registry_reverse_lookup_idx" on "external_sync_registry" ("provider", "external_type", "external_id", "tenant_id");`);
    this.addSql(`alter table "external_sync_registry" add constraint "external_sync_registry_entity_provider_uq" unique ("entity_type", "entity_id", "provider", "external_type");`);
  }

}
