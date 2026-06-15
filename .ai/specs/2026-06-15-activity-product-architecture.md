# Activity & Microsoft 365 — Dokument Produktowo-Architektoniczny

**Data**: 2026-06-15
**Status**: Propozycja do decyzji
**Horyzont**: 2–3 lata produktu
**Wzorzec UX**: Dynamics 365 Sales
**Pierwsza integracja zewnętrzna**: Microsoft 365 (Outlook + Calendar + Tasks)
**Przyszłe integracje**: Google Workspace (Gmail + Google Calendar), inne źródła aktywności

---

## 1. Wizja produktowa

Użytkownik OpenMercato, który ma połączone konto Microsoft 365, widzi w OM:

```
[Profil klienta ABC]

► ZAPLANOWANE AKTYWNOŚCI
  ┌─────────────────────────────────────────────────────┐
  │ 📅 Spotkanie onboarding   Jutro, 10:00     Jan K.  │
  │ ✅ Follow-up oferta        Piątek           Jan K.  │
  └─────────────────────────────────────────────────────┘

► HISTORIA AKTYWNOŚCI (jedna oś czasu)
  ─── Dziś ──────────────────────────────────────────────
  │ ✉️  Re: Propozycja cenowa   14:32   Jan K. → Klient  │
  │ 📞 Rozmowa telefoniczna    11:00   Piotr W.          │
  ─── Wczoraj ───────────────────────────────────────────
  │ 📅 Demo produktowe         16:00   Jan K. (O365)     │
  │ ✉️  Zapytanie ofertowe      09:15   Klient → Jan K.  │
  ─── 12 czerwca ────────────────────────────────────────
  │ 📝 Notatka: Klient prosi…  Piotr W.                  │
```

Dla użytkownika nie ma znaczenia, czy email przyszedł z Outlooka, Gmail,
czy spotkanie zostało zalogowane ręcznie — widzi jedną, spójną historię kontaktu.

---

## 2. Architektura modułu konfiguracji integracji

### 2.1 Dwie warstwy konfiguracji

```
┌─────────────────────────────────────────────────────┐
│              WARSTWA TENANTU (admin)                 │
│                                                     │
│  Azure App Registration                             │
│  (clientId, clientSecret, tenantId)                 │
│  ↓                                                  │
│  Polityka synchronizacji                            │
│  (co wolno synchronizować w tej organizacji)        │
│  ↓                                                  │
│  Monitoring błędów i statusów wszystkich userów     │
└──────────────────┬──────────────────────────────────┘
                   │ admin konfiguruje raz
                   ▼
┌─────────────────────────────────────────────────────┐
│              WARSTWA UŻYTKOWNIKA                    │
│                                                     │
│  Konto O365 (OAuth2 per user)                       │
│  ↓                                                  │
│  Preferencje synchronizacji                         │
│  (co synchronizować, kierunek, wybór kalendarzy)    │
│  ↓                                                  │
│  Status połączenia + historia błędów                │
└─────────────────────────────────────────────────────┘
```

### 2.2 Zależność warstw

```
Admin NIE MUSI konfigurować tenantu, żeby user mógł połączyć konto.

Wariant A (prostszy onboarding):
  User podaje własne clientId + clientSecret przy połączeniu konta.
  → Każdy user ma własną rejestrację Azure.
  → Lepsze dla małych firm, gorsze dla enterprise.

Wariant B (centralna rejestracja — rekomendowany):
  Admin konfiguruje jedną rejestrację Azure dla całej organizacji.
  → Każdy user autoryzuje się przez OAuth przy użyciu tej rejestracji.
  → Lepsze zarządzanie, lepsze audytowanie, standard enterprise.
  → Fallback: jeśli admin nie skonfigurował tenantu, user NIE MOŻE połączyć konta.
    (Błąd: "Skontaktuj się z administratorem w celu skonfigurowania integracji O365")
```

**Rekomendacja: Wariant B** — zgodny ze standardem enterprise i wzorcem HubSpot/Salesforce.

### 2.3 Uprawnienia administratora

