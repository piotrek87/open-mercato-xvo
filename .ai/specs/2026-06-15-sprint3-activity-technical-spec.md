# Activity Module — Sprint 3 Technical Specification
# Activity Creation UX

**Data**: 2026-06-15
**Status**: Draft — awaiting review
**Sprint**: 3
**Zależności**: Sprint 1 + Sprint 2 muszą być zmigrowane
**Poprzednia specyfikacja**: `.ai/specs/2026-06-15-sprint2-activity-technical-spec.md`
**Architektura produktowa**: `.ai/specs/2026-06-15-activity-product-architecture.md`

---

## TLDR

Sprint 3 dostarcza kompletny UX tworzenia aktywności: drawer do pełnego formularza + quick-log
inline na osi czasu. Formularz jest dynamiczny — pola renderowane na podstawie `ActivityTypeDefinition.capabilities`.
Kontekst encji (klient, firma, zamówienie) jest pre-wypełniany automatycznie.
Sprint 3 wprowadza też dictionary-backed types (Layer 3 rejestru typów).

---

## Scope Sprint 3

| Area | Deliverable |
|---|---|
| Modal vs Drawer | Decyzja: Drawer (`Sheet side=right`) dla pełnego formularza; Dialog dla quick-log note |
| Quick-log flow | `InlineActivityComposer` w timeline — bezpośredni POST dla notatki, Drawer dla reszty |
| Full-form flow | `LogActivityDrawer` — dynamiczne pola, type-picker, walidacja client-side + server-side |
| Dynamic Form Architecture | Renderer capabilities-driven; pola opcjonalne pokazywane/ukrywane per type |
| Activity Creation Context | Pre-fill `linkedEntityType` + `linkedEntityId` ze kontekstu strony |
| Standalone creation | Strona `/backend/activities/new` — pełny formularz bez pre-fill |
| Validation Strategy | Zod client-side + server echo; error mapping do pól formularza |
| Optimistic updates | Timeline dodaje kartę w locie przed potwierdzeniem z API |
| Dictionary-backed types | Layer 3: typy z DB (tabela `activity_type_definitions`) — CRUD w backendzie |
| i18n | Wszystkie nowe klucze |
| Testy | Unit: form field visibility logic; Integration: POST /api/activities |

**Out of scope Sprint 3:** edycja aktywności (Sprint 4 UX), powiadomienia przy complete (Sprint 4),
bulk actions, O365 sync.

---

## 1. Modal vs Drawer — decyzja architektoniczna

### 1.1 Wybór komponentu

**Pełny formularz**: `Sheet` (z `@open-mercato/ui/primitives/sheet`) z `side="right"`.

Uzasadnienie:
- Użytkownik widzi oś czasu za drawerem podczas wypełniania — weryfikuje kontekst
- `Sheet side="right"` ma `sm:max-w-md` — wystarczające dla formularza
- Nie przerywa nawigacji po stronie — nie wymaga osobnej route
- Spójne z NotificationPanel (ten sam komponent)

**Quick-log notatka**: `Dialog` (z `@open-mercato/ui/primitives/dialog`) — modal, bo:
- Notatka to 2 pola (subject + notes) — nie wymaga sidebara
- Szybsza interakcja: wpisz + Enter; bez scrollowania
- Uzasadniony modal — użytkownik jest w stanie "skupienia"

**Samodzielna strona** `/backend/activities/new`: dedykowana strona z pełnym `CrudForm`.
Dostępna z przycisku "Nowa aktywność" na liście (`backend/page.tsx`).

### 1.2 Hierarchia otwarcia

```
Timeline widget
  ↓ klik "Log Activity" → LogActivityDrawer (Sheet side=right)
  ↓ klik "Notatka" w InlineActivityComposer → QuickNoteDialog (Dialog)
  ↓ klik innego typu w InlineActivityComposer → LogActivityDrawer z pre-wybranym typem

Lista /backend/activities
  ↓ klik "Nowa aktywność" → /backend/activities/new (page)

Strona detalu klienta / firmy / zamówienia
  ↓ Button "Log Activity" w header → LogActivityDrawer z pre-fill kontekstu
```

### 1.3 Mobile (narrower viewport)

`Sheet side="right"` automatycznie zajmuje `w-full` poniżej `sm` breakpointa — pełny ekran.
`QuickNoteDialog` na mobile: `DialogContent` z `max-h-[90vh]` i `overflow-y-auto`.
Nie wprowadzamy osobnych komponentów dla mobile — responsywność przez Tailwind breakpointy.

---

## 2. Quick-log Flow — InlineActivityComposer

### 2.1 Anatomia komponentu

```
src/modules/activities/widgets/injection/timeline/InlineActivityComposer.tsx
```

Umiejscowienie: nad listą aktywności w `ActivityTimelineWidget`, zawsze widoczny (nie collapsible).

