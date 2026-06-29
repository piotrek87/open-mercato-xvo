import { Migration } from '@mikro-orm/migrations';

export class Migration20260615131325_activities extends Migration {

  override async up(): Promise<void> {
    // Create activity_links junction table
    this.addSql(`create table "activity_links" (
      "id"                  uuid not null default gen_random_uuid(),
      "activity_id"         uuid not null,
      "entity_type"         varchar(100) not null,
      "entity_id"           uuid not null,
      "is_primary"          boolean not null default false,
      "organization_id"     uuid not null,
      "tenant_id"           uuid not null,
      "created_at"          timestamptz not null default now(),
      "created_by_user_id"  uuid null,
      primary key ("id")
    );`);

    // FK to activities (cascade delete — links are owned by the activity)
    this.addSql(`alter table "activity_links"
      add constraint "activity_links_activity_fk"
      foreign key ("activity_id") references "activities" ("id") on delete cascade;`);

    // Indexes (see Sprint 2 spec §2.2)
    this.addSql(`create index "activity_links_activity_idx"  on "activity_links" ("activity_id");`);
    this.addSql(`create index "activity_links_entity_idx"    on "activity_links" ("entity_type", "entity_id", "organization_id");`);
    this.addSql(`create index "activity_links_timeline_idx"  on "activity_links" ("organization_id", "entity_type", "entity_id", "created_at" desc);`);

    // Uniqueness: same entity cannot be linked twice to the same activity
    this.addSql(`alter table "activity_links"
      add constraint "activity_links_unique_entity"
      unique ("activity_id", "entity_type", "entity_id");`);

    // Partial unique: at most one is_primary=true per activity
    this.addSql(`create unique index "activity_links_primary_idx"
      on "activity_links" ("activity_id") where ("is_primary" = true);`);

    // Data migration: backfill from existing Activity.linked_entity_type/id (idempotent)
    this.addSql(`
      insert into "activity_links" ("id", "activity_id", "entity_type", "entity_id", "is_primary", "organization_id", "tenant_id", "created_at")
      select
        gen_random_uuid(),
        a."id",
        a."linked_entity_type",
        a."linked_entity_id",
        true,
        a."organization_id",
        a."tenant_id",
        a."created_at"
      from "activities" a
      where a."linked_entity_type" is not null
        and a."linked_entity_id" is not null
        and a."deleted_at" is null
      on conflict ("activity_id", "entity_type", "entity_id") do nothing;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "activity_links";`);
  }

}
