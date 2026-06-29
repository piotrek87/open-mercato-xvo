import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'kysely'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { applyEmailVisibilityFilter } from '@open-mercato/core/modules/customers/lib/visibilityFilter'
import { MessageChannelLink } from '@open-mercato/core/modules/communication_channels/data/entities'
import { O365_MAIL_PROVIDER_KEY } from '../../../lib/credentials'
import { loadAttachmentsForLinkIds } from '../../../lib/email-attachments'
import {
  O365_MAIL_SOURCE_PREFIX,
  buildScopedAttachmentGroups,
  buildSingleAttachmentGroup,
  dedupeCiMetaBySource,
  summarizeAttachmentGroups,
  type EmailAttachmentGroup,
} from '../../../lib/email-attachments-shape'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['channel_office365.view'] },
}

const querySchema = z.object({
  // Single-email selectors (Faza 0): the external message identity or the hub link id.
  externalMessageId: z.string().min(1).optional(),
  linkId: z.string().uuid().optional(),
  // Scoped-list selectors: every O365 email attached to a person / company.
  personId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  // Return only the totals (for the awareness chip).
  countOnly: z.enum(['1', 'true']).optional(),
})

const fileSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  fileSize: z.number(),
  url: z.string(),
})
const skippedSchema = z.object({ fileName: z.string(), fileSizeBytes: z.number(), status: z.string() })
const groupSchema = z.object({
  externalMessageId: z.string().nullable(),
  linkId: z.string(),
  subject: z.string().nullable(),
  occurredAt: z.string().nullable(),
  direction: z.string().nullable(),
  files: z.array(fileSchema),
  skipped: z.array(skippedSchema),
})
const responseSchema = z.object({
  groups: z.array(groupSchema),
  totalFiles: z.number(),
  emailsWithAttachments: z.number(),
})

/**
 * Company → linked persons. Mirrors `resolveExpandedEntityIds` in
 * interactions-get-override so the company attachment list matches the company
 * activities tab (a person linked to the company contributes their emails).
 */
async function resolveEntityIds(
  db: any,
  entityId: string,
  kind: 'person' | 'company',
  tenantId: string,
): Promise<string[]> {
  if (kind === 'person') return [entityId]
  const rows = (await db
    .selectFrom('customer_person_company_links')
    .select(['person_entity_id'])
    .where('company_entity_id', '=', entityId)
    .where('tenant_id', '=', tenantId)
    .where('deleted_at', 'is', null)
    .execute()) as Array<{ person_entity_id: string }>
  return [entityId, ...rows.map((r) => r.person_entity_id)]
}

/**
 * GET /api/channel_office365/channel_office365/email-attachments
 *
 * Lists stored, downloadable attachments for synced O365 emails. Two modes, one
 * unified response (`{ groups, totalFiles, emailsWithAttachments }`):
 *   - Single email — `?externalMessageId=` or `?linkId=` → exactly one group
 *     (Faza 0: the Activity detail reads `groups[0]`).
 *   - Scoped list — `?personId=` or `?companyId=` → one group per the entity's
 *     O365 emails that have downloadable attachments, newest first, filtered by
 *     the same private/shared visibility rule as the timeline.
 * Add `&countOnly=1` to get just `{ totalFiles, emailsWithAttachments }`.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query' }, { status: 400 })
  }
  const q = parsed.data
  const singleMode = q.linkId || q.externalMessageId
  const scopedMode = q.personId || q.companyId
  if (!singleMode && !scopedMode) {
    return NextResponse.json(
      { error: 'externalMessageId, linkId, personId or companyId is required' },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()
  const tenantId = auth.tenantId as string

  let groups: EmailAttachmentGroup[] = []

  if (singleMode) {
    const link = q.linkId
      ? await em.findOne(MessageChannelLink, { id: q.linkId, tenantId })
      : await em.findOne(MessageChannelLink, {
          externalMessageId: q.externalMessageId,
          providerKey: O365_MAIL_PROVIDER_KEY,
          tenantId,
        })
    if (link) {
      const filesMap = await loadAttachmentsForLinkIds(em, [link.id], { tenantId })
      const group = buildSingleAttachmentGroup(
        { id: link.id, externalMessageId: link.externalMessageId ?? null, channelPayload: link.channelPayload },
        filesMap.get(link.id) ?? [],
      )
      if (group) groups = [group]
    }
  } else {
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
    const orgIds = Array.isArray(scope?.filterIds) && scope.filterIds.length > 0
      ? scope.filterIds
      : auth.orgId
        ? [auth.orgId]
        : []
    const db = em.getKysely<any>() as any
    const entityId = (q.personId ?? q.companyId) as string
    const kind: 'person' | 'company' = q.companyId ? 'company' : 'person'
    const entityIds = await resolveEntityIds(db, entityId, kind, tenantId)

    let ciQuery = db
      .selectFrom('customer_interactions')
      .select(['source', 'title', 'occurred_at', 'interaction_type', 'visibility', 'author_user_id'])
      .where('tenant_id', '=', tenantId)
      .where('deleted_at', 'is', null)
      .where('channel_provider_key', '=', O365_MAIL_PROVIDER_KEY)
      .where(sql<boolean>`source like ${O365_MAIL_SOURCE_PREFIX + '%'}`)
    ciQuery = entityIds.length === 1
      ? ciQuery.where('entity_id', '=', entityIds[0])
      : ciQuery.where('entity_id', 'in', entityIds)
    if (orgIds.length === 1) ciQuery = ciQuery.where('organization_id', '=', orgIds[0])
    else if (orgIds.length > 1) ciQuery = ciQuery.where('organization_id', 'in', orgIds)

    const viewerUserId = auth.isApiKey ? null : auth.sub ?? null
    ciQuery = applyEmailVisibilityFilter(ciQuery, { currentUserId: viewerUserId, userFeatures: undefined })

    const ciRows = (await ciQuery.execute()) as Array<{
      source: string | null
      title: string | null
      occurred_at: Date | string | null
    }>

    const metaByExt = dedupeCiMetaBySource(
      ciRows.map((r) => ({ source: r.source, title: r.title, occurredAt: r.occurred_at })),
    )
    const extMsgIds = [...metaByExt.keys()]

    if (extMsgIds.length > 0) {
      const links = await em.find(MessageChannelLink, {
        externalMessageId: { $in: extMsgIds },
        providerKey: O365_MAIL_PROVIDER_KEY,
        tenantId,
      })
      const linkInfoByExt = new Map<string, { linkId: string; direction: string | null }>()
      for (const l of links) {
        if (!l.externalMessageId) continue
        const cp = (l.channelPayload ?? {}) as { direction?: string | null }
        linkInfoByExt.set(l.externalMessageId, { linkId: l.id, direction: cp.direction ?? null })
      }
      const filesMap = await loadAttachmentsForLinkIds(em, links.map((l) => l.id), { tenantId })
      groups = buildScopedAttachmentGroups(metaByExt, linkInfoByExt, filesMap)
    }
  }

  const totals = summarizeAttachmentGroups(groups)

  if (q.countOnly) {
    return NextResponse.json(totals)
  }
  return NextResponse.json({ groups, ...totals })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    GET: {
      summary: 'List stored attachments for synced Microsoft 365 emails (single email or person/company scoped)',
      tags: ['channel_office365'],
      responses: [
        { status: 200, description: 'Attachment groups', schema: responseSchema },
        { status: 400, description: 'Missing/invalid selector' },
        { status: 401, description: 'Unauthorized' },
      ],
    },
  },
}
