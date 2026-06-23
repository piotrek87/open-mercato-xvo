/**
 * TC-ACT-006 — UI: Activity Analytics page + /backend/customer-interactions redirect
 *
 * 1. /backend/activities/stats loads and renders the page title
 * 2. /backend/customer-interactions server-redirects to /backend/activities
 */
import { test, expect } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'

test.describe('TC-ACT-006 — UI: stats page loads + customer-interactions redirect', () => {
  test('/backend/activities/stats renders the analytics page title', async ({ page }) => {
    await login(page, 'admin')
    await page.goto('/backend/activities/stats', { waitUntil: 'domcontentloaded' })

    // Page title or any KPI card label should be visible
    await expect(
      page.getByText(/Activity Analytics|Total activities|Overdue tasks/i).first(),
    ).toBeVisible()
  })

  test('/backend/customer-interactions redirects to /backend/activities', async ({ page }) => {
    await login(page, 'admin')
    await page.goto('/backend/customer-interactions', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(/\/backend\/activities/)
  })
})
