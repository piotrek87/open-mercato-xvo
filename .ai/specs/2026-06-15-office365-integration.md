# SPEC-O365-001: Office 365 Integration (Email + Calendar)

**Date**: 2026-06-15
**Status**: Draft — Awaiting Open Questions

## TLDR

**Key Points:**
- Build a `channel_office365` integration package that connects each staff member's Microsoft 365 account to Open Mercato via per-user OAuth2 (Microsoft Identity Platform).
- **Email** (bidirectional): inbound mail via Microsoft Graph `GET /me/mailFolders/Inbox/messages` + polling or Graph change notifications; outbound via `POST /me/sendMail`.
- **Calendar** (bidirectional): read events from `GET /me/events`, create/update OM-originated events via `POST /me/events`.
- Single OAuth2 access token per user covers both Mail and Calendar scopes — shared credential store.
- Pattern: mirrors `@open-mercato/channel-gmail` (`ChannelAdapter` for email) + a custom calendar sync layer.

**Scope:**
- OAuth2 per-user connect/disconnect flow (Azure App Registration with delegated permissions)
- Inbound email — periodic polling or Graph change notifications (webhooks)
- Outbound email — send via Graph API on behalf of the connected user
- Calendar read — import events from user's primary calendar into OM
- Calendar write — create/update OM-originated records as calendar events in O365
- Token refresh (sliding expiry, refresh_token persistence, re-auth prompt on expiry)
- Health check and integration detail UI

**Out of scope (MVP):**
- Shared mailboxes / room calendars
- Calendar attendee RSVP handling
- Teams meetings (separate integration)
- Contacts sync

## Open Questions *(remove before finalizing)*

- **Q1 — Calendar entity mapping**: What OM entity does an O365 calendar event map **to** on the OM side?
  - **A**: `planner` module task/event — calendar events become planner entries
  - **B**: New `CalendarEvent` entity in this module — standalone calendar record
  - **C**: `scheduler` module appointment
  - **D**: It's linked to a specific business object (e.g. sales order, customer meeting) — user picks the entity at sync time
  - _This is the biggest architectural blocker — it determines the entire data model._

- **Q2 — Calendar write trigger**: What causes an OM record to be pushed **to** O365 as a calendar event?
  - **A**: Manual — user clicks "Add to calendar" on a specific record in OM
  - **B**: Automatic — when a task/appointment of a certain type is created in OM
  - **C**: Configurable rule per entity type

- **Q3 — Inbound sync method**: Polling vs. Graph change notifications (webhooks)?
  - **A**: Polling only (simpler, no public webhook URL required) — same model as channel-imap
  - **B**: Graph change notifications (near-realtime, requires a publicly reachable endpoint + subscription renewal every 3 days for mail / 30 min for calendar)
  - **C**: Polling as default, change notifications as opt-in
  - _Affects infrastructure requirements (public URL in dev) and complexity significantly._

- **Q4 — Token credential storage**: The same OAuth token covers both mail and calendar scopes. Should email and calendar share one `CommunicationChannel` record, or use separate records with a shared token?
  - **A**: Single channel record per user, calendar is a second capability on the same channel
  - **B**: Two separate channel records (one for mail, one for calendar) backed by a shared integration credential

- **Q5 — Azure App Registration**: Does the team already have an Azure App Registration (client ID + client secret), or is the spec expected to cover the setup instructions?

---

## Overview

Office 365 is the dominant business email + calendar platform. Staff members lose context switching between Outlook and OM. This integration surfaces O365 mail threads and calendar events directly within OM — and writes OM-originated appointments back to Outlook, creating a single pane of glass for customer-facing work.

> **Market Reference**: HubSpot and Salesforce both implement per-user O365 OAuth2 with Microsoft Graph API v1.0. Both use polling for mail ingest (5–10 min interval) and a combination of webhooks + polling for calendar. Neither back-fills historical mail on first connect. We adopt the same philosophy: connect → seed cursor → ingest from that point forward.

## Problem Statement

- Staff members manage customer emails in Outlook and tasks/orders in OM — no unified thread view.
- Meetings booked in OM don't appear in Outlook; meetings booked in Outlook aren't visible in OM.
- There's no audit trail of O365 communication attached to OM customer/order records.

## Proposed Solution

Build `packages/channel-office365/` as a new npm workspace package following the `ChannelAdapter` contract for email (same as `channel-gmail`) plus a dedicated **calendar sync layer** (architecture depends on Q1 answer).

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| Use Microsoft Graph API v1.0 (not beta) | Stable surface, supported long-term |
| `@microsoft/microsoft-graph-client` SDK | Official SDK; handles token injection and retries |
| Per-user OAuth2 (delegated permissions) | Each user connects their own account; no admin consent for shared mailbox needed |
| Single OAuth token covers mail + calendar | MS Graph scopes are additive on the same token — no second auth flow |
| No back-fill on first connect | Matches gmail pattern; avoids quota exhaustion on large inboxes |
| Encryption maps for tokens | `accessToken`, `refreshToken` are PII-adjacent secrets — MUST use `defaultEncryptionMaps` |

