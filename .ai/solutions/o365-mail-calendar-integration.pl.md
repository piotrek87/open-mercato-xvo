# Integracja Microsoft 365 (poczta + kalendarz + załączniki)

> Polska wersja [o365-mail-calendar-integration.md](o365-mail-calendar-integration.md). W razie rozbieżności wersja angielska jest kanoniczna.

Gałąź (przenośny bundle): `integration/o365` · Moduły: `channel_office365`, `mail_attachments`
(+ zmiany analityki w module `activities`).

---

## 1. Opis biznesowy (dla użytkowników końcowych)

Podłącz skrzynkę i kalendarz Microsoft 365 (Outlook/Exchange) do Open Mercato, żeby komunikacja z
klientami i spotkania żyły obok rekordów CRM — bez kopiuj-wklej, bez przełączania kart.

**Co dostajesz:**

- **Podłączenie Microsoft 365** w *Ustawienia → Integracje → Microsoft 365* (jednorazowe logowanie OAuth).
  Skrzynki per użytkownik; połączenie może należeć do jednej organizacji i tam się synchronizować.
- **Synchronizacja e-maili** — poczta przychodząca i wysłana jest pobierana i pokazywana na zakładce
  **„E-maile"** kontaktu jako wątki konwersacji oraz logowana do **Aktywności**. Odpowiedzi przychodzące
  pojawiają się automatycznie.
- **Synchronizacja kalendarza** — wydarzenia z kalendarza Microsoft 365 trafiają do Aktywności;
  spotkania zaplanowane z rekordu synchronizują się z powrotem do Outlooka.
- **Tworzenie i odpowiadanie z załącznikami** — z zakładki **„E-maile"** kontaktu napiszesz nowy mail
  lub odpowiesz bezpośrednio w Open Mercato. Załączysz pliki z dysku **i/lub** „Załącz z OM" (istniejące
  załączniki mailowe kontaktu oraz pliki z zakładki Pliki). Wysłana poczta wychodzi przez Twoją realną
  skrzynkę i jest ponownie synchronizowana do CRM.
- **Zakładka „Załączniki e-mail"** — każdy załącznik z zsynchronizowanej poczty kontaktu w jednym
  miejscu, z pobieraniem i akcją usuwania (usuwa kopię w CRM; sam mail zachowuje plik).
- **Statystyki aktywności** (*Aktywności → Statystyki aktywności*) — kokpit „Moje/Zespół": suma
  aktywności, realizacja zadań, zadania po terminie, pokrycie dealami, trend tygodniowy, ranking
  zespołu oraz „deale wymagające uwagi" (otwarte deale bez kontaktu od 14+ dni lub nigdy). Każda metryka
  ma inline tooltip z wyjaśnieniem. Przydatne i dla handlowca (widok osobisty), i dla zarządu (widok
  zespołowy).

**Prywatność:** dane wrażliwe (dane kontaktowe, tytuły deali itd.) są szyfrowane at rest przez
mechanizm tenant-encryption frameworka. Deduplikacja załączników unika dwukrotnego zapisu tego samego
wysłanego pliku.

---

## 2. Architektura (jeden akapit)

Podejście app-only — **zero zmian w rdzeniu frameworka**; referencje wędrują do naszego adaptera Graph
przez swobodne pole `channelMetadata`. `mail_attachments` to moduł niezależny od dostawcy (upload +
resolver zamieniający trwałe referencje załączników na bajty); `channel_office365` to adapter Microsoft
365 (transport Graph, route compose, sync, widgety UI). Zakładka e-maili + dialog compose są
wstrzykiwane przez sloty injection na karcie osoby w `customers` (wbudowana zakładka e-maili jest ukryta,
nasza ją zastępuje), bo rdzeniowy dialog compose nie obsługuje załączników i nie udostępnia uchwytu do
nadpisania.

**Zależy od tych (wbudowanych) modułów:** `customers`, `communication_channels`, `activities`,
`attachments`, `directory`, `auth`. Strona statystyk w `activities` czyta `customer_deals` (odszyfrowane).

---

## 3. Przenoszenie na inne środowisko

### 3.1 Pliki / moduły do skopiowania
- `src/modules/channel_office365/**`
- `src/modules/mail_attachments/**`
- Zmiany analityki aktywności w `src/modules/activities/` (API statystyk + strona + i18n), jeśli chcesz
  mieć tam też kokpit.
- Zarejestruj w `src/modules.ts` (kolejność: `mail_attachments` przed `activities`):
  ```ts
  { id: 'mail_attachments', from: '@app' },
  { id: 'activities', from: '@app' },
  { id: 'channel_office365', from: '@app' },
  ```
- Po skopiowaniu uruchom `yarn generate`.

