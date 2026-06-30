import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import {
  validateCrudMutationGuard,
  runCrudMutationGuardAfterSuccess,
} from '@open-mercato/shared/lib/crud/mutation-guard'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import type { SendAsUserService } from '@open-mercato/core/modules/communication_channels/lib/send-as-user'
import { checkAttachmentLimits, resolveMailAttachmentLimits } from '../../../../mail_attachments/lib/config'
import type { MailAttachmentRef, MailAttachmentResolver } from '../../../../mail_attachments/lib/types'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['customers.email.compose'] },
}

const composeSchema = z
  .object({
    personId: z.string().uuid(),
    userChannelId: z.string().uuid(),
    to: z.array(z.string().email()).min(1).max(50),
    cc: z.array(z.string().email()).max(50).optional(),
    bcc: z.array(z.string().email()).max(50).optional(),
    subject: z.string().min(1).max(500),
    body: z.string().min(1).max(200_000),
    bodyFormat: z.enum(['text', 'html']).default('html'),
    visibility: z.enum(['private', 'shared']).default('private'),
    inReplyTo: z.string().max(500).optional(),
    references: z.array(z.string().max(500)).max(50).optional(),
    parentMessageId: z.string().uuid().optional(),
    // References ONLY — no filename/MIME/size duplicated. The mail_attachments source is the
    // single source of truth, resolved at compose (for validation) and at send (for bytes).
    attachments: z.array(z.object({ kind: z.literal('attachment'), id: z.string().uuid() })).max(50).optional(),
  })
  .strict()

/**
 * POST /api/channel_office365/compose — our own compose-with-attachments endpoint.
 *
 * App-only path that adds attachment REFERENCES on top of the core send-as-user flow. The core
 * `ComposeEmailDialog` and `/customers/people/[id]/emails` route stay untouched. Refs travel to our
 * Graph adapter via `channelMetadata.attachments`; the adapter resolves them through the
 * provider-agnostic `mailAttachmentResolver`.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: z.infer<typeof composeSchema>
  try {
    body = composeSchema.parse(await readJsonSafe(req, null))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      { status: 422 },
    )
  }

  const container = await createRequestContainer()
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  const organizationId = scope?.selectedId ?? (auth as { orgId?: string | null }).orgId ?? null
  const userId = auth.sub as string

  const guardResult = await validateCrudMutationGuard(container, {
    tenantId: auth.tenantId,
    organizationId,
    userId,
    resourceKind: 'customers.person',
    resourceId: body.personId,
    operation: 'custom',
    requestMethod: req.method,
    requestHeaders: req.headers,
  })
  if (guardResult && !guardResult.ok) {
    return NextResponse.json(guardResult.body, { status: guardResult.status })
  }

  const em = (container.resolve('em') as EntityManager).fork()
  const dscope = { tenantId: auth.tenantId as string, organizationId }

  // Ownership check (same pattern as the core compose route).
  const person = await findOneWithDecryption(
    em,
    CustomerEntity,
    { id: body.personId, kind: 'person', tenantId: auth.tenantId, organizationId, deletedAt: null } as never,
    undefined,
    dscope,
  )
  if (!person) {
    return NextResponse.json({ error: 'Person not found' }, { status: 404 })
  }

  // Validate attachment references early (existence + scope + configurable limits) so the operator
  // gets immediate feedback instead of a silent worker failure. resolve() reads only metadata here
  // (no byte download); the adapter reads bytes at send time.
  const refs: MailAttachmentRef[] = body.attachments ?? []
  if (refs.length > 0) {
    const resolver = container.resolve('mailAttachmentResolver') as MailAttachmentResolver
    let files
    try {
      files = await resolver.resolve(refs, { tenantId: auth.tenantId as string, organizationId, actorUserId: userId })
    } catch {
      return NextResponse.json({ error: 'invalid_attachment', message: 'One or more attachments could not be resolved' }, { status: 400 })
    }
    const violation = checkAttachmentLimits(files.map((f) => ({ size: f.size, fileName: f.fileName })), resolveMailAttachmentLimits())
    if (violation) {
      return NextResponse.json({ error: 'attachment_limit', violation }, { status: 413 })
    }
  }

  const sendAsUserService = container.resolve('communicationChannelsSendAsUser') as SendAsUserService
  const sendResult = await sendAsUserService(
    container,
    { userId, tenantId: auth.tenantId as string, organizationId, auth },
    {
      userChannelId: body.userChannelId,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      body: body.bodyFormat === 'html' ? { html: body.body } : { plain: body.body },
      inReplyTo: body.inReplyTo,
      references: body.references,
      parentMessageId: body.parentMessageId,
      channelMetadata: {
        crmVisibility: body.visibility,
        crmPersonId: body.personId,
        // Refs only — consumed by our Graph adapter via the provider-agnostic resolver.
        ...(refs.length > 0 ? { attachments: refs } : {}),
      },
    },
  )

  if (!sendResult.ok) {
    return NextResponse.json({ error: sendResult.error }, { status: sendResult.status })
  }

  if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
    await runCrudMutationGuardAfterSuccess(container, {
      tenantId: auth.tenantId,
      organizationId,
      userId,
      resourceKind: 'customers.person',
      resourceId: body.personId,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      metadata: guardResult.metadata ?? null,
    })
  }

  return NextResponse.json({
    messageId: sendResult.messageId,
    threadId: sendResult.threadId,
    queuedAt: new Date().toISOString(),
  })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'channel_office365',
  methods: {
    POST: {
      summary: 'Compose + send an O365 email anchored to a Person, with attachment references',
      tags: ['channel_office365', 'Email'],
      responses: [
        { status: 200, description: 'Email queued for send' },
        { status: 401, description: 'Unauthorized' },
        { status: 403, description: 'Missing customers.email.compose feature or mutation guard rejection' },
        { status: 404, description: 'Person not found' },
        { status: 413, description: 'Attachments exceed configured limits' },
        { status: 422, description: 'Invalid request body' },
      ],
    },
  },
}

export default POST
