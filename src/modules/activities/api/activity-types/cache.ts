import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

export const ACTIVITY_TYPE_DEFS_CACHE_TAG = (tenantId: string, orgId: string) =>
  `activity_type_defs:${tenantId}:${orgId}`

export const ACTIVITY_TYPE_DEFS_CACHE_KEY_ACTIVE = (tenantId: string, orgId: string) =>
  `${tenantId}:${orgId}:activity_type_defs:active`

export const ACTIVITY_TYPE_DEFS_CACHE_KEY_ALL = (tenantId: string, orgId: string) =>
  `${tenantId}:${orgId}:activity_type_defs:all`

export async function invalidateActivityTypeDefsCache(tenantId: string, orgId?: string | null): Promise<void> {
  try {
    const container = await createRequestContainer()
    const cacheService = container.resolve('cacheService') as { invalidateTag: (tag: string) => Promise<void> }
    if (orgId) {
      await cacheService.invalidateTag(ACTIVITY_TYPE_DEFS_CACHE_TAG(tenantId, orgId))
    } else {
      // Fallback: invalidate tenant-wide tag when orgId is unavailable
      await cacheService.invalidateTag(`activity_type_defs:${tenantId}`)
    }
  } catch {
    // Cache invalidation failure is non-fatal — DB remains source of truth
    console.warn('[activities] cache invalidation failed for activity_type_defs')
  }
}
