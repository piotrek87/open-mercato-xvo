import { Migration } from '@mikro-orm/migrations'

/**
 * Adds a partial unique index on customer_interactions to prevent duplicate records
 * created by the O365 calendar/mail sync workers.
 *
 * Each O365 sync writes a CustomerInteraction for every matched (activity, CRM person)
 * pair. Without a dedup guard, re-syncing would insert duplicates.
 *
 * Dedup key: (entity_id, source, organization_id)
 *   — entity_id    the CRM person's CustomerEntity UUID
 *   — source       'office365:mail:<o365_message_id>' | 'office365:calendar:<o365_event_id>'
 *   — organization_id  tenant-scoped partition
 *
 * Partial: WHERE source LIKE 'office365:%' AND deleted_at IS NULL
 *   — only applies to O365-sourced interactions; never conflicts with soft-deleted rows
 *
 * The INSERT in customer-linker.ts uses:
 *   ON CONFLICT (entity_id, source, organization_id)
 *   WHERE source LIKE 'office365:%' AND deleted_at IS NULL
 *   DO UPDATE SET title = EXCLUDED.title, ...
 * so re-syncs refresh stale data rather than duplicating.
 *
 * Guarded: runs only when customer_interactions exists (safe on fresh installs where
 * the core customers module may not yet have run its migrations).
 */
export class Migration20260619_o365_ci_dedup extends Migration {

  override async up(): Promise<void> {
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'customer_interactions'
        ) THEN
          CREATE UNIQUE INDEX IF NOT EXISTS customer_interactions_o365_dedup_idx
            ON customer_interactions (entity_id, source, organization_id)
            WHERE source LIKE 'office365:%' AND deleted_at IS NULL;
        END IF;
      END;
      $$;
    `)
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS customer_interactions_o365_dedup_idx;`)
  }

}
