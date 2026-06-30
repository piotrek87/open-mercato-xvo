import { NextResponse } from 'next/server'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { Attachment } from '@open-mercato/core/modules/attachments/data/entities'
import { storePartitionFile } from '@open-mercato/core/modules/attachments/lib/storage'
import { checkAttachmentLimits, resolveMailAttachmentLimits } from '../../../lib/config'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['mail_attachments.upload'] },
}

/**
 * Partition for outbound-mail uploads. Distinct from inbound `email_attachments` so the TTL worker
 * can sweep unsent uploads without touching synced inbound files. Pending (never-sent) uploads keep
 * `entityId = ENTITY_PENDING`; on send they are re-linked to the outbound MessageChannelLink (P1.7).
 */
const PARTITION = 'email_outbound_attachments'
const ENTITY_PENDING = 'mail_attachments:pending_upload'

/**
 * POST /api/mail_attachments/mail_attachments/upload — multipart single-file upload.
 * (The route generator prefixes the module id, so the file at api/mail_attachments/upload maps to
 * /api/mail_attachments/mail_attachments/upload — same double-nesting as the channel_office365 routes.)
 *
 * Stores the file via the attachments module (the single source of truth for fileName/MIME/size)
 * and returns a durable reference (`attachmentId`) the caller puts in a `MailAttachmentRef`. The
 * same ref can be attached to many messages with no re-upload.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing "file" field' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const fileName = file.name && file.name.trim().length > 0 ? file.name : 'attachment'
  const mimeType = file.type && file.type.trim().length > 0 ? file.type : 'application/octet-stream'

  // Per-file size limit (count + combined total are enforced at compose time, where the full set is
  // known). Limits are configuration (decision 10).
  const limits = resolveMailAttachmentLimits()
  const violation = checkAttachmentLimits([{ size: buffer.length, fileName }], limits)
  if (violation) {
    return NextResponse.json({ error: 'attachment_limit', violation }, { status: 413 })
  }

  const container = await createRequestContainer()
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const organizationId = scope?.selectedId ?? (auth as { orgId?: string | null }).orgId ?? null
  const em = (container.resolve('em') as EntityManager).fork()

  const stored = await storePartitionFile({
    partitionCode: PARTITION,
    orgId: organizationId,
    tenantId: auth.tenantId as string,
    fileName,
    buffer,
  })

  const attachmentId = randomUUID()
  em.create(Attachment, {
    id: attachmentId,
    entityId: ENTITY_PENDING,
    recordId: attachmentId,
    organizationId: organizationId ?? null,
    tenantId: auth.tenantId as string,
    partitionCode: PARTITION,
    fileName,
    mimeType,
    fileSize: buffer.length,
    storageDriver: 'local',
    storagePath: stored.storagePath,
    url: `/api/attachments/file/${attachmentId}`,
    content: null,
  })
  await em.flush()

  return NextResponse.json({ attachmentId, fileName, mimeType, size: buffer.length })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'mail_attachments',
  methods: {
    POST: {
      summary: 'Upload a single outbound mail attachment; returns a durable attachment reference',
      tags: ['mail_attachments'],
      responses: [
        {
          status: 200,
          description: 'Stored',
          schema: z.object({
            attachmentId: z.string(),
            fileName: z.string(),
            mimeType: z.string(),
            size: z.number(),
          }),
        },
        { status: 400, description: 'Missing or invalid file' },
        { status: 401, description: 'Unauthorized' },
        { status: 413, description: 'Attachment exceeds configured size limit' },
      ],
    },
  },
}
