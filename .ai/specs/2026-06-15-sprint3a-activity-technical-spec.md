# Activity Module — Sprint 3A Technical Specification
# Activity Creation UX

**Data**: 2026-06-15
**Status**: Approved — ready to implement
**Sprint**: 3A
**Branch**: `feat/activities-sprint3a` (base: `feat/activities-sprint2`)
**Zależności**: Sprint 1 + Sprint 2 zaimplementowane i zmigrowane
**Poprzednia specyfikacja**: `.ai/specs/2026-06-15-sprint2-activity-technical-spec.md`
**Powiązane**: `.ai/specs/2026-06-15-sprint3-activity-technical-spec.md` (pełny Sprint 3, §1–8 + §10–15)

> Sprint 3A wydziela UX tworzenia aktywności bez Layer 3 (dictionary-backed types).
> Layer 3 = Sprint 3B. Podział uzasadniony w Architecture Review 2026-06-15.

---

## TLDR

Sprint 3A dostarcza kompletny UX tworzenia aktywności:
- `InlineActivityComposer` — quick-log inline w timeline (notatka bezpośrednio, inne typy → Drawer)
- `LogActivityDrawer` — pełny formularz w Sheet side=right, capabilities-driven fields
- Optimistic update — karta pojawia się natychmiast, wraca przy błędzie
- `/backend/activities/new` — standalone strona z CrudForm
- Brak migracji DB. Brak nowych encji.

---

## Scope Sprint 3A

| Area | Deliverable |
|---|---|
| `defaultValues` w `ActivityTypeDefinition` | Per-type defaults formularza |
| POST `/api/activities` pełny DTO | Zwraca `links: []` dla optimistic update |
| `ActivityTypePicker` | Przyciski typów z ikoną + etykietą, RBAC filter |
| `ActivityFormFields` | capabilities-driven renderer, react-hook-form + Zod |
| `LogActivityDrawer` | Sheet side=right, TypePicker + Fields, pre-fill, Cmd+Enter |
| `QuickNoteDialog` | Dialog dla szybkiej notatki, 2 pola |
| `InlineActivityComposer` | Inline textarea + trigger Drawera |
| Optimistic updates | Placeholder karta, error recovery, deduplication |
| `/backend/activities/new` | Standalone strona CrudForm |
| Testy + i18n | Unit: field visibility; klucze i18n Sprint 3A |

**Out of scope 3A:** Layer 3 (dictionary-backed types), edycja aktywności, powiadomienia.

---

## 1. Decyzje architektoniczne — zatwierdzone

### 1.1 Komponent dla pełnego formularza

**`Sheet` (side=right)** z `@open-mercato/ui/primitives/sheet`.

Uzasadnienie: user widzi oś czasu za Drawerem — weryfikuje kontekst podczas wypełniania.
Nie przerywa nawigacji, nie wymaga osobnej route. Spójne z NotificationPanel.

### 1.2 Komponent dla quick-note

**`Dialog`** (inline textarea) — nie Drawer. 2 pola (subject auto-derive + notes). Enter submituje.

### 1.3 Form state management

**`react-hook-form` + Zod resolver** — nie `CrudForm`.
`CrudForm` jest statyczny; tu pola zmieniają się dynamicznie po wyborze typu.
Schemat: `activityCreateSchema` z `validators.ts` (bez zmian).

### 1.4 "Linked to" chip bez nazwy encji

Chip pokazuje `entityType:entityId`. Czytelna nazwa encji → Sprint 4 (enricher pattern).
Nie importujemy modułów customers/sales — naruszałoby izolację modułów.

### 1.5 Default owner

`ownerUserId` domyślnie = zalogowany user (`session.userId` z `getAuthFromRequest`).
Rozwiązywane po stronie serwera przy POST jeśli pole puste — nie wymaga zmian klienta.

### 1.6 Participants w Sprint 3A

Plain text email input (multi-value, comma-separated). User picker ze staff → Sprint 4.

### 1.7 Recurrence rule w Sprint 3A

Preset dropdown: Daily, Weekly, Biweekly, Monthly. Pełny RRULE string → Sprint 4.

---

