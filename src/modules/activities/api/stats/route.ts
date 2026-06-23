import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { activitiesTag } from '../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['activities.view'] },
}

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  organizationId: z.string().uuid().optional(),
})

type TypeRow = { activity_type: string; count: string }
type OwnerRow = { owner_user_id: string | null; count: string }
type ColdDealRow = { linked_entity_id: string; last_activity: string; days_cold: string }

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
    })
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid query params', details: parseResult.error.issues }, { status: 400 })
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const conn = em.getConnection()

    const tenantId = auth.tenantId
    const orgId = parseResult.data.organizationId ?? auth.orgId ?? null

    // Effective_date range bounds
    const from = parseResult.data.from ? new Date(parseResult.data.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const to = parseResult.data.to ? new Date(parseResult.data.to) : new Date()

    const baseWhere = orgId
      ? `tenant_id = ? AND organization_id = ? AND deleted_at IS NULL`
      : `tenant_id = ? AND deleted_at IS NULL`
    const baseParams: unknown[] = orgId ? [tenantId, orgId] : [tenantId]

    const rangeWhere = orgId
      ? `tenant_id = ? AND organization_id = ? AND deleted_at IS NULL AND effective_date >= ? AND effective_date <= ?`
      : `tenant_id = ? AND deleted_at IS NULL AND effective_date >= ? AND effective_date <= ?`
    const rangeParams: unknown[] = orgId ? [tenantId, orgId, from, to] : [tenantId, from, to]

    // --- KPI: totals ---
    const [kpiRow] = await conn.execute<Array<{ total: string; completed: string }>>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'completed') AS completed
       FROM activities
       WHERE ${rangeWhere}`,
      rangeParams,
      'all',
    )

    const [overdueRow] = await conn.execute<Array<{ overdue: string }>>(
      `SELECT COUNT(*) AS overdue
         FROM activities
        WHERE ${baseWhere}
          AND lifecycle_mode = 'task'
          AND status NOT IN ('completed', 'cancelled')
          AND due_at IS NOT NULL
          AND due_at < NOW()`,
      baseParams,
      'all',
    )

    // --- Volume by activity type ---
    const volumeByType = await conn.execute<TypeRow[]>(
      `SELECT activity_type, COUNT(*) AS count
         FROM activities
        WHERE ${rangeWhere}
        GROUP BY activity_type
        ORDER BY count DESC`,
      rangeParams,
      'all',
    )

    // --- Team leaderboard: activities per owner ---
    const leaderboard = await conn.execute<OwnerRow[]>(
      `SELECT owner_user_id, COUNT(*) AS count
         FROM activities
        WHERE ${rangeWhere}
          AND owner_user_id IS NOT NULL
        GROUP BY owner_user_id
        ORDER BY count DESC
        LIMIT 20`,
      rangeParams,
      'all',
    )

    // --- Deals going cold: linked deals with no activity in 14+ days ---
    const coldDeals = await conn.execute<ColdDealRow[]>(
      `SELECT linked_entity_id,
              MAX(effective_date) AS last_activity,
              EXTRACT(DAY FROM (NOW() - MAX(effective_date)))::int AS days_cold
         FROM activities
        WHERE ${baseWhere}
          AND linked_entity_type = 'customers.deal'
          AND linked_entity_id IS NOT NULL
        GROUP BY linked_entity_id
        HAVING MAX(effective_date) < NOW() - INTERVAL '14 days'
        ORDER BY days_cold DESC
        LIMIT 20`,
      baseParams,
      'all',
    )

    return NextResponse.json({
      data: {
        kpis: {
          total: Number(kpiRow?.total ?? 0),
          completed: Number(kpiRow?.completed ?? 0),
          overdue: Number(overdueRow?.overdue ?? 0),
        },
        volumeByType: (volumeByType ?? []).map((r) => ({
          activityType: r.activity_type,
          count: Number(r.count),
        })),
        leaderboard: (leaderboard ?? []).map((r) => ({
          ownerUserId: r.owner_user_id,
          count: Number(r.count),
        })),
        coldDeals: (coldDeals ?? []).map((r) => ({
          linkedEntityId: r.linked_entity_id,
          lastActivity: r.last_activity,
          daysCold: Number(r.days_cold),
        })),
        period: { from: from.toISOString(), to: to.toISOString() },
      },
    })
  } catch (error) {
    console.error('activities.stats failed', error)
    return NextResponse.json({ error: 'Failed to load stats' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: activitiesTag,
  summary: 'Activity analytics — volume, leaderboard, and cold deals',
  description: 'Returns KPI totals, volume by type, team leaderboard, and deals with no recent activity.',
  methods: {
    GET: {
      responses: [
        { status: 200, description: 'Stats payload' },
        { status: 401, description: 'Unauthorized' },
      ],
    },
  },
}
