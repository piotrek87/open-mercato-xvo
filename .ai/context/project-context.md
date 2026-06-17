# Project Context — my-app (OpenMercato)

**Last updated:** 2026-06-18
**Sessions:** Sprint 1–3B Activity Module implementation; Sprint 4A–4C Office 365 Calendar Sync; Sprint 5 — Unified M365 Connector + Email Sync + Activities UI Polish
**Sprint 5 CLOSED 2026-06-18 — commit `b76b21a`**

---

## Session Resume Instructions

> Read this document first. Do NOT re-analyze accepted architecture.
> All decisions in this document are binding — treat them as already reviewed and approved.
> Read only the specifications listed in "Document Index" when you need implementation detail.
> Before any significant change, propose a plan instead of generating code immediately.

---

## Project Overview

**my-app** is a standalone application built on the **OpenMercato** framework (`node_modules/@open-mercato/*`). It is a B2B CRM/sales platform for a Polish company (user: piotr.kowalczyk@xentivo.pl).

**Stack:** Next.js App Router, TypeScript, MikroORM v7, Awilix DI, Zod, PostgreSQL.

**Current state (2026-06-17):**
- Classic-mode OpenMercato scaffold with all built-in modules enabled (customers, sales, catalog, auth, integrations, etc.)
- Sprint 1 of the Activity Module is **fully implemented and deployed** on branch `feat/activities-sprint1` (migrated, auth synced, encryption seeded)
- Sprint 2 is **fully implemented** on branch `feat/activities-sprint2` (migrated, 54 tests passing)
- Sprint 3A is **fully implemented** on branch `feat/activities-sprint3a` (89 tests passing, 0 TS errors — no migration, pure UI + API fix)
- Sprint 3B is **fully implemented** on branch `feat/activities-sprint3b` (119 tests passing, 0 TS errors)
- Sprint 4A+4B+4C — O365 calendar sync — **fully implemented and ready for merge** on branch `feat/activities-sprint4a`. 85 Activity records synced, `visibility: private`, scheduler running at 5m interval. Sync-now button + Mail.ReadWrite scope expansion added in Sprint 4C. tsc: clean (exit 0). Known tech debt: `em.flush()` inside upsert loop (non-blocking). **PR to main pending.**
- Sprint 5 Phase 1 — **Unified Microsoft 365 Connector** — **IMPLEMENTED, awaiting environmental checkpoint** on branch `feat/activities-sprint4a`. providerKey renamed `office365_calendar` → `office365`, integrationId renamed `channel_office365_calendar` → `channel_office365`, capability-based channelState (`capabilities.calendar.*`, `capabilities.mail.*`), backward-compat read + self-migrating write, SQL migration `Migration20260617_channel_office365_unified.ts`. **Azure prerequisite: add new redirect URI `/api/communication_channels/oauth/office365/callback` before deploy.**
- Sprint 5 Phase 2 — **O365 Email Sync** — **IMPLEMENTED** on branch `feat/activities-sprint4a`. Graph Mail Delta API (Inbox + SentItems), mail-sync worker, capability toggle API, manual trigger route, email capability row in admin UI. tsc: 0 errors. yarn generate: clean.
- Sprint 5 Phase 3 — **Activities Widget UI Polish + CRM Backfill** — **IMPLEMENTED** on branch `feat/activities-sprint4a`. Week calendar strip (Mon–Sun, type-colored dots), sort/filter/pagination parity, Microsoft 365 tab name, timeline axis, API bugfix (visibility `$or` overwrite fixed), backfill subscriber on `customers.person.created`. **Sprint 5 CLOSED. Committed: `b76b21a`.**

---

## Accepted Architecture Decisions

### 1. Activity as Contextual Activity Journal

The core model is a **unified `activities` table** — a single source of truth for all interaction types (emails, meetings, calls, notes, tasks).

- One table, no polymorphic sub-tables per type.
- `lifecycle_mode: 'fact' | 'task'` — the only meaningful split. Facts are immutable records of something that happened. Tasks are actionable items with a status lifecycle.
- `activity_type` (email, meeting, call, note, task) is a **label**, not a schema discriminator.
- Status machine: `not_started → in_progress → completed` (tasks) | `fact → completed` (default for facts on create).

**Decision is final. Do not propose alternative schemas.**

### 2. CustomerInteraction Deprecation Strategy

`CustomerInteraction` (existing module in `@open-mercato/core`) is **deprecated in favor of Activity**, but the migration is deferred to Sprint 8.

- Sprint 1–7: both models coexist. No data migration yet.
- Sprint 8: bridge/migration that reads CustomerInteraction and writes Activity.
- Never extend CustomerInteraction as a long-term architecture.

### 3. Activity as Future Framework Package

The `activities` module is designed to eventually become `@open-mercato/core-activities` — a framework-level package usable by all OpenMercato apps.

Implications for all implementation decisions:
- No app-specific business logic in the core module.
- Extension points (enrichers, interceptors, custom types) must be clean.
- All cross-module links via FK IDs only (no ORM relations across modules).

### 4. O365 Integration Approach

Approved model: **OAuth2 per-user** — each staff member connects their own Microsoft 365 account in personal settings. Not a tenant-wide service account.

- Module: `src/modules/channel_office365` (Sprint 4 — **IMPLEMENTED**).
- Uses `@open-mercato/core` `communication_channels` hub: `ChannelAdapter`, OAuth2 flow, `schedulerService`.
- Pattern followed: `channel-imap` and `channel-gmail` modules.
- Sprint 4A+4B+4C scope: **inbound calendar sync only** (Graph Delta API → Activity). Email sync is Sprint 5 Phase 2.
- Activity is the write target for all synced items.

