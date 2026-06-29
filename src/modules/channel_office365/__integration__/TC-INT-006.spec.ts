/**
 * TC-INT-006 — CRM auto-link: email od poznanego kontaktu tworzy CustomerInteraction
 *
 * Weryfikuje end-to-end flow crm-email-linker:
 * 1. CRM person z primaryEmail
 * 2. O365 email channel (via test-seed)
 * 3. Hub emit-inbound z adresem osoby w "from"
 * 4. Oczekiwanie na przetworzenie kolejki events przez dev server workers
 * 5. CustomerInteraction pojawia się na profilu osoby
 *
 * Wymaga:
 * - OM_ENABLE_TEST_CHANNEL_SEEDING=true
 * - `yarn dev` z aktywnym queue workerem events
 *
 * Polling zastępuje drainIntegrationQueue — dev server przetwarza eventy
 * automatycznie, więc drain in-process spowodowałby race condition i timeout
 * boostrappowania >20s.
 */
import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'
import { createPersonFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import {
  isChannelSeedingAvailable,
  seedInboundMessage,
  deleteChannelIfExists,
} from '@open-mercato/core/helpers/integration/communicationChannelsFixtures'

const TEST_SEED_PATH = '/api/channel_office365/channel_office365/test-seed'

test.describe('TC-INT-006 — CRM auto-link po emailu od kontaktu', () => {
  let token: string
  let personId: string | null = null
  let emailChannelId: string | null = null

  test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request, 'admin')
  })

  test.afterEach(async ({ request }) => {
    if (personId) {
      await deleteEntityIfExists(request, token, '/api/customers/people', personId)
      personId = null
    }
    if (emailChannelId) {
      await deleteChannelIfExists(request, token, emailChannelId)
      emailChannelId = null
    }
    await apiRequest(request, 'POST', TEST_SEED_PATH, { token, data: { action: 'cleanup' } })
  })

  test('email od kontaktu tworzy CustomerInteraction', async ({ request }) => {
    // Guard: test-seeding must be enabled
    const seedingOn = await isChannelSeedingAvailable(request, token)
    if (!seedingOn) {
      test.skip()
      return
    }

    // 1. Create CRM person with a known primaryEmail
    const stamp = Date.now()
    const personEmail = `test-o365-crm-${stamp}@example.com`

    personId = await createPersonFixture(request, token, {
      firstName: 'TestO365',
      lastName: `CRM${stamp}`,
      displayName: `TestO365 CRM${stamp}`,
    })

    // Add primaryEmail via PUT (people route uses PUT with id in body)
    const updateResp = await apiRequest(request, 'PUT', '/api/customers/people', {
      token,
      data: { id: personId, primaryEmail: personEmail },
    })
    expect(updateResp.status()).toBe(200)

    // 2. Seed O365 email channel
    const o365Resp = await apiRequest(request, 'POST', TEST_SEED_PATH, {
      token,
      data: { action: 'connect-office365' },
    })
    expect(o365Resp.status()).toBe(201)
    const { emailChannelId: eci } = await o365Resp.json() as {
      emailChannelId: string
      calendarChannelId: string
    }
    emailChannelId = eci

    // 3. Emit inbound message via hub test-seed — also enqueues events queue job
    const { channelLinkId } = await seedInboundMessage(request, token, {
      channelId: emailChannelId,
      from: personEmail,
      subject: `TC-INT-006 test email ${stamp}`,
      providerKey: 'office365_mail',
    })
    expect(channelLinkId).toBeTruthy()

    const expectedSource = `office365:mail:${channelLinkId}`

    // 4+5. Poll until CustomerInteraction with the expected source appears.
    //      Dev server queue workers (yarn dev) process the events queue automatically.
    //      Polling avoids race condition with in-process drainIntegrationQueue.
    await expect
      .poll(
        async () => {
          const ciResp = await apiRequest(
            request,
            'GET',
            `/api/customers/interactions?entityId=${personId}&channelProviderKey=office365_mail`,
            { token },
          )
          if (!ciResp.ok()) return false
          const body = await ciResp.json() as { items?: Array<{ source?: string }> }
          return (body.items ?? []).some((ci) => ci.source === expectedSource)
        },
        { message: `CustomerInteraction source=${expectedSource} not found`, timeout: 15000, intervals: [1000, 2000, 2000, 2000, 2000] },
      )
      .toBe(true)
  })

  test('email od nieznanego adresu NIE tworzy CustomerInteraction', async ({ request }) => {
    const seedingOn = await isChannelSeedingAvailable(request, token)
    if (!seedingOn) {
      test.skip()
      return
    }

    // Seed O365 email channel (no matching CRM person)
    const o365Resp = await apiRequest(request, 'POST', TEST_SEED_PATH, {
      token,
      data: { action: 'connect-office365' },
    })
    expect(o365Resp.status()).toBe(201)
    const { emailChannelId: eci } = await o365Resp.json() as { emailChannelId: string }
    emailChannelId = eci

    const stamp = Date.now()
    const unknownEmail = `nobody-${stamp}@unknown-domain-xyz.com`

    const { channelLinkId } = await seedInboundMessage(request, token, {
      channelId: emailChannelId,
      from: unknownEmail,
      subject: `TC-INT-006 unknown email ${stamp}`,
      providerKey: 'office365_mail',
    })
    expect(channelLinkId).toBeTruthy()

    const expectedSource = `office365:mail:${channelLinkId}`

    // Wait briefly for potential processing, then assert CI was NOT created
    // Using 3s wait (enough for queue workers to run if they would)
    await new Promise((resolve) => setTimeout(resolve, 3000))

    const ciResp = await apiRequest(
      request,
      'GET',
      `/api/customers/interactions?channelProviderKey=office365_mail`,
      { token },
    )
    expect(ciResp.status()).toBe(200)
    const ciBody = await ciResp.json() as { items?: Array<{ source?: string }> }
    const found = (ciBody.items ?? []).find((ci) => ci.source === expectedSource)
    expect(found).toBeUndefined()
  })
})
