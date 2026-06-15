/**
 * O365 Calendar ChannelAdapter.
 *
 * Registers with the communication_channels hub to provide:
 *  - OAuth lifecycle (buildOAuthAuthorizeUrl, exchangeOAuthCode, refreshCredentials)
 *  - realtimePush: true → hub does NOT poll; our calendar-sync worker handles ingestion
 *
 * The adapter stubs required ChannelAdapter methods (sendMessage, verifyWebhook, etc.)
 * as calendar events are consumed by the calendar-sync worker, not the messages pipeline.
 */

import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelNativeContent,
  ConvertOutboundInput,
  GetMessageStatusInput,
  InboundMessage,
  MessageStatus,
  NormalizedInboundMessage,
  SendMessageInput,
  SendMessageResult,
  VerifyWebhookInput,
  BuildOAuthAuthorizeUrlInput,
  BuildOAuthAuthorizeUrlResult,
  ExchangeOAuthCodeInput,
  ExchangeOAuthCodeResult,
  RefreshCredentialsInput,
  RefreshedCredentials,
} from '@open-mercato/core/modules/communication_channels/lib/adapter'

import {
  o365ClientCredentialsSchema,
  o365UserCredentialsSchema,
  O365_DEFAULT_SCOPES,
  O365_PROVIDER_KEY,
} from './credentials'
import { getMsOAuthClient, tokenResponseToExpiresAt } from './oauth'

export const o365CalendarCapabilities: ChannelCapabilities = {
  threading: false,
  richText: false,
  fileSharing: false,
  readReceipts: false,
  deliveryReceipts: false,
  typingIndicators: false,
  reactions: false,
  multiReactionPerUser: false,
  editMessage: false,
  deleteMessage: false,
  presence: false,
  richBlocks: false,
  interactiveComponents: false,
  inlineImages: false,
  conversationHistory: false,
  contactCards: false,
  locationSharing: false,
  voiceNotes: false,
  stickers: false,
  supportedBodyFormats: ['text'],
  // true = hub does NOT poll; calendar-sync worker handles it independently
  realtimePush: true,
}

class O365CalendarChannelAdapter implements ChannelAdapter {
  readonly providerKey = O365_PROVIDER_KEY
  readonly channelType = 'calendar'
  readonly capabilities = o365CalendarCapabilities

  async sendMessage(_input: SendMessageInput): Promise<SendMessageResult> {
    return { externalMessageId: '', status: 'failed', error: 'Calendar channel does not support sending messages' }
  }

  async verifyWebhook(_input: VerifyWebhookInput): Promise<InboundMessage> {
    // Calendar adapter uses polling (calendar-sync worker), not webhooks
    return { raw: {}, eventType: 'other', metadata: { reason: 'office365-calendar-uses-polling' } }
  }

  async getStatus(_input: GetMessageStatusInput): Promise<MessageStatus> {
    return { status: 'sent' }
  }

  async convertOutbound(_input: ConvertOutboundInput): Promise<ChannelNativeContent> {
    return { content: { text: '' } }
  }

  async normalizeInbound(_raw: InboundMessage): Promise<NormalizedInboundMessage> {
    throw new Error('O365 calendar does not ingest messages through the hub pipeline')
  }

  async buildOAuthAuthorizeUrl(input: BuildOAuthAuthorizeUrlInput): Promise<BuildOAuthAuthorizeUrlResult> {
    const client = parseClientCredentialsOrThrow(input.credentials)
    const url = getMsOAuthClient().buildAuthorizeUrl({
      clientId: client.clientId,
      redirectUri: input.redirectUri,
      state: input.state,
      scopes: O365_DEFAULT_SCOPES,
      loginHint: input.loginHint,
    })
    return { authorizeUrl: url, extra: { scopes: O365_DEFAULT_SCOPES } }
  }

  async exchangeOAuthCode(input: ExchangeOAuthCodeInput): Promise<ExchangeOAuthCodeResult> {
    const client = parseClientCredentialsOrThrow(input.credentials)
    const token = await getMsOAuthClient().exchangeCode({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: input.redirectUri,
      code: input.code,
    })
    let email: string | undefined
    let displayName: string | undefined
    let msUserId: string | undefined
    try {
      const userInfo = await getMsOAuthClient().fetchUserInfo(token.access_token)
      email = userInfo.mail ?? userInfo.userPrincipalName
      displayName = userInfo.displayName ?? email
      msUserId = userInfo.id
    } catch {
      // Non-fatal — fall back to token data
    }
    const expiresAt = tokenResponseToExpiresAt(token)
    return {
      credentials: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: expiresAt?.toISOString(),
        email,
        displayName,
        msUserId,
      },
      externalIdentifier: email,
      displayName: displayName ?? email,
      expiresAt: expiresAt ?? undefined,
    }
  }

  async refreshCredentials(input: RefreshCredentialsInput): Promise<RefreshedCredentials> {
    const current = o365UserCredentialsSchema.parse(input.credentials)
    if (!current.refreshToken) {
      throw new Error('requires_reauth')
    }
    const oauthClient = input.oauthClient
    if (!oauthClient?.clientId || !oauthClient?.clientSecret) {
      throw new Error('[internal] O365 OAuth client credentials (clientId/clientSecret) required for refresh')
    }
    const token = await getMsOAuthClient().refreshToken({
      clientId: oauthClient.clientId,
      clientSecret: oauthClient.clientSecret,
      refreshToken: current.refreshToken,
    })
    const expiresAt = tokenResponseToExpiresAt(token)
    return {
      credentials: {
        ...current,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? current.refreshToken,
        expiresAt: expiresAt?.toISOString(),
      },
      expiresAt: expiresAt ?? undefined,
    }
  }
}

function parseClientCredentialsOrThrow(value: unknown) {
  const parsed = o365ClientCredentialsSchema.safeParse(value)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new Error(`Invalid O365 client credentials: ${first?.message ?? 'validation error'}`)
  }
  return parsed.data
}

let cachedAdapter: O365CalendarChannelAdapter | null = null

export function getO365CalendarAdapter(): O365CalendarChannelAdapter {
  if (!cachedAdapter) cachedAdapter = new O365CalendarChannelAdapter()
  return cachedAdapter
}
