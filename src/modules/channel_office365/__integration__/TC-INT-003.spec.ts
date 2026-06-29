/**
 * TC-INT-003 — UI: strona ustawień Microsoft 365
 *
 * Weryfikuje że strona /backend/profile/microsoft-365 renderuje się poprawnie:
 * - pusty stan gdy brak połączenia
 * - przycisk "Connect Microsoft 365"
 * - sekcja Azure App Registration instructions
 *
 * Nie wymaga prawdziwego konta O365.
 */
import { test, expect } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'

const PAGE_PATH = '/backend/profile/microsoft-365'

test.describe('TC-INT-003 — UI strony Microsoft 365 (brak połączenia)', () => {
  test('strona ładuje się i pokazuje pusty stan', async ({ page }) => {
    await login(page, 'admin')
    await page.goto(PAGE_PATH, { waitUntil: 'domcontentloaded' })

    // Nagłówek strony
    await expect(page.getByRole('heading', { name: /microsoft 365/i })).toBeVisible()

    // Pusty stan — brak połączonego konta
    await expect(
      page.getByText(/no microsoft 365 account connected/i),
    ).toBeVisible()
  })

  test('przycisk "Connect Microsoft 365" jest widoczny', async ({ page }) => {
    await login(page, 'admin')
    await page.goto(PAGE_PATH, { waitUntil: 'domcontentloaded' })

    const connectBtn = page.getByRole('button', { name: /connect microsoft 365/i })
    await expect(connectBtn).toBeVisible()
    await expect(connectBtn).toBeEnabled()
  })

  test('sekcja instrukcji Azure App Registration jest widoczna', async ({ page }) => {
    await login(page, 'admin')
    await page.goto(PAGE_PATH, { waitUntil: 'domcontentloaded' })

    await expect(
      page.getByText(/azure app registration required/i),
    ).toBeVisible()

    // Wymagane scopy
    await expect(
      page.getByText(/mail\.readwrite/i),
    ).toBeVisible()
  })

  test('strona wymaga zalogowania — redirect do /login bez sesji', async ({ page }) => {
    await page.goto(PAGE_PATH, { waitUntil: 'domcontentloaded' })
    // Bez zalogowania powinno przekierować na stronę logowania
    await expect(page).toHaveURL(/\/login/)
  })
})
