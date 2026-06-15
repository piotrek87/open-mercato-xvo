# CustomerInteraction vs. Activity — Analiza Architektoniczna

**Data**: 2026-06-15
**Cel**: Wybrać jedno źródło prawdy dla emaili, spotkań, zadań i aktywności CRM
**Horyzont**: 3 lata produktu

---

## 1. Stan faktyczny — co już ma CustomerInteraction

Przed porównaniem wariantów ważne jest, że `CustomerInteraction` to nie jest prosty model.
Po głębokiej analizie kodu okazuje się, że ma już prawie wszystko, czego potrzeba:

| Cecha | CustomerInteraction | Nowy Activity |
|-------|--------------------|--------------:|
| `interactionType` — open text (nie enum) | ✅ rozszerzalne | ✅ |
| `linkedEntities` JSONB — cross-entity linki | ✅ już jest | ✅ |
| `externalMessageId` + `channelProviderKey` | ✅ email sync wbudowany | trzeba dodać |
| `participants` JSONB | ✅ | trzeba dodać |
| `recurrenceRule` (iCal RRULE) | ✅ | trzeba dodać |
| `scheduledAt` / `occurredAt` / `durationMinutes` | ✅ | ✅ |
| `ownerUserId` / `authorUserId` | ✅ | ✅ |
| `visibility` (`private`/`shared`/`team`/`public`) | ✅ | trzeba projektować |
| `guestPermissions` JSONB | ✅ | trzeba dodać |
| `pinned` | ✅ | trzeba dodać |
| Custom fields (ce.ts, entity ID gotowy) | ✅ | trzeba wdrożyć |
| Encryption (title + body) | ✅ | trzeba wdrożyć |
| Multi-tenant scoping | ✅ | ✅ |
| Search + query index | ✅ | trzeba wdrożyć |
| Events (created/completed/canceled/reverted) | ✅ | trzeba projektować |
| Undo/redo commands | ✅ | trzeba projektować |
| Email dedup (UNIQUE index) | ✅ | trzeba dodać |
| Email visibility gate (private/shared) | ✅ | trzeba projektować |
| Conflict detection API (`/conflicts`) | ✅ | trzeba dodać |
| Response enrichers | ✅ | ✅ |

**Wniosek**: `CustomerInteraction` jest już de facto modelem Activity dla strefy klientów.
To nie jest prosty model do zastąpienia. Zbudowanie równoważnego nowego modelu
to minimum 6-8 tygodni pracy.

---

## 2. Fundamentalne ograniczenie CustomerInteraction

Jest **jedna** twarda blokada, która uniemożliwia użycie CustomerInteraction jako
uniwersalnego modelu aktywności:

```
CustomerInteraction.entity → CustomerEntity    NOT NULL
```

**Każda interakcja musi mieć rodzica w module customers (osobę lub firmę).**

Konsekwencje:

- ❌ Nie można zarejestrować zadania niezwiązanego z żadnym klientem
- ❌ Spotkanie wewnętrzne (bez klienta) nie ma gdzie trafić
- ❌ Aktywność powiązana wyłącznie z zamówieniem (bez przypisanego klienta) — brak miejsca
- ❌ Aktywność systemowa (np. "pipeline zadania automatyzacji") — brak miejsca

Pytanie do weryfikacji przed decyzją:
**Jaki % aktywności w Twoim produkcie NIE będzie miał powiązanego klienta?**

- Jeśli ~0% → CustomerInteraction jako podstawa jest wystarczające
- Jeśli >10% → nowy moduł Activity jest uzasadniony

---

## 3. Trzy realistyczne ścieżki

### Ścieżka 1 — Eject + CustomerInteraction staje się Activity

**Mechanizm**: `yarn mercato eject customers` → modyfikacja encji:
- `entity` → nullable (breaking migration)
- Dodanie `linkedEntityType` + `linkedEntityId` jako główny polimorficzny link
- Dodanie `externalId` + `externalProvider` kolumn
- Rename encji i migracja danych

```
PRZED:
CustomerInteraction.entity_id → CustomerEntity (NOT NULL)

PO:
CustomerInteraction (przemianowany na Activity)
├── entity_id: nullable (opcjonalny link do CustomerEntity)
├── linked_entity_type: string (nowy — polimorficzny)
├── linked_entity_id: UUID (nowy — polimorficzny)
├── external_id: string (nowy — O365 event ID, Gmail ID)
└── external_provider: string (nowy — 'office365', 'gmail', ...)
```

