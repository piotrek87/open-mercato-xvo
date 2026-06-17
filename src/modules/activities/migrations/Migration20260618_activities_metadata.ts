import { Migration } from '@mikro-orm/migrations';

export class Migration20260618_activities_metadata extends Migration {

  override async up(): Promise<void> {
    // effective_date — GENERATED ALWAYS STORED: COALESCE(occurred_at, due_at, created_at)
    // Used as the canonical sort key for chronological ordering.
    // Emails sort by occurredAt, meetings by dueAt, manual entries by createdAt.
    this.addSql(`
      alter table "activities"
        add column "effective_date" timestamptz
          generated always as (coalesce(occurred_at, due_at, created_at)) stored;
    `);

    this.addSql(`
      create index "activities_effective_date_idx"
        on "activities" ("organization_id", "tenant_id", "effective_date" desc, "id" desc);
    `);

    // metadata — JSONB bag for provider-specific extra data.
    // Populated by sync workers only; never written by manual activity creation.
    // Examples: { teamsJoinUrl, isOnlineMeeting, hasAttachments, from, to, cc }
    this.addSql(`
      alter table "activities"
        add column "metadata" jsonb null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "activities_effective_date_idx";`);
    this.addSql(`alter table "activities" drop column if exists "effective_date";`);
    this.addSql(`alter table "activities" drop column if exists "metadata";`);
  }

}
