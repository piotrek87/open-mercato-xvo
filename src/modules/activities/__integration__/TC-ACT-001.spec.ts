/**
 * TC-ACT-001 — GET /api/activities/stats
 *
 * Validates the analytics endpoint returns the expected response shape:
 * kpis (total, completed, overdue), volumeByType, leaderboard, coldDeals, period.
 */
import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'

test.describe('TC-ACT-001 — GET /api/activities/stats — response shape', () => {
  test('returns all required fields with correct types', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(request, 'GET', '/api/activities/stats', { token })

    expect(resp.status()).toBe(200)

    const body = await resp.json() as { data: Record<string, unknown> }
    const data = body.data

    // kpis
    const kpis = data.kpis as Record<string, unknown>
    expect(typeof kpis.total).toBe('number')
    expect(typeof kpis.completed).toBe('number')
    expect(typeof kpis.overdue).toBe('number')

    // arrays
    expect(Array.isArray(data.volumeByType)).toBe(true)
    expect(Array.isArray(data.leaderboard)).toBe(true)
    expect(Array.isArray(data.coldDeals)).toBe(true)

    // period with ISO dates
    const period = data.period as Record<string, string>
    expect(typeof period.from).toBe('string')
    expect(typeof period.to).toBe('string')
    expect(new Date(period.from).getTime()).not.toBeNaN()
    expect(new Date(period.to).getTime()).not.toBeNaN()
  })

  test('empty date range returns zero totals and reflects requested period', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const from = '1900-01-01T00:00:00.000Z'
    const to = '1900-01-31T23:59:59.999Z'
    const resp = await apiRequest(request, 'GET', `/api/activities/stats?from=${from}&to=${to}`, { token })

    expect(resp.status()).toBe(200)
    const body = await resp.json() as {
      data: { kpis: { total: number }; period: { from: string; to: string } }
    }
    expect(body.data.kpis.total).toBe(0)
    expect(body.data.period.from).toBe(from)
    expect(body.data.period.to).toBe(to)
  })

  test('returns 401 without authentication', async ({ request }) => {
    const resp = await request.get('/api/activities/stats')
    expect(resp.status()).toBe(401)
  })
})