**Plusy:**
- Jedno źródło prawdy od pierwszego dnia
- Wszystkie istniejące funkcje (encryption, custom fields, events) zachowane
- Zero duplikacji danych
- Najczystsza architektura docelowa

**Minusy:**
- ❌ Eject = stały fork core module — każdy upgrade frameworka wymaga ręcznego merge'a
- ❌ Breaking migration — nullable na NOT NULL kolumnie wymaga zatrzymania serwisu lub multi-step deployment
- ❌ Ryzyko regresji w istniejącej logice klientów (widoki, eventy, wyszukiwanie)
- ❌ `customers` to jeden z największych modułów core — fork niesie ogromne ryzyko długoterminowe

**Verdict**: ✅ Architektonicznie najczystsza, ale ❌ **zbyt ryzykowna dla 3-letniego horyzontu**.
Upgrade framework co kwartał × 12 = 12 ręcznych merge'ów na ogromnym module.

---

### Ścieżka 2 — Nowy moduł `activities` jako uniwersalne źródło prawdy

**Mechanizm**: Nowa encja `Activity` w `src/modules/activities/` z **opcjonalnym**
linkiem do dowolnej encji. `CustomerInteraction` zostaje, ale stopniowo deprecatowany.

```
Activity (nowy moduł)
├── id: UUID
├── organization_id, tenant_id
├── activity_type: string (open text — kompatybilne z interactionType)
├── subject: string (odpowiednik title)
├── notes: string ENCRYPTED (odpowiednik body)
├── status: not_started | in_progress | completed | cancelled
├── priority, due_at, completed_at, occurred_at
├── duration_minutes, location, all_day, recurrence_rule
├── author_user_id, owner_user_id, participants: JSONB
├── linked_entity_type: string (nullable — opcjonalny)
├── linked_entity_id: UUID (nullable — opcjonalny)
├── external_id: string (O365 event ID, Gmail message ID)
├── external_provider: string ('office365', 'gmail', ...)
├── sync_direction: 'inbound'|'outbound'|'bidirectional'|null
├── last_synced_at: Date
├── custom fields via ce.ts
└── deleted_at, created_at, updated_at
```

**Problem do rozwiązania: jak uniknąć duplikacji?**

Kluczowa zasada: **jeden write path, dwa read paths (przez okres przejściowy)**.

```
WRITE (od dnia 1):
  POST /api/activities → tworzy Activity (nowy moduł)
  POST /api/interactions → [DEPRECATED] przekierowuje przez API interceptor → tworzy Activity

READ (przez okres przejściowy ~6 miesięcy):
  Timeline klienta = Activity(linked_entity_type='customers:person', linked_entity_id=X)
                   + CustomerInteraction (historyczne rekordy z enrichera)

READ (po migracji):
  Timeline klienta = tylko Activity
```

**Mechanizm interceptora** (dzień 1, bez ejektu):

```typescript
// src/modules/activities/api/interceptors.ts
export const interceptors: ApiInterceptor[] = [{
  method: 'POST',
  path: '/api/interactions',
  position: 'before',
  handler: async (req, ctx) => {
    // Przekieruj do Activity — zwróć odpowiedź jakby to była interakcja
    const activity = await ctx.container.resolve('activityService').create({
      activityType: req.body.interactionType,
      linkedEntityType: 'customers:entity',
      linkedEntityId: req.body.entityId,
      ...mapInteractionToActivity(req.body),
    })
    return { intercepted: true, response: mapActivityToInteraction(activity) }
  }
}]
```

**Migracja danych** (jednorazowa, po 6 miesiącach):

```sql
INSERT INTO activities (id, organization_id, tenant_id, activity_type, subject, ...)
SELECT id, organization_id, tenant_id, interaction_type, title, ...
FROM customer_interactions
WHERE deleted_at IS NULL;

-- Po weryfikacji:
ALTER TABLE customer_interactions ADD COLUMN migrated_to_activity_id UUID;
UPDATE customer_interactions SET migrated_to_activity_id = activities.id
  WHERE customer_interactions.id = activities.external_id
  AND activities.external_provider = 'legacy_interaction';
```

**Plusy:**
- ✅ Brak ejektu — framework upgrades bez ryzyka
- ✅ Stopniowa migracja — zero downtime
- ✅ Jedno źródło prawdy od dnia 1 (dla nowych zapisów)
- ✅ `CustomerInteraction` zachowany dla historycznych danych i wstecznej kompatybilności API

