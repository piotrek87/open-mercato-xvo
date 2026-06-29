import { Migration } from '@mikro-orm/migrations'

export class Migration20260616_channel_office365_backfill_visibility extends Migration {

  override up(): void | Promise<void> {
    // Guarded: activities table may not exist yet on a fresh install
    // (framework core migrations might not have run before this module migration).
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'activities'
        ) THEN
          UPDATE activities
          SET visibility = 'private',
              updated_at = NOW()
          WHERE external_provider = 'office365_calendar'
            AND visibility = 'team';
        END IF;
      END;
      $$;
    `)
  }

  override down(): void | Promise<void> {
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'activities'
        ) THEN
          UPDATE activities
          SET visibility = 'team',
              updated_at = NOW()
          WHERE external_provider = 'office365_calendar'
            AND visibility = 'private';
        END IF;
      END;
      $$;
    `)
  }

}