## 2. `defaultValues` w `ActivityTypeDefinition`

### 2.1 Rozszerzenie interfejsu

Dodać do `ActivityTypeDefinition` w `activity-types.ts`:

```typescript
export interface ActivityTypeDefaultValues {
  status?: string
  visibility?: string
  priority?: number
  durationMinutes?: number
  occurredAt?: 'now' | null      // 'now' = auto-fill current datetime w formularzu
  dueAt?: 'end_of_day' | null    // 'end_of_day' = koniec bieżącego dnia
}

export interface ActivityTypeDefinition {
  // ... istniejące pola bez zmian ...
  defaultValues?: ActivityTypeDefaultValues
}
```

### 2.2 Zaktualizowane wartości dla 5 built-in typów

| Type | lifecycleMode | defaultValues |
|---|---|---|
| `email` | fact | `{ occurredAt: 'now', visibility: 'team' }` |
| `meeting` | task | `{ dueAt: 'end_of_day', visibility: 'team', durationMinutes: 60 }` |
| `call` | task | `{ dueAt: 'end_of_day', visibility: 'team', durationMinutes: 15 }` |
| `note` | fact | `{ occurredAt: 'now', visibility: 'team' }` |
| `task` | task | `{ dueAt: 'end_of_day', visibility: 'team', status: 'not_started' }` |

### 2.3 Rozwiązywanie `defaultValues` w formularzu

```typescript
function resolveDefaultValues(typeDef: ActivityTypeDefinition): Partial<ActivityFormData> {
  const dv = typeDef.defaultValues ?? {}
  return {
    activityType: typeDef.id,
    lifecycleMode: typeDef.lifecycleMode,
    visibility: dv.visibility ?? 'team',
    status: dv.status ?? (typeDef.lifecycleMode === 'task' ? 'not_started' : undefined),
    durationMinutes: dv.durationMinutes ?? null,
    priority: dv.priority ?? null,
    dueAt: dv.dueAt === 'end_of_day' ? endOfDay(new Date()).toISOString() : null,
    occurredAt: dv.occurredAt === 'now' ? new Date().toISOString() : null,
  }
}
```

`endOfDay` = `new Date().setHours(23, 59, 0, 0)` — bez zewnętrznej biblioteki date.

---

## 3. POST `/api/activities` — pełny response DTO

### 3.1 Problem

`POST /api/activities` aktualnie zwraca niepełną odpowiedź (bez pola `links`).
Optimistic update wymaga pełnego kształtu identycznego z `GET /api/activities/:id`.

### 3.2 Zmiana

W `src/modules/activities/api/route.ts`, handler POST:

Aktualnie zwraca wynik `mapActivityToResponse(activity)` bez `links`.
Po zmianie: zwraca `mapActivityToResponse(activity, [])` — `links: []` jako puste (nowo tworzona aktywność nie ma jeszcze linków poza primary w `linkedEntityType/Id`).

`mapActivityToResponse` w `api/[id]/route.ts` już przyjmuje `links` — przenieść/wyeksportować
tę funkcję do `api/shared.ts` lub zaimportować cross-file. Zrobić whichever jest prostsze —
nie refaktoryzujemy struktury API poza minimum potrzebne.

---

## 4. `ActivityTypePicker` — specyfikacja komponentu

### 4.1 Plik

```
src/modules/activities/widgets/injection/timeline/ActivityTypePicker.tsx
```

### 4.2 Props

```typescript
interface ActivityTypePickerProps {
  types: ActivityTypeDefinition[]
  selected: string | null
  onSelect: (typeId: string) => void
}
```

### 4.3 Rendering

```
[📧 Email] [📅 Spotkanie] [📞 Rozmowa] [📝 Notatka] [✅ Zadanie]
```

- Każdy przycisk: ikona (lucide-react, z `typeDef.icon`) + etykieta (i18n przez `t(typeDef.label)`)
- Layout: `flex flex-wrap gap-2`
- Wybrany typ: `bg-primary text-primary-foreground`
- Nie wybrany: `bg-muted text-muted-foreground hover:bg-accent`
- Używa `IconButton` z `@open-mercato/ui/primitives/icon-button` z `aria-label` per typ

