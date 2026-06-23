/**
 * TC-ACT-003 — GET /api/activities?q= — full-text search
 *
 * Creates an activity with a UUID-tagged unique subject, then verifies:
 * - Searching by the tag returns the activity
 * - Searching for a non-existent term returns an empty list
 */
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'

const UNIQUE_TAG = randomUUID().slice(0, 8)
const UNIQUE_SUBJECT = `TC-ACT-003-search-${UNIQUE_TAG}`

test.describe('TC-ACT-003 — GET /api/activities?q= — full-text search', () => {
  test.describe.configure({ mode: 'serial' })

  let activityId: string | null = null

  test.beforeAll(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(request, 'POST', '/api/activities', {
      token,
      data: {
        activityType: 'note',
        lifecycleMode: 'fact',
        subject: UNIQUE_SUBJECT,
      },
    })
    expect(resp.status()).toBe(201)
    const body = await resp.json() as { data: { id: string } }
    activityId = body.data.id
  })

  test.afterAll(async ({ request }) => {
    if (!activityId) return
    const token = await getAuthToken(request, 'admin')
    await apiRequest(request, 'DELETE', `/api/activities/${activityId}`, { token }).catch(() => null)
  })

  test('searching by unique tag returns the matching activity', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(
      request, 'GET',
      `/api/activities?q=${encodeURIComponent(UNIQUE_TAG)}`,
      { token },
    )
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { data: Array<{ id: string; subject: string }> }
    const match = body.data.find((a) => a.id === activityId)
    expect(match).toBeDefined()
    expect(match?.subject).toBe(UNIQUE_SUBJECT)
  })

  test('searching for a non-existent term returns an empty data array', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(
      request, 'GET',
      '/api/activities?q=zNO_MATCH_TC_ACT_003_xyz_never_exists',
      { token },
    )
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { data: unknown[] }
    expect(body.data.length).toBe(0)
  })
})
