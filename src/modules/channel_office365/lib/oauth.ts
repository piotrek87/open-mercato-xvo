/**
 * Microsoft Identity v2.0 OAuth helpers for Office 365 calendar integration.
 * Uses raw fetch against Microsoft's well-known endpoints.
 * Endpoints: https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow
 */

import {
  requestOAuthToken,
  tokenResponseToExpiresAt,
  type OAuthTokenResponse,
} from '@open-mercato/core/modules/communication_channels/lib/oauth-token'
import { O365_DEFAULT_SCOPES } from './credentials'

export { tokenResponseToExpiresAt }
export type TokenResponse = OAuthTokenResponse

const O365_BASE = 'https://login.microsoftonline.com'

export function o365AuthorizeUrl(tenantId?: string): string {
  return `${O365_BASE}/${tenantId ?? 'common'}/oauth2/v2.0/authorize`
}
export function o365TokenUrl(tenantId?: string): string {
  return `${O365_BASE}/${tenantId ?? 'common'}/oauth2/v2.0/token`
}

// Kept for backward compat (health.ts imports this)
export const O365_TOKEN_URL = o365TokenUrl()
export const O365_GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me'

export interface BuildAuthorizeUrlInput {
  clientId: string
  redirectUri: string
  state: string
  scopes?: string[]
  loginHint?: string
  tenantId?: string
}

export interface ExchangeCodeInput {
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
  tenantId?: string
}

export interface RefreshTokenInput {
  clientId: string
  clientSecret: string
  refreshToken: string
  tenantId?: string
}

export interface MsUserInfo {
  id?: string
  userPrincipalName?: string
  mail?: string
  displayName?: string
}

export interface MsOAuthClient {
  buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string
  exchangeCode(input: ExchangeCodeInput): Promise<TokenResponse>
  refreshToken(input: RefreshTokenInput): Promise<TokenResponse>
  fetchUserInfo(accessToken: string): Promise<MsUserInfo>
}

class RealMsOAuthClient implements MsOAuthClient {
  buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
    const scopes = input.scopes?.length ? input.scopes : O365_DEFAULT_SCOPES
    const url = new URL(o365AuthorizeUrl(input.tenantId))
    url.searchParams.set('client_id', input.clientId)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', scopes.join(' '))
    url.searchParams.set('state', input.state)
    url.searchParams.set('response_mode', 'query')
    // Always interrupt Microsoft SSO and show the account chooser. Without this,
    // Microsoft silently reuses the browser's existing session and re-connects the
    // SAME account after a disconnect — so the user can never switch mailboxes.
    // `select_account` forces the picker every time, with a "Use another account"
    // option, so each connect can target a different account.
    url.searchParams.set('prompt', 'select_account')
    if (input.loginHint) url.searchParams.set('login_hint', input.loginHint)
    return url.toString()
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<TokenResponse> {
    const params = new URLSearchParams()
    params.set('grant_type', 'authorization_code')
    params.set('code', input.code)
    params.set('redirect_uri', input.redirectUri)
    params.set('client_id', input.clientId)
    params.set('client_secret', input.clientSecret)
    params.set('scope', O365_DEFAULT_SCOPES.join(' '))
    return requestOAuthToken(o365TokenUrl(input.tenantId), params, {
      errorLabel: 'O365 OAuth code exchange failed',
    })
  }

  async refreshToken(input: RefreshTokenInput): Promise<TokenResponse> {
    const params = new URLSearchParams()
    params.set('grant_type', 'refresh_token')
    params.set('refresh_token', input.refreshToken)
    params.set('client_id', input.clientId)
    params.set('client_secret', input.clientSecret)
    params.set('scope', O365_DEFAULT_SCOPES.join(' '))
    return requestOAuthToken(o365TokenUrl(input.tenantId), params, {
      errorLabel: 'O365 OAuth refresh failed',
    })
  }

  async fetchUserInfo(accessToken: string): Promise<MsUserInfo> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await fetch(O365_GRAPH_ME_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`O365 /me fetch failed: ${res.status} ${res.statusText}`)
      }
      return (await res.json()) as MsUserInfo
    } finally {
      clearTimeout(timeout)
    }
  }
}

let cachedClient: MsOAuthClient | null = null

export function getMsOAuthClient(): MsOAuthClient {
  if (!cachedClient) cachedClient = new RealMsOAuthClient()
  return cachedClient
}

export function setMsOAuthClient(client: MsOAuthClient | null): void {
  cachedClient = client
}
