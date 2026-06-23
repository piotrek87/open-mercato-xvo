/**
 * TC-ACT-004 — GET /api/activities?overdue=true — overdue filter
 *
 * Creates a task-mode activity with a dueAt 2 days in the past, then verifies:
 * - It appears in the overdue list
 * - All results in the overdue list have past dueAt and non-terminal status
 */
import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'

test.describe('TC-ACT-004 — GET /api/activities?overdue=true — overdue filter', () => {
  test.describe.configure({ mode: 'serial' })

  let taskId: string | null = null

  test.beforeAll(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    // Past dueAt: 2 days ago
    const pastDue = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const resp = await apiRequest(request, 'POST', '/api/activities', {
      token,
      data: {
        activityType: 'task',
        lifecycleMode: 'task',
        subject: 'TC-ACT-004 overdue task fixture',
        dueAt: pastDue,
        status: 'not_started',
      },
    })
    expect(resp.status()).toBe(201)
    const body = await resp.json() as { data: { id: string } }
    taskId = body.data.id
  })

  test.afterAll(async ({ request }) => {
    if (!taskId) return
    const token = await getAuthToken(request, 'admin')
    await apiRequest(request, 'DELETE', `/api/activities/${taskId}`, { token }).catch(() => null)
  })

  test('overdue=true list includes the past-due fixture task', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(request, 'GET', '/api/activities?overdue=true&limit=100', { token })
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { data: Array<{ id: string }> }
    const found = body.data.find((a) => a.id === taskId)
    expect(found).toBeDefined()
  })

  test('all overdue results have past dueAt and non-terminal status', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(request, 'GET', '/api/activities?overdue=true&limit=100', { token })
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { data: Array<{ dueAt: string | null; status: string }> }
    const now = Date.now()
    for (const item of body.data) {
      expect(item.dueAt).not.toBeNull()
      expect(new Date(item.dueAt!).getTime()).toBeLessThan(now)
      expect(['completed', 'cancelled']).not.toContain(item.status)
    }
  })
})
