# Activity Extensibility Architecture
# — Activity jako przyszły framework package OpenMercato

**Data**: 2026-06-15
**Status**: Rekomendacja architektoniczna
**Kontekst**: Projektowanie Activity jako `@open-mercato/activities` —
             modułu platformowego z pełną rozszerzalnością przez zewnętrzne moduły
             (Microsoft 365, Google Workspace, sales, catalog i inne)

---

## 1. Pytanie fundamentalne: czym jest Activity?

Zanim odpowiemy na pytania o rozszerzalność, trzeba ustalić model mentalny.
Activity nie pasuje do żadnej z klasycznych kategorii:

```
Event Store              Activity Feed            CRM Activity Model
(immutable, append-only) (real-time, paginated)   (mutable lifecycle)
  "co się stało"           "co się dzieje"          "co zrobić"
  ✓ email received         ✓ timeline display       ✓ tasks/meetings
  ✓ payment made           ✓ real-time updates      ✓ assign/complete
  ✗ nie obsługuje zadań    ✗ brak reguł biznesowych ✗ nie obsługuje faktów
```

**Rekomendacja: "Contextual Activity Journal"** — nowa kategoria, hybryda wszystkich trzech.

> Wszystko istotne, co wydarzyło się lub ma się wydarzyć w kontekście relacji biznesowej —
> niezależnie od tego, czy pochodzi z zewnętrznej integracji, działania użytkownika
> czy automatyzacji systemowej.

Kluczowy insight: aktywności mają **dwa fundamentalnie różne tryby życia**:

```
FAKT (fact)                         PLAN (task)
──────────────────────────────────  ────────────────────────────────────
Immutable po created_at             Mutable lifecycle
"Jan wysłał email o 14:32"          "Jan ma spotkanie jutro o 10:00"
Pochodzi z zewnątrz lub systemu     Tworzone przez użytkownika
Nie edytujemy faktów historycznych  Edytujemy, przekładamy, anulujemy
Odpowiednik Event Store             Odpowiednik CRM Activity Model
```

Jedno pole `lifecycle_mode: 'fact' | 'task'` na encji `Activity` determinuje
całe zachowanie — uprawnienia edycji, dostępne akcje w UI, logikę sync.
Jedna tabela, dwa tryby.

---

## 2. Typy aktywności — rejestr, nie enum

### 2.1 Dlaczego nie enum

Hardcoded enum w core oznacza, że każdy nowy typ (`ShipmentActivity`, `AIActivity`)
wymaga modyfikacji `@open-mercato/activities` package. To narusza zasadę otwarte-zamknięte
i blokuje niezależny rozwój modułów.

OM rozwiązuje identyczny problem dla powiadomień przez **plik deklaracyjny
auto-odkrywany przez generator**. Activity powinna zastosować ten sam wzorzec.

### 2.2 Trójwarstwowy model typów

```
WARSTWA 1 — Typy wbudowane (core package)
  Definiowane w @open-mercato/activities/src/activity-types.ts
  email | meeting | task | call | note
  Zawsze dostępne, nie można ich usunąć

WARSTWA 2 — Typy rejestrowane przez moduły
  Definiowane w <module>/activity-types.ts
  Auto-odkrywane przez generator → activity-types.generated.ts
  Przykłady: sales:quote_sent | sales:payment_received | channel_office365:calendar_sync

WARSTWA 3 — Typy użytkownika (dictionary-backed)
  Przechowywane w tabeli dictionaries (już istnieje w OM)
  Konfigurowane per-tenant przez admina w UI
  Przykłady: "Wizyta u klienta", "Demo produktowe", "Szkolenie"
  Fallback ikona + kolor z DictionaryEntry
```

### 2.3 Kształt ActivityTypeDefinition

Wzorowany bezpośrednio na `NotificationTypeDefinition` (sprawdzony w frameworku):