```
┌──────────────────────────────────────────────────────────┐
│  [📝] [📞] [✅] [📅] [✉️] ← przyciski typów             │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Dodaj notatkę...                                   │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

Renderowanie typów: z `getAllActivityTypes()` (generated registry).
Domyślnie zaznaczony: `note` (pierwsza pozycja, bo `lifecycleMode: 'fact'` + `hasBody: true`).

### 2.2 Dwa path wykonania

**Path A — type = note (quick-log):**
1. User klika przycisk `note` (lub jest domyślnie wybrany)
2. Textarea otwiera się inline (nie otwiera Drawera)
3. `subject` = pierwsze 100 znaków tekstu (auto-derive) lub user podaje osobno
4. Enter lub klik "Dodaj" → POST /api/activities
5. Optimistic update: karta pojawia się natychmiast, spinner na ikonie
6. Sukces: flash "Notatka dodana", karta pozostaje
7. Błąd: karta znika, flash "Nie udało się dodać notatki", textarea odrestaurowana

**Path B — type ≠ note:**
1. User klika inny typ (call, meeting, task, email, lub Layer 3)
2. Otwiera się `LogActivityDrawer` z pre-wybranym typem i pre-fill kontekstu (entityType, entityId)
3. Formularz pełny — patrz §3

### 2.3 Warianty subject derivation

| Przypadek | Zachowanie |
|---|---|
| User wpisał tekst < 100 znaków | `subject = tekst`, `notes = null` |
| User wpisał tekst > 100 znaków | `subject = tekst[0..97] + "…"`, `notes = pełny tekst` |
| Brak tekstu, klik Dodaj | Inline error: "Treść notatki jest wymagana" |

### 2.4 Props InlineActivityComposer

```typescript
interface InlineActivityComposerProps {
  entityType: string
  entityId: string
  organizationId: string
  onActivityCreated: (activity: ActivityCardData) => void
}
```

---

## 3. Full-form Flow — LogActivityDrawer

### 3.1 Plik

```
src/modules/activities/widgets/injection/timeline/LogActivityDrawer.tsx
```

Używa `Sheet` z `@open-mercato/ui/primitives/sheet`.

### 3.2 Struktura drawera

```
SheetHeader
  SheetTitle: "Log Activity"                          [X]

SheetContent (overflow-y-auto)
  ActivityTypePicker         ← krok 1: wybór typu (zawsze widoczny)
  ─────────────────────────────
  ActivityFormFields         ← krok 2: dynamiczne pola (zależne od typu)

SheetFooter
  [Anuluj]                   [Zapisz aktywność]  (Cmd/Ctrl+Enter)
```

### 3.3 ActivityTypePicker

Wyświetla przyciski typów z ikoną i etykietą. Źródło: `getAllActivityTypes()` + RBAC filter
(pomijaj typy gdzie user nie ma `createFeature`).

Układ: row z `flex-wrap gap-2` (nie dropdown — typy są primary choice, nie secondary).

Po wyborze typu: formularz poniżej animuje się in (fade + slide-down, 150ms).

### 3.4 Dynamic Form Fields — capabilities-driven

Mapping `capabilities → pola formularza`:

| Capability | Pola renderowane | Dodatkowe zachowanie |
|---|---|---|
| (zawsze) | `subject` (required) | min 1, max 500 |
| (zawsze) | `visibility` select | default = 'team' |
| (zawsze, task mode) | `status` select | default per type |
| `hasBody` | `notes` textarea | max 10 000 znaków |
| `hasDueDate` | `dueAt` datetime | + `allDay` toggle |
| `hasOwner` | `ownerUserId` user-picker | default = current user |
| `hasParticipants` | `participants` multi-select | email + userId |
| `hasLocation` | `location` text input | max 500 |
| `hasRecurrence` | `recurrenceRule` select | preset patterns |
| `hasDueDate` + `hasBody` | `durationMinutes` number | min 0, max 1440 |

**Fact mode** (lifecycleMode = 'fact'): `status` jest ukryty; `occurredAt` zastępuje `dueAt`
(etykieta "Kiedy", default = now).

**Task mode** (lifecycleMode = 'task'): `status` widoczny; `dueAt` etykieta "Termin".

### 3.5 Pola zawsze widoczne (niezależnie od capabilities)

- `activityType` — hidden input (ustawiony przez type-picker)
- `lifecycleMode` — hidden input (z type definition)
- `subject` — zawsze wymagany
- `visibility` — zawsze, default = 'team'
- Dla fact: `occurredAt`; dla task: `dueAt` (nawet bez `hasDueDate` — bo każda aktywność ma datę)

### 3.6 Pre-fill z kontekstu encji

`LogActivityDrawer` przyjmuje opcjonalne props:

```typescript
interface LogActivityDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialType?: string                  // pre-wybrany typ
  entityType?: string                   // pre-fill link
  entityId?: string                     // pre-fill link
  onActivityCreated?: (activity: ActivityCardData) => void
}
```

Gdy `entityType` + `entityId` są dostarczone:
- `linkedEntityType` i `linkedEntityId` w POST payload są ustawiane automatycznie
- Pole "Powiązane z" wyświetla chip read-only (etykieta "Klient: Jan Kowalski" lub "Zamówienie: #1234")
- Użytkownik nie może zmienić primary link z tego kontekstu (tylko z dedykowanego ekranu edycji)

### 3.7 Standalone creation — /backend/activities/new

Plik: `src/modules/activities/backend/new/page.tsx` + `page.meta.ts`

Używa pełnego `CrudForm` (nie Sheet). Dostępna z listy aktywności.
`navHidden: true` — nie pojawia się w sidebarze.
Po sukcesie: redirect do `/backend/activities` + flash.

---

## 4. Dynamic Form Architecture — szczegóły implementacji

### 4.1 Komponenty i odpowiedzialności

```
LogActivityDrawer
  └── ActivityTypePicker         — wybór typu, zwraca ActivityTypeDefinition
  └── ActivityFormFields         — renderuje pola na podstawie typeDef.capabilities
        └── SubjectField
        └── NotesField           (conditional: hasBody)
        └── DateField            (dueAt/occurredAt, conditional logic)
        └── DurationField        (conditional: hasDueDate && hasBody)
        └── LocationField        (conditional: hasLocation)
        └── ParticipantsField    (conditional: hasParticipants)
        └── RecurrenceField      (conditional: hasRecurrence)
        └── OwnerField           (conditional: hasOwner)
        └── StatusField          (conditional: task mode)
        └── VisibilityField      (always)
