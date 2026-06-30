# Microsoft 365 integration (mail + calendar + attachments)

> 🇵🇱 Polish version: [o365-mail-calendar-integration.pl.md](o365-mail-calendar-integration.pl.md)

Branch (portable bundle): `integration/o365` · Modules: `channel_office365`, `mail_attachments`
(+ activity-analytics changes in the `activities` module).

---

## 1. Business description (for end users)

Connect a Microsoft 365 (Outlook/Exchange) mailbox and calendar to Open Mercato so that
customer communication and meetings live next to your CRM records — no copy-paste, no
switching tabs.

**What you get:**

- **Connect Microsoft 365** in *Settings → Integrations → Microsoft 365* (one-time OAuth sign-in).
  Per-user mailboxes; the connection can belong to one organization and sync there.
- **E-mail sync** — incoming and sent mail is pulled in and shown on the contact's **"E-maile"**
  tab as conversation threads, and logged to **Activities**. Inbound replies surface automatically.
- **Calendar sync** — Microsoft 365 calendar events are synced into Activities; meetings scheduled
  from a record sync back to Outlook.
- **Compose & reply with attachments** — from the contact's **"E-maile"** tab, write a new email or
  reply directly in Open Mercato. Attach files from your disk **and/or** "Załącz z OM" (the contact's
  existing email attachments and Files-tab files). Sent mail goes out through your real mailbox and is
  re-synced back into the CRM.
- **"Załączniki e-mail"** tab — every attachment from the contact's synced mail in one place, with
  download and a delete action (removes the CRM copy; the email itself keeps the file).
- **Activity statistics** (*Activities → Statystyki aktywności*) — a "Mine/Team" cockpit: total
  activities, task completion, overdue tasks, deal coverage, weekly trend, team leaderboard, and
  "deals needing attention" (open deals with no contact for 14+ days or never). Every metric has an
  inline tooltip explaining it. Useful for both salespeople (personal view) and management (team view).

**Privacy:** sensitive data (contact details, deal titles, etc.) is encrypted at rest via the
framework's tenant-encryption. Attachment de-duplication avoids storing the same sent file twice.

---

## 2. Architecture (one paragraph)

App-only approach — **zero changes to the framework core**, refs travel to our Graph adapter through
free-form `channelMetadata`. `mail_attachments` is a provider-agnostic module (upload + a resolver
that turns durable attachment references into bytes); `channel_office365` is the Microsoft 365 adapter
(Graph transport, compose route, sync, UI widgets). The emails tab + compose dialog are injected via
the customers person-detail injection spots (the built-in emails tab is hidden, ours replaces it),
because the core compose dialog has no attachment support and exposes no override handle.

**Depends on these (built-in) modules:** `customers`, `communication_channels`, `activities`,
`attachments`, `directory`, `auth`. The `activities` stats page reads `customer_deals` (decrypted).

---

## 3. Porting to another environment

### 3.1 Files / modules to copy
- `src/modules/channel_office365/**`
- `src/modules/mail_attachments/**`
- The activity-analytics changes in `src/modules/activities/` (stats API + page + i18n) if you want the
  cockpit there too.
- Register in `src/modules.ts` (order: `mail_attachments` before `activities`):
  ```ts
  { id: 'mail_attachments', from: '@app' },
  { id: 'activities', from: '@app' },
  { id: 'channel_office365', from: '@app' },
  ```
- Run `yarn generate` after copying.

### 3.2 Azure app registration (required — done once per Azure tenant)
Register an app in Azure AD (Entra) with:
- **Redirect URI** (Web): `https://<your-domain>/api/communication_channels/oauth/office365/callback`
- **API permissions** (delegated): `Calendars.ReadWrite`, `Mail.ReadWrite`, `User.Read`, `offline_access`
- A **client secret** (note its expiry — when it expires, channels flip to "requires reauth").

### 3.3 In-app configuration (NOT env vars)
Microsoft 365 **Client ID** and **Client Secret** are configured in the app UI:
*Settings → Integrations → Microsoft 365*. They are stored per-tenant (encrypted), not in env.
Each end user then connects their own mailbox via OAuth from the same screen.

### 3.4 Environment variables
| Variable | Purpose | Default | Required |
|---|---|---|---|
| `TENANT_DATA_ENCRYPTION_FALLBACK_KEY` (or a configured Vault/KMS) | Tenant data-encryption key. Contact data, deal titles, attachment metadata are encrypted at rest; **without the same key, encrypted data cannot be read after a move**. | derived (dev warning) | **Yes (prod)** |
| `MAIL_ATTACHMENTS_MAX_FILES` | Max attachments per outgoing email. | `10` | No |
| `MAIL_ATTACHMENTS_MAX_FILE_MB` | Max size of a single attachment (MB). | `25` | No |
| `MAIL_ATTACHMENTS_MAX_TOTAL_MB` | Max combined attachment size per email (MB). | `25` | No |
| `DATABASE_URL` | Postgres connection (framework-level). | — | Yes |
| `OM_DEV_AUTO_MIGRATE` | Dev auto-applies migrations on `yarn dev`. | `1` (dev) | No |

> Graph attachment transport switches automatically: ≤3 MB inline, >3 MB via an upload session.

### 3.5 Setup steps (target environment)
1. Copy modules + register in `src/modules.ts`; `yarn generate`.
2. `yarn db:migrate` (creates `channel_office365` + `mail_attachments` tables/partitions).
3. `yarn mercato auth sync-role-acls` — grants the new features to default roles:
   `customers.email.compose`, `mail_attachments.upload`, `activities.view`.
4. `yarn mercato entities seed-encryption --tenant <id>` if you add/extend encryption maps.
5. Configure Azure Client ID/Secret in *Settings → Integrations → Microsoft 365*, then connect a mailbox.
6. Schedule/enable the channel poll (the `communication-channels-poll-tick` schedule drives mail/calendar sync).

### 3.6 Operational caveats
- **After changing an event subscriber** (e.g. `link-sent-attachments`), run `yarn dev:reset` — the
  queue worker loads the bundled subscriber and a plain restart may not reload it.
- **Workers are lazy** — they start on the first job; the `events`, `communication-channels-outbound`,
  and `communication-channels-poll*` queues must be running for sync + attachment linking.
- **Sent attachments appear after the next "Sent Items" sync** (seconds–minutes), by design — our own
  upload copy is deleted on send and the canonical copy comes from sync (idempotent on
  `(channel, external_message_id)`, so deleting an attachment does not resurrect it).
- The unused TTL sweep for never-sent uploads: `yarn mercato mail-attachments cleanup-uploads`.

### 3.7 Known gaps / recommendations
- The recurring **"channel requires reauth" toast** + its raw-key text are **core** (`communication_channels`)
  behaviours, not this bundle: the toast re-fires until the notification is *dismissed* (not just read),
  shows the i18n key instead of the title, and there is no `channel.reconnected` event to auto-clear it.
  Candidate for an upstream fix.
- The emails-tab fork hides the built-in emails tab via a CSS selector
  (`[role="tablist"] [role="tab"]:has(svg.lucide-mail)`). If a framework upgrade changes that tab's
  icon, the built-in tab reappears (graceful, not a crash) — re-check on upgrade.
- Compose is O365-only ("Send as" lists Microsoft 365 channels); attachment refs only flow through the
  O365 Graph adapter. The resolver is provider-agnostic, so adding Gmail later is a new source, not a
  rewrite.
