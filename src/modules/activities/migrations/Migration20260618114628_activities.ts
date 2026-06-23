import { Migration } from '@mikro-orm/migrations';

export class Migration20260618114628_activities extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`drop index if exists "activities_effective_date_idx";`);
  }

  override down(): void | Promise<void> {
    this.addSql(`create index "activities_effective_date_idx" on "activities" ("organization_id", "tenant_id", "effective_date", "id");`);
  }

}
