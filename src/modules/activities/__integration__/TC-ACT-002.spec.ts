/**
 * TC-ACT-002 — GET /api/activities/export
 *
 * Validates the CSV export endpoint:
 * - Content-Type: text/csv
 * - Content-Disposition: attachment; filename="activities.csv"
 * - First row matches the 18-column header definition
 */
import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'

const EXPECTED_COLUMNS = [
  'id', 'subject', 'activity_type', 'lifecycle_mode', 'status',
  'owner_user_id', 'author_user_id', 'due_at', 'occurred_at',
  'completed_at', 'duration_minutes', 'location', 'visibility',
  'linked_entity_type', 'linked_entity_id', 'source_type',
  'created_at', 'updated_at',
]

test.describe('TC-ACT-002 — GET /api/activities/export — CSV download', () => {
  test('returns text/csv with attachment header and correct column row', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(request, 'GET', '/api/activities/export', { token })

    expect(resp.status()).toBe(200)

    const contentType = resp.headers()['content-type'] ?? ''
    expect(contentType).toContain('text/csv')

    const disposition = resp.headers()['content-disposition'] ?? ''
    expect(disposition).toContain('attachment')
    expect(disposition).toContain('activities.csv')

    const text = await resp.text()
    const headerRow = text.split('\n')[0].trim()
    expect(headerRow).toBe(EXPECTED_COLUMNS.join(','))
  })

  test('returns 401 without authentication', async ({ request }) => {
    const resp = await request.get('/api/activities/export')
    expect(resp.status()).toBe(401)
  })
})
