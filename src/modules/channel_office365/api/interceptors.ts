import type { EntityManager } from '@mikro-orm/postgresql'
import type { ApiInterceptor } from '@open-mercato/shared/lib/crud/api-interceptor'
import { MessageChannelLink } from '@open-mercato/core/modules/communication_channels/data/entities'
import { O365_MAIL_PROVIDER_KEY } from '../lib/credentials'
import { loadAttachmentsForLinkIds } from '../lib/email-attachments'
import { applyEmailAttachmentCounts } from '../lib/email-attachments-shape'

// office365_mail filtering from GET /api/communication_channels/me/channels is
// handled via a route override in src/modules.ts — interceptors don't run on
// custom routes that don't call runCustomRouteAfterInterceptors.

/**
 * Decoupling note: the generic `activities` module never imports
 * `channel_office365`. Instead the activities list route opts into
 * `runCustomRouteAfterInterceptors`, and this `after` interceptor enriches each
 * office365_mail row with `emailAttachmentCount` so the injected 📎 column has
 * data. One links query + one attachments query per page (no N+1). The count is
 * stored-files-only by construction (see `loadAttachmentsForLinkIds`).
 */
const activitiesEmailAttachmentCount: ApiInterceptor = {
  id: 'channel_office365.activities-email-attachment-count',
  targetRoute: 'activities',
  methods: ['GET'],
  priority: 50,
  async after(_request, response, context) {
    const body = response.body as { data?: unknown } | undefined
    const rows = Array.isArray(body?.data) ? (body!.data as Array<Record<string, unknown>>) : null
    if (!rows || rows.length === 0) return {}
    const tenantId = context.tenantId
    if (!tenantId) return {}

    const extMsgIds = Array.from(
      new Set(
        rows
          .filter((r) => r.externalProvider === O365_MAIL_PROVIDER_KEY && typeof r.externalId === 'string' && r.externalId)
          .map((r) => r.externalId as string),
      ),
    )
    if (extMsgIds.length === 0) return {}

    const em = context.em as EntityManager
    const links = await em.find(MessageChannelLink, {
      externalMessageId: { $in: extMsgIds },
      providerKey: O365_MAIL_PROVIDER_KEY,
      tenantId,
    })
    const linkIdByExt = new Map<string, string>()
    for (const l of links) if (l.externalMessageId) linkIdByExt.set(l.externalMessageId, l.id)

    const filesMap = await loadAttachmentsForLinkIds(em, links.map((l) => l.id), { tenantId })

    const countByExt = new Map<string, number>()
    for (const ext of extMsgIds) {
      const linkId = linkIdByExt.get(ext)
      countByExt.set(ext, linkId ? (filesMap.get(linkId)?.length ?? 0) : 0)
    }

    return { merge: { data: applyEmailAttachmentCounts(rows, countByExt) } }
  },
}

export const interceptors: ApiInterceptor[] = [activitiesEmailAttachmentCount]