| Akcja | Feature ID |
|---|---|
| Skonfiguruj Azure App Registration | `office365.configure_tenant` |
| Przeglądaj połączone konta wszystkich userów | `office365.view_all_connections` |
| Wymuś rozłączenie konta użytkownika | `office365.manage_user_connections` |
| Ustaw polityki synchronizacji | `office365.manage_policies` |
| Przeglądaj logi błędów synchronizacji | `office365.view_sync_logs` |

### 2.4 Uprawnienia użytkownika

| Akcja | Feature ID |
|---|---|
| Połącz własne konto O365 | `office365.connect_own_account` |
| Przeglądaj swoje aktywności z O365 | `office365.view_own_activities` |
| Konfiguruj własne preferencje sync | `office365.configure_own_sync` |

---

## 3. Encje konfiguracyjne

### 3.1 `Office365TenantConfig` — konfiguracja poziomu tenantu

Przechowuje rejestrację Azure (jedna per tenant). Zarządzana przez admina.

```
Office365TenantConfig
├── id: UUID
├── organization_id: UUID FK
├── tenant_id: UUID FK
│
├── azure_tenant_id: string         -- Azure AD tenant ID lub 'common'
├── client_id: string               -- Azure App Registration Client ID
├── client_secret: string           -- ENCRYPTED
│
├── allowed_scopes: string[]        -- scopes dopuszczone przez admina
│     default: ['Mail.ReadWrite', 'Calendars.ReadWrite', 'Tasks.ReadWrite',
│               'User.Read', 'offline_access']
│
├── sync_policy: JSONB {            -- polityka na poziomie organizacji
│     allowEmailSync: boolean       -- admin może wyłączyć dla całej org
│     allowCalendarSync: boolean
│     allowTasksSync: boolean
│     defaultEmailDirection: 'inbound'|'bidirectional'
│     requirePrivateEventFilter: boolean  -- wymusz filtr prywatnych wydarzeń
│     maxHistoryDays: number        -- ile dni wstecz synchronizować przy connect
│   }
│
├── configured_by_user_id: UUID     -- kto skonfigurował
├── status: 'active' | 'invalid_credentials' | 'not_configured'
├── last_verified_at: Date          -- kiedy ostatnio sprawdzono poprawność credentiali
│
├── created_at: Date
└── updated_at: Date

UNIQUE: (organization_id, tenant_id)  -- jeden config per tenant
```

### 3.2 `Office365UserConnection` — połączenie konta użytkownika

Per-user OAuth token. Jeden per użytkownik per tenant.

```
Office365UserConnection
├── id: UUID
├── organization_id: UUID FK
├── tenant_id: UUID FK
├── staff_user_id: UUID FK         -- który pracownik
│
├── o365_user_id: string           -- Graph object ID (stabilny, nie zmienia się)
├── email: string                  -- UPN / primary mail z Graph /me
├── display_name: string
│
├── access_token: string           -- ENCRYPTED
├── refresh_token: string          -- ENCRYPTED
├── token_expires_at: Date
├── granted_scopes: string[]       -- które scopes faktycznie przyznał user
│
├── status: 'connected'
│        | 'requires_reauth'       -- token wygasł, nie można odświeżyć
│        | 'insufficient_scopes'   -- user nie przyznał wymaganych scopes
│        | 'disconnected'
│
├── connected_at: Date
├── last_sync_at: Date
├── last_health_check_at: Date
│
├── created_at: Date
└── updated_at: Date

UNIQUE: (organization_id, tenant_id, staff_user_id)
UNIQUE: (organization_id, tenant_id, o365_user_id)  -- jeden user O365 per org
```

### 3.3 `Office365SyncProfile` — preferencje synchronizacji użytkownika

Co i w jakim kierunku synchronizować. Jeden per połączenie.

