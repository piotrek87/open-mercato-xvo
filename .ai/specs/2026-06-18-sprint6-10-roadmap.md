# Roadmap — Sprints 6–10

**Project:** my-app (OpenMercato CRM)
**Date:** 2026-06-18
**Status:** Proposed — not yet started
**Context:** Continuation of Sprint 1–5. Activities module + M365 integration are complete. This roadmap covers the next phase of development.

---

## Sprint 6 — Activity Search & Smart Filters

**Estimated effort:** 2–3 days
**Priority:** High — 1350+ activities with no search is a usability blocker
**Prerequisites:** None — builds on Sprint 5 API

### Scope

| Feature | Detail |
|---|---|
| Full-text search | `GET /api/activities?q=<term>` — search subject, notes, participant names. Use OpenMercato search guide (`.ai/guides/search.md`). |
| Activity count badge | Show activity count on customer list/company list cards — `includeLinked=true` count per entity. |
| Quick-filter chips | "Due today", "Overdue", "My activities" — pre-set filter shortcuts above the timeline in the widget. |
| Date range filter in widget | Replace the "sync from date" input with a proper date-range picker (from/to) wired to `dateField: occurredAt`. |
| Activity search page | `/backend/activities` search bar wired to `GET /api/activities?q=` — results in DataTable with highlighted match. |

### Files to touch

- `src/modules/activities/api/route.ts` — add `q` param, full-text WHERE clause
- `src/modules/activities/search.ts` — register searchable fields
- `src/modules/activities/widgets/injection/timeline/widget.client.tsx` — quick-filter chips, date range
- `src/modules/activities/backend/page.tsx` — search bar on list page

### Key decision needed

Does the search use PostgreSQL `tsvector` / `ilike` (simple, no setup) or OpenMercato's search indexer (full-text, requires Meilisearch/Typesense)? Recommendation: start with `ilike` on `subject` + `notes`, migrate to indexer in Sprint 9 when volume justifies it.

---

## Sprint 7 — O365 Write-back (CRM → Calendar)

**Estimated effort:** 4–5 days
**Priority:** High — closes deferred item 4C-1
**Prerequisites:** Conflict resolution policy decision (see below)

### Scope

| Feature | Detail |
|---|---|
| Create Activity → O365 event | When a staff member creates a meeting-type Activity with `externalProvider = null`, offer to push it to O365 calendar. |
| Update Activity → O365 event | Editing subject, date, duration, participants on a synced Activity updates the O365 event. |
| Cancel/delete Activity → O365 cancel | Soft-deleting a synced Activity sends Graph API `PATCH /events/{id}` with `isCancelled: true`. |
| Write-back toggle | Per-user opt-in: "Sync activities I create to Microsoft 365 calendar". Stored in channel settings. |

### Conflict resolution policy (required decision before Sprint 7 starts)

Two models to choose from:

| Model | Behavior | Trade-off |
|---|---|---|
| **Last-write-wins** | Whichever side (CRM or O365) changed last at next delta sync wins. Simple, may lose CRM edits if O365 changes arrive after. | Low complexity |
| **CRM is master** | CRM changes always win. O365 changes that arrive via delta are only applied if `updatedAt` in O365 > last CRM update. | Medium complexity, correct for CRM-centric workflows |

Recommendation: **CRM is master** — the CRM is the system of record, O365 is a view.

### Files to create/modify

- `lib/graph-client.ts` — add `createCalendarEvent()`, `updateCalendarEvent()`, `cancelCalendarEvent()`
- `workers/calendar-sync.ts` — write-back logic in delta processing loop
- `api/channel_office365/write-back/route.ts` — optional manual trigger
- `data/entities.ts` (activities) — add `syncDirection: 'bidirectional'` option

---

## Sprint 8 — CustomerInteraction Deprecation

**Estimated effort:** 3–4 days
**Priority:** Medium — tech debt, but not urgent until volume grows
**Prerequisites:** Sprint 1–5 complete (Activities is the write target)
**Context:** Decision #2 in project-context.md

### Scope

| Phase | Detail |
|---|---|
| Read bridge | `CustomerInteraction` API responses include a computed `activity: Activity \| null` reference for existing linked records. Reverse-lookup via `externalId = interaction.id`. |
| Data migration | `Migration20260XXX_ci_to_activities.ts` — for each `CustomerInteraction` record without a matching Activity, create one with `sourceType: 'customer_interaction_import'`, `externalId: ci.id`. Run once. |
| UI redirect | `/backend/customer_interactions` 301 → `/backend/activities`. Remove CustomerInteraction tab from customer detail pages (Activity widget already covers this). |
| Module flag | Add `CUSTOMER_INTERACTION_DEPRECATED=true` env flag — disables CustomerInteraction module in classic mode without ejecting. |

