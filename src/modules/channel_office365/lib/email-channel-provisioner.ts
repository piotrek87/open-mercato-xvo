/**
 * Email channel auto-provisioning helper.
 *
 * After a user connects Microsoft 365 (calendar OAuth flow), the hub creates a
 * CommunicationChannel with providerKey='office365'. This provisioner creates a
 * SIBLING email channel with providerKey='office365_mail' that shares the same
 * OAuth credentials.
 *
 * Idempotent: calling multiple times for the same (user, tenant, org) is safe —
 * createConnectedChannelRow heals on reconnect, so re-provisioning after a token
 * refresh is handled correctly.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { createConnectedChannelRow } from '@open-mercato/core/modules/communication_channels/lib/connect-channel'
import { getO365EmailAdapter } from './graph-mail-adapter'
import { O365_PROVIDER_KEY, O365_MAIL_PROVIDER_KEY } from './credentials'

export interface ProvisionEmailChannelArgs {
  em: EntityManager
  userId: string
  scope: { tenantId: string; organizationId: string | null }
}

export interface ProvisionEmailChannelResult {
  channelId: string
  /** true when a new channel was created, false when an existing channel was updated */
  created: boolean
}

/**
 * Create or update the email channel for a user that already has an O365 calendar channel.
 *
 * Copies the credentialsRef from the calendar channel so both channels share the same
 * OAuth token row. Returns null if the user has no calendar channel (e.g. OAuth not done).
 */
export async function provisionEmailChannel(
  args: ProvisionEmailChannelArgs,
): Promise<ProvisionEmailChannelResult | null> {
  const { em, userId, scope } = args
  const dscope = { tenantId: scope.tenantId, organizationId: scope.organizationId ?? null }

  // Find the calendar channel — it carries the credentialsRef we need to copy
  const calendarChannel = await findOneWithDecryption(
    em,
    CommunicationChannel,
    {
      tenantId: scope.tenantId,
      userId,
      providerKey: O365_PROVIDER_KEY,
      deletedAt: null,
    },
    undefined,
    dscope,
  )
  if (!calendarChannel) return null

  const credentialsRefId = calendarChannel.credentialsRef ?? null
  const externalIdentifier = calendarChannel.externalIdentifier ?? null
  const displayName = calendarChannel.displayName
    ? `${calendarChannel.displayName} (Email)`
    : 'Microsoft 365 Email'

  // Check if the email channel already exists so we can report created vs updated
  const existingEmailChannel = await findOneWithDecryption(
    em,
    CommunicationChannel,
    {
      tenantId: scope.tenantId,
      userId,
      providerKey: O365_MAIL_PROVIDER_KEY,
      deletedAt: null,
    },
    undefined,
    dscope,
  )

  const emailAdapter = getO365EmailAdapter()
  const channel = await createConnectedChannelRow({
    em,
    adapter: emailAdapter,
    providerKey: O365_MAIL_PROVIDER_KEY,
    displayName,
    externalIdentifier,
    credentialsRefId,
    userId,
    scope,
  })

  return {
    channelId: channel.id,
    created: !existingEmailChannel,
  }
}

/**
 * Returns the email channel for the current user, or null if not provisioned.
 */
export async function findEmailChannel(
  em: EntityManager,
  userId: string,
  scope: { tenantId: string; organizationId: string | null },
): Promise<CommunicationChannel | null> {
  const dscope = { tenantId: scope.tenantId, organizationId: scope.organizationId ?? null }
  return findOneWithDecryption(
    em,
    CommunicationChannel,
    {
      tenantId: scope.tenantId,
      userId,
      providerKey: O365_MAIL_PROVIDER_KEY,
      deletedAt: null,
    },
    undefined,
    dscope,
  )
}
