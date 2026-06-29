# O365 Email Attachments — visible & downloadable everywhere emails appear

**Date**: 2026-06-29
**Status**: Ready for implementation — Stage 1 (Approach A) fully specced (data model, API contracts, 5 phases). Stage 2 (B) optional/on-demand. C not planned.

## TLDR

**Key Points:**
- Wherever a synced O365 email is shown, the operator must (a) immediately *see* it carries an attachment and (b) be able to *download* it — without forking `@open-mercato/core`.
- Builds on shipped Faza 0 (attachment fetch + `EmailAttachments` on the Activity detail page).
- **Architectural constraint (user):** the email `subject` is a faithful copy of source data and MUST NOT become a carrier of presentation state. Stamping a 📎 into `subject` is a last-resort hack, not the design.

**Scope:**
- An attachment **signal** carried as *data/metadata* (not in the subject), surfaced on every surface we can render into.
- Clickable **download** of stored attachments, reusing the existing `GET /api/channel_office365/email-attachments` route and the `email_attachments` partition. No new entities.

## Decisions (locked by user 2026-06-29)
- **Marker semantics (was Q2):** "has attachment" = **≥1 stored, non-inline** attachment (no false 📎 from signature images). Known only *after* `email-attachment-fetcher` runs, and only when `syncAttachments` is ON.
- **Backfill (was Q3):** yes — idempotent backfill of existing rows that already have stored attachments.
- **Visibility (was Q4):** yes — the customer-detail section applies the same private/shared + org/tenant filter as the timeline (`applyEmailVisibilityFilter`).
- **Subject stamp (was Q1):** **NOT the chosen mechanism.** Documented below only as a fallback with full consequences.

---

## Extension-Surface Analysis (verified against installed code 2026-06-29)

The data layer is fully open to us; the **render layer of the core timeline / email-tab is closed**. Evidence:

| Surface | Who renders it | Extension point available to the app? |
|---|---|---|
| Activities **list** `/backend/activities` | **our** `DataTable` | ✅ we own it — add a column / icon directly |
| Activity **detail** `/backend/activities/[id]` | **our** page | ✅ Faza 0 already renders `EmailAttachments` |
| Person/Company **detail** page chrome | core `people-v2/[id]` | ✅ `InjectionSpot` slots: `detail:customers.person:footer`, `:tabs`, `:header`, `:status-badges` (+ company equiv.) |
| CRM **timeline rows** ("Historia interakcji") | core `ActivityTimeline` → `TimelineEntry` | ❌ imported directly (not registry-resolved → not replaceable); **no `spotId` inside** `components/detail/**`; renders only `AiActionChips` (disabled, closed catalog) |
| CRM "Aktywności" **cards** | core `ActivityCard` | ❌ same; renders `EmailCardActions` (composed in place, not a slot) + disabled AI chips |
| "E-maile" tab **message rows** | `@open-mercato/ui` `EmailThreadsPanel` | ❌ `EmailThreadMessage` type has **no attachment field**, panel renders **no** attachment UI, imported directly (not replaceable) |

**Data plumbing we fully control (no fork, no subject mutation):**
- Response enricher on `customers.interaction` (exact pattern of the shipped `interactionEmailCardEnricher`) → attach `_integrations.attachments = { count, hasStored, files[] }`.
- Our existing override of `GET /api/customers/people/[id]/email-threads` → add `attachmentCount` to the thread DTO.
- Our existing `interactions-get-override` → already the hook for the timeline list.

**The catch:** enriched metadata is **invisible** in the core timeline / E-mail rows because no core JSX consumes it. Metadata is only renderable by **our own** widgets (the footer section, our Activities-list column). So a *per-row inline* marker/download inside the core timeline or E-mail tab is **not reachable** by metadata alone.

## Solution — staged

The feature MUST be fully usable without any Core change. **Stage 1 (Approach A)** is the deliverable and stands alone. **Stage 2 (Approach B)** is an optional later evolution, never a prerequisite for Stage 1. **Approach C** is a documented fallback only — not planned.

