/**
 * TC-INT-001 — Email settings API: GET/PATCH bez kanału emailowego
 *
 * Weryfikuje że endpointy /api/channel_office365/channel_office365/email-settings
 * zwracają poprawne odpowiedzi gdy użytkownik nie ma jeszcze kanału office365_mail.
 *
 * Nie wymaga prawdziwego konta O365 — testuje zachowanie przy braku kanału.
 */
import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'

const EMAIL_SETTINGS_PATH = '/api/channel_office365/channel_office365/email-settings'

test.describe('TC-INT-001 — email-settings API (brak kanału emailowego)', () => {
  test('GET zwraca {settings: null} gdy kanał office365_mail nie istnieje', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(request, 'GET', EMAIL_SETTINGS_PATH, { token })

    expect(resp.status()).toBe(200)
    const body = await resp.json() as { settings: unknown }
    expect(body).toHaveProperty('settings')
    expect(body.settings).toBeNull()
  })

  test('PATCH zwraca 404 gdy kanał office365_mail nie istnieje', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(request, 'PATCH', EMAIL_SETTINGS_PATH, {
      token,
      data: { syncAttachments: true },
    })

    expect(resp.status()).toBe(404)
    const body = await resp.json() as { error: string }
    expect(body.error).toBe('no_email_channel')
  })

  test('GET zwraca 401 bez tokena', async ({ request }) => {
    const resp = await request.get(EMAIL_SETTINGS_PATH)
    expect(resp.status()).toBe(401)
  })

  test('PATCH odrzuca niepoprawny typ syncAttachments', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(request, 'PATCH', EMAIL_SETTINGS_PATH, {
      token,
      data: { syncAttachments: 'tak' },
    })
    // 404 bo brak kanału, albo 400 jeśli walidacja Zod wyprzedza lookup
    expect([400, 404]).toContain(resp.status())
  })
})
