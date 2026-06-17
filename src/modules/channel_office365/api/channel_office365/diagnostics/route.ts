/**
 * Diagnostic endpoint — shows the state of the O365 sync pipeline so we can
 * pinpoint exactly where the chain breaks without needing direct DB access.
 *
 * Returns counts and samples for each layer:
 *   1. Activity records (externalProvider = 'office365_mail' / 'office365_calendar')
 *   2. ActivityLink records for those activities
 *   3. CustomerInteraction records with source LIKE 'office365:%'
 *   4. CRM persons with a decryptable primaryEmail
 *   5. Whether the dedup index exists
 */

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

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await getAuthFromRequest(request)
    if (!auth?.sub || !auth?.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const scope = {
      tenantId: auth.tenantId as string,
      organizationId: (auth.organizationId ?? auth.tenantId) as string,
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const conn = em.getConnection()

    // 1. Activity counts by externalProvider
    const activityRows = await conn.execute(
      `SELECT external_provider, count(*)::int AS cnt
       FROM activities
       WHERE tenant_id = $1
         AND organization_id = $2
         AND deleted_at IS NULL
         AND external_provider IN ('office365_mail', 'office365_calendar')
       GROUP BY external_provider`,
      [scope.tenantId, scope.organizationId],
    ) as Array<{ external_provider: string; cnt: number }>

    // 2. Sample activity participants (first 5 mail activities)
    const sampleActivities = await conn.execute(
      `SELECT id, subject, external_provider, occurred_at,
              participants
       FROM activities
       WHERE tenant_id = $1
         AND organization_id = $2
         AND deleted_at IS NULL
         AND external_provider = 'office365_mail'
       ORDER BY occurred_at DESC NULLS LAST
       LIMIT 5`,
      [scope.tenantId, scope.organizationId],
    ) as Array<{ id: string; subject: string; external_provider: string; occurred_at: string | null; participants: unknown }>

    // 3. ActivityLink counts for O365 activities
    const linkRows = await conn.execute(
      `SELECT al.entity_type, count(*)::int AS cnt
       FROM activity_links al
       JOIN activities a ON a.id = al.activity_id
       WHERE a.tenant_id = $1
         AND a.organization_id = $2
         AND a.deleted_at IS NULL
         AND a.external_provider IN ('office365_mail', 'office365_calendar')
       GROUP BY al.entity_type`,
      [scope.tenantId, scope.organizationId],
    ) as Array<{ entity_type: string; cnt: number }>

    // 4. CustomerInteraction counts
    const ciRows = await conn.execute(
      `SELECT interaction_type, count(*)::int AS cnt,
              count(external_message_id)::int AS with_mcl
       FROM customer_interactions
       WHERE tenant_id = $1
         AND organization_id = $2
         AND deleted_at IS NULL
         AND source LIKE 'office365:%'
       GROUP BY interaction_type`,
      [scope.tenantId, scope.organizationId],
    ) as Array<{ interaction_type: string; cnt: number; with_mcl: number }>

    // 5. CRM persons — try to decrypt and count those with primaryEmail
    let crmPersonsTotal = 0
    let crmPersonsWithEmail = 0
    let emailSample: string[] = []
    let crmError: string | null = null
    try {
      const persons = await findWithDecryption(em, CustomerEntity, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        kind: 'person',
        deletedAt: null,
      }, undefined, scope)
      crmPersonsTotal = persons.length
      const withEmail = persons.filter(p => !!p.primaryEmail)
      crmPersonsWithEmail = withEmail.length
      emailSample = withEmail.slice(0, 5).map(p => {
        const e = p.primaryEmail ?? ''
        const atIdx = e.indexOf('@')
        return atIdx > 1 ? `***@${e.slice(atIdx + 1)}` : '***'
      })
    } catch (err) {
      crmError = err instanceof Error ? err.message : String(err)
    }

    // 6. Check if the dedup index exists
    const idxRows = await conn.execute(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'customer_interactions'
         AND indexname = 'customer_interactions_o365_dedup_idx'`,
      [],
    ) as Array<{ indexname: string }>
    const dedupIndexExists = idxRows.length > 0

    // 7. Check if message-chain tables exist and have any O365 rows
    let messageRows: Array<{ cnt: number }> = []
    let mclRows: Array<{ cnt: number }> = []
    try {
      messageRows = await conn.execute(
        `SELECT count(*)::int AS cnt FROM messages
         WHERE tenant_id = $1 AND organization_id = $2
           AND idempotency_key IS NOT NULL`,
        [scope.tenantId, scope.organizationId],
      ) as Array<{ cnt: number }>
      mclRows = await conn.execute(
        `SELECT count(*)::int AS cnt FROM message_channel_links
         WHERE tenant_id = $1 AND organization_id = $2
           AND provider_key = 'office365'`,
        [scope.tenantId, scope.organizationId],
      ) as Array<{ cnt: number }>
    } catch {
      // tables might not exist
    }

    return NextResponse.json({
      scope,
      activities: activityRows,
      activitySamples: sampleActivities.map(a => ({
        subject: a.subject,
        provider: a.external_provider,
        occurredAt: a.occurred_at,
        participantCount: Array.isArray(a.participants) ? (a.participants as unknown[]).length : 0,
        participantEmails: Array.isArray(a.participants)
          ? (a.participants as Array<{ email?: string; status?: string }>)
              .map(p => ({ email: p.email, status: p.status }))
          : [],
      })),
      activityLinks: linkRows,
      customerInteractions: ciRows,
      crmPersons: {
        total: crmPersonsTotal,
        withEmail: crmPersonsWithEmail,
        emailDomainSamples: emailSample,
        error: crmError,
      },
      dedupIndexExists,
      messages: { count: messageRows[0]?.cnt ?? 0 },
      messageChannelLinks: { office365Count: mclRows[0]?.cnt ?? 0 },
    })
  } catch (err) {
    console.error('[channel_office365] diagnostics failed', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Diagnostics failed' },
      { status: 500 },
    )
  }
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