### 4.4 Ikony — dynamiczny import z lucide-react

```typescript
import dynamicIconImports from 'lucide-react/dynamicIconImports'
// lub: import * as LucideIcons from 'lucide-react'

function getIcon(iconName: string): LucideIcon {
  const icons = LucideIcons as Record<string, LucideIcon>
  return icons[iconName] ?? icons['Activity']
}
```

Fallback: `Activity` (z lucide-react) gdy `typeDef.icon` nie istnieje.

---

## 5. `ActivityFormFields` — specyfikacja komponentu

### 5.1 Plik

```
src/modules/activities/widgets/injection/timeline/ActivityFormFields.tsx
```

### 5.2 Props

```typescript
interface ActivityFormFieldsProps {
  typeDef: ActivityTypeDefinition | undefined
  control: Control<ActivityFormData>   // react-hook-form Control
  errors: FieldErrors<ActivityFormData>
}
```

### 5.3 Mapping capabilities → pola

```
Zawsze widoczne:
  subject         (required, text, max 500)
  visibility      (select: private/team/public, default: team)

Fact mode (lifecycleMode === 'fact'):
  occurredAt      (datetime-local, label: "Kiedy", default: now)
  [status UKRYTY]

Task mode (lifecycleMode === 'task'):
  dueAt           (datetime-local, label: "Termin")
  status          (select: not_started/in_progress/completed)

capabilities.hasBody:
  notes           (textarea, max 10000)

capabilities.hasOwner:
  ownerUserId     (text input — UUID; Sprint 4: user picker)

capabilities.hasParticipants:
  participants    (text input, comma-sep emails; Sprint 4: multi-select)

capabilities.hasLocation:
  location        (text, max 500)

capabilities.hasDueDate AND capabilities.hasBody:
  durationMinutes (number input, min 0 max 1440)

capabilities.hasRecurrence:
  recurrenceRule  (select: preset options)
```

### 5.4 Recurrence preset options

```typescript
const RECURRENCE_PRESETS = [
  { value: '', label: 'activities.form.recurrence.none' },
  { value: 'FREQ=DAILY', label: 'activities.form.recurrence.daily' },
  { value: 'FREQ=WEEKLY', label: 'activities.form.recurrence.weekly' },
  { value: 'FREQ=WEEKLY;INTERVAL=2', label: 'activities.form.recurrence.biweekly' },
  { value: 'FREQ=MONTHLY', label: 'activities.form.recurrence.monthly' },
]
```

### 5.5 Fallback dla nieznanego typu

Gdy `typeDef === undefined`:
- Pokaż: `subject`, `notes`, `visibility`
- Ukryj: wszystkie capability-specific fields
- `console.warn('[activities] unknown type in form:', typeId)`

---

## 6. `LogActivityDrawer` — specyfikacja komponentu

### 6.1 Plik

```
src/modules/activities/widgets/injection/timeline/LogActivityDrawer.tsx
```

### 6.2 Props

```typescript
interface LogActivityDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialType?: string
  entityType?: string
  entityId?: string
  onActivityCreated?: (activity: ActivityResponseDto) => void
}
```

`ActivityResponseDto` = kształt zwracany przez `POST /api/activities` po fix §3.

### 6.3 Struktura

```tsx
<Sheet open={open} onOpenChange={onOpenChange}>
  <SheetContent side="right" className="flex flex-col gap-0 p-0">
    <SheetHeader className="px-6 py-4 border-b">
      <SheetTitle>{t('activities.drawer.title')}</SheetTitle>
    </SheetHeader>

    <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
      <ActivityTypePicker
        types={availableTypes}
        selected={selectedType}
        onSelect={handleTypeChange}
      />
      {selectedType && <Separator />}
      <ActivityFormFields
        typeDef={currentTypeDef}
        control={form.control}
        errors={form.formState.errors}
      />
      {(entityType && entityId) && (
        <LinkedEntityChip entityType={entityType} entityId={entityId} />
      )}
    </div>

    <SheetFooter className="px-6 py-4 border-t">
      <Button variant="outline" onClick={() => onOpenChange(false)}>
        {t('activities.form.cancel')}
      </Button>
      <Button onClick={form.handleSubmit(handleSubmit)} disabled={isSubmitting}>
        {isSubmitting ? <Spinner size="sm" /> : t('activities.form.submit')}
      </Button>
    </SheetFooter>
  </SheetContent>
</Sheet>
```