**Minusy:**
- Przez 6 miesięcy: dwa read paths (enricher bridge) — lekka złożoność
- Wymaga starannego API interceptora na `/api/interactions`
- Nowy moduł to ~3 tygodnie implementacji

**Verdict**: ✅ **Rekomendowane dla 3-letniego horyzontu**.

---

### Ścieżka 3 — CustomerInteraction rozszerzone bez ejektu (via UMES)

**Mechanizm**: Bez ejektu, bez nowego modułu. Rozszerz CustomerInteraction przez:
- Custom fields: `external_id`, `external_provider`, `sync_direction` (za darmo, bez migracji)
- API interceptors: logika sync O365 ↔ CustomerInteraction
- Response enrichers: wzbogac odpowiedzi API o dane z O365
- Subscribers: reaguj na eventy `customers.interaction.*` do synchronizacji

```
CustomerInteraction + UMES extensions:
├── [custom field] external_id: string
├── [custom field] external_provider: string
├── [custom field] sync_direction: string
├── linkedEntities JSONB: już obsługuje multi-entity linki
└── interactionType: open text, dodaj 'meeting_o365', 'email_o365' etc.
```

**Co tracimy** vs pełnego Activity:
- Nadal wymagany `entity_id` → CustomerEntity (NOT NULL) — nie obsłużysz aktywności bez klienta
- Custom fields są przechowywane osobno (performance: dodatkowy JOIN przy każdym odczycie)
- Brak `external_id` jako indeksowanej kolumny → dedup musi działać przez custom fields (wolniejsze)
- Nie da się dodać composite UNIQUE index na custom fields (nie można zagwarantować dedup)

**Plusy:**
- ✅ Zero implementacji — działa od razu
- ✅ Brak ryzyka
- ✅ Wszystkie funkcje CustomerInteraction bez zmiany

**Minusy:**
- ❌ Nie rozwiązuje fundamentalnego ograniczenia (entity NOT NULL)
- ❌ Custom fields jako `external_id` = brak unikalnego indexu = możliwe duplikaty przy sync
- ❌ Długoterminowy dług — po roku masz CustomerInteraction z custom fields `external_id`,
  `external_provider` które nie są "first-class" — trudne do utrzymania
- ❌ Nie nadaje się do aktywności niezwiązanych z klientami (spotkania wewnętrzne, zadania ad hoc)

**Verdict**: ✅ Dobra opcja na **3 miesiące** (O365 MVP szybki), ❌ nie dla 3-letniego horyzontu.

---

## 4. Docelowy model na 3 lata — rekomendacja

### Decyzja: Ścieżka 2, ale z precyzyjnym podziałem odpowiedzialności

**Nie chodzi o "zastąpienie" CustomerInteraction. Chodzi o podział domeny.**

```
┌─────────────────────────────────────────────────────────────┐
│           ACTIVITIES module (nowe, 3 lata)                  │
│           "Wszystko co dzieje się w firmie"                  │
│                                                             │
│  Activity { type, subject, status, due_at, owner, ... }     │
│  ├── linked_entity_type: nullable (opcjonalne)              │
│  ├── linked_entity_id:   nullable (opcjonalne)              │
│  ├── external_id + external_provider (O365, Gmail, ...)     │
│  └── Custom fields (ce.ts)                                  │
│                                                             │
│  Zakres: email | meeting | task | call | note               │
│  Powiązanie: customer | order | deal | lead | BRAK          │
└───────────────────┬─────────────────────────────────────────┘
                    │ jest "widokiem" / "bogatszym" widokiem
                    ▼
┌─────────────────────────────────────────────────────────────┐
│        CUSTOMERS module (bez ejektu, core zostaje)          │
│        CustomerInteraction                                  │
│                                                             │
│  Rola w architekturze docelowej:                            │
│  → DEPRECATED jako write endpoint (po 6 miesiącach)        │
│  → zachowany jako READ endpoint (wsteczna kompatybilność)  │
│  → historyczne rekordy pozostają w tabeli (brak migracji   │
│    dla starszych niż 12 miesięcy danych)                   │
│                                                             │
│  Timeline klienta = Activity WHERE linked_entity=customer   │
│  + CustomerInteraction (historyczne, przez enricher bridge)│
└─────────────────────────────────────────────────────────────┘
```

