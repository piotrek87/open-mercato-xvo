// Health check for integration-level credentials (clientId + clientSecret).
// Per-user token validity is reflected in channel.status, not here.
//
// Hub contract (health-service.ts normalizeProbeResult):
//   expects { status: 'healthy' | 'degraded' | 'unhealthy', message?, details? }
export const channelOffice365HealthCheck = {
  async check(credentials: Record<string, unknown>): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy'
    details?: Record<string, unknown>
    message?: string
  }> {
    const clientId = credentials.clientId as string | undefined
    const clientSecret = credentials.clientSecret as string | undefined

    if (!clientId || !clientSecret) {
      return { status: 'unhealthy', message: 'Client ID and Secret are required' }
    }

    // Probe Azure OIDC discovery — no auth needed, just checks connectivity.
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8_000)
      let res: Response
      try {
        res = await fetch(
          'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
          { signal: controller.signal },
        )
      } finally {
        clearTimeout(timeout)
      }
      if (!res.ok) {
        return { status: 'unhealthy', message: `Azure identity endpoint returned ${res.status}` }
      }
      return { status: 'healthy', details: { clientId, configured: true } }
    } catch (err) {
      return {
        status: 'unhealthy',
        message: err instanceof Error ? err.message : 'Cannot reach Azure identity endpoint',
      }
    }
  },
}
