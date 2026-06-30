# Polish company lookup (NIP / KRS / REGON)

Branch (portable bundle): `integration/companies-pl` · Module: `companies_pl`

---

## 1. Business description (for end users)

Fill in a Polish company's details automatically from its tax number (NIP) instead of typing them by
hand.

**What you get:**
- On a **company** record (create form and detail page) there's a **NIP / KRS / REGON** panel with a
  **"Pobierz dane po NIP"** button.
- Enter a NIP and the system fetches the official company data from the **Ministry of Finance VAT
  white-list** (Wykaz podatników VAT) and fills in the company name and registry numbers.
- Fetched **addresses** (registered seat) can be saved to the company with one click.
- The numbers are stored as custom fields (**NIP, KRS, REGON**) on the company, and are filterable in
  lists.

**Good to know:** the data source is the Ministry of Finance VAT white-list (public, no API key). KRS
and REGON are populated only with whatever the white-list returns for that NIP.

---

## 2. Architecture (one paragraph)

A single API route (`GET /api/companies_pl/company-lookup?nip=…`) proxies the Ministry of Finance VAT
white-list and normalizes the response. The UI is delivered purely via **widget injection** into the
core `customers` company detail/create surfaces (no direct cross-module ORM coupling). Custom fields
(`nip`, `krs`, `regon`) are added to the core `customers:customer_company_profile` entity via `ce.ts`.
A pure helper parses the white-list's free-text address into structured fields.

**Depends on these (built-in) modules:** `customers` (company profile + addresses APIs), `entities`
(custom fields).

---

## 3. Porting to another environment

### 3.1 Files / modules to copy
- `src/modules/companies_pl/**`
- Register in `src/modules.ts`: `{ id: 'companies_pl', from: '@app' }`
- Run `yarn generate`, then `yarn db:generate` / `yarn mercato entities install` so the `nip`/`krs`/`regon`
  custom fields are provisioned on existing tenants.

### 3.2 Environment variables
The module works **out of the box with zero config** (it calls the public Ministry of Finance API).
Both vars are optional escape hatches:

| Variable | Purpose | Default | Required |
|---|---|---|---|
| `OM_COMPANY_LOOKUP_API_URL` | Override the lookup endpoint with your own proxy (e.g. a GUS/KRS aggregator). When set, it fully replaces the MF white-list call; the NIP is appended as `?nip=`/`&nip=`. Expected JSON: `{ nip, krs, regon, name, legalName }`. | unset (uses MF white-list) | No |
| `OM_USE_WL_API` | Set to `false` to use a built-in **mock** response (dev without MF access). Any other value (or unset) calls the live API. | unset → live API | No |

No API keys/secrets — the MF white-list is public. Base URL `https://wl-api.mf.gov.pl` is a constant.

### 3.3 Setup steps (target environment)
1. Copy `src/modules/companies_pl/**` + register in `src/modules.ts`; `yarn generate`.
2. `yarn mercato entities install` (provision NIP/KRS/REGON custom fields on the company entity).
3. No migrations of its own, no secrets. Open a company record → the lookup panel is there.

### 3.4 Known gaps / recommendations (from review)
These are pre-existing and worth hardening before heavy production use:
- **Mock mode ships in the prod path**: `OM_USE_WL_API=false` returns a fabricated company (fake KRS
  `0000123456`). Guard it to dev-only or document clearly so it isn't enabled by accident.
- **No RBAC feature gate** on the lookup route (only `requireAuth: true`). Consider a
  `companies_pl.lookup` feature in `acl.ts` + `setup.ts` `defaultRoleFeatures`.
- **No i18n** — all strings are hardcoded Polish (route errors, widget labels, `ce.ts` field labels).
  Add `i18n/{pl,en}.json` + `useT()` to meet the design-system/i18n rule and support English.
- **No NIP/REGON/KRS checksum validation** — only length/regex. Add the standard mod-11 NIP checksum
  (and REGON/KRS checks) so malformed-but-well-formed numbers don't hit the API.
- **No fetch timeout** on the external call — add an `AbortController` timeout so a hung MF API doesn't
  hang the request.
- **PII / encryption** — NIP/REGON/KRS and fetched addresses are company/PII data. Confirm whether the
  core company profile encrypts them; if these custom-field columns hold PII, declare an
  `encryption.ts` map.
- **Naming vs reality** — module is named for NIP/KRS/REGON but only queries the MF VAT white-list (not
  GUS REGON or the KRS registry). For richer data, point `OM_COMPANY_LOOKUP_API_URL` at a GUS/KRS proxy.
- **Tests** — a `parsePolishAddress` unit test now exists; NIP checksum + white-list response mapping
  remain good candidates.
