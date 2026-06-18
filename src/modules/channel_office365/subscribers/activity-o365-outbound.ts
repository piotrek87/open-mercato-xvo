/**
 * Shared helpers for the O365 outbound sync subscribers.
 * Each event (created / updated / deleted) has its own subscriber file.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { Activity } from '../../activities/data/entities'
import {
  resolveUserChannel,
  resolveAccessToken,
  pushMeetingToO365,
  deleteMeetingFromO365,
} from '../lib/sync-outbound'

export const MEETING_ACTIVITY_TYPE = 'meeting'

export type ActivityEventPayload = {
  id: string
  tenantId: string
  organizationId?: string | null
  activityType?: string
  ownerUserId?: string | null
  syncDirection?: string | null
}

export async function handleOutboundCreateOrUpdate(
  payload: ActivityEventPayload,
): Promise<void> {
  const { id, tenantId, ownerUserId, activityType, syncDirection } = payload

  if (!id || !tenantId || !ownerUserId) return
  if (activityType !== MEETING_ACTIVITY_TYPE) return
  if (syncDirection === 'import') return

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()

  const activity = await em.findOne(Activity, { id, tenantId, deletedAt: null })
  if (!activity) return
  if (activity.activityType !== MEETING_ACTIVITY_TYPE) return
  if (activity.syncDirection === 'import') return

  const channel = await resolveUserChannel(em, ownerUserId, tenantId)
  if (!channel) return

  let credentialsService: { resolve: (id: string, scope: object) => Promise<Record<string, unknown> | null> } | null = null
  try {
    credentialsService = container.resolve('integrationCredentialsService')
  } catch {
    console.warn('[channel_office365:activity-o365-outbound] integrationCredentialsService not available')
    return
  }

  if (!credentialsService) return
  const accessToken = await resolveAccessToken(channel, credentialsService)
  if (!accessToken) {
    console.warn(`[channel_office365:activity-o365-outbound] no valid token for channel ${channel.id}`)
    return
  }

  await pushMeetingToO365(activity, channel, accessToken, em)
}

export async function handleOutboundDelete(
  payload: ActivityEventPayload,
): Promise<void> {
  const { id, tenantId, ownerUserId, activityType, syncDirection } = payload

  if (!id || !tenantId) return
  if (activityType !== MEETING_ACTIVITY_TYPE) return
  // If syncDirection='import' the delete originated from O365 — don't loop back
  if (syncDirection === 'import') return

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()

  // Activity may already be soft-deleted — load without deletedAt filter
  const activity = await em.findOne(Activity, { id, tenantId })
  if (!activity) return
  if (activity.activityType !== MEETING_ACTIVITY_TYPE) return
  if (activity.syncDirection === 'import') return

  const userId = ownerUserId ?? activity.ownerUserId
  if (!userId) return

  const channel = await resolveUserChannel(em, userId, tenantId)
  if (!channel) return

  let credentialsService: { resolve: (id: string, scope: object) => Promise<Record<string, unknown> | null> } | null = null
  try {
    credentialsService = container.resolve('integrationCredentialsService')
  } catch {
    return
  }

  if (!credentialsService) return
  const accessToken = await resolveAccessToken(channel, credentialsService)
  if (!accessToken) return

  await deleteMeetingFromO365(activity, accessToken, em)
}