```
ActivityTypeDefinition {
  id:           string     -- 'email' | 'sales:quote_sent' — globally unique
  moduleId:     string     -- kto deklaruje ten typ ('activities' | 'sales')
  label:        string     -- i18n key (np. 'activities.types.email')
  icon:         string     -- lucide-react icon name: 'Mail' | 'CalendarDays' | 'Phone'
  color?:       string     -- semantic token: 'text-status-info-icon' (opcjonalne)

  lifecycleMode: 'fact' | 'task'
    -- 'fact' = immutable po occurred_at, nie edytowalny przez UI
    -- 'task' = pełny lifecycle: not_started → in_progress → completed | cancelled

  capabilities: {
    hasDueDate?:       boolean   -- czy pokazać pole "Termin"
    hasStatus?:        boolean   -- czy ma lifecycle state machine
    hasOwner?:         boolean   -- czy przypisywalne do użytkownika
    hasParticipants?:  boolean   -- czy obsługuje uczestników
    hasRecurrence?:    boolean   -- czy obsługuje cykl (RRULE)
    hasExternalSync?:  boolean   -- czy pochodzi z zewnętrznej integracji
    hasLocation?:      boolean   -- czy ma pole "Lokalizacja"
    hasBody?:          boolean   -- czy ma pole "Treść/Opis"
  }

  -- RBAC: jeśli nie podano, fallback do globalnych 'activities.view' / 'activities.manage'
  viewFeature?:    string   -- np. 'sales.activities.view'
  createFeature?:  string   -- np. 'sales.activities.manage'

  -- Filter bar w timeline
  filterLabel?:   string   -- etykieta w filtrze (fallback: label)
  filterIcon?:    string   -- ikona w filtrze (fallback: icon)

  -- Quick actions na karcie aktywności
  actions?: Array<{
    id:          string
    label:       string    -- i18n key
    icon:        string    -- lucide-react
    variant:     'default' | 'outline' | 'ghost' | 'destructive'
    feature?:    string    -- opcjonalny RBAC gate
    condition?:  'when_planned' | 'when_completed' | 'when_overdue' | 'always'
  }>

  primaryActionId?: string  -- domyślna akcja po kliknięciu karty
}
```

### 2.4 Auto-odkrywanie przez generator

Wzorzec identyczny z `notifications.ts`:

```
Moduł deklaruje:         <module>/activity-types.ts
Generator odkrywa:       .mercato/generated/activity-types.generated.ts
Lookup function:         getActivityType(id: string): ActivityTypeDefinition | undefined
Registry:                getAllActivityTypes(): ActivityTypeDefinition[]
```

Generator skanuje wszystkie `activity-types.ts` w zainstalowanych modułach,
spłaszcza tablice definicji i eksportuje zagregowany rejestr.

---

## 3. Jak moduł dodaje własny typ aktywności

### 3.1 Przykład: moduł `sales` dodaje QuoteActivity i PaymentActivity

**Krok 1**: Plik `src/modules/sales/activity-types.ts`

```
export const activityTypes: ActivityTypeDefinition[] = [
  {
    id: 'sales:quote_sent',
    moduleId: 'sales',
    label: 'sales.activities.quoteSent',
    icon: 'FileText',
    lifecycleMode: 'fact',
    capabilities: { hasExternalSync: false, hasBody: true },
    viewFeature: 'sales.view',
    actions: [
      { id: 'view_quote', label: 'sales.activities.viewQuote', icon: 'ExternalLink', condition: 'always' }
    ],
    primaryActionId: 'view_quote',
  },
  {
    id: 'sales:payment_received',
    moduleId: 'sales',
    label: 'sales.activities.paymentReceived',
    icon: 'CreditCard',
    lifecycleMode: 'fact',
    capabilities: { hasExternalSync: false },
    viewFeature: 'sales.view',
  },
]
```

**Krok 2**: Plik `src/modules/sales/activity-types.client.ts` (renderery UI)

```
export const activityTypeRenderers: ActivityTypeClientRenderers = {
  'sales:quote_sent':       () => import('./components/QuoteSentActivityCard'),
  'sales:payment_received': () => import('./components/PaymentReceivedActivityCard'),
}
-- Lazy import = code splitting — karta ładuje się tylko jeśli typ jest widoczny
```