### Jak uniknąć duplikacji — zasada jednego write path

**Reguła bezwzględna: od dnia 1 wdrożenia modułu activities, KAŻDY nowy zapis
idzie TYLKO przez activities module. CustomerInteraction = read-only legacy.**

```
DZIEŃ 0 (przed activities module):
  POST /api/interactions → CustomerInteraction

DZIEŃ 1 (po wdrożeniu activities module):
  POST /api/activities   → Activity (new)
  POST /api/interactions → API interceptor → Activity (stary endpoint, nowy write path)

  GET /api/interactions  → odpowiada z Activity WHERE legacy_source='customers'
                           + historyczne CustomerInteraction (przez enricher)

PO 6 MIESIĄCACH (data migration):
  Jednorazowy skrypt: CustomerInteraction → Activity (z external_provider='legacy_interaction')
  GET /api/interactions → odpowiada TYLKO z Activity (CustomerInteraction = empty table practically)
  
PO 12 MIESIĄCACH:
  CustomerInteraction = READ ONLY, stara tabela = archiwum
  POST /api/interactions = 410 Gone z linkiem do /api/activities
```

---

## 5. Diagram modelu docelowego (3 lata)

```
JEDNA TABELA: activities (Activity entity)
┌────────────────────────────────────────────────────────┐
│ id, org_id, tenant_id                                  │
│                                                        │
│ activity_type ──────── open text (nie enum!)           │
│   'email'              ← O365 mail, Gmail              │
│   'meeting'            ← O365 calendar event          │
│   'task'               ← native task, O365 To-Do       │
│   'call'               ← phone call log                │
│   'note'               ← free text note                │
│   '[custom]'           ← user-defined via dictionaries │
│                                                        │
│ subject (VARCHAR, ENCRYPTED)                           │
│ notes   (TEXT, ENCRYPTED)                              │
│                                                        │
│ status: not_started → in_progress → completed          │
│                     ↘ cancelled                        │
│                                                        │
│ due_at, completed_at, occurred_at                      │
│ duration_minutes, location, all_day, recurrence_rule   │
│ priority, pinned, visibility                           │
│                                                        │
│ author_user_id  (FK → staff)                           │
│ owner_user_id   (FK → staff)                           │
│ participants    (JSONB)                                │
│                                                        │
│ ── ENTITY LINK (nullable = niezwiązane z obiektem) ──  │
│ linked_entity_type: string | NULL                      │
│   'customers:person'     'customers:company'           │
│   'customers:deal'       'sales:order'                 │
│   'catalog:product'      [dowolny moduł]               │
│ linked_entity_id: UUID | NULL                          │
│                                                        │
│ ── EXTERNAL SYNC ────────────────────────────────────  │
│ external_id: string | NULL  (O365 eventId, Gmail ID)   │
│ external_provider: string | NULL  ('office365', ...)   │
│ sync_direction: 'in'|'out'|'both'|NULL                 │
│ last_synced_at: Date | NULL                            │
│                                                        │
│ ── LEGACY BRIDGE ────────────────────────────────────  │
│ legacy_interaction_id: UUID | NULL  (FK historical)    │
│                                                        │
│ deleted_at, created_at, updated_at                     │
└────────────────────────────────────────────────────────┘

INDEKSY:
  (org_id, tenant_id, linked_entity_type, linked_entity_id, status)
  (org_id, tenant_id, owner_user_id, status, due_at)
  (org_id, tenant_id, activity_type, status)
  UNIQUE (external_id, external_provider, org_id) WHERE external_id IS NOT NULL
  (org_id, tenant_id, linked_entity_type, linked_entity_id, occurred_at)

TABELA POMOCNICZA: activity_links
  (wiele powiązań: Activity → N encji różnych typów)
  ├── activity_id → Activity
  ├── entity_type: string
  ├── entity_id: UUID
  └── link_role: 'primary' | 'cc' | 'related'
```

---

## 6. Status CustomerInteraction w modelu docelowym

| Faza | CustomerInteraction.write | CustomerInteraction.read | Timeline klienta |
|------|--------------------------|--------------------------|-----------------|
| **Teraz** | ✅ główny write path | ✅ główny read path | CustomerInteraction |
| **Sprint 1-2** (moduł activities) | API interceptor → Activity | ✅ (legacy) | Activity + enricher bridge |
| **Miesiąc 6** (data migration) | ❌ deprecated | ✅ read-only archiwum | Activity only |
| **Miesiąc 12** | ❌ 410 Gone | ❌ archiwum migrowane | Activity only |
| **Rok 3** | ❌ usunięte | ❌ | Activity only |