### 3.2 Rejestracja aplikacji w Azure (wymagana — raz na tenant Azure)
Zarejestruj aplikację w Azure AD (Entra) z:
- **Redirect URI** (Web): `https://<twoja-domena>/api/communication_channels/oauth/office365/callback`
- **Uprawnienia API** (delegated): `Calendars.ReadWrite`, `Mail.ReadWrite`, `User.Read`, `offline_access`
- **Client secret** (zanotuj datę wygaśnięcia — po wygaśnięciu kanały przechodzą w stan „wymaga
  ponownej autoryzacji").

### 3.3 Konfiguracja w aplikacji (NIE zmienne środowiskowe)
**Client ID** i **Client Secret** Microsoft 365 konfiguruje się w UI aplikacji:
*Ustawienia → Integracje → Microsoft 365*. Są przechowywane per-tenant (zaszyfrowane), nie w env.
Każdy użytkownik końcowy następnie podłącza własną skrzynkę przez OAuth z tego samego ekranu.

### 3.4 Zmienne środowiskowe
| Zmienna | Cel | Domyślnie | Wymagana |
|---|---|---|---|
| `TENANT_DATA_ENCRYPTION_FALLBACK_KEY` (lub skonfigurowany Vault/KMS) | Klucz szyfrowania danych tenanta. Dane kontaktowe, tytuły deali, metadane załączników są szyfrowane at rest; **bez tego samego klucza zaszyfrowanych danych nie da się odczytać po przeniesieniu**. | wyprowadzony (ostrzeżenie w dev) | **Tak (prod)** |
| `MAIL_ATTACHMENTS_MAX_FILES` | Maks. liczba załączników na jeden wychodzący mail. | `10` | Nie |
| `MAIL_ATTACHMENTS_MAX_FILE_MB` | Maks. rozmiar pojedynczego załącznika (MB). | `25` | Nie |
| `MAIL_ATTACHMENTS_MAX_TOTAL_MB` | Maks. łączny rozmiar załączników na mail (MB). | `25` | Nie |
| `DATABASE_URL` | Połączenie Postgres (poziom frameworka). | — | Tak |
| `OM_DEV_AUTO_MIGRATE` | Dev auto-aplikuje migracje przy `yarn dev`. | `1` (dev) | Nie |

> Transport załączników Graph przełącza się automatycznie: ≤3 MB inline, >3 MB przez upload session.

### 3.5 Kroki konfiguracji (środowisko docelowe)
1. Skopiuj moduły + zarejestruj w `src/modules.ts`; `yarn generate`.
2. `yarn db:migrate` (tworzy tabele/partycje `channel_office365` + `mail_attachments`).
3. `yarn mercato auth sync-role-acls` — nadaje nowe feature'y domyślnym rolom:
   `customers.email.compose`, `mail_attachments.upload`, `activities.view`.
4. `yarn mercato entities seed-encryption --tenant <id>` jeśli dodajesz/rozszerzasz mapy szyfrowania.
5. Skonfiguruj Azure Client ID/Secret w *Ustawienia → Integracje → Microsoft 365*, potem podłącz skrzynkę.
6. Włącz/zaplanuj polling kanału (harmonogram `communication-channels-poll-tick` napędza sync poczty/kalendarza).

### 3.6 Uwagi operacyjne
- **Po zmianie subskrybenta zdarzeń** (np. `link-sent-attachments`) uruchom `yarn dev:reset` — worker
  kolejki ładuje zbundlowanego subskrybenta i zwykły restart może go nie przeładować.
- **Workery są leniwe** — startują przy pierwszym zadaniu; kolejki `events`,
  `communication-channels-outbound` i `communication-channels-poll*` muszą działać, żeby sync +
  linkowanie załączników funkcjonowały.
- **Wysłane załączniki pojawiają się po następnym syncu „Elementy wysłane"** (sekundy–minuty), z
  założenia — nasza kopia uploadu jest kasowana przy wysłaniu, a kopia kanoniczna przychodzi z syncu
  (idempotentnie po `(channel, external_message_id)`, więc usunięcie załącznika go nie wskrzesza).
- Sprzątanie nigdy niewysłanych uploadów (TTL): `yarn mercato mail-attachments cleanup-uploads`.

### 3.7 Znane luki / rekomendacje
- Powtarzający się **toast „kanał wymaga ponownej autoryzacji"** + jego surowy tekst klucza to zachowania
  **rdzenia** (`communication_channels`), nie tego bundla: toast odpala się ponownie aż powiadomienie
  zostanie *odrzucone* (nie tylko odczytane), pokazuje klucz i18n zamiast tytułu, i nie ma zdarzenia
  `channel.reconnected` które by go auto-czyściło. Kandydat na fix upstream.
- Fork zakładki e-maili ukrywa wbudowaną zakładkę selektorem CSS
  (`[role="tablist"] [role="tab"]:has(svg.lucide-mail)`). Jeśli upgrade frameworka zmieni ikonę tej
  zakładki, wbudowana zakładka wróci (gracefully, bez crasha) — sprawdź ponownie przy upgrade.
- Compose jest tylko dla O365 („Wyślij jako" listuje kanały Microsoft 365); referencje załączników płyną
  tylko przez adapter O365 Graph. Resolver jest niezależny od dostawcy, więc dodanie Gmaila później to
  nowe źródło, nie przepisywanie.