**Krok 3**: `yarn generate` — generator odkrywa plik, dodaje do rejestru

**Krok 4**: W logice modułu `sales`, przy wysyłaniu oferty:

```
// Subscriber on sales.quote.sent event:
await activityService.create({
  activityType: 'sales:quote_sent',
  lifecycleMode: 'fact',
  subject: `Oferta ${quote.number} wysłana`,
  occurredAt: new Date(),
  linkedEntityType: 'customers:person',
  linkedEntityId: quote.contactPersonId,
  linkedEntityType2: 'sales:order',  // opcjonalny drugi link
  linkedEntityId2: quote.orderId,
  source: { type: 'sales:quote', id: quote.id },  // skąd pochodzi
})
```

**Krok 5**: Aktywność pojawia się automatycznie w:
- Timeline klienta (dzięki `linkedEntityType = 'customers:person'`)
- Timeline zamówienia (dzięki `linkedEntityType2 = 'sales:order'`)
- Filtrze "Oferty" (dzięki `filterLabel` w ActivityTypeDefinition)

### 3.2 Przykład: ShipmentActivity z modułu logistyki

```
{
  id: 'logistics:shipment_dispatched',
  moduleId: 'logistics',
  label: 'logistics.activities.shipmentDispatched',
  icon: 'Truck',
  lifecycleMode: 'fact',           -- fakt, nie plan
  capabilities: { hasExternalSync: true, hasLocation: true },
  viewFeature: 'logistics.view',
  actions: [
    { id: 'track', label: 'logistics.trackShipment', icon: 'MapPin', condition: 'always' }
  ],
}
```

### 3.3 Przykład: AIActivity z modułu ai_assistant

```
{
  id: 'ai_assistant:analysis_completed',
  moduleId: 'ai_assistant',
  label: 'ai_assistant.activities.analysisCompleted',
  icon: 'Sparkles',
  lifecycleMode: 'fact',
  capabilities: { hasBody: true },
  viewFeature: 'ai_assistant.view',
  actions: [
    { id: 'view_analysis', label: 'ai_assistant.viewAnalysis', icon: 'FileSearch', condition: 'always' }
  ],
}
```

---

## 4. Jak działają timeline, ikony, renderery, filtry i uprawnienia dla typów zewnętrznych

### 4.1 Architektura renderowania timeline

```
<ActivityTimeline entityType="customers:person" entityId={id}>
  │
  ├── GET /api/activities?entityType=customers:person&entityId={id}
  │   Response: [{ id, activityType: 'sales:quote_sent', subject, ... }, ...]
  │
  └── dla każdego Activity:
        ↓
      activityTypeRegistry.get(activity.activityType)
        → ActivityTypeDefinition { icon: 'FileText', label: '...', ... }
        ↓
      activityTypeRenderers['sales:quote_sent']
        → QuoteSentActivityCard (lazy import) LUB DefaultActivityCard
        ↓
      render(<QuoteSentActivityCard activity={...} typeDef={...} />)
```

**Graceful degradation**: jeśli `activityType = 'unknown:future_type'` nie ma
definicji w rejestrze (np. po downgrade pakietu), `<ActivityTimeline>` renderuje
`<DefaultActivityCard>` z ikoną fallback `'Activity'` i surowym `subject`.
Timeline nigdy nie crashuje z powodu nieznanego typu.

### 4.2 Ikony — bez inline SVG

Każda `ActivityTypeDefinition` deklaruje `icon: string` — nazwa komponentu
z `lucide-react` (np. `'Mail'`, `'CalendarDays'`).

```
Timeline component:
  import * as Icons from 'lucide-react'
  const Icon = Icons[typeDef.icon] ?? Icons.Activity  // fallback
  render: <Icon className="size-4" />
```

