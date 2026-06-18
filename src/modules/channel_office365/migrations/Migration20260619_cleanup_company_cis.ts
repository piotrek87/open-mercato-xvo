import { Migration } from '@mikro-orm/migrations'

/**
 * Sprint 7D cleanup — remove company-scoped O365 CustomerInteraction rows.
 *
 * Sprint 7C wrote duplicate CIs for every company that a matched person belonged to
 * (entity_id = companyId, source = 'office365:...'). Sprint 7D replaces that static
 * dual-write with a D365-style query-time expansion: the GET override resolves all
 * persons linked to a company via customer_person_company_links at request time, so
 * company CIs are no longer needed and should be removed to avoid double-counting.
 *
 * WHAT IS DELETED:
 *   customer_interactions WHERE
 *     source LIKE 'office365:%'        -- written by O365 sync workers
 *     AND deleted_at IS NULL           -- only live rows (already-soft-deleted rows are harmless)
 *     AND entity_id IN (               -- only rows written to a company entity
 *       SELECT id FROM customer_entities
 *       WHERE kind = 'company'
 *         AND deleted_at IS NULL
 *     )
 *
 * WHAT IS NOT DELETED:
 *   - Person-scoped O365 CIs (entity_id → person) — these remain and are the source of truth
 *   - Non-O365 CIs on companies (source NOT LIKE 'office365:%') — untouched
 *   - Soft-deleted rows (deleted_at IS NOT NULL) — harmless, left in place
 *
 * SAFE TO RE-RUN: Uses DELETE ... WHERE, no side effects on re-run (rows are already gone).
 */
export class Migration20260619_cleanup_company_cis extends Migration {

  override async up(): Promise<void> {
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'customer_interactions'
        ) THEN
          DELETE FROM customer_interactions
          WHERE source LIKE 'office365:%'
            AND deleted_at IS NULL
            AND entity_id IN (
              SELECT id FROM customer_entities
              WHERE kind = 'company'
                AND deleted_at IS NULL
            );
        END IF;
      END;
      $$;
    `)
  }

  override async down(): Promise<void> {
    // Rows deleted by this migration cannot be restored automatically.
    // Re-run the O365 mail/calendar sync after rolling back to Sprint 7C to repopulate them.
  }

}
