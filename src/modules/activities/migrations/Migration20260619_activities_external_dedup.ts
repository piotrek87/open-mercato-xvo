import { Migration } from '@mikro-orm/migrations';

export class Migration20260619_activities_external_dedup extends Migration {

  override async up(): Promise<void> {
    // Partial unique index for synced activities — prevents duplicate imports when
    // mail-sync or calendar-sync workers run concurrently (concurrency > 1).
    // MikroORM decorators do not support partial indexes, so this is manual SQL.
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS activities_external_dedup_idx
        ON activities (external_id, external_provider, organization_id)
        WHERE external_id IS NOT NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS activities_external_dedup_idx;`);
  }

}
