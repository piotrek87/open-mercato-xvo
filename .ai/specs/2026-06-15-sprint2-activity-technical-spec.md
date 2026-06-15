# Activity Module — Sprint 2 Technical Specification
# Dynamic Registry, ActivityLink, Type Extensibility

**Data**: 2026-06-15
**Status**: Draft — awaiting review
**Sprint**: 2
**Zależności**: Sprint 1 (`feat/activities-sprint1`) musi być zmergowany i zmigrowany przed startem Sprint 2
**Poprzednia specyfikacja**: `.ai/specs/2026-06-15-sprint1-activity-technical-spec.md`
**Architektura rozszerzalności**: `.ai/specs/2026-06-15-activity-extensibility-architecture.md`

---

## Scope Sprint 2

| Area | Deliverable |
|---|---|
| Dynamic Activity Type Registry | Generator, auto-discovery, generated registry, lookup API |
| ActivityLink entity | Tabela junction M2M, CRUD API, timeline query migration |
| Activity Type Extensibility | Pełna implementacja `ActivityTypeDefinition`, renderers client-side |
| API | Registry endpoint, ActivityLink CRUD, updated timeline query |
| UI | Dynamic filter bar, lazy renderer loading, fallback card |

**Out of scope Sprint 2**: Custom fields UI, bulk actions, dictionary-backed types (Layer 3), O365 integration.

---

## 1. Dynamic Activity Type Registry

### 1.1 Cel i model mentalny

Sprint 1 zawiera `activity-types.ts` ze statyczną tablicą 5 typów wbudowanych.
Sprint 2 zamienia ten plik w **punkt wejścia Layer 1** i dodaje mechanizm
auto-odkrywania dla **Layer 2** (typy deklarowane przez zewnętrzne moduły aplikacji).

Wzorzec: identyczny z `notifications.ts` w frameworku OM — sprawdzony w produkcji.

### 1.2 Struktura plików

```
src/modules/activities/
  activity-types.ts          ← Layer 1: built-in types (email, meeting, call, note, task)
  activity-types.client.ts   ← Layer 1: renderers dla built-in types

src/modules/<module>/
  activity-types.ts          ← Layer 2: typy deklarowane przez dowolny moduł aplikacji
  activity-types.client.ts   ← Layer 2: renderers per moduł (opcjonalny)

.mercato/generated/
  activity-types.generated.ts  ← OUTPUT generatora — nie edytować ręcznie
```

### 1.3 Architektura generatora

Generator jest rozszerzeniem istniejącego `yarn generate`. Dodaje nowy krok skanowania:

**Wejście — pliki skanowane przez generator:**

```
1. src/modules/activities/activity-types.ts          (Layer 1 — core)
2. src/modules/*/activity-types.ts                   (Layer 2 — app modules)
3. node_modules/@open-mercato/*/src/**/activity-types.ts  (Layer 2 — framework packages)
```

Kolejność ma znaczenie: Layer 1 jest zawsze podstawą. Layer 2 rozszerza.

**Proces discovery (krok po kroku):**

```
1. Generator skanuje powyższe ścieżki (glob)
2. Dla każdego znalezionego pliku:
   a. importuje tablicę `activityTypes: ActivityTypeDefinition[]`
   b. waliduje każdy element (required fields: id, moduleId, label, icon, lifecycleMode)
   c. sprawdza unikalność `id` w global scope
3. Spłaszcza wszystkie tablice w jedną
4. Generuje `.mercato/generated/activity-types.generated.ts`
5. Loguje podsumowanie: ile typów znalezionych, z jakich modułów
```

**Reguły walidacji podczas generowania:**

| Reguła | Zachowanie przy naruszeniu |
|---|---|
| Brakuje wymaganego pola (`id`, `moduleId`, `label`, `icon`, `lifecycleMode`) | Błąd build — generator kończy z exit code 1 |
| Duplikat `id` w scope tej samej aplikacji | Błąd build — generyczny komunikat: który plik i które ID koliduje |
| Duplikat `id` między framework package a app module | Warning — app module wygrywa (override pattern) |
| Plik `activity-types.ts` istnieje ale nie eksportuje `activityTypes` | Warning — plik ignorowany, build kontynuuje |
| Nieprawidłowy `icon` (nie istnieje w lucide-react) | Warning tylko — nie blokuje (runtime graceful degradation) |

### 1.4 Wyjście generatora — kształt `activity-types.generated.ts`

