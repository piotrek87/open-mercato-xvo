import { Migration } from '@mikro-orm/migrations'

/**
 * Sprint 5 Phase 1 — Unified Microsoft 365 Channel
 *
 * Migrates the channel_office365 module from a calendar-only connector
 * to a unified Microsoft 365 connector with capability-based channelState.
 *
 * Three steps (all idempotent):
 *
 * Step 1: Rename provider_key 'office365_calendar' → 'office365'
 *   Affects: communication_channels table
 *   Impact on Activity records: NONE — activities.external_provider stays
 *   'office365_calendar' forever (semantic identifier, not the channel key)
 *
 * Step 2: Rename integration_id 'channel_office365_calendar' → 'channel_office365'
 *   Affects: integration_credentials table (tenant-level config + per-user tokens)
 *   Impact on credentials: existing tokens continue to work immediately
 *
 * Step 3: Restructure channelState JSONB (flat → nested capabilities)
 *   Before: { deltaToken, lastSyncedAt, bootstrapped, grantedScopes }
 *   After:  { capabilities: { calendar: { enabled, deltaToken, ... }, mail: { enabled } }, grantedScopes }
 *   Idempotent guard: only runs on rows where capabilities is absent
 *   Delta cursor: preserved in capabilities.calendar.deltaToken — no re-bootstrap
 *
 * Each step is wrapped in DO $$ IF EXISTS $$ to guard against fresh installs where
 * framework core tables (communication_channels, integration_credentials) may not
 * exist yet when this module migration runs.
 *
 * Rollback:
 *   down() reverses all three steps exactly. Safe to run at any point
 *   as long as no new channels have been created with providerKey 'office365'
 *   and no mail sync has written capabilities.mail.deltaToken.
 */
export class Migration20260617_channel_office365_unified extends Migration {

  override async up(): Promise<void> {
    // Step 1: Rename providerKey
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'communication_channels'
        ) THEN
          UPDATE communication_channels
          SET    provider_key = 'office365'
          WHERE  provider_key = 'office365_calendar';
        END IF;
      END;
      $$;
    `)

    // Step 2: Rename integrationId in credentials
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'integration_credentials'
        ) THEN
          UPDATE integration_credentials
          SET    integration_id = 'channel_office365'
          WHERE  integration_id = 'channel_office365_calendar';
        END IF;
      END;
      $$;
    `)

    // Step 3: Restructure channelState JSONB — flat → nested capabilities
    // Idempotent: WHERE (channel_state->'capabilities') IS NULL skips already-migrated rows
    // (rows the new worker has already written to before this migration runs)
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'communication_channels'
        ) THEN
          UPDATE communication_channels
          SET channel_state = jsonb_build_object(
            'capabilities', jsonb_build_object(
              'calendar', jsonb_build_object(
                'enabled',      true,
                'deltaToken',   channel_state->>'deltaToken',
                'lastSyncedAt', channel_state->>'lastSyncedAt',
                'bootstrapped', COALESCE((channel_state->>'bootstrapped')::boolean, false)
              ),
              'mail', jsonb_build_object(
                'enabled', false
              )
            ),
            'grantedScopes', COALESCE(channel_state->'grantedScopes', '[]'::jsonb)
          )
          WHERE  provider_key   = 'office365'
            AND  channel_state IS NOT NULL
            AND  (channel_state->'capabilities') IS NULL;
        END IF;
      END;
      $$;
    `)
  }

  override async down(): Promise<void> {
    // Rollback Step 3: Flatten channelState back to original structure
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'communication_channels'
        ) THEN
          UPDATE communication_channels
          SET channel_state = jsonb_build_object(
            'deltaToken',   channel_state->'capabilities'->'calendar'->>'deltaToken',
            'lastSyncedAt', channel_state->'capabilities'->'calendar'->>'lastSyncedAt',
            'bootstrapped', COALESCE(
              (channel_state->'capabilities'->'calendar'->>'bootstrapped')::boolean,
              false
            ),
            'grantedScopes', COALESCE(channel_state->'grantedScopes', '[]'::jsonb)
          )
          WHERE  provider_key = 'office365'
            AND  (channel_state->'capabilities') IS NOT NULL;
        END IF;
      END;
      $$;
    `)

    // Rollback Step 2: Rename integrationId back
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'integration_credentials'
        ) THEN
          UPDATE integration_credentials
          SET    integration_id = 'channel_office365_calendar'
          WHERE  integration_id = 'channel_office365';
        END IF;
      END;
      $$;
    `)

    // Rollback Step 1: Rename providerKey back
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'communication_channels'
        ) THEN
          UPDATE communication_channels
          SET    provider_key = 'office365_calendar'
          WHERE  provider_key = 'office365';
        END IF;
      END;
      $$;
    `)
  }

}
