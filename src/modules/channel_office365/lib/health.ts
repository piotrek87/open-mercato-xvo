import { O365_GRAPH_ME_URL } from './oauth'

export const channelOffice365HealthCheck = {
  async check(credentials: Record<string, unknown>): Promise<{
    healthy: boolean
    details?: Record<string, unknown>
    message?: string
  }> {
    const accessToken = credentials.accessToken as string | undefined
    if (!accessToken) {
      return { healthy: false, message: 'Access token missing' }
    }
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      let res: Response
      try {
        res = await fetch(O365_GRAPH_ME_URL, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }
      if (res.status === 401) {
        return { healthy: false, message: 'Access token expired — reconnect required' }
      }
      if (!res.ok) {
        return { healthy: false, message: `Graph API ${res.status}` }
      }
      const me = (await res.json()) as { displayName?: string; mail?: string; userPrincipalName?: string }
      return {
        healthy: true,
        details: {
          displayName: me.displayName,
          email: me.mail ?? me.userPrincipalName,
        },
      }
    } catch (err) {
      return {
        healthy: false,
        message: err instanceof Error ? err.message : 'Connection failed',
      }
    }
  },
}