### Stage 1 — Approach A (App-only, ZERO core changes) — *the deliverable*
No subject mutation. Pure data + the slots/tables we already own.
1. **Metadata, not subject.** Response enricher on `customers.interaction` adds `_integrations.attachments = { count, hasStored, files[] }` (pattern of the shipped `interactionEmailCardEnricher`); our `email-threads` override adds `attachmentCount` to the thread DTO. The subject is never touched.
2. **Activities list** (`/backend/activities`, our `DataTable`): add a small 📎 indicator column (icon + count, with `aria-label`), value from our own activity row joined to stored attachments. The row already links to the Activity detail → download one click away.
3. **Customer (person + company) detail:** inject a clickable **"Załączniki e-mail"** section into `detail:customers.person:footer` (+ company equivalent). Groups stored attachments per email (subject + date as the group *label* — read-only display of the real subject, never a mutation); each file is a download link to `/api/attachments/file/<id>`. Reuses the Faza 0 route + `email_attachments` partition. DS-compliant (`SectionHeader`/`CollapsibleSection`, `EmptyState`, `LoadingMessage`, lucide icons, `apiCall`). Applies `applyEmailVisibilityFilter` + org/tenant scope (decision Q4).
4. **Awareness affordance (closes the discoverability gap within A):** surface a small "📎 N" count chip in an already-visible slot (`detail:customers.person:status-badges` or `:header`) that anchors/scrolls to the section — so operators know attachments exist without scrolling to the footer. Pure app-side, no core change.
5. **Backfill** stored-attachment metadata idempotently for existing rows that already have stored attachments.

**Covers:** Activities list (signal + 1-click download), Activity detail (Faza 0), Person/Company detail (consolidated clickable section + visible count). **Conscious non-goal:** no marker on individual *core* timeline rows / E-mail message rows — see the UX evaluation for why this is acceptable.

### Stage 2 — Approach B (optional, additive upstream Core/UI extension) — *only if usage shows real friction*
Not required for Stage 1. Pursue only if, after A ships, operators report they genuinely need an inline per-row marker. Tiny, purely-additive, zero behavior change:
- **Core timeline/card:** add an injection spot per email row, e.g. `<InjectionSpot spotId="customers.interaction:row-trailing" data={activity} />` inside `TimelineEntry` / `ActivityCard` (~3-5 additive lines; core already imports `InjectionSpot`). We inject a clickable 📎 chip fed by the Stage 1 enricher data — **no new data work**.
- **UI EmailThreadsPanel:** add optional `attachments?: { name; url }[]` to `EmailThreadMessage` and render a chip row when present (backward compatible). Our existing email-threads override populates it.
- **Path:** we *can* contribute upstream (Q5), but the design deliberately does not depend on it. Local `node_modules` edits = fork (rejected) → B ships only via upstream PR / vendored patch. Reuses 100% of Stage 1's data layer, so B is purely a thin render add-on.

### Approach C — `subject` 📎 stamp — *documented fallback, NOT planned*
Rejected as a design (subject must stay a faithful source copy). Recorded only so the trade-off is explicit if ever forced. Consequences: search/filter/sort/export pick up the emoji; one-time-only stamping must survive re-sync + poll overwrites + the deferred fetcher (double-stamp risk); touching hub `messages.subject` risks JWZ thread grouping; subject stops being a faithful copy (every consumer inherits a presentation artifact; reversal is a migration); the "signal" leaks into surfaces we don't control. Not implemented.

## UX Evaluation of Approach A (operator perspective)

Assessed honestly to decide whether the inline marker (B) is ever needed — not built just because it is possible.