```typescript
// .mercato/generated/activity-types.generated.ts
// AUTO-GENERATED — nie edytować ręcznie. Wygenerowano przez: yarn generate

import type { ActivityTypeDefinition } from '@app/modules/activities/activity-types'

const _registry: ActivityTypeDefinition[] = [
  // Layer 1 — activities module
  { id: 'email',   moduleId: 'activities', label: 'activities.types.email',   icon: 'Mail',         lifecycleMode: 'fact', capabilities: { hasBody: true, hasParticipants: true } },
  { id: 'meeting', moduleId: 'activities', label: 'activities.types.meeting', icon: 'CalendarDays', lifecycleMode: 'task', capabilities: { hasDueDate: true, hasLocation: true, hasParticipants: true, hasRecurrence: true } },
  { id: 'call',    moduleId: 'activities', label: 'activities.types.call',    icon: 'Phone',        lifecycleMode: 'task', capabilities: { hasDueDate: true, hasParticipants: true } },
  { id: 'note',    moduleId: 'activities', label: 'activities.types.note',    icon: 'FileText',     lifecycleMode: 'fact', capabilities: { hasBody: true } },
  { id: 'task',    moduleId: 'activities', label: 'activities.types.task',    icon: 'CheckSquare',  lifecycleMode: 'task', capabilities: { hasDueDate: true, hasStatus: true, hasOwner: true } },
  // Layer 2 — auto-discovered (przykład po dodaniu modułu sales)
  // { id: 'sales:quote_sent', moduleId: 'sales', ... },
]

export function getActivityType(id: string): ActivityTypeDefinition | undefined {
  return _registry.find(t => t.id === id)
}

export function getAllActivityTypes(): ActivityTypeDefinition[] {
  return _registry
}

export function getActivityTypesByModule(moduleId: string): ActivityTypeDefinition[] {
  return _registry.filter(t => t.moduleId === moduleId)
}
```

### 1.5 Build-time vs runtime

| Aspekt | Sprint 2 (build-time only) | Przyszłość (Sprint 3+) |
|---|---|---|
| Rejestracja typów | Tylko przez `yarn generate` | Opcjonalnie dynamiczna przez API |
| Kiedy registry jest dostępne | Po każdym `yarn generate` | Zawsze (z DB fallback) |
| Typy user-defined (Layer 3) | ❌ nie zaimplementowane | ✅ dictionary-backed |
| Hot reload w dev | ✅ generator re-runs przy zmianie `activity-types.ts` | n/d |

**Decyzja**: Sprint 2 jest wyłącznie build-time. Nie ma runtime registration API.
Uzasadnienie: eliminuje złożoność cache invalidation i race conditions przy starcie serwera.

### 1.6 Failure handling — runtime

Jeśli `activity.activity_type` zawiera wartość nieobecną w rejestrze:

```
Scenariusz A: typ pochodzi z pakietu który był dostępny, ale jest downgraded/removed
  → getActivityType(id) zwraca undefined
  → Timeline renderuje DefaultActivityCard
  → Ikona fallback: 'Activity' (lucide-react)
  → Subject wyświetlany as-is
  → Żaden crash, żaden error boundary trigger

Scenariusz B: błąd w activity-types.client.ts (lazy import fails)
  → React.lazy error boundary łapie
  → Fallback: DefaultActivityCard (nie cała timeline)
  → Tylko ta jedna karta degraduje, reszta timeline działa normalnie

Scenariusz C: duplikat ID po mergowaniu dwóch branchy
  → Generator wykrywa przy kolejnym `yarn generate`
  → Build fails z jasnym komunikatem
  → Nie możliwy w runtime jeśli CI zawsze uruchamia `yarn generate`
```

---

## 2. ActivityLink Entity

### 2.1 Problem i decyzja projektowa

Sprint 1 ma `linked_entity_type` + `linked_entity_id` bezpośrednio na encji `Activity`.
Obsługuje dokładnie **jeden** link per aktywność.

Otwarte pytanie z project-context: "add second pair of columns OR introduce junction table?"

**Decyzja Sprint 2: junction table `activity_links`.**

Uzasadnienie:
- Druga para kolumn (`linked_entity_type2`) tworzy precedens dla trzeciej, czwartej — schema explosion
- Junction table jest O(n) extensible bez migracji
- Jedna aktywność linkowana do 3+ encji jest realnym przypadkiem (call z klientem dot. zamówienia i faktury)
- Query performance nie degraduje dzięki indeksom

**Backward compatibility**: kolumny `linked_entity_type/id` na `Activity` **zostają** jako primary link (nie są usuwane). `ActivityLink` rozszerza, nie zastępuje. Klienci API z Sprint 1 nie są breaking.

### 2.2 Model danych — encja ActivityLink

```
Tabela: activity_links

Kolumny:
  id                UUID PK (generated)
  activity_id       UUID NOT NULL FK → activities.id ON DELETE CASCADE
  entity_type       VARCHAR(100) NOT NULL   -- np. 'customers:person', 'sales:order'
  entity_id         UUID NOT NULL
  is_primary        BOOLEAN NOT NULL DEFAULT false
                    -- true dla linku który "zastępuje" linked_entity_type/id na Activity
                    -- co najwyżej jeden PRIMARY per activity (constraint poniżej)
  organization_id   UUID NOT NULL
  tenant_id         UUID NOT NULL
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  created_by_user_id UUID NULL FK → users.id ON DELETE SET NULL

Constraints:
  UNIQUE (activity_id, entity_type, entity_id)
    -- ta sama encja nie może być powiązana dwa razy z tą samą aktywnością
  
  UNIQUE (activity_id) WHERE is_primary = true
    -- maksymalnie jeden link primary per aktywność (partial unique index)

Indeksy:
  PRIMARY KEY (id)
  INDEX ON (activity_id)
    -- pobieranie wszystkich linków aktywności — O(links per activity)
  INDEX ON (entity_type, entity_id, organization_id)
    -- timeline query: "wszystkie aktywności powiązane z tym rekordem" — krytyczny
  INDEX ON (organization_id, entity_type, entity_id, created_at DESC)
    -- timeline query z cursor pagination (composite covering index)
```