### Key risk

CustomerInteraction may have references in workflow rules, notifications, or custom code in other modules. Audit before migration. Use `grep -r "CustomerInteraction\|customer_interaction"` across `src/modules/` first.

### Files to touch

- `src/modules/customers/` — remove or redirect CustomerInteraction routes
- New migration in `src/modules/activities/migrations/`
- `src/modules.ts` — disable CustomerInteraction if env flag set

---

## Sprint 9 — Activity Automation & Notifications

**Estimated effort:** 3–4 days
**Priority:** Medium — high value for sales teams
**Prerequisites:** Sprint 6 (search), events infrastructure (already in place)

### Scope

| Feature | Detail |
|---|---|
| Task due-date reminders | `notifications.ts` in activities module — notify `ownerUserId` when a task Activity's `dueAt` is within 24h and status is not `completed`. |
| Overdue task notification | Daily job: find tasks where `dueAt < now` and `status != completed` → notify owner. |
| Workflow trigger — activity created | Emit `activities.activity.created` → workflow engine can define steps (e.g. "after meeting created, create follow-up task"). |
| Auto-create task from deal events | Subscribe to `customers.deal.won` → auto-create a follow-up task Activity linked to the deal. Opt-in per workflow rule. |
| `activities.activity.completed` event | Emit when `status` transitions to `completed`. Enables downstream automation. |

### Files to create/modify

- `src/modules/activities/notifications.ts` — declare notification types
- `src/modules/activities/subscribers/task-overdue-notify.ts` — overdue notifier
- `src/modules/activities/subscribers/deal-won-followup.ts` — auto-create task on deal won
- `src/modules/activities/events.ts` — add `activities.activity.completed` event

---

## Sprint 10 — Reporting & Analytics Dashboard

**Estimated effort:** 4–5 days
**Priority:** Low — deferred until data volume and team size justify dashboards
**Prerequisites:** Sprint 6–9 complete (data quality + tagging)

### Scope

| Report | Detail |
|---|---|
| Activity volume chart | Bar chart: activities by type + period (week / month / quarter). Source: `GET /api/activities?from=&to=&groupBy=activityType`. |
| Team leaderboard | Activities per `ownerUserId` per period. Useful for sales managers. |
| Deal pipeline activity | Activities per deal per stage. Identifies deals going cold (no activity > 14 days). |
| Response time metric | Time between email received (`externalProvider: office365_mail`) and first outbound email. |
| CSV export | `GET /api/activities?export=csv` — download full filtered set. |

### Files to create

- `src/modules/activities/api/stats/route.ts` — aggregation endpoint
- `src/modules/activities/backend/activities/stats/page.tsx` — dashboard page
- `src/modules/activities/backend/activities/stats/page.meta.ts`

### Key constraint

The `effective_date GENERATED STORED` column (Sprint 5 migration) is the correct sort key. All aggregate queries should use it as the time dimension — not `created_at`.

---

## Deferred / out of scope for Sprints 6–10

| Item | Reason deferred | Earliest sprint |
|---|---|---|
| M365 Contacts Sync (bi-directional) | Significant complexity — conflict resolution between Graph contacts and CustomerEntity (encrypted fields, merge strategy). | Sprint 11+ |
| Activity module → `@open-mercato/core-activities` | Premature extraction without 3+ app instances using it. | Sprint 12+ |
| Multi-calendar support | Low user demand. Most users have one primary calendar. | Sprint 11+ |
| Configurable sync window | Power user feature — −7d/+90d bootstrap is correct default. | Sprint 10+ |
| ActivityLink generic extraction (`@open-mercato/entity-links`) | Trigger: 3+ modules independently needing polymorphic association tables. Currently only Activities uses it. | If trigger met |
| O365 event write-back conflict resolution | Needs product decision before Sprint 7 can start. | Sprint 7 (after decision) |

---

## Sprint ordering rationale

```
Sprint 5 DONE
    │
    ├── Sprint 6: Search (usability — most users hit this immediately)
    │
    ├── Sprint 7: Write-back (closes the O365 integration loop — read + write)
    │
    ├── Sprint 8: CustomerInteraction migration (tech debt — should not accumulate past Sprint 8)
    │
    ├── Sprint 9: Automation (workflow value — sales teams need follow-up automation)
    │
    └── Sprint 10: Reporting (analytics — only valuable once data volume is large enough)
```

Sprints 6 and 7 can be swapped if write-back is higher priority than search for the first demo users. Sprint 8 should not be pushed past Sprint 9 — the longer CustomerInteraction coexists with Activities, the harder the migration becomes.
