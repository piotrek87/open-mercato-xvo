/**
 * Dumb Microsoft Graph attachment transport. Operates ONLY on plain files
 * (`GraphAttachableFile`) — it knows nothing about CRM `Attachment`s, `MailAttachmentRef`s, or any
 * other domain model. Resolution of references → files happens upstream (the provider-agnostic
 * `mailAttachmentResolver`); this file's sole job is talking to Graph.
 *
 * Strategy (Graph rules): a file < 3 MB is added in one call; a file ≥ 3 MB uses an upload session
 * with chunked PUTs (chunk size a multiple of 320 KiB, as Graph requires for all but the last chunk).
 */

import { GraphApiError } from './graph-client'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const SIMPLE_ADD_MAX_BYTES = 3 * 1024 * 1024            // < 3 MB → single add; ≥ 3 MB → upload session
const UPLOAD_CHUNK_BYTES = 320 * 1024 * 12              // 3.75 MiB — a 320 KiB multiple (Graph requirement)

/** Minimal file contract the transport consumes. Structurally satisfied by `ResolvedMailAttachment`. */
export interface GraphAttachableFile {
  fileName: string
  contentType: string
  size: number
  read(): Promise<Buffer>
}

/** Attach every file to an existing Graph draft message, in order. */
export async function attachFilesToGraphDraft(
  accessToken: string,
  messageId: string,
  files: GraphAttachableFile[],
): Promise<void> {
  for (const file of files) {
    const bytes = await file.read()
    if (bytes.length < SIMPLE_ADD_MAX_BYTES) {
      await simpleAdd(accessToken, messageId, file, bytes)
    } else {
      await uploadSessionAdd(accessToken, messageId, file, bytes)
    }
  }
}

async function simpleAdd(
  accessToken: string,
  messageId: string,
  file: GraphAttachableFile,
  bytes: Buffer,
): Promise<void> {
  const res = await fetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: file.fileName,
      contentType: file.contentType,
      contentBytes: bytes.toString('base64'),
    }),
  })
  if (!res.ok) {
    throw new GraphApiError(res.status, `Graph attachment add failed (${res.status}) for ${file.fileName}: ${await safeError(res)}`)
  }
}

async function uploadSessionAdd(
  accessToken: string,
  messageId: string,
  file: GraphAttachableFile,
  bytes: Buffer,
): Promise<void> {
  // 1) Open an upload session for this attachment.
  const sessionRes = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        AttachmentItem: { attachmentType: 'file', name: file.fileName, size: bytes.length, contentType: file.contentType },
      }),
    },
  )
  if (!sessionRes.ok) {
    throw new GraphApiError(sessionRes.status, `Graph createUploadSession failed (${sessionRes.status}) for ${file.fileName}: ${await safeError(sessionRes)}`)
  }
  const session = (await sessionRes.json()) as { uploadUrl?: string }
  const uploadUrl = session.uploadUrl
  if (!uploadUrl) throw new GraphApiError(500, `Graph createUploadSession returned no uploadUrl for ${file.fileName}`)

  // 2) PUT the bytes in 320 KiB-multiple chunks (last chunk may be smaller). uploadUrl is pre-signed.
  const total = bytes.length
  for (let start = 0; start < total; start += UPLOAD_CHUNK_BYTES) {
    const end = Math.min(start + UPLOAD_CHUNK_BYTES, total)
    const chunk = bytes.subarray(start, end)
    // Wrap in a Blob so the request body is an unambiguous DOM `BodyInit` (sidesteps the
    // Node `Buffer`/`Uint8Array<ArrayBufferLike>` vs DOM `BodyInit` typing mismatch).
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end - 1}/${total}`,
      },
      body: new Blob([new Uint8Array(chunk)]),
    })
    // 200/201 = complete; 202 = more chunks expected.
    if (!res.ok && res.status !== 202) {
      throw new GraphApiError(res.status, `Graph upload chunk failed (${res.status}) for ${file.fileName}: ${await safeError(res)}`)
    }
  }
}

async function safeError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    return body?.error?.message ?? res.statusText
  } catch {
    return res.statusText
  }
}
