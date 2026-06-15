# Activity Model Architecture — Open Mercato
# (Design Document, not an implementation spec)

**Date**: 2026-06-15
**Status**: Proposal — Awaiting Decision
**Inspired by**: Dynamics 365 Sales, HubSpot, Salesforce CRM
**Scope**: Architectural analysis and recommendation for a unified Activity model
            covering email, calendar events, tasks, calls, meetings, and notes,
            with Microsoft 365 (Outlook + Calendar) as the first external sync consumer.

---

## 1. Business Goal

A staff member should have a unified **activity timeline** inside Open Mercato that mirrors
what they see in Outlook — without switching context. This includes:

- **Emails** (inbound & outbound, threaded)
- **Calendar events** (meetings, appointments)
- **Tasks** (to-dos with due dates and owners)
- **Calls** (logged, with outcome)
- **Notes** (free-text observations attached to a record)
- **Future activities** (demos, on-site visits, etc.)

All activities must be linkable to any business object: Customer, Contact, Deal, Order, Lead, etc.

---

## 2. What Already Exists in Open Mercato

### 2.1 `CustomerInteraction` (customers module) — CLOSEST MATCH

The most Activity-like entity already in OM:

```
CustomerInteraction
├── interactionType: 'email' | 'call' | 'meeting' | 'task'
├── title, body
├── status: 'planned' | ... (mutable state)
├── scheduledAt, occurredAt
├── durationMinutes, location, allDay
├── recurrenceRule, recurrenceEnd
├── reminderMinutes
├── priority
├── authorUserId, ownerUserId
├── participants[]: { userId, name, email, status }
├── linkedEntities[]: related customer records, orders
├── externalMessageId (→ communication_channels)
└── visibility: 'team' | 'public'
```

**Gap**: Only linked to the `customers` module. Cannot link to orders, deals, products, or arbitrary entities without modifying the core module.

### 2.2 `CustomerActivity` (customers module) — IMMUTABLE AUDIT TRAIL

Simpler, write-once log entry:
- `activityType` (dictionary-driven), `subject`, `body`, `occurredAt`
- `authorUserId`, `appearanceIcon`, `appearanceColor`
- Links: `entityId` (person/company/deal)

**Gap**: Purely historical — no due date, assignment, or status. Cannot represent forward-looking work.

### 2.3 `ExternalConversation` + `ExternalMessage` (communication_channels) — EMAIL THREADING

Already handles inbound/outbound email from external channels (Gmail, IMAP).
- Emails arrive as `ExternalMessage` objects in `ExternalConversation` threads
- `ExternalConversation.contactPersonId` links to a customer person

**Gap**: Not surfaced in a unified Activity timeline. No calendar or task concept. Read-only from the "activity" perspective.

### 2.4 `WorkflowUserTask` (workflows module) — STRUCTURED TASKS

Process-step tasks with due date + assignment + state machine. NOT suitable as a general-purpose
activity because they are tightly coupled to workflow execution — you can't create a standalone task.

### 2.5 `AuditLog / ActionLog` (audit_logs module) — SYSTEM AUDIT

System-level immutable log of every command mutation. Not user-visible activity log.

---

## 3. Architectural Variants

### Variant A — Extend `CustomerInteraction` into a Universal Activity Entity

**Approach**: Modify (or eject) the `customers` module to decouple `CustomerInteraction`
from the customer boundary and allow linking to any entity type.

```
CustomerInteraction (extended)
├── linkedEntityType: string  (was: entityId → CustomerEntity only)
├── linkedEntityId: string
├── linkedEntityType2..N: string[]  (multiple links)
└── ... all existing fields
```

**Pros:**
- Leverages existing entity, events, and UI
- No new migration complexity
- Existing interactions visible immediately

**Cons:**
- Requires ejecting a core module (risky, framework upgrades become harder)
- `CustomerInteraction` name implies customer scope — confuses developers
- Cannot add truly module-specific fields (e.g., `calendarEventId` for calendar activities)
- Tight coupling: calendar sync, O365, and task logic all live inside `customers` module

**Verdict**: ❌ Not recommended for 2-3 year horizon. Short-term shortcut.

