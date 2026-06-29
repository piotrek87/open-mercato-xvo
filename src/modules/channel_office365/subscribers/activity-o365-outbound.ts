/**
 * Shared helpers for the O365 outbound sync subscribers.
 * Each event (created / updated / deleted) has its own subscriber file.
 *
 * Listens to customers.interaction.created/updated/deleted because meetings
 * are created via POST /api/customers/interactions (core customers module),
 * not via the activities module API.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { CustomerInteraction } from '@open-mercato/core/modules/customers/data/entities'
import {
  resolveUserChannel,
  resolveAccessToken,
  pushInteractionToO365,
  deleteInteractionFromO365,
} from '../lib/sync-outbound'

export const MEETING_INTERACTION_TYPE = 'meeting'

export type InteractionEventPayload = {
  id: string
  tenantId: string
  organizationId?: string | null
  interactionType?: string | null
  syncOrigin?: string | null
}

export async function handleOutboundCreateOrUpdate(
  payload: InteractionEventPayload,
): Promise<void> {
  const { id, tenantId, interactionType, syncOrigin } = payload

  console.info(`[channel_office365:outbound] received event id=${id} interactionType=${interactionType} tenantId=${tenantId} syncOrigin=${syncOrigin}`)

  if (!id || !tenantId) {
    console.info('[channel_office365:outbound] bail: missing id or tenantId')
    return
  }
  if (interactionType !== MEETING_INTERACTION_TYPE) {
    console.info(`[channel_office365:outbound] bail: interactionType=${interactionType} !== meeting`)
    return
  }
  // Skip system-originated changes (e.g. email import) to prevent ping-pong
  if (syncOrigin) {
    console.info(`[channel_office365:outbound] bail: syncOrigin=${syncOrigin} set (system change)`)
    return
  }

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()

  const interaction = await em.findOne(CustomerInteraction, { id, tenantId, deletedAt: null })
  if (!interaction) {
    console.info(`[channel_office365:outbound] bail: interaction ${id} not found`)
    return
  }
  if (interaction.interactionType !== MEETING_INTERACTION_TYPE) {
    console.info(`[channel_office365:outbound] bail: interaction.interactionType=${interaction.interactionType} !== meeting`)
    return
  }

  const channelUserId = interaction.ownerUserId ?? interaction.authorUserId
  if (!channelUserId) {
    console.info('[channel_office365:outbound] bail: no channelUserId (ownerUserId and authorUserId both null)')
    return
  }

  const channel = await resolveUserChannel(em, channelUserId, tenantId)
  if (!channel) {
    console.info(`[channel_office365:outbound] bail: no connected O365 channel for userId=${channelUserId} tenantId=${tenantId}`)
    return
  }

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

  console.info(`[channel_office365:outbound] pushing interaction ${interaction.id} to O365 for channel ${channel.id}`)
  await pushInteractionToO365(interaction, channel, accessToken, em)
}

export async function handleOutboundDelete(
  payload: InteractionEventPayload,
): Promise<void> {
  const { id, tenantId, interactionType, syncOrigin } = payload

  console.info(`[channel_office365:outbound-delete] received event id=${id} interactionType=${interactionType}`)

  if (!id || !tenantId) return
  if (interactionType !== MEETING_INTERACTION_TYPE) return
  if (syncOrigin) return

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()

  // Interaction may already be soft-deleted — load without deletedAt filter
  const interaction = await em.findOne(CustomerInteraction, { id, tenantId })
  if (!interaction) {
    console.info(`[channel_office365:outbound-delete] bail: interaction ${id} not found`)
    return
  }
  if (interaction.interactionType !== MEETING_INTERACTION_TYPE) return

  const channelUserId = interaction.ownerUserId ?? interaction.authorUserId
  if (!channelUserId) {
    console.info('[channel_office365:outbound-delete] bail: no channelUserId')
    return
  }

  const channel = await resolveUserChannel(em, channelUserId, tenantId)
  if (!channel) {
    console.info(`[channel_office365:outbound-delete] bail: no connected O365 channel for userId=${channelUserId}`)
    return
  }

  let credentialsService: { resolve: (id: string, scope: object) => Promise<Record<string, unknown> | null> } | null = null
  try {
    credentialsService = container.resolve('integrationCredentialsService')
  } catch {
    return
  }

  if (!credentialsService) return
  const accessToken = await resolveAccessToken(channel, credentialsService)
  if (!accessToken) return

  console.info(`[channel_office365:outbound-delete] deleting O365 event for interaction ${interaction.id}`)
  await deleteInteractionFromO365(interaction, accessToken, em)
}