```

### 4.2 Form state management

Nie używamy `CrudForm` dla drawera — formularz jest zbyt dynamiczny (pola zmieniają się po
wyborze typu). Zamiast tego: `react-hook-form` bezpośrednio + Zod resolver.

```typescript
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
```

Schemat Zod: `activityCreateSchema` z `validators.ts` — już zawiera wszystkie pola.
Nie tworzmy nowego schematu — adapter dla react-hook-form wystarczy.

### 4.3 Zmiana typu — reset strategia

Gdy user zmienia typ przez ActivityTypePicker:

```
Zachowaj:  subject, ownerUserId, visibility
Resetuj:   notes, dueAt, occurredAt, location, participants, recurrenceRule, durationMinutes, allDay
Ustaw:     lifecycleMode (z nowego typeDef), status (default per lifecycleMode)
```

Uzasadnienie: subject to dane wpisane przez usera. Reszta to typ-specyficzne konfiguracje.

### 4.4 Fallback behavior — nieznany typ

Gdy `ActivityTypeDefinition` nie istnieje w rejestrze (typ z Layer 3 nie wygenerowany):

```
Pokaż: subject (zawsze), notes (fallback), visibility
Ukryj: wszystkie capability-specific fields
Log warning: console.warn('[activities] unknown type:', typeId)
Nie crash — formularz działa, zapis przechodzi
```

### 4.5 Strona /backend/activities/new — CrudForm fields

Pełna lista pól dla CrudForm (widok standalone, bez kontekstu encji):

```typescript
const fields: CrudField[] = [
  { key: 'activityType', label: t('activities.form.type'), type: 'select', required: true, options: [...] },
  { key: 'subject', label: t('activities.form.subject'), type: 'text', required: true },
  { key: 'notes', label: t('activities.form.notes'), type: 'textarea' },
  { key: 'dueAt', label: t('activities.form.dueAt'), type: 'datetime' },
  { key: 'occurredAt', label: t('activities.form.occurredAt'), type: 'datetime' },
  { key: 'ownerUserId', label: t('activities.form.owner'), type: 'text' },
  { key: 'visibility', label: t('activities.form.visibility'), type: 'select', options: [...] },
  { key: 'linkedEntityType', label: t('activities.form.linkedEntityType'), type: 'text' },
  { key: 'linkedEntityId', label: t('activities.form.linkedEntityId'), type: 'text' },
]
```

Strona standalone nie ma dynamicznej logiki ukrywania pól — wszystkie pola widoczne,
capabilities-driven UI jest w Drawer (kontekst timeline).

---

## 5. Activity Creation Context

### 5.1 Konteksty startowe

| Kontekst | Jak Drawer się otwiera | Pre-fill |
|---|---|---|
| Oś czasu klienta osoby | `InlineActivityComposer` lub button "Log Activity" | `linkedEntityType: 'customers:person'`, `linkedEntityId: <id>` |
| Oś czasu firmy | j.w. | `linkedEntityType: 'customers:company'`, `linkedEntityId: <id>` |
| Oś czasu zamówienia | j.w. | `linkedEntityType: 'sales:order'`, `linkedEntityId: <id>` |
| Lista aktywności | Przycisk "Nowa aktywność" | Redirect do `/backend/activities/new` (brak kontekstu) |
| Standalone | URL `/backend/activities/new` | Brak pre-fill |

### 5.2 Przekazywanie kontekstu do widget

`LogActivityDrawer` jest montowany wewnątrz `ActivityTimelineWidget`.
`context` prop widget zawiera `entityType` i `entityId` — te same wartości trafiają do Drawera.

Nie ma globalnego store — kontekst przepływa przez props (prosto, bez Redux/Zustand).

### 5.3 "Linked to" chip w Drawerze

Gdy kontekst jest znany, Drawer pokazuje chip:

```
Powiązane z: [🧑 Jan Kowalski ×]
```

`×` jest disabled (nie można usunąć primary link z Drawera).
Etykieta pochodzi z `entityType` — moduł activities musi rozwiązać nazwę przez API.

**Problem**: activities module nie może importować modułu customers ani sales (zasada: Activity
nie importuje innych modułów). Rozwiązanie: widget injection slot + enricher pattern.

**Decyzja Sprint 3**: chip pokazuje tylko `entityType: entityId` (np. "customers:person: abc-123")
bez nazwy własnej encji. Czytelna nazwa encji → Sprint 4 (enricher API pattern).

Uzasadnienie: nie wprowadzamy cross-module dependency dla Sprint 3. UX jest akceptowalny
— user właśnie kliknął na stronie klienta, więc wie co linkuje.

---

## 6. Validation Strategy

### 6.1 Client-side (react-hook-form + Zod)

Schemat: `activityCreateSchema` z `validators.ts` (bez zmian w Sprint 3).
Resolver: `@hookform/resolvers/zod` → automatyczne mapowanie błędów do pól.

Triggery walidacji:
- `onBlur` — nie blokuje UX podczas wpisywania
- `onSubmit` — pełna walidacja przed POST

Zachowanie przy błędach:
- Pole z błędem: `border-destructive` + `text-status-error-text` pod polem
- Przycisk "Zapisz" pozostaje aktywny (nie disabled) — pozwala na ponowny submit po poprawce
- Focus przenosi się na pierwsze pole z błędem po submit

### 6.2 Server-side validation

`POST /api/activities` już waliduje przez `activityCreateSchema` Zod.
Błędy Zod są zwracane jako:

```json
{
  "error": "Validation failed",
  "fieldErrors": {
    "subject": ["String must contain at least 1 character(s)"],
    "dueAt": ["Invalid datetime string"]
  }
}
```

### 6.3 Error mapping — server → form

Drawer mapuje odpowiedź serwera na pola formularza przez `react-hook-form.setError()`:

```typescript
if (response.fieldErrors) {
  Object.entries(response.fieldErrors).forEach(([field, messages]) => {
    form.setError(field as keyof ActivityFormData, {
      type: 'server',
      message: messages[0],
    })
  })
}
```

Błędy bez przypisanego pola (np. "Activity limit exceeded"): `flash('…', 'error')` + drawer
pozostaje otwarty.

### 6.4 Przypadki specjalne

| Przypadek | Zachowanie |
|---|---|
| `lifecycleMode` niezgodny z `activityType` | Server corrects (lifecycleMode pochodzi z type definition) |
| `dueAt` w przeszłości | Warning chip w polu "są pewny? To jest data w przeszłości" — nie blokuje zapisu |
| `occurredAt` > now | Warning chip "Data wystąpienia jest w przyszłości" — nie blokuje |
| `linkedEntityId` bez `linkedEntityType` | Zod refine catch po stronie client — "Uzupełnij typ encji" |

---

## 7. Timeline Integration

### 7.1 Optimistic update pattern

Po kliknięciu "Zapisz" w Drawerze:

1. **Zamknij Drawer** natychmiast (lepsza percepcja szybkości)
2. **Dodaj kartę placeholder** na początek listy z `isOptimistic: true`
   - Karta ma `opacity-60` + skeleton shimmer na metadanych
   - Akcje (Edytuj, Ukończ) są disabled
3. **POST /api/activities** w tle
4. **Sukces:**
   - Zastąp kartę placeholder odpowiedzią z API (pełna karta)
   - `flash('Aktywność dodana', 'success')`
5. **Błąd:**
   - Usuń kartę placeholder
   - Przywróć Drawer z wypełnionymi danymi (nie resetuj formularza)
   - `flash('Nie udało się zapisać aktywności', 'error')`
   - Pokaż błędy walidacji jeśli serwer zwrócił `fieldErrors`

### 7.2 Quick-log note (uproszczone optimistic)

Jak wyżej, ale: Drawer nie istnieje — textarea jest inline.
Po sukcesie: wyczyść textarea. Po błędzie: przywróć tekst w textarea.

### 7.3 Refresh strategy

**Nie ma full-page refresh** — optimistic update jest wystarczający dla UX.

Wyjątek: po powrocie do strony z innej zakładki (page visibility change) → silent refresh
listy aktywności (bez optimistic, z loading spinner na ikonie odświeżania, nie na całej liście).

```typescript
React.useEffect(() => {
  const handleVisibility = () => {
    if (document.visibilityState === 'visible') void loadActivities()
  }
  document.addEventListener('visibilitychange', handleVisibility)
  return () => document.removeEventListener('visibilitychange', handleVisibility)
}, [loadActivities])
```

### 7.4 Sortowanie po dodaniu

Nowe aktywności (fact mode): `occurredAt` = now → trafiają na górę historii.
Nowe aktywności (task mode): `dueAt` = user-selected → trafiają do sekcji "Zaplanowane".

Po optimistic insert: nowa karta na górze listy. Po refresh: lista sortowana przez API (desc createdAt).
Krótka rozbieżność sortowania (karta widoczna dwa razy przez < 1s) jest akceptowalna.
Rozwiązanie: deduplicate po `id` przy mergu odpowiedzi API.

---

## 8. API — istniejące endpointy i rozszerzenia

### 8.1 Istniejące endpointy (bez zmian)

| Endpoint | Status | Uwagi |
|---|---|---|
| `POST /api/activities` | ✅ gotowy | Walidacja Zod, eventy, encryption |
| `GET /api/activities` | ✅ gotowy | Cursor pagination, filtry, includeLinked |
| `GET /api/activities/:id` | ✅ gotowy | Embedded links |
| `GET /api/activity-types` | ✅ gotowy | RBAC filter, moduleId query |

### 8.2 Wymagane rozszerzenia Sprint 3

#### 8.2.1 POST /api/activities — response body

Aktualnie: `{ data: { id, ...activity } }`.
Sprint 3 wymaga pełnego response DTO (z `links: []`) dla optimistic update.

Zmiana: `POST /api/activities` zwraca ten sam kształt co `GET /api/activities/:id`
(z `links: []` inicjalnie puste, bo nowo tworzona aktywność nie ma jeszcze linków poza primary).

Sprawdzić: czy `mapActivityToResponse` jest wywoływany w POST handlerze z `links` — jeśli nie, dodać.

#### 8.2.2 GET /api/activity-types — pole `defaultValues`

Dodać do `ActivityTypeDefinition` (i do response rejestru) pole `defaultValues`:

```typescript
defaultValues?: {
  status?: string
  visibility?: string
  priority?: number
  durationMinutes?: number
  occurredAt?: 'now' | null     // 'now' = auto-fill current datetime
  dueAt?: 'end_of_day' | null   // 'end_of_day' = auto-fill
}
```

Pozwala na type-specific defaults bez logiki w frontendzie (np. `note` domyślnie `occurredAt: 'now'`,
`task` domyślnie `dueAt: 'end_of_day'`).

Dodać `defaultValues` do `ActivityTypeDefinition` interface i do `activityTypes` array.

#### 8.2.3 Brak nowych endpointów

Sprint 3 nie wymaga nowych endpointów API. Cały flow używa istniejącego `POST /api/activities`.

---

## 9. Dictionary-backed Activity Types (Layer 3)

### 9.1 Cel

Layer 3 pozwala administratorowi systemu definiować własne typy aktywności przez UI backendu,
bez deploymentu kodu. Typy są przechowywane w bazie danych.

Przykłady: "Wizyta handlowa", "Demo produktu", "Szkolenie onboarding", "Ticket support".

### 9.2 Encja ActivityTypeDefinitionRecord

Nowa tabela: `activity_type_definitions`

```
Kolumny:
  id                 UUID PK
  type_id            VARCHAR(100) UNIQUE NOT NULL    -- np. 'custom:demo'
  module_id          VARCHAR(100) NOT NULL DEFAULT 'activities'
  label              VARCHAR(200) NOT NULL
  icon               VARCHAR(100) NOT NULL DEFAULT 'Activity'
  color              VARCHAR(50) NULL
  lifecycle_mode     VARCHAR(10) NOT NULL DEFAULT 'task'
  capabilities       JSONB NOT NULL DEFAULT '{}'
  view_feature       VARCHAR(200) NULL
  create_feature     VARCHAR(200) NULL
  filter_label       VARCHAR(200) NULL
  filter_group       VARCHAR(100) NULL
  is_active          BOOLEAN NOT NULL DEFAULT true
  sort_order         SMALLINT NOT NULL DEFAULT 0
  organization_id    UUID NOT NULL                  -- tenant-scoped
  tenant_id          UUID NOT NULL
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Constraints:
- UNIQUE (type_id, organization_id) — per-tenant namespace
- `type_id` format: `custom:<identifier>` (prefix wymuszony przez Zod)

