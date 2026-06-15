import { NextResponse, NextRequest } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'
import { Activity, ActivityLink } from '../../../data/entities'
import { activityLinkCreateSchema } from '../../../data/validators'

const SOFT_LIMIT_LINKS_PER_ACTIVITY = 10

function mapLink(link: ActivityLink) {
  return {
    id: link.id,
    activityId: link.activityId,
    entityType: link.entityType,
    entityId: link.entityId,
    isPrimary: link.isPrimary,
    createdAt: link.createdAt.toISOString(),
    createdByUserId: link.createdByUserId ?? null,
  }
}

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['activities.view'] },
  POST: { requireAuth: true, requireFeatures: ['activities.manage'] },
}

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

    const links = await em.find(ActivityLink, {
      activityId: params.id,
      organizationId: auth.orgId ?? activity.organizationId,
    }, { orderBy: { createdAt: 'ASC' } })

    return NextResponse.json({ data: links.map(mapLink) })
  } catch (error) {
    console.error('activity_links.list failed', error)
    return NextResponse.json({ error: 'Failed to list links' }, { status: 500 })
  }
}

export async function POST(
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

    const parseResult = activityLinkCreateSchema.safeParse(body)
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Validation failed', details: parseResult.error.issues }, { status: 422 })
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

    // Soft limit check
    const existingCount = await em.count(ActivityLink, { activityId: params.id })
    if (existingCount >= SOFT_LIMIT_LINKS_PER_ACTIVITY) {
      return NextResponse.json({ error: 'activity_link_limit_exceeded', message: `Maximum ${SOFT_LIMIT_LINKS_PER_ACTIVITY} links per activity` }, { status: 422 })
    }

    // Duplicate check
    const existing = await em.findOne(ActivityLink, {
      activityId: params.id,
      entityType: parsed.entityType,
      entityId: parsed.entityId,
    })
    if (existing) {
      return NextResponse.json({ error: 'activity_link_already_exists' }, { status: 409 })
    }

    let newLink!: ActivityLink

    await withAtomicFlush(em, [
      async () => {
        // If new link is primary, demote existing primary
        if (parsed.isPrimary) {
          const currentPrimary = await em.findOne(ActivityLink, {
            activityId: params.id,
            isPrimary: true,
          })
          if (currentPrimary) {
            currentPrimary.isPrimary = false
          }
        }

        newLink = em.create(ActivityLink, {
          activityId: params.id,
          entityType: parsed.entityType,
          entityId: parsed.entityId,
          isPrimary: parsed.isPrimary,
          organizationId: auth.orgId ?? activity.organizationId,
          tenantId: auth.tenantId,
          createdByUserId: auth.sub,
        })

        // Denormalize: update Activity.linked_entity_type/id when setting primary
        if (parsed.isPrimary) {
          activity.linkedEntityType = parsed.entityType
          activity.linkedEntityId = parsed.entityId
        }
      },
    ], { transaction: true, label: 'activity_links.create' })

    return NextResponse.json(mapLink(newLink), { status: 201 })
  } catch (error) {
    console.error('activity_links.create failed', error)
    return NextResponse.json({ error: 'Failed to create link' }, { status: 500 })
  }
}

const linkResponseSchema = z.object({
  id: z.string().uuid(),
  activityId: z.string().uuid(),
  entityType: z.string(),
  entityId: z.string().uuid(),
  isPrimary: z.boolean(),
  createdAt: z.string(),
  createdByUserId: z.string().nullable(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'activity-links',
  summary: 'Activity links',
  methods: {
    GET: {
      summary: 'List activity links',
      description: 'Returns all entity links for an activity.',
      responses: [{ status: 200, description: 'Links list', schema: z.object({ data: z.array(linkResponseSchema) }) }],
    },
    POST: {
      summary: 'Add activity link',
      description: 'Link an entity to an activity. At most one link may be isPrimary.',
      requestBody: { schema: activityLinkCreateSchema, description: 'Link to add' },
      responses: [
        { status: 201, description: 'Created link', schema: linkResponseSchema },
        { status: 409, description: 'Link already exists' },
        { status: 422, description: 'Validation error or limit exceeded' },
      ],
    },
  },
}
