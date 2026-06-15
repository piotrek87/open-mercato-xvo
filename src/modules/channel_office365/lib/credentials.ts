import { z } from 'zod'

/**
 * Tenant-level OAuth app config stored on IntegrationCredentials for
 * 'channel_office365_calendar' at tenant scope (userId=null).
 * Managed by admin via the integration settings page.
 */
export const o365ClientCredentialsSchema = z
  .object({
    clientId: z.string().min(1, 'Azure Application (client) ID required'),
    clientSecret: z.string().min(1, 'Azure client secret required'),
  })
  .strict()

export type O365ClientCredentials = z.infer<typeof o365ClientCredentialsSchema>

/**
 * Per-user OAuth tokens stored on IntegrationCredentials for
 * 'channel_office365_calendar' at user scope (userId set).
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
 * Per-channel sync state stored on CommunicationChannel.channelState (JSONB).
 * deltaToken holds the @odata.deltaLink cursor from the Graph Calendar Delta API.
 */
export const o365ChannelStateSchema = z
  .object({
    deltaToken: z.string().optional(),
    lastSyncedAt: z.string().datetime().optional(),
    bootstrapped: z.boolean().optional(),
  })
  .partial()
  .passthrough()

export type O365ChannelState = z.infer<typeof o365ChannelStateSchema>

export const O365_DEFAULT_SCOPES = [
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
]

export const O365_PROVIDER_KEY = 'office365_calendar'
export const O365_INTEGRATION_ID = 'channel_office365_calendar'
export const O365_EXTERNAL_PROVIDER = 'office365_calendar'