**CustomerInteraction nie zostaje ani "adapterem" ani "widokiem".**
Zostaje stopniowo zastąpione przez Activity — ale bezpiecznie, bez ejektu, bez przestoju.

---

## 7. Co z O365 w tym modelu?

Odpowiedź na pierwotne pytanie o integrację:

**Email (O365 → OM)**:
```
Graph /me/messages → channel-office365 ChannelAdapter
  → communication_channels hub (ExternalMessage)
  → activities subscriber: tworzy Activity {
      activity_type: 'email',
      external_id: graphMessageId,
      external_provider: 'office365',
      linked_entity_type: 'customers:person',  // jeśli znany kontakt
      linked_entity_id: resolvedCustomerId,     // może być null
    }
```

**Calendar (O365 → OM)**:
```
Graph /me/calendarView → channel-office365 CalendarSyncWorker
  → upsert Activity {
      activity_type: 'meeting',
      external_id: graphEventId,
      external_provider: 'office365',
      UNIQUE constraint chroni przed duplikatami
    }
```

**Meeting (OM → O365)**:
```
POST /api/activities { activity_type: 'meeting', ... }
  → event: activities.activity.created
  → subscriber: GET user's O365 credentials → POST /me/events
  → update Activity.external_id = graphEventId
```

---

## 8. Podsumowanie — odpowiedzi na pytania z zadania

**Q: Czy Activity powinno zastąpić CustomerInteraction?**
→ **Tak, docelowo tak. Ale stopniowo, nie nagle.** Activity staje się
  jedynym źródłem prawdy. CustomerInteraction jest deprecatowany po 6 miesiącach.

**Q: Co dzieje się z CustomerInteraction?**
→ **Nie jest usuwane natychmiast. Nie staje się adapterem (zbyt duże ryzyko).**
  Poprawna sekwencja:
  1. Zostaje (read-only legacy) przez 6 miesięcy
  2. Jest migrowane jednorazowym skryptem do Activity
  3. Po roku: 410 Gone na write endpoints, tabela = archiwum
  4. Po 3 latach: usunięte (opcjonalnie — tabela może pozostać jako archiwum)

**Q: Jak uniknąć przechowywania emaila/taska/spotkania w dwóch miejscach jednocześnie?**
→ **Jeden write path od dnia 1.** API interceptor na POST /api/interactions
  przekierowuje do Activity. READ path = enricher bridge przez 6 miesięcy.
  Po migracji danych = tylko Activity. Duplikacja jest niemożliwa bo interceptor
  przejmuje wszystkie nowe zapisy.

**Q: Czy CustomerInteraction można rozszerzyć do roli Activity?**
→ **Technicznie tak (Ścieżka 3), ale tylko dla aktywności powiązanych z klientami.**
  `entity: CustomerEntity NOT NULL` jest twardą blokadą. Eject rozwiązuje ten problem,
  ale koszt długoterminowy (ręczne merge'e frameworka) jest zbyt wysoki.
  Nowy moduł activities = lepszy wybór na 3-letni horyzont.

---

## 9. Rekomendacja finalna

```
Nie ejectuj customers module.
Zbuduj activities module jako nowe, czyste źródło prawdy.
CustomerInteraction deprecatuj stopniowo przez API interceptor.
Jedna tabela, jeden write path, dwa read paths przez 6 miesięcy.
```

Sekwencja implementacji:

```
Sprint 1-2:  activities moduł — encja, CRUD, eventy, RBAC, search
Sprint 3:    Activity timeline widget (customers page, sales order page)
Sprint 4:    API interceptor na POST /api/interactions → Activity
             Enricher bridge: GET /api/interactions = Activity + legacy CustomerInteraction
Sprint 5-6:  channel-office365 — OAuth2 + email ChannelAdapter
Sprint 7:    channel-office365 — Calendar sync worker
Sprint 8:    Data migration script (CustomerInteraction → Activity)
Sprint 9+:   O365 Tasks sync, Google Calendar (reuse activities module)
```

---

## Changelog

| Data | Zmiana |
|------|--------|
| 2026-06-15 | Dokument stworzony po deep-dive w CustomerInteraction |