### 6.4 Keyboard shortcuts

```typescript
React.useEffect(() => {
  function handleKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      void form.handleSubmit(handleSubmit)()
    }
  }
  if (open) document.addEventListener('keydown', handleKey)
  return () => document.removeEventListener('keydown', handleKey)
}, [open, form, handleSubmit])
```

`Escape` — obsługiwany automatycznie przez `Sheet` (Radix Dialog pod spodem).

### 6.5 Zmiana typu — reset strategia

```typescript
function handleTypeChange(typeId: string) {
  const typeDef = types.find(t => t.id === typeId)
  if (!typeDef) return
  const subject = form.getValues('subject')  // zachowaj
  const ownerUserId = form.getValues('ownerUserId')  // zachowaj
  form.reset({
    ...resolveDefaultValues(typeDef),
    subject,        // restore
    ownerUserId,    // restore
  })
  setSelectedType(typeId)
}
```

### 6.6 Submit flow

```typescript
async function handleSubmit(data: ActivityFormData) {
  setIsSubmitting(true)
  const payload = {
    ...data,
    linkedEntityType: entityType ?? data.linkedEntityType,
    linkedEntityId: entityId ?? data.linkedEntityId,
  }
  try {
    const result = await apiCallOrThrow<ActivityResponseDto>('/api/activities', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    onActivityCreated?.(result.data)
    onOpenChange(false)
    flash(t('activities.create.success'), 'success')
  } catch (err) {
    setIsSubmitting(false)
    const fieldErrors = extractFieldErrors(err)
    if (fieldErrors) {
      Object.entries(fieldErrors).forEach(([field, messages]) => {
        form.setError(field as keyof ActivityFormData, { type: 'server', message: messages[0] })
      })
    } else {
      flash(t('activities.create.error'), 'error')
    }
    // Drawer pozostaje otwarty — dane zachowane
  }
}
```

---

## 7. `QuickNoteDialog` — specyfikacja komponentu

### 7.1 Plik

```
src/modules/activities/widgets/injection/timeline/QuickNoteDialog.tsx
```

### 7.2 Props

```typescript
interface QuickNoteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  entityType: string
  entityId: string
  onNoteCreated?: (activity: ActivityResponseDto) => void
}
```

### 7.3 Rendering

```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent className="sm:max-w-md">
    <DialogHeader>
      <DialogTitle>{t('activities.quicknote.title', 'Quick Note')}</DialogTitle>
    </DialogHeader>
    <Textarea
      ref={textareaRef}
      placeholder={t('activities.compose.placeholder')}
      value={text}
      onChange={e => setText(e.target.value)}
      className="min-h-[100px]"
      onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void handleSubmit() }}
    />
    {error && <p className="text-sm text-status-error-text">{error}</p>}
    <DialogFooter>
      <Button variant="outline" onClick={() => onOpenChange(false)}>{t('activities.form.cancel')}</Button>
      <Button onClick={handleSubmit} disabled={isSubmitting}>{t('activities.compose.add')}</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

### 7.4 Subject auto-derive

```typescript
function deriveSubjectAndNotes(text: string): { subject: string; notes: string | null } {
  const trimmed = text.trim()
  if (trimmed.length <= 100) return { subject: trimmed, notes: null }
  return { subject: trimmed.slice(0, 97) + '…', notes: trimmed }
}
```

---

## 8. `InlineActivityComposer` — specyfikacja komponentu

### 8.1 Plik

```
src/modules/activities/widgets/injection/timeline/InlineActivityComposer.tsx
```

### 8.2 Props

```typescript
interface InlineActivityComposerProps {
  entityType: string
  entityId: string
  availableTypes: ActivityTypeDefinition[]
  onActivityCreated: (activity: ActivityResponseDto) => void
}
```

### 8.3 Rendering

```
┌─────────────────────────────────────────────────────────────┐
│  [📧][📅][📞][📝][✅]   ← ActivityTypePicker (compact)      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Dodaj notatkę...                              [→]   │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

