# SPEC-ACT-001: Activity Module — Sprint 1 Technical Specification

**Data**: 2026-06-15
**Status**: Ready for Implementation
**Szacowany czas**: 2 tygodnie (2 deweloperów)
**Poprzednie dokumenty**:
  - `2026-06-15-activity-model-architecture.md` — warianty architektoniczne
  - `2026-06-15-customerinteraction-vs-activity.md` — relacja z CustomerInteraction
  - `2026-06-15-activity-product-architecture.md` — produkt + UX
  - `2026-06-15-activity-extensibility-architecture.md` — rozszerzalność

---

## Zakres Sprint 1

### Co implementujemy

- Moduł `activities` — encje, migracja, CRUD API, lifecycle actions
- ActivityTimeline widget — injektowany na stronę klienta i zamówienia
- Built-in typy aktywności: email, meeting, task, call, note
- RBAC: features, defaultRoleFeatures, ACL gate na wszystkich endpointach
- Eventy: activities.activity.{created,updated,completed,cancelled,deleted}
- Szyfrowanie: `subject` + `notes` przez encryption maps

### Czego NIE implementujemy w Sprint 1

| Funkcja | Docelowy sprint |
|---------|----------------|
| O365 / Gmail sync | Sprint 4–5 |
| `ActivityLink` (wiele linków per Activity) | Sprint 2 |
| Activity type registry auto-discovery (`activity-types.ts` generator) | Sprint 2 |
| Custom fields (ce.ts) | Sprint 2 |
| Full-text search (search.ts indexer) | Sprint 3 |
| Dashboard widget | Sprint 3 |
| Recurrence / powtarzające się aktywności | Sprint 4 |
| Powiadomienia / przypomnienia | Sprint 3 |
| CustomerInteraction bridge (API interceptor) | Sprint 8 |
| Migracja danych CustomerInteraction → Activity | Sprint 8 |

---

## 1. Model danych

### 1.1 Encja `Activity`

**Tabela**: `activities`
**Module entity ID**: `activities:activity`

```
KOLUMNA                  TYP              NULL    DEFAULT   UWAGI
─────────────────────────────────────────────────────────────────────────────
id                       uuid             NO              PK, auto-generated
organization_id          uuid             NO              FK scope (indexed)
tenant_id                uuid             NO              FK scope (indexed)
─────────────────────────────────────────────────────────────────────────────
activity_type            varchar(100)     NO              open text, nie enum
                                                          'email'|'meeting'|'task'|
                                                          'call'|'note'|
                                                          'sales:quote_sent'|...
lifecycle_mode           varchar(10)      NO      'task'   'fact' | 'task'
                                                          immutable po wdrożeniu
─────────────────────────────────────────────────────────────────────────────
subject                  text             NO              ENCRYPTED
                                                          max 500 znaków (enforce w Zod)
notes                    text             YES             ENCRYPTED
                                                          max 10 000 znaków
─────────────────────────────────────────────────────────────────────────────
status                   varchar(20)      NO      patrz    'not_started' (task domyślnie)
                                                  niżej    'in_progress'
                                                           'completed'
                                                           'cancelled'
                                                  Reguła: 'fact' MUSI mieć
                                                  status='completed' lub NULL
                                                  zaraz po created_at
priority                 smallint         YES             0–100; NULL = brak priorytetu
─────────────────────────────────────────────────────────────────────────────
due_at                   timestamptz      YES             kiedy ma się wydarzyć (task)
completed_at             timestamptz      YES             kiedy zakończono
occurred_at              timestamptz      YES             kiedy faktycznie się stało (fact)
duration_minutes         integer          YES             0–1440
location                 varchar(500)     YES             ENCRYPTED (PII-adjacent)
all_day                  boolean          NO      false
recurrence_rule          varchar(500)     YES             iCal RRULE — Sprint 4
─────────────────────────────────────────────────────────────────────────────
author_user_id           uuid             YES             kto stworzył
owner_user_id            uuid             YES             kto odpowiada
participants             jsonb            YES             []{ userId?, name?,
                                                             email?, status? }
visibility               varchar(10)      NO      'team'   'private'|'team'|'public'
                                                  'private' tylko dla lifecycle_mode='task'
                                                  'fact' → wymuszony 'team'
─────────────────────────────────────────────────────────────────────────────
linked_entity_type       varchar(100)     YES             'customers:person'|
                                                          'customers:company'|
                                                          'customers:deal'|
                                                          'sales:order'|...
linked_entity_id         uuid             YES             FK (brak ORM relation)
                                                          NULL = aktywność org-wide
─────────────────────────────────────────────────────────────────────────────
external_id              varchar(500)     YES             ID w systemie zewnętrznym
                                                          (O365 event ID, Gmail ID)
external_provider        varchar(100)     YES             'office365'|'gmail'|
                                                          'google_calendar'|...
sync_direction           varchar(20)      YES             'inbound'|'outbound'|
                                                          'bidirectional'
last_synced_at           timestamptz      YES
─────────────────────────────────────────────────────────────────────────────
source_type              varchar(100)     YES             'manual'|'sales:quote'|
                                                          'channel_office365:sync'
source_id                uuid             YES             ID rekordu źródłowego
─────────────────────────────────────────────────────────────────────────────
is_active                boolean          NO      true
deleted_at               timestamptz      YES             soft delete
created_at               timestamptz      NO              auto
updated_at               timestamptz      NO              auto onUpdate
─────────────────────────────────────────────────────────────────────────────
```

**Status defaults**:

| lifecycle_mode | Domyślny status przy tworzeniu |
|---|---|
| `task` | `not_started` |
| `fact` | `completed` (fakt już się wydarzył) |

**Reguły biznesowe na status**:

```
'fact' activities:
  Dozwolone statusy: 'completed' tylko
  Nigdy: 'not_started', 'in_progress', 'cancelled'
  Rationale: fakt historyczny nie ma lifecycle — albo się stało, albo nie

'task' activities:
  State machine:
    not_started ──► in_progress ──► completed
          │               │
          └───────────────┴──────► cancelled
    completed ──► not_started  (reopen action)
    cancelled → BRAK powrotu (cancelled jest terminalny)
```

### 1.2 Encja `ActivityLink` — Sprint 2, nie Sprint 1

W Sprint 1 wystarczy `linked_entity_type` + `linked_entity_id` na głównej encji.
`ActivityLink` (wiele linków per aktywność) odkładamy do Sprint 2.

**Powód**: Brak ActivityLink nie blokuje żadnego UC w Sprint 1.
Komplikuje natomiast zapytania i paginację — lepiej zrobić ją dobrze w Sprint 2.

### 1.3 Indeksy

Maksymalnie **6 indeksów** w Sprint 1 (więcej spowalnia inseerty przy sync w Sprint 4):

```sql
-- IDX-1: Timeline per entity (najczęstsze zapytanie)
CREATE INDEX activities_entity_timeline_idx
ON activities (organization_id, tenant_id, linked_entity_type, linked_entity_id,
               deleted_at, due_at, occurred_at, created_at)
WHERE deleted_at IS NULL;

-- IDX-2: Moje aktywności (widok "My Activities" dla zalogowanego usera)
CREATE INDEX activities_owner_idx
ON activities (organization_id, tenant_id, owner_user_id, status, due_at)
WHERE deleted_at IS NULL;

-- IDX-3: Filtr po typie (filter bar w timeline)
CREATE INDEX activities_type_status_idx
ON activities (organization_id, tenant_id, activity_type, status, deleted_at);

-- IDX-4: Deduplication przy external sync (UNIQUE z partial condition)
CREATE UNIQUE INDEX activities_external_dedup_idx
ON activities (organization_id, external_id, external_provider)
WHERE external_id IS NOT NULL AND deleted_at IS NULL;

-- IDX-5: Overdue detection (worker scheduled w Sprint 3)
CREATE INDEX activities_overdue_idx
ON activities (organization_id, tenant_id, due_at, status)
WHERE lifecycle_mode = 'task'
  AND status IN ('not_started', 'in_progress')
  AND deleted_at IS NULL;

-- IDX-6: Scope scans + soft delete (używany przy bulk queries admin)
CREATE INDEX activities_org_tenant_idx
ON activities (organization_id, tenant_id, created_at DESC)
WHERE deleted_at IS NULL;
```

**Uwaga o IDX-1**: Jest to partial index z `WHERE deleted_at IS NULL`.
Oznacza to, że soft-deleted rekordy wypadają z indeksu → zapytania na aktywnych
rekordach są szybkie nawet przy milionach soft-deleted wierszy.

### 1.4 Constraints

```sql
-- Integralność: linked_entity_id bez linked_entity_type jest błędem
ALTER TABLE activities
  ADD CONSTRAINT activities_entity_link_check
  CHECK (
    (linked_entity_type IS NULL AND linked_entity_id IS NULL) OR
    (linked_entity_type IS NOT NULL AND linked_entity_id IS NOT NULL)
  );

-- Integralność: external_id bez external_provider jest błędem
ALTER TABLE activities
  ADD CONSTRAINT activities_external_link_check
  CHECK (
    (external_id IS NULL AND external_provider IS NULL) OR
    (external_id IS NOT NULL AND external_provider IS NOT NULL)
  );

-- Fact activities nie mogą mieć statusu other than 'completed'
-- (Enforced przez Zod + command, nie DB constraint — łatwiej zmienić)

-- Priority range
ALTER TABLE activities
  ADD CONSTRAINT activities_priority_range_check
  CHECK (priority IS NULL OR (priority >= 0 AND priority <= 100));

-- Duration range
ALTER TABLE activities
  ADD CONSTRAINT activities_duration_check
  CHECK (duration_minutes IS NULL OR (duration_minutes >= 0 AND duration_minutes <= 1440));
```

### 1.5 Strategia soft delete

- `deleted_at timestamptz NULL` — standardowy wzorzec OM
- Wszystkie zapytania dodają `AND deleted_at IS NULL` (przez `withScopedPayload`)
- `DELETE /api/activities/[id]` → ustawia `deleted_at = now()` (nigdy hard delete)
- Restore: `POST /api/activities/[id]/restore` → `deleted_at = NULL`
  (tylko w Sprint 1 dla `task` mode; `fact` mode nie jest restorable)
- Admin hard-delete: nie planujemy w Sprint 1

**Reguły soft delete**:

| lifecycle_mode | Kto może usunąć | Kiedy można usunąć |
|---|---|---|
| `task` | owner lub activities.manage | zawsze |
| `fact` | activities.manage (admin) | tylko w Sprint 3+ |

Rationale: fakty historyczne (np. "email wysłany") nie powinny być usuwane przez zwykłych
użytkowników — to by zafałszowało historię kontaktu z klientem.

### 1.6 Multi-tenant support

**Obowiązkowe na każdym rekordzie**:
- `organization_id` — identyfikuje organizację (tenant biznesowy)
- `tenant_id` — identyfikuje schemat/bazę (techniczny tenant OM)

**Każde zapytanie musi filtrować po obu**:
```typescript
withScopedPayload(req, { organizationId, tenantId })
// Wstrzykuje WHERE organization_id = ? AND tenant_id = ?
// do każdego query przez EntityManager
```