### 2.3 Relacja do istniejących kolumn na Activity

```
Activity.linked_entity_type / Activity.linked_entity_id
  → pozostają, nie są deprecated w Sprint 2
  → traktowane jako "legacy primary link"
  → przy tworzeniu ActivityLink z is_primary=true:
      Activity.linked_entity_type / Activity.linked_entity_id SĄ RÓWNIEŻ aktualizowane
      (denormalizacja — dla backward compat z Sprint 1 consumers)
  → przy usuwaniu primary ActivityLink:
      Activity.linked_entity_type / Activity.linked_entity_id są nullowane
      jeśli nie ma innego linku z is_primary=true
```

### 2.4 Multi-link support — reguły biznesowe

| Reguła | Opis |
|---|---|
| Max linków per aktywność | Brak twardego limitu w bazie — soft limit 10 w walidacji API |
| Primary link | Dokładnie jeden per aktywność (lub zero). Reprezentuje "główny kontekst" |
| Zmiana primary | PATCH `/api/activities/:id/links/:linkId` z `{ is_primary: true }` — atomicznie przenosi primary |
| Usuwanie primary | Dozwolone — Activity staje się "unlinked" (linked_entity_type null) |
| Duplikat entity_type+entity_id | Blokowany przez UNIQUE constraint — API zwraca 409 Conflict |
| Cross-tenant | Zablokowane — organization_id ActivityLink musi === organization_id Activity |

### 2.5 Timeline query strategy

**Sprint 1 query (pozostaje dla primary link):**
```sql
SELECT * FROM activities
WHERE linked_entity_type = $1
  AND linked_entity_id = $2
  AND organization_id = $3
  AND deleted_at IS NULL
ORDER BY occurred_at DESC, id DESC
LIMIT $4
```

**Sprint 2 query (dodatkowy query path dla "all links"):**
```sql
SELECT a.*
FROM activities a
WHERE a.organization_id = $1
  AND a.deleted_at IS NULL
  AND (
    -- primary link (legacy path, uses existing index)
    (a.linked_entity_type = $2 AND a.linked_entity_id = $3)
    OR
    -- secondary links (new path, uses activity_links index)
    EXISTS (
      SELECT 1 FROM activity_links al
      WHERE al.activity_id = a.id
        AND al.entity_type = $2
        AND al.entity_id = $3
        AND al.organization_id = $1
    )
  )
ORDER BY a.occurred_at DESC, a.id DESC
LIMIT $4
```

**Performance uwaga**: `EXISTS` subquery jest efektywne dzięki indeksowi na `(entity_type, entity_id, organization_id)`.
Przy dużych wolumenach (> 100k activities per tenant) rozważyć UNION zamiast OR/EXISTS — decyzja do Sprint 3.

**Cursor pagination**: bez zmian względem Sprint 1 — cursor `(occurred_at, id)` działa na obu ścieżkach.

### 2.6 Migracja danych istniejących aktywności

Po zastosowaniu migracji Sprint 2:

```sql
-- Dla każdej istniejącej Activity z linked_entity_type IS NOT NULL
-- utwórz odpowiadający ActivityLink z is_primary = true

INSERT INTO activity_links (id, activity_id, entity_type, entity_id, is_primary, organization_id, tenant_id, created_at)
SELECT
  gen_random_uuid(),
  a.id,
  a.linked_entity_type,
  a.linked_entity_id,
  true,
  a.organization_id,
  a.tenant_id,
  a.created_at
FROM activities a
WHERE a.linked_entity_type IS NOT NULL
  AND a.linked_entity_id IS NOT NULL
  AND a.deleted_at IS NULL
ON CONFLICT (activity_id, entity_type, entity_id) DO NOTHING;
```

Ta migracja jest idempotentna. Może być uruchamiana wielokrotnie bezpiecznie.

---

## 3. Activity Type Extensibility — pełna specyfikacja

### 3.1 ActivityTypeDefinition — kompletny kształt

