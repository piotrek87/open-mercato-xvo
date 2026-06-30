# Conscious architecture deviations (tech debt) — O365 + companies_pl

Snapshot before the next Open Mercato upgrade. Each item: **why** it exists, **risk**, and **how to
retire it**. These are deliberate trade-offs, not accidents.

> Upgrade watch-list: items 1, 2, 5, 6, 7 are the ones most likely to break on an OM core upgrade.

---

## O365 integration

### 1. Forked emails tab (`O365PersonEmailThreadsTab`)
- **Why:** the core `ComposeEmailDialog` has no attachment support, and the core emails tab / panel /
  dialog expose **no registered component handle and no injection spot** — so there is no
  non-invasive way to swap in our attachment-capable dialog. We re-implemented a lean version of the
  core tab against the same stable APIs.
- **Risk:** behavioural drift from core on upgrade (bug fixes / polling changes in the core tab won't
  reach our fork); maintenance burden.
- **Retire:** upstream — have core register a component-replacement handle for the compose dialog, OR
  add attachment support to the core compose flow (core itself flagged this as the "v2 upgrade path").
  Then delete the fork and use the handle.

### 2. Hiding the built-in emails tab via a CSS `:has()` selector
- **Why:** built-in person-detail tabs are hardcoded in `PersonDetailTabs`; there is no API to hide or
  replace a built-in tab — injection can only *add* tabs. A headless widget injects
  `[role="tablist"] [role="tab"]:has(svg.lucide-mail){display:none}` to hide the built-in one so our
  injected tab is the single entry point.
- **Risk:** brittle — if a core upgrade changes that tab's lucide icon or markup, the selector stops
  matching and the built-in tab reappears (graceful: two tabs, never a crash). CSS injection is also
  outside the design system.
- **Retire:** upstream — a prop/registry to hide or replace built-in person-detail tabs (tab-override
  handle). Then drop the CSS-injector widget.

### 3. Attachment refs carried in `channelMetadata` (free-form)
- **Why:** app-only, zero core changes. Core's send-as-user/compose contract has no typed field for
  outbound attachments, so refs travel in the free-form `channelMetadata.attachments` and are read by
  our Graph adapter.
- **Risk:** untyped contract; only our O365 adapter reads it (a different provider would silently drop
  attachments). If core ever validates/repurposes `channelMetadata`, it breaks.
- **Retire:** upstream — a typed `attachments` field in the send-as-user/compose contract.

### 4. Delete-on-send for outbound uploads (rely on Sent-Items sync)
- **Why:** avoid double-storing each sent attachment (our re-homed upload **+** the copy the
  "Sent Items" Graph sync re-ingests). The `link-sent-attachments` subscriber deletes our pending
  upload on `message.sent` and lets the sync produce the canonical copy.
- **Risk:** if mail sync is OFF or the Sent-Items sync doesn't re-ingest the message, the CRM loses the
  attachment record (the file still lives in the actual sent email). Short visibility gap until the
  next sync.
- **Retire:** upstream — make the Sent-folder dedup reliably recognize our own outbound message (by RFC
  Message-ID) so it does **not** create a duplicate, letting us keep our re-homed copy as canonical;
  or a content-addressed (hash + ref-count) attachment store.

### 5. Double-nested API paths
- **Why:** the route generator prefixes the module id, and route files sit under
  `api/<moduleId>/<resource>/`, producing URLs like `/api/channel_office365/channel_office365/compose`
  and `/api/mail_attachments/mail_attachments/upload`. We matched the existing convention.
- **Risk:** confusing URLs; easy to call the wrong path (we hit a 404 initially). If the generator's
  prefixing behaviour changes on upgrade, the URLs shift.
- **Retire:** place route files directly under `api/<resource>/` so the URL is single
  `/api/<moduleId>/<resource>`, after confirming the canonical convention against the upgraded core.

### 6. Lazy `createRequestContainer()` inside the Graph adapter
- **Why:** the adapter is registered as a plain value (`asValue(new ...)`) with no DI container at
  construction, so `sendMessage` lazily creates a request container to resolve `mailAttachmentResolver`.
- **Risk:** per-send container creation overhead and hidden coupling; if DI/bootstrap changes on
  upgrade, the lazy resolution path is a fragile spot.
- **Retire:** register the adapter via `asFunction`/`asClass` with DI and inject the resolver (or a
  resolver factory) directly.

### 7. Activity stats read `customer_deals` cross-module (raw SQL + decryption)
- **Why:** deal coverage / "deals needing attention" need the deals table; there is no cross-module
  read API, so the stats route runs raw SQL on `customer_deals` and decrypts titles via
  `findWithDecryption`.
- **Risk:** couples the activities stats to the customers schema (table/column names); raw SQL bypasses
  the query engine. A `customer_deals` schema change on upgrade breaks the queries.
- **Retire:** a customers-provided aggregate/read API, a query-engine cross-entity read, or a reporting
  service the stats route consumes.

### 8. Hardcoded `customers:customer_entity` id string in the compose dialog
- **Why:** the client dialog fetches the contact's Files-tab attachments and needs the entity id;
  importing generated entity-id constants into a client component is awkward, so the frozen id is
  inlined.
- **Risk:** low (the id is a frozen contract) but it's a magic string — a rename would break it
  silently.
- **Retire:** expose the id via a shared constant import or pass it from the server context.

---

## companies_pl (NIP lookup)

### 9. No i18n — hardcoded Polish strings
- **Why:** early-stage module; strings (route errors, widget labels, `ce.ts` field labels) are inline
  Polish.
- **Risk:** violates the i18n rule; no English; persisted Polish strings (e.g. address names written to
  the DB) are untranslatable.
- **Retire:** add `i18n/{pl,en}.json` + `useT()`; stop persisting human strings as data.

### 10. PII without a declared encryption map *(deferred by decision)*
- **Why:** NIP/KRS/REGON + fetched addresses are added as plain custom fields / written via core APIs;
  no `encryption.ts` map declared in this module.
- **Risk:** potential GDPR/PII-at-rest gap if the core company profile doesn't already encrypt them.
- **Retire:** confirm core company-profile encryption; if these columns hold PII, declare
  `defaultEncryptionMaps`. *(Intentionally deferred — bigger change.)*

### 11. MF VAT white-list only (name says NIP/KRS/REGON)
- **Why:** only the public MF white-list is queried; KRS/REGON come from whatever it returns.
- **Risk:** misleading scope; KRS/REGON often empty.
- **Retire:** point `OM_COMPANY_LOOKUP_API_URL` at a GUS/KRS aggregator, or add those integrations.

---

## Resolved this cycle (no longer debt)
- companies_pl: **RBAC gate** (`companies_pl.lookup` feature + route `requireFeatures`), **fetch
  timeout** (AbortController), **mock guard** (mock disabled in production), **NIP/REGON checksum +
  KRS format validation** — all fixed; unit-tested.
- O365: dedup (delete-on-send + dialog), user-deletable attachments, fixed API paths, DI `.proxy()`
  fix, dead i18n keys removed.