**Sprint 5 Phase 1 — Unified M365 Connector (IMPLEMENTED — see Decision #12):**
- `providerKey: office365` (was `office365_calendar`)
- `integrationId: channel_office365` (was `channel_office365_calendar`)
- `channelType: 'calendar'` — **deliberately unchanged** (no business value in renaming; avoids risk)
- Capability-based `channelState`: `{ capabilities: { calendar: { enabled, deltaToken, lastSyncedAt, bootstrapped }, mail: { enabled } }, grantedScopes }`
- Backward-compat read: `capabilities.calendar.deltaToken ?? channelState.deltaToken` (flat fallback)
- Self-migrating write: worker always writes nested structure on first sync post-upgrade
- SQL migration: `Migration20260617_channel_office365_unified.ts` (idempotent, reversible)
- **Azure prerequisite before deploy:** add redirect URI `/api/communication_channels/oauth/office365/callback`

**Implemented decisions (binding — do not re-open):**
- OAuth scopes: `Calendars.ReadWrite Mail.ReadWrite offline_access User.Read`
- Graph Delta API: `Prefer: odata.maxpagesize=100` header (NOT `$top=...` in URL — incompatible with delta tracking)
- Synced activities: `activityType: meeting`, `lifecycleMode: task`, `visibility: private`, `externalProvider: office365_calendar`
- `externalProvider: 'office365_calendar'` on Activity records — **NEVER changes** (semantic data-source identifier, not the channel key)
- `ownerUserId` = OAuth grantor's user ID (person who connected their O365 account); not resolved from attendees
- `seriesMaster` recurring event skeleton events are skipped (no `start`/`end` dates; individual occurrences are synced)
- `duration_minutes` capped at 1440 (null for multi-day events) — enforced by `activities_duration_check` DB constraint
- Cancelled events: soft-delete via `deletedAt`; batch `$in` query + single `em.flush()` after loop
- Delta cursor stored in `channel.channelState.capabilities.calendar.deltaToken` (Sprint 5+) or `channelState.deltaToken` (Sprint 4A-4C legacy); bootstrap window: −7d to +90d from first sync

### 5. Tenant/User Configuration Model

- Each staff member has their own O365 OAuth2 token stored in the `communication_channels` hub credential store (not hand-rolled, not in `.env`).
- Sync runs per-user, not per-tenant.
- `externalId` + `externalProvider` on the Activity entity is the deduplication key (`UNIQUE WHERE external_id IS NOT NULL`).
- `syncDirection: 'inbound'` for calendar sync (read from O365, write to Activity). Email sync direction TBD Sprint 5.

### 6. Registry-Based Activity Types

Activity types (email, meeting, call, note, task) are defined in `src/modules/activities/activity-types.ts` as a static registry (Sprint 1). Sprint 2 makes the registry dynamic — auto-discovered by `yarn generate` from `activity-types.ts` files across all modules.

Do not add an `activity_types` database table — the static/generated registry is intentional at this stage.

### 7. lifecycle_mode: fact/task

`fact` = something that happened (past, immutable by nature).
`task` = something to do (future/present, has a status machine).

Business rule: **`visibility: 'private'` is not allowed for facts** (they are organizational records, not personal tasks). This is enforced in `activityCreateSchema`.

### 8. Timeline Architecture

The primary UX pattern for activities is a **timeline view** injected as a tab into related entity detail pages (customer, sales order, etc.).

- Widget injection slots used: `customers.person.detail:tabs`, `detail:customers.company:tabs`, `sales.document.detail.order:tabs`
- Query filter: `linkedEntityType` + `linkedEntityId`
- Cursor-based pagination on `(created_at, id)` — no offset pagination.

### 9. Activity as Single Source of Truth

After Sprint 8, Activity replaces CustomerInteraction entirely. Until then, both coexist without a bridge. New features MUST target Activity, not CustomerInteraction.

### 11. Activity is a Per-User Record — No Shared Activity Model

**Decision (2026-06-16):** Each Activity record belongs to exactly one user (`ownerUserId`). When the same calendar meeting has multiple OpenMercato staff attendees who all have O365 connected, the system correctly creates N separate Activity records — one per person.

**Reasoning (from Sprint 4C 4C-2 analysis):**
- Microsoft Graph Calendar API returns per-mailbox event IDs (different for each attendee's copy of the meeting). A single global identifier (`iCalUId`) exists but using it as the deduplication key would require a data migration of all existing records.
- A shared Activity with one `notes` field can't capture per-person annotations from the same meeting.
- Status is personal: Alice marking a meeting "completed" should not affect Bob's view.
- A shared model would require either `visibility: 'team'` (undoing the privacy decision from Sprint 4B) or a new visibility tier (`'participants'`) that the framework doesn't have.
- The "problem" of multiple records per meeting is not actually a problem — it reflects the correct CRM model (each engagement is personal).

**What this means for future development:**
- Do NOT switch to `iCalUId` as the `externalId` for calendar events.
- Do NOT build a "shared Activity" model for meetings.
- If attendee enrichment is ever needed, scope it as either:
  - **4C-2a** internal attendee enrichment: add `internalUserId` to the `participants` JSON field for matched staff members (no Activity count change, no deduplication change).
  - **Separate topic**: auto-link external attendees to CRM customer entities via `ActivityLink` (high value, separate sprint, not Sprint 4C).

**Decision is final. Do not re-open the shared Activity question.**

### 12. Unified Microsoft 365 Connector Architecture (Sprint 5 Phase 1)

**Decision (2026-06-17):** The Office 365 module is a **Unified M365 Connector** — one OAuth flow, one token set, capability-based feature toggles per user. Modeled after Dynamics 365 connector pattern.

**Rationale:**
- One connection per user (not separate channels per capability)
- Future capabilities (Contacts Sync, Tasks Sync) added to same channel without new OAuth flows
- `channelState.capabilities.*` provides per-capability deltaToken, enabled flag, and sync metadata
- User can disable calendar sync without disconnecting email sync, and vice versa

**Key identifiers (binding — do not change without migration):**
- `O365_PROVIDER_KEY = 'office365'` (constant in `lib/credentials.ts`)
- `O365_INTEGRATION_ID = 'channel_office365'` (constant in `lib/credentials.ts`)
- `channelType = 'calendar'` — **left unchanged** by explicit user decision ("no business value, additional risk point")
- `O365_EXTERNAL_PROVIDER_CALENDAR = 'office365_calendar'` — Activity `externalProvider`, **NEVER changes** (used as deduplication key)
- `O365_EXTERNAL_PROVIDER_MAIL = 'office365_mail'` — reserved constant for Phase 2 email sync Activities

**channelState structure (Sprint 5+):**
```json
{
  "capabilities": {
    "calendar": { "enabled": true, "deltaToken": "...", "lastSyncedAt": "...", "bootstrapped": true },
    "mail": { "enabled": false }
  },
  "grantedScopes": ["Calendars.ReadWrite", "Mail.ReadWrite", "offline_access", "User.Read"]
}
```

**Backward-compat pattern:** New code reads `capabilities.calendar.deltaToken` first, falls back to `channelState.deltaToken` (Sprint 4A-4C legacy). Worker self-migrates on first write.

**Phase 1 checkpoint (required before Phase 2):**
1. OAuth flow works with new redirect URI `/api/communication_channels/oauth/office365/callback`
2. `yarn db:migrate` applies `Migration20260617_channel_office365_unified.ts` — existing channels migrated to `provider_key='office365'`
3. Calendar sync worker runs successfully post-migration
4. DeltaToken preserved in `capabilities.calendar.deltaToken`
5. "Sync now" button works (202 response)
6. No UI regressions on `/backend/channel_office365`
7. `down()` rollback verified in staging

**Decision is final. Do not re-open providerKey/integrationId naming without a migration plan.**

### 10. ActivityLink Stays in the Activities Module

**Decision (2026-06-15):** The `ActivityLink` junction table (Sprint 2) is **specific to the Activities module** and is NOT a candidate for a generic `entity-links` platform mechanism at this stage.

**Reasoning:**
- ActivityLink solves a specific problem: open-ended contextual tagging ("this activity happened in the context of these entities"). It is not a structural domain relationship like Order→Invoice.
- Examples such as Order↔Invoice, Order↔Shipment are structural FK relationships with business rules — best modeled as FK columns per module, not a generic junction table.
- Premature extraction without 3+ proven use-cases produces over-engineered API with no clear owner.
- ActivityLink is a clean junction table — if future extraction is needed, the data migration is trivial (`INSERT INTO entity_links SELECT FROM activity_links`).

**Trigger for re-evaluation:** If 3+ modules independently need polymorphic association tables — then design `@open-mercato/entity-links` as a platform module. Not before.

**Decision is final for Sprint 2. Do not re-open this question.**

---

## Rejected Alternatives

| Alternative | Why rejected |
|---|---|
| Separate tables per activity type (EmailActivity, TaskActivity, etc.) | Schema explosion; cross-type queries become joins; type extensions require migrations |
| Scheduler as source of truth for tasks | Not a journal; no history; no link to CRM entities |
| Planner as source of truth | Same objection as Scheduler; no audit trail |
| Extending CustomerInteraction as the long-term model | Limited schema; no lifecycle_mode; no external sync fields; framework-owned, can't be extended freely |
| Tenant-wide O365 service account | Doesn't match per-user calendar/mail model; privacy issues |
| Polymorphic `type` column as schema discriminator | Over-engineering; Activity is one entity with optional fields |
| Offset pagination | Performance degrades on large datasets; cursor is the correct choice for a journal |
| Generic `entity-links` platform module (Sprint 2) | Premature — ActivityLink is context-specific, not a generic relationship. No other use-case exists yet. Revisit when 3+ modules need the pattern. |
| Second pair of columns (`linked_entity_type2`) instead of junction table | Leads to third, fourth pair — schema explosion. Junction table is the correct choice. |
| Shared Activity per calendar meeting (Sprint 4C 4C-2 analysis) | Breaks per-person notes/status; requires iCalUId migration of existing records; needs new `'participants'` visibility tier the framework doesn't have; the "problem" is not actually a problem in a CRM. See Decision #11. |
| iCalUId as externalId deduplication key for O365 calendar | Would require migration of all 85+ existing records; breaks per-user deduplication invariant. See Decision #11. |

---

## Document Index

### Architectural Specifications (binding decisions — do not re-analyze)

| Path | Description | Status |
|---|---|---|
| `.ai/specs/2026-06-15-activity-model-architecture.md` | Core architectural spec — why unified table, lifecycle_mode, visibility, linked entity pattern | Final |
| `.ai/specs/2026-06-15-activity-product-architecture.md` | Product-level design — UX patterns, timeline view, widget injection rationale | Final |
| `.ai/specs/2026-06-15-activity-extensibility-architecture.md` | Extensibility architecture — registry-based types (3 layers), renderers, filters, zero-coupling model | Final |
| `.ai/specs/2026-06-15-customerinteraction-vs-activity.md` | Analysis of CustomerInteraction vs Activity — deprecation rationale, migration strategy | Final |
| `.ai/specs/2026-06-15-office365-integration.md` | O365 integration architecture — OAuth2 per-user, Graph API, sync model | Final (Sprint 4A+4B implemented) |

### Technical Implementation Specs (source of truth for implementation)

| Path | Description | Status |
|---|---|---|
| `.ai/specs/2026-06-15-sprint1-activity-technical-spec.md` | Sprint 1 tech spec — data model (28 cols), API contracts, RBAC, events, migration, 8 risks | Implemented |
| `.ai/specs/2026-06-15-sprint2-activity-technical-spec.md` | Sprint 2 tech spec — dynamic registry, ActivityLink entity, type extensibility, API contracts, UI architecture, 7 risks | Implemented |
| `.ai/specs/2026-06-15-sprint3a-activity-technical-spec.md` | Sprint 3A tech spec — Activity Creation UX (Drawer, InlineComposer, QuickNote, optimistic updates, standalone page) | Implemented |

### Templates and Conventions

| Path | Description |
|---|---|
| `.ai/specs/SPEC-000-template.md` | Spec template for new specifications |
| `.ai/specs/README.md` | Spec index and conventions |

---

## Sprint Status

### Sprint 1 — Activity Module Core

**Status: IMPLEMENTED — pending deployment**
**Branch:** `feat/activities-sprint1`
**Base:** `develop`
**Last commit:** `d487588` — `docs(runs): final gate — all checks pass, sprint 1 complete`
**Run folder:** `.ai/runs/2026-06-15-activities-sprint1/`

**What was implemented:**

| Area | Files |
|---|---|
| Module scaffold | `acl.ts`, `setup.ts`, `events.ts`, `encryption.ts`, `activity-types.ts`, `index.ts` |
| Data model | `data/entities.ts` (28 cols), `data/validators.ts` (4 Zod schemas) |
| Migration | `migrations/Migration20260615_activities.ts` (6 indexes, 1 partial unique, 4 check constraints) |
| API — collection | `api/route.ts` (GET list + POST create, cursor pagination, visibility filter) |
| API — record | `api/[id]/route.ts` (GET + PUT + soft-DELETE) |
| API — lifecycle | `api/[id]/complete/`, `cancel/`, `reopen/`, `restore/` (4 route files) |
| Admin UI | `backend/page.tsx` + `page.meta.ts` (DataTable list page) |
| Widget | `widgets/injection/timeline/widget.ts` + `widget.client.tsx` (ActivityTimeline) |
| Widget injection | `widgets/injection-table.ts` (3 slots: customer person, customer company, sales order) |
| i18n | `i18n/en.json` (46 keys) |
| Tests | `__tests__/validators.test.ts` (20 tests), `__tests__/lifecycle.test.ts` (14 tests) |

**Encryption maps:** `subject`, `notes`, `location` (reads via `findWithDecryption`/`findOneWithDecryption`)

**RBAC features:** `activities.view`, `activities.manage`, `activities.complete`, `activities.cancel`, `activities.view_private`

**Deployment checklist (required before Sprint 2 can start):**

- [ ] `git push -u origin feat/activities-sprint1`
- [ ] Review migration SQL in `migrations/Migration20260615_activities.ts`
- [ ] `yarn db:migrate`
- [ ] `yarn mercato auth sync-role-acls`
- [ ] `yarn mercato entities seed-encryption --tenant <tenantId>`

**Known:** `yarn typecheck` exits code 2 due to 14 pre-existing errors in `.mercato/next/dev/types/validator.ts` (on `main` before this branch). The `activities` module itself is clean.

---

### Sprint 2 — Activity Extensibility

**Status: IMPLEMENTED**
**Branch:** `feat/activities-sprint2`
**Spec:** `.ai/specs/2026-06-15-sprint2-activity-technical-spec.md`
**Tests:** 54/54 green. Typecheck: clean. Migration applied.

**Delivered:**

| Area | Deliverable |
|---|---|
| Dynamic Activity Type Registry | Generator plugin, `activity-types.generated.ts`, `getActivityType()`, `getAllActivityTypes()` |
| ActivityLink entity | Junction table `activity_links`, CRUD API (4 endpoints), data migration from Sprint 1 |
| Activity Type Extensibility | Full `ActivityTypeDefinition` (capabilities, actions, RBAC, icons), `activity-types.client.ts` renderers |
| API | `GET /api/activity-types`, ActivityLink CRUD, `includeLinked` query param on list endpoint |
| UI | Dynamic filter bar, lazy renderer loading with Suspense, DefaultActivityCard fallback |

---

### Sprint 3A — Activity Creation UX

**Status: IMPLEMENTED**
**Branch:** `feat/activities-sprint3a` (from `feat/activities-sprint2`)
**Spec:** `.ai/specs/2026-06-15-sprint3a-activity-technical-spec.md`
**Tests:** 89/89 green. Typecheck: 0 errors. No DB migration.

**Delivered:**

| Area | Deliverable |
|---|---|
| `defaultValues` in ActivityTypeDefinition | Per-type form defaults (`occurredAt: 'now'`, `dueAt: 'end_of_day'`, `durationMinutes`) |
| POST `/api/activities` full DTO | Response includes full activity object + `links: []` |
| `ActivityTypePicker` | Type selection buttons with Lucide icon, ARIA pressed state |
| `ActivityFormFields` | Capabilities-driven field renderer (react-hook-form, plain HTML inputs) |
| `LogActivityDrawer` | Drawer side=right, TypePicker + Fields, pre-fill defaults, Cmd+Enter |
| `QuickNoteDialog` | Dialog for fast note, auto-focus, Cmd+Enter |
| `InlineActivityComposer` | Inline textarea for note/email types, Drawer trigger for task types |
| `utils.ts` | Extracted pure functions: `deriveSubjectAndNotes`, `parseParticipants`, `isInlineType`, `mergeWithFresh` |
| Optimistic updates | Placeholder card, `mergeWithFresh` deduplication, error recovery |
| `/backend/activities/new` | Standalone CrudForm page with `datetime` pickers |
| i18n | 40+ new keys for all Sprint 3A components |
| Tests | 35 unit tests in `__tests__/sprint3a.test.ts` |

**Fixes in Sprint 3A:** `@app/modules/*` tsconfig alias, `mapActivityToResponse` in `.map()`, `activity-types.ts` default export, `ActivityLink.createdAt` in `em.create()`.

**Removed before PR:** `QuickNoteDialog` — dead code, no trigger, not required by spec.

---

### Sprint 3B — Dictionary-backed Activity Types (Layer 3)

**Status: IMPLEMENTED**
**Branch:** `feat/activities-sprint3b` (from `feat/activities-sprint3a`)
**Spec:** `.ai/specs/2026-06-15-sprint3-activity-technical-spec.md` §9
**Tests:** 119/119 green. Typecheck: 0 errors.

**Delivered:**

| Area | Deliverable |
|---|---|
| `ActivityTypeDefinitionRecord` entity | `data/entities.ts`, table `activity_type_definitions`, auto-generated migration |
| Layer 3 CRUD API | `GET+POST /api/activity-type-definitions`, `GET+PATCH+DELETE /api/activity-type-definitions/[id]` |
| Runtime merge | `GET /api/activity-types` merges L1+L2+L3; `includeInactive=true` for timeline rendering |
| Cache | Tag-based invalidation `activity_type_defs:<tenantId>:<orgId>` on POST/PATCH/DELETE |
| RBAC | `activities.manage_types` → admin + superadmin |
| Admin settings page | `/backend/activities/settings/types` — DataTable + Create/Edit Dialog, Cmd+Enter submit |
| Tests | 30 unit tests in `__tests__/sprint3b.test.ts` — schema, merge logic, L1 guard |
| i18n | 40+ new keys |

**Deployment checklist:**
- [ ] `yarn db:migrate` — applies `Migration20260615183513_activities.ts`
- [ ] `yarn mercato auth sync-role-acls` — grants `activities.manage_types` to existing tenants

---

### Sprint 4A — O365 Calendar Sync (core infrastructure)

**Status: IMPLEMENTED**
**Branch:** `feat/activities-sprint3a` (current working branch)
**Module:** `src/modules/channel_office365/`

**Delivered:**

| Area | Deliverable |
|---|---|
| Module scaffold | `index.ts`, `acl.ts`, `setup.ts` (scheduler registration), `di.ts` |
| OAuth2 flow | `lib/adapter.ts` — `ChannelAdapter` with `providerKey: office365_calendar`, OAuth authorize URL + token exchange |
| Graph API client | `lib/graph-client.ts` — `fetchCalendarEvents()` via Delta API, `Prefer: odata.maxpagesize=100`, token refresh |
| Calendar sync worker | `workers/calendar-sync.ts` — queue `channel-office365-calendar-sync`, `upsertActivity()` with full deduplication |
| Scheduler | `setup.ts seedDefaults` — `schedulerService.register()`, UUID `3b8f7e4a-2c1d-4e5f-8a9b-0c1d2e3f4a5b`, 5m interval |
| Admin UI | `backend/channel_office365/page.tsx` — channel list, OAuth connect, status badge, `requires_reauth` reconnect flow |

**Key bugs fixed in Sprint 4A:**
- OAuth scope: `Calendars.Read` → `Calendars.ReadWrite` (required for future write-back)
- Graph Delta API: removed `&$top=100` from URL (use `Prefer: odata.maxpagesize=100` header only)
- `duration_minutes` capped at 1440 (null for multi-day events >1440 min)
- Scheduler UUID: string slug → proper UUID (`3b8f7e4a-2c1d-4e5f-8a9b-0c1d2e3f4a5b`)

**E2E verified:** OAuth → credentials → worker → 85 Activities imported → UPSERT dedup on second sync → scheduler running.

---

### Sprint 4B — O365 Calendar Sync (stability + privacy)

**Status: IMPLEMENTED**
**Branch:** `feat/activities-sprint3a` (current working branch)

**Delivered:**

| Item | Deliverable |
|---|---|
| 4B-6: `seriesMaster` guard | `calendar-sync.ts` — skip events where `event.type === 'seriesMaster'` (no `start`/`end` dates) |
| 4B-V: `visibility: private` | New synced activities default to `'private'` (was `'team'`). Business decision: O365 calendar is personal data. |
| 4B-V: backfill migration | `migrations/Migration20260616_channel_office365_backfill_visibility.ts` — applied. 85 records updated. |
| 4B-5: cancelled events | Batch `$in` query + single `em.flush()` — soft-delete (`deletedAt`) for cancelled meetings. |
| 4B-3: `requires_reauth` UX | Already implemented — `page.tsx` had status badge + "Reconnect" button (no code changes needed). |

**Migration snapshot:** `migrations/.snapshot-open-mercato.json` created (empty — module has no own entities).

**Operational notes:**
- esbuild CLI cache: after changing `workers/` or `lib/` TS → delete `.mercato/generated/modules.cli.generated.mjs` before `yarn mercato queue worker`
- Dev server: `yarn dev:reset` after changing worker/lib TS (Turbopack cache)

---

### Sprint 4C — O365 Calendar Sync (poll-now + scope expansion)

**Status: IMPLEMENTED**
**Branch:** `feat/activities-sprint4a` (current working branch)

**Delivered:**

| Item | Deliverable |
|---|---|
| 4C-3: queue factory | `lib/queue.ts` — `getO365CalendarSyncQueue()` via `createModuleQueue` |
| 4C-3: sync API route | `api/channel_office365/sync/route.ts` — `POST /api/channel_office365/sync`, validates channel ownership, enqueues `{ channelId }`, 202 response |
| 4C-3: worker filter | `workers/calendar-sync.ts` — reads optional `channelId` from `job.payload`; if present, filters to that channel only; absent → sync all (scheduler path unchanged) |
| 4C-3: Sync now button | `backend/channel_office365/page.tsx` — per-channel "Sync now" button with `RefreshCw` icon, `syncingId` state, `aria-label`, `refetch()` after 3s |
| 4C-4: Mail.ReadWrite scope | `lib/credentials.ts` — `Mail.ReadWrite` added to `O365_DEFAULT_SCOPES` (was `Mail.Read` initially, changed after Azure admin consent discovery); `O365_MAIL_READ_SCOPE = 'https://graph.microsoft.com/Mail.ReadWrite'` export |
| 4C-4: grantedScopes schema | `lib/credentials.ts` — `grantedScopes: z.array(z.string()).optional()` in `o365ChannelStateSchema` |
| 4C-4: adapter token capture | `lib/adapter.ts` — `exchangeOAuthCode` stores `grantedScopes: token.scope?.split(' ')` in returned credentials |
| 4C-4: worker propagation | `workers/calendar-sync.ts` — propagates `grantedScopes` from credentials to `channelState` on each successful sync |
| 4C-4: channels state API | `api/channel_office365/channels/route.ts` — `GET /api/channel_office365/channels` returns `{ items: [{ id, grantedScopes }] }`. Filters by `tenantId + userId + providerKey` only (no `organizationId` — fixed post-4C, was causing empty result when JWT lacked `orgId` claim) |
| 4C-4: Mail.ReadWrite hint | `backend/channel_office365/page.tsx` — inline hint per channel when `grantedScopes` doesn't include `Mail.ReadWrite`; second query to `/api/channel_office365/channels` |
| 4C-4: Azure scopes note | `backend/channel_office365/page.tsx` — setup instructions updated to list `Mail.ReadWrite` |
| i18n | `src/i18n/en.json` — 34 new `channel_office365.*` keys |

**Operational notes:**
- Azure App Registration for xentivo.pl tenant: `Mail.ReadWrite` is already consented. Existing connections continue calendar sync without interruption.
- Mail.ReadWrite hint disappears after user reconnects AND first sync completes (worker propagates grantedScopes to channelState).
- esbuild CLI cache: after changing `workers/` or `lib/` TS → delete `.mercato/generated/modules.cli.generated.mjs` before `yarn mercato queue worker`.

---

### Sprint 5 — Unified M365 Connector + Email Sync

**Phase 1: Unified M365 Connector — Status: IMPLEMENTED, checkpoint pending**
**Phase 2: Email Sync — Status: PLANNED, not started**
**Branch:** `feat/activities-sprint4a`

#### Phase 1: Unified M365 Connector (IMPLEMENTED)

| Area | Deliverable |
|---|---|
| `lib/credentials.ts` | Complete rewrite: `O365_PROVIDER_KEY='office365'`, `O365_INTEGRATION_ID='channel_office365'`, `O365_EXTERNAL_PROVIDER_CALENDAR='office365_calendar'` (NEVER changes), `O365_EXTERNAL_PROVIDER_MAIL='office365_mail'` (Phase 2), `o365CapabilityStateSchema`, `o365ChannelStateSchema` with nested `capabilities` |
| `lib/adapter.ts` | Rename: `O365CalendarChannelAdapter` → `O365ChannelAdapter`; `channelType = 'calendar'` unchanged; `getO365CalendarAdapter()` kept for compat |
| `di.ts` | DI token: `channelOffice365CalendarAdapter` → `channelOffice365Adapter`; uses `O365_PROVIDER_KEY` constant |
| `setup.ts` | `hasChannelAdapter(O365_PROVIDER_KEY)`; calendar scheduler name "Microsoft 365 Calendar Sync"; mail sync scheduler stub (UUID `7c2e9f1b-4a8d-5b6e-9c0d-1e2f3a4b5c6d`, `isEnabled: false`, queue `channel-office365-mail-sync`) |
| `integration.ts` | `id: O365_INTEGRATION_ID`, `title: 'Microsoft 365'`, `providerKey: O365_PROVIDER_KEY`, tags include `email`, redirect URI note updated |
| `workers/calendar-sync.ts` | Capability-aware: skips if `capabilities.calendar.enabled === false`; backward-compat delta read; self-migrating write (always writes nested structure); `type O365ChannelState` typed correctly |
| `api/.../channels/route.ts` | Returns `capabilities` alongside `grantedScopes`; default capabilities `{ calendar: { enabled: true }, mail: { enabled: false } }` |
| `backend/.../page.tsx` | Filters by `O365_PROVIDER_KEY`; OAuth URL uses `O365_PROVIDER_KEY`; `CapabilityState` type; calendar sync row with `capabilities.calendar.lastSyncedAt`; redirect URI note updated |
| `widgets/.../widget.client.tsx` | Uses `O365_PROVIDER_KEY` constant; label "Connect Microsoft 365" |
| `i18n/en.json` (module) | "Microsoft 365" throughout; new keys: `capability.calendar.label`, `capability.mail.label`, `setup.redirectUri` |
| `src/i18n/en.json` (app) | Same updates; `capability.*` and `setup.redirectUri` keys added |
| `migrations/Migration20260617_channel_office365_unified.ts` | NEW — Step 1: `provider_key` rename; Step 2: `integration_id` rename; Step 3: JSONB restructure flat→nested (idempotent guard, reversible `down()`) |

**tsc verification:** 0 errors (verified after all 13 files modified)
**yarn generate:** 410 API routes, no errors

**Phase 1 checkpoint (REQUIRED before Phase 2):**
1. Add Azure redirect URI: `<yourdomain>/api/communication_channels/oauth/office365/callback`
2. `yarn db:migrate` — applies `Migration20260617_channel_office365_unified.ts`
3. Verify OAuth flow with new redirect URI
4. Verify calendar sync worker runs post-migration
5. Verify deltaToken preserved in `capabilities.calendar.deltaToken`
6. Verify "Sync now" button (202 response)
7. No UI regressions on `/backend/channel_office365`
8. Verify migration rollback via `down()` in staging

#### Phase 2: Email Sync (IMPLEMENTED — 2026-06-18)

**Decisions applied:** P2-1 bodyPreview, P2-2 no attachments, P2-3 7-day bootstrap, P2-4 Inbox + SentItems, P2-5 no auto-link.

| File | Type | Status |
|---|---|---|
| `lib/credentials.ts` | Modified | Added `sentItemsDeltaToken` to `o65CapabilityStateSchema` |
| `lib/queue.ts` | Modified | Added `O365_MAIL_SYNC_QUEUE` + `getO365MailSyncQueue()` |
| `lib/graph-mail-client.ts` | NEW | Graph Mail Delta API client — `drainMailDelta()`, `GraphMailMessage`, 7-day bootstrap, Inbox + SentItems |
| `workers/calendar-sync.ts` | Modified | Tech debt fixed — batch load + `withAtomicFlush` (was N+1 flush per event) |
| `workers/mail-sync.ts` | NEW | Queue `channel-office365-mail-sync`, checks `capabilities.mail.enabled`, upserts Activities with `activityType: 'email'`, `lifecycleMode: 'fact'`, `externalProvider: 'office365_mail'`, batch + `withAtomicFlush` |
| `api/channel_office365/capabilities/route.ts` | NEW | `PATCH /api/channel_office365/capabilities` — toggle calendar/mail enabled; guards mail enable on `Mail.ReadWrite` scope |
| `api/channel_office365/mail-sync/route.ts` | NEW | `POST /api/channel_office365/mail-sync` — manual trigger; guards on `capabilities.mail.enabled` |
| `setup.ts` | Modified | Mail scheduler `isEnabled: false` → `isEnabled: true` |
| `backend/channel_office365/page.tsx` | Modified | Email capability row with Enable/Disable toggle, "Sync now" button, `lastSyncedAt` |
| `i18n/en.json` (module + app) | Modified | 13 new keys for email sync UI |

**Key constants (Phase 2):**
- `O365_EXTERNAL_PROVIDER_MAIL = 'office365_mail'` — Activity `externalProvider` for emails (NEVER changes)
- Mail scheduler UUID: `7c2e9f1b-4a8d-5b6e-9c0d-1e2f3a4b5c6d`
- Email Activity: `lifecycleMode: 'fact'`, `status: 'fact'`, `visibility: 'private'`, `sourceType: 'inbox' | 'sent'`
- Delta cursors: `capabilities.mail.deltaToken` (Inbox), `capabilities.mail.sentItemsDeltaToken` (SentItems)

#### Phase 3: Activities Widget UI Polish + CRM Backfill (CLOSED 2026-06-18)

**Commit:** `b76b21a`

| Area | Deliverable |
|---|---|
| Tab name | `groupLabel: 'Microsoft 365'` literal — `groupLabelKey` does not exist in `InjectionWidgetPlacement` type |
| Week calendar strip | Mon–Sun tile view with type-colored dots per activity type, click-to-filter by day, prev/next week navigation (client-side — no API reload) |
| Sort + filter + pagination | Sort toggle (newest/oldest), type filter chips (full registry, not just loaded page), total count badge, "Load more" cursor pagination (100 items/page) |
| Timeline axis | Flex gutter approach: continuous vertical line + dot, no `absolute` positioning (avoids overflow clipping) |
| DefaultActivityCard | Wrapped in `<Link href="/backend/activities/{id}">`, time shown in date when not midnight |
| API bugfix | Visibility filter `$or` moved inside `$and` — was overwriting entity-link `$or` (caused all activities to show on every record regardless of entity) |
| Backfill subscriber | `subscribers/customer-activity-backfill.ts` — `customers.person.created` → decrypt email → JSONB `@>` query on `activities.participants` → `autoLinkActivityToCustomers` (ON CONFLICT DO NOTHING). Closes the delta-token gap for retrospective linking. |

---

## Future Roadmap

| Sprint | Scope | Status | Key deliverables |
|---|---|---|---|
| **Sprint 1–3B** | Activity module core + UX + types | **DONE** | Entity, API, widget, creation UX, optimistic updates, dynamic type registry |
| **Sprint 4A–4C** | O365 Calendar Sync | **DONE** | OAuth2, Graph Delta API, worker, scheduler, manual sync, Mail.ReadWrite scope |
| **Sprint 5** | Unified M365 Connector + Email Sync + UI polish | **DONE — `b76b21a`** | Capability-based channelState, email sync, week calendar strip, backfill subscriber |
| **Sprint 6** | Activity Search & Smart Filters | Proposed | Full-text search, quick-filter chips, activity count badge on customer list |
| **Sprint 7** | O365 Write-back (CRM → Calendar) | Proposed | Create/edit/cancel Activity → syncs to O365; conflict resolution policy needed first |
| **Sprint 8** | CustomerInteraction Deprecation | Proposed | Data migration CI → Activity, UI redirect, module disable flag |
| **Sprint 9** | Activity Automation & Notifications | Proposed | Task due-date reminders, workflow triggers, auto-create from deal events |
| **Sprint 10** | Reporting & Analytics | Proposed | Activity dashboard, team leaderboard, deal pipeline activity, CSV export |

See `.ai/specs/2026-06-18-sprint6-10-roadmap.md` for full Sprint 6–10 specifications, scope, prerequisites, and ordering rationale.

---

## Open Questions

1. **O365 calendar event ownership** — RESOLVED (Sprint 4A): `ownerUserId` = OAuth grantor. Do not re-open. See Decision #11 for multi-attendee analysis.

2. **Activity notifications:** Should completing a task activity trigger a notification to the owner? `notifications.ts` in the activities module is not yet created. Decide before implementing.

3. **`customFields` in API response:** The API currently returns `customFields: {}` (empty object). The custom fields mechanism will populate this later.

4. **ActivityLink future extraction (trigger: Sprint 5+):** If 3+ modules independently need polymorphic association tables — evaluate extracting `@open-mercato/entity-links`. Not before. See Decision #10.

5. **O365 email sync scope** — PARTIALLY RESOLVED (Sprint 4C): `Mail.ReadWrite` added to `O365_DEFAULT_SCOPES` in Sprint 4C (covers all Mail.Read capabilities). New connections receive the scope automatically; existing connections need re-auth to pick it up. Sprint 5 can detect via `grantedScopes` stored in `channelState` (propagated by worker after each sync).

6. **O365 write-back (CRM → calendar):** Before implementing 4C-1, design a bi-directional conflict resolution strategy: what happens when both sides change the same event between syncs? Who wins? This is a product decision, not a code decision.

7. **O365 auto-link activities to CRM customers:** **RESOLVED (Sprint 5 Phase 3).** `subscribers/customer-activity-backfill.ts` — persistent subscriber on `customers.person.created` retroactively links all existing activities where `participants[].email` matches the new person's decrypted `primaryEmail`. Forward-looking: new activities are linked during sync by `customer-linker.ts` (`buildEmailCustomerMap` + `autoLinkActivityToCustomers`). Both paths use `ActivityLink` with ON CONFLICT DO NOTHING. Delta-token gap closed.

---

## Sprint 5: CLOSED (2026-06-18)

**Last commit:** `b76b21a feat(activities+channel_office365): Sprint 5 — M365 email sync, activities UI polish, backfill linker`
**Branch:** `feat/activities-sprint4a`
**tsc:** 0 errors. yarn generate: clean. All migrations committed.

### Deployment checklist (required before first live use on a new environment)

1. `yarn db:migrate` — applies (in order):
   - `Migration20260616_channel_office365_backfill_visibility.ts`
   - `Migration20260617_channel_office365_unified.ts` (providerKey + integrationId rename + channelState JSONB restructure)
   - `Migration20260618_activities_metadata.ts` (`effective_date GENERATED STORED` + `metadata JSONB`)
2. Azure Portal → add redirect URI: `<yourdomain>/api/communication_channels/oauth/office365/callback`
3. Reconnect O365 in Settings → Integrations → Microsoft 365 (required after providerKey rename)
4. Enable Email Sync in `/backend/channel_office365` → Email row → Enable toggle
5. `yarn mercato auth sync-role-acls` — propagate any new RBAC features to existing tenants

### Post-deployment E2E verification

| Check | How to verify |
|---|---|
| Calendar sync | Click "Sync now" on calendar row → Activities count increases |
| Email sync | Enable mail capability → "Sync now" → `SELECT COUNT(*) FROM activities WHERE external_provider = 'office365_mail'` |
| CRM auto-link | Open any customer person → "Microsoft 365" tab → linked activities visible |
| Backfill | Add a new person to Customers → open their detail → Microsoft 365 tab shows historical activities |
| Sort order | Activities list shows newest first; cursor pagination loads older items correctly |
| Week calendar | Calendar strip shows dots for days with activities; clicking a day filters the list |

### Closed decisions — Sprint 5 Phase 3

| Decision | Answer |
|---|---|
| `groupLabelKey` in injection-table? | Does not exist in framework `InjectionWidgetPlacement` type — use `groupLabel` literal string only |
| Calendar navigation triggers API reload? | No — 100 items loaded upfront, week navigation and day-filter are client-side only |
| Backfill subscriber location? | `channel_office365` module (not `activities`) — it is O365-specific email-matching logic |
| Timeline axis implementation? | Flex gutter (no `absolute` positioning) — avoids overflow clipping issues in injected tab containers |

### Closed decisions — Sprint 4C scope (carried forward)

| ID | Item | Status |
|---|---|---|
| 4C-1 | Write-back Activity → O365 | Deferred → Sprint 7. Requires conflict resolution policy decision first. |
| 4C-2 | Shared Activity / attendee resolution | Permanently deferred. See Decision #11. |
| 4C-5 | Multi-calendar support | Low priority — deferred to Sprint 11+. |
| 4C-6 | Configurable sync window | Low priority — deferred to Sprint 10+. |

## Next Session Starting Point — Sprint 6

**Proposed scope:** Activity Search & Smart Filters
**Full spec:** `.ai/specs/2026-06-18-sprint6-10-roadmap.md` → Sprint 6 section

### Pre-Sprint 6 decisions needed

1. **Search backend:** PostgreSQL `ilike` (simple, no infra) vs OpenMercato search indexer (full-text, requires Meilisearch). Recommendation: start with `ilike` on `subject` + `notes`.
2. **O365 write-back priority:** If Sprint 7 (write-back) is more urgent than Sprint 6 (search), swap them. Write-back requires conflict resolution policy decision before code starts.
3. **CustomerInteraction migration timing:** Confirm Sprint 8 is the right timing — the longer it waits, the more the two models diverge.

### What to load before starting Sprint 6

| Task | Load |
|---|---|
| Add search to activities | `.ai/guides/search.md` |
| Add quick-filter chips to widget | `src/modules/activities/widgets/injection/timeline/widget.client.tsx` |
| Add search to list page | `src/modules/activities/backend/page.tsx` |

### Closed decisions (Sprint 1–5 complete) — do not re-open

| Decision | Answer | Where documented |
|---|---|---|
| Activity unified table vs sub-tables | Unified table | Decision #1 |
| ActivityLink: junction table or second FK pair? | Junction table `activity_links` | Decision #10 |
| ActivityLink: stays in Activities or generic module? | Stays in Activities module | Decision #10 |
| Build-time vs runtime registry (Sprint 2)? | Build-time generated file. Runtime in Sprint 3B. | Sprint 2 spec §1.5 |
| Dictionary-backed types (Layer 3)? | Sprint 3B — DONE | Sprint 3A spec scope |
| Drawer vs Sheet for full form? | `Drawer` from `@open-mercato/ui/primitives/drawer` | Sprint 3A spec |
| react-hook-form resolvers? | Manual Zod `safeParse()` — `@hookform/resolvers` not installed | Sprint 3A impl |
| L3 inactive types in timeline? | `GET /api/activity-types?includeInactive=true` for rendering | Sprint 3B impl |
| Cache invalidation strategy? | Tag-based `activity_type_defs:<tenantId>:<orgId>` on every write | Sprint 3B impl |
| O365: per-user vs tenant-wide account? | Per-user OAuth2 — each staff member connects own M365 account | Decision #4 |
| O365 `ownerUserId`? | Calendar grantor (OAuth user) — not resolved from attendees | Sprint 4A impl |
| O365 default `visibility`? | `'private'` — O365 calendar is personal data; opt-in `'team'` per event | Sprint 4B (4B-V) |
| O365 `seriesMaster` handling? | Skip in sync loop — no `start`/`end` dates; individual occurrences synced | Sprint 4B (4B-6) |
| O365 cancelled event handling? | Soft-delete via `deletedAt`; batch flush after single `$in` query | Sprint 4B (4B-5) |
| Graph Delta API page size? | `Prefer: odata.maxpagesize=100` header only — `$top` in URL breaks delta tracking | Sprint 4A bugfix |
| O365 `duration_minutes` for multi-day events? | Capped at 1440 (null for >1440) — enforced by `activities_duration_check` constraint | Sprint 4A bugfix |
| O365 Activity per-user vs shared? | Per-user (N records for N staff at same meeting) — see Decision #11 | Sprint 4C analysis |
| O365 `externalId` key? | Per-mailbox Graph event ID (NOT `iCalUId`) — unique per user, no collision | Decision #11 |
| O365 scheduler UUID? | `3b8f7e4a-2c1d-4e5f-8a9b-0c1d2e3f4a5b` — `ScheduledJob.id` is UUID type | Sprint 4A bugfix |
| O365 delta cursor storage? | Sprint 4A-4C: `channel.channelState.deltaToken` (flat). Sprint 5+: `channelState.capabilities.calendar.deltaToken` (nested). Backward-compat fallback in worker. | Sprint 4A impl + Sprint 5 Phase 1 |
| 4C-2 (attendee resolution) scope? | Deferred from Sprint 4C; if revisited: 4C-2a (enrich `participants` JSON) only | Sprint 4C analysis |
| O365 providerKey rename? | `office365_calendar` → `office365`. SQL migration + worker + integration + UI updated. channelType stays `'calendar'`. | Sprint 5 Phase 1 (Decision #12) |
| O365 integrationId rename? | `channel_office365_calendar` → `channel_office365`. SQL migration updates `integration_credentials`. | Sprint 5 Phase 1 (Decision #12) |
| O365 channelType change? | **REJECTED** — `channelType = 'calendar'` stays unchanged. No business value, additional risk. | Sprint 5 Phase 1 |
| O365 `externalProvider` on Activity? | `'office365_calendar'` — NEVER changes post-creation. Is a semantic data-source identifier, not the channel providerKey. Decoupled from connector rename. | Sprint 5 Phase 1 (Decision #12) |

---

## Token Efficiency Rules

For future sessions working on this project:

- Read `project-context.md` first — do not re-derive what is already here.
- Do not re-scan the full `src/` tree. Scope exploration to the module(s) relevant to the current task.
- Do not re-analyze Activity architecture — all decisions are final and documented above.
- Do not re-analyze O365 architecture — the approach is decided; the spec exists.
- Use `.ai/specs/` as the source of truth for implementation detail, not code reverse-engineering.
- Prefer short, concrete answers. No long reports unless explicitly requested.
- When implementing, match the task to the AGENTS.md Task → Context Map first, load the listed files, then write code.
- For Sprint 2: start by reading `.ai/specs/2026-06-15-sprint2-activity-technical-spec.md`, not by exploring `src/`.
- Always use `rtk` prefix for terminal commands (60–90% token savings on command output).
