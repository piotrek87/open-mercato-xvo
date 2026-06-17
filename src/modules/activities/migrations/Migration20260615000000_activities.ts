import { Migration } from '@mikro-orm/migrations';

export class Migration20260615000000_activities extends Migration {

  override async up(): Promise<void> {
    this.addSql(`
      create table "activities" (
        "id" uuid not null default gen_random_uuid(),
        "organization_id" uuid not null,
        "tenant_id" uuid not null,
        "activity_type" varchar(100) not null,
        "lifecycle_mode" varchar(10) not null default 'task',
        "subject" text not null,
        "notes" text null,
        "status" varchar(20) not null default 'not_started',
        "priority" smallint null,
        "due_at" timestamptz null,
        "completed_at" timestamptz null,
        "occurred_at" timestamptz null,
        "duration_minutes" int null,
        "location" varchar(500) null,
        "all_day" boolean not null default false,
        "recurrence_rule" varchar(500) null,
        "author_user_id" uuid null,
        "owner_user_id" uuid null,
        "participants" jsonb null,
        "visibility" varchar(10) not null default 'team',
        "linked_entity_type" varchar(100) null,
        "linked_entity_id" uuid null,
        "external_id" varchar(500) null,
        "external_provider" varchar(100) null,
        "sync_direction" varchar(20) null,
        "last_synced_at" timestamptz null,
        "source_type" varchar(100) null,
        "source_id" uuid null,
        "is_active" boolean not null default true,
        "deleted_at" timestamptz null,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        constraint "activities_pkey" primary key ("id")
      );
    `);

    // Composite indexes per spec
    this.addSql(`
      create index "activities_entity_timeline_idx"
      on "activities" ("organization_id", "tenant_id", "linked_entity_type", "linked_entity_id", "due_at", "occurred_at", "created_at")
      where deleted_at is null;
    `);

    this.addSql(`
      create index "activities_owner_idx"
      on "activities" ("organization_id", "tenant_id", "owner_user_id", "status", "due_at")
      where deleted_at is null;
    `);

    this.addSql(`
      create index "activities_type_status_idx"
      on "activities" ("organization_id", "tenant_id", "activity_type", "status", "deleted_at");
    `);

    this.addSql(`
      create index "activities_overdue_idx"
      on "activities" ("organization_id", "tenant_id", "due_at", "status")
      where lifecycle_mode = 'task'
        and status in ('not_started', 'in_progress')
        and deleted_at is null;
    `);

    this.addSql(`
      create index "activities_org_tenant_idx"
      on "activities" ("organization_id", "tenant_id", "created_at" desc)
      where deleted_at is null;
    `);

    // Partial unique index for external sync deduplication
    this.addSql(`
      create unique index "activities_external_dedup_idx"
      on "activities" ("organization_id", "external_id", "external_provider")
      where external_id is not null and deleted_at is null;
    `);

    // Check constraints
    this.addSql(`
      alter table "activities"
        add constraint "activities_entity_link_check"
        check (
          (linked_entity_type is null and linked_entity_id is null) or
          (linked_entity_type is not null and linked_entity_id is not null)
        );
    `);

    this.addSql(`
      alter table "activities"
        add constraint "activities_external_link_check"
        check (
          (external_id is null and external_provider is null) or
          (external_id is not null and external_provider is not null)
        );
    `);

    this.addSql(`
      alter table "activities"
        add constraint "activities_priority_range_check"
        check (priority is null or (priority >= 0 and priority <= 100));
    `);

    this.addSql(`
      alter table "activities"
        add constraint "activities_duration_check"
        check (duration_minutes is null or (duration_minutes >= 0 and duration_minutes <= 1440));
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "activities" cascade;`);
  }

}
