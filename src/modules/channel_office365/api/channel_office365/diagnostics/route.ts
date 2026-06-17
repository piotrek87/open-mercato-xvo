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

  // Step 1: Activity counts
  result.step1_activities = await safeQuery('activities', () =>
    conn.execute(
      `SELECT external_provider, count(*)::int AS cnt
       FROM activities
       WHERE tenant_id = $1 AND organization_id = $2
         AND deleted_at IS NULL
         AND external_provider IN ('office365_mail','office365_calendar')
       GROUP BY external_provider`,
      [tenantId, organizationId],
    ),
  )

  // Step 2: Sample mail activity participants
  result.step2_sampleParticipants = await safeQuery('sampleParticipants', async () => {
    const rows = await conn.execute(
      `SELECT subject, external_provider, occurred_at, participants
       FROM activities
       WHERE tenant_id = $1 AND organization_id = $2
         AND deleted_at IS NULL
         AND external_provider = 'office365_mail'
       ORDER BY occurred_at DESC NULLS LAST
       LIMIT 3`,
      [tenantId, organizationId],
    ) as Array<{ subject: string; external_provider: string; occurred_at: string | null; participants: unknown }>
    return rows.map(r => ({
      subject: r.subject,
      occurredAt: r.occurred_at,
      participants: r.participants,
    }))
  })

  // Step 3: ActivityLink counts
  result.step3_activityLinks = await safeQuery('activityLinks', () =>
    conn.execute(
      `SELECT al.entity_type, count(*)::int AS cnt
       FROM activity_links al
       JOIN activities a ON a.id = al.activity_id
       WHERE a.tenant_id = $1 AND a.organization_id = $2
         AND a.deleted_at IS NULL
         AND a.external_provider IN ('office365_mail','office365_calendar')
       GROUP BY al.entity_type`,
      [tenantId, organizationId],
    ),
  )

  // Step 4: CustomerInteraction counts
  result.step4_customerInteractions = await safeQuery('customerInteractions', () =>
    conn.execute(
      `SELECT interaction_type,
              count(*)::int AS total,
              count(external_message_id)::int AS with_mcl_id
       FROM customer_interactions
       WHERE tenant_id = $1 AND organization_id = $2
         AND deleted_at IS NULL
         AND source LIKE 'office365:%'
       GROUP BY interaction_type`,
      [tenantId, organizationId],
    ),
  )

  // Step 5: CRM persons via findWithDecryption
  result.step5_crmPersons = await safeQuery('crmPersons', async () => {
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

  // Step 7: Messages / MCL counts
  result.step7_messageChain = await safeQuery('messageChain', async () => {
    const msgCount = await conn.execute(
      `SELECT count(*)::int AS cnt FROM messages
       WHERE tenant_id = $1 AND organization_id = $2 AND idempotency_key IS NOT NULL`,
      [tenantId, organizationId],
    ) as Array<{ cnt: number }>
    const mclCount = await conn.execute(
      `SELECT count(*)::int AS cnt FROM message_channel_links
       WHERE tenant_id = $1 AND organization_id = $2 AND provider_key = 'office365'`,
      [tenantId, organizationId],
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