### 9.3 Integracja z rejestrem (runtime merge)

`GET /api/activity-types` dla Layer 3:

```
1. Pobierz Layer 1+2 z generated registry (build-time)
2. Pobierz Layer 3 z DB (activity_type_definitions WHERE is_active=true, ORDER BY sort_order)
3. Merge: Layer 3 NIE może nadpisać Layer 1+2 (id collision → Layer 1+2 wygrywa + warning)
4. Zwróć merged registry
```

Cache: `activity_type_definitions` per tenant, TTL 60s, invalidowany przy CREATE/UPDATE/DELETE.
Cache key: `tenant:<tenantId>:activity_type_definitions`.

### 9.4 Backend UI — CRUD dla Layer 3

Nowa strona: `/backend/activities/settings/types`

```
page.meta.ts:
  pageGroup: 'activities'
  pageGroupKey: 'activities'
  pageContext: 'settings' as const
  navHidden: true
```

DataTable z kolumnami: Type ID, Label, Icon, Lifecycle, Active (toggle), Sort Order.
Akcje: Create (otwiera Dialog z CrudForm), Edit (Dialog), Delete (tylko custom typy).

API: 4 endpointy CRUD pod `/api/activity-type-definitions`.
Nie używamy `makeCrudRoute` — wymagana jest walidacja `type_id` prefix (`custom:`).