**Szyfrowanie per-tenant**:
- Klucz DEK jest resolwowany przez DI z `tenantDataEncryptionService`
- Różne tenants mają różne klucze → dane jednego tenanta nie są czytelne przez inny
- Pola: `subject`, `notes`, `location` → deklarowane w `encryption.ts`

### 1.7 Encryption maps

Plik `src/modules/activities/encryption.ts`:

```
Encja: activities:activity
Pola:
  subject:  type='string', algorithm='aes-256-gcm'
  notes:    type='string', nullable=true, algorithm='aes-256-gcm'
  location: type='string', nullable=true, algorithm='aes-256-gcm'

Odczyty MUSZĄ używać:
  findWithDecryption(em, Activity, where, undefined, { tenantId, organizationId })
  findOneWithDecryption(...)

Zapisy przez CRUD factory automatycznie szyfrują przez TenantDataEncryptionService.
```

---

## 2. API Contracts

### 2.1 Routing

Wszystkie endpointy w `src/modules/activities/api/`:

```
POST   /api/activities                    Utwórz aktywność
GET    /api/activities                    Lista z filtrami i paginacją
GET    /api/activities/[id]               Pojedynczy rekord
PUT    /api/activities/[id]               Aktualizuj
DELETE /api/activities/[id]               Soft delete

POST   /api/activities/[id]/complete      Lifecycle: zakończ
POST   /api/activities/[id]/cancel        Lifecycle: anuluj
POST   /api/activities/[id]/reopen        Lifecycle: wznów (tylko task)
POST   /api/activities/[id]/restore       Przywróć usuniętą (tylko task)

GET    /api/activities/types              Publiczny rejestr typów (Sprint 2)
```

**Każdy plik `route.ts` MUSI eksportować `metadata` i `openApi`.**

### 2.2 Metadata (auth gates)

```typescript
export const metadata = {
  GET:    { requireAuth: true, requireFeatures: ['activities.view'] },
  POST:   { requireAuth: true, requireFeatures: ['activities.manage'] },
  PUT:    { requireAuth: true, requireFeatures: ['activities.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['activities.manage'] },
}

// Lifecycle routes:
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['activities.manage'] },
}
```

### 2.3 POST /api/activities — Create

**Request body** (Zod schema `activityCreateSchema`):

```
{
  id?:              uuid             -- opcjonalny (client-side ID generation)
  activityType:     string           REQUIRED, min 1, max 100
  lifecycleMode:    'fact'|'task'    REQUIRED
  subject:          string           REQUIRED, min 1, max 500

  notes?:           string           max 10 000
  status?:          ActivityStatus   default: 'not_started' (task) / 'completed' (fact)
  priority?:        int              0–100
  dueAt?:           ISO string       nullable
  occurredAt?:      ISO string       nullable; REQUIRED jeśli lifecycleMode='fact'
                                     i status='completed'
  durationMinutes?: int              0–1440
  location?:        string           max 500
  allDay?:          boolean          default false
  ownerUserId?:     uuid
  participants?:    Array<{
    userId?:  uuid
    name?:    string max 200
    email?:   string email format
    status?:  string max 50
  }>
  visibility?:      'private'|'team'|'public'   default 'team'
                    'private' forbidden when lifecycleMode='fact'

  linkedEntityType?: string          max 100
  linkedEntityId?:   uuid
  -- Wymaganie: oba muszą być podane razem lub żadne

  externalId?:       string          max 500
  externalProvider?: string          max 100
  syncDirection?:    'inbound'|'outbound'|'bidirectional'
  -- Wymaganie: externalId wymaga externalProvider

  sourceType?:  string               max 100
  sourceId?:    uuid
}
```

**Response 201**:

```
ActivityResponse {
  id:               uuid
  activityType:     string
  lifecycleMode:    'fact'|'task'
  subject:          string           (decrypted)
  notes?:           string           (decrypted)
  status:           string
  priority?:        number
  dueAt?:           string           ISO 8601
  completedAt?:     string
  occurredAt?:      string
  durationMinutes?: number
  location?:        string           (decrypted)
  allDay:           boolean
  authorUserId?:    string
  ownerUserId?:     string
  participants:     Array<{...}>
  visibility:       string
  linkedEntityType?: string
  linkedEntityId?:   string
  externalId?:      string
  externalProvider?: string
  syncDirection?:   string
  lastSyncedAt?:    string
  sourceType?:      string
  sourceId?:        string
  isActive:         boolean
  createdAt:        string
  updatedAt:        string
  customFields:     {}               -- pusty w Sprint 1, gotowy na Sprint 2
}
```

**Błędy**:

| Kod | Kiedy |
|-----|-------|
| 400 | Walidacja Zod nie przeszła |
| 400 | `linkedEntityId` bez `linkedEntityType` |
| 400 | `visibility='private'` na `lifecycleMode='fact'` |
| 400 | `occurredAt` null przy `lifecycleMode='fact'` |
| 409 | `external_id` + `external_provider` już istnieje (dedup) |
| 403 | Brak `activities.manage` feature |

### 2.4 GET /api/activities — List / Timeline

**Query params**:

```
entityType?:     string         -- filtr linked_entity_type
entityId?:       uuid           -- filtr linked_entity_id (wymaga entityType)
activityType?:   string|string[]-- jeden lub wiele typów (comma-separated)
lifecycleMode?:  'fact'|'task'
status?:         string|string[]-- jeden lub wiele statusów
ownerUserId?:    uuid
authorUserId?:   uuid
externalProvider?: string
visibility?:     'private'|'team'|'public'

-- Zakres dat
from?:           ISO string     -- >= data (inclusive)
to?:             ISO string     -- <= data (inclusive)
dateField?:      'dueAt'|'occurredAt'|'completedAt'|'createdAt'
                 default: 'dueAt' jeśli lifecycleMode='task'
                          'occurredAt' jeśli lifecycleMode='fact'
                          'createdAt' gdy brak obu

-- Paginacja (cursor-based)
cursor?:         string         -- opaque cursor z poprzedniej strony
limit?:          int            1–100, default 25

-- Sortowanie
sort?:           string         'dueAt:asc'|'dueAt:desc'|
                                'occurredAt:desc'|'createdAt:desc'
                                default: zależy od trybu timeline (patrz niżej)

-- Pełnotekstowe wyszukiwanie (Sprint 3)
search?:         string         -- ignorowane w Sprint 1
```

**Response 200**:

```
{
  data:        ActivityResponse[]
  nextCursor?: string            -- null gdy brak kolejnych stron
  hasMore:     boolean
}
```

**Uwaga o `total`**: Celowo nie zwracamy `total` count. Przy 100k+ rekordach
`SELECT COUNT(*)` z filtrami jest kosztowny i niepotrzebny dla nieskończonego
scrolla. Jeśli UI potrzebuje liczby — osobny lekki endpoint `/api/activities/counts`.

### 2.5 Strategia paginacji — Cursor-based

**Dlaczego nie offset?**

Offset pagination (`LIMIT 25 OFFSET 100`) przy 100k+ rekordach wymaga:
1. Pełnego skanowania 100 wierszy przed stroną
2. Niestabilnych wyników gdy dane się zmieniają między stronami

Cursor pagination używa `(sort_key, id)` jako pozycji:

**Format cursora** (base64-encoded JSON, opaque dla klienta):

```json
{
  "v": 1,
  "mode": "history",
  "after": {
    "occurred_at": "2026-06-14T14:32:00Z",
    "created_at": "2026-06-14T14:32:01Z",
    "id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**SQL dla history cursor** (after page):

```sql
WHERE organization_id = $1 AND tenant_id = $2
  AND linked_entity_type = $3 AND linked_entity_id = $4
  AND deleted_at IS NULL
  AND (
    COALESCE(occurred_at, created_at) < $cursor_date
    OR (COALESCE(occurred_at, created_at) = $cursor_date AND id < $cursor_id)
  )
ORDER BY COALESCE(occurred_at, created_at) DESC, id DESC
LIMIT $limit + 1
-- +1 żeby sprawdzić hasMore bez dodatkowego COUNT
```

**Dwa osobne cursory na timeline**:

Timeline klienta składa się z dwóch sekcji, każda ma swój cursor:
```
Response dla timeline:
{
  planned: {
    data: Activity[]        -- status in (not_started, in_progress), due_at ASC
    nextCursor?: string
    hasMore: boolean
  },
  history: {
    data: Activity[]        -- completed/cancelled/facts, occurred_at DESC
    nextCursor?: string
    hasMore: boolean
  }
}
```

Alternatywnie: dwa osobne wywołania API z `lifecycleMode` filter.
Rekomendacja: **dwa osobne wywołania** — prostsze do cache'owania i invalidacji.

### 2.6 POST /api/activities/[id]/complete

**Dozwolone**: tylko `lifecycle_mode='task'`, status in `('not_started', 'in_progress')`

**Request**:
```
{
  occurredAt?:      ISO string    -- gdy faktycznie nastąpiło (default: now)
  notes?:           string        -- notatka z realizacji
  durationMinutes?: int           -- ile trwało
}
```

**Response 200**: ActivityResponse ze statusem `completed`, ustawionym `completedAt`

**Emituje event**: `activities.activity.completed`

**Błędy**:

| Kod | Kiedy |
|-----|-------|
| 400 | `lifecycle_mode='fact'` — faktów nie można "zakończyć" (już są zakończone) |
| 409 | Status już `completed` lub `cancelled` |
| 403 | Brak `activities.manage` feature |

### 2.7 POST /api/activities/[id]/cancel

**Dozwolone**: tylko `lifecycle_mode='task'`, status in `('not_started', 'in_progress')`

**Request**:
```
{
  reason?: string   max 500
}
```

**Response 200**: ActivityResponse ze statusem `cancelled`

**Emituje event**: `activities.activity.cancelled`

### 2.8 POST /api/activities/[id]/reopen

**Dozwolone**: tylko `lifecycle_mode='task'`, status=`completed`
(nie można reopenować `cancelled` — terminal state)

**Request**: `{}`

**Response 200**: ActivityResponse ze statusem `not_started`, `completedAt=null`

**Emituje event**: `activities.activity.updated`

### 2.9 PUT /api/activities/[id] — Update

**Request body** (Zod schema `activityUpdateSchema`): wszystkie pola z Create
jako opcjonalne, plus `id: uuid REQUIRED`.

**Ograniczenia**:
- `lifecycle_mode` jest **immutable** — nie można zmienić po stworzeniu
- `activity_type` jest immutable
- `external_id` + `external_provider` tylko przez system (nie przez UI user)
- `fact` activities: edycja zablokowana gdy `status='completed'` (Sprint 1: enforce przez API)
  Wyjątek: admin z `activities.manage` może edytować subject/notes

**Emituje event**: `activities.activity.updated`

---

## 3. Timeline Architecture

### 3.1 Dwie sekcje, dwa query patterns

**Sekcja ZAPLANOWANE** (Planned):

```
Query criteria:
  lifecycle_mode = 'task'
  status IN ('not_started', 'in_progress')
  deleted_at IS NULL
  (opcjonalnie: linked_entity_type + linked_entity_id)

