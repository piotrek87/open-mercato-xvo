/**
 * TC-INT-005 — UI: disconnect M365 kaskadowo usuwa email channel
 *
 * Weryfikuje że po kliknięciu "Disconnect" na stronie M365:
 * - strona pokazuje pusty stan
 * - email-settings API zwraca {settings: null} (email channel usunięty kaskadowo)
 *
 * Wymaga OM_ENABLE_TEST_CHANNEL_SEEDING=true.
 */
import { test, expect } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'

const PAGE_PATH = '/backend/profile/microsoft-365'
const TEST_SEED_PATH = '/api/channel_office365/channel_office365/test-seed'
const EMAIL_SETTINGS_PATH = '/api/channel_office365/channel_office365/email-settings'

test.describe('TC-INT-005 — disconnect M365 kaskadowo usuwa email channel', () => {
  test.beforeEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    // Cleanup residual test channels before each test
    await apiRequest(request, 'POST', TEST_SEED_PATH, { token, data: { action: 'cleanup' } })
  })

  test.afterEach(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    await apiRequest(request, 'POST', TEST_SEED_PATH, { token, data: { action: 'cleanup' } })
  })

  test('disconnect: strona przechodzi do pustego stanu', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const seedResp = await apiRequest(request, 'POST', TEST_SEED_PATH, {
      token,
      data: { action: 'connect-office365' },
    })
    if (seedResp.status() === 404) {
      test.skip()
      return
    }
    expect(seedResp.status()).toBe(201)

    await login(page, 'admin')
    await page.goto(PAGE_PATH, { waitUntil: 'domcontentloaded' })

    // Verify connected state is visible
    await expect(page.getByRole('button', { name: /disconnect/i })).toBeVisible()

    // Accept the browser confirm dialog automatically
    page.on('dialog', (dialog) => dialog.accept())

    // Click Disconnect button
    await page.getByRole('button', { name: /disconnect/i }).click()

    // After disconnect, empty state should appear
    await expect(
      page.getByText(/no microsoft 365 account connected/i),
    ).toBeVisible()
  })

  test('disconnect: email-settings zwraca null po odłączeniu', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const seedResp = await apiRequest(request, 'POST', TEST_SEED_PATH, {
      token,
      data: { action: 'connect-office365' },
    })
    if (seedResp.status() === 404) {
      test.skip()
      return
    }
    expect(seedResp.status()).toBe(201)

    // Verify email channel exists before disconnect
    const beforeResp = await apiRequest(request, 'GET', EMAIL_SETTINGS_PATH, { token })
    expect(beforeResp.status()).toBe(200)
    const before = await beforeResp.json() as { settings: unknown }
    expect(before.settings).not.toBeNull()

    // Perform disconnect via UI
    await login(page, 'admin')
    await page.goto(PAGE_PATH, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: /disconnect/i })).toBeVisible()
    page.on('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: /disconnect/i }).click()
    await expect(page.getByText(/no microsoft 365 account connected/i)).toBeVisible()

    // Email channel cascade: settings should now be null
    const afterResp = await apiRequest(request, 'GET', EMAIL_SETTINGS_PATH, { token })
    expect(afterResp.status()).toBe(200)
    const after = await afterResp.json() as { settings: unknown }
    expect(after.settings).toBeNull()
  })

  test('disconnect API bezpośrednio: oba kanały usuwane', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const seedResp = await apiRequest(request, 'POST', TEST_SEED_PATH, {
      token,
      data: { action: 'connect-office365' },
    })
    if (seedResp.status() === 404) {
      test.skip()
      return
    }
    expect(seedResp.status()).toBe(201)
    const { calendarChannelId, emailChannelId } = await seedResp.json() as {
      calendarChannelId: string
      emailChannelId: string
    }

    // Delete calendar channel (simulates what UI does first)
    const delCalResp = await apiRequest(
      request, 'DELETE',
      `/api/communication_channels/channels/${calendarChannelId}`,
      { token },
    )
    expect([200, 204]).toContain(delCalResp.status())

    // Delete email channel (cascade step that UI does second)
    const delMailResp = await apiRequest(
      request, 'DELETE',
      `/api/communication_channels/channels/${emailChannelId}`,
      { token },
    )
    expect([200, 204]).toContain(delMailResp.status())

    // Both gone — email-settings returns null
    const settingsResp = await apiRequest(request, 'GET', EMAIL_SETTINGS_PATH, { token })
    const body = await settingsResp.json() as { settings: unknown }
    expect(body.settings).toBeNull()
  })
})
