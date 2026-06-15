import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'
import { ActivityTypeDefinitionRecord } from '../../../data/entities'
import { activityTypeDefinitionUpdateSchema } from '../../../data/validators'
import { invalidateActivityTypeDefsCache } from '../../activity-types/cache'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['activities.view'] },
  PATCH: { requireAuth: true, requireFeatures: ['activities.manage_types'] },
  DELETE: { requireAuth: true, requireFeatures: ['activities.manage_types'] },
}

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

async function resolveRecord(
  em: EntityManager,
  id: string,
  tenantId: string,
  orgId: string | null | undefined,
): Promise<ActivityTypeDefinitionRecord | null> {
  return em.findOne(ActivityTypeDefinitionRecord, {
    id,
    tenantId,
    organizationId: orgId ?? undefined,
  })
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const record = await resolveRecord(em, id, auth.tenantId, auth.orgId)
    if (!record) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json({ data: mapRecordToResponse(record) })
  } catch (error) {
    console.error('activity_type_definitions.get failed', error)
    return NextResponse.json({ error: 'Failed to get activity type definition' }, { status: 500 })
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await readJsonSafe(request)
    const parsed = activityTypeDefinitionUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', fieldErrors: parsed.error.flatten().fieldErrors },
        { status: 422 },
      )
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const record = await resolveRecord(em, id, auth.tenantId, auth.orgId)
    if (!record) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const data = parsed.data
    if (data.label !== undefined) record.label = data.label
    if (data.icon !== undefined) record.icon = data.icon
    if (data.color !== undefined) record.color = data.color ?? null
    if (data.lifecycleMode !== undefined) record.lifecycleMode = data.lifecycleMode
    if (data.capabilities !== undefined) record.capabilities = data.capabilities
    if (data.viewFeature !== undefined) record.viewFeature = data.viewFeature ?? null
    if (data.createFeature !== undefined) record.createFeature = data.createFeature ?? null
    if (data.filterLabel !== undefined) record.filterLabel = data.filterLabel ?? null
    if (data.filterGroup !== undefined) record.filterGroup = data.filterGroup ?? null
    if (data.isActive !== undefined) record.isActive = data.isActive
    if (data.sortOrder !== undefined) record.sortOrder = data.sortOrder
    record.updatedAt = new Date()

    await em.flush()
    await invalidateActivityTypeDefsCache(auth.tenantId, auth.orgId)

    return NextResponse.json({ data: mapRecordToResponse(record) })
  } catch (error) {
    console.error('activity_type_definitions.update failed', error)
    return NextResponse.json({ error: 'Failed to update activity type definition' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const record = await resolveRecord(em, id, auth.tenantId, auth.orgId)
    if (!record) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Soft delete — preserve history, activities using this type still render
    record.isActive = false
    record.updatedAt = new Date()
    await em.flush()

    await invalidateActivityTypeDefsCache(auth.tenantId, auth.orgId)

    return NextResponse.json({ data: { id, isActive: false } })
  } catch (error) {
    console.error('activity_type_definitions.delete failed', error)
    return NextResponse.json({ error: 'Failed to deactivate activity type definition' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'activity-type-definitions',
  summary: 'Single custom activity type definition',
  methods: {
    GET: {
      summary: 'Get a custom activity type definition',
      responses: [{ status: 200, description: 'Activity type definition', schema: z.object({ data: z.any() }) }],
    },
    PATCH: {
      summary: 'Update a custom activity type definition',
      responses: [{ status: 200, description: 'Updated', schema: z.object({ data: z.any() }) }],
    },
    DELETE: {
      summary: 'Soft-delete (deactivate) a custom activity type definition',
      description: 'Sets is_active=false. Historical activities using this type still render correctly.',
      responses: [{ status: 200, description: 'Deactivated', schema: z.object({ data: z.object({ id: z.string(), isActive: z.boolean() }) }) }],
    },
  },
}
