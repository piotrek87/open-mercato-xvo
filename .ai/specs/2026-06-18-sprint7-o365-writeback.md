# Sprint 7 — O365 Inbound Fix & Write-Back Architecture

**Status:** PHASE A CLOSED — `main`, commit `4aae1d9` (2026-06-18). Phase B DEFERRED.
**Author:** Claude Code  
**Date:** 2026-06-18  
**Scope tego dokumentu:** Faza A (naprawa inbound) + architektura Fazy B (write-back). Implementacja Fazy B następuje po zatwierdzeniu Fazy A E2E.

---

## Status zamknięcia Fazy A

### Zaimplementowane (Phase A)

| # | Problem/zadanie | Commit | Status |
|---|---|---|---|
| P1 | `visibility='private'` → `'team'` w obu workerach | `15e512c` | DONE |
| P2 | Primary link (`linkedEntityType`/`linkedEntityId`) na Activity | `8f7c921` | DONE |
| P3 | ActivityLink dla firm (`customers:company`) | `dd374b7` | DONE |
| P4 | `hasFeature()` zamiast `.includes()` | `15e512c` | DONE |
| P5 | Partial unique index `customer_interactions_o365_dedup_idx` | `dd374b7` | DONE |
| — | CI dual-write dla spotkań (persons) | `dd374b7` Sprint 7A | DONE |
| — | CI dual-write dla emaili + MCL chain (persons) | `d6a2e5b` Sprint 7B | DONE |
| — | CI dual-write dla firm (spotkania + maile) | `4aae1d9` Sprint 7C | DONE |
| — | Interceptor deals page (strip dealId) | `4aae1d9` Sprint 7C | DONE |

### Deferred

| Item | Decyzja |
|---|---|
| Phase B (write-back CRM → O365) | Deferred do Sprint 7.5 / Sprint 9. Wymaga E2E Phase A + product decision Q3 (błąd write-back). |
| Per-channel visibility policy | Deferred do Sprint 8. Infrastructure gotowa (channelState.capabilities.mail), brak UI. |
| `activities.view_private` grant dla adminów | Mniejsze znaczenie po zmianie na `visibility='team'`. Deferred. |

---

---

## 1. Diagnoza: dlaczego zsynchronizowane aktywności nie są widoczne

Workery `mail-sync` i `calendar-sync` **już tworzą rekordy Activity w OM**. Problem leży w 4 niezależnych miejscach.

### 1.1 Przyczyna główna: `visibility='private'`

Oba workery ustawiają na każdej synced Activity:

```typescript
// mail-sync.ts:356 i calendar-sync.ts:308
visibility: 'private',
```

API w `GET /api/activities` filtruje prywatne rekordy:

```typescript
// api/route.ts
const canViewPrivate = features.includes('activities.view_private')  // ← uwaga: .includes() bez wildcards

if (!canViewPrivate) {
  where['$and'] = [{
    $or: [
      { visibility: { $ne: 'private' } },
      { visibility: 'private', ownerUserId: auth.sub },   // ← tylko właściciel widzi własne
    ],
  }]
}
```

**Efekt:** Zsynchronizowane maile i meetingi są widoczne **wyłącznie** dla użytkownika, który podłączył konto O365 (`channel.userId`). Każdy inny użytkownik — nawet admin — widzi `total: 0`.

Dodatkowo: sprawdzenie `features.includes(...)` narusza zasadę AGENTS.md (brak obsługi wildcardów `activities.*`). Należy zastąpić `hasFeature()` z `@open-mercato/shared/lib/auth/featureMatch`.

### 1.2 Brak primary link na Activity

Oba workery tworzą Activity **bez** `linkedEntityType` / `linkedEntityId`:

```typescript
// W upsertMailActivity() — brak tych pól:
em.create(Activity, {
  // ... brak linkedEntityType, linkedEntityId
  visibility: 'private',
  externalId: msg.id,
  ...
})
```

Widget timeline już używa `includeLinked=true`, więc odpytuje `ActivityLink` (relacje wtórne). To zadziała — **ale tylko jeśli** `autoLinkActivityToCustomers()` rzeczywiście wstawił wiersze do `ActivityLink`.

### 1.3 Linkowanie działa, ale tylko dla `customers:person`

`autoLinkActivityToCustomers()` w `customer-linker.ts`:
- Buduje mapę `email → customerId[]` na podstawie odszyfrowanych pól `primaryEmail` osób
- Wstawia `ActivityLink(entityType='customers:person', entityId=customerId, ...)`
- Używa `em.upsertMany` z `onConflictAction: 'ignore'` — poprawne

