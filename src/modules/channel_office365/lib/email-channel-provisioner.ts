/**
 * Email channel auto-provisioning helper.
 *
 * After a user connects Microsoft 365 (calendar OAuth flow), the hub creates a
 * CommunicationChannel with providerKey='office365'. This provisioner creates a
 * SIBLING email channel with providerKey='office365_mail' that shares the same
 * OAuth credentials.
 *
 * Idempotent: safe to call multiple times. Handles three cases:
 *   1. Active email channel exists  → update credentials in place
 *   2. Soft-deleted email channel   → reactivate + update credentials
 *   3. No email channel             → create new row directly
 *
 * We bypass createConnectedChannelRow deliberately: its cross-provider conflict
 * guard correctly blocks two unrelated providers sharing the same mailbox, but
 * office365 (calendar) + office365_mail (email) are siblings intentionally
 * designed to share the same externalIdentifier (the user's email address).
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { getO365EmailAdapter } from './graph-mail-adapter'

// Polling cadence for email — mirrors EMAIL_POLL_INTERVAL_SECONDS from the hub
const EMAIL_POLL_INTERVAL_SECONDS = 300
import { O365_PROVIDER_KEY, O365_MAIL_PROVIDER_KEY } from './credentials'

// Default look-back window for the FIRST email sync after enabling. The mailbox shows nothing
// older than this until the user widens the window via the date picker + Sync. This value is
// surfaced in the M365 settings UI so the user knows mail before this date is not synced.
export const EMAIL_SYNC_LOOKBACK_DAYS = 1
function defaultEmailSyncFromDate(): string {
  return new Date(Date.now() - EMAIL_SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

export interface ProvisionEmailChannelArgs {
  em: EntityManager
  userId: string
  scope: { tenantId: string; organizationId: string | null }
}

export interface ProvisionEmailChannelResult {
  channelId: string
  /** true when a new channel was created, false when an existing channel was updated/reactivated */
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

  const emailAdapter = getO365EmailAdapter()
  const credentialsAvailable = credentialsRefId !== null

  const applyState = (target: CommunicationChannel, isNew: boolean): void => {
    target.credentialsRef = credentialsRefId
    target.externalIdentifier = externalIdentifier ?? null
    target.displayName = displayName
    target.channelType = emailAdapter.channelType
    target.capabilities = emailAdapter.capabilities as unknown as Record<string, unknown>
    // isActive stays false until the user explicitly enables email sync via capabilities toggle.
    // The hub only polls channels where isActive=true, so this is the on/off gate.
    if (!credentialsAvailable) {
      target.isActive = false
      target.status = 'requires_reauth'
      target.lastError = 'credentials_persist_failed'
    } else if (isNew) {
      // Newly provisioned — start inactive; capabilities PATCH will activate it.
      target.isActive = false
      target.status = 'disconnected'
      target.lastError = null
    }
    // On update (isNew=false): preserve existing isActive — user may have already enabled it.
    target.pollIntervalSeconds = EMAIL_POLL_INTERVAL_SECONDS
    target.deletedAt = null
    // Align organizationId with auth.orgId so poll-now and me/channels can find this channel
    target.organizationId = scope.organizationId ?? null
    // Preserve existing sync state on re-provision. The M365 page's "healing" effect calls
    // this provisioner on EVERY mount (idempotent safety net), so wiping channelState here
    // used to reset syncFromDate to "now" and discard the persisted delta token on every page
    // load — historical mail never synced and the delta never advanced. Only initialize the
    // sync window when the channel has none yet; otherwise leave syncFromDate + delta intact.
    const existingSyncFromDate = (target.channelState as { syncFromDate?: unknown } | null)?.syncFromDate
    if (typeof existingSyncFromDate !== 'string') {
      target.channelState = {
        ...(target.channelState ?? {}),
        syncFromDate: defaultEmailSyncFromDate(),
      }
    }
  }

  // Prefer active email channel; fall back to a soft-deleted one so we can reactivate
  // it instead of inserting a duplicate after a DB reset or manual cleanup.
  const existingEmailChannel =
    (await findOneWithDecryption(
      em,
      CommunicationChannel,
      { tenantId: scope.tenantId, userId, providerKey: O365_MAIL_PROVIDER_KEY, deletedAt: null },
      undefined,
      dscope,
    )) ??
    // Non-encrypted lookup — safe to use em.findOne for soft-deleted discovery
    (await em.findOne(CommunicationChannel, {
      tenantId: scope.tenantId,
      userId,
      providerKey: O365_MAIL_PROVIDER_KEY,
    }))

  if (existingEmailChannel) {
    applyState(existingEmailChannel, false)
    await em.flush()
    return { channelId: existingEmailChannel.id, created: false }
  }

  // No existing email channel — create one directly, inactive until user enables email sync.
  const newChannel = em.create(CommunicationChannel, {
    providerKey: O365_MAIL_PROVIDER_KEY,
    channelType: emailAdapter.channelType,
    displayName,
    externalIdentifier: externalIdentifier ?? null,
    credentialsRef: credentialsRefId,
    capabilities: emailAdapter.capabilities as unknown as Record<string, unknown>,
    isActive: false,
    userId,
    isPrimary: false,
    pollIntervalSeconds: EMAIL_POLL_INTERVAL_SECONDS,
    status: credentialsAvailable ? 'disconnected' : 'requires_reauth',
    lastError: credentialsAvailable ? null : 'credentials_persist_failed',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId ?? null,
    channelState: { syncFromDate: defaultEmailSyncFromDate() },
  })
  em.persist(newChannel)
  await em.flush()
  return { channelId: newChannel.id, created: true }
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