Sort: due_at ASC NULLS LAST, created_at ASC
Limit: 10 (domyślnie — zaplanowane aktywności to krótka lista)
Paginacja: cursor na (due_at, created_at, id)
```

**Sekcja HISTORIA** (History):

```
Query criteria:
  (lifecycle_mode = 'fact')
  OR (lifecycle_mode = 'task' AND status IN ('completed', 'cancelled'))
  deleted_at IS NULL
  (opcjonalnie: linked_entity_type + linked_entity_id)

Sort: COALESCE(occurred_at, completed_at, created_at) DESC, id DESC
Limit: 25 (domyślnie — historia to długa lista z infinite scroll)
Paginacja: cursor na (coalesced_date, id)
```

### 3.2 Wydajność przy 100k+ aktywności

**Problem**: Customer z historią 5 lat + integracja O365 może mieć 100k+ aktywności.
Standardowe zapytania bez odpowiedniej strategii będą wolne.

**Rozwiązania**:

**A — Partial indexes z `WHERE deleted_at IS NULL`**

Wszystkie 6 indeksów w sekcji 1.3 są partial indexes.
Soft-deleted rekordy (mogą stanowić 30–40% tabeli po latach) wypadają z indeksów
→ rozmiar indeksu = tylko aktywne rekordy.

**B — Cursor zamiast offset**

Zapytanie z cursorem używa warunku `WHERE sort_key < $cursor_value`
→ baza danych używa B-tree index seek, nie full scan.
Czas zapytania jest O(log n) niezależnie od głębokości strony.

**C — Composite index pokrywający wszystkie kolumny filtra**

IDX-1 (`organization_id, tenant_id, linked_entity_type, linked_entity_id, deleted_at, due_at, occurred_at, created_at`) jest covering index dla timeline query.
PostgreSQL może obsłużyć zapytanie bez sięgania do głównej tabeli (index-only scan).

**D — COALESCE w sort key — uwaga**

`COALESCE(occurred_at, completed_at, created_at)` jako sort key nie może być
bezpośrednio indeksowany. Rozwiązanie: dodaj wygenerowaną kolumnę w Sprint 2:

```sql
-- Sprint 2 migration:
ALTER TABLE activities
  ADD COLUMN effective_date timestamptz
  GENERATED ALWAYS AS (COALESCE(occurred_at, completed_at, created_at)) STORED;

CREATE INDEX activities_history_timeline_idx
ON activities (organization_id, tenant_id, linked_entity_type, linked_entity_id, effective_date DESC, id DESC)
WHERE deleted_at IS NULL;
```

W Sprint 1: `ORDER BY COALESCE(occurred_at, completed_at, created_at) DESC`
jest akceptowalne przy < 10k rekordów per entity.

**E — Brak JOIN na ActivityLink w Sprint 1**

ActivityLink (wiele linków per aktywność) to Sprint 2. Sprint 1 używa tylko
`linked_entity_type + linked_entity_id` na głównej tabeli → zero JOIN w timeline query.

### 3.3 Real-time updates (DOM Event Bridge)

Wszystkie eventy `activities.activity.*` deklarują `clientBroadcast: true`.

Komponent `<ActivityTimeline>` nasłuchuje na eventy:
```
om:activities:activity:created
om:activities:activity:updated
om:activities:activity:completed
om:activities:activity:cancelled
om:activities:activity:deleted
```

Po otrzymaniu eventu: **nie refetchuj całej listy** — tylko uaktualnij/dodaj/usuń
konkretny rekord na podstawie `activityId` w payloadzie eventu.

### 3.4 Filtrowanie w timeline

**Filtry po stronie klienta** (nie wymagają round-trip do API):

Jeśli timeline załadował wszystkie aktywności dla entity (mały zbiór < 200),
filtrowanie można robić client-side bez nowych requestów.

**Filtry po stronie serwera** (dla entity z dużą liczbą aktywności):

Gdy `hasMore=true` na pierwszej stronie → filtry muszą być wysyłane jako query params
do API, a nie aplikowane client-side. `<ActivityTimeline>` powinien wykrywać ten przypadek
i przełączać się na server-side filtering.

**Dostępne filtry w UI (Sprint 1)**:

```
Filtr "Typ aktywności":
  Checkboxy dynamicznie generowane z getAllActivityTypes()
  (w Sprint 1: hardcoded built-in types email|meeting|task|call|note)

Filtr "Status":
  Zaplanowane | Zakończone | Anulowane

Filtr "Właściciel":
  Dropdown staff userów (opcjonalny)
```

### 3.5 Widget injection

`ActivityTimeline` jest wstrzykiwany jako widget do stron detalu encji.

**Injection spots Sprint 1**:

```typescript
// src/modules/activities/widgets/injection-table.ts
export const widgetInjections = [
  {
    widgetId: 'activities:timeline',
    spotId: 'detail:customers.person:sections',  -- strona klienta (osoby)
    position: 'append',
    priority: 10,
  },
  {
    widgetId: 'activities:timeline',
    spotId: 'detail:customers.company:sections', -- strona firmy
    position: 'append',
    priority: 10,
  },
  {
    widgetId: 'activities:timeline',
    spotId: 'detail:sales.order:sections',       -- strona zamówienia
    position: 'append',
    priority: 10,
  },
]
```

Widget `ActivityTimeline` otrzymuje w `context`:
```
{
  entityType: string    -- np. 'customers:person'
  entityId:   string    -- UUID rekordu
  scope:      { organizationId, tenantId }
}
```

**Problem koegzystencji z CustomerInteraction** (patrz Ryzyka §7.1):
W Sprint 1 ActivityTimeline jest nową sekcją PONIŻEJ istniejącej sekcji
CustomerInteraction. Nagłówek sekcji: **"Aktywności (nowe)"** z informacją
"Wkrótce zastąpi historię interakcji".

---

## 4. RBAC

### 4.1 Feature IDs

Plik `src/modules/activities/acl.ts`:

```
Feature ID                  Opis
────────────────────────────────────────────────────────────────────
activities.view             Podgląd aktywności (lista, detal)
activities.manage           Tworzenie, edycja, usuwanie aktywności
activities.complete         Oznaczanie aktywności jako zakończone
activities.cancel           Anulowanie aktywności
activities.view_private     Podgląd prywatnych aktywności cudzych
                            (domyślnie: tylko owner widzi prywatne)
