import { NextResponse, NextRequest } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { validateCrudMutationGuard, runCrudMutationGuardAfterSuccess } from '@open-mercato/shared/lib/crud/mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { Activity, ActivityLink } from '../../data/entities'
import { activityUpdateSchema } from '../../data/validators'
import { eventsConfig } from '../../events'
import { activityOkSchema } from '../openapi'

// --- Response DTO (duplicated from ../route.ts — cannot import between Next.js route files) ---

function mapActivityToResponse(a: Activity, links: ActivityLink[] = []) {
  return {
    id: a.id,
    activityType: a.activityType,
    lifecycleMode: a.lifecycleMode,
    subject: a.subject,
    notes: a.notes ?? null,
    status: a.status,
    priority: a.priority ?? null,
    dueAt: a.dueAt?.toISOString() ?? null,
    completedAt: a.completedAt?.toISOString() ?? null,
    occurredAt: a.occurredAt?.toISOString() ?? null,
    durationMinutes: a.durationMinutes ?? null,
    location: a.location ?? null,
    allDay: a.allDay,
    recurrenceRule: a.recurrenceRule ?? null,
    authorUserId: a.authorUserId ?? null,
    ownerUserId: a.ownerUserId ?? null,
    participants: a.participants ?? [],
    visibility: a.visibility,
    linkedEntityType: a.linkedEntityType ?? null,
    linkedEntityId: a.linkedEntityId ?? null,
    externalId: a.externalId ?? null,
    externalProvider: a.externalProvider ?? null,
    syncDirection: a.syncDirection ?? null,
    lastSyncedAt: a.lastSyncedAt?.toISOString() ?? null,
    sourceType: a.sourceType ?? null,
    sourceId: a.sourceId ?? null,
    isActive: a.isActive,
    metadata: a.metadata ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    customFields: {},
    links: links.map((l) => ({
      id: l.id,
      entityType: l.entityType,
      entityId: l.entityId,
      isPrimary: l.isPrimary,
    })),
  }
}

// --- Visibility guard helper ---

function canAccessActivity(
  activity: Activity,
  auth: { sub: string; features?: string[] },
): boolean {
  if (activity.visibility !== 'private') return true
  if (activity.ownerUserId === auth.sub) return true
  const features = Array.isArray((auth as Record<string, unknown>)['features'])
    ? ((auth as Record<string, unknown>)['features'] as string[])
    : []
  return features.includes('activities.view_private')
}

// --- Metadata ---

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['activities.view'] },
  PUT: { requireAuth: true, requireFeatures: ['activities.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['activities.manage'] },
}

// --- GET: single activity ---

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const activity = await findOneWithDecryption(
      em,
      Activity,
      { id: params.id, tenantId: auth.tenantId, deletedAt: null },
      undefined,
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? '' },
    )

    if (!activity) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Hide private records from non-owners without the override feature
    if (!canAccessActivity(activity, auth)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const links = await em.find(ActivityLink, {
      activityId: params.id,
      organizationId: auth.orgId ?? activity.organizationId,
    }, { orderBy: { createdAt: 'ASC' } })

    return NextResponse.json(mapActivityToResponse(activity, links))
  } catch (error) {
    console.error('activities.get failed', error)
    return NextResponse.json({ error: 'Failed to get activity' }, { status: 500 })
  }
}

