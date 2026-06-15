import { NextResponse, NextRequest } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { validateCrudMutationGuard, runCrudMutationGuardAfterSuccess } from '@open-mercato/shared/lib/crud/mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { Activity } from '../../../data/entities'
import { activityCompleteSchema } from '../../../data/validators'
import { eventsConfig } from '../../../events'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['activities.complete'] },
}

export const openApi = {
  POST: {
    tags: ['Activities'],
    summary: 'Complete an activity',
    responses: { 200: { description: 'OK' } },
  },
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
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
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? '' },
    )

    if (!activity) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 })
    }

    if (activity.status === 'completed' || activity.status === 'cancelled') {
      return NextResponse.json({ error: 'Activity is already completed or cancelled' }, { status: 422 })
    }

    const body = await readJsonSafe(request)
    const parseResult = activityCompleteSchema.safeParse(body ?? {})
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Validation failed', details: parseResult.error.issues }, { status: 400 })
    }
    const parsed = parseResult.data

    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: auth.orgId ?? null,
      userId: auth.sub,
      resourceKind: 'activity',
      resourceId: activity.id,
      operation: 'update',
      requestMethod: 'POST',
      requestHeaders: request.headers,
      mutationPayload: (body ?? {}) as Record<string, unknown>,
    })

    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    await withAtomicFlush(
      em,
      [
        () => {
          activity.status = 'completed'
          activity.completedAt = new Date()
          if (parsed.occurredAt) activity.occurredAt = new Date(parsed.occurredAt)
          if (parsed.notes !== undefined) activity.notes = parsed.notes
          if (parsed.durationMinutes !== undefined) activity.durationMinutes = parsed.durationMinutes
        },
      ],
      { transaction: true, label: 'activities.complete' },
    )

    await eventsConfig.emit('activities.activity.completed', {
      id: activity.id,
      tenantId: auth.tenantId,
      organizationId: auth.orgId ?? '',
      activityType: activity.activityType,
      lifecycleMode: activity.lifecycleMode,
    })

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: auth.orgId ?? null,
        userId: auth.sub,
        resourceKind: 'activity',
        resourceId: activity.id,
        operation: 'update',
        requestMethod: 'POST',
        requestHeaders: request.headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('activities.complete failed', error)
    return NextResponse.json({ error: 'Failed to complete activity' }, { status: 500 })
  }
}