```typescript
interface ActivityTypeDefinition {
  // --- Identyfikacja ---
  id: string               // Globalnie unikalne. Format: 'email' (core) lub 'module:type' (external)
  moduleId: string         // Kto deklaruje: 'activities' | 'sales' | 'channel_office365' | ...

  // --- Prezentacja ---
  label: string            // i18n key, np. 'activities.types.email'
  icon: string             // Nazwa komponentu lucide-react, np. 'Mail', 'CalendarDays'
  color?: string           // Opcjonalny semantic token, np. 'text-status-info-icon'

  // --- Zachowanie ---
  lifecycleMode: 'fact' | 'task'
  capabilities: {
    hasDueDate?: boolean        // Pole "Termin" — domyślnie false
    hasStatus?: boolean         // Lifecycle state machine — domyślnie false
    hasOwner?: boolean          // Przypisywalne do użytkownika — domyślnie false
    hasParticipants?: boolean   // Lista uczestników — domyślnie false
    hasRecurrence?: boolean     // Pole RRULE — domyślnie false
    hasExternalSync?: boolean   // Pochodzi z integracji — domyślnie false
    hasLocation?: boolean       // Pole lokalizacji — domyślnie false
    hasBody?: boolean           // Treść/opis — domyślnie false
  }

  // --- RBAC ---
  // Jeśli nie podano, fallback do 'activities.view' / 'activities.manage'
  viewFeature?: string       // Feature wymagany do przeglądania (np. 'sales.view')
  createFeature?: string     // Feature wymagany do tworzenia (np. 'sales.manage')

  // --- Filter bar w timeline ---
  filterLabel?: string       // i18n key dla etykiety filtru (fallback: label)
  filterIcon?: string        // Ikona filtru (fallback: icon)
  filterGroup?: string       // Opcjonalne grupowanie filtrów (np. 'integrations')

  // --- Quick actions na karcie aktywności ---
  actions?: Array<{
    id: string
    label: string            // i18n key
    icon: string             // lucide-react
    variant: 'default' | 'outline' | 'ghost' | 'destructive'
    feature?: string         // Opcjonalny RBAC gate per akcja
    condition?: 'when_planned' | 'when_in_progress' | 'when_completed' | 'when_overdue' | 'always'
  }>
  primaryActionId?: string   // Domyślna akcja po kliknięciu karty
}
```

### 3.2 Jak moduł aplikacji rejestruje typ

**Krok 1** — plik `src/modules/<id>/activity-types.ts`:

```typescript
import type { ActivityTypeDefinition } from '@app/modules/activities/activity-types'

export const activityTypes: ActivityTypeDefinition[] = [
  {
    id: 'sales:quote_sent',
    moduleId: 'sales',
    label: 'sales.activities.quoteSent',
    icon: 'FileText',
    lifecycleMode: 'fact',
    capabilities: { hasBody: true, hasExternalSync: false },
    viewFeature: 'sales.view',
    createFeature: 'sales.manage',
    actions: [
      {
        id: 'view_quote',
        label: 'sales.activities.actions.viewQuote',
        icon: 'ExternalLink',
        variant: 'outline',
        condition: 'always',
      }
    ],
    primaryActionId: 'view_quote',
  },
]
```

**Krok 2** — `yarn generate` — generator odkrywa plik, dodaje do rejestru.

**Krok 3** — opcjonalny plik `src/modules/<id>/activity-types.client.ts` (renderery):

```typescript
import type { ActivityTypeClientRenderers } from '@app/modules/activities/activity-types.client'

export const activityTypeRenderers: ActivityTypeClientRenderers = {
  'sales:quote_sent': () => import('./components/QuoteSentActivityCard'),
}
```

**Krok 4** — i18n keys w `src/i18n/en.json`.

Żadna zmiana w module `activities` nie jest wymagana.

### 3.3 Capabilities — reguły UI

Capabilities determinują które pola są widoczne w formularzu tworzenia/edycji:

| Capability | Pole w formularzu | Warunek widoczności |
|---|---|---|
| `hasDueDate` | "Termin (due_at)" | `lifecycleMode: 'task'` |
| `hasStatus` | Status badge + lifecycle actions | zawsze (kontroluje dostępność akcji) |
| `hasOwner` | "Przypisane do" | zawsze |
| `hasParticipants` | "Uczestnicy" | zawsze |
| `hasRecurrence` | "Powtarzaj" | `hasDueDate: true` |
| `hasExternalSync` | Sync badge w karcie | zawsze (display only) |
| `hasLocation` | "Lokalizacja (location)" | zawsze |
| `hasBody` | "Treść (notes)" | zawsze |

Pole `occurred_at` ("Kiedy") jest zawsze widoczne dla `lifecycleMode: 'fact'`.
Pole `due_at` jest zawsze widoczne dla `lifecycleMode: 'task'` + `hasDueDate: true`.

### 3.4 Actions — reguły renderowania

Quick actions renderowane na karcie aktywności tylko gdy:
1. `condition` pasuje do aktualnego `status` aktywności
2. Użytkownik posiada `feature` (jeśli zdefiniowany)
3. Aktywność nie jest soft-deleted

Mapowanie `condition` → `status`:

```
'when_planned'     → status IN ('not_started')
'when_in_progress' → status IN ('in_progress')
'when_completed'   → status IN ('completed')
'when_overdue'     → status IN ('not_started', 'in_progress') AND due_at < NOW()
'always'           → zawsze (niezależnie od status)
```