### 9.5 Walidacja Layer 3

```typescript
const activityTypeDefinitionCreateSchema = z.object({
  typeId: z.string().regex(/^custom:[a-z_]+$/, 'Must start with "custom:" followed by lowercase letters and underscores'),
  label: z.string().min(1).max(200),
  icon: z.string().min(1).max(100).default('Activity'),
  color: z.string().max(50).optional(),
  lifecycleMode: z.enum(['fact', 'task']).default('task'),
  capabilities: z.object({
    hasBody: z.boolean().optional(),
    hasDueDate: z.boolean().optional(),
    hasStatus: z.boolean().optional(),
    hasOwner: z.boolean().optional(),
    hasParticipants: z.boolean().optional(),
    hasLocation: z.boolean().optional(),
    hasRecurrence: z.boolean().optional(),
  }).default({}),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
})
```

---

## 10. Pliki do stworzenia / zmodyfikowania

### Nowe pliki

```
src/modules/activities/
  backend/
    new/
      page.tsx                         ← standalone creation page
      page.meta.ts
    settings/
      types/
        page.tsx                        ← Layer 3 CRUD UI
        page.meta.ts
  widgets/injection/timeline/
    InlineActivityComposer.tsx          ← quick-log component
    LogActivityDrawer.tsx               ← full form drawer
    ActivityTypePicker.tsx              ← type selection buttons
    ActivityFormFields.tsx              ← dynamic fields renderer
    QuickNoteDialog.tsx                 ← fast note dialog
  api/
    activity-type-definitions/
      route.ts                          ← Layer 3 CRUD API
  data/
    entities.ts                         ← ADD: ActivityTypeDefinitionRecord entity
    validators.ts                       ← ADD: activityTypeDefinitionCreateSchema
  migrations/
    Migration20260615_sprint3_activities.ts  ← activity_type_definitions table
```