---

### Variant B — New `activities` Module as Universal Activity Hub

**Approach**: Create a new `src/modules/activities/` module with an `Activity` entity
that is the single source of truth for all user-facing activities. Other modules
(customers, sales, O365) subscribe to events and inject widgets.

```
Activity (new entity)
├── id: uuid
├── organization_id, tenant_id
├── activityType: ActivityType  (enum + dictionary)
├── subject: string
├── notes: string (optional, ENCRYPTED)
├── status: ActivityStatus
├── priority: 'low' | 'normal' | 'high' | 'urgent'
├── dueAt: Date (optional)
├── completedAt: Date (optional)
├── occurredAt: Date (optional, for historical activities)
├── durationMinutes: number (optional, for calls/meetings)
├── location: string (optional)
├── allDay: boolean
├── authorUserId: string (FK → staff)
├── ownerUserId: string (FK → staff)
├── participants[]: ActivityParticipant (embedded)
│
├── linkedEntityType: string (primary linked record — polymorphic)
├── linkedEntityId: string
│
├── externalId: string (optional — O365 event ID, Gmail message ID, etc.)
├── externalProvider: string (optional — 'office365', 'gmail', 'google_calendar')
├── syncDirection: 'inbound' | 'outbound' | 'bidirectional' | null
├── lastSyncedAt: Date (optional)
│
├── is_active: boolean
├── deleted_at: Date (optional)
├── created_at, updated_at: Date
└── custom fields via ce.ts
```

```
ActivityLink (separate entity for multiple cross-module links)
├── id: uuid
├── activity_id: string (FK → Activity)
├── entity_type: string
├── entity_id: string
├── link_role: string (optional — 'primary' | 'related' | 'attendee')
├── organization_id, tenant_id
└── created_at: Date
```

**Pros:**
- Clean module boundary — activities is a standalone domain concept
- Any module can link activities to its entities without coupling
- Single timeline API for the UI to consume
- Calendar events, emails, tasks, calls all queryable in one place
- Custom fields, RBAC, search, events all work out of the box
- O365 integration, Google Calendar, etc. are external sync providers — not part of this module
- `CustomerInteraction` can migrate to this model progressively (emit events → subscribers bridge)

**Cons:**
- New migration needed (new tables)
- `CustomerInteraction` duplication during migration window
- More upfront work than Variant A

**Verdict**: ✅ **Recommended** for 2-3 year horizon.

---

### Variant C — Extend `planner` Module into a Scheduling + Activity Hub

**Approach**: Planner currently handles availability rules. Extend it to cover scheduled activities (meetings, tasks) as well.

**Pros:**
- Planner already has recurrence + scheduling concepts

**Cons:**
- Planner is narrowly focused on availability/resource scheduling — conceptually wrong fit
- Would require ejecting a core module
- Tasks and emails don't fit a scheduling mental model

**Verdict**: ❌ Not recommended. Wrong conceptual boundary.

---

### Variant D — Hybrid: `activities` Module + Retain `CustomerInteraction`

**Approach**: Create the new `activities` module, but keep `CustomerInteraction` in place.
New activities created via the `activities` module. Old `CustomerInteraction` records show
up in the timeline via a response enricher bridge.

**Pros:**
- No data migration needed for existing interactions
- Gradual transition

**Cons:**
- Two parallel concepts confuse developers for years
- Enricher bridge is fragile
- Search/filtering must span two tables

**Verdict**: ⚠️ Acceptable short-term bridge, but plan to deprecate `CustomerInteraction` within 6 months.

---

## 4. Recommended Architecture

**Decision: Variant B** — New `activities` module as the universal activity hub.