Zgodnie z AGENTS.md CRITICAL Rule #10: nigdy inline `<svg>`, zawsze lucide-react.
Nowy moduł wybiera ikonę z istniejącego zestawu — nie dodaje nowych ikon.

### 4.3 Filtry — generowane z rejestru

Filter bar w timeline jest **generowany dynamicznie** z tablicy zarejestrowanych typów:

```
Dostępne filtry = getAllActivityTypes()
  .filter(type => userHasFeature(type.viewFeature))    -- RBAC gate
  .filter(type => hasActivitiesOfThisType(entityId))   -- nie pokazuj pustych filtrów
  .map(type => ({ label: t(type.filterLabel), icon: type.filterIcon }))
```

Użytkownik widzi TYLKO typy, które:
1. Ma uprawnienia do przeglądania
2. Faktycznie istnieją w kontekście tego rekordu

Nowy moduł dodający typ → automatycznie pojawia się w filtrze.
Zero zmian w komponencie `<ActivityTimeline>`.

### 4.4 Uprawnienia — trójstopniowy model

```
POZIOM 1 — Globalne (fallback)
  'activities.view'   — widok wszystkich aktywności
  'activities.manage' — tworzenie/edycja aktywności

POZIOM 2 — Per-typ (opcjonalne, deklarowane w ActivityTypeDefinition)
  'sales.view'        — widok aktywności z modułu sales
  'office365.view_own_activities' — widok swoich aktywności O365

POZIOM 3 — Per-rekord (ownership)
  lifecycle_mode: 'task' + visibility: 'private'
  → widoczne tylko dla owner_user_id

Cascading:
  user.features ⊇ ['activities.view', type.viewFeature] → może zobaczyć
  W przypadku braku type.viewFeature → wystarczy 'activities.view'
```

Na poziomie API:

```
GET /api/activities?entityType=...
  → filtruje zwracane rekordy wg activity_type × user.features
  → użytkownik bez 'sales.view' nie dostanie 'sales:quote_sent' w odpowiedzi
  → timeline po stronie klienta dostaje tylko to, co user może zobaczyć
```

### 4.5 Quick actions — kontekstowe i RBAC-gated

Każda akcja zdefiniowana w `ActivityTypeDefinition.actions` ma:
- `condition: 'when_planned' | 'when_completed' | 'when_overdue' | 'always'`
- `feature?: string` — opcjonalny dodatkowy RBAC gate

Timeline renderuje tylko akcje, dla których:
1. `condition` pasuje do aktualnego `status` aktywności
2. Użytkownik posiada wymagany `feature`

---

## 5. Koegzystencja O365, Google Workspace i przyszłych modułów

### 5.1 Zasada zero-coupling

Activity module **nie importuje** żadnej integracji zewnętrznej.
Integracje nie importują się nawzajem.
Komunikacja wyłącznie przez:
1. `POST /api/activities` — zapis aktywności
2. `activities.*` eventy — subskrypcja przez zewnętrzne moduły
3. FK IDs — linkowanie do encji

```
activities module
  NIE zna: 'office365', 'gmail', 'google_calendar'
  ZNA: 'external_id', 'external_provider' (generyczne pola)

channel-office365
  ZNA: activities module API (/api/activities)
  NIE zna: channel-google, innych integracji

channel-google
  ZNA: activities module API (/api/activities)
  NIE zna: channel-office365, innych integracji
```

### 5.2 Rejestracja typów per integracja

Każda integracja deklaruje swoje typy w `activity-types.ts`:

```
packages/channel-office365/src/modules/channel_office365/activity-types.ts
  activityTypes: [
    { id: 'office365:email',    icon: 'Mail',          lifecycleMode: 'fact' },
    { id: 'office365:meeting',  icon: 'CalendarDays',  lifecycleMode: 'fact' },
    { id: 'office365:task',     icon: 'CheckSquare',   lifecycleMode: 'task' },
  ]

packages/channel-google/src/modules/channel_google/activity-types.ts
  activityTypes: [
    { id: 'google:email',     icon: 'Mail',         lifecycleMode: 'fact' },
    { id: 'google:calendar',  icon: 'CalendarDays', lifecycleMode: 'fact' },
  ]
```

