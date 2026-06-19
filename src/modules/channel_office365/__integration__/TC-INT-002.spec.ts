/**
 * TC-INT-002 — provision-email-channel API: brak kanału kalendarza
 *
 * Weryfikuje że POST /provision-email-channel zwraca 422 gdy użytkownik
 * nie ma połączonego konta M365 (brak kanału office365).
 *
 * Testuje też RBAC — endpoint wymaga channel_office365.manage.
 */
import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'

const PROVISION_PATH = '/api/channel_office365/channel_office365/provision-email-channel'

test.describe('TC-INT-002 — provision-email-channel API', () => {
  test('zwraca 422 gdy brak kanału kalendarza office365', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(request, 'POST', PROVISION_PATH, {
      token,
      data: {},
    })

    // 422 = brak kanału kalendarza (użytkownik nie połączył M365)
    expect(resp.status()).toBe(422)
    const body = await resp.json() as { error: string }
    expect(body.error).toBe('no_calendar_channel')
  })

  test('zwraca 401 bez tokena', async ({ request }) => {
    const resp = await request.post(PROVISION_PATH, {
      data: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(resp.status()).toBe(401)
  })

  test('me/channels zwraca pustą listę gdy brak połączeń', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(request, 'GET', '/api/communication_channels/me/channels', { token })

    expect(resp.status()).toBe(200)
    const body = await resp.json() as { items: unknown[]; total: number }
    // Kanały office365 i office365_mail nie istnieją (brak OAuth)
    const items = body.items ?? []
    const o365Channels = items.filter(
      (c: unknown) => (c as { providerKey?: string }).providerKey === 'office365' ||
                      (c as { providerKey?: string }).providerKey === 'office365_mail',
    )
    expect(o365Channels).toHaveLength(0)
  })
})