────────────────────────────────────────────────────────────────────
```

### 4.2 defaultRoleFeatures (setup.ts)

```
superadmin: wszystkie features
admin:      activities.view, activities.manage, activities.complete,
            activities.cancel, activities.view_private
member:     activities.view, activities.manage, activities.complete,
            activities.cancel
viewer:     activities.view
```

**Po dodaniu features**: `yarn mercato auth sync-role-acls`

### 4.3 Visibility model — egzekucja w API

**Na poziomie query** (nie na poziomie aplikacji):

```sql
-- Użytkownik BEZ activities.view_private:
AND (
  visibility != 'private'
  OR owner_user_id = $current_user_id
)

-- Użytkownik Z activities.view_private:
-- Brak dodatkowego filtru visibility
```

API-key callers: traktowani jak `visibility='public'` only
(brak tożsamości użytkownika → fail-closed jak w channel-gmail).

### 4.4 Type-specific permissions — Sprint 2

W Sprint 1: wszystkie built-in typy używają globalnych `activities.view` / `activities.manage`.

W Sprint 2 (gdy activity-types.ts registry zostanie dodany):
```
if (typeDef.viewFeature && !user.hasFeature(typeDef.viewFeature)) {
  // filtruj ten typ z wyników
}
```

Architektura jest gotowa, implementacja w Sprint 2.

---

## 5. Model eventów

### 5.1 Deklaracja w `events.ts`

Plik `src/modules/activities/events.ts`:

```
Module ID: 'activities'

Eventy (createModuleEvents):
─────────────────────────────────────────────────────────────────────
ID: activities.activity.created
Label: Activity Created
Category: crud
clientBroadcast: true

ID: activities.activity.updated
Label: Activity Updated
Category: crud
clientBroadcast: true

ID: activities.activity.completed
Label: Activity Completed
Category: lifecycle
clientBroadcast: true

ID: activities.activity.cancelled
Label: Activity Cancelled
Category: lifecycle
clientBroadcast: true

ID: activities.activity.deleted
Label: Activity Deleted
Category: crud
clientBroadcast: true

ID: activities.activity.restored
Label: Activity Restored
Category: lifecycle
clientBroadcast: true
─────────────────────────────────────────────────────────────────────
```

### 5.2 Payload eventów

Każdy event niesie minimalny, stabilny payload:

```
ActivityEventPayload {
  activityId:       string   -- UUID aktywności
  activityType:     string   -- 'email' | 'task' | 'sales:quote_sent' | ...
  lifecycleMode:    string   -- 'fact' | 'task'
  organizationId:   string
  tenantId:         string
  linkedEntityType?: string
  linkedEntityId?:   string
  ownerUserId?:      string
  authorUserId?:     string
  externalProvider?: string

  -- Tylko dla completed / cancelled:
  previousStatus?:  string
  newStatus?:       string
  occurredAt?:      string   ISO 8601
}
```

**Zasada minimalizmu payloadu**: nie przekazuj pełnej encji Activity w evencie —
subskrybenci pobierają szczegóły przez API jeśli potrzebują.
Mały payload = mniej problemów ze zgodnością przy ewolucji schematu.

### 5.3 Emisja eventów — wzorzec

Eventy są emitowane **po** `withAtomicFlush` (poza blokiem atomowej transakcji):

```
// Pseudokod — nie kod implementacji
await withAtomicFlush(em, [
  () => { activity.status = 'completed'; activity.completedAt = new Date() },
], { transaction: true, label: 'activities.complete' })