### Modyfikowane pliki

```
src/modules/activities/
  activity-types.ts                     ← ADD: defaultValues field to ActivityTypeDefinition
  api/route.ts                          ← FIX: POST returns full DTO with links: []
  api/activity-types/route.ts           ← ADD: Layer 3 DB merge, cache
  acl.ts                                ← ADD: activities.manage_types feature
  setup.ts                              ← ADD: grant activities.manage_types to admin
  widgets/injection/timeline/
    widget.client.tsx                   ← ADD: InlineActivityComposer, LogActivityDrawer mount
  i18n/en.json                          ← ADD: Sprint 3 keys
  __tests__/sprint3.test.ts             ← NOWY: testy
```

### Kolejność implementacji

| Krok | Zadanie | Uwagi |
|---|---|---|
| 1 | `ActivityTypeDefinitionRecord` entity + migration | `yarn db:generate` |
| 2 | Layer 3 CRUD API (`/api/activity-type-definitions`) | |
| 3 | `/api/activity-types` — merge Layer 3 + cache | Rozszerza istniejący endpoint |
| 4 | `ActivityTypeDefinition.defaultValues` + update `activityTypes` | build-time |
| 5 | POST `/api/activities` — pełny response DTO | Małe fix |
| 6 | `ActivityTypePicker` component | |
| 7 | `ActivityFormFields` — dynamic fields renderer | Serce formularza |
| 8 | `LogActivityDrawer` — Sheet + ActivityTypePicker + ActivityFormFields | |
| 9 | `QuickNoteDialog` | |
| 10 | `InlineActivityComposer` — integruje quick-log + LogActivityDrawer | |
| 11 | Optimistic update logic w `widget.client.tsx` | |
| 12 | Page `/backend/activities/new` — CrudForm standalone | |
| 13 | Page `/backend/activities/settings/types` — Layer 3 admin UI | |
| 14 | Testy jednostkowe | |
| 15 | i18n Sprint 3 |  |

---

## 11. i18n — nowe klucze Sprint 3