### 5.3 Deduplication między integratorami

Kluczowe: ten sam email nie może pojawić się dwa razy jeśli użytkownik
ma połączone jednocześnie konto Outlook i Gmail na ten sam adres.

```
UNIQUE INDEX na Activity:
  (external_id, external_provider, organization_id)

channel-office365 pisze:
  external_id = 'AAMkADxxxxxxx'   (Graph message ID)
  external_provider = 'office365'

channel-google pisze:
  external_id = '18f234abcd...'   (Gmail message ID)
  external_provider = 'gmail'

Ten sam email z innego systemu = inny external_id → dwa rekordy.
To jest poprawne zachowanie — dwie ścieżki sync, dwa fakty.
```

Deduplication WEWNĄTRZ jednej integracji (ta sama wiadomość polled dwa razy):
→ UNIQUE constraint blokuje drugi insert → zero duplikatów.

### 5.4 Unifikacja w UI bez wiedzy o źródle

Timeline filtruje po `linked_entity_type + linked_entity_id`, nie po `external_provider`.
Ikona emaila (`Mail`) wygląda tak samo dla Outlooka i Gmaila.
Badge źródła (`MS 365` | `Gmail`) to opcjonalny element karty, nie warunek filtrowania.

Użytkownik widzi: "jeden email, nieważne skąd".

---

## 6. Projektowanie Activity jako framework package

### 6.1 Stabilny kontrakt API (wersjonowany)

Jako moduł platformy, Activity musi mieć stabilne API:

```
/api/activities          CRUD + list
/api/activities/[id]     GET single
/api/activities/[id]/complete    POST lifecycle action
/api/activities/[id]/cancel      POST lifecycle action
/api/activities/types    GET — publiczny rejestr typów (dla klientów API)
```

Wersjonowanie: `/api/v2/activities` gdy breaking change.
Stara wersja deprecated przez 6 miesięcy (komunikat w odpowiedzi).

### 6.2 Trzy kontrakty rozszerzenia dla zewnętrznych modułów

**Kontrakt 1: Deklaratywny (typy)**

```
Moduł deklaruje: <module>/activity-types.ts
Generator:       activity-types.generated.ts
Efekt:           nowy typ w rejestrze, ikona, filtry, renderery
```

**Kontrakt 2: Programowy (tworzenie Activity przez API)**

```
POST /api/activities {
  activityType: 'sales:quote_sent',
  subject: 'Oferta Q-2026-042 wysłana',
  linkedEntityType: 'customers:person',
  linkedEntityId: '...',
  external_id?: '...',
  external_provider?: 'office365',
}
→ 201 Created { id, activityType, ... }
```

**Kontrakt 3: Subskrypcja (reakcja na eventy)**

```
Moduł deklaruje: <module>/subscribers/on-activity-created.ts
Nasłuchuje: 'activities.activity.created' event
Może: wysłać powiadomienie, zaktualizować status zamówienia, sync do O365
```

Żaden z kontraktów nie wymaga modyfikacji `@open-mercato/activities`.

### 6.3 Stabilność backwardowa — zasady

Pola Activity entity mają trzy kategorie:

```
STABLE (nigdy nie usuwaj, nigdy nie zmieniaj typu):
  id, organization_id, tenant_id, activity_type, subject,
  lifecycle_mode, status, owner_user_id, author_user_id,
  linked_entity_type, linked_entity_id, external_id, external_provider,
  occurred_at, due_at, created_at, updated_at, deleted_at

EXTENSIBLE (można dodawać nowe wartości, nie usuwać starych):
  status enum values, activity_type values (open text)

ADDITIVE (nowe pola można dodawać, stare zostawać):
  notes, location, participants, recurrence_rule, all_day, duration_minutes
  → nowe pola nullable z sensownym default = backward compatible
```

### 6.4 Autonomia typów — ActivityTypeDefinition jako granica modułu