// Po commicie:
await emitCrudSideEffects({
  eventId: 'activities.activity.completed',
  payload: { activityId: activity.id, ... },
})
// Invalidacja cache (Sprint 2, gdy cache zostanie dodany)
```

### 5.4 Subskrybenci Sprint 1

W Sprint 1 moduł `activities` nie ma własnych subskrybentów.
Subskrybują INNE moduły (np. notifications w Sprint 3).

---

## 6. Acceptance Criteria Sprint 1

### 6.1 Obowiązkowe (Definition of Done)

**API**:
- [ ] `POST /api/activities` tworzy Activity z lifecycle_mode='task', zwraca 201
- [ ] `POST /api/activities` tworzy Activity z lifecycle_mode='fact', zwraca 201
- [ ] `POST /api/activities` zwraca 409 gdy duplicate `external_id + external_provider`
- [ ] `GET /api/activities?entityType=customers:person&entityId={id}` zwraca listę z paginacją
- [ ] `GET /api/activities` respektuje cursor paginację (nextCursor w odpowiedzi)
- [ ] `PUT /api/activities/[id]` aktualizuje mutable pola
- [ ] `DELETE /api/activities/[id]` ustawia `deleted_at`, zwraca 200
- [ ] `POST /api/activities/[id]/complete` zmienia status na 'completed', zwraca ActivityResponse
- [ ] `POST /api/activities/[id]/cancel` zmienia status na 'cancelled'
- [ ] `POST /api/activities/[id]/complete` zwraca 400 dla lifecycle_mode='fact'
- [ ] `POST /api/activities/[id]/cancel` zwraca 409 gdy status już 'cancelled'

**RBAC**:
- [ ] GET bez zalogowania → 401
- [ ] GET z zalogowanym userem bez `activities.view` → 403
- [ ] POST z zalogowanym userem bez `activities.manage` → 403
- [ ] `visibility='private'` Activity nie widoczna dla innego usera (bez `activities.view_private`)
- [ ] `visibility='private'` Activity widoczna dla owner_user_id

**Encryption**:
- [ ] `subject` i `notes` są zaszyfrowane w bazie (weryfikacja: bezpośrednie zapytanie SQL nie zwraca plaintext)
- [ ] GET zwraca odszyfrowane `subject` i `notes`

**Multi-tenant**:
- [ ] Activity stworzone w tenantA niewidoczne dla usera tenantB (test z dwoma tenantami)

**Events**:
- [ ] `activities.activity.created` emitowany po POST
- [ ] `activities.activity.completed` emitowany po POST /complete
- [ ] `activities.activity.deleted` emitowany po DELETE

**Timeline Widget**:
- [ ] `<ActivityTimeline>` widoczny na `/backend/customers/[id]` (sekcja "Aktywności")
- [ ] `<ActivityTimeline>` widoczny na `/backend/sales/orders/[id]`
- [ ] Timeline pokazuje Planned (status in_progress/not_started) oddzielnie od History
- [ ] Filtrowanie po typie aktywności działa (email, meeting, task, call, note)
- [ ] Quick-add: formularz tworzenia nowej aktywności dostępny z timeline

**Build & Quality**:
- [ ] `yarn typecheck` bez błędów
- [ ] `yarn generate` bez ostrzeżeń — moduł odkryty
- [ ] `yarn build` bez błędów
- [ ] Unit testy dla Zod schemas i lifecycle state machine (≥ 80% coverage)
- [ ] `yarn db:generate` tworzy poprawną migrację dla encji Activity

### 6.2 Kryteria wydajnościowe

- [ ] `GET /api/activities?entityType=customers:person&entityId=X` ≤ 100ms dla entity z ≤ 1000 aktywności
- [ ] `POST /api/activities` ≤ 200ms (single insert z encryption)
- [ ] Timeline widget ładuje się bez CLS (Cumulative Layout Shift) — Suspense z `<LoadingMessage>`

### 6.3 Jak zweryfikować sukces

**Testy manualne (dev environment)**:

```
1. Utwórz aktywność typu 'task':
   POST /api/activities
   { activityType: 'task', lifecycleMode: 'task', subject: 'Test task',
     linkedEntityType: 'customers:person', linkedEntityId: '{valid_customer_id}' }
   → Oczekuj 201, id w odpowiedzi

2. Zakończ aktywność:
   POST /api/activities/{id}/complete
   → Oczekuj 200, status='completed', completedAt != null

3. Sprawdź timeline klienta:
   GET /backend/customers/{customer_id}
   → Oczekuj sekcję "Aktywności" z nową aktywnością

4. Weryfikuj szyfrowanie:
   SELECT subject FROM activities WHERE id = '{id}'
   → Oczekuj zaszyfrowany ciąg (nie 'Test task')

5. Weryfikuj multi-tenant isolation:
   Zaloguj się jako user drugiego tenanta
   GET /api/activities/{id}
   → Oczekuj 404 (nie 403 — nie ujawniamy faktu istnienia)