- **The real job is retrieval, not per-row awareness.** ~90% of the time the task is *"get me that file"* (contract, invoice, offer), not *"tell me this one row has a paperclip."* For retrieval, the **consolidated "Załączniki e-mail" section is better than inline icons**: the operator scans one grouped list instead of scrolling the whole timeline and opening rows.
- **Triage is served by the list column.** "Which emails carry attachments?" is answered at a glance across the whole Activities list, with sort/filter, then 1 click to download.
- **Per-email deep view** is already covered by the Activity detail (Faza 0).
- **The single gap** — no badge on an individual timeline/E-mail row while reading it — is an *awareness* signal, not a retrieval blocker, and is largely neutralized by the Stage 1 count chip (#4 above).
- **Verdict:** Approach A is expected to fully solve the business problem. Approach B is a narrow awareness optimization; commit to it only on a real usage signal, not speculatively.

## Resolved Questions
- **Q5 (upstream path):** Available, but the feature MUST NOT depend on it. B is target/parallel, not a Stage-1 requirement.
- **Q6 (A coverage acceptable):** Yes — A is the accepted MVP and Stage 1. Stage 2 (B) is optional evolution.

## Stage 1 — Detailed Design (Approach A)

### Data Models (NO new tables)
Reuse the shipped `Attachment` rows + existing linkage. Nothing persisted is added.

- **`Attachment`** (core attachments): `partition_code='email_attachments'`, `entity_id='communication_channels:message_channel_link'`, `record_id = MessageChannelLink.id`, `url='/api/attachments/file/<id>'`. **Stored `Attachment` rows = downloadable, non-inline files only** — the fetcher persists an `Attachment` only for `status='stored'`; `too_large` / `fetch_error` / `skipped_inline` live in `MessageChannelLink.channelPayload.attachments[]` for transparency, not as rows. → satisfies decision Q2a with **no extra logic** (counting rows already excludes inline).
- **Linkage chain (verified):**
  - Timeline source-CI: `customer_interactions.source = 'office365:mail:<extMsgId>'`, `channel_provider_key='office365_mail'`, `external_message_id IS NULL`.
  - Activities list/detail: `activities.external_id = <extMsgId>`, `external_provider='office365_mail'`.
  - `<extMsgId>` = `MessageChannelLink.external_message_id`; `MessageChannelLink.id` = `Attachment.record_id`.
- **Computed read-models (not persisted):**
  - `EmailAttachmentFile = { id; fileName; mimeType; fileSize; url }`
  - `EmailAttachmentGroup = { externalMessageId; linkId; subject; occurredAt; direction; files: EmailAttachmentFile[] }`
  - `PersonEmailAttachments = { groups: EmailAttachmentGroup[]; totalFiles: number; emailsWithAttachments: number }`

### API Contracts

**1. EXTEND the existing `GET /api/channel_office365/email-attachments` (NO new endpoint)**
Decision: do not multiply APIs. The existing single-email route gains person/company modes and a unified `groups[]` response.
- Selectors (exactly one mode):
  - `?externalMessageId=<id>` or `?linkId=<uuid>` — single email (today's Faza 0 behaviour).
  - `?personId=<uuid>` or `?companyId=<uuid>` — scoped list across that entity's O365 emails.
  - `&countOnly=1` — return only `{ totalFiles, emailsWithAttachments }` (for the chip).
- **Unified response shape:** `{ groups: EmailAttachmentGroup[], totalFiles, emailsWithAttachments }`, where each group keeps `files` + `skipped` (so single-email mode = exactly one group; Faza 0 reads `groups[0]`). `EmailAttachmentGroup = { externalMessageId; linkId; subject; occurredAt; direction?; files[]; skipped[] }`. Groups with zero `files` are omitted in person/company mode.
- `metadata.GET = { requireAuth: true, requireFeatures: ['channel_office365.view'] }`; `openApi` updated to document the modes.
- Person/company logic: resolve target entity ids (company → expand to linked persons, mirroring `resolveExpandedEntityIds` in `interactions-get-override`) → query `customer_interactions` office365_mail email rows (`source LIKE 'office365:mail:%'`) for those entities, tenant/org-scoped, **through `applyEmailVisibilityFilter`** (Q4) → parse `<extMsgId>` from `source` → batch `MessageChannelLink` (`external_message_id IN (...)`, provider=office365_mail) → batch `Attachment` (`record_id IN linkIds`, partition `email_attachments`) → group per email; `subject`/`occurredAt` from the CI, `direction` from `link.channelPayload.direction` when present.
- **Faza 0 migration:** update the `EmailAttachments` component on the Activity detail page to read `groups[0]?.files ?? []` / `groups[0]?.skipped ?? []` (tested). Single shared link→attachment helper extracted; download still via `/api/attachments/file/<id>` (no new download path).

**2. activities list count — DECOUPLED (no activities→channel_office365 coupling)**
The generic `activities` module MUST NOT import `channel_office365`. So instead of hard-coding the count into `mapActivityToResponse`:
- **(generic)** the activities list route opts into custom-route after-interceptors via `runCustomRouteAfterInterceptors(...)` — O365-agnostic, just enables extensibility (the route currently does not call it).
- **(O365)** `channel_office365/api/interceptors.ts` registers an `after` interceptor on `GET /api/activities` that batches `emailAttachmentCount` onto `externalProvider==='office365_mail'` rows (reusing `loadAttachmentsForLinkIds`; one links query + one attachments query per page, no N+1).
- **(O365)** `channel_office365` injects the 📎 column via `data-table:activities.list:columns` (the list DataTable already exposes `extensionTableId="activities.list"`), reading `row.emailAttachmentCount`.
- This keeps the dependency direction correct (channel_office365 extends activities, never the reverse) and matches the `me/channels` precedent of owning O365 concerns inside the channel module.

**3. STAGE-2 DATA DEPENDENCY (documented, NOT built in Stage 1)**
- `interactions-get-override` GET would attach `_integrations.attachments: { count, files }` to source-CIs. Built together with the Stage 2 timeline chip — no Stage 1 surface consumes it, so it is deferred to keep Stage 1 "build only what renders."

### UI (Stage 1)
All UI uses lucide `Paperclip` (page-body rule #10 — never the 📎 emoji; "📎" in this spec is prose shorthand only).
- **Footer section** — new widget `src/modules/channel_office365/widgets/injection/email-attachments-section/` mapped via `injection-table.ts` to `detail:customers.person:footer` (+ company equivalent — verify the company detail exposes a `:footer` spot during impl; fall back to `:tabs` count-labelled tab only if absent). Renders a `CollapsibleSection` ("Załączniki e-mail") grouped per email (subject + date + direction as label), each file a download link with a `Paperclip` icon; `EmptyState`/`LoadingMessage`/`apiCall`. **Renders nothing when `totalFiles===0`** (no clutter). DS-compliant.
- **Awareness chip** — widget mapped to `detail:customers.person:status-badges`. Decision: **descriptive + clickable**, not a bare emoji+count. `Button variant="outline" size="sm"` with a leading `Paperclip` icon and a localized, **Polish-pluralized** label — `Załączniki (N)` (or `1 załącznik` / `5 załączników`), `aria-label`, `onClick` scrolls to the section anchor. Rendered only when `totalFiles>0`. Uses `?countOnly=1`.
- **Activities list column** — in [activities/backend/page.tsx](src/modules/activities/backend/page.tsx) add a small column rendering a `Paperclip` icon + `emailAttachmentCount` (with `aria-label`, `meta.maxWidth` narrow, `meta.truncate:false`); empty cell when count is 0. Row already links to the Activity detail (Faza 0 download).
- **i18n** — `channel_office365.attachments.section.{title,empty}`, `.badge` (pluralized: `_one`/`_few`/`_many` per the project's plural convention), `.group.*` in `src/i18n/{pl,en}.json` (de/es fall back to en).

### Implementation Plan

#### Phase 1 — Data + API (no UI)
1. ✅ DONE — shared `loadAttachmentsForLinkIds(em, linkIds, scope)` helper (`lib/email-attachments.ts`).
2. ✅ DONE — extended `GET /api/channel_office365/email-attachments`: `personId`/`companyId`/`countOnly` modes + unified `groups[]` shape (single-email = one group), visibility-filtered, company→person expansion; `openApi` updated.
3. ✅ DONE — migrated the Faza 0 `EmailAttachments` component (Activity detail) to read `groups[0]`. (typecheck clean)
4. ✅ DONE — DECOUPLED activities count: activities route opts into `runCustomRouteAfterInterceptors` (generic, O365-agnostic); `channel_office365/api/interceptors.ts` `after` interceptor on `targetRoute:'activities'` adds batched `emailAttachmentCount` to office365_mail rows (registered in `interceptors.generated.ts`). The injected column itself is Phase 3 (UI).
5. ✅ DONE — unit tests (15, all green): pure shaping in `lib/email-attachments-shape.ts` (parse/dedupe/scoped-group/single-group/summarize/count-apply/skipped) + DB helper filter+mapping. Covers single-email back-compat (`groups[0]`=files+skipped), company→person dedup, stored-only/clutter-free omission, `countOnly` totals, interceptor per-row count. Typecheck clean; `yarn generate` OK; 134/134 module tests pass.

**Phase 1 status: COMPLETE & VERIFIED.** Data layer done. (Visibility-filter + company-expansion runtime behaviour is delegated to the shared `applyEmailVisibilityFilter` + the same kysely expansion as `interactions-get-override`; the unit suite covers the pure dedupe/grouping these feed.)

#### Phase 2 — Customer detail UI (iterative)
**2a — Footer section (person) ✅ DONE (typecheck clean, generate OK; awaiting live UX review).**
- `widgets/injection/email-attachments-section/{widget.ts,widget.client.tsx}` → mapped to `detail:customers.person:footer` (priority 50), feature-gated `channel_office365.view`.
- Fetches person-scoped `email-attachments` endpoint; `CollapsibleSection` (built-in file-count badge), groups per email (subject + date + inbound/outbound icon), download links (`Paperclip` + name + size + `Download`); `LoadingMessage` while loading; **renders nothing when empty/error** (clutter-free + fail-safe). i18n keys added to `en.json` + `pl.json`.
- Open UX points for review: (i) loading card briefly flashes on customers with no attachments — switch to render-null-during-load if undesired; (ii) the `CollapsibleSection` count badge already gives per-customer awareness — may reduce/remove the need for the separate status-badges chip; (iii) company detail not yet wired (same widget + `companyId`, pending a confirmed company footer spot).
2b — Status-badges count chip (`countOnly`) with scroll-to-section. *(deferred — decide after 2a review)*
2c — Company detail section (same widget, `companyId`). *(deferred)*

#### Phase 3 — Activities list column (UI only — data already wired in Phase 1)
1. channel_office365 injects a `Paperclip` + count column into `data-table:activities.list:columns`, reading `row.emailAttachmentCount` (already populated by the Phase 1 interceptor); empty cell when 0; `aria-label`; verify sort/filter unaffected.

#### Phase 4 — Backfill + verification
1. Confirm existing stored attachments surface on all three surfaces. For emails synced before `syncAttachments` was enabled (no `Attachment` rows yet), document the operational backfill = enable `syncAttachments` + reset-data(mail)/resync so the fetcher runs (idempotent; Q3). No data migration needed — surfacing is read-only over existing rows.

#### Phase 5 — RBAC + validation gate
1. Confirm `channel_office365.view` is in `defaultRoleFeatures`; run `yarn mercato auth sync-role-acls` if a new feature is introduced (none expected).
2. Validation gate: `yarn tsc`, unit tests, `yarn i18n:check`, build.

## Risks
| Risk | Severity | Mitigation | Residual |
|------|----------|------------|----------|
| Footer section poorly discoverable | Med | Stage-1 count chip in `:status-badges`/`:header` anchoring to the section | Operators must still scroll to download |
| Footer section leaks private emails | High | Reuse `applyEmailVisibilityFilter` + org/tenant scope | — |
| Over-marking from inline images | Low | Marker = stored non-inline only (decision Q2a) | Marker lags the fetcher by one write |
| Building B speculatively | Low | Gate B on a real post-A usage signal | — |

## Changelog
| Date | Change |
|------|--------|
| 2026-06-29 | Initial skeleton; Q1–Q4 raised |
| 2026-06-29 | Extension-surface analysis (code-verified); decisions Q1a/Q2a/backfill/Q4 locked; three approaches + recommendation; subject-stamp demoted to documented last resort; Q5/Q6 raised |
| 2026-06-29 | Q5/Q6 resolved; restructured into Stage 1 (A, deliverable) / Stage 2 (B, optional) / C (fallback, not planned); added operator UX evaluation + Stage-1 awareness chip closing the discoverability gap |
| 2026-06-29 | Exhaustive per-row signal check (read ActivitiesSection/ActivitiesCard): confirmed NO Core-rendered per-email field is repurposable and NO per-row injection spot exists → `📎 N` on the row itself is Stage-2-only. Added full Stage 1 detailed design (Data Models, API contracts, 5 implementation phases); status → Ready for implementation |