**Brakuje:**
- Linków dla `customers:company` (firma powiązana z osobą)
- Linków dla dealów (szans sprzedaży)

Gdy użytkownik wchodzi na stronę firmy → timeline odpytuje `ActivityLink(entityType='customers:company')` → brak wyników → puste.

### 1.4 Brak partial unique index (ryzyko duplikatów)

W `entities.ts` jest komentarz:

```typescript
// Note: A partial unique index on (external_id, external_provider, organization_id)
// WHERE external_id IS NOT NULL must be added manually to the migration SQL
```

Indeks nie istnieje w żadnej migracji. Workery chronią się przez `em.find({ externalId: { $in: ... } })` przed dublem, ale bez indeksu możliwe są race conditions przy równoległych uruchomieniach workerów (concurrency=2 dla mail-sync, concurrency=3 dla calendar-sync).

### 1.5 Tabela znalezisk

| # | Problem | Plik | Severity |
|---|---|---|---|
| P1 | `visibility='private'` blokuje widoczność dla innych użytkowników | `mail-sync.ts:356`, `calendar-sync.ts:308` | **Krytyczny** |
| P2 | Brak `linkedEntityType`/`linkedEntityId` — brak primary link | `mail-sync.ts:upsertMailActivity`, `calendar-sync.ts` | Wysoki |
| P3 | Brak linków dla firm (`customers:company`) | `customer-linker.ts` | Wysoki |
| P4 | `features.includes()` zamiast `hasFeature()` — naruszenie wildcardów | `api/route.ts` | Średni |
| P5 | Brak partial unique index na `(external_id, external_provider, organization_id)` | migracja | Średni |

---

## 2. Decyzja produktowa — visibility (wymagane potwierdzenie)

To jest najważniejsza decyzja architektoniczna Sprint 7.

### Opcja A: `visibility='team'` dla wszystkich synced activities (rekomendacja)

Zsynchronizowane maile i meetingi są widoczne dla wszystkich użytkowników mających dostęp do klienta.

**Za:**
- Spójność z oczekiwaniem użytkownika ("wchodzę do emaila osoby i chcę widzieć historię")
- Prosta implementacja — zmiana jednej linii w obu workerach
- Zgodna z zachowaniem firmowych skrzynek (mail firmowy = wspólna własność)

**Przeciw:**
- Maile osobiste (prywatne rozmowy poza kontekstem biznesowym) stają się widoczne dla kolegów
- GDPR: treść maila (`notes = bodyPreview`) jest widoczna dla innych użytkowników

**Wariant A1 — `visibility='team'` z wyjątkiem:** Dodaj pole `mailSyncVisibility` do `channelState.capabilities.mail` (domyślnie `'team'`). Admin decyduje per-kanał. Sprint 7 implementuje tylko domyślne `'team'`, UI do zmiany w Sprint 8.

### Opcja B: `visibility='private'` + napraw filtr dla właściciela kanału

Maile i meetingi widoczne tylko dla właściciela skrzynki. Kolega nie widzi.

**Za:**
- Privacy by default
- Zgodna z obecnym zamysłem workera (komentarz: "email is personal data")

**Przeciw:**
- Łamie oczekiwanie użytkownika ("jak wchodzę do emaila osoby to nic nie widzę")
- Wymaga dodatkowego mechanizmu share/delegate żeby inni mogli zobaczyć

### Opcja C: Per-channel policy z UI

Każdy kanał O365 ma konfigurowalną politykę visibility. Skomplikowane — Sprint 9+.

**Rekomendacja Sprint 7: Opcja A1** — `visibility='team'` jako domyślna, z możliwością per-channel override w przyszłości. Uzasadnienie: scenariusz docelowy to firmowe konto handlowca, nie prywatna skrzynka.

> **TODO przed implementacją:** Zatwierdź opcję przez użytkownika/product.

---

## 3. Model danych — analiza wystarczalności

### 3.1 Istniejące pola (kompletne, brak migracji schema)

```
external_id       varchar(500)   — ID wiadomości/eventu w O365
external_provider varchar(100)   — 'office365_mail' | 'office365_calendar'
sync_direction    varchar(20)    — 'import' | 'export' | 'bidirectional'
last_synced_at    timestamptz    — kiedy ostatnio sync
source_type       varchar(100)   — 'inbox' | 'sent' | 'calendar'
source_id         uuid           — ID kanału (czyje konto O365)
```