```
Office365SyncProfile
├── id: UUID
├── organization_id: UUID FK
├── tenant_id: UUID FK
├── connection_id: UUID FK → Office365UserConnection
│
├── email_sync: boolean (default: true)
├── email_direction: 'inbound' | 'outbound' | 'bidirectional' (default: 'bidirectional')
├── email_folder_ids: string[]     -- które foldery (default: ['Inbox', 'SentItems'])
│
├── calendar_sync: boolean (default: true)
├── calendar_direction: 'inbound' | 'outbound' | 'bidirectional' (default: 'bidirectional')
├── selected_calendar_ids: string[]  -- które kalendarze (null = główny)
├── sync_private_events: boolean (default: false)
│
├── tasks_sync: boolean (default: false)  -- domyślnie wyłączone (beta)
├── tasks_direction: 'inbound' | 'outbound' | 'bidirectional'
│
├── max_history_days: number (default: 30)  -- ile dni wstecz przy pierwszym connect
│   max: ograniczony przez Office365TenantConfig.sync_policy.maxHistoryDays
│
├── auto_link_to_customer: boolean (default: true)
│   -- automatycznie powiąż email/meeting z klientem na podstawie adresu email
│
├── created_at: Date
└── updated_at: Date

UNIQUE: (organization_id, tenant_id, connection_id)
```

### 3.4 `Office365SyncCursor` — stan synchronizacji (cursor/delta token)

Wewnętrzna encja — nie widoczna dla użytkownika. Jeden cursor per resource per user.

```
Office365SyncCursor
├── id: UUID
├── organization_id: UUID FK
├── tenant_id: UUID FK
├── connection_id: UUID FK → Office365UserConnection
│
├── resource_type: 'mail' | 'calendar' | 'tasks'
├── delta_token: string           -- Graph Delta API $deltaToken
├── last_synced_at: Date
├── next_sync_at: Date            -- kiedy następne zaplanowane pobranie
├── consecutive_errors: int (default: 0)
│   -- po 5 kolejnych błędach → status = 'paused', alert dla admina
│
├── created_at: Date
└── updated_at: Date

UNIQUE: (organization_id, tenant_id, connection_id, resource_type)
```

### 3.5 `Office365SyncLog` — log błędów synchronizacji

Tylko błędy (sukces nie jest logowany — zbyt duży wolumen).

```
Office365SyncLog
├── id: UUID
├── organization_id: UUID FK
├── tenant_id: UUID FK
├── connection_id: UUID FK → Office365UserConnection
│
├── resource_type: 'mail' | 'calendar' | 'tasks'
├── error_code: string            -- 'token_expired' | 'graph_429' | 'graph_500' | ...
├── error_message: string         -- szczegóły błędu
├── is_transient: boolean         -- czy błąd przejściowy (automatycznie ponowiony)
├── resolved_at: Date | NULL      -- kiedy błąd ustąpił
│
├── occurred_at: Date
└── created_at: Date
```

### 3.6 Relacje między encjami

```
Office365TenantConfig (1)
  └── Office365UserConnection (N — jeden per user)
        ├── Office365SyncProfile (1 — preferencje usera)
        ├── Office365SyncCursor  (N — jeden per typ zasobu: mail, calendar, tasks)
        └── Office365SyncLog     (N — błędy)
```

---

## 4. Ustawienia użytkownika

Dostępne na stronie: `/backend/profile/integrations/office365`
(strona settings, `pageContext: 'settings'`, `navHidden: true`)

### 4.1 Sekcja: Połączenie konta

```
╔══════════════════════════════════════════════════════════╗
║  Microsoft 365                             [Połączone ✓] ║
╠══════════════════════════════════════════════════════════╣
║  Konto:  jan.kowalski@firma.onmicrosoft.com              ║
║  Połączono: 10 czerwca 2026                              ║
║  Ostatnia synchronizacja: 2 minuty temu                  ║
║                                    [Rozłącz] [Odśwież]   ║
╚══════════════════════════════════════════════════════════╝
```

Stany połączenia:
- `connected` — zielony badge, czas ostatniej synchronizacji
- `requires_reauth` — pomarańczowy banner "Zaloguj się ponownie, aby wznowić synchronizację" + przycisk
- `insufficient_scopes` — czerwony banner z listą brakujących uprawnień + przycisk ponownego łączenia
- `disconnected` — przycisk "Połącz konto Microsoft 365"

### 4.2 Sekcja: Poczta e-mail

```
[ ✓ ] Synchronizuj pocztę e-mail

    Kierunek synchronizacji:
    ( ) Tylko przychodzące
    (•) Dwukierunkowy (przychodzące + wychodzące)
    ( ) Tylko wychodzące

    Synchronizowane foldery:
    [ ✓ ] Skrzynka odbiorcza (Inbox)
    [ ✓ ] Elementy wysłane (Sent Items)
    [   ] Wersje robocze (Drafts)
```

