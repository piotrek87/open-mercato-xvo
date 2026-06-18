import type { ApiInterceptor } from '@open-mercato/shared/lib/crud/api-interceptor'

// GET /api/customers/interactions is now fully handled by the route override in
// src/modules.ts (channel_office365 overrides.routes.api), which also covers
// company entity expansion and dealId stripping. No interceptors needed.
export const interceptors: ApiInterceptor[] = []
