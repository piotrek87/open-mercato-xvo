# Plan — 2026-06-15-activities-sprint1

**Source spec:** `.ai/specs/2026-06-15-sprint1-activity-technical-spec.md`
**Branch:** `feat/activities-sprint1`
**Base branch:** `develop`

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr`. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Run folder + execution plan | done | — |
| 1 | 1.2 | Module scaffold (index, acl, setup, di, events, encryption, activity-types) | done | 0f6bf2e |
| 1 | 1.3 | Entity + validators | done | f8dd62b |
| 1 | 1.4 | Migration file | done | c96af11 |
| 1 | 1.5 | Register in src/modules.ts + yarn generate | done | 115492d |
| 2 | 2.1 | API list + create route + openapi.ts | done | fb0a883 |
| 2 | 2.2 | API single record routes (GET/PUT/DELETE) | todo | — |
| 2 | 2.3 | Lifecycle routes (complete, cancel, reopen, restore) | todo | — |
| 3 | 3.1 | Backend list page | todo | — |
| 3 | 3.2 | ActivityTimeline widget component | todo | — |
| 3 | 3.3 | Widget injection table | todo | — |
| 4 | 4.1 | i18n translations (en.json) | todo | — |
| 4 | 4.2 | Unit tests for validators + lifecycle state machine | todo | — |

## Goal

Implement the Sprint 1 Activity Module for the OpenMercato standalone application. The module provides a universal activity/task tracking system that will eventually replace `CustomerInteraction` as the primary source of truth for emails, calendar events, tasks, calls, and notes.

## Scope

- `src/modules/activities/` — new module, all files
- `src/modules.ts` — register `activities` module
- No changes to existing modules except widget injection slots

## Non-goals

- O365 / Gmail sync
- ActivityLink entity (Sprint 2)
- Activity type registry auto-discovery (Sprint 2)
- Custom fields (Sprint 2)
- Full-text search (Sprint 3)
- CustomerInteraction bridge/migration (Sprint 8)
- Any changes to existing modules' core logic

## Risks

1. No git remote / `gh` CLI — PR is local-only. User must push and create PR manually after.
2. Repository was initialized in this run — `develop` and `feat/activities-sprint1` created from initial commit.
3. yarn generate requires running Node + the dev environment; run after module registration.
4. Migration probe (`yarn db:generate`) requires a live DB connection; migration SQL will be authored manually based on entity definition.
5. Widget injection spot IDs verified from source: `customers.person.detail:tabs`, `detail:customers.company:tabs`, `sales.document.detail.order:tabs`.

## External References

None (no `--skill-url` arguments provided).

## Implementation Plan

### Phase 1: Module Scaffold & Entity

**Step 1.1 — Run folder + execution plan** (this file)

**Step 1.2 — Module scaffold**
Files to create:
- `src/modules/activities/index.ts`
- `src/modules/activities/acl.ts`
- `src/modules/activities/setup.ts`
- `src/modules/activities/di.ts`
- `src/modules/activities/events.ts`
- `src/modules/activities/encryption.ts`
- `src/modules/activities/activity-types.ts`

**Step 1.3 — Entity + validators**
Files to create:
- `src/modules/activities/data/entities.ts` — Activity entity (28 columns as per spec)
- `src/modules/activities/data/validators.ts` — Zod schemas for create/update

**Step 1.4 — Migration file**
Files to create:
- `src/modules/activities/migrations/Migration20260615_activities.ts`
- `src/modules/activities/migrations/.snapshot-open-mercato.json` (activities module portion)

**Step 1.5 — Register module**
- Update `src/modules.ts` to add `{ id: 'activities', from: '@app' }`
- Run `yarn generate` to update generated files

### Phase 2: API Layer

**Step 2.1 — API list + create**
- `src/modules/activities/api/openapi.ts`
- `src/modules/activities/api/route.ts` — GET list + POST create

**Step 2.2 — API single record routes**
- `src/modules/activities/api/[id]/route.ts` — GET one + PUT + DELETE

**Step 2.3 — Lifecycle routes**
- `src/modules/activities/api/[id]/complete/route.ts`
- `src/modules/activities/api/[id]/cancel/route.ts`
- `src/modules/activities/api/[id]/reopen/route.ts`
- `src/modules/activities/api/[id]/restore/route.ts`

### Phase 3: Backend UI + Timeline Widget

**Step 3.1 — Backend list page**
- `src/modules/activities/backend/page.tsx`
- `src/modules/activities/backend/page.meta.ts`

**Step 3.2 — ActivityTimeline widget**
- `src/modules/activities/widgets/injection/timeline/widget.ts`
- `src/modules/activities/widgets/injection/timeline/widget.client.tsx`

**Step 3.3 — Widget injection table**
- `src/modules/activities/widgets/injection-table.ts`

### Phase 4: i18n + Tests

**Step 4.1 — i18n translations**
- `src/modules/activities/i18n/en.json`

**Step 4.2 — Unit tests**
- `src/modules/activities/__tests__/validators.test.ts`
- `src/modules/activities/__tests__/lifecycle.test.ts`