### 4.3 Sekcja: Kalendarz

```
[ ✓ ] Synchronizuj kalendarz

    Kierunek synchronizacji:
    ( ) Tylko import (O365 → OM)
    (•) Dwukierunkowy
    ( ) Tylko eksport (OM → O365)

    Synchronizowane kalendarze:                [Wczytaj z O365]
    [ ✓ ] Kalendarz — jan.kowalski@firma.com (główny)
    [   ] Zespół Sprzedaży
    [   ] Urlopy

    Prywatność wydarzeń:
    [   ] Synchronizuj prywatne wydarzenia kalendarza
          (domyślnie wyłączone — prywatne wydarzenia są widoczne
           tylko dla właściciela w Outlooku)
```

### 4.4 Sekcja: Zadania (beta)

```
[   ] Synchronizuj zadania (Microsoft To-Do)   [BETA]

    Kierunek synchronizacji:
    (•) Tylko import (O365 → OM)
    ( ) Dwukierunkowy

    Lista zadań:
    [   ] Moje zadania (domyślna)
```

### 4.5 Sekcja: Historia synchronizacji

```
Ostatnia synchronizacja: 15 czerwca 2026, 14:32
Status: ✓ Bez błędów

Zsynchronizowane w ciągu ostatnich 30 dni:
  ✉️  127 e-maili
  📅  34 zdarzenia kalendarza
  ✅  0 zadań

[Wymuś synchronizację]   [Zresetuj historię synchronizacji]
```

---

## 5. Ustawienia administratora

Dostępne na stronie integracji: `/backend/integrations/office365`
(zakładka "Konfiguracja" i zakładka "Użytkownicy")

### 5.1 Zakładka: Azure App Registration

```
╔══════════════════════════════════════════════════════════╗
║  Konfiguracja Azure                                      ║
╠══════════════════════════════════════════════════════════╣
║  Azure Tenant ID     [ common                       ]    ║
║                        (lub konkretny tenant dla AAD)    ║
║                                                          ║
║  Client ID           [ 12345678-abcd-...            ]    ║
║                                                          ║
║  Client Secret       [ ••••••••••••••••••           ]    ║
║                        [Ukryj]     [Edytuj]              ║
║                                                          ║
║  Redirect URI (skopiuj do Azure):                        ║
║  https://app.openmercato.com/api/office365/oauth/callback║
║                                                          ║
║  Wymagane uprawnienia Microsoft Graph:                   ║
║  ✓ Mail.ReadWrite (delegated)                            ║
║  ✓ Calendars.ReadWrite (delegated)                       ║
║  ✓ Tasks.ReadWrite (delegated)                           ║
║  ✓ User.Read (delegated)                                 ║
║  ✓ offline_access (delegated)                            ║
║                                                          ║
║  [Testuj połączenie]          Status: ✓ Skonfigurowane   ║
╚══════════════════════════════════════════════════════════╝
```

### 5.2 Zakładka: Polityki synchronizacji

```
Dostępne funkcje synchronizacji dla tej organizacji:

[ ✓ ] Poczta e-mail
        Domyślny kierunek: [ Dwukierunkowy ▼ ]

[ ✓ ] Kalendarz
        Domyślny kierunek: [ Dwukierunkowy ▼ ]
        [ ] Wymagaj filtrowania prywatnych wydarzeń
            (użytkownicy nie mogą synchronizować prywatnych wydarzeń)

[   ] Zadania (Microsoft To-Do)
        ⚠️ Funkcja w fazie beta

Limit historii przy pierwszym połączeniu:
  [ 30 dni ▼ ]  (maksymalnie 365 dni)

Automatyczne łączenie z klientami:
[ ✓ ] Automatycznie powiązuj aktywności z klientami na podstawie adresu e-mail
```

### 5.3 Zakładka: Użytkownicy

