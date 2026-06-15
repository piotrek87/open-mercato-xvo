import { NextResponse, NextRequest } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { hasFeature } from '@open-mercato/shared/security/features'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'
import { getAllActivityTypes } from '@/.mercato/generated/activity-types.generated'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['activities.view'] },
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const moduleId = searchParams.get('moduleId') ?? undefined
    const lifecycleMode = searchParams.get('lifecycleMode') ?? undefined

    const userFeatures: string[] = Array.isArray((auth as Record<string, unknown>)['features'])
      ? ((auth as Record<string, unknown>)['features'] as string[])
      : []

    let types = getAllActivityTypes()

    // RBAC filter: exclude types with viewFeature the user doesn't have
    types = types.filter((t) => {
      if (!t.viewFeature) return true
      return hasFeature(userFeatures, t.viewFeature)
    })

    if (moduleId) {
      types = types.filter((t) => t.moduleId === moduleId)
    }

    if (lifecycleMode === 'fact' || lifecycleMode === 'task') {
      types = types.filter((t) => t.lifecycleMode === lifecycleMode)
    }

    return NextResponse.json({ data: types, total: types.length })
  } catch (error) {
    console.error('activity_types.list failed', error)
    return NextResponse.json({ error: 'Failed to list activity types' }, { status: 500 })
  }
}

const typeResponseSchema = z.object({
  id: z.string(),
  moduleId: z.string(),
  label: z.string(),
  icon: z.string(),
  color: z.string().optional(),
  lifecycleMode: z.enum(['fact', 'task']),
  capabilities: z.record(z.string(), z.boolean().optional()),
  viewFeature: z.string().optional(),
  createFeature: z.string().optional(),
  filterLabel: z.string().optional(),
  filterIcon: z.string().optional(),
  filterGroup: z.string().optional(),
  actions: z.array(z.object({
    id: z.string(),
    label: z.string(),
    icon: z.string(),
    variant: z.enum(['default', 'outline', 'ghost', 'destructive']),
    feature: z.string().optional(),
    condition: z.string().optional(),
  })).optional(),
  primaryActionId: z.string().optional(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'activity-types',
  summary: 'Activity type registry',
  methods: {
    GET: {
      summary: 'List activity types',
      description: 'Returns all registered activity types visible to the current user (RBAC filtered).',
      responses: [{ status: 200, description: 'Activity types', schema: z.object({ data: z.array(typeResponseSchema), total: z.number() }) }],
    },
  },
}
