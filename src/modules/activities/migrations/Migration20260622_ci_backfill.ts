// Data-only migration — no schema change, no snapshot update needed.
import { Migration } from '@mikro-orm/migrations'

export class Migration20260622CiBackfill extends Migration {

  override async up(): Promise<void> {
    // Guard: customer_interactions may not exist on a fresh database (framework table
    // created by core migrations that run separately from app module migrations).
    // On a fresh DB there is nothing to backfill anyway.
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'customer_interactions'
        ) THEN
          INSERT INTO activities (
            id,
            organization_id,
            tenant_id,
            activity_type,
            lifecycle_mode,
            subject,
            notes,
            status,
            occurred_at,
            duration_minutes,
            location,
            all_day,
            participants,
            author_user_id,
            owner_user_id,
            visibility,
            external_id,
            external_provider,
            source_type,
            source_id,
            is_active,
            created_at,
            updated_at
          )
          SELECT
            gen_random_uuid(),
            ci.organization_id,
            ci.tenant_id,
            COALESCE(ci.interaction_type, 'note'),
            'fact',
            COALESCE(ci.title, '(imported interaction)'),
            ci.body,
            CASE WHEN ci.status = 'done' THEN 'completed' ELSE 'not_started' END,
            ci.occurred_at,
            ci.duration_minutes,
            ci.location,
            COALESCE(ci.all_day, false),
            ci.participants,
            ci.author_user_id,
            ci.owner_user_id,
            COALESCE(ci.visibility, 'team'),
            ci.id::text,
            'customer_interaction',
            'customer_interaction_import',
            ci.id,
            true,
            ci.created_at,
            ci.updated_at
          FROM customer_interactions ci
          WHERE ci.deleted_at IS NULL
            AND ci.external_message_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM activities a
              WHERE a.external_id = ci.id::text
                AND a.source_type = 'customer_interaction_import'
                AND a.organization_id = ci.organization_id
                AND a.deleted_at IS NULL
            );
        END IF;
      END $$;
    `)
  }

  override async down(): Promise<void> {
    this.addSql(`
      DELETE FROM activities
      WHERE source_type = 'customer_interaction_import'
    `)
  }

}