```
Połączone konta Microsoft 365

Szukaj...            [Eksportuj CSV]

┌──────────────────┬────────────────────────────┬──────────────┬──────────────┬───────┐
│ Pracownik        │ Konto O365                 │ Status       │ Ostatnia sync│       │
├──────────────────┼────────────────────────────┼──────────────┼──────────────┼───────┤
│ Jan Kowalski     │ jan.k@firma.com            │ ✓ Połączono  │ 2 min temu   │ [···] │
│ Anna Nowak       │ anna.n@firma.com           │ ⚠ Odśwież   │ 3 dni temu   │ [···] │
│ Piotr Wiśniewski │ —                          │ Niepołączone │ —            │       │
└──────────────────┴────────────────────────────┴──────────────┴──────────────┴───────┘

[···] menu: Wymuś synchronizację | Rozłącz konto | Podgląd logów błędów
```

### 5.4 Zakładka: Logi błędów

```
Błędy synchronizacji (ostatnie 30 dni)

Filtry: [Wszyscy użytkownicy ▼]  [Wszystkie typy ▼]  [Wszystkie błędy ▼]

┌──────────────────┬─────────┬─────────────────────────────┬──────────┬──────────┐
│ Użytkownik       │ Zasób   │ Błąd                        │ Czas     │ Status   │
├──────────────────┼─────────┼─────────────────────────────┼──────────┼──────────┤
│ Anna Nowak       │ Mail    │ token_expired               │ 12 cze   │ ✗ Otwarty│
│ Jan Kowalski     │ Calendar│ graph_429 (rate limit)      │ 10 cze   │ ✓ Resolv.│
└──────────────────┴─────────┴─────────────────────────────┴──────────┴──────────┘
```

---

## 6. Onboarding integracji — przepływ UX

### 6.1 Perspektywa administratora (jednorazowe)

```
Krok 1: Admin otwiera /backend/integrations → Office 365
Krok 2: "Konfiguracja Azure" — przewodnik krok po kroku
  ├── Link do Azure Portal z instrukcją tworzenia App Registration
  ├── Lista wymaganych uprawnień do skopiowania
  ├── Redirect URI do skopiowania do Azure
  └── Formularz: Tenant ID, Client ID, Client Secret
Krok 3: Kliknięcie "Testuj połączenie"
  ├── Sukces → zielony status, integracja aktywna
  └── Błąd → konkretny komunikat (invalid_client, tenant_not_found, etc.)
Krok 4: Konfiguracja polityk synchronizacji (opcjonalne, domyślne ustawienia są OK)
Krok 5: Powiadomienie do pracowników "Integracja O365 gotowa — połącz swoje konto"
```

### 6.2 Perspektywa użytkownika

```
Krok 1: User otwiera /backend/profile/integrations/office365
  lub widzi banner "Połącz konto Microsoft 365" na stronie głównej
Krok 2: Kliknięcie "Połącz konto Microsoft 365"
  → Redirect do Microsoft Identity (login.microsoftonline.com)
Krok 3: Logowanie do konta O365 + zgoda na uprawnienia
  → Ekran zgody Microsoft: "Aplikacja prosi o dostęp do..."
Krok 4: Redirect powrotny do OM → flash "Konto połączone pomyślnie"
Krok 5: Strona preferencji synchronizacji
  → "Jakie dane chcesz synchronizować?"
  → Domyślnie: Email ✓, Kalendarz ✓, Zadania ✗
Krok 6: Pierwsza synchronizacja (w tle)
  → Banner: "Synchronizuję dane za ostatnie 30 dni..."
  → Po zakończeniu: flash "Zsynchronizowano 127 e-maili i 34 zdarzenia"
```

---

## 7. Docelowy UX — prezentacja Activity

### 7.1 Oś czasu aktywności (wzorzec D365)

Każda strona detalu encji (klient, firma, zamówienie, deal) pokazuje jedną oś czasu.

**Architektura komponentu:**

```
<ActivityTimeline entityType="customers:person" entityId={customerId}>
  ├── <PlannedSection>         -- nadchodzące, posortowane rosnąco
  │     ├── ActivityCard type=meeting (jutro, 10:00)
  │     └── ActivityCard type=task   (piątek, deadline)
  │
  └── <HistorySection>         -- historia, posortowana malejąco
        ├── DayGroup "Dziś"
        │     ├── ActivityCard type=email  (14:32, O365)
        │     └── ActivityCard type=call   (11:00, ręczne)
        ├── DayGroup "Wczoraj"
        │     └── ActivityCard type=meeting (16:00, O365 Calendar)
        └── DayGroup "12 czerwca"
              └── ActivityCard type=note   (Piotr W.)
</ActivityTimeline>
```