`ActivityTypeDefinition` to granica między activity module a zewnętrznym modułem.
Zewnętrzny moduł NIGDY nie modyfikuje logiki core activity module.
Zamiast tego deklaruje swoje typy z całą potrzebną metadaną.

To jest ten sam wzorzec co `NotificationTypeDefinition` — framework OM
już udowodnił, że ten pattern działa w produkcji.

---

## 7. Activity jako "Contextual Activity Journal" — model docelowy

### 7.1 Diagram przepływu — pełna architektura

```
MODUŁY ŹRÓDŁOWE                     ACTIVITY MODULE (platforma)
──────────────────────────           ──────────────────────────────────────────
                                     
channel-office365                    POST /api/activities
  [O365 email arrives]  ──────────►  { activityType: 'office365:email',
                                       lifecycleMode: 'fact',
                                       external_id: 'AAMkAD...',
                                       external_provider: 'office365' }
                                            │
channel-google                              │  UNIQUE constraint
  [Gmail arrives]       ──────────►         │  deduplication
                                            ▼
sales module                         ┌─────────────────────────────────────┐
  [quote.sent event]    ──────────►  │  activities table                   │
                                     │                                     │
User via UI                          │  id | activity_type | subject | ... │
  [creates task]        ──────────►  │  fact: email, meeting, payment      │
                                     │  task: meeting planned, open task   │
ai_assistant                         └─────────────────────┬───────────────┘
  [analysis done]       ──────────►                        │
                                                           │ emits events
                                            ┌──────────────▼──────────────┐
KONSUMENCI EVENTÓW                          │  activities.activity.*      │
──────────────────────────                  │  .created                   │
                                            │  .completed                 │
notifications module     ◄──────────        │  .overdue                   │
  [send reminder]                           │  .synced                    │
                                            └─────────────────────────────┘
calendar sync worker     ◄──────────
  [push to O365]

PREZENTACJA UI
──────────────────────────
<ActivityTimeline>
  [customer page]         ◄── GET /api/activities?entityType=customers:person&entityId=X
  [order page]            ◄── GET /api/activities?entityType=sales:order&entityId=Y
  [global feed]           ◄── GET /api/activities?ownerUserId=me&status=planned
```

### 7.2 Odpowiedź na pytanie: event store, activity feed, CRM model czy hybryda?

**Hybryda — ale precyzyjnie zdefiniowana przez `lifecycle_mode`:**

| Aspekt | lifecycle_mode: 'fact' | lifecycle_mode: 'task' |
|--------|----------------------|----------------------|
| Wzorzec | Event Store | CRM Activity Model |
| Mutowalność | Immutable po `occurred_at` | Pełny lifecycle state machine |
| Kierunek w czasie | Przeszłość (co się stało) | Przyszłość (co zrobić) |
| Skąd pochodzi | Integracje zewnętrzne, system | Użytkownik, automatyzacja |
| Przykłady | email, payment, shipment | task, meeting, call_planned |
| Edycja przez UI | ❌ read-only | ✅ edytowalny |
| Sync do O365 | Opcjonalny (fakt już istnieje w źródle) | ✅ write-back do O365 |

Activity Feed (prezentacja) to warstwa widoku nad obiema kategoriami:
```
Activity Feed = chronological view(facts + tasks)
              + real-time updates via SSE (DOM Event Bridge)
              + infinite scroll pagination
```

---

## 8. Walidacja wzorca — czy OM już to potrafi?

| Pytanie | Wzorzec w OM | Odpowiednik w Activity |
|---------|-------------|----------------------|
| Jak rejestrować typy? | `notifications.ts` → generator | `activity-types.ts` → generator |
| Jak dostarczać renderery? | `notifications.client.ts` + `Renderer` component | `activity-types.client.ts` + lazy import |
| Jak obsługiwać akcje per typ? | `NotificationHandler` w `notifications.handlers.ts` | `ActivityTypeAction` w `ActivityTypeDefinition` |
| Jak gaterować RBAC? | `handler.features[]` sprawdzane przez runtime | `typeDef.viewFeature` sprawdzane w query |
| Jak unikać cross-module coupling? | `createModuleEvents` + FK IDs | `activityService.create()` + FK IDs |
| Jak auto-odkrywać? | Generator skanuje `**.ts` pliki | Ten sam generator, nowy scan target |
| Jak obsłużyć user-defined typy? | `dictionaries` module + DB entries | Warstwa 3 — fallback do DictionaryEntry |