```

---

## 7. Ryzyka techniczne i problemy integracyjne

### 7.1 Koegzystencja z CustomerInteraction timeline

**Problem**: Na stronie klienta (`/backend/customers/[id]`) znajduje się już
istniejąca sekcja historii interakcji z `CustomerInteraction`. Po injektowaniu
`ActivityTimeline` widget, użytkownik zobaczy **dwie sekcje** — nową i starą.

**Mitygacja Sprint 1**:
- `ActivityTimeline` widget injektowany z nowym nagłówkiem: "Aktywności M365 / Nowe"
- `CustomerInteraction` sekcja pozostaje bez zmian
- Komunikat w nowej sekcji: "Ta sekcja docelowo zastąpi poniższą historię interakcji"

**Ryzyko**: Użytkownicy mogą być zdezorientowani.
**Plan**: Sprint 7–8 usuwa CustomerInteraction sekcję po bridge/migracji.

### 7.2 Encryption service — runtime dependency

**Problem**: `findWithDecryption` wymaga DI-resolved `tenantDataEncryptionService`.
Jeśli serwis nie jest poprawnie zarejestrowany w `di.ts`, wszystkie odczyty
zwrócą błąd w runtime — nie w compile time.

**Mitygacja**:
- Test integracyjny weryfikujący encrypt/decrypt round-trip w isolation
- `yarn dev` na czystej bazie: zweryfikuj że POST + GET nie zwraca encrypted gibberish
- Sprawdź że `tenantDataEncryptionService` jest dostępny w containerze
  przez dodanie logu w `di.ts` przy starcie

### 7.3 IDX-1 rozmiar — potential slow index creation

**Problem**: IDX-1 jest szerokim composite index z 8 kolumnami.
Na produkcyjnej tabeli z milionami rekordów, `CREATE INDEX CONCURRENTLY`
może trwać dziesiątki minut i blokować table locks.

**Mitygacja**:
- Sprint 1: tabela jest nowa — index creation jest natychmiastowa
- Produkcja po wdrożeniu: monitoring rozmiaru indeksu po 3 miesiącach sync O365
- Sprint 3: rozważyć partition table per organization_id jeśli IDX-1 > 10GB

### 7.4 COALESCE w sort key — no index support

**Problem**: `ORDER BY COALESCE(occurred_at, completed_at, created_at) DESC`
nie może bezpośrednio użyć indeksu → sequential scan na dużych zbiorach.

**Mitygacja Sprint 1**:
- Akceptowalne dla Sprint 1 (brak O365 sync → mała liczba rekordów)
- Sprint 2: dodać generated column `effective_date` + dedykowany index

**Próg alertu**: jeśli query planner pokazuje Seq Scan dla > 1000 rekordów,
Sprint 2 musi być przyspieszony.

### 7.5 Generator ordering — activity-types.ts discovery

**Problem**: W Sprint 1 `activity-types.ts` NIE jest odkrywany przez generator
(to Sprint 2). W Sprint 1 typy są hardcoded w komponencie timeline.

**Ryzyko**: Jeśli developerzy zaimplemntują activity-types.ts discovery częściowo
w Sprint 1, generator może nie odkryć pliku i typy nie pojawią się w registry.

**Mitygacja**: Jasna dokumentacja: activity-types.ts auto-discovery = Sprint 2.
Sprint 1: typy jako `const BUILT_IN_ACTIVITY_TYPES` w pliku komponentu.

### 7.6 Cursor pagination przy zmianie sort key

**Problem**: Jeśli `due_at` aktywności zostanie zmieniony między stronami paginacji,
cursor oparty na `due_at` może pominąć lub zduplikować tę aktywność.

**Mitygacja**:
- Cursor używa zawsze `(sort_key, id)` — `id` jako tiebreaker eliminuje duplikaty
- `id` jest immutable (UUID, nigdy się nie zmienia)
- Akceptowalny edge case: po edycji `due_at` użytkownik może nie widzieć aktywności
  do czasu odświeżenia strony

### 7.7 Injection spot IDs — weryfikacja z istniejącymi modułami

**Problem**: Injection spot IDs (`detail:customers.person:sections`,
`detail:sales.order:sections`) muszą dokładnie pasować do zadeklarowanych
spot IDs w modułach `customers` i `sales`. Literówka = widget nie pojawia się.

**Mitygacja**:
- Przed Sprint 1: zweryfikować dokładne spot IDs przez grep w `customers` module:
  ```
  grep -r "spotId" node_modules/@open-mercato/core/src/modules/customers/
  grep -r "spotId" node_modules/@open-mercato/core/src/modules/sales/
  ```
- Jeśli spot IDs nie istnieją → konieczne sprawdzenie dokumentacji lub
  kontakt z maintainerem frameworku

### 7.8 `withAtomicFlush` + encryption service

**Problem**: Jeśli `withAtomicFlush` jest używany z encryption service wewnątrz
bloku transakcji, a encryption service robi zewnętrzne wywołania (KMS),
transakcja może być trzymana otwarta zbyt długo.

**Mitygacja**:
- Pre-encrypt przed wejściem w `withAtomicFlush`
- Lub: użyj trybu `{ transaction: false }` dla single-entity mutations
- Wzorzec z `customers` module: sprawdzić jak CustomerInteraction command
  obsługuje encrypted fields w transakcji

---

## 8. Struktura plików modułu (Sprint 1)

```
src/modules/activities/
├── index.ts                              -- module metadata
├── activity-types.ts                     -- built-in types (hardcoded, Sprint 1)
│
├── data/
│   ├── entities.ts                       -- Activity entity (@mikro-orm/decorators/legacy)
│   └── validators.ts                     -- Zod: activityCreateSchema, activityUpdateSchema
│
├── api/
│   ├── route.ts                          -- GET list + POST create
│   ├── [id]/
│   │   ├── route.ts                      -- GET one + PUT + DELETE
│   │   ├── complete/route.ts             -- POST lifecycle
│   │   ├── cancel/route.ts               -- POST lifecycle
│   │   ├── reopen/route.ts               -- POST lifecycle
│   │   └── restore/route.ts              -- POST soft-delete restore
│   └── openapi.ts                        -- OpenAPI spec
│
├── backend/
│   ├── page.tsx + page.meta.ts          -- Lista aktywności (/backend/activities)
│   └── [id]/
│       └── page.tsx + page.meta.ts      -- Detal aktywności
│
├── widgets/
│   ├── injection/
│   │   └── timeline/
│   │       ├── widget.ts                 -- widget metadata
│   │       └── widget.client.tsx         -- <ActivityTimeline> component
│   └── injection-table.ts               -- customer:person, customer:company, sales:order
│
├── migrations/
│   └── Migration_YYYYMMDD_activity.ts   -- CREATE TABLE activities + indeksy
│
├── events.ts                             -- createModuleEvents
├── acl.ts                               -- feature IDs
├── setup.ts                             -- defaultRoleFeatures
├── di.ts                                -- Awilix registrations
└── encryption.ts                        -- defaultEncryptionMaps (subject, notes, location)
```

---

## 9. Zależności i wymagania środowiskowe

| Zależność | Wersja | Uwagi |
|-----------|--------|-------|
| `@open-mercato/shared` | workspace | `withAtomicFlush`, `makeCrudRoute`, `findWithDecryption` |
| `@open-mercato/ui` | workspace | `DataTable`, `CrudForm`, widget components |
| `@mikro-orm/decorators/legacy` | >= 7.0 | Dekoratory encji |
| Brak zewnętrznych NPM zależności | | Sprint 1 nie wymaga SDK zewnętrznych |

**Po implementacji**:
```bash
yarn generate        # odkrycie modułu
yarn db:generate     # SQL migration dla Activity entity
# Po review SQL:
yarn db:migrate      # aplikacja migracji (po potwierdzeniu przez usera)
yarn mercato auth sync-role-acls  # propagacja nowych features
```

---

## Changelog

| Data | Zmiana |
|------|--------|
| 2026-06-15 | Initial technical specification — ready for Sprint 1 implementation |
