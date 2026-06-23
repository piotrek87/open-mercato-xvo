import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { validateCrudMutationGuard, runCrudMutationGuardAfterSuccess } from '@open-mercato/shared/lib/crud/mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { Activity, ActivityLink } from '../data/entities'
import { activityCreateSchema } from '../data/validators'
import { eventsConfig } from '../events'
import { buildActivitiesCrudOpenApi, activityCreatedSchema } from './openapi'

// --- Cursor helpers ---
// Cursor encodes effectiveDate (COALESCE(occurred_at, due_at, created_at)) + id.
// Old cursors (format: { id, createdAt }) are rejected as invalid — acceptable at dev stage.

function encodeCursor(item: Activity): string {
  const effectiveDate = item.effectiveDate ?? item.occurredAt ?? item.dueAt ?? item.createdAt
  return Buffer.from(JSON.stringify({ id: item.id, d: effectiveDate.toISOString() })).toString('base64')
}

function decodeCursor(cursor: string): { id: string; d: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'))
    if (typeof parsed?.id !== 'string' || typeof parsed?.d !== 'string') return null
    if (isNaN(new Date(parsed.d).getTime())) return null
    return parsed as { id: string; d: string }
  } catch {
    return null
  }
}

// --- Query schema ---

const listQuerySchema = z.object({
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
  includeLinked: z.enum(['true', 'false']).optional().default('false'),
  activityType: z.string().optional(),
  lifecycleMode: z.enum(['fact', 'task']).optional(),
  status: z.string().optional(),
  ownerUserId: z.string().uuid().optional(),
  externalProvider: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  dateField: z.enum(['dueAt', 'occurredAt', 'createdAt', 'completedAt']).optional().default('createdAt'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['asc', 'desc']).optional().default('desc'),
  q: z.string().max(200).optional(),
  overdue: z.enum(['true', 'false']).optional(),
})

// --- Response DTO ---

function mapActivityToResponse(a: Activity, links: { id: string; entityType: string; entityId: string; isPrimary: boolean }[] = []) {
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
    links,
  }
}

// --- Metadata ---

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['activities.view'] },
  POST: { requireAuth: true, requireFeatures: ['activities.manage'] },
}

