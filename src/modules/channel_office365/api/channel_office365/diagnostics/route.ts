import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['channel_office365.view'] },
}

async function safeQuery<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const data = await fn()
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: `[${label}] ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function GET(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tenantId = auth.tenantId as string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const organizationId = ((auth as any).organizationId ?? tenantId) as string

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()
  const conn = em.getConnection()

  const result: Record<string, unknown> = { tenantId, organizationId }

  // Step 1: Activity counts (ORM-based, avoids raw SQL param format issues)
  result.step1_activities = await safeQuery('activities', async () => {
    const [mailCount, calCount] = await Promise.all([
      em.count('Activity' as never, { tenantId, deletedAt: null, externalProvider: 'office365_mail' } as never),
      em.count('Activity' as never, { tenantId, deletedAt: null, externalProvider: 'office365_calendar' } as never),
    ])
    return [
      { external_provider: 'office365_mail', cnt: mailCount },
      { external_provider: 'office365_calendar', cnt: calCount },
    ]
  })

  // Step 2: Sample mail activity participants (raw with ? placeholders)
  result.step2_sampleParticipants = await safeQuery('sampleParticipants', async () => {
    const rows = await conn.execute(
      `SELECT subject, external_provider, occurred_at, participants
       FROM activities
       WHERE tenant_id = ? AND deleted_at IS NULL
         AND external_provider = 'office365_mail'
       ORDER BY occurred_at DESC NULLS LAST
       LIMIT 3`,
      [tenantId],
    ) as Array<{ subject: string; external_provider: string; occurred_at: string | null; participants: unknown }>
    return rows.map(r => ({
      subject: r.subject,
      occurredAt: r.occurred_at,
      participants: r.participants,
    }))
  })

  // Step 3: ActivityLink counts (raw with ? placeholders)
  result.step3_activityLinks = await safeQuery('activityLinks', () =>
    conn.execute(
      `SELECT al.entity_type, count(*)::int AS cnt
       FROM activity_links al
       JOIN activities a ON a.id = al.activity_id
       WHERE a.tenant_id = ? AND a.deleted_at IS NULL
         AND a.external_provider IN ('office365_mail','office365_calendar')
       GROUP BY al.entity_type`,
      [tenantId],
    ),
  )

  // Step 4: CustomerInteraction counts (raw with ? placeholders)
  result.step4_customerInteractions = await safeQuery('customerInteractions', () =>
    conn.execute(
      `SELECT interaction_type,
              count(*)::int AS total,
              count(external_message_id)::int AS with_mcl_id
       FROM customer_interactions
       WHERE tenant_id = ? AND deleted_at IS NULL AND source LIKE 'office365:%'
       GROUP BY interaction_type`,
      [tenantId],
    ),
  )

  // Step 5a: CRM persons via ORM (no encryption, just counts to check org scoping)
  result.step5a_crmPersonsRaw = await safeQuery('crmPersonsRaw', async () => {
    const [byTenantOnly, byBoth] = await Promise.all([
      em.count(CustomerEntity, { tenantId, kind: 'person', deletedAt: null }),
      em.count(CustomerEntity, { tenantId, organizationId, kind: 'person', deletedAt: null }),
    ])
    // Sample distinctOrganizationIds for person records in this tenant
    const orgRows = await em.getConnection().execute(
      `SELECT DISTINCT organization_id FROM customer_entities WHERE tenant_id = ? AND kind = 'person' AND deleted_at IS NULL LIMIT 10`,
      [tenantId],
    ) as Array<{ organization_id: string }>
    return {
      countByTenantOnly: byTenantOnly,
      countByTenantAndOrg: byBoth,
      organizationIdsInCrm: orgRows.map(r => r.organization_id),
      authOrganizationId: organizationId,
    }
  })

  // Step 5b: channel organizationId
  result.step5b_channelOrgs = await safeQuery('channelOrgs', async () => {
    const rows = await em.getConnection().execute(
      `SELECT id, organization_id, user_id FROM communication_channels WHERE tenant_id = ? AND provider_key = 'office365' AND deleted_at IS NULL LIMIT 5`,
      [tenantId],
    ) as Array<{ id: string; organization_id: string | null; user_id: string | null }>
    return rows
  })

  // Step 5c: findWithDecryption with exact scope
  result.step5c_crmPersonsDecrypted = await safeQuery('crmPersons', async () => {
    const persons = await findWithDecryption(em, CustomerEntity, {
      tenantId,
      organizationId,
      kind: 'person',
      deletedAt: null,
    }, undefined, { tenantId, organizationId })
    const withEmail = persons.filter(p => !!p.primaryEmail)
    return {
      total: persons.length,
      withEmail: withEmail.length,
      emailDomainSamples: withEmail.slice(0, 5).map(p => {
        const e = p.primaryEmail ?? ''
        const at = e.indexOf('@')
        return at > 0 ? `***@${e.slice(at + 1)}` : '***'
      }),
    }
  })

  // Step 6: Dedup index
  result.step6_dedupIndex = await safeQuery('dedupIndex', async () => {
    const rows = await conn.execute(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'customer_interactions'
         AND indexname = 'customer_interactions_o365_dedup_idx'`,
      [],
    ) as Array<{ indexname: string }>
    return { exists: rows.length > 0 }
  })

  // Step 7: Messages / MCL counts (raw with ? placeholders)
  result.step7_messageChain = await safeQuery('messageChain', async () => {
    const msgCount = await conn.execute(
      `SELECT count(*)::int AS cnt FROM messages
       WHERE tenant_id = ? AND idempotency_key IS NOT NULL`,
      [tenantId],
    ) as Array<{ cnt: number }>
    const mclCount = await conn.execute(
      `SELECT count(*)::int AS cnt FROM message_channel_links
       WHERE tenant_id = ? AND provider_key = 'office365'`,
      [tenantId],
    ) as Array<{ cnt: number }>
    return {
      messagesWithIdempotencyKey: msgCount[0]?.cnt ?? 0,
      mclOffice365: mclCount[0]?.cnt ?? 0,
    }
  })

  return NextResponse.json(result)
}

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    GET: {
      summary: 'Diagnostic info for O365 sync pipeline',
      tags: ['channel_office365'],
      responses: [{ status: 200, description: 'Diagnostic data', schema: z.object({}).passthrough() }],
    },
  },
}
