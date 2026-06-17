import type { ApiInterceptor } from '@open-mercato/shared/lib/crud/api-interceptor'

/**
 * When the CRM deals page opens "Historia interakcji z [Person]", ActivitiesSection
 * sends both entityId=personId AND dealId=dealId to GET /api/customers/interactions.
 * The route applies them as AND conditions, so O365 CIs (which have deal_id=NULL) are
 * excluded — the main list is empty even though the tab counts are correct (counts only
 * use entityId). Removing dealId when entityId is also present makes the list consistent
 * with the counts and shows all person interactions regardless of deal_id.
 */
export const interceptors: ApiInterceptor[] = [
  {
    id: 'channel_office365.customer_interactions.strip_deal_id_for_person_context',
    targetRoute: '/api/customers/interactions',
    methods: ['GET'],
    before: async (request) => {
      const query = request.query ?? {}
      const entityId = query['entityId']
      const dealId = query['dealId']
      if (entityId && dealId) {
        const newQuery = Object.fromEntries(
          Object.entries(query).filter(([k]) => k !== 'dealId'),
        )
        return { ok: true, query: newQuery }
      }
      return { ok: true }
    },
  },
]