Textarea widoczna tylko gdy `selectedType` ma `lifecycleMode === 'fact' && capabilities.hasBody`
(czyli: note, email). Dla pozostałych typów po kliknięciu → natychmiast otwiera Drawer.

### 8.4 Logika

```
1. Domyślnie zaznaczony: 'note'
2. User klika typ:
   a. typ = note/email (hasBody = true, fact mode) → textarea pojawia się inline
   b. typ = task/call/meeting (nie hasBody lub task mode) → otwiera LogActivityDrawer(initialType=typ)
3. User wpisuje tekst w textarea i klika [→] lub Enter:
   → deriveSubjectAndNotes()
   → optimistic card
   → POST /api/activities (type: note, linkedEntityType, linkedEntityId)
   → sukces: textarea czyszczona, onActivityCreated()
   → błąd: tekst zachowany, flash error, placeholder znika
```

### 8.5 State w widget.client.tsx

`InlineActivityComposer` jest bezstanowy w zakresie Drawera — deleguje otwarcie Drawera
do parenta (`ActivityTimelineWidget`) przez callback `onOpenDrawer(type)`.
Drawer state (`isDrawerOpen`, `drawerInitialType`) żyje w `widget.client.tsx`.

---

## 9. Optimistic Update — specyfikacja

### 9.1 Kształt placeholder karty

```typescript
type OptimisticActivity = ActivityCardData & {
  _isOptimistic: true
  _tempId: string       // generowany jako `optimistic-${Date.now()}-${Math.random()}`
}
```

`_isOptimistic` i `_tempId` są strip-owane przed renderowaniem przez `DefaultActivityCard`.

### 9.2 Flow w `widget.client.tsx`

```
onCreate(draft: ActivityFormData) →
  1. Generuj _tempId
  2. Dodaj OptimisticActivity na początek items[]
  3. Drawer/Dialog zamknięty (już)
  4. POST /api/activities
  5a. Sukces → usuń placeholder (_tempId), dodaj response na początku
  5b. Błąd → usuń placeholder (_tempId); jeśli Drawer był: przywróć otwarcie z danymi
```

### 9.3 Rendering placeholdera

```tsx
<li key={item._tempId ?? item.id} className={item._isOptimistic ? 'opacity-60 pointer-events-none' : ''}>
  <DefaultActivityCard activity={item} typeDef={...} />
</li>
```

`pointer-events-none` na placeholderze: user nie może klikać akcji na niezapisanej karcie.

### 9.4 Deduplication po refresh

```typescript
function mergeActivities(
  current: ActivityCardData[],
  fresh: ActivityCardData[]
): ActivityCardData[] {
  const existingIds = new Set(fresh.map(a => a.id))
  const optimistic = current.filter(a => a._isOptimistic && !existingIds.has(a.id))
  return [...optimistic, ...fresh]
}
```

Przy visibility change refresh: karty optimistic zachowane, świeże dane z API mergowane poniżej.

---

## 10. Strona `/backend/activities/new`

### 10.1 Pliki

```
src/modules/activities/backend/new/page.tsx
src/modules/activities/backend/new/page.meta.ts
```

### 10.2 page.meta.ts

```typescript
export const meta = {
  pageGroup: 'activities',
  pageGroupKey: 'activities',
  pageOrder: 99,
  navHidden: true,          // nie w sidebarze
  requireAuth: true,
  requireFeatures: ['activities.manage'],
}
```

### 10.3 CrudForm fields

Statyczna lista — brak capabilities-driven logic (to jest standalone, bez kontekstu):

