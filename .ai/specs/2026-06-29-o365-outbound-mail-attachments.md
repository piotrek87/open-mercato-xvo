# O365 Outbound Mail Attachments — unified, app-only attach-and-send

**Date**: 2026-06-29
**Status**: Phase 1 (backend mechanism + upload-from-disk) IMPLEMENTED & verified (tsc + 39 unit tests + generate green; ACL synced). Phase 2 (operator compose dialog UI) pending. Phases 3–4 future.

## TLDR

- Let an operator **attach files when composing/replying** to an email from the CRM, sent through the existing O365 (Graph) outbound pipeline.
- **App-only, ZERO core changes, ZERO upstream dependency** (project rule). The only app-controlled code in the outbound worker path is *our* `graph-mail-adapter`; the file references travel to it through the already-free-form `channelMetadata` carrier.
- Designed as **one unified attachment mechanism** with a pluggable source registry (upload-from-disk, existing CRM `Attachment`, future generated PDFs, future OneDrive/SharePoint) — not a one-off "send a file from disk".
- The **Graph adapter stays dumb**: it talks to Microsoft Graph and operates on *resolved files* (name/MIME/size/bytes). It never sees a `MailAttachmentRef`, an `Attachment` entity, or any CRM model. A **resolver layer** maps references → file descriptors.
- `channelMetadata` carries **references only** (`{ kind, id }`). Filename / MIME / size are never duplicated there — the attachment source (its service) is the single source of truth, resolved at send time.

## Problem Statement

Today outbound email from the CRM (`POST /api/customers/people/[id]/emails` → `sendAsUser` → `messages.compose` → `deliver-outbound-message` → `graph-mail-adapter.sendMessage`) supports **subject + body + to/cc/bcc only**. Verified against installed code (2026-06-29):

| Layer | Owner | Carries attachments? |
|---|---|---|
| `ComposeEmailDialog` (UI) | core | ❌ no file picker |
| `POST /customers/people/[id]/emails` (`composeSchema.strict()`) | core | ❌ |
| `SendAsUserInput` / `sendAsUser` | core | ❌ |
| `deliver-outbound-message` → `adapter.sendMessage({content,metadata,...})` | core | ❌ never passes `attachments` |
| `SendMessageInput.attachments?` (adapter contract) | core | ⚠️ field exists (url-based) but **nothing populates it** |
| `graph-mail-adapter.sendMessage` / `buildMailPayload` | **app (ours)** | ❌ ignores attachments |

So the entire core chain is closed to attachments and the contract's `attachments` field is dead. We must route attachments to our adapter **without** changing core.

## Extension-Surface Analysis (verified 2026-06-29)

- **`channelMetadata` is the open carrier.** `SendAsUserInput.channelMetadata` is documented free-form ("the hub does not interpret these keys"); it is persisted on the outbound `MessageChannelLink` and flows `sendAsUser` → `convertOutbound` → `sendMessage(input.metadata)`. Our `buildMailPayload` **already reads `input.metadata`** (to/cc/subject). → we can pass attachment **references** the same way, no core change.
- **Our adapter is the only app code in the worker path.** Therefore ref→file resolution must run *inside* our module at send time — but we keep it in a **separate resolver service**, not in the Graph transport, so the transport stays dumb.
- **Storage already exists.** The core `attachments` module exposes `storageDriverFactory` (DI, singleton) with `store(payload)` / `read(partitionCode, storagePath) → { buffer, contentType }` and the `Attachment` entity. Inbound O365 attachments already use it (`email_attachments` partition). We reuse it as the default attachment source — no new storage layer.
- **Core `ComposeEmailDialog` is not extensible** for attachments (no file UI, no injection slot). Per user decision we ship **our own** compose dialog and do not touch core.

## Decisions (locked by user 2026-06-29)

