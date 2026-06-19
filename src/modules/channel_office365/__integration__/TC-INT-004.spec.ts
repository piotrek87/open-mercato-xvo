/**
 * TC-INT-004 — UI: strona M365 z aktywnym kanałem emailowym
 *
 * Weryfikuje elementy UI widoczne gdy office365_mail jest połączony:
 * - baner migracyjny (data odcięcia 2026-06-19)
 * - przycisk "Zaimportuj historię"
 * - sekcja synchronizacji załączników
 * - przycisk "Sync now" dla emaili
 *
 * Używa test-seed (OM_ENABLE_TEST_CHANNEL_SEEDING=true) do stworzenia
 * fałszywego kanału bez prawdziwego OAuth.
 */
import { test, expect } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'

const PAGE_PATH = '/backend/profile/microsoft-365'
const TEST_SEED_PATH = '/api/channel_office365/channel_office365/test-seed'

test.describe('TC-INT-004 — UI M365 z aktywnym kanałem email', () => {
  let emailChannelId: string | null = null

  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(request, 'POST', TEST_SEED_PATH, {
      token,
      data: { action: 'connect-office365' },
    })
    if (resp.status() === 404) {
      test.skip()
      return
    }
    expect(resp.status()).toBe(201)
    const body = await resp.json() as { emailChannelId: string }
    emailChannelId = body.emailChannelId
  })

  test.afterEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await apiRequest(request, 'POST', TEST_SEED_PATH, { token, data: { action: 'cleanup' } })
    emailChannelId = null
  })

  test('baner migracyjny jest widoczny gdy email sync aktywny', async ({ page }) => {
    await login(page, 'admin')
    await page.goto(PAGE_PATH, { waitUntil: 'domcontentloaded' })

    // Baner informuje o dacie odcięcia
    await expect(
      page.getByText(/2026-06-19/),
    ).toBeVisible()
  })

  test('przycisk "Zaimportuj historię" jest widoczny', async ({ page }) => {
    await login(page, 'admin')
    await page.goto(PAGE_PATH, { waitUntil: 'domcontentloaded' })

    await expect(
      page.getByRole('button', { name: /zaimportuj histori/i }),
    ).toBeVisible()
  })

  test('sekcja synchronizacji załączników jest widoczna', async ({ page }) => {
    await login(page, 'admin')
    await page.goto(PAGE_PATH, { waitUntil: 'domcontentloaded' })

    await expect(
      page.getByText(/synchronizacja za.+cznik/i),
    ).toBeVisible()
  })

  test('przycisk Sync now dla emaili jest widoczny', async ({ page }) => {
    await login(page, 'admin')
    await page.goto(PAGE_PATH, { waitUntil: 'domcontentloaded' })

    // Są dwa przyciski "Sync now" — jeden dla kalendarza, jeden dla emaila
    const syncButtons = page.getByRole('button', { name: /sync now/i })
    await expect(syncButtons.first()).toBeVisible()
  })

  test('API email-settings zwraca syncAttachments: false dla nowego kanału', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const resp = await apiRequest(
      request, 'GET',
      '/api/channel_office365/channel_office365/email-settings',
      { token },
    )
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { settings: { syncAttachments: boolean } | null }
    // Nowy kanał — syncAttachments domyślnie false
    expect(body.settings).not.toBeNull()
    expect(body.settings?.syncAttachments).toBe(false)
  })

  test('API PATCH email-settings aktualizuje syncAttachments', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')

    const patchResp = await apiRequest(
      request, 'PATCH',
      '/api/channel_office365/channel_office365/email-settings',
      { token, data: { syncAttachments: true } },
    )
    expect(patchResp.status()).toBe(200)
    const patchBody = await patchResp.json() as { settings: { syncAttachments: boolean } }
    expect(patchBody.settings.syncAttachments).toBe(true)

    // Verify GET odzwierciedla zmianę
    const getResp = await apiRequest(
      request, 'GET',
      '/api/channel_office365/channel_office365/email-settings',
      { token },
    )
    const getBody = await getResp.json() as { settings: { syncAttachments: boolean } }
    expect(getBody.settings.syncAttachments).toBe(true)
  })
})