## User Stories

- **Staff member** wants to **connect their O365 account** so that incoming Outlook emails appear in OM without copy-pasting.
- **Staff member** wants to **reply to a customer email from OM** so that the reply is sent from their Outlook address.
- **Staff member** wants to **see their O365 calendar events in OM** so they can plan customer interactions without leaving the app.
- **Staff member** wants to **create a meeting in OM** so it automatically appears in their Outlook calendar.
- **Admin** wants to **configure the Azure App Registration credentials once** so all staff can connect their own accounts.

## Data Models

### O365UserCredential (per-user OAuth token — stored encrypted)

_Stored on `CommunicationChannel.credentials` (per channel-gmail pattern)_

- `accessToken`: string — **ENCRYPTED** (OAuth access token)
- `refreshToken`: string — **ENCRYPTED** (long-lived refresh token)
- `expiresAt`: string (ISO 8601)
- `scopes`: string[] (granted scopes)
- `email`: string (UPN / mail address from Graph `/me`)
- `userId`: string (Graph object ID — stable identifier)

### O365TenantCredential (admin-configured app registration — stored encrypted)

_Stored on `IntegrationCredentials` (tenant-level, same as channel-gmail `clientId` / `clientSecret`)_

- `clientId`: string — Azure App Client ID
- `clientSecret`: string — **ENCRYPTED**
- `tenantId`: string — Azure AD Tenant ID (or `common` for multi-tenant)
- `scopes`: string (optional override; defaults cover Mail.ReadWrite + Calendars.ReadWrite)

### CalendarEvent — **TBD pending Q1**

_Model depends entirely on Q1 answer. Placeholder:_

- `id`: UUID
- `organization_id`: string (FK)
- `tenant_id`: string (FK)
- `staff_user_id`: string (FK → staff)
- `o365_event_id`: string (Graph event ID — external identifier for dedup)
- `subject`: string
- `start_at`: Date
- `end_at`: Date
- `location`: string (optional)
- `body_preview`: string (optional)
- `linked_entity_type`: string (optional — e.g. `sales.order`)
- `linked_entity_id`: string (optional)
- `sync_direction`: `'o365_to_om' | 'om_to_o365' | 'both'`
- `last_synced_at`: Date
- `created_at`: Date
- `updated_at`: Date

> **Encryption**: `accessToken`, `refreshToken`, `clientSecret` MUST be declared in `packages/channel-office365/src/modules/channel_office365/encryption.ts` exporting `defaultEncryptionMaps: ModuleEncryptionMap[]`. Reads via `findWithDecryption` / `findOneWithDecryption`.

## API Contracts

### OAuth Flow

- `GET /api/communication_channels/oauth/office365/authorize` — Redirects user to Microsoft identity login
- `GET /api/communication_channels/oauth/office365/callback` — Exchanges code for tokens, persists `O365UserCredential`

### Email (via ChannelAdapter — routes owned by communication_channels hub)

- `POST /me/sendMail` (Graph) — outbound send
- `GET /me/mailFolders/Inbox/messages?$filter=...` (Graph) — inbound polling
- `POST /subscriptions` (Graph) — optional change notification subscription

### Calendar

- `GET /me/events?$filter=start/dateTime ge '{cursor}'` (Graph) — inbound polling
- `POST /me/events` (Graph) — create event from OM
- `PATCH /me/events/{id}` (Graph) — update event from OM
- `DELETE /me/events/{id}` (Graph) — delete/cancel from OM

## Implementation Plan

> **Note**: Phases C–D depend on Q1 (calendar entity mapping) and Q3 (polling vs. webhooks). The outline below assumes polling + new `CalendarEvent` entity.

### Phase A: Foundation — Package scaffold + OAuth2 per-user flow

1. Create `packages/channel-office365/` workspace package with `package.json`, `tsconfig.json`, `src/index.ts`
2. Scaffold `src/modules/channel_office365/`: `index.ts`, `acl.ts`, `setup.ts`, `di.ts`, `integration.ts`
3. Register `integration.ts` with tenant credentials fields (`clientId`, `clientSecret`, `tenantId`, `scopes`)
4. Implement `lib/oauth.ts` — `buildAuthorizeUrl`, `exchangeCode`, `refreshToken`, `fetchUserInfo` against Microsoft Identity endpoints
5. Implement `lib/credentials.ts` — Zod schemas for `O365UserCredential` + `O365TenantCredential`
6. Declare `encryption.ts` with `defaultEncryptionMaps` for `accessToken`, `refreshToken`, `clientSecret`
7. Add widget injection `widgets/injection/connect/` — "Connect your O365 account" button on integration detail page
8. Add `lib/health.ts` — validate connectivity via `GET /me` on Graph
9. Wire into `src/modules.ts`, run `yarn generate`
10. Write unit tests: OAuth URL builder, credential Zod schemas

### Phase B: Email inbound + outbound (ChannelAdapter)