1. **Approach B (app-only)** — no core changes, no upstream dependency.
2. **One unified attachment mechanism**, designed for: (a) upload from disk, (b) pick existing CRM `Attachment`, (c) future generated documents (offer/invoice PDFs), (d) future OneDrive/SharePoint.
3. **Dumb Graph adapter** — introduce a resolver layer (`MailAttachmentResolver`); the adapter operates on files (stream/bytes + name/MIME/size), never on CRM entities.
4. **`channelMetadata` carries references only** — no duplicated filename/MIME/size; the source service is the single source of truth.
5. **Own Compose dialog** — do not modify core `ComposeEmailDialog`.
6. **"Attach from CRM" anticipated from day one** — the ref union + resolver registry support it immediately even though Phase 1 UI ships only upload-from-disk.
7. **Provider-agnostic resolver (round 2)** — `MailAttachmentRef` / `ResolvedMailAttachment` / `MailAttachmentSource` / `MailAttachmentResolver` carry **no Microsoft-Graph (or any provider) assumptions** in names, types, or implementation. They live in a neutral, channel-independent home so Gmail or any future channel reuses the **same** resolver via DI **without interface changes**.
8. **Placement (round 2)** — the resolver, the ref/file types, the `attachment` source, the upload route, the storage partition, and the TTL cleanup worker live in a **new provider-agnostic app module `mail_attachments`** (`from: '@app'`), exposed via DI as `mailAttachmentResolver`. `channel_office365` only *consumes* it (resolves by DI name) — no cross-module import of internals. The O365-specific pieces (compose route, compose dialog, Graph attach/transport) stay in `channel_office365`.
9. **Reusable references (round 2)** — a `MailAttachmentRef` is a durable pointer to a stored file; the **same ref can be attached to many messages with no re-upload**. The resolver always reads current bytes from the source at send time. (Implication: an `Attachment`'s lifecycle is independent of any single send.)
10. **Configurable limits (round 2)** — max file count / max total size are **configuration**, not hard-coded constants (defaults: 10 files, 25 MB total).
11. **Q1 lifecycle (round 2)** — dedicated partition `email_outbound_attachments` + **TTL cleanup** of uploads that were never referenced by a sent message. **No draft model** — CRM has no persistent draft concept and we will not add one for this feature.
12. **Q3 surfacing (round 2)** — on successful send, the same `Attachment`s are linked to the outbound `MessageChannelLink` so they appear in the existing communication history + "Załączniki e-mail" tab. **No separate outbound mechanism.**
13. **Q4 reply (round 2)** — Phase 1 reply behaves like Outlook: the user attaches manually. Auto-re-attaching the original inbound files is Phase 2+.
14. **Q5 compose (round 2)** — the entire attachment flow goes through **our own** Compose dialog; core `ComposeEmailDialog` stays untouched. Target end-state: our dialog is the only compose UI used in the O365 module.

## Proposed Solution — Architecture

Three layers inside `channel_office365` (+ a thin storage reuse), wired only through `channelMetadata`:

```
[ Our Compose Dialog ]  picks files / CRM attachments / (future) docs
        │  builds refs: MailAttachmentRef[]
        ▼
[ Our Compose API route ]  (app-only; NOT core /emails)
        │  uploads-from-disk → Attachment rows (source of truth)
        │  sendAsUserService(..., channelMetadata: { crmPersonId, crmVisibility,
        │                                            attachments: MailAttachmentRef[] })   ← refs ONLY
        ▼
[ core: sendAsUser → messages.compose → MessageChannelLink → outbound queue
        → deliver-outbound-message → adapter.sendMessage(input.metadata = channelMetadata) ]   (untouched)
        ▼
[ Our graph-mail-adapter.sendMessage ]   reads input.metadata.attachments (refs)
        │
        ├─► [ MailAttachmentResolver ]  ref.kind → registered source → ResolvedMailAttachment[]
        │        (knows Attachment entity / storageDriverFactory / future sources)
        │
        └─► [ Graph transport (dumb) ]  operates on ResolvedMailAttachment only:
                 create draft → attach (≤3MB inline | >3MB upload session) → /send
```

### Interface 1 — Reference (what travels in `channelMetadata`, references only)

```typescript
// src/modules/channel_office365/lib/mail-attachments/types.ts
// Discriminated union — extensible per source. NO filename/mime/size here.
export type MailAttachmentRef =
  | { kind: 'attachment'; id: string }              // existing CRM Attachment (incl. freshly uploaded)
  | { kind: 'generated-document'; documentId: string; format?: 'pdf' }  // Phase 3 (future)
  | { kind: 'onedrive'; driveItemId: string }       // Phase 4 (future)

// Persisted on channelMetadata as: { attachments: MailAttachmentRef[] }
```

### Interface 2 — Resolved file (what the dumb adapter consumes)

```typescript
export interface ResolvedMailAttachment {
  fileName: string
  contentType: string
  size: number                 // bytes; drives inline vs upload-session decision
  inline?: boolean             // reserved (cid: images); default false for Phase 1
  read(): Promise<Buffer>      // lazy — large files only materialize at upload time
}
```

### Interface 3 — Source + Resolver registry (the layer the user asked for)

```typescript
export interface MailAttachmentSource {
  readonly kind: MailAttachmentRef['kind']
  // Resolve a batch of refs of THIS kind into file descriptors, tenant/org-scoped.
  resolve(refs: MailAttachmentRef[], scope: ResolveScope): Promise<ResolvedMailAttachment[]>
}

export type ResolveScope = { tenantId: string; organizationId: string | null; actorUserId: string | null }

// Façade used by the adapter — picks the source by kind, fans out, preserves order.
export interface MailAttachmentResolver {
  resolve(refs: MailAttachmentRef[], scope: ResolveScope): Promise<ResolvedMailAttachment[]>
}
```

- Phase 1 ships exactly one source: **`AttachmentMailSource`** (`kind: 'attachment'`) — loads the `Attachment` row (tenant/org-scoped) for name/MIME/size and returns `read()` backed by `storageDriverFactory.read(partitionCode, storagePath)`. **The `Attachment`/its service is the single source of truth** for name/MIME/size (decision 4).
- Future sources register additional `kind`s without touching the adapter or transport.
- Resolver + sources are registered in `channel_office365/di.ts` and resolved from the container at send time.

### Interface 4 — Dumb Graph transport

`graph-mail-adapter.sendMessage` is refactored to:
1. read `refs = input.metadata.attachments ?? []`;
2. `const files = await resolver.resolve(refs, scope)` (skipped entirely when empty — current behavior preserved);
3. create the draft (existing `buildMailPayload`, unchanged for the no-attachment path);
4. **attach** each `ResolvedMailAttachment`: `size ≤ 3 MB` → inline `#microsoft.graph.fileAttachment` (base64) on `POST /me/messages` or `POST /me/messages/{id}/attachments`; `size > 3 MB` → `POST /me/messages/{id}/attachments/createUploadSession` + chunked `PUT`;
5. `POST /me/messages/{id}/send` (existing).

The transport functions take `ResolvedMailAttachment[]` only — no refs, no `Attachment`, no DI of CRM models.

**DI access (Q1 resolved against installed code):** the adapter is registered as `asValue(new O365EmailChannelAdapter())` — a DI-free singleton, and `sendMessage` receives only `SendMessageInput` (no container). So the resolution step lazily bootstraps DI **inside `sendMessage`, only when `refs.length > 0`** (preserving today's zero-overhead no-attachment path): `const container = await createRequestContainer()` (the same helper API routes/CLI use, from `@open-mercato/shared/lib/di/container`), resolve `em` + `storageDriverFactory`, build the `MailAttachmentResolver`, and pass `input.scope` (tenant/org) explicitly. No core change, no constructor wiring. Residual check: confirm `createRequestContainer()` is safe to call from the outbound queue-worker process (expected yes — it is a generic DI bootstrap, not request-bound).

## Data Flow (Phase 1, upload-from-disk)

1. Operator opens **our** "Nowy e-mail / Odpowiedz (z załącznikami)" dialog on a Person.
2. Picks files → each file `POST`ed to our **upload route** → stored via `storageDriverFactory.store` + an `Attachment` row (partition `email_outbound_attachments`, scoped, linked to draft token) → returns `{ attachmentId, fileName, size, mimeType }` for UI display.
3. On send, dialog calls **our compose route** with body fields + `attachments: [{ kind:'attachment', id }]`.
4. Compose route validates (Zod), then `sendAsUserService(..., channelMetadata:{ crmPersonId, crmVisibility, attachments })`. **Only refs cross the wire.**
5. Core hub composes the Message, persists the outbound `MessageChannelLink` (with our `channelMetadata`), enqueues, and the worker calls our `sendMessage`.
6. `sendMessage` → `resolver.resolve(refs, scope)` → Graph transport attaches + sends.
7. (Consistency) on success we link the same `Attachment` rows to the outbound `MessageChannelLink` so the sent files surface in the existing **"Załączniki e-mail"** tab — outbound attachments become first-class in the same view as inbound.

## Data Models

- **No new entity for the mechanism.** Reuse the core `Attachment` (the `attachments` module) as the canonical store + source of truth for uploaded/CRM files.
- New **partition code** `email_outbound_attachments` (sibling of inbound `email_attachments`) registered in our module so uploads are isolated and lifecycle-managed.
- `channelMetadata.attachments: MailAttachmentRef[]` (references only) persisted on the outbound `MessageChannelLink` (existing JSONB column — no migration).
- Outbound `Attachment` rows are linked to the `MessageChannelLink` (entityId `communication_channels:message_channel_link`, recordId = link id) mirroring the inbound convention, so the existing attachments section/endpoint shows them with no new read path.

## API Contracts (app-only, our module)

```
POST /api/mail_attachments/upload              (provider-agnostic module)
  requireFeatures: ['mail_attachments.upload']
  multipart/form-data (single file) → { attachmentId, fileName, mimeType, size }
  Stores via attachments module (partition email_outbound_attachments), tenant/org-scoped.
  Enforces configurable per-file size; total/count enforced at compose time.

POST /api/channel_office365/compose            (our compose route — replaces core /emails for this dialog)
  requireFeatures: ['customers.email.compose']
  body (Zod): {
    personId: uuid, userChannelId: uuid,
    to: string[], cc?: string[], bcc?: string[],
    subject: string, body: string, bodyFormat: 'text'|'html',
    visibility: 'private'|'shared',
    inReplyTo?, references?, parentMessageId?,
    attachments?: Array<{ kind: 'attachment', id: uuid }>   // refs ONLY
  }
  → calls communicationChannelsSendAsUser with channelMetadata.attachments = refs
  → { messageId, threadId, queuedAt }
```

All inputs Zod-validated; both routes export `metadata` + `openApi`; reuse `apiCall` / `useGuardedMutation` on the client (no raw `fetch`).

## Phased Implementation

**Phase 1 — Backend mechanism + upload-from-disk (the MVP).** Step list:
- **P1.1** New provider-agnostic module `src/modules/mail_attachments/` (`from: '@app'` in `src/modules.ts`): `index.ts`, `di.ts`, `acl.ts`, `lib/types.ts` (`MailAttachmentRef`, `ResolvedMailAttachment`, `MailAttachmentSource`, `MailAttachmentResolver` — neutral names, zero provider assumptions), config for limits (`MAIL_ATTACHMENTS_MAX_FILES`, `MAIL_ATTACHMENTS_MAX_TOTAL_BYTES`, defaults 10 / 25 MB).
- **P1.2** `AttachmentMailSource` (`kind:'attachment'`) — loads `Attachment` (tenant/org-scoped) for name/MIME/size; `read()` via `storageDriverFactory.read(partitionCode, storagePath)`. `MailAttachmentResolver` façade (picks source by `kind`, preserves order, fails closed on unauthorized/missing refs). Register both in `mail_attachments/di.ts` as `mailAttachmentResolver`.
- **P1.3** Upload route `POST /api/mail_attachments/upload` (multipart) → store via `storageDriverFactory.store` + `Attachment` row (partition `email_outbound_attachments`, scoped) → `{ attachmentId, fileName, mimeType, size }`. Enforce configurable per-file/type checks. Register partition `email_outbound_attachments`.
- **P1.4** TTL cleanup worker (`mail_attachments/workers/*`) — periodically delete `email_outbound_attachments` `Attachment`s older than TTL that are **not** linked to any `MessageChannelLink` (never sent). Idempotent, scoped.
- **P1.5** Refactor `channel_office365/lib/graph-mail-adapter.ts`: in `sendMessage`, when `input.metadata.attachments?.length`, lazily `createRequestContainer()` → resolve `mailAttachmentResolver` → `ResolvedMailAttachment[]`; **dumb** Graph transport attaches each (≤3 MB inline `#microsoft.graph.fileAttachment`; >3 MB `createUploadSession`) between draft-create and `/send`. Transport touches only `ResolvedMailAttachment`. No-attachment path unchanged.
- **P1.6** Compose route `POST /api/channel_office365/compose` (O365-specific): Zod body incl. `attachments?: Array<{ kind:'attachment', id: uuid }>` (refs only); calls `communicationChannelsSendAsUser` with `channelMetadata.attachments = refs` (+ `crmPersonId`, `crmVisibility`). Validates count/size against config before send.
- **P1.7** On successful send, link the referenced `Attachment`s to the outbound `MessageChannelLink` (entityId `communication_channels:message_channel_link`, recordId = link id) so they surface in the existing history + "Załączniki e-mail" tab (decision 12). Done in our adapter post-send or a `communication_channels.message.sent` subscriber in `channel_office365` (chosen at impl. time; subscriber keeps the adapter dumb — preferred).
- **P1.8** ACL: `mail_attachments.upload` feature in `acl.ts` + `setup.ts` `defaultRoleFeatures` + `yarn mercato auth sync-role-acls`. Reuse `customers.email.compose` for the compose route.
- **P1.9** Tests (pure pieces): ref parse/validate, size→inline-vs-session decision, resolver fan-out with a mocked source, limit enforcement. `tsc` + `yarn test` + `yarn generate` green.

> Phase 1 ships **no UI** beyond what's needed to exercise it; the operator-facing dialog is **Phase 2**. (Phase 1 is verifiable via the routes + a temporary trigger or test.)

**Phase 2 — UI: our Compose dialog + "Attach from CRM".**
- App-owned compose/reply dialog (DS-compliant: `FormField`, `Button`/`IconButton`, lucide `Paperclip`, `Cmd/Ctrl+Enter` submit, `Escape` cancel, `aria-label`s). Injected via our widget (e.g. on Person/Company detail), not core `ComposeEmailDialog`.
- Two add-paths wired to the SAME ref model: **upload from disk** and **pick existing CRM `Attachment`** (`{ kind:'attachment', id }`). Backend already supports both from Phase 1.

**Phase 3 — Generated documents (future).** New `GeneratedDocumentMailSource` (`kind:'generated-document'`) resolving offer/invoice PDFs to `ResolvedMailAttachment`. No adapter/transport change.

**Phase 4 — OneDrive/SharePoint (future).** New `OneDriveMailSource` (`kind:'onedrive'`); may use Graph's reference-attachment to avoid re-upload. No adapter/transport change.

## Risks / Constraints

- **Adapter DI access** — resolved (see "DI access" above): lazy `createRequestContainer()` inside `sendMessage` when attachments are present. Only residual: confirm it runs in the queue-worker process.
- **Upload lifecycle** (see Q1) — orphaned uploads (attached then send cancelled) need TTL/cleanup.
- **Limits** (see Q3) — Graph inline cap 3 MB; total message ~150 MB via upload session; we set app limits.
- **Provider scope** — only our O365 adapter implements this; other adapters ignore `channelMetadata.attachments` (acceptable, app-only).
- **Security/scope** — resolver MUST tenant/org-scope every ref and reject refs the sender can't access (fail-closed). No cross-tenant attachment leakage.
- **Encryption** — file bytes live in the attachments storage driver (existing model); filenames are not declared sensitive today. Confirm no new `encryption.ts` entry is required (Q4).

## Resolved Decisions (2026-06-29 round 2)

All Open Questions answered; see Decisions 7–14 above. Summary:
- **Lifecycle:** partition `email_outbound_attachments` + TTL cleanup; no drafts.
- **Limits:** configurable; defaults 10 files / 25 MB total.
- **Surfacing:** link sent files to outbound `MessageChannelLink`; reuse existing history + tab.
- **Reply:** manual attach in Phase 1.
- **Compose:** our dialog only; core untouched.
- **Resolver:** provider-agnostic, lives in new `mail_attachments` module, consumed by `channel_office365` via DI.
- **Refs:** durable + reusable across messages, no re-upload.

## Acceptance Criteria

- [ ] Composing from the CRM with ≥1 uploaded file sends a real O365 email whose recipient receives the attachment(s).
- [ ] Files > 3 MB send correctly (upload session), within the configured total limit.
- [ ] `channelMetadata` contains only references (`{kind,id}`) — no filename/MIME/size duplication (asserted in a test).
- [ ] `graph-mail-adapter` Graph transport references no CRM model — only `ResolvedMailAttachment` (asserted by types + review).
- [ ] Adding a new source kind requires no change to the adapter/transport (demonstrated by the `attachment` source being the only adapter-agnostic touch-point).
- [ ] No core file modified; no upstream dependency.
- [ ] Sent attachments appear in the existing "Załączniki e-mail" tab (if Q4 = yes).
- [ ] tsc + unit tests + i18n + generate green.

## Changelog

| Date | Change |
|------|--------|
| 2026-06-29 | Initial skeleton + architecture (interfaces, data flow, phases, open questions) |
| 2026-06-29 | Round 2: architecture accepted; all Open Questions resolved (decisions 7–14); provider-agnostic resolver in new `mail_attachments` module; reusable refs; configurable limits; TTL cleanup; Q1 DI wiring resolved; Phase 1 step list (P1.1–P1.9). Status → Ready for implementation. |
| 2026-06-29 | Phase 1 implemented: `mail_attachments` module (types/config/resolver/`AttachmentMailSource`/di/acl/setup/cli), upload route, TTL cleanup (lib+CLI), `graph-mail-adapter` dumb transport (inline ≤3 MB / upload-session >3 MB), compose route `/api/channel_office365/compose`, link-sent subscriber + dual-partition loader. tsc + 39 tests + generate green; `mail_attachments.upload` synced. UI = Phase 2. |
