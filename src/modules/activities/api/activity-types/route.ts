import { NextResponse, NextRequest } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { hasFeature } from '@open-mercato/shared/security/features'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'
import { getAllActivityTypes } from '@/.mercato/generated/activity-types.generated'
import type { ActivityTypeDefinition } from '../../activity-types'
import { ActivityTypeDefinitionRecord } from '../../data/entities'
import {
  ACTIVITY_TYPE_DEFS_CACHE_KEY_ACTIVE,
  ACTIVITY_TYPE_DEFS_CACHE_KEY_ALL,
  ACTIVITY_TYPE_DEFS_CACHE_TAG,
} from './cache'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['activities.view'] },
}

function mapDbRecordToDefinition(r: ActivityTypeDefinitionRecord): ActivityTypeDefinition {
  return {
    id: r.typeId,
    moduleId: r.moduleId,
    label: r.label,
    icon: r.icon,
    color: r.color ?? undefined,
    lifecycleMode: r.lifecycleMode,
    capabilities: r.capabilities,
    viewFeature: r.viewFeature ?? undefined,
    createFeature: r.createFeature ?? undefined,
    filterLabel: r.filterLabel ?? undefined,
    filterGroup: r.filterGroup ?? undefined,
  }
}

async function fetchL3Types(
  em: EntityManager,
  tenantId: string,
  orgId: string | null | undefined,
  includeInactive: boolean,
): Promise<ActivityTypeDefinition[]> {
  const where: Record<string, unknown> = {
    tenantId,
    organizationId: orgId,
  }
  if (!includeInactive) {
    where['isActive'] = true
  }
  const records = await em.find(
    ActivityTypeDefinitionRecord,
    where,
    { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  )
  return records.map(mapDbRecordToDefinition)
}

type CacheService = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown, opts?: { tags?: string[] }) => Promise<void>
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
    const includeInactive = searchParams.get('includeInactive') === 'true'

    const userFeatures: string[] = Array.isArray((auth as Record<string, unknown>)['features'])
      ? ((auth as Record<string, unknown>)['features'] as string[])
      : []

    const container = await createRequestContainer()
    const cacheService = container.resolve('cacheService') as CacheService
    const em = (container.resolve('em') as EntityManager).fork()

    // --- Cache lookup ---
    const tenantId = auth.tenantId
    const orgId = auth.orgId ?? null
    const cacheKey = includeInactive
      ? ACTIVITY_TYPE_DEFS_CACHE_KEY_ALL(tenantId, orgId ?? 'noorg')
      : ACTIVITY_TYPE_DEFS_CACHE_KEY_ACTIVE(tenantId, orgId ?? 'noorg')

    let l3Types: ActivityTypeDefinition[] | null = null
    try {
      const cached = await cacheService.get(cacheKey)
      if (cached && Array.isArray(cached)) {
        l3Types = cached as ActivityTypeDefinition[]
      }
    } catch {
      // Cache miss or error — fall through to DB
    }

    if (l3Types === null) {
      l3Types = await fetchL3Types(em, tenantId, orgId, includeInactive)
      try {
        await cacheService.set(cacheKey, l3Types, {
          tags: [
            `tenant:${tenantId}`,
            ACTIVITY_TYPE_DEFS_CACHE_TAG(tenantId, orgId ?? 'noorg'),
          ],
        })
      } catch {
        // Non-fatal — next request will re-fetch
      }
    }

    // --- Merge L1+L2 (built-in) with L3 (DB) ---
    // L1+L2 always win on id collision
    const builtInTypes = getAllActivityTypes()
    const builtInIds = new Set(builtInTypes.map((t) => t.id))

    const l3Filtered = l3Types.filter((t) => {
      if (builtInIds.has(t.id)) {
        console.warn(`[activities] L3 type "${t.id}" conflicts with a built-in type — skipping L3 entry`)
        return false
      }
      return true
    })

    let types: ActivityTypeDefinition[] = [...builtInTypes, ...l3Filtered]

    // --- RBAC filter: exclude types where user lacks viewFeature ---
    types = types.filter((t) => {
      if (!t.viewFeature) return true
      return hasFeature(userFeatures, t.viewFeature)
    })

    // --- Optional filters ---
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
  summary: 'Activity type registry (L1+L2+L3)',
  methods: {
    GET: {
      summary: 'List activity types',
      description: 'Returns merged registry: built-in types (L1+L2) plus tenant-scoped custom types (L3). Pass includeInactive=true to include deactivated L3 types (for timeline rendering).',
      responses: [{ status: 200, description: 'Activity types', schema: z.object({ data: z.array(typeResponseSchema), total: z.number() }) }],
    },
  },
}