```
┌─────────────────────────────────────────────────────────────────┐
│                     ACTIVITIES MODULE                            │
│                                                                  │
│  Activity entity (universal)                                     │
│  ├── activityType: Task | Email | Call | Meeting | Note | ...    │
│  ├── status: NotStarted | InProgress | Completed | Cancelled     │
│  ├── dueAt / completedAt / occurredAt                            │
│  ├── ownerUserId, authorUserId, participants[]                   │
│  ├── linkedEntityType + linkedEntityId (primary link)            │
│  ├── ActivityLink[] (secondary/multiple links)                   │
│  ├── externalId + externalProvider (for sync)                    │
│  └── Custom Fields (ce.ts)                                       │
│                                                                  │
│  Events emitted:                                                 │
│  - activities.activity.created                                   │
│  - activities.activity.completed                                 │
│  - activities.activity.assigned                                  │
│  - activities.activity.synced (after O365/Google sync)           │
└─────────────────────────────────────────────────────────────────┘
         ▲                    ▲                    ▲
         │ FK ID              │ FK ID              │ FK ID
         │                    │                    │
┌────────┴──────┐   ┌────────┴───────┐   ┌────────┴────────┐
│   customers   │   │     sales      │   │    (any module) │
│               │   │                │   │                 │
│ Widget injects│   │ Widget injects │   │ Widget injects  │
│ Activity      │   │ Activity       │   │ Activity        │
│ timeline into │   │ timeline into  │   │ timeline into   │
│ customer page │   │ order page     │   │ any entity page │
└───────────────┘   └────────────────┘   └─────────────────┘

         ▼ subscribers listen to activities.activity.created
┌──────────────────────────────────────────────────────────────┐
│                  EXTERNAL SYNC LAYER                          │
│                                                              │
│  channel-office365 (new)        channel-gmail (existing)     │
│  ├── Email ←→ Activity(Email)   ├── Email ←→ ExternalMessage │
│  └── Calendar ←→ Activity(Meeting)                           │
│                                                              │
│  Sync direction:                                             │
│  - O365 event created → activities.activity.create(Meeting) │
│  - OM Activity(Meeting) created → POST /me/events (O365)     │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. Entity Diagram

```
┌──────────────────────────────────────────────────┐
│                   Activity                        │
├──────────────────────────────────────────────────┤
│ id            UUID PK                             │
│ organization_id  UUID FK                          │
│ tenant_id     UUID FK                             │
│                                                   │
│ activity_type  ActivityType (enum/dict)           │
│   Task | Email | Call | Meeting | Note | Custom   │
│                                                   │
│ subject        VARCHAR(500) NOT NULL              │
│ notes          TEXT ENCRYPTED (optional)          │
│                                                   │
│ status         ActivityStatus                     │
│   not_started | in_progress | completed |         │
│   cancelled | deferred                            │
│ priority       low | normal | high | urgent       │
│                                                   │
│ due_at         TIMESTAMPTZ (optional)             │
│ completed_at   TIMESTAMPTZ (optional)             │
│ occurred_at    TIMESTAMPTZ (optional)             │
│ duration_min   INT (optional)                     │
│ location       VARCHAR(500) ENCRYPTED (optional)  │
│ all_day        BOOLEAN (default false)            │
│                                                   │
│ author_user_id  UUID FK → staff                   │
│ owner_user_id   UUID FK → staff                   │
│ participants    JSONB ([]{ userId, name, email })  │
│                                                   │
│ linked_entity_type  VARCHAR (optional)            │
│ linked_entity_id    UUID (optional)               │
│                                                   │
│ external_id       VARCHAR (optional)              │
│ external_provider VARCHAR (optional)              │
│ sync_direction    VARCHAR (optional)              │
│ last_synced_at    TIMESTAMPTZ (optional)          │
│                                                   │
│ is_active    BOOLEAN DEFAULT TRUE                 │
│ deleted_at   TIMESTAMPTZ (soft delete)            │
│ created_at   TIMESTAMPTZ                          │
│ updated_at   TIMESTAMPTZ                          │
├──────────────────────────────────────────────────┤
│ Indexes:                                          │
│ - (organization_id, tenant_id, owner_user_id)     │
│ - (organization_id, tenant_id, linked_entity_type,│
│    linked_entity_id)                              │
│ - (organization_id, tenant_id, activity_type,     │
│    status)                                        │
│ - (external_id, external_provider) UNIQUE WHERE  │
│    external_id IS NOT NULL                        │
└──────────────────────────────────────────────────┘
                        │
                   1 : N │
                        ▼