```typescript
const fields: CrudField[] = [
  { key: 'activityType', label: t('activities.form.type'), type: 'select',
    required: true, options: types.map(t => ({ value: t.id, label: t.label })) },
  { key: 'subject', label: t('activities.form.subject'), type: 'text', required: true },
  { key: 'notes', label: t('activities.form.notes'), type: 'textarea' },
  { key: 'dueAt', label: t('activities.form.dueAt'), type: 'datetime' },
  { key: 'occurredAt', label: t('activities.form.occurredAt'), type: 'datetime' },
  { key: 'ownerUserId', label: t('activities.form.owner'), type: 'text' },
  { key: 'visibility', label: t('activities.form.visibility'), type: 'select',
    options: VISIBILITY_OPTIONS.map(v => ({ value: v, label: t(`activities.visibility.${v}`) })) },
  { key: 'linkedEntityType', label: t('activities.form.linkedEntityType'), type: 'text' },
  { key: 'linkedEntityId', label: t('activities.form.linkedEntityId'), type: 'text' },
]
```

Server action: `createCrud('/api/activities', activityCreateSchema)`.
Po sukcesie: `redirect('/backend/activities')`.

### 10.4 Dostęp

Przycisk "Nowa aktywność" na stronie `/backend/activities` (`backend/page.tsx`):

```tsx
<Button asChild>
  <Link href="/backend/activities/new">{t('activities.list.action.create')}</Link>
</Button>
```

Klucz `activities.list.action.create` już istnieje w i18n (Sprint 1).

---

## 11. Pliki do stworzenia / zmodyfikowania

### Nowe pliki

```
src/modules/activities/
  backend/new/
    page.tsx
    page.meta.ts
  widgets/injection/timeline/
    ActivityTypePicker.tsx
    ActivityFormFields.tsx
    LogActivityDrawer.tsx
    QuickNoteDialog.tsx
    InlineActivityComposer.tsx
  __tests__/sprint3a.test.ts
```

### Modyfikowane pliki

```
src/modules/activities/
  activity-types.ts                 ← ADD defaultValues field + values for 5 types
  api/route.ts                      ← FIX POST handler returns links: []
  widgets/injection/timeline/
    widget.client.tsx               ← MOUNT InlineActivityComposer, LogActivityDrawer
  i18n/en.json                      ← ADD Sprint 3A keys
  backend/page.tsx                  ← ADD "Nowa aktywność" link button
```

### Kolejność implementacji

| Krok | Zadanie | Commit |
|---|---|---|
| 1 | `defaultValues` w `ActivityTypeDefinition` + 5 typów | step 1 |
| 2 | POST fix — pełny response DTO | step 2 |
| 3 | `ActivityTypePicker` | step 3 |
| 4 | `ActivityFormFields` | step 4 |
| 5 | `LogActivityDrawer` | step 5 |
| 6 | `QuickNoteDialog` | step 6 |
| 7 | `InlineActivityComposer` | step 7 |
| 8 | Optimistic update w `widget.client.tsx` | step 8 |
| 9 | `/backend/activities/new` + button na liście | step 9 |
| 10 | Testy + i18n | step 10 |

---

## 12. i18n — nowe klucze Sprint 3A

