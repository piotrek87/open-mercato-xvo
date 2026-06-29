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
  type: z.string().optional(),
  status: z.string().optional(),
  organizationId: z.string().uuid().optional(),
})

const CSV_COLUMNS = [
  'id', 'subject', 'activity_type', 'lifecycle_mode', 'status',
  'owner_user_id', 'author_user_id', 'due_at', 'occurred_at',
  'completed_at', 'duration_minutes', 'location', 'visibility',
  'linked_entity_type', 'linked_entity_id', 'source_type',
  'created_at', 'updated_at',
]

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function rowToCsv(row: Record<string, unknown>): string {
  return CSV_COLUMNS.map((col) => escapeCsvCell(row[col])).join(',')
}

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
      type: url.searchParams.get('type') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      organizationId: url.searchParams.get('organizationId') ?? undefined,
    })
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid query params', details: parseResult.error.issues }, { status: 400 })
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const conn = em.getConnection()

    const { from, to, type, status, organizationId } = parseResult.data
    const tenantId = auth.tenantId
    const orgId = organizationId ?? auth.orgId ?? null

    const conditions: string[] = ['tenant_id = ?', 'deleted_at IS NULL']
    const params: unknown[] = [tenantId]

    if (orgId) {
      params.push(orgId)
      conditions.push('organization_id = ?')
    }
    if (from) {
      params.push(new Date(from))
      conditions.push('effective_date >= ?')
    }
    if (to) {
      params.push(new Date(to))
      conditions.push('effective_date <= ?')
    }
    if (type) {
      params.push(type)
      conditions.push('activity_type = ?')
    }
    if (status) {
      params.push(status)
      conditions.push('status = ?')
    }

    const sql = `SELECT ${CSV_COLUMNS.join(', ')} FROM activities WHERE ${conditions.join(' AND ')} ORDER BY effective_date DESC LIMIT 10000`
    const rows = await conn.execute<Array<Record<string, unknown>>>(sql, params, 'all')

    const header = CSV_COLUMNS.join(',')
    const lines = [header, ...(rows ?? []).map(rowToCsv)]
    const csv = lines.join('\n')

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="activities.csv"',
      },
    })
  } catch (error) {
    console.error('activities.export failed', error)
    return NextResponse.json({ error: 'Failed to export activities' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: activitiesTag,
  summary: 'Export activities as CSV',
  description: 'Downloads up to 10,000 activities as a CSV file. Filtered by date, type, and status.',
  methods: {
    GET: {
      responses: [
        { status: 200, description: 'CSV file download' },
        { status: 401, description: 'Unauthorized' },
      ],
    },
  },
}
