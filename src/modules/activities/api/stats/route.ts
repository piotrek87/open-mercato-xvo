import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerDeal } from '@open-mercato/core/modules/customers/data/entities'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { activitiesTag } from '../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['activities.view'] },
}

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  organizationId: z.string().uuid().optional(),
  // 'mine' = the signed-in user's own activities/deals (salesperson cockpit);
  // 'team' = the whole organization (management view).
  scope: z.enum(['mine', 'team']).default('mine'),
})

const COLD_DAYS = 14

type TypeRow = { activity_type: string; count: string }
type OwnerRow = { owner_user_id: string | null; count: string }
type TrendRow = { week: string; count: string }
type AttentionRow = { deal_id: string; last_activity: string | null; days_cold: string | null }

export async function GET(request: Request) {
  try {
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(request.url)
    const parseResult = querySchema.safeParse({
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      organizationId: url.searchParams.get('organizationId') ?? undefined,
      scope: url.searchParams.get('scope') ?? undefined,
    })
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid query params', details: parseResult.error.issues }, { status: 400 })
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const conn = em.getConnection()

    const tenantId = auth.tenantId
    // Follow the active organization switcher (falls back to the token org, then tenant-wide for
    // superadmins with no org context). Query override wins for deep links.
    const orgScope = await resolveOrganizationScopeForRequest({ container, auth, request })
    const orgId = parseResult.data.organizationId ?? orgScope?.selectedId ?? auth.orgId ?? null
    const mine = parseResult.data.scope === 'mine'
    const userId = (auth.sub as string | undefined) ?? null

    const from = parseResult.data.from ? new Date(parseResult.data.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const to = parseResult.data.to ? new Date(parseResult.data.to) : new Date()

    // Reusable scope fragments. `mine` narrows by owner; absent org = tenant-wide (superadmin).
    const scopeSql = (alias = ''): { where: string; params: unknown[] } => {
      const p = alias ? `${alias}.` : ''
      const parts = [`${p}tenant_id = ?`, `${p}deleted_at IS NULL`]
      const params: unknown[] = [tenantId]
      if (orgId) { parts.push(`${p}organization_id = ?`); params.push(orgId) }
      if (mine && userId) { parts.push(`${p}owner_user_id = ?`); params.push(userId) }
      return { where: parts.join(' AND '), params }
    }

    // Date-range variant (for volume/trend/completion in the selected window).
    const ranged = (): { where: string; params: unknown[] } => {
      const base = scopeSql()
      return { where: `${base.where} AND effective_date >= ? AND effective_date <= ?`, params: [...base.params, from, to] }
    }

    const base = scopeSql()
    const range = ranged()

    // --- KPI: total activities (range) ---
    const [totalRow] = await conn.execute<Array<{ total: string }>>(
      `SELECT COUNT(*) AS total FROM activities WHERE ${range.where}`,
      range.params,
      'all',
    )

    // --- KPI: task completion (range) — tasks ONLY, so emails/meetings (which never "complete")
    // don't drag the rate to zero. ---
    const [taskRow] = await conn.execute<Array<{ task_total: string; task_completed: string }>>(
      `SELECT COUNT(*) AS task_total,
              COUNT(*) FILTER (WHERE status = 'completed') AS task_completed
         FROM activities
        WHERE ${range.where} AND lifecycle_mode = 'task'`,
      range.params,
      'all',
    )

    // --- KPI: overdue tasks (not range-bound; an overdue task is overdue regardless of window) ---
    const [overdueRow] = await conn.execute<Array<{ overdue: string }>>(
      `SELECT COUNT(*) AS overdue
         FROM activities
        WHERE ${base.where}
          AND lifecycle_mode = 'task'
          AND status NOT IN ('completed', 'cancelled')
          AND due_at IS NOT NULL
          AND due_at < NOW()`,
      base.params,
      'all',
    )

    // --- Volume by activity type (range) ---
    const volumeByType = await conn.execute<TypeRow[]>(
      `SELECT activity_type, COUNT(*) AS count
         FROM activities
        WHERE ${range.where}
        GROUP BY activity_type
        ORDER BY count DESC`,
      range.params,
      'all',
    )

    // --- Trend: activities per ISO week across the range ---
    const trend = await conn.execute<TrendRow[]>(
      `SELECT to_char(date_trunc('week', effective_date), 'YYYY-MM-DD') AS week, COUNT(*) AS count
         FROM activities
        WHERE ${range.where}
        GROUP BY 1
        ORDER BY 1`,
      range.params,
      'all',
    )

    // --- Team leaderboard (team scope only): activities per owner ---
    const leaderboard = mine
      ? []
      : await conn.execute<OwnerRow[]>(
          `SELECT owner_user_id, COUNT(*) AS count
             FROM activities
            WHERE ${range.where} AND owner_user_id IS NOT NULL
            GROUP BY owner_user_id
            ORDER BY count DESC
            LIMIT 20`,
          range.params,
          'all',
        )

    // --- Deal scope fragments (against customer_deals, open deals only) ---
    const dealScope = (): { where: string; params: unknown[] } => {
      const parts = ['d.tenant_id = ?', 'd.deleted_at IS NULL', "d.status = 'open'"]
      const params: unknown[] = [tenantId]
      if (orgId) { parts.push('d.organization_id = ?'); params.push(orgId) }
      if (mine && userId) { parts.push('d.owner_user_id = ?'); params.push(userId) }
      return { where: parts.join(' AND '), params }
    }

    // --- Deal coverage: share of open deals with at least one activity in the last COLD_DAYS ---
    const ds = dealScope()
    const [coverageRow] = await conn.execute<Array<{ total_open: string; covered: string }>>(
      `SELECT COUNT(*) AS total_open,
              COUNT(*) FILTER (WHERE recent.has_recent IS NOT NULL) AS covered
         FROM customer_deals d
         LEFT JOIN LATERAL (
           SELECT 1 AS has_recent FROM activities a
            WHERE a.linked_entity_type = 'customers.deal' AND a.linked_entity_id = d.id
              AND a.deleted_at IS NULL AND a.effective_date >= NOW() - INTERVAL '${COLD_DAYS} days'
            LIMIT 1
         ) recent ON TRUE
        WHERE ${ds.where}`,
      ds.params,
      'all',
    )

    // --- Deals needing attention: open deals with NO activity in COLD_DAYS (incl. never touched) ---
    // Titles are encrypted at rest, so we only aggregate by id here and decrypt the titles separately
    // (raw SQL on customer_deals.title would return ciphertext).
    const attention = await conn.execute<AttentionRow[]>(
      `SELECT d.id AS deal_id,
              to_char(MAX(a.effective_date), 'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_activity,
              CASE WHEN MAX(a.effective_date) IS NULL THEN NULL
                   ELSE EXTRACT(DAY FROM (NOW() - MAX(a.effective_date)))::int END AS days_cold
         FROM customer_deals d
         LEFT JOIN activities a
           ON a.linked_entity_type = 'customers.deal' AND a.linked_entity_id = d.id AND a.deleted_at IS NULL
        WHERE ${ds.where}
        GROUP BY d.id
       HAVING MAX(a.effective_date) IS NULL OR MAX(a.effective_date) < NOW() - INTERVAL '${COLD_DAYS} days'
        ORDER BY MAX(a.effective_date) ASC NULLS FIRST
        LIMIT 20`,
      ds.params,
      'all',
    )

    // Resolve decrypted deal titles for the attention list (title is an encrypted column).
    const attentionIds = (attention ?? []).map((r) => r.deal_id)
    const titleById = new Map<string, string>()
    if (attentionIds.length > 0) {
      const deals = await findWithDecryption(
        em,
        CustomerDeal,
        { id: { $in: attentionIds }, tenantId, ...(orgId ? { organizationId: orgId } : {}) } as never,
        undefined,
        { tenantId, organizationId: orgId ?? null },
      )
      for (const d of deals as Array<{ id: string; title?: string | null }>) {
        if (d.title) titleById.set(d.id, d.title)
      }
    }

    const taskTotal = Number(taskRow?.task_total ?? 0)
    const taskCompleted = Number(taskRow?.task_completed ?? 0)
    const totalOpen = Number(coverageRow?.total_open ?? 0)
    const covered = Number(coverageRow?.covered ?? 0)

    return NextResponse.json({
      data: {
        scope: parseResult.data.scope,
        kpis: {
          total: Number(totalRow?.total ?? 0),
          taskTotal,
          taskCompleted,
          taskCompletionRate: taskTotal > 0 ? Math.round((taskCompleted / taskTotal) * 100) : null,
          overdue: Number(overdueRow?.overdue ?? 0),
          coverage: { totalOpen, covered, rate: totalOpen > 0 ? Math.round((covered / totalOpen) * 100) : null },
        },
        volumeByType: (volumeByType ?? []).map((r) => ({ activityType: r.activity_type, count: Number(r.count) })),
        trend: (trend ?? []).map((r) => ({ week: r.week, count: Number(r.count) })),
        leaderboard: (leaderboard ?? []).map((r) => ({ ownerUserId: r.owner_user_id, count: Number(r.count) })),
        dealsNeedingAttention: (attention ?? []).map((r) => ({
          dealId: r.deal_id,
          title: titleById.get(r.deal_id) ?? null,
          lastActivity: r.last_activity,
          daysCold: r.days_cold !== null ? Number(r.days_cold) : null,
        })),
        period: { from: from.toISOString(), to: to.toISOString() },
        coldDays: COLD_DAYS,
      },
    })
  } catch (error) {
    console.error('activities.stats failed', error)
    return NextResponse.json({ error: 'Failed to load stats' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: activitiesTag,
  summary: 'Activity analytics — KPIs, volume, trend, leaderboard, deal coverage, deals needing attention',
  description: 'Returns activity KPIs (with task-based completion), volume by type, weekly trend, team leaderboard, deal coverage, and open deals needing attention. Scope: mine (owner) or team (organization).',
  methods: {
    GET: {
      responses: [
        { status: 200, description: 'Stats payload' },
        { status: 401, description: 'Unauthorized' },
      ],
    },
  },
}
