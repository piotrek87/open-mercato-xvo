# OpenMercato CRM — my-app

B2B CRM application built on the [OpenMercato](https://open-mercato.dev) framework. Tracks customer interactions, syncs calendar and email from Microsoft 365, and surfaces communication history on customer and deal records.

## What's included

| Module | Sprints | Description |
|---|---|---|
| **Activities** | 1–5 | Unified interaction journal — meetings, emails, calls, notes, tasks. Cursor pagination, optimistic UI, widget injection into customer/deal detail pages. |
| **Microsoft 365 integration** | 4–5 | Per-user OAuth2. Graph Calendar + Mail Delta sync (Inbox + SentItems). Auto-linking to CRM contacts. Week-strip calendar UI. |
| Standard modules | — | Customers, Sales, Catalog, Auth, Integrations (OpenMercato classic mode) |

## Tech stack

| Layer | Technology |
|---|---|
| Framework | OpenMercato (`@open-mercato/*`) |
| Frontend | Next.js 14 App Router, TypeScript, Tailwind CSS |
| Backend | Next.js API Routes, MikroORM v7, PostgreSQL |
| DI | Awilix |
| Validation | Zod |
| Queue | BullMQ (Redis) in production · local filesystem in dev |
| Auth | JWT + session cookies |

## Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Redis (optional in dev, required in production for background workers)
- Microsoft Azure AD app registration (for M365 integration)

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/piotrek87/open-mercato-xvo.git
cd open-mercato-xvo
yarn install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — set DATABASE_URL, JWT_SECRET, AUTH_SECRET at minimum
```

### 3. Initialize database

```bash
yarn db:migrate      # apply all migrations
yarn initialize      # bootstrap DB schema + create first admin account
```

### 4. Start development server

```bash
yarn dev
```

App runs at `http://localhost:3000`. Admin panel at `http://localhost:3000/backend`.

## Microsoft 365 Integration

### Azure AD app registration

1. Open [Azure Portal → App registrations](https://portal.azure.com/#blade/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/RegisteredApps)
2. Create or select your app registration
3. Under **Authentication → Redirect URIs** add:
   ```
   https://yourdomain.com/api/communication_channels/oauth/office365/callback
   http://localhost:3000/api/communication_channels/oauth/office365/callback
   ```
4. Under **API permissions** grant (delegated):
   - `Calendars.ReadWrite`
   - `Mail.ReadWrite`
   - `offline_access`
   - `User.Read`
5. Set in `.env`:
   ```env
   O365_CLIENT_ID=<your-application-client-id>
   O365_CLIENT_SECRET=<your-client-secret-value>
   O365_TENANT_ID=<your-azure-tenant-id>    # single-tenant apps only
   ```

### Connecting a user account

1. Log in as a staff member
2. Go to **Settings → Integrations → Microsoft 365**
3. Click **Connect** and complete the OAuth2 flow
4. Enable **Calendar Sync** and/or **Email Sync** in the capability toggles

Calendar sync runs every 5 minutes. Email sync runs every 15 minutes. Both can be triggered manually via "Sync now".

## Docker

```bash
docker-compose up          # PostgreSQL + Redis only (run app locally with yarn dev)
```

Full containerized setup:

```bash
docker-compose -f docker-compose.fullapp.yml up
```

## Key environment variables

See `.env.example` for the full list.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | JWT signing secret |
| `AUTH_SECRET` | Yes | Session/cookie signing secret |
| `APP_URL` | Yes | Public URL — used in OAuth redirects and email links |
| `REDIS_URL` | Production | Redis for queue workers (BullMQ) |
| `O365_CLIENT_ID` | M365 only | Azure AD application client ID |
| `O365_CLIENT_SECRET` | M365 only | Azure AD client secret |
| `O365_TENANT_ID` | M365 only | Azure AD tenant ID (single-tenant apps) |

## Branch structure

| Branch | Contents |
|---|---|
| `main` | Stable releases |
| `feat/activities-sprint4a` | Current development — Sprints 1–5 complete |

## Running background workers

Workers process queue jobs for calendar and email sync.

```bash
# Calendar sync worker
yarn mercato channel_office365 worker channel-office365-calendar-sync --concurrency=3

# Email sync worker
yarn mercato channel_office365 worker channel-office365-mail-sync --concurrency=3
```

In development (`QUEUE_STRATEGY=local`), workers process automatically via the local filesystem queue.

## Running tests

```bash
yarn jest                 # unit tests (119 passing)
yarn playwright test      # E2E tests
```

## Regenerating framework files

After any structural change (new module, new entity, new API route):

```bash
yarn generate             # regenerates .mercato/generated/
yarn db:generate          # probe schema diff + create migration SQL
```