```json
{
  "activities.form.type": "Activity type",
  "activities.form.subject": "Subject",
  "activities.form.notes": "Notes",
  "activities.form.dueAt": "Due date",
  "activities.form.occurredAt": "When",
  "activities.form.owner": "Owner",
  "activities.form.visibility": "Visibility",
  "activities.form.location": "Location",
  "activities.form.participants": "Participants",
  "activities.form.recurrence": "Recurrence",
  "activities.form.duration": "Duration (minutes)",
  "activities.form.allDay": "All day",
  "activities.form.status": "Status",
  "activities.form.linkedTo": "Linked to",
  "activities.form.submit": "Log Activity",
  "activities.form.cancel": "Cancel",
  "activities.form.title": "Log Activity",
  "activities.form.subject.placeholder": "What happened or what needs to be done?",
  "activities.form.notes.placeholder": "Additional details…",

  "activities.compose.placeholder": "Add a note…",
  "activities.compose.add": "Add",
  "activities.compose.noSubject": "Note content is required",

  "activities.drawer.title": "Log Activity",

  "activities.type.definitions.page.title": "Activity Types",
  "activities.type.definitions.column.typeId": "Type ID",
  "activities.type.definitions.column.label": "Label",
  "activities.type.definitions.column.lifecycle": "Lifecycle",
  "activities.type.definitions.column.active": "Active",
  "activities.type.definitions.action.create": "New type",
  "activities.type.definitions.error.duplicate": "This type ID already exists",
  "activities.type.definitions.error.builtIn": "Built-in types cannot be deleted",

  "activities.create.page.title": "New Activity",
  "activities.create.success": "Activity logged",
  "activities.create.error": "Failed to log activity",
  "activities.create.dueInPast": "This date is in the past",
  "activities.create.occurredInFuture": "This date is in the future",

  "activities.optimistic.saving": "Saving…",
  "activities.optimistic.error": "Failed to save activity"
}
```

---

## 12. RBAC — nowe feature

| Feature ID | Opis | Kto dostaje |
|---|---|---|
| `activities.manage_types` | CRUD dla Layer 3 (activity_type_definitions) | admin, superadmin |

Dodać do `acl.ts` i `setup.ts`, następnie `yarn mercato auth sync-role-acls`.

---

## 13. Acceptance Criteria

### 13.1 Quick-log flow

- [ ] `InlineActivityComposer` jest widoczny w timeline widget na stronie klienta, firmy i zamówienia
- [ ] Klik na "Notatka" otwiera textarea inline (nie Drawer)
- [ ] Enter lub klik "Dodaj" zapisuje notatkę z poprawnym `linkedEntityType` i `linkedEntityId`
- [ ] Nowa notatka pojawia się na liście natychmiast (optimistic)
- [ ] Błąd API: textarea nie jest czyszczona, flash error, karta placeholder znika
- [ ] Klik na dowolny inny typ (call, meeting, task, email) otwiera `LogActivityDrawer`

### 13.2 Full-form Drawer

- [ ] Drawer otwiera się ze strony kontekstu encji z pre-wybranym primary link chip
- [ ] Type picker renderuje typy z RBAC filter (nie pokazuje typów bez `createFeature`)
- [ ] Zmiana typu: formularz zmienia pola, zachowuje subject
- [ ] Pola widoczne/ukryte zgodnie z `capabilities` wybranego typu
- [ ] Fact mode: `occurredAt` default = teraz, `status` ukryty
- [ ] Task mode: `dueAt` widoczny, `status` widoczny
- [ ] `Cmd/Ctrl+Enter` submituje formularz
- [ ] `Escape` zamyka Drawer
- [ ] Błędy walidacji client-side: wyświetlane pod polami
- [ ] Błędy server-side (`fieldErrors`): mapowane do pól formularza

### 13.3 Standalone creation

- [ ] `/backend/activities/new` dostępna z listy aktywności
- [ ] Formularz zawiera wszystkie pola z `activityCreateSchema`
- [ ] Po zapisie: redirect do listy + flash sukcesu
- [ ] TypeScript: 0 błędów, testy: 0 failed

### 13.4 Layer 3

- [ ] Admin może tworzyć typy z prefixem `custom:` przez UI
- [ ] Typy z DB są zwracane przez `GET /api/activity-types` (za Layer 1+2)
- [ ] Type picker w Drawerze renderuje Layer 3 typy
- [ ] Built-in types nie mogą być usunięte przez CRUD UI
- [ ] Cache invalidacja: po CREATE/UPDATE/DELETE typu → TTL reset

### 13.5 Optimistic updates

- [ ] Karta placeholder pojawia się natychmiast po kliknięciu "Zapisz"
- [ ] Karta placeholder ma wygaszony wygląd (`opacity-60`)
- [ ] Po odpowiedzi API: karta placeholder zastąpiona pełną kartą
- [ ] Deduplication: przy refresh listy karta nie pojawia się dwa razy

### 13.6 API