// --- PUT: update activity ---

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await readJsonSafe(request)
    if (body === null) {
      return NextResponse.json({ error: 'Invalid or empty request body' }, { status: 400 })
    }

    const parseResult = activityUpdateSchema.safeParse({ ...body, id: params.id })
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Validation failed', details: parseResult.error.issues }, { status: 400 })
    }
    const parsed = parseResult.data

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const activity = await findOneWithDecryption(
      em,
      Activity,
      { id: params.id, tenantId: auth.tenantId, deletedAt: null },
      undefined,
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? '' },
    )

    if (!activity) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (!canAccessActivity(activity, auth)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const orgId = auth.orgId ?? null

    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: orgId,
      userId: auth.sub,
      resourceKind: 'activity',
      resourceId: params.id,
      operation: 'update',
      requestMethod: 'PUT',
      requestHeaders: request.headers,
      mutationPayload: body as Record<string, unknown>,
    })

    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    await withAtomicFlush(
      em,
      [
        () => {
          // Only assign fields that are explicitly present in the parsed body.
          // Immutable fields (activityType, lifecycleMode, organizationId, tenantId) are never assigned.
          if (parsed.subject !== undefined) activity.subject = parsed.subject
          if (parsed.notes !== undefined) activity.notes = parsed.notes ?? null
          if (parsed.status !== undefined) {
            activity.status = parsed.status
            if (parsed.status === 'completed' && !activity.completedAt) {
              activity.completedAt = new Date()
            }
          }
          if (parsed.priority !== undefined) activity.priority = parsed.priority ?? null
          if (parsed.dueAt !== undefined) activity.dueAt = parsed.dueAt ? new Date(parsed.dueAt) : null
          if (parsed.occurredAt !== undefined) activity.occurredAt = parsed.occurredAt ? new Date(parsed.occurredAt) : null
          if (parsed.durationMinutes !== undefined) activity.durationMinutes = parsed.durationMinutes ?? null
          if (parsed.location !== undefined) activity.location = parsed.location ?? null
          if (parsed.allDay !== undefined) activity.allDay = parsed.allDay
          if (parsed.ownerUserId !== undefined) activity.ownerUserId = parsed.ownerUserId ?? null
          if (parsed.participants !== undefined) activity.participants = parsed.participants ?? null
          if (parsed.visibility !== undefined) activity.visibility = parsed.visibility
          if (parsed.linkedEntityType !== undefined) activity.linkedEntityType = parsed.linkedEntityType ?? null
          if (parsed.linkedEntityId !== undefined) activity.linkedEntityId = parsed.linkedEntityId ?? null
          if (parsed.sourceType !== undefined) activity.sourceType = parsed.sourceType ?? null
          if (parsed.sourceId !== undefined) activity.sourceId = parsed.sourceId ?? null
        },
      ],
      { transaction: true, label: 'activities.update' },
    )

    // Emit event after flush (outside the flush block)
    await eventsConfig.emit('activities.activity.updated', {
      id: activity.id,
      tenantId: auth.tenantId,
      organizationId: orgId ?? '',
      activityType: activity.activityType,
      lifecycleMode: activity.lifecycleMode,
    })

    // After-success mutation guard hook
    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: orgId,
        userId: auth.sub,
        resourceKind: 'activity',
        resourceId: activity.id,
        operation: 'update',
        requestMethod: 'PUT',
        requestHeaders: request.headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    return NextResponse.json(mapActivityToResponse(activity))
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.issues }, { status: 400 })
    }
    console.error('activities.update failed', error)
    return NextResponse.json({ error: 'Failed to update activity' }, { status: 500 })
  }
}

// --- DELETE: soft-delete activity ---

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const activity = await findOneWithDecryption(
      em,
      Activity,
      { id: params.id, tenantId: auth.tenantId, deletedAt: null },
      undefined,
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? '' },
    )

    if (!activity) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (!canAccessActivity(activity, auth)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const orgId = auth.orgId ?? null

    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: orgId,
      userId: auth.sub,
      resourceKind: 'activity',
      resourceId: params.id,
      operation: 'delete',
      requestMethod: 'DELETE',
      requestHeaders: request.headers,
      mutationPayload: {},
    })

    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    await withAtomicFlush(
      em,
      [() => { activity.deletedAt = new Date() }],
      { transaction: true, label: 'activities.delete' },
    )

    // Emit event after flush (outside the flush block)
    await eventsConfig.emit('activities.activity.deleted', {
      id: activity.id,
      tenantId: auth.tenantId,
      organizationId: orgId ?? '',
      activityType: activity.activityType,
      lifecycleMode: activity.lifecycleMode,
    })

    // After-success mutation guard hook
    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: orgId,
        userId: auth.sub,
        resourceKind: 'activity',
        resourceId: activity.id,
        operation: 'delete',
        requestMethod: 'DELETE',
        requestHeaders: request.headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('activities.delete failed', error)
    return NextResponse.json({ error: 'Failed to delete activity' }, { status: 500 })
  }
}

// --- OpenAPI ---

const activityResponseSchema = z.object({
  id: z.string().uuid(),
  activityType: z.string(),
  lifecycleMode: z.enum(['fact', 'task']),
  subject: z.string(),
  notes: z.string().nullable(),
  status: z.string(),
  priority: z.number().nullable(),
  dueAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  occurredAt: z.string().nullable(),
  durationMinutes: z.number().nullable(),
  location: z.string().nullable(),
  allDay: z.boolean(),
  recurrenceRule: z.string().nullable(),
  authorUserId: z.string().nullable(),
  ownerUserId: z.string().nullable(),
  participants: z.array(z.object({
    userId: z.string().uuid().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
    status: z.string().optional(),
  })),
  visibility: z.string(),
  linkedEntityType: z.string().nullable(),
  linkedEntityId: z.string().nullable(),
  externalId: z.string().nullable(),
  externalProvider: z.string().nullable(),
  syncDirection: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  isActive: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  customFields: z.record(z.string(), z.unknown()),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Activities',
  summary: 'Activity detail',
  methods: {
    GET: {
      summary: 'Get activity',
      description: 'Retrieve a single activity by ID.',
      responses: [{ status: 200, description: 'Activity record', schema: activityResponseSchema }],
    },
    PUT: {
      summary: 'Update activity',
      description: 'Update an existing activity. Only provided fields are changed; immutable fields (activityType, lifecycleMode) are ignored.',
      requestBody: { schema: activityUpdateSchema, description: 'Fields to update.' },
      responses: [{ status: 200, description: 'Updated activity', schema: activityResponseSchema }],
    },
    DELETE: {
      summary: 'Delete activity',
      description: 'Soft-delete an activity (sets deletedAt). Deleted records are excluded from list queries.',
      responses: [{ status: 200, description: 'Deleted', schema: activityOkSchema }],
    },
  },
}
