import { Migration } from '@mikro-orm/migrations';

export class Migration20260615183513_activities extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "activity_type_definitions" ("id" uuid not null default gen_random_uuid(), "type_id" varchar(100) not null, "module_id" varchar(100) not null default 'activities', "label" varchar(200) not null, "icon" varchar(100) not null default 'Activity', "color" varchar(50) null, "lifecycle_mode" varchar(10) not null default 'task', "capabilities" jsonb not null default '{}', "view_feature" varchar(200) null, "create_feature" varchar(200) null, "filter_label" varchar(200) null, "filter_group" varchar(100) null, "is_active" boolean not null default true, "sort_order" smallint not null default 0, "organization_id" uuid not null, "tenant_id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "activity_type_defs_org_idx" on "activity_type_definitions" ("organization_id", "tenant_id", "is_active", "sort_order");`);
    this.addSql(`alter table "activity_type_definitions" add constraint "activity_type_defs_type_org_unique" unique ("type_id", "organization_id");`);
  }

}