### 7.2 ActivityCard — anatomia karty

```
┌─────────────────────────────────────────────────────────┐
│  [📅] Spotkanie onboarding                 Jan K.   ⋮   │
│       Klient ABC · Jutro 10:00–11:30 · MS Teams         │
│       "Omówimy wdrożenie modułu sprzedaży..."           │
│                                           [Edytuj] [✓]  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  [✉️] Re: Propozycja cenowa               Jan K.   ⋮    │
│       Do: anna@klientabc.pl · Dziś 14:32 · Outlook      │
│       "Dziękuję za przesłaną ofertę. Mam kilka pytań…"  │
│                                [Odpowiedz] [Przekaż]    │
└─────────────────────────────────────────────────────────┘
```

Elementy każdej karty:
- **Ikona typu** (lucide-react: Mail, CalendarDays, Phone, StickyNote, ListChecks)
- **Tytuł / temat**
- **Metadane** (właściciel, data, czas, źródło: "Outlook", "Google", ręczne)
- **Snippet treści** (pierwsze 120 znaków, rozwijany)
- **Badge statusu** (Zaplanowane / Wykonane / Anulowane)
- **Badge źródła** (mały "MS 365" lub "Gmail" jeśli pochodzi z zewnętrznej integracji)
- **Akcje kontekstowe** (zależne od typu):
  - Email: Odpowiedz, Przekaż, Oznacz jako ważne
  - Meeting: Edytuj, Anuluj, Dołącz (link Teams)
  - Task: Oznacz jako wykonane, Przełóż, Edytuj
  - Note: Edytuj, Usuń

### 7.3 Filtry i grupowanie

```
[Wszystkie ▼]  [📅 Spotkania]  [✉️ E-maile]  [✅ Zadania]  [📞 Rozmowy]  [📝 Notatki]

[Od: —————]  [Do: —————]  [Właściciel: Wszyscy ▼]  [Źródło: Wszystkie ▼]
```

Filtry:
- Typ aktywności (checkboxy, multi-select)
- Zakres dat
- Właściciel / osoba przypisana
- Źródło (ręczne, Microsoft 365, Gmail, Google Calendar)
- Status (Zaplanowane, Wykonane, Anulowane)

Grupowanie (domyślnie: wg dnia):
- Po dniu (domyślne)
- Po tygodniu (dla widoku zagregowanego)
- Po typie (wszystkie e-maile razem, potem spotkania, itd.)

### 7.4 Quick-add (InlineActivityComposer)

Nad historią: pasek szybkiego dodawania aktywności.

```
[📝 Notatka] [📞 Rozmowa] [✅ Zadanie] [📅 Spotkanie] [✉️ E-mail]
╔════════════════════════════════════════════════════╗
║ Dodaj notatkę...                              [→]  ║
╚════════════════════════════════════════════════════╝
```

Wybranie typu otwiera odpowiedni formularz inline lub dialog.

### 7.5 Timeline na stronie zamówienia

Na stronie detalu zamówienia (`/backend/sales/orders/[id]`) oś czasu działa identycznie,
ale query filtruje po `linked_entity_type='sales:order'`.

W jednym widoku użytkownik widzi:
- E-maile wymienione z klientem w kontekście tego zamówienia
- Spotkania powiązane z tym zamówieniem
- Zadania do wykonania przy tym zamówieniu
- Notatki pracowników

---

## 8. Activity: moduł infrastrukturalny czy biznesowy?

### 8.1 Taksonomia modułów w OM