┌──────────────────────────────────────────────────┐
│                 ActivityLink                      │
├──────────────────────────────────────────────────┤
│ id              UUID PK                           │
│ activity_id     UUID FK → Activity               │
│ entity_type     VARCHAR (e.g. 'customers:person') │
│ entity_id       UUID                              │
│ link_role       VARCHAR (primary|related|cc)      │
│ organization_id, tenant_id                        │
│ created_at      TIMESTAMPTZ                       │
└──────────────────────────────────────────────────┘

┌─────────────────────────────┐
│  ActivityType (values)      │
├─────────────────────────────┤
│  TASK       (to-do item)    │
│  EMAIL      (email thread)  │
│  CALL       (phone call)    │
│  MEETING    (calendar event)│
│  NOTE       (free text)     │
│  CUSTOM     (user-defined)  │
└─────────────────────────────┘

┌──────────────────────────────────────────────────┐
│  ActivityStatus (state machine)                   │
├──────────────────────────────────────────────────┤
│  not_started → in_progress → completed           │
│             ↘                                    │
│              cancelled                            │
│              deferred (for tasks with new dueAt) │
└──────────────────────────────────────────────────┘
```

---

## 6. Data Flow Diagram

### 6a. Email Activity (O365 → OM)

```
  Outlook (user sends email)
        │
        ▼
  Microsoft Graph API
  GET /me/mailFolders/Inbox/messages
        │
        ▼
  channel-office365 adapter
  (O365MailChannelAdapter.fetchHistory)
        │
        ▼ normalize to NormalizedInboundMessage
  communication_channels hub
  ExternalMessage + ExternalConversation created
        │
        ▼ event: communication_channels.message.received
  activities module subscriber
  creates Activity { type: EMAIL, externalId: graphMessageId,
                     externalProvider: 'office365',
                     linkedEntityType: auto-resolved from contact }
        │
        ▼
  Customer Timeline UI (widget injection)
  shows Activity in customer's timeline
```

### 6b. Meeting Activity (OM → O365)

```
  Staff creates Activity { type: MEETING, dueAt: '2026-06-20', ... }
  in OM (manual or via workflow)
        │
        ▼ event: activities.activity.created (type=MEETING)
  channel-office365 subscriber
  POST /me/events to Microsoft Graph
        │
        ▼ Graph returns { id: 'AAMkADxxxx' }
  subscriber updates Activity.externalId = 'AAMkADxxxx'
               Activity.lastSyncedAt = now
        │
        ▼
  Event appears in Outlook calendar
```

### 6c. Calendar Sync (O365 → OM)

```
  Background worker (every 5 min per connected user)
        │
        ▼
  GET /me/calendarView?startDateTime=...&endDateTime=...
  + $deltaToken cursor (Graph Calendar Delta API)
        │
        ▼ normalize Graph Event → Activity fields
  Upsert Activity WHERE external_id = graphEventId
  (dedup by external_id + external_provider)
        │
        ▼ event: activities.activity.synced
  Real-time UI update (DOM Event Bridge, clientBroadcast: true)
```

### 6d. Task Activity (OM-native)

```
  Staff creates Task in OM (backend/activities/tasks page)
        │
        ▼
  Activity { type: TASK, status: not_started, dueAt: ..., ownerUserId: ... }
        │
        ▼ event: activities.activity.created
  notification module subscriber
  sends reminder notification before dueAt
        │
        ▼ (opt-in, if user has O365 connected)
  channel-office365 subscriber
  POST /me/tasks (MS To-Do API) or POST /me/events as all-day event
