import { z } from 'zod'

/**
 * Tenant-level OAuth app config stored on IntegrationCredentials for
 * 'channel_office365' at tenant scope (userId=null).
 * Managed by admin via the integration settings page.
 */
export const o365ClientCredentialsSchema = z
  .object({
    clientId: z.string().min(1, 'Azure Application (client) ID required'),
    clientSecret: z.string().min(1, 'Azure client secret required'),
    // Azure AD tenant ID (e.g. xentivo.pl or the GUID). When set, uses the
    // tenant-specific endpoint instead of /common — required when admin consent
    // is configured for a specific directory. Leave empty for multi-tenant apps.
    tenantId: z.string().optional(),
  })
  .strict()

export type O365ClientCredentials = z.infer<typeof o365ClientCredentialsSchema>

/**
 * Per-user OAuth tokens stored on IntegrationCredentials for
 * 'channel_office365' at user scope (userId set).
 * Encrypted at rest by the hub's credentials service.
 */
export const o365UserCredentialsSchema = z
  .object({
    accessToken: z.string().min(1, 'Access token required'),
    refreshToken: z.string().optional(),
    expiresAt: z.string().datetime().optional(),
    email: z.string().email().optional(),
    displayName: z.string().optional(),
    msUserId: z.string().optional(),
  })
  .passthrough()

export type O365UserCredentials = z.infer<typeof o365UserCredentialsSchema>

/**
 * Per-capability sync state nested inside channelState.capabilities.
 * Each capability (calendar, mail, …) gets its own delta cursor and flags.
 */
const o365CapabilityStateSchema = z
  .object({
    enabled: z.boolean().optional(),
    deltaToken: z.string().optional(),
    sentItemsDeltaToken: z.string().optional(),
    lastSyncedAt: z.string().optional(),
    bootstrapped: z.boolean().optional(),
    syncFromDate: z.string().optional(), // ISO date — user-configured bootstrap cutoff
  })
  .passthrough()

export type O365CapabilityState = z.infer<typeof o365CapabilityStateSchema>

/**
 * Per-channel sync state stored on CommunicationChannel.channelState (JSONB).
 *
 * Sprint 5 model (unified M365 connector):
 *   capabilities.calendar  — calendar sync state (deltaToken, enabled, …)
 *   capabilities.mail      — mail sync state (added in Sprint 5)
 *   grantedScopes          — OAuth scopes granted by the user
 *
 * Backward compat: legacy top-level deltaToken / lastSyncedAt / bootstrapped
 * from Sprint 4A-4C are retained in the schema so existing records parse
 * without errors. The calendar-sync worker reads capabilities.calendar.deltaToken
 * first and falls back to the legacy top-level deltaToken if capabilities are
 * absent (pre-migration channels). After the first successful sync the worker
 * writes the new nested structure; the SQL migration cleans up remaining records.
 */
export const o365ChannelStateSchema = z
  .object({
    capabilities: z
      .object({
        calendar: o365CapabilityStateSchema.optional(),
        mail: o365CapabilityStateSchema.optional(),
      })
      .optional(),
    grantedScopes: z.array(z.string()).optional(),
    // Legacy flat fields (Sprint 4A-4C) — read-only; worker migrates on write
    deltaToken: z.string().optional(),
    lastSyncedAt: z.string().optional(),
    bootstrapped: z.boolean().optional(),
  })
  .partial()
  .passthrough()

export type O365ChannelState = z.infer<typeof o365ChannelStateSchema>

export const O365_DEFAULT_SCOPES = [
  'https://graph.microsoft.com/Calendars.ReadWrite',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
]

// Mail.ReadWrite covers all Mail.Read capabilities — used to detect mail scope in grantedScopes
export const O365_MAIL_READ_SCOPE = 'https://graph.microsoft.com/Mail.ReadWrite'

// Unified Microsoft 365 channel — one connection per user, capability-based
export const O365_PROVIDER_KEY = 'office365'
// Separate channel registered in the hub for email (adapter providerKey)
export const O365_MAIL_PROVIDER_KEY = 'office365_mail'
export const O365_INTEGRATION_ID = 'channel_office365'

// externalProvider values on Activity records — semantic identifiers for data origin.
// These NEVER change: existing Activity records keep 'office365_calendar' forever.
export const O365_EXTERNAL_PROVIDER_CALENDAR = 'office365_calendar'
export const O365_EXTERNAL_PROVIDER_MAIL = 'office365_mail'
// Backward compat alias used by calendar-sync worker
export const O365_EXTERNAL_PROVIDER = O365_EXTERNAL_PROVIDER_CALENDAR