### 3.5 Ikony — konwencje

- Każda `ActivityTypeDefinition` deklaruje `icon: string` — nazwa komponentu z `lucide-react`
- Timeline component dynamicznie ładuje: `const Icon = Icons[typeDef.icon] ?? Icons.Activity`
- Fallback: `Icons.Activity` (lucide-react) — dla nieznanych nazw i brakujących typów
- Nowy moduł MUSI wybrać ikonę z istniejącego zestawu lucide-react — nie dodaje custom SVG
- Rekomendowane ikony per kategoria: Mail, Phone, CalendarDays, Video, FileText, CheckSquare, MessageSquare, Bell, Truck, CreditCard, Sparkles, Users

### 3.6 Renderery — architektura klient-side

Plik `activity-types.client.ts` per moduł — eksportuje lazy imports:

```typescript
type ActivityTypeClientRenderers = {
  [typeId: string]: () => Promise<{ default: React.ComponentType<ActivityCardProps> }>
}
```

Merging renderers w głównym pliku `activities/activity-types.client.ts`:

```typescript
// Aggregated by generator — analogicznie do generated registry
// Plik .mercato/generated/activity-type-renderers.generated.ts

import { activityTypeRenderers as builtinRenderers } from '@app/modules/activities/activity-types.client'
// ...inne moduły auto-odkryte przez generator

export const allRenderers: ActivityTypeClientRenderers = {
  ...builtinRenderers,
  // ...merged from all modules
}
```

Props dla każdego custom renderer:

```typescript
interface ActivityCardProps {
  activity: ActivityResponse    // pełny obiekt aktywności z API
  typeDef: ActivityTypeDefinition
  onAction?: (actionId: string, activityId: string) => void
  compact?: boolean             // true w timeline (ograniczona wysokość)
}
```

---

## 4. API Contracts

### 4.1 Registry endpoints

#### `GET /api/activity-types`

Zwraca wszystkie zarejestrowane typy widoczne dla current user (filtrowane przez RBAC).

**Query params:**
```
moduleId?:     string   -- filtruj po module (np. 'sales')
lifecycleMode?: 'fact' | 'task'
```

**Response 200:**
```json
{
  "data": [
    {
      "id": "email",
      "moduleId": "activities",
      "label": "activities.types.email",
      "icon": "Mail",
      "lifecycleMode": "fact",
      "capabilities": {
        "hasBody": true,
        "hasParticipants": true
      },
      "filterLabel": "activities.types.email",
      "filterIcon": "Mail",
      "actions": []
    }
  ],
  "total": 5
}
```

**Auth**: `requireAuth: true, requireFeatures: ['activities.view']`
**Filtrowanie RBAC**: typy z `viewFeature` są zwracane tylko jeśli user posiada ten feature.

#### `GET /api/activity-types/:id`

**Response 200**: pojedynczy `ActivityTypeDefinition`
**Response 404**: `{ "error": "activity_type_not_found" }`

### 4.2 ActivityLink CRUD

#### `GET /api/activities/:id/links`

Zwraca wszystkie linki dla danej aktywności.

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "activityId": "uuid",
      "entityType": "customers:person",
      "entityId": "uuid",
      "isPrimary": true,
      "createdAt": "2026-06-15T10:00:00Z",
      "createdByUserId": "uuid"
    }
  ]
}
```

#### `POST /api/activities/:id/links`

Dodaje nowy link do aktywności.

**Request body:**
```json
{
  "entityType": "sales:order",
  "entityId": "uuid",
  "isPrimary": false
}
```

**Walidacja Zod:**
```typescript
const activityLinkCreateSchema = z.object({
  entityType: z.string().min(1).max(100).regex(/^[a-z_]+:[a-z_]+$/),
  entityId:   z.string().uuid(),
  isPrimary:  z.boolean().optional().default(false),
})
```

**Response 201**: nowo utworzony `ActivityLink`
**Response 404**: aktywność nie istnieje lub brak dostępu
**Response 409**: `{ "error": "activity_link_already_exists" }` — duplikat entity_type+entity_id
**Response 422**: walidacja

**Efekt uboczny**: jeśli `isPrimary: true` — atomicznie:
1. Istniejący primary link (jeśli jest) → `is_primary = false`
2. Nowy link → `is_primary = true`
3. `Activity.linked_entity_type/id` → zaktualizowane (denormalizacja)

#### `PATCH /api/activities/:id/links/:linkId`

Zmiana `is_primary` istniejącego linku.

**Request body:**
```json
{ "isPrimary": true }
```

**Response 200**: zaktualizowany `ActivityLink`
**Response 404**: link nie istnieje lub nie należy do tej aktywności

#### `DELETE /api/activities/:id/links/:linkId`

Usuwa link. Jeśli był primary — Activity.linked_entity_type/id stają się null (chyba że istnieje inny link — wtedy promowany jest najstarszy).

**Response 204**: brak body
**Response 404**: link nie istnieje

### 4.3 Zmiany w istniejących endpoints

#### `GET /api/activities` — nowe query params

```
entityType:   string  -- primary link filter (istniejący)
entityId:     uuid    -- primary link filter (istniejący)
includeLinked?: boolean -- DEFAULT false — czy uwzględnić aktywności powiązane przez ActivityLink
                         -- jeśli true, query używa OR EXISTS path (sekcja 2.5)