- [ ] `POST /api/activities` zwraca pełny DTO z `links: []`
- [ ] `GET /api/activity-types` zwraca merged registry (L1+L2+L3)
- [ ] `GET /api/activity-type-definitions` paginacja, filtry
- [ ] `POST /api/activity-type-definitions` walidacja `typeId` prefix `custom:`
- [ ] `PATCH /api/activity-type-definitions/:id` — partial update
- [ ] `DELETE /api/activity-type-definitions/:id` — soft delete (is_active = false)

---

## 14. Ryzyka i tradeoffs UX

| ID | Ryzyko | Prawdopodobieństwo | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | **Optimistic card flicker** — karta placeholder zastąpiona przez API response powoduje widoczne "przeskoczenie" jeśli dane różnią się (np. subject auto-trim) | Średnie | Niski | Animacja cross-fade 150ms przy zastąpieniu |
| R-2 | **Type picker overflow** — Layer 3 typy mogą przepełnić row layout, szczególnie na mobile | Średnie | Średni | `flex-wrap` + collapsible "więcej typów" jeśli > 6 typów na screen |
| R-3 | **Lost work przy błędzie sieciowym** — user wypełnił formularz, sieć pada, Drawer się zamknął | Niskie | Wysoki | Po błędzie API: Drawer ponownie otwierany z zapisanymi danymi; `localStorage` sessionStorage jako fallback |
| R-4 | **Layer 3 cache stale** — admin zmienia typ, user widzi stare dane przez 60s | Niskie | Niski | TTL 60s jest akceptowalny; przycisk "Odśwież" w type picker (hidden, shift+click) |
| R-5 | **Fact/task mismatch** — user wybiera typ o `lifecycleMode: 'fact'`, ale chce ustawić `status` | Niskie | Niski | Server przyjmuje, ignoruje status dla fact; UI ukrywa pole — user nie może wpisać złego |
| R-6 | **`linkedEntityType` jako string** — user na stronie standalone może wpisać niepoprawny format | Średnie | Średni | Zod regex validation na kliencie + serwer; dropdown z pre-definowanymi opcjami na stronie standalone |
| R-7 | **Drawer na mobile blokuje widok osi czasu** — Sheet side=right zajmuje 100% width poniżej sm | Niskie | Niski | Akceptowalny tradeoff — mobilny UX wymaga full-screen form |
| R-8 | **Optimistic + offline** — POST nigdy nie wraca (timeout) | Niskie | Średni | Timeout 10s na POST; po timeout: karta znika, flash "Request timed out — aktywność może nie być zapisana", retry button |

### 14.1 Kluczowy tradeoff: Drawer vs osobna strona dla pełnego formularza

**Opcja A — Drawer (wybrana):**
- Pro: User widzi kontekst encji; brak nawigacji; lepsza percepcja szybkości
- Con: Ograniczona przestrzeń (md breakpoint); trudniejszy deep-link

**Opcja B — Osobna strona:**
- Pro: Pełna przestrzeń; prostszy state management; deep-linkable
- Con: Utrata kontekstu strony; poczucie porzucenia widoku

**Decyzja**: Drawer dla kontekstu encji, strona dla standalone. Oba mają pełną funkcjonalność.

### 14.2 Tradeoff: brak nazwy encji w "Linked to" chip

Chip pokazuje `entityType:entityId` zamiast czytelnej nazwy (np. "Jan Kowalski").
Użytkownik otwiera Drawer z danej strony — wie co linkuje. Czytalna nazwa → Sprint 4.
Alternatywa (cross-module import) złamałaby zasadę izolacji modułów.

### 14.3 Tradeoff: subject auto-derive dla notatki

Pierwszych 100 znaków staje się subjectem automatycznie. Alternatywa: osobne pole subject.
Wybrano auto-derive — szybszy UX dla quick-log. Pełna forma (Drawer) ma osobny subject.

---

## 15. Otwarte pytania

1. **Powiadomienia przy complete (Sprint 3+):** Czy ukończenie task activity triggeruje notyfikację?
   Decyzja wymagana przed implementacją `activities/notifications.ts`. Rekomendacja: zdecydować
   na początku Sprint 4.

2. **Default owner:** Czy `ownerUserId` w formularzu domyślnie ustawiony na zalogowanego usera?
   Rekomendacja: tak — eliminuje najczęstszy krok. Wymaga dostępu do `session.userId` w kliencie.

3. **Participants input UX:** Jak user dodaje uczestników — email input? User picker z listy staff?
   Rekomendacja dla Sprint 3: plain text email input (multi-value). User picker (staff lookup) → Sprint 4.

4. **Recurrence rule format:** RRULE string czy preset dropdown?
   Rekomendacja: preset dropdown w Sprint 3 (Daily, Weekly, Monthly, Biweekly) → pełny RRULE Sprint 4.

---

## Changelog

| Data | Zmiana |
|------|--------|
| 2026-06-15 | Initial spec — Sprint 3 Activity Creation UX |