**Wniosek: Brak nowych kolumn.** `externalId`+`externalProvider`+`organizationId` wystarczą jako klucz deduplication. `sourceId` można mapować na UUID rekordu `CommunicationChannel` żeby wiedzieć czyje konto wysłało.

### 3.2 Wymagana migracja

Tylko brakujący partial unique index:

```sql
-- Migration: Sprint 7
CREATE UNIQUE INDEX IF NOT EXISTS activities_external_dedup_idx
  ON activities (external_id, external_provider, organization_id)
  WHERE external_id IS NOT NULL;
```

---

## 4. Source of Truth

| Typ | Source of Truth | Uzasadnienie |
|---|---|---|
| Email | **O365** | Wysłany mail jest kanoniczną wersją w O365. OM trzyma metadane CRM + preview treści. |
| Meeting / event | **O365** | Kalendarz O365 zarządza zaproszeniami, RSVP, aktualizacjami. |
| Task / zadanie | **OM** | Zadania OM nie synchronizują się z O365 Tasks w Sprint 7. |
| Call / log | **OM** | Manualne logowanie, brak odpowiednika w O365. |

### 4.1 Strategia konfliktów (Sprint 7 — create-first)

**Inbound (O365 → OM):**
- `subject`, `occurredAt`/`dueAt`, `durationMinutes`, `location`, `participants` → **nadpisane przez sync**
- `notes` (treść z bodyPreview) → **nadpisane przez sync** (brak edycji notes w O365 activities w Sprint 7)
- `ownerUserId`, `priority` → **chronione** (nie nadpisywane przez sync)

**Outbound (OM → O365, Sprint 7 scope: only create):**
- Po wysłaniu maila z OM → `externalId` zapisany z powrotem
- Następny mail-sync widzi wiadomość po `externalId` → update `lastSyncedAt`, `syncDirection='bidirectional'`
- NIE tworzy duplikatu

**Edycja synced activity w OM:**
- Sprint 7: lokalne edycje są przechowywane, **nie** są pushowane do O365
- Sprint 8: flaga `userEditedAt` na Activity — sync nie nadpisuje pól które użytkownik edytował po `userEditedAt`

---

## 5. Plan Fazy A — naprawa inbound

### A1: Migracja — partial unique index

```typescript
// src/modules/activities/migrations/Migration20260618_activities_external_dedup.ts
export class Migration20260618_activities_external_dedup extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS activities_external_dedup_idx
        ON activities (external_id, external_provider, organization_id)
        WHERE external_id IS NOT NULL;
    `)
  }
  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS activities_external_dedup_idx;`)
  }
}
```

### A2: Zmiana visibility w workerach

**mail-sync.ts — zmiana w `upsertMailActivity()`:**
```typescript
// PRZED:
visibility: 'private',

// PO (Sprint 7):
visibility: 'team',
// Uzasadnienie: firmowe konto O365 → historia komunikacji widoczna dla całego zespołu.
// Sprint 8: per-channel policy przez channelState.capabilities.mail.visibility
```

**calendar-sync.ts — ta sama zmiana:**
```typescript
// PRZED:
visibility: 'private',

// PO:
visibility: 'team',
```

### A3: Naprawa filtru visibility w API

```typescript
// api/route.ts — PRZED:
const canViewPrivate = features.includes('activities.view_private')

// PO:
import { hasFeature } from '@open-mercato/shared/lib/auth/featureMatch'
const canViewPrivate = hasFeature(auth.features ?? [], 'activities.view_private')
```

### A4: Rozszerzenie customer-linker o firmy

`autoLinkActivityToCustomers()` po wstawieniu linków dla osób musi wstawić też linki dla ich firm.

**Wymagane dane:** Po zlinkowaniu osoby (`customers:person`, `entityId=personId`) → lookup `companyId` tej osoby → wstaw `ActivityLink(entityType='customers:company', entityId=companyId, isPrimary=false)`.

**Kształt rozszerzenia:**

