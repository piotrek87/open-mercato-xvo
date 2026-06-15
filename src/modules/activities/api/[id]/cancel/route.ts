import { NextResponse, NextRequest } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { validateCrudMutationGuard, runCrudMutationGuardAfterSuccess } from '@open-mercato/shared/lib/crud/mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { Activity } from '../../../data/entities'
import { activityCancelSchema } from '../../../data/validators'
import { eventsConfig } from '../../../events'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['activities.cancel'] },
}

export const openApi = {
  POST: {
    tags: ['Activities'],
    summary: 'Cancel an activity',
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

    if (activity.status === 'cancelled') {
      return NextResponse.json({ error: 'Activity is already cancelled' }, { status: 422 })
    }

    const body = await readJsonSafe(request)
    const parseResult = activityCancelSchema.safeParse(body ?? {})
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
          activity.status = 'cancelled'
          if (parsed.reason) {
            const cancellationNote = `\n---\nCancelled: ${parsed.reason}`
            activity.notes = (activity.notes ?? '') + cancellationNote
          }
        },
      ],
      { transaction: true, label: 'activities.cancel' },
    )

    await eventsConfig.emit('activities.activity.cancelled', {
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
    console.error('activities.cancel failed', error)
    return NextResponse.json({ error: 'Failed to cancel activity' }, { status: 500 })
  }
}