```

**Backward compat**: bez `includeLinked` zachowanie identyczne z Sprint 1.

#### `POST /api/activities` — rozszerzone body

```typescript
const activityCreateSchema = z.object({
  // ...pola Sprint 1 bez zmian...
  
  // Nowe — opcjonalne dodatkowe linki przy tworzeniu
  additionalLinks: z.array(z.object({
    entityType: z.string().min(1).max(100),
    entityId:   z.string().uuid(),
  })).max(9).optional(),
  // Max 9 dodatkowych + 1 primary = 10 total (soft limit)
})
```

#### `GET /api/activities/:id` — rozszerzone response

```json
{
  "id": "uuid",
  "activityType": "email",
  // ...pola Sprint 1...
  "links": [
    { "id": "uuid", "entityType": "customers:person", "entityId": "uuid", "isPrimary": true },
    { "id": "uuid", "entityType": "sales:order",      "entityId": "uuid", "isPrimary": false }
  ]
}
```

Pole `links` jest zawsze obecne (pusta tablica jeśli brak). Backward compat: nie usuwa `linkedEntityType/linkedEntityId` z response.

### 4.4 OpenAPI — nowe tagi

Wszystkie nowe endpointy eksportują `openApi` z tagami:
- `GET/api/activity-types*` → tag: `activity-types`
- `*/activities/:id/links*` → tag: `activity-links`

---

## 5. UI Architecture

### 5.1 Dynamic filter bar

Komponent `<ActivityFilterBar>` w `widgets/timeline/` jest generowany dynamicznie z rejestru.

**Logika:**

```
1. Po załadowaniu timeline: pobierz GET /api/activity-types (z cache React Query, staleTime: 5min)
2. Filtruj: typy które mają activities w danym entityType/entityId context
   (opcja A: endpoint zwraca typy dostępne w kontekście)
   (opcja B: client-side filtruj po pobraniu wszystkich activities)
   → Decyzja: opcja B dla Sprint 2 (prostsze, wystarczające przy cursor limit=50)
3. Renderuj filter chips w kolejności: built-in types first, potem external (sortowane po moduleId)
4. "Wszystkie" chip zawsze pierwszy
5. Klawisz escape → reset do "Wszystkie"
6. Stan filtrów w URL (searchParams) dla deep-link support
```

**Props:**
```typescript
interface ActivityFilterBarProps {
  availableTypes: ActivityTypeDefinition[]   // z rejestru, już przefiltrowane RBAC
  activeFilter: string | null                // null = "Wszystkie"
  onChange: (typeId: string | null) => void
}
```

### 5.2 Renderer loading — lazy import strategy

```
Przy renderowaniu listy activities:

1. Dla każdego activity w odpowiedzi:
   a. getActivityType(activity.activityType) → ActivityTypeDefinition | undefined
   b. allRenderers[activity.activityType] → lazy renderer function | undefined

2. Jeśli renderer istnieje:
   const ActivityCard = React.lazy(allRenderers[activity.activityType])
   render: <Suspense fallback={<DefaultActivityCard activity={activity} />}>
             <ActivityCard activity={activity} typeDef={typeDef} />
           </Suspense>

3. Jeśli renderer NIE istnieje (lub typeDef undefined):
   render: <DefaultActivityCard activity={activity} typeDef={typeDef ?? fallbackTypeDef} />
