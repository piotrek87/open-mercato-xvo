import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'
import { ActivityTypeDefinitionRecord } from '../../data/entities'
import { activityTypeDefinitionCreateSchema } from '../../data/validators'
import { invalidateActivityTypeDefsCache } from '../activity-types/cache'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['activities.view'] },
  POST: { requireAuth: true, requireFeatures: ['activities.manage_types'] },
}

const listQuerySchema = z.object({
  isActive: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

function mapRecordToResponse(r: ActivityTypeDefinitionRecord) {
  return {
    id: r.id,
    typeId: r.typeId,
    moduleId: r.moduleId,
    label: r.label,
    icon: r.icon,
    color: r.color ?? null,
    lifecycleMode: r.lifecycleMode,
    capabilities: r.capabilities,
    viewFeature: r.viewFeature ?? null,
    createFeature: r.createFeature ?? null,
    filterLabel: r.filterLabel ?? null,
    filterGroup: r.filterGroup ?? null,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
    organizationId: r.organizationId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function GET(request: Request) {
  try {
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(request.url)
    const query = listQuerySchema.parse(Object.fromEntries(url.searchParams))

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const where: Record<string, unknown> = {
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
    }

    if (query.isActive !== undefined) {
      where['isActive'] = query.isActive === 'true'
    }

    const [records, total] = await em.findAndCount(
      ActivityTypeDefinitionRecord,
      where,
      { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], limit: query.limit, offset: query.offset },
    )

    return NextResponse.json({
      data: records.map(mapRecordToResponse),
      total,
      limit: query.limit,
      offset: query.offset,
    })
  } catch (error) {
    console.error('activity_type_definitions.list failed', error)
    return NextResponse.json({ error: 'Failed to list activity type definitions' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await readJsonSafe(request)
    const parsed = activityTypeDefinitionCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', fieldErrors: parsed.error.flatten().fieldErrors },
        { status: 422 },
      )
    }

    const data = parsed.data

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    // Check for duplicate typeId within this organization
    const existing = await em.findOne(ActivityTypeDefinitionRecord, {
      typeId: data.typeId,
      organizationId: auth.orgId,
      tenantId: auth.tenantId,
    })
    if (existing) {
      return NextResponse.json(
        { error: 'Validation failed', fieldErrors: { typeId: ['This type ID already exists'] } },
        { status: 422 },
      )
    }

    const record = em.create(ActivityTypeDefinitionRecord, {
      typeId: data.typeId,
      moduleId: 'activities',
      label: data.label,
      icon: data.icon,
      color: data.color ?? null,
      lifecycleMode: data.lifecycleMode,
      capabilities: data.capabilities,
      viewFeature: data.viewFeature ?? null,
      createFeature: data.createFeature ?? null,
      filterLabel: data.filterLabel ?? null,
      filterGroup: data.filterGroup ?? null,
      isActive: data.isActive,
      sortOrder: data.sortOrder,
      organizationId: auth.orgId!,
      tenantId: auth.tenantId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await em.flush()

    await invalidateActivityTypeDefsCache(auth.tenantId, auth.orgId)

    return NextResponse.json({ data: mapRecordToResponse(record) }, { status: 201 })
  } catch (error) {
    console.error('activity_type_definitions.create failed', error)
    return NextResponse.json({ error: 'Failed to create activity type definition' }, { status: 500 })
  }
}

const typeDefResponseSchema = z.object({
  id: z.string().uuid(),
  typeId: z.string(),
  moduleId: z.string(),
  label: z.string(),
  icon: z.string(),
  color: z.string().nullable(),
  lifecycleMode: z.enum(['fact', 'task']),
  capabilities: z.record(z.string(), z.boolean().optional()),
  viewFeature: z.string().nullable(),
  createFeature: z.string().nullable(),
  filterLabel: z.string().nullable(),
  filterGroup: z.string().nullable(),
  isActive: z.boolean(),
  sortOrder: z.number(),
  organizationId: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'activity-type-definitions',
  summary: 'Layer 3 custom activity type definitions',
  methods: {
    GET: {
      summary: 'List custom activity type definitions',
      description: 'Returns tenant-scoped Layer 3 activity type definitions.',
      responses: [{ status: 200, description: 'Activity type definitions', schema: z.object({ data: z.array(typeDefResponseSchema), total: z.number() }) }],
    },
    POST: {
      summary: 'Create a custom activity type definition',
      description: 'Creates a new Layer 3 type. typeId must start with "custom:".',
      responses: [{ status: 201, description: 'Created', schema: z.object({ data: typeDefResponseSchema }) }],
    },
  },
}