```typescript
// customer-linker.ts — po wstawieniu person links:

// 1. Zbierz wszystkie personId które zostały zlinkowane
const linkedPersonIds: string[] = ... // z insertowanych ActivityLink rows

// 2. Lookup companyId per person (batch query)
const persons = await em.find(CustomerEntity, {
  id: { $in: linkedPersonIds },
  tenantId: scope.tenantId,
  organizationId: scope.organizationId,
  deletedAt: null,
}, { fields: ['id', 'companyId'] })   // companyId = FK na firmę

// 3. Wstaw ActivityLink dla każdej unikalnej firmy
const companyLinks = persons
  .filter(p => p.companyId)
  .flatMap(p => linkedByPerson.get(p.id)!.map(activityId => ({
    activityId,
    entityType: 'customers:company',
    entityId: p.companyId!,
    isPrimary: false,
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    createdByUserId: null,
  })))

if (companyLinks.length > 0) {
  await em.upsertMany(ActivityLink, companyLinks, {
    onConflictFields: ['activity_id', 'entity_type', 'entity_id'],
    onConflictAction: 'ignore',
  })
}
```

> **Uwaga implementacyjna:** `CustomerEntity` jest w module `customers` z `@open-mercato/core`. Sprawdź poprawną ścieżkę importu. Alternatywa: raw SQL join zamiast ORM żeby uniknąć zależności cross-modułowej.

### A5: Weryfikacja `includeLinked` w API (już działa)

Timeline widget (`widget.client.tsx:288`) już wysyła `includeLinked=true`. API już obsługuje ten parametr poprawnie (sprawdza ActivityLink gdy `includeLinked=true`). **Brak zmian wymaganych.**

---

## 6. Weryfikacja E2E Fazy A

Przepływ do przetestowania ręcznie po wdrożeniu:

```
1. Konto O365 podłączone przez użytkownika A
2. Uruchom mail-sync (lub poczekaj 15 min)
3. Zaloguj się jako użytkownik B (admin, inny niż A)
4. Otwórz osobę powiązaną z zsynchronizowanym mailem
5. W zakładce Activity Timeline: powinny być widoczne maile z O365
6. Otwórz firmę tej osoby: powinny być te same maile
7. Sprawdź że brak duplikatów po kolejnym sync

Checklist:
[ ] Mail z O365 widoczny w timeline osoby (dla użytkownika B)
[ ] Meeting z O365 widoczny w timeline osoby (dla użytkownika B)
[ ] Mail widoczny w timeline firmy powiązanej z osobą
[ ] total > 0 w odpowiedzi API z includeLinked=true
[ ] Drugi sync nie tworzy duplikatów (partial unique index działa)
[ ] externalId, externalProvider, syncDirection widoczne w odpowiedzi API
```

---

## 7. Architektura Fazy B — Write-Back (po zamknięciu Fazy A)

### 7.1 Scope Sprint 7

| Operacja | Email | Meeting |
|---|---|---|
| **Create** | ✅ Sprint 7 | ✅ Sprint 7 |
| Update | ❌ Sprint 8 | ❌ Sprint 8 |
| Delete | ❌ Sprint 8 | ❌ Sprint 8 |

### 7.2 Powiązanie Activity z rekordem M365 po write-back

Po wysłaniu przez Graph API zapisujemy na Activity:

```typescript
activity.externalId       = graphResponse.id           // 'AAMkAG...'
activity.externalProvider = 'office365_mail'            // lub 'office365_calendar'
activity.syncDirection    = 'export'                    // zmieni się na 'bidirectional' po inbound sync
activity.lastSyncedAt     = new Date()
activity.sourceId         = channelRecord.id            // UUID rekordu CommunicationChannel
```

**sourceId** pozwala przy następnym sync wiedzieć "ta aktywność pochodzi z kanału X" i nie duplikować.

### 7.3 Deduplication przy write-back

1. `POST /api/activities` z `sendViaO365=true` → Activity tworzona z `syncDirection='export'`, `externalId=null`
2. Graph API sendMail → response zawiera `id` wiadomości
3. Activity aktualizowana: `externalId=messageId, externalProvider='office365_mail'`
4. Następny `mail-sync` → `em.find({ externalId: messageId })` → znaleziono → update `lastSyncedAt`, `syncDirection='bidirectional'`
5. Brak duplikatu dzięki partial unique index + find-before-create

### 7.4 Skąd brać credentials przy write-back

- Przy tworzeniu Activity w API → `auth.sub` = ID zalogowanego użytkownika
- Szukamy: `CommunicationChannel WHERE userId = auth.sub AND providerKey = 'office365' AND status = 'connected'`
- Jeśli znaleziono → pobieramy credentials → Graph API
- Jeśli nie znaleziono → Activity zapisywana lokalnie, response `{ data: activity, o365Skipped: true }`
- Brak blokowania: zawsze tworzymy Activity niezależnie od sukcesu write-back

