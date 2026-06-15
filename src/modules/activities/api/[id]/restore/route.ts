import { NextResponse, NextRequest } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { Activity } from '../../../data/entities'
import { eventsConfig } from '../../../events'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['activities.manage'] },
}

export const openApi = {
  POST: {
    tags: ['Activities'],
    summary: 'Restore a soft-deleted activity',
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

    // Load WITHOUT deletedAt: null filter so we find soft-deleted records
    const activity = await findOneWithDecryption(
      em,
      Activity,
      { id: params.id, tenantId: auth.tenantId },
      undefined,
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? '' },
    )

    if (!activity) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 })
    }

    if (!activity.deletedAt) {
      return NextResponse.json({ error: 'Activity is not deleted' }, { status: 422 })
    }

    await withAtomicFlush(
      em,
      [
        () => {
          activity.deletedAt = null
        },
      ],
      { transaction: true, label: 'activities.restore' },
    )

    await eventsConfig.emit('activities.activity.restored', {
      id: activity.id,
      tenantId: auth.tenantId,
      organizationId: auth.orgId ?? '',
      activityType: activity.activityType,
      lifecycleMode: activity.lifecycleMode,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('activities.restore failed', error)
    return NextResponse.json({ error: 'Failed to restore activity' }, { status: 500 })
  }
}