```

**Bundling strategy**: każdy `activity-types.client.ts` jest osobnym chunk — ładowany tylko gdy timeline zawiera ten typ. Przy typowym tenant z 5 typami builtinowymi i 2 custom: max 7 dodatkowych chunków, każdy < 5KB.

### 5.3 DefaultActivityCard

Fallback card renderowany gdy:
- Typ aktywności nie ma custom renderer
- Custom renderer nie zdążył się załadować (Suspense)
- Typ aktywności jest nieznany (graceful degradation)

Wymagania DefaultActivityCard:
- Wyświetla: icon (lub fallback `Activity`), subject, status badge, occurred_at/due_at
- Wyświetla: ownerUser inicjały, linkedEntity display name (jeśli dostępne)
- Wyświetla: quick actions z `typeDef.actions` (jeśli typeDef dostępny)
- Nie crashuje gdy `typeDef` jest undefined
- Compact mode: tylko icon + subject + status (dla timeline z dużą gęstością)

### 5.4 Performance considerations

| Scenariusz | Ryzyko | Mitygacja |
|---|---|---|
| 200+ activities w timeline (infinite scroll) | Wiele lazy imports na raz | Grupowanie typów — jeden import per typ, nie per activity |
| `getAllActivityTypes()` wywołane per render | Niepotrzebne re-obliczenia | Memoize w React context lub zustand |
| OR EXISTS query dla `includeLinked` | Slow na dużych tabelach | Index na (entity_type, entity_id, organization_id) — patrz sekcja 2.2 |
| RBAC filter na `/api/activity-types` | N+1 feature checks | Batch check: `user.features.includes()` na już załadowanym user object |
| Registry cold start | Import `.generated.ts` przy każdym request | Moduł jest singleton — Node.js cache importu; zero overhead po pierwszym load |

---

## 6. Acceptance Criteria

### AC-1: Dynamic Registry Discovery

- [ ] `yarn generate` skanuje `src/modules/*/activity-types.ts` i produkuje `.mercato/generated/activity-types.generated.ts`
- [ ] Nowy moduł z `activity-types.ts` jest automatycznie odkryty po `yarn generate` bez zmian w module activities
- [ ] `getActivityType('email')` zwraca definicję dla built-in emaila
- [ ] `getActivityType('unknown:type')` zwraca `undefined` (nie rzuca)
- [ ] `getAllActivityTypes()` zwraca tablicę wszystkich zarejestrowanych typów
- [ ] Duplikat `id` w dwóch modułach aplikacji → `yarn generate` kończy exit code 1 z komunikatem wskazującym oba pliki
- [ ] Brakujące wymagane pole → `yarn generate` kończy exit code 1

### AC-2: ActivityLink Entity

- [ ] Migracja tworzy tabelę `activity_links` z poprawną strukturą i wszystkimi indeksami
- [ ] Migracja wypełnia `activity_links` danymi z istniejących `linked_entity_type/id` na Activity (idempotentna)
- [ ] `POST /api/activities/:id/links` tworzy nowy link
- [ ] `POST` z duplikatem entity_type+entity_id zwraca 409
- [ ] Maksymalnie jeden link z `is_primary=true` per aktywność (naruszenie → 422)
- [ ] `DELETE` primary link → `Activity.linked_entity_type/id` stają się null
- [ ] `GET /api/activities/:id` zawiera pole `links: []`
- [ ] `GET /api/activities?entityType=X&entityId=Y&includeLinked=true` zwraca aktywności powiązane przez ActivityLink (nie tylko primary)

### AC-3: Activity Type Extensibility

- [ ] Moduł z `activity-types.ts` i `activity-types.client.ts` renderuje własną kartę w timeline bez zmian w module activities
- [ ] Karta z nieznanym typem renderuje DefaultActivityCard (bez crash, bez error boundary)
- [ ] Akcje na karcie renderowane tylko gdy spełniony `condition` + user posiada `feature`
- [ ] `viewFeature` na typie → aktywności tego typu nie są zwracane przez API użytkownikowi bez tej feature
- [ ] `filterGroup` grupuje filtry w filter bar

### AC-4: API Registry Endpoint

- [ ] `GET /api/activity-types` zwraca tylko typy widoczne dla current user (RBAC)
- [ ] `GET /api/activity-types` bez auth → 401
- [ ] `GET /api/activity-types?moduleId=sales` zwraca tylko typy z modułu sales
- [ ] `GET /api/activity-types/:id` z nieistniejącym id → 404

### AC-5: UI

- [ ] Filter bar wyświetla tylko typy faktycznie obecne w aktualnym kontekście (entityType+entityId)
- [ ] Filtr zmienia URL (searchParams) — deeplink działa po odświeżeniu
- [ ] Lazy renderer ładuje się bez blokowania reszty timeline
- [ ] DefaultActivityCard renderuje poprawnie gdy typeDef undefined
- [ ] Registry załadowany raz — brak N+1 na liście activities

### AC-6: Backward Compatibility

- [ ] Istniejące aktywności Sprint 1 z `linked_entity_type/id` działają bez zmian w API
- [ ] `GET /api/activities?entityType=X&entityId=Y` (bez `includeLinked`) — zachowanie identyczne z Sprint 1
- [ ] Sprint 1 consumers API nie są breaking (brak removed fields)

---

## 7. Risks and Migration Concerns

### R-1: ID collision po dodaniu zewnętrznego modułu

**Ryzyko**: Dwa moduły deklarują typ o tym samym `id` (np. oba deklarują `'task'`).
**Prawdopodobieństwo**: Niskie (built-in IDs są proste, external powinny używać `module:type` prefix).
**Wpływ**: Build failure lub niezdefiniowane zachowanie (który typ "wygrywa").
**Mitygacja**:
- Generator wykrywa duplikaty i failuje z jasnym komunikatem (exit code 1)
- Konwencja nazewnictwa w AGENTS.md: built-in = prosty string, external = `moduleId:typeName`
- Konwencja egzekwowana przez walidację generatora (pattern: `/^[a-z_]+:[a-z_]+$/` dla external)

### R-2: Migracja ActivityLink dla dużych tenantów

**Ryzyko**: INSERT INTO activity_links SELECT FROM activities na dużej tabeli (> 500k rows) może trwać długo i blokować tabelę.
**Prawdopodobieństwo**: Niskie (Sprint 2 to wczesna faza, dane są małe).
**Mitygacja**:
- Migracja w batches: `INSERT ... SELECT ... LIMIT 10000 OFFSET $batch` w pętli
- Alternatywnie: migrację danych oddzielić od migracji struktury (dwa migracje lub background job)
- Jeśli tenant ma > 100k activities: uruchomić jako background worker po starcie

### R-3: OR EXISTS query performance degradacja

**Ryzyko**: `includeLinked=true` używa OR EXISTS — przy braku wystarczających indeksów może być slow.
**Prawdopodobieństwo**: Niskie (indeksy są zdefiniowane w specce).
**Mitygacja**:
- Index na `(entity_type, entity_id, organization_id)` w `activity_links` (zdefiniowany w sekcji 2.2)
- EXPLAIN ANALYZE przed release na representative dataset
- Fallback: rewrite jako UNION jeśli OR EXISTS okaże się problem

### R-4: Lazy renderer loading — waterfall

**Ryzyko**: Timeline z 10 różnych typów aktywności = 10 osobnych lazy imports (waterfall).
**Prawdopodobieństwo**: Niskie (typowy timeline ma 2-3 typy).
**Mitygacja**:
- Preload renderers po pobraniu listy activities: `getAllActivityTypes().forEach(t => allRenderers[t.id]?.())`
- Preload wywołany przed renderem listy, nie per-karta
- Sprint 2: akceptujemy waterfall jako known limitation. Fix w Sprint 3 jeśli pomiary pokażą problem.

### R-5: Generator nie uruchomiony po dodaniu nowego modułu

**Ryzyko**: Developer dodaje `activity-types.ts` ale zapomina uruchomić `yarn generate` — typy nie są w rejestrze.
**Prawdopodobieństwo**: Średnie (ludzki błąd).
**Wpływ**: Nowe typy nie są widoczne w UI, ale aplikacja nie crashuje (graceful degradation).
**Mitygacja**:
- `yarn dev` auto-runs generator przy starcie (analogicznie do AGENTS.md konwencji `yarn generate`)
- CI job zawiera `yarn generate && git diff --exit-code .mercato/generated/` — diff wykrywa niezregenerowane pliki
- TypeScript type imports z `.generated.ts` pokazują błędy kompilacji jeśli rejestr jest nieaktualny

### R-6: ActivityTypeDefinition schema evolution

**Ryzyko**: Dodanie nowych pól do `ActivityTypeDefinition` w przyszłości może wymagać aktualizacji wszystkich istniejących `activity-types.ts` plików.
**Mitygacja**:
- Wszystkie nowe pola MUSZĄ być opcjonalne z sensownym default — backward compatible
- Reguła: `ActivityTypeDefinition` fields są ADDITIVE (nigdy nie usuwać, nigdy nie zmieniać semantyki istniejących)
- Sekcja **Stable/Extensible/Additive** z extensibility spec jest wiążąca

### R-7: Backward compat Activity.linked_entity_type/id denormalizacja

**Ryzyko**: Denormalizacja między `Activity.linked_entity_type/id` a `ActivityLink.is_primary` — może stać się niespójna przy bugach.
**Mitygacja**:
- `withAtomicFlush` obejmuje obie operacje (update Activity + upsert ActivityLink)
- Scheduled consistency check (cron) porównujący Activity.linked_entity_type z ActivityLink.is_primary (Sprint 3+)
- Deprecation strategy: w Sprint 8 (CustomerInteraction migration) rozważyć finalne usunięcie redundantnych kolumn z Activity

---

## Appendix A — Powiązane pliki (nie czytać jeśli nie potrzebne)

| Plik | Kiedy przydatny |
|---|---|
| `.ai/specs/2026-06-15-activity-extensibility-architecture.md` | Szczegółowa architektura rejestru — dobre tło przed implementacją |
| `.ai/specs/2026-06-15-sprint1-activity-technical-spec.md` | Sprint 1 API contracts — reference dla backward compat |
| `src/modules/activities/data/entities.ts` | Istniejąca encja Activity — przed edycją |
| `src/modules/activities/activity-types.ts` | Built-in types (Layer 1) — punkt wyjścia dla generatora |
| `.mercato/generated/` | Output katalogu generatora — nie edytować ręcznie |

## Appendix B — Kolejność implementacji (sugerowana)

1. Generator extension — ActivityTypeDefinition type + `activity-types.generated.ts` output
2. ActivityLink migration (struktura + dane)
3. ActivityLink CRUD API
4. Registry endpoint `GET /api/activity-types`
5. Updated `GET /api/activities/:id` (links embedded)
6. `includeLinked` query param w GET /api/activities
7. UI: lazy renderer loading + DefaultActivityCard
8. UI: dynamic filter bar
9. Testy jednostkowe i integracyjne
10. i18n keys dla nowych typów (jeśli dodawane)

---

## Changelog

| Data | Zmiana |
|---|---|
| 2026-06-15 | Dokument stworzony — Sprint 2 technical specification |