```json
{
  "activities.form.type": "Activity type",
  "activities.form.subject": "Subject",
  "activities.form.subject.placeholder": "What happened or what needs to be done?",
  "activities.form.notes": "Notes",
  "activities.form.notes.placeholder": "Additional details…",
  "activities.form.dueAt": "Due date",
  "activities.form.occurredAt": "When",
  "activities.form.owner": "Owner",
  "activities.form.visibility": "Visibility",
  "activities.form.location": "Location",
  "activities.form.participants": "Participants",
  "activities.form.participants.placeholder": "email@example.com, email2@example.com",
  "activities.form.recurrence": "Recurrence",
  "activities.form.recurrence.none": "Does not repeat",
  "activities.form.recurrence.daily": "Daily",
  "activities.form.recurrence.weekly": "Weekly",
  "activities.form.recurrence.biweekly": "Every two weeks",
  "activities.form.recurrence.monthly": "Monthly",
  "activities.form.duration": "Duration (minutes)",
  "activities.form.allDay": "All day",
  "activities.form.status": "Status",
  "activities.form.linkedTo": "Linked to",
  "activities.form.submit": "Log Activity",
  "activities.form.cancel": "Cancel",
  "activities.form.linkedEntityType": "Entity type",
  "activities.form.linkedEntityId": "Entity ID",

  "activities.drawer.title": "Log Activity",

  "activities.quicknote.title": "Quick Note",

  "activities.compose.placeholder": "Add a note…",
  "activities.compose.add": "Add",
  "activities.compose.noSubject": "Note content is required",

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

## 13. Acceptance Criteria

### 13.1 Quick-log (InlineActivityComposer)

- [ ] Widoczny nad listą aktywności we wszystkich 3 kontekstach (person, company, order)
- [ ] Klik "Notatka" otwiera textarea inline (nie Drawer)
- [ ] Enter lub [→] zapisuje notatkę z `linkedEntityType`/`linkedEntityId` z kontekstu
- [ ] Nowa notatka pojawia się natychmiast (optimistic, `opacity-60`)
- [ ] Błąd API: textarea nie jest czyszczona, flash error, placeholder znika
- [ ] Klik innego typu otwiera `LogActivityDrawer` z pre-wybranym typem

### 13.2 LogActivityDrawer

- [ ] Otwiera się z pre-wybranym primary link chip (read-only) gdy kontekst znany
- [ ] Type picker renderuje typy z rejestru (L1+L2 z Sprint 2)
- [ ] Zmiana typu: formularz zmienia pola, zachowuje `subject` i `ownerUserId`
- [ ] Fact mode: `occurredAt` default = teraz, `status` ukryty
- [ ] Task mode: `dueAt` widoczny, `status` widoczny
- [ ] `capabilities.hasBody`: textarea `notes` widoczna
- [ ] `capabilities.hasLocation`: pole `location` widoczne
- [ ] `capabilities.hasParticipants`: pole participants widoczne
- [ ] `capabilities.hasRecurrence`: dropdown recurrence widoczny
- [ ] `Cmd/Ctrl+Enter` submituje formularz
- [ ] `Escape` zamyka Drawer
- [ ] Błędy client-side: pod polami
- [ ] Błędy server-side `fieldErrors`: mapowane do pól przez `form.setError`
- [ ] Błąd ogólny: flash error + Drawer pozostaje otwarty z danymi

### 13.3 Optimistic updates

- [ ] Karta placeholder pojawia się natychmiast (`opacity-60`, `pointer-events-none`)
- [ ] Sukces: placeholder zastąpiony pełną kartą (animacja fade)
- [ ] Błąd: placeholder znika; dane przywrócone w Drawerze / textarea
- [ ] Deduplication: refresh listy nie duplikuje karty

### 13.4 Standalone creation

- [ ] `/backend/activities/new` dostępna i renderuje CrudForm
- [ ] Przycisk "Nowa aktywność" na liście linkuje do tej strony
- [ ] Po sukcesie: redirect do `/backend/activities` + flash

### 13.5 Quality gate

- [ ] TypeScript: 0 błędów
- [ ] Testy: wszystkie zielone (Sprint 1 + Sprint 2 + 3A)
- [ ] Brak hardkodowanych kolorów Tailwind (semantic tokens)
- [ ] Każdy icon-only button ma `aria-label`
- [ ] Dialog / Sheet: `Cmd/Ctrl+Enter` + `Escape`

---

## 14. Ryzyka

| ID | Ryzyko | Mitigation |
|---|---|---|
| R-1 | `react-hook-form` + Zod resolver nie zainstalowane w projekcie | Sprawdzić `package.json` przed krokiem 4 |
| R-2 | `Sheet` import path nieznany | Zweryfikować: `@open-mercato/ui/primitives/sheet` (potwierdzone w Sprint 3 review) |
| R-3 | Optimistic card flicker przy zastąpieniu | Cross-fade 150ms CSS transition |
| R-4 | `mapActivityToResponse` w dwóch plikach — ryzyko desync | Wyekstrahować do `api/shared.ts` w kroku 2 |
| R-5 | `lucide-react` dynamic icon import może nie działać z tree-shaking | Fallback `Activity` icon; sprawdzić bundle size |

---

## Changelog

| Data | Zmiana |
|------|--------|
| 2026-06-15 | Spec wydzielona ze Sprint 3 po Architecture Review — Sprint 3A (UX bez Layer 3) |
