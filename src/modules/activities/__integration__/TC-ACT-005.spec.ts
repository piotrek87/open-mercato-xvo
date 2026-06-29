/**
 * TC-ACT-005 — CI bridge enricher: _activities.linkedActivity
 *
 * Verifies that the activities CI bridge enricher correctly annotates
 * customer interaction list responses when a bridging Activity exists with:
 *   externalId = interaction.id
 *   sourceType  = 'customer_interaction_import'
 *
 * The interactions list endpoint (GET /api/customers/interactions) calls
 * applyResponseEnrichers('customers.interaction', ...) which triggers the
 * enricher registered in src/modules/activities/data/enrichers.ts.
 */
import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityByBody } from '@open-mercato/core/helpers/integration/crmFixtures'

test.describe('TC-ACT-005 — CI enricher adds _activities.linkedActivity', () => {
  test.describe.configure({ mode: 'serial' })

  let companyId: string | null = null
  let interactionId: string | null = null
  let activityId: string | null = null

  test.beforeAll(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')

    // Company fixture — interactions require a linked entity
    companyId = await createCompanyFixture(request, token, 'TC-ACT-005 Test Company')

    // Create a customer interaction
    const ciResp = await apiRequest(request, 'POST', '/api/customers/interactions', {
      token,
      data: { entityId: companyId, interactionType: 'call' },
    })
    expect(ciResp.status()).toBe(201)
    const ciBody = await ciResp.json() as { id: string }
    interactionId = ciBody.id

    // Create an Activity bridged to that interaction via externalId
    const actResp = await apiRequest(request, 'POST', '/api/activities', {
      token,
      data: {
        activityType: 'call',
        lifecycleMode: 'fact',
        subject: 'TC-ACT-005 CI bridge activity',
        externalId: interactionId,
        externalProvider: 'customer_interaction_import',
        sourceType: 'customer_interaction_import',
      },
    })
    expect(actResp.status()).toBe(201)
    const actBody = await actResp.json() as { data: { id: string } }
    activityId = actBody.data.id
  })

  test.afterAll(async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    if (activityId) {
      await apiRequest(request, 'DELETE', `/api/activities/${activityId}`, { token }).catch(() => null)
    }
    if (interactionId) {
      await deleteEntityByBody(request, token, '/api/customers/interactions', interactionId)
    }
    if (companyId) {
      await deleteEntityByBody(request, token, '/api/customers/companies', companyId)
    }
  })

  test('interactions list row is enriched with _activities.linkedActivity pointing to the bridge activity', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')

    // Fetch interactions filtered to the test company
    const resp = await apiRequest(
      request, 'GET',
      `/api/customers/interactions?entityId=${companyId}`,
      { token },
    )
    expect(resp.status()).toBe(200)

    const body = await resp.json() as { items: Array<Record<string, unknown>> }
    const row = body.items.find((r) => r.id === interactionId)
    expect(row).toBeDefined()

    // Enricher must have added _activities
    expect(row).toHaveProperty('_activities')
    const enriched = row!['_activities'] as Record<string, unknown>
    expect(enriched).toHaveProperty('linkedActivity')

    const linked = enriched['linkedActivity'] as { id: string; activityType: string } | null
    expect(linked).not.toBeNull()
    expect(linked?.id).toBe(activityId)
    expect(linked?.activityType).toBe('call')
  })
})
