import { NextResponse, NextRequest } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'
import { Activity, ActivityLink } from '../../../../data/entities'
import { activityLinkUpdateSchema } from '../../../../data/validators'

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
  PATCH: { requireAuth: true, requireFeatures: ['activities.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['activities.manage'] },
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; linkId: string } },
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

    const parseResult = activityLinkUpdateSchema.safeParse(body)
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

    const link = await em.findOne(ActivityLink, {
      id: params.linkId,
      activityId: params.id,
      organizationId: auth.orgId ?? activity.organizationId,
    })
    if (!link) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    await withAtomicFlush(em, [
      async () => {
        if (parsed.isPrimary && !link.isPrimary) {
          // Demote current primary
          const currentPrimary = await em.findOne(ActivityLink, {
            activityId: params.id,
            isPrimary: true,
          })
          if (currentPrimary && currentPrimary.id !== link.id) {
            currentPrimary.isPrimary = false
          }
          link.isPrimary = true
          // Denormalize
          activity.linkedEntityType = link.entityType
          activity.linkedEntityId = link.entityId
        } else if (!parsed.isPrimary && link.isPrimary) {
          link.isPrimary = false
          // Clear denormalized fields if no other primary exists
          activity.linkedEntityType = null
          activity.linkedEntityId = null
        }
      },
    ], { transaction: true, label: 'activity_links.update' })

    return NextResponse.json(mapLink(link))
  } catch (error) {
    console.error('activity_links.update failed', error)
    return NextResponse.json({ error: 'Failed to update link' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; linkId: string } },
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

    const link = await em.findOne(ActivityLink, {
      id: params.linkId,
      activityId: params.id,
      organizationId: auth.orgId ?? activity.organizationId,
    })
    if (!link) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const wasPrimary = link.isPrimary

    await withAtomicFlush(em, [
      async () => {
        em.remove(link)

        if (wasPrimary) {
          // Promote oldest remaining link to primary (if any)
          const next = await em.findOne(ActivityLink, {
            activityId: params.id,
            id: { $ne: params.linkId },
            organizationId: auth.orgId ?? activity.organizationId,
          }, { orderBy: { createdAt: 'ASC' } })

          if (next) {
            next.isPrimary = true
            activity.linkedEntityType = next.entityType
            activity.linkedEntityId = next.entityId
          } else {
            activity.linkedEntityType = null
            activity.linkedEntityId = null
          }
        }
      },
    ], { transaction: true, label: 'activity_links.delete' })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    console.error('activity_links.delete failed', error)
    return NextResponse.json({ error: 'Failed to delete link' }, { status: 500 })
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
  summary: 'Activity link operations',
  methods: {
    PATCH: {
      summary: 'Update link',
      description: 'Change isPrimary for an activity link. Setting isPrimary=true atomically demotes the current primary.',
      requestBody: { schema: activityLinkUpdateSchema, description: 'Fields to update' },
      responses: [{ status: 200, description: 'Updated link', schema: linkResponseSchema }],
    },
    DELETE: {
      summary: 'Delete link',
      description: 'Remove an activity link. If it was the primary link, the oldest remaining link is promoted.',
      responses: [{ status: 204, description: 'Deleted' }],
    },
  },
}