1. Create `lib/graph-client.ts` — thin `@microsoft/microsoft-graph-client` wrapper with token injection + auto-refresh
2. Implement `GmailChannelAdapter` equivalent: `O365MailChannelAdapter implements ChannelAdapter`
   - `sendMessage` — `POST /me/sendMail` (build MIME via nodemailer / mailcomposer)
   - `fetchHistory` — polling `GET /me/mailFolders/Inbox/messages` with `$filter` + `$deltaToken` cursor
   - `buildOAuthAuthorizeUrl`, `exchangeOAuthCode`, `refreshCredentials`
   - `normalizeInbound` — Graph message → `NormalizedInboundMessage`
   - `convertOutbound` — OM message → Graph send payload
   - `resolveContact` — extract sender/recipient email
3. Register adapter in `di.ts` via `registerChannelAdapter`
4. Implement cursor strategy: `$deltaToken` (Graph Mail Delta API) — preferred over historyId polling
5. Handle token expiry + refresh (mirror channel-gmail `requires_reauth` sentinel)
6. Write unit tests: `normalizeInbound`, `convertOutbound`, token refresh, send error handling

### Phase C: Calendar sync — inbound (O365 → OM)

> _Depends on Q1 answer. Steps assume new `CalendarEvent` entity._

1. Add `data/entities.ts` — `CalendarEvent` entity (MikroORM, `@mikro-orm/decorators/legacy`)
2. Add `data/validators.ts` — Zod schema
3. Run `yarn db:generate` → review migration SQL → `yarn db:migrate`
4. Implement `lib/calendar-client.ts` — Graph Calendar API wrapper (`GET /me/events`, `GET /me/calendarView`)
5. Add `workers/calendar-sync.ts` — background worker for inbound polling
   - Cursor: `$deltaToken` from Graph Calendar Delta API
   - Upsert `CalendarEvent` by `o365_event_id` (dedup)
6. Add `api/calendar-events/route.ts` — `GET` list + `GET /:id` with `metadata` + `openApi`
7. Add `backend/calendar/page.tsx` + `page.meta.ts` — calendar event list page (DataTable)
8. Write unit tests: delta cursor parsing, event normalization

### Phase D: Calendar write — outbound (OM → O365)

> _Depends on Q2 answer. Steps assume manual "Add to calendar" action._

1. Add `api/calendar-events/[id]/sync-to-o365/route.ts` — `POST` action endpoint
2. Implement create/update logic: `POST /me/events` + `PATCH /me/events/{o365EventId}`
3. Add `widgets/injection/` widget injected into relevant OM entity detail pages (e.g. planner task, customer record) — "Add to O365 Calendar" button
4. Use `withAtomicFlush` for local state updates; emit `emitCrudSideEffects` after commit
5. Store returned `o365_event_id` on `CalendarEvent` record
6. Add delete/cancel: `DELETE /me/events/{id}` on OM record archive
7. Write unit tests: create/update/delete round-trip, conflict handling

### Phase E: Change notifications (optional, Q3-dependent)

1. Implement Graph subscription creation: `POST /subscriptions` for mail + calendar
2. Add `api/webhooks/office365/route.ts` — validation token + notification handler
3. Add `workers/o365-notification-processor.ts` — async processing worker
4. Add subscription renewal worker (mail subscriptions expire every 3 days, calendar every 30 min)

### Phase F: i18n + Tests + Polish

1. Add `i18n/en.json`, `i18n/pl.json` — all user-facing strings
2. Integration tests: OAuth flow, send email, inbound polling, calendar upsert
3. Add `workers/token-refresh-probe.ts` — proactive token refresh before expiry
4. Documentation widget on integration detail page

## Risks

| Risk | Severity | Mitigation | Residual |
|------|----------|------------|---------|
| Azure App Registration requires admin consent for some scopes (`Mail.ReadWrite` is delegated — no admin consent; `Calendars.ReadWrite` is delegated — no admin consent) | Low | Use only delegated permissions; document required scopes | User must have O365 license |
| Graph `$deltaToken` expires if not used within 5 minutes (mail) / 1 day (calendar) | Medium | Fall back to `GET /me/mailFolders/Inbox/messages?$orderby=receivedDateTime desc` + date cursor; mirror Gmail's 404-fallback pattern | Brief re-poll cost |
| Token refresh race condition (multiple workers refresh simultaneously) | Medium | Use DI-resolved cache (`container.resolve('cache')`) as distributed lock keyed by `tenant:userId:o365:lock` | Small window if cache is unavailable |
| Outbound send from wrong "from" address if user has multiple aliases | Low | Always send as `/me` (Graph resolves to primary UPN); surface email in UI so user can verify | User education |
| Change notification endpoint must be publicly reachable | High (Phase E only) | Phase E is opt-in; Phase A-D polling requires no public URL | Phase E blocked in local dev without tunnel |
| Calendar entity model wrong (Q1 not answered) | High | Spec deliberately defers Phase C-D until Q1 is resolved | 1-2 day delay |

## Changelog

| Date | Change |
|------|--------|
| 2026-06-15 | Initial skeleton spec — open questions Q1–Q5 pending |