// --- GET: list activities ---

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

    // Build WHERE filter
    const where: Record<string, unknown> = {
      tenantId: auth.tenantId,
      deletedAt: null,
    }

    // Organization scope — default to auth.orgId when no override
    const orgId = auth.orgId ?? null
    if (orgId) {
      where['organizationId'] = orgId
    }

    // Primary link filter OR secondary links (includeLinked=true)
    if (query.entityType && query.entityId) {
      if (query.includeLinked === 'true') {
        // Collect activity IDs from activity_links (secondary links)
        const linkedLinks = await em.find(ActivityLink, {
          entityType: query.entityType,
          entityId: query.entityId,
          organizationId: orgId ?? undefined,
          tenantId: auth.tenantId,
        }, { fields: ['activityId'] })
        const linkedIds = linkedLinks.map((l) => l.activityId)

        // OR: primary link match OR id in linked set
        const orClauses: Record<string, unknown>[] = [
          { linkedEntityType: query.entityType, linkedEntityId: query.entityId },
        ]
        if (linkedIds.length > 0) {
          orClauses.push({ id: { $in: linkedIds } })
        }
        where['$or'] = [
          ...(Array.isArray(where['$or']) ? where['$or'] : []),
          ...orClauses,
        ]
      } else {
        where['linkedEntityType'] = query.entityType
        where['linkedEntityId'] = query.entityId
      }
    } else {
      if (query.entityType) where['linkedEntityType'] = query.entityType
      if (query.entityId) where['linkedEntityId'] = query.entityId
    }
    if (query.activityType) where['activityType'] = query.activityType
    if (query.lifecycleMode) where['lifecycleMode'] = query.lifecycleMode
    if (query.status) where['status'] = query.status
    if (query.ownerUserId) where['ownerUserId'] = query.ownerUserId
    if (query.externalProvider) where['externalProvider'] = query.externalProvider

    // Date range filter on the selected date field
    if (query.from || query.to) {
      const dateField = query.dateField
      const range: Record<string, Date> = {}
      if (query.from) range['$gte'] = new Date(query.from)
      if (query.to) range['$lte'] = new Date(query.to)
      where[dateField] = range
    }

    // Visibility filter: exclude private records not owned by current user
    const canViewPrivate = Array.isArray((auth as Record<string, unknown>)['features'])
      ? ((auth as Record<string, unknown>)['features'] as string[]).includes('activities.view_private')
      : false

    if (!canViewPrivate) {
      // Use $and so this doesn't overwrite the entity-link $or set above
      where['$and'] = [
        ...(Array.isArray(where['$and']) ? where['$and'] : []),
        {
          $or: [
            { visibility: { $ne: 'private' } },
            { visibility: 'private', ownerUserId: auth.sub },
          ],
        },
      ]
    }

    // Full-text search on subject and notes.
    // These fields are encrypted at rest, so SQL LIKE/ILIKE cannot search them.
    // We decrypt all tenant activities (scoped) and filter in memory.
    // For production scale, integrate with the search module instead.
    if (query.q) {
      const qLower = query.q.toLowerCase()
      const searchEm = em.fork()
      const searchScope: Record<string, unknown> = { tenantId: auth.tenantId, deletedAt: null }
      if (orgId) searchScope['organizationId'] = orgId
      const allActivities = await findWithDecryption<Activity>(
        searchEm,
        Activity,
        searchScope as FilterQuery<Activity>,
        { limit: 1000 },
        { tenantId: auth.tenantId, organizationId: orgId ?? '' },
      )
      const matchingIds = allActivities
        .filter((a) =>
          (a.subject ?? '').toLowerCase().includes(qLower) ||
          (a.notes ?? '').toLowerCase().includes(qLower),
        )
        .map((a) => a.id)
      if (matchingIds.length === 0) {
        return NextResponse.json({ data: [], hasMore: false, nextCursor: null, total: 0 })
      }
      where['id'] = { $in: matchingIds }
    }

    // Overdue filter: dueAt in the past, not yet completed/cancelled
    if (query.overdue === 'true') {
      const now = new Date()
      where['$and'] = [
        ...(Array.isArray(where['$and']) ? where['$and'] : []),
        {
          dueAt: { $lt: now, $ne: null },
          status: { $nin: ['completed', 'cancelled'] },
        },
      ]
    }

    // Count total matching records (before cursor pagination)
    const total = await em.count(Activity, where as FilterQuery<Activity>)

    // Cursor-based pagination — keyed on effectiveDate (COALESCE(occurred_at, due_at, created_at))
    const parsedLimit = query.limit
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor)
      if (!decoded) {
        return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
      }
      const cursorDate = new Date(decoded.d)
      if (query.sort === 'desc') {
        where['$and'] = [
          ...(Array.isArray(where['$and']) ? where['$and'] : []),
          {
            $or: [
              { effectiveDate: { $lt: cursorDate } },
              { effectiveDate: cursorDate, id: { $lt: decoded.id } },
            ],
          },
        ]
      } else {
        where['$and'] = [
          ...(Array.isArray(where['$and']) ? where['$and'] : []),
          {
            $or: [
              { effectiveDate: { $gt: cursorDate } },
              { effectiveDate: cursorDate, id: { $gt: decoded.id } },
            ],
          },
        ]
      }
    }

    const orderBy = { effectiveDate: query.sort, id: query.sort } as { effectiveDate: 'asc' | 'desc'; id: 'asc' | 'desc' }

    const results = await findWithDecryption<Activity>(
      em,
      Activity,
      where as FilterQuery<Activity>,
      { limit: parsedLimit + 1, orderBy },
      { tenantId: auth.tenantId, organizationId: orgId ?? '' },
    )

    const hasMore = results.length > parsedLimit
    const items = hasMore ? results.slice(0, parsedLimit) : results
    const nextCursor = hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null

    return NextResponse.json({
      data: items.map((a) => mapActivityToResponse(a)),
      hasMore,
      nextCursor,
      total,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.issues }, { status: 400 })
    }
    console.error('activities.list failed', error)
    return NextResponse.json({ error: 'Failed to list activities' }, { status: 500 })
  }
}