```
POZIOM 1 — Czysta infrastruktura (żadnego UI dla użytkownika, brak CRUD)
  → cache, queue, search, events, storage
  → Inne moduły używają ich jako serwisów

POZIOM 2 — Infrastruktura z UI (platforma, nie domena)
  → notifications (dostarczanie powiadomień)
  → audit_logs (logi systemowe)
  → integrations hub (marketplace integracji)
  → communication_channels hub (routing wiadomości)
  Cecha: dostępne globalnie, używane przez inne moduły poprzez eventy/serwisy

POZIOM 3 — Moduły domenowe (pełne CRUD, biznesowe reguły, własny UI)
  → customers, sales, catalog
  Cecha: zamknięta domena, inne moduły linkują przez FK IDs

POZIOM 4 — Moduły aplikacji (customizacje, integracje zewnętrzne)
  → channel-office365, channel-gmail, src/modules/example
```

### 8.2 Gdzie pasuje Activity?

Activity NIE jest czysto infrastrukturalne (ma biznesowe reguły: assign, complete, remind).
Activity NIE jest zamkniętą domeną (musi być widoczne w każdym module).
Activity jest **cross-cutting platform capability** — poziom 2+ lub "poziom 2.5".

Analogia: w Dynamics 365, Activities to część Platform layer (nie CRM layer).
Każda aplikacja D365 może tworzyć i wyświetlać aktywności. To jest feature platformy.

### 8.3 Konsekwencje dla architektury OM

**Rekomendacja: Activities = moduł platformy, docelowo w @open-mercato/core**

```
Dziś (projekt standalone):
  src/modules/activities/       ← implementacja w projekcie
  Zasady: stabilne API, zdarzenia, brak ejektu

Za 12 miesięcy:
  Wydzielenie do packages/activities/  (workspace package)

Za 24 miesiące:
  Przeniesienie do @open-mercato/activities  (official package)
  → aktivności stają się częścią frameworka, nie projektu
```

**Czym Activity RÓŻNI SIĘ od modułu biznesowego:**

| Kryterium | Moduł biznesowy (np. customers) | Activity (platforma) |
|---|---|---|
| Kto tworzy rekordy | Użytkownicy przez UI | Użytkownicy + inne moduły + integracje zewnętrzne |
| FK dependencies | Może mieć FK do Activity | NIE ma FK do żadnego business module |
| Events | Emituje zdarzenia → Activity subscribes | Emituje zdarzenia → business modules subscribe |
| Widget injection | Może injektować do Activity timeline | Injectuje własny timeline do cudzych stron |
| Stability contract | Może się zmieniać | Stabilne API (jak REST contract) — breaking changes niedopuszczalne |
| Kto może go używać | Jego własne komponenty | Każdy moduł w systemie |

### 8.4 Praktyczne implikacje "moduł platformy"

1. **API Activity musi być stable** — inne moduły tworzą Activity przez `POST /api/activities`.
   Breaking change w schemacie = regresja we wszystkich integratorach.

2. **Activity nie importuje innych modułów** — zależność jest zawsze odwrócona:
   `sales` → uses Activity API,  NIE: Activity → imports sales.
   Cross-module link wyłącznie przez FK ID (`linked_entity_type: 'sales:order'`).

3. **Timeline widget jako shared component** — `<ActivityTimeline>` musi być dostępny
   jako komponent do importu przez dowolny moduł, bez kopiowania kodu.

4. **Versioning** — gdy Activity schema się zmienia, bump wersji API;
   stara wersja deprecated przez 6 miesięcy (jak external API contract).

5. **Testowanie** — Activity musi mieć komplet testów integracyjnych
   (nie tylko unit tests), bo jest zależnością krytyczną całego systemu.

---

## 9. Architektura dla przyszłych integracji (Google Workspace, inne)

Kluczowe: activity module NIE WIE nic o O365 ani Gmail.
Integracje są zewnętrznymi konsumentami, nie częścią Activity.

```
activities module
  (stabilne API, nie importuje żadnej integracji)
       ▲
       │ POST /api/activities (tworzy Activity)
       │ subscribes to activities.* events
       │
  ─────┼───────────────────────────────────────────────
       │
  ┌────┴─────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │ channel-office365│  │ channel-gmail    │  │ future: Salesforce│
  │                  │  │                  │  │         HubSpot   │
  │ O365 email →     │  │ Gmail email →    │  │ contact sync →   │
  │   Activity:email │  │   Activity:email │  │   Activity:call   │
  │ O365 calendar →  │  │ G Calendar →     │  │ Salesforce task→ │
  │   Activity:meet. │  │   Activity:meet. │  │   Activity:task   │
  │ O365 tasks →     │  │                  │  │                   │
  │   Activity:task  │  │                  │  │                   │
  └──────────────────┘  └──────────────────┘  └──────────────────┘

ZASADA: Każda integracja zewnętrzna tworzy Activity przez publiczne API.
        Activity module nie wie nic o tym skąd przyszło.
        Jedyne co Activity "widzi" to: external_id + external_provider.
```

