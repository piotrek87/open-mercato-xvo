import { Migration } from '@mikro-orm/migrations'

export class Migration20260616_channel_office365_backfill_visibility extends Migration {

  override up(): void | Promise<void> {
    // Office 365 calendar events are personal calendar data.
    // Defaulting to 'private' ensures that synced meetings (1:1s, personal
    // appointments, HR conversations) are not exposed org-wide by default.
    // Users can explicitly change visibility to 'team' for events they want
    // to share with colleagues. This backfill aligns existing synced records
    // with the new default set in the calendar-sync worker (Sprint 4B).
    this.addSql(`
      UPDATE activities
      SET visibility = 'private',
          updated_at = NOW()
      WHERE external_provider = 'office365_calendar'
        AND visibility = 'team';
    `)
  }

  override down(): void | Promise<void> {
    this.addSql(`
      UPDATE activities
      SET visibility = 'team',
          updated_at = NOW()
      WHERE external_provider = 'office365_calendar'
        AND visibility = 'private';
    `)
  }

}