// --- POST: create activity ---

export async function POST(request: Request) {
  try {
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const body = await readJsonSafe(request)
    if (body === null) {
      return NextResponse.json({ error: 'Invalid or empty request body' }, { status: 400 })
    }

    const parseResult = activityCreateSchema.safeParse(body)
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Validation failed', details: parseResult.error.issues }, { status: 400 })
    }
    const parsed = parseResult.data

    // Business rules
    let resolvedStatus = parsed.status ?? 'not_started'
    let resolvedOccurredAt = parsed.occurredAt ? new Date(parsed.occurredAt) : null

    if (parsed.lifecycleMode === 'fact') {
      if (!parsed.status) {
        resolvedStatus = 'completed'
      }
      if (!parsed.occurredAt) {
        resolvedOccurredAt = new Date()
      }
      // private visibility + fact mode is already checked by the schema refine,
      // but we add a defensive check here as well
      if (parsed.visibility === 'private') {
        return NextResponse.json(
          { error: 'Private visibility is not allowed for fact-mode activities' },
          { status: 400 },
        )
      }
    }

    // Mutation guard
    const orgId = auth.orgId ?? null
    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: orgId,
      userId: auth.sub,
      resourceKind: 'activity',
      resourceId: parsed.id ?? '',
      operation: 'create',
      requestMethod: 'POST',
      requestHeaders: (request as Request).headers,
      mutationPayload: body as Record<string, unknown>,
    })

    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    const activity = new Activity()

    await withAtomicFlush(
      em,
      [
        () => {
          activity.id = parsed.id ?? crypto.randomUUID()
          activity.organizationId = orgId ?? ''
          activity.tenantId = auth.tenantId as string
          activity.activityType = parsed.activityType
          activity.lifecycleMode = parsed.lifecycleMode
          activity.subject = parsed.subject
          activity.notes = parsed.notes ?? null
          activity.status = resolvedStatus
          activity.priority = parsed.priority ?? null
          activity.dueAt = parsed.dueAt ? new Date(parsed.dueAt) : null
          activity.completedAt = resolvedStatus === 'completed' ? new Date() : null
          activity.occurredAt = resolvedOccurredAt
          activity.durationMinutes = parsed.durationMinutes ?? null
          activity.location = parsed.location ?? null
          activity.allDay = parsed.allDay ?? false
          activity.recurrenceRule = parsed.recurrenceRule ?? null
          activity.authorUserId = auth.sub
          activity.ownerUserId = parsed.ownerUserId ?? null
          activity.participants = parsed.participants ?? null
          activity.visibility = parsed.visibility ?? 'team'
          activity.linkedEntityType = parsed.linkedEntityType ?? null
          activity.linkedEntityId = parsed.linkedEntityId ?? null
          activity.externalId = parsed.externalId ?? null
          activity.externalProvider = parsed.externalProvider ?? null
          activity.syncDirection = parsed.syncDirection ?? null
          activity.sourceType = parsed.sourceType ?? null
          activity.sourceId = parsed.sourceId ?? null
          activity.isActive = true
          em.persist(activity)
        },
      ],
      { transaction: true, label: 'activities.create' },
    )

    // Emit event after flush (outside the flush block)
    await eventsConfig.emit('activities.activity.created', {
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
        operation: 'create',
        requestMethod: 'POST',
        requestHeaders: (request as Request).headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    return NextResponse.json({ data: mapActivityToResponse(activity) }, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.issues }, { status: 400 })
    }
    console.error('activities.create failed', error)
    return NextResponse.json({ error: 'Failed to create activity' }, { status: 500 })
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

const listResponseSchema = z.object({
  data: z.array(activityResponseSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
})

export const openApi: OpenApiRouteDoc = buildActivitiesCrudOpenApi({
  resourceName: 'Activity',
  pluralName: 'Activities',
  querySchema: listQuerySchema,
  listResponseSchema,
  create: {
    schema: activityCreateSchema,
    description: 'Creates a new activity record. For fact-mode activities, status defaults to completed and occurredAt defaults to now.',
    responseSchema: activityCreatedSchema,
  },
})