```

---

## 7. Comparison: Variants Summary

| Criterion | Variant A (extend CustomerInteraction) | Variant B (new activities module) | Variant C (extend planner) |
|-----------|----------------------------------------|-----------------------------------|---------------------------|
| Time to implement | ~1 week | ~3 weeks | ~2 weeks |
| Breaking change risk | High (eject core module) | None | High (eject core) |
| Customer module coupling | Permanent | None (widget injection) | N/A |
| Multi-entity linking | Hacky | Native (ActivityLink) | No |
| O365 calendar sync fit | Awkward | Natural | Possible |
| Email activity fit | Workable | Natural | No |
| Custom fields support | Via ce.ts (already there) | Via ce.ts (new) | Partial |
| Framework upgrade impact | High | None | High |
| 2-year maintainability | Low | High | Low |
| Recommended | ❌ | ✅ | ❌ |

---

## 8. Reuse from Existing OM Architecture

| Mechanism | How it's reused |
|-----------|----------------|
| `communication_channels` hub | Handles email inbound/outbound; activities module subscribes to `message.received` events |
| `ExternalConversation.contactPersonId` | Already links email threads to customer persons |
| `CustomerInteraction` events | `activities` module subscribes; creates Activity records as mirror (bridge pattern) |
| Widget injection | Activity timeline widget injected into customer, order, deal pages |
| `withAtomicFlush` | Used for all multi-phase activity mutations |
| `makeCrudRoute` | Activity CRUD API |
| `findWithDecryption` | `notes` + `location` fields (PII potential) |
| `createModuleEvents` | `activities.activity.*` events for downstream subscribers |
| Search module | Full-text over `subject` + `notes` |
| Response enrichers | Sales module enriches activity list with order summary |

---

## 9. Microsoft 365 Integration — Position in This Architecture

With the `activities` module as the foundation, the O365 integration becomes:

**Email side** (unchanged architecture):
- `channel-office365` lives in `packages/channel-office365/`
- Implements `ChannelAdapter` (same as channel-gmail)
- Emails become `ExternalMessage` objects via the `communication_channels` hub
- The `activities` module subscribes to `communication_channels.message.received` and creates `Activity { type: EMAIL }` records pointing to the `ExternalMessage`

**Calendar side** (new):
- `channel-office365` adds a `CalendarSyncWorker` alongside the email adapter
- Graph Calendar Delta API polling → upsert `Activity { type: MEETING, externalProvider: 'office365' }`
- When OM creates `Activity { type: MEETING }`, a subscriber calls `POST /me/events` on Graph
- Conflict resolution: last-write-wins with `lastSyncedAt` timestamp comparison

**Tasks side** (optional Phase E):
- MS To-Do API or Outlook tasks (Graph `/me/tasks`)
- Same pattern: Graph polling → Activity { type: TASK }
- OM task creation → Graph sync (opt-in per user)

---

## 10. Migration Plan (CustomerInteraction Bridge)

During the transition window (weeks 1–12):

1. New activities create `Activity` records in the new module
2. Old `CustomerInteraction` records appear in the activity timeline via a **response enricher** (bridge) that fetches and maps them into the `Activity` response shape
3. After 6 months: run a one-time migration script to import `CustomerInteraction` records into `Activity` table with `externalProvider: 'legacy_interaction'`
4. After migration: deprecate `CustomerInteraction` create/update endpoints; serve reads from `Activity` table

---

## 11. Recommended Implementation Sequence

```
Sprint 1-2:  activities module scaffold (entities, CRUD, events, RBAC)
Sprint 3:    Activity timeline widget (customer page, sales order page)
Sprint 4:    channel-office365 — OAuth2 + email (ChannelAdapter)
Sprint 5:    channel-office365 — Calendar sync (CalendarSyncWorker)
Sprint 6:    Tasks sync (O365 To-Do ↔ Activity)
Sprint 7:    CustomerInteraction bridge + search indexing
Sprint 8+:   Google Calendar adapter (reuses same activities module)
```

---

## 12. Open Questions (Resolved by This Document)

| Q | Original question | Answer |
|---|-------------------|--------|
| Q1 | Where do calendar events go in OM? | New `activities` module, `Activity { type: MEETING }` |
| Q2 | What triggers OM → O365 calendar write? | Event subscriber on `activities.activity.created (type=MEETING)` + manual "sync to O365" action |
| Q3 | Polling vs webhooks? | Polling for MVP (sprint 4-5); Graph change notifications opt-in (sprint 6+) |
| Q4 | Shared token for mail + calendar? | Yes — single OAuth token per user, stored on `CommunicationChannel.credentials` (encrypted) |
| Q5 | Azure App Registration? | User configures client ID + secret as tenant-level `IntegrationCredentials` (same as Gmail OAuth client config) |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-06-15 | Initial architectural document |
