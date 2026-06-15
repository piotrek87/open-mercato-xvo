# Project Context — my-app (OpenMercato)

**Last updated:** 2026-06-15
**Sessions:** Sprint 1 Activity Module implementation + Sprint 2 specification & architectural decisions

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

**Current state (2026-06-15):**
- Classic-mode OpenMercato scaffold with all built-in modules enabled (customers, sales, catalog, auth, integrations, etc.)
- Sprint 1 of the Activity Module is **fully implemented and deployed** on branch `feat/activities-sprint1` (migrated, auth synced, encryption seeded)
- Sprint 2 is **fully implemented** on branch `feat/activities-sprint2` (migrated, 54 tests passing)
- Sprint 3 is **specified and approved** — ready to implement
- No O365 integration yet (Sprint 4+)

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

- Separate `integrations_o365` module (Sprint 4).
- Uses existing `@open-mercato/core` integrations provider pattern.
- Pattern to follow: `channel-imap` and `channel-gmail` modules.
- Scope: bidirectional email sync (Graph API) + bidirectional calendar sync.
- Activity is the write target for all synced items.

### 5. Tenant/User Configuration Model

- Each staff member has their own O365 OAuth2 token stored in the `integrations` module credential store.
- Sync runs per-user, not per-tenant.
- `externalId` + `externalProvider` on the Activity entity is the deduplication key (`UNIQUE WHERE external_id IS NOT NULL`).
- `syncDirection: 'inbound' | 'outbound' | 'bidirectional'` tracks the sync origin.

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

---

## Document Index

### Architectural Specifications (binding decisions — do not re-analyze)

| Path | Description | Status |
|---|---|---|
| `.ai/specs/2026-06-15-activity-model-architecture.md` | Core architectural spec — why unified table, lifecycle_mode, visibility, linked entity pattern | Final |
| `.ai/specs/2026-06-15-activity-product-architecture.md` | Product-level design — UX patterns, timeline view, widget injection rationale | Final |
| `.ai/specs/2026-06-15-activity-extensibility-architecture.md` | Extensibility architecture — registry-based types (3 layers), renderers, filters, zero-coupling model | Final |
| `.ai/specs/2026-06-15-customerinteraction-vs-activity.md` | Analysis of CustomerInteraction vs Activity — deprecation rationale, migration strategy | Final |
| `.ai/specs/2026-06-15-office365-integration.md` | O365 integration architecture — OAuth2 per-user, Graph API, sync model | Final (Sprint 4+) |

### Technical Implementation Specs (source of truth for implementation)

| Path | Description | Status |
|---|---|---|
| `.ai/specs/2026-06-15-sprint1-activity-technical-spec.md` | Sprint 1 tech spec — data model (28 cols), API contracts, RBAC, events, migration, 8 risks | Implemented |
| `.ai/specs/2026-06-15-sprint2-activity-technical-spec.md` | Sprint 2 tech spec — dynamic registry, ActivityLink entity, type extensibility, API contracts, UI architecture, 7 risks | Approved |

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

### Sprint 3 — Activity Creation UX

**Status: SPECIFIED & APPROVED — ready to implement**
**Branch:** to create from `feat/activities-sprint2`
**Spec:** `.ai/specs/2026-06-15-sprint3-activity-technical-spec.md`
**Hard dependency:** Sprint 2 must be deployed and migrated first.

**Scope:**

| Area | Deliverable |
|---|---|
| Quick-log flow | `InlineActivityComposer` — inline note + Drawer trigger for other types |
| Full-form Drawer | `LogActivityDrawer` (Sheet side=right), `ActivityTypePicker`, `ActivityFormFields` |
| Dynamic Form Architecture | capabilities-driven field visibility, react-hook-form + Zod |
| Activity Creation Context | pre-fill entityType/entityId from timeline context; standalone `/backend/activities/new` |
| Layer 3 (dictionary-backed types) | `activity_type_definitions` table, CRUD API + admin UI |
| Optimistic updates | placeholder card in timeline, error recovery |
| API extensions | POST returns full DTO; activity-types endpoint merges L3 from DB |

**Out of scope Sprint 3:** edit activity, completion notifications, bulk actions, O365 sync.

---

## Future Roadmap

| Sprint | Scope | Key deliverables |
|---|---|---|
| **Sprint 3** | Activity creation UX | "Log Activity" modal/drawer, quick-log from timeline, full-text search integration, dictionary-backed types (Layer 3) |
| **Sprint 4** | O365 Integration | `integrations_o365` module, per-user OAuth2 flow, email sync (inbound Graph API), calendar sync (bidirectional) |
| **Sprint 5** | Gmail Integration | Per-user OAuth2, Gmail API, email sync |
| **Sprint 6** | Activity automation | Workflow triggers on activity events, auto-create activities from sales events |
| **Sprint 7** | Reporting & analytics | Activity dashboard, team performance views, funnel metrics |
| **Sprint 8** | CustomerInteraction migration | Bridge + migration to Activity; deprecate CustomerInteraction UI |