### 7.5 UX w LogActivityDrawer

Przy typie `email` lub `meeting`, jeśli użytkownik ma podłączone O365:

```
┌─── Nowa aktywność ────────────────────────────────┐
│ Typ: [Email]                                       │
├────────────────────────────────────────────────────┤
│ ☑ Wyślij przez Microsoft 365                       │  ← toggle (domyślnie ON)
│   jan@xentivo.pl                                   │  ← konto
├────────────────────────────────────────────────────┤
│ Do:    [jan@firma.pl ×] [+ dodaj]                  │  ← pojawia się tylko gdy toggle ON
│ Temat: [_______________________________________]   │
│ Treść: [_______________________________________]   │
│        [_______________________________________]   │
├────────────────────────────────────────────────────┤
│                    [Anuluj] [Wyślij i zapisz]      │
└────────────────────────────────────────────────────┘
```

Jeśli O365 nie jest podłączone → toggle ukryty → normalne "Zapisz".

Dane do toggle: `GET /api/channel_office365/capabilities` → `{ mail: { enabled: true }, accountEmail: 'jan@...' }`

### 7.6 Oznaczenie synced activities w timeline

`DefaultActivityCard` gdy `externalProvider = 'office365_mail' | 'office365_calendar'`:
- Mała ikonka M365 (logo lub Cloud icon z lucide) przy tytule
- Tooltip: "Zsynchronizowano z Microsoft 365"

---

## 8. Otwarte pytania do zatwierdzenia przed implementacją

### Q1 — Visibility (krytyczne)

**Pytanie:** Czy zsynchronizowane maile i meetingi z O365 mają być widoczne:  
(A) Tylko dla właściciela konta O365 → `visibility='private'` (obecny stan, łamie UX)  
(B) Dla wszystkich użytkowników z dostępem do klienta → `visibility='team'` (rekomendacja)  
(C) Konfigurowalnie per kanał → `channelState.capabilities.mail.visibility` (Sprint 8)

**Rekomendacja: B** z przygotowaniem infrastruktury pod C.

### Q2 — Firmy w auto-link

**Pytanie:** Czy przy auto-linkowaniu do klientów (osoba e-mail → ActivityLink) chcemy też automatycznie dodać link do firmy tej osoby?

**Rekomendacja: Tak** — firma jest naturalnym kontekstem maila biznesowego. Brak linka do firmy = pusta historia w widoku firmy.

### Q3 — Błąd write-back do O365

**Pytanie:** Co jeśli Graph API zwróci błąd podczas wysyłania maila (token wygasł, quota, sieć)?

**Propozycja:** Activity zostaje zapisana lokalnie (status=completed, bez externalId). Toast z błędem i linkiem "Połącz ponownie z Microsoft 365". Użytkownik może ponowić z poziomu Activity detail (Sprint 8).

### Q4 — `activities.view_private` feature

**Pytanie:** Czy feature `activities.view_private` powinien być grantem dla adminów (żeby mogli audytować prywatne aktywności)?

**Propozycja:** Tak — grant dla roli `admin` w `activities/setup.ts`. Ale jeśli zmieniamy na `visibility='team'` (Q1=B), to feature staje się niszowy — dotyczy tylko aktywności ręcznie oznaczonych jako private przez użytkownika.

---

## 9. Kolejność implementacji

```
Sprint 7 — Faza A (naprawa inbound):
  [A1] Migracja: partial unique index activities_external_dedup_idx
  [A2] mail-sync + calendar-sync: visibility='team' (po zatwierdzeniu Q1)
  [A3] api/route.ts: hasFeature() zamiast .includes()
  [A4] customer-linker: dodaj linki dla firm (customers:company)
  [A5] E2E smoke test (checklist z sekcji 6)

Sprint 7 — Faza B (write-back, po zatwierdzeniu Fazy A E2E):
  [B1] Weryfikacja/rozszerzenie GraphMailClient.sendMail()
  [B2] POST /api/activities: opcje sendViaO365, toRecipients
  [B3] LogActivityDrawer: fetch capabilities, toggle M365, pole Do:
  [B4] Zapis externalId po udanej wysyłce
  [B5] GraphClient.createEvent() dla meetingów
  [B6] DefaultActivityCard: ikonka M365
```
