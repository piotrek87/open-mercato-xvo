import type { ApiInterceptor } from '@open-mercato/shared/lib/crud/api-interceptor'

// office365_mail filtering from GET /api/communication_channels/me/channels is
// handled via a route override in src/modules.ts — interceptors don't run on
// custom routes that don't call runCustomRouteAfterInterceptors.

export const interceptors: ApiInterceptor[] = []