**Wniosek**: Activity nie wymaga nowych wzorców. Kompozycja istniejących
wzorców OM (notification registry + channel adapter contract + dictionary fallback)
daje pełną architekturę rozszerzalności.

---

## 9. Rekomendacja — decyzje projektowe

### Decyzja 1: Typy aktywności = rejestr, nie enum
✅ `activity-types.ts` per moduł, auto-odkrywany przez generator.
Trzy warstwy: core built-in → module-registered → user dictionary.

### Decyzja 2: lifecycle_mode jako oś podziału
✅ `'fact'` (immutable, Event Store) vs `'task'` (mutable, CRM Activity).
Jedno pole zmienia całe zachowanie encji — edycję, akcje, sync.

### Decyzja 3: Renderery — lazy import per typ
✅ `activity-types.client.ts` z lazy importami komponentów React.
Graceful degradation do `DefaultActivityCard` dla nieznanych typów.

### Decyzja 4: Filtry i uprawnienia generowane z rejestru
✅ Brak hardkodowanych filtrów. Timeline generuje filtry
z `getAllActivityTypes().filter(userCanView)`.

### Decyzja 5: Zero-coupling między integracjami
✅ Integracje piszą przez `POST /api/activities`.
Activity module nie wie nic o O365, Gmail, Google Calendar.

### Decyzja 6: Activity = "Contextual Activity Journal"
✅ Hybryda Event Store + CRM Activity, zjednoczona przez `lifecycle_mode`.
Activity Feed to widok nad obiema warstwami, nie osobna architektura.

### Decyzja 7: Docelowo @open-mercato/activities package
✅ Dziś: `src/modules/activities/` z dyscypliną package API.
Za rok: `packages/activities/` workspace package.
Za 2 lata: `@open-mercato/activities` w core frameworku.

---

## 10. Co zbudować w Sprint 1

Na podstawie powyższej architektury, Sprint 1 tworzy fundament:

```
src/modules/activities/
  ├── index.ts                  -- module metadata
  ├── activity-types.ts         -- built-in types: email, meeting, task, call, note
  ├── activity-types.client.ts  -- default renderers dla built-in types
  ├── data/
  │   ├── entities.ts           -- Activity + ActivityLink entity
  │   └── validators.ts         -- Zod schemas
  ├── api/
  │   ├── route.ts              -- CRUD + list (makeCrudRoute)
  │   ├── [id]/complete/route.ts
  │   ├── [id]/cancel/route.ts
  │   └── types/route.ts        -- GET registered types (publiczny)
  ├── backend/
  │   ├── page.tsx + page.meta.ts        -- lista aktywności
  │   └── [id]/page.tsx + page.meta.ts  -- detal
  ├── widgets/
  │   ├── timeline/widget.ts             -- ActivityTimeline widget
  │   └── timeline/widget.client.tsx     -- komponent timeline
  ├── events.ts        -- activities.activity.{created,updated,completed,cancelled}
  ├── acl.ts           -- activities.view, activities.manage
  ├── setup.ts         -- defaultRoleFeatures
  ├── di.ts
  └── ce.ts            -- custom fields support
```

Sprint 1 NIE zawiera integracji O365 — to Sprint 4-5.
Sprint 1 buduje fundament na którym każda integracja będzie mogła pisać Activity
przez stabilne API bez modyfikowania core modułu.

---

## Changelog

| Data | Zmiana |
|------|--------|
| 2026-06-15 | Dokument stworzony — architektura rozszerzalności Activity module |
