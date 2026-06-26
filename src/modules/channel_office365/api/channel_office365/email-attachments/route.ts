import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { MessageChannelLink } from '@open-mercato/core/modules/communication_channels/data/entities'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import { O365_MAIL_PROVIDER_KEY } from '../../../lib/credentials'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['channel_office365.view'] },
}

// Entity key used by the email-attachment-fetcher subscriber when persisting downloaded files.
const MESSAGE_LINK_ENTITY_ID = 'communication_channels:message_channel_link'

const querySchema = z.object({
  // The Graph/external message identity. Equals MessageChannelLink.externalMessageId and
  // activities.external_id for office365_mail rows, so callers can pass whichever they hold.
  externalMessageId: z.string().min(1).optional(),
  // Direct hub link id (MessageChannelLink.id). Boxed customer_interactions carry this in
  // their external_message_id column, so the timeline/E-mail surfaces can resolve directly.
  linkId: z.string().uuid().optional(),
})

const fileSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  fileSize: z.number(),
  url: z.string(),
})

const skippedSchema = z.object({
  fileName: z.string(),
  fileSizeBytes: z.number(),
  status: z.string(),
})

const responseSchema = z.object({
  files: z.array(fileSchema),
  skipped: z.array(skippedSchema),
})

type SyncRecord = {
  fileName?: string
  fileSizeBytes?: number
  status?: string
}

/**
 * GET /api/channel_office365/channel_office365/email-attachments
 *
 * Lists the attachments stored for a synced O365 email so any surface that reads the email
 * (activity detail, E-mail tab, interaction timeline) can render a downloadable list. Resolve
 * the hub MessageChannelLink either by its id (`linkId`) or by the external message identity
 * (`externalMessageId`), then return the Attachment rows the email-attachment-fetcher persisted
 * under recordId = link.id, plus any non-stored sync records (too_large / fetch_error /
 * skipped_inline) so the UI can explain gaps.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success || (!parsed.data.externalMessageId && !parsed.data.linkId)) {
    return NextResponse.json({ error: 'externalMessageId or linkId is required' }, { status: 400 })
  }

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()

  const tenantId = auth.tenantId as string

  const link = parsed.data.linkId
    ? await em.findOne(MessageChannelLink, { id: parsed.data.linkId, tenantId })
    : await em.findOne(MessageChannelLink, {
        externalMessageId: parsed.data.externalMessageId,
        providerKey: O365_MAIL_PROVIDER_KEY,
        tenantId,
      })

  if (!link) {
    return NextResponse.json({ files: [], skipped: [] })
  }

  const rows = await em.find(
    Attachment,
    {
      entityId: MESSAGE_LINK_ENTITY_ID,
      recordId: link.id,
      tenantId,
      organizationId: link.organizationId ?? null,
    },
    { orderBy: { fileName: 'asc' } },
  )

  const files = rows.map((a) => ({
    id: a.id,
    fileName: a.fileName,
    mimeType: a.mimeType,
    fileSize: a.fileSize,
    url: `/api/attachments/file/${a.id}`,
  }))

  // Surface non-downloadable records (too large, fetch failed, inline image skipped) for transparency.
  const cp = (link.channelPayload ?? {}) as { attachments?: SyncRecord[] }
  const skipped = (cp.attachments ?? [])
    .filter((r) => r.status && r.status !== 'stored')
    .map((r) => ({
      fileName: r.fileName ?? 'attachment',
      fileSizeBytes: typeof r.fileSizeBytes === 'number' ? r.fileSizeBytes : 0,
      status: r.status ?? 'unknown',
    }))

  return NextResponse.json({ files, skipped })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    GET: {
      summary: 'List stored attachments for a synced Microsoft 365 email',
      tags: ['channel_office365'],
      responses: [
        { status: 200, description: 'Attachment list', schema: responseSchema },
        { status: 400, description: 'Missing identifier' },
        { status: 401, description: 'Unauthorized' },
      ],
    },
  },
}