**Deduplication jest odpowiedzialnością Activity module:**
```
UNIQUE INDEX: (external_id, external_provider, organization_id)
```
Dowolna integracja może spokojnie "upsertować" Activity — duplikaty są niemożliwe.

---

## 10. Mapa drogowa 2–3 lata

```
KWARTAŁ 1 (Q3 2026) — Fundament
  Sprint 1-2: Moduł activities — encja, API, eventy, RBAC, timeline widget
  Sprint 3:   ActivityTimeline wstrzyknięty w customer page + sales order page
  Sprint 4:   channel-office365 — OAuth2 tenant + per-user flow

KWARTAŁ 2 (Q3-Q4 2026) — O365 integracja
  Sprint 5:   O365 email sync (ChannelAdapter — jak Gmail)
  Sprint 6:   O365 calendar sync (CalendarSyncWorker)
  Sprint 7:   Admin panel (Office365TenantConfig, user management, logs)
  Sprint 8:   CustomerInteraction → API interceptor → Activity bridge

KWARTAŁ 3 (Q1 2027) — Dojrzałość
  Sprint 9:   O365 Tasks sync (beta)
  Sprint 10:  Data migration (CustomerInteraction → Activity)
  Sprint 11:  Pakiet activities wydzielony do workspace package
  Sprint 12:  Dashboard widget "Moje aktywności na dziś"

KWARTAŁ 4 (Q2 2027) — Kolejna integracja
  Sprint 13:  channel-google (Gmail + Google Calendar — reuse activities module)
  Sprint 14:  Zaawansowane filtry + wyszukiwanie pełnotekstowe aktywności
  Sprint 15:  AI-suggested activities (kolejne follow-upy, propozycje spotkań)

ROK 3 (2028) — Platforma
  - @open-mercato/activities jako oficjalny package
  - Marketplace integracji: dowolna integracja może tworzyć Activity
  - Activity jako podstawa modułu raportowania aktywności CRM
  - Webhooks na zdarzeniach aktywności (→ zewnętrzne systemy)
```

---

## 11. Odpowiedzi na pytania z zadania

**Czy Activity to moduł infrastrukturalny czy biznesowy?**
→ **"Moduł platformy" — trzecia kategoria.** Ma pełne CRUD + UI (jak biznesowy),
  ale jest cross-cutting dependency dla całego systemu (jak infrastruktura).
  Docelowo: oficjalny pakiet `@open-mercato/activities` w core frameworku.

**Jak Activity powinno być prezentowane w UI?**
→ **Jedna pionowa oś czasu** (jak D365), podzielona na "Zaplanowane" (góra)
  i "Historia" (dół). Filtry po typie, dacie, właścicielu i źródle.
  Widget injectowany przez widget injection do dowolnej strony encji.

**Encje konfiguracyjne O365:**
→ `Office365TenantConfig` (admin) + `Office365UserConnection` (per-user OAuth)
  + `Office365SyncProfile` (preferencje) + `Office365SyncCursor` (delta tokens)
  + `Office365SyncLog` (błędy). Wszystko w pakiecie `channel-office365`.

**Jedna oś czasu dla wszystkich źródeł:**
→ Tak — Activity module jest jedynym źródłem prawdy.
  Email z Outlooka, spotkanie z Google Calendar, ręcznie dodana notatka —
  wszystko trafia do tabeli `activities` z odpowiednim `external_provider`.
  UI nie rozróżnia źródła (tylko badge informacyjny na karcie).

---

## Changelog

| Data | Zmiana |
|------|--------|
| 2026-06-15 | Dokument stworzony — pełna analiza produktowo-architektoniczna |