---

## Open Questions

1. **O365 calendar event ownership (Sprint 4):** When a calendar event is synced from O365, should `ownerUserId` be set to the calendar owner, or to the first attendee who is a staff member? This affects deduplication when multiple staff attend the same meeting. Decide before Sprint 4.

2. **Activity notifications (Sprint 3+):** Should completing a task activity trigger a notification to the owner? The `notifications.ts` file in the activities module is not yet created. Decide before Sprint 3.

3. **`customFields` in API response (Sprint 3):** The API currently returns `customFields: {}` (empty object). The custom fields mechanism will populate this in Sprint 3.

4. **ActivityLink future extraction (trigger: Sprint 5+):** If 3+ modules independently need polymorphic association tables — evaluate extracting `@open-mercato/entity-links` as a platform module. Not before. See Decision #10.

---

## Next Session Starting Point

### Prerequisite: Sprint 1 deployment

Before any Sprint 2 work begins, verify Sprint 1 is deployed:

```bash
rtk git status                          # confirm on feat/activities-sprint1 or main
rtk git log --oneline -5                # confirm d487588 is present
# If not yet deployed, run the Sprint 1 deployment checklist above
```

### Step 1: Read before writing any code

Load these files in this order — do not skip:

```
1. .ai/context/project-context.md             ← this file (already done)
2. .ai/specs/2026-06-15-sprint2-activity-technical-spec.md   ← implementation source of truth
3. src/modules/activities/data/entities.ts    ← current Activity entity (before adding ActivityLink)
4. src/modules/activities/activity-types.ts   ← current static registry (Sprint 1)
```

Do NOT scan the full `src/` tree. These 4 files are sufficient context.

### Step 2: Suggested implementation order

Follow Appendix B of the Sprint 2 tech spec exactly:

| Step | Task | Notes |
|---|---|---|
| 1 | Generator extension | Add `activity-types.ts` scan target; output `activity-types.generated.ts`; validate on duplicate IDs |
| 2 | `ActivityTypeDefinition` type | Full shape with capabilities, actions, RBAC fields — replace Sprint 1 partial definition |
| 3 | ActivityLink migration (schema) | New table + indexes + constraints — run `yarn db:generate` to verify SQL |
| 4 | ActivityLink migration (data) | Backfill from existing `linked_entity_type/id` — idempotent INSERT SELECT |
| 5 | ActivityLink CRUD API | 4 endpoints: GET list, POST create, PATCH update, DELETE |
| 6 | Registry endpoint | `GET /api/activity-types` with RBAC filter |
| 7 | Updated `GET /api/activities/:id` | Embed `links: []` in response |
| 8 | `includeLinked` query param | OR EXISTS path for timeline queries |
| 9 | `activity-types.client.ts` | Lazy renderer architecture; generated merge file |
| 10 | UI: lazy renderer loading | Suspense + DefaultActivityCard fallback in timeline widget |
| 11 | UI: dynamic filter bar | Generated from registry, RBAC-filtered, URL state |
| 12 | Tests | Unit tests for registry lookup, ActivityLink validators, timeline query paths |
| 13 | i18n | Any new keys for Sprint 2 UI |

Commit after each logical step (not all at end). Use `/om-auto-create-pr-loop` skill for autonomous execution.

### Step 3: Closed decisions — do not re-open

The following were explicitly decided and must not be re-analyzed in Sprint 2:

| Decision | Answer | Where documented |
|---|---|---|
| ActivityLink: junction table or second FK pair? | Junction table `activity_links` | Decision #10, Sprint 2 spec §2 |
| ActivityLink: stays in Activities or generic module? | Stays in Activities module | Decision #10 |
| Keep `Activity.linked_entity_type/id` columns? | Yes — backward compat, denormalized primary | Sprint 2 spec §2.3 |
| Build-time vs runtime registry? | Build-time only (Sprint 2). No runtime registration API. | Sprint 2 spec §1.5 |
| Dictionary-backed types (Layer 3)? | Deferred to Sprint 3 | Sprint 2 spec scope |
| Custom fields UI? | Out of scope Sprint 2 | Sprint 2 spec scope |
| Bulk actions? | Out of scope Sprint 2 | Sprint 2 spec scope |
| Renderer per type: lazy import or eager? | Lazy import (React.lazy + Suspense) | Sprint 2 spec §5.2 |
| Timeline query for multi-link: OR EXISTS or UNION? | OR EXISTS for Sprint 2 — UNION is Sprint 3 option if needed | Sprint 2 spec §2.5 + R-3 |

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
