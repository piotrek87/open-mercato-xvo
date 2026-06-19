# O365 Email — migracja do Communication Hub

**Date**: 2026-06-19
**Status**: Ready for Implementation

---

## TLDR

Zastępujemy własny `mail-sync` worker w module `channel_office365` dedykowanym adapterem emailowym zarejestrowanym w frameworkowym hubie `communication_channels`. Hub staje się źródłem prawdy dla emaili. `CustomerInteraction(email)` zostaje jako projekcja CRM budowana przez subscriber z eventów huba. Stare maile pozostają jako archiwum bez backfill. Użytkownik klika "Connect Microsoft 365" raz i dostaje kalendarz + email (odczyt + wysyłanie).

---

## Problem Statement

1. **Brak wysyłania emaili** — obecny `mail-sync` to tylko odczyt (inbox + sent items). Nie ma compose UI ani `sendMail`.
2. **Duplikacja infrastruktury** — moduł `channel_office365` reimplementuje własne threading, polling, i customer-linking zamiast używać huba `communication_channels`, który ma to gotowe.
3. **Niska odporność na aktualizacje frameworka** — własny mail-sync musi być ręcznie synchronizowany z każdą zmianą w hubie (nowy compose UI, nowe sloty, nowe API).

---

## Proposed Solution

Budujemy adapter `ChannelAdapter` dla O365 email (Graph API), rejestrujemy go w hubie `communication_channels`. Hub przejmuje odpowiedzialność za polling, threading, dostarczanie i wysyłanie emaili. Usuwamy zduplikowaną logikę z `channel_office365`.

**Architektura docelowa:**

```
O365 OAuth (jeden klik)
├── Kalendarz → channel_office365 workers/calendar-sync.ts     [BEZ ZMIAN]
└── Email     → communication_channels hub
                  ↓ (nowy adapter)
               channel_office365/lib/graph-mail-adapter.ts
                  ↓ (hub tworzy)
               Message + ExternalConversation + MessageChannelLink
                  ↓ (event)
               channel_office365/subscribers/crm-email-linker.ts
                  ↓ (projekcja CRM)
               CustomerInteraction(email) + ActivityLink
```

### Source of Truth

| Warstwa | Rola | Zmiana |
|---|---|---|
| `Message` + `MessageChannelLink` (hub) | Źródło prawdy — kanoniczne dane emaila | Nowe |
| `CustomerInteraction(email)` | Projekcja CRM — denormalizowany read model dla osi czasu | Zostaje (zmienia producenta) |
| Legacy `CustomerInteraction(email)` (sprzed migracji) | Archiwum — brak zmian w bazie | Zostaje na zawsze |

`CustomerInteraction(email)` pozostaje jako indeks CRM, ponieważ:
- Umożliwia szybkie zapytania po `entityId` (person/company) bez joinów do huba
- Zachowuje `ActivityLink` (relacja mail → klient)
- Komponent `E-maile` tab korzysta z `MessageChannelLink` — działa bez zmian

---

## Auto-linking: Email → Klient CRM

**Mechanizm:** mapowanie po adresie email (`primaryEmail`), z użyciem istniejącego `findWithDecryption`. Limit: `AUTO_LINK_CAP = 10` (dziedziczony z `customer-linker.ts`).

**Przepływ (nowy subscriber `crm-email-linker.ts`):**

```
1. Hub fires: communication_channels.message.received
      ↓
2. Odczyt uczestników z MessageChannelLink.channelPayload
   → [from, ...to, ...cc] jako lista adresów email
      ↓
3. findWithDecryption(em, CustomerEntity, {
     primaryEmail: IN [emails],
     organizationId, tenantId,        ← tenant scope
     deletedAt: null                  ← pomijamy soft-deleted
   })
      ↓
4. Dla każdego dopasowanego klienta (max AUTO_LINK_CAP=10):
   a. INSERT ActivityLink (messageId → personId/companyId)
      ON CONFLICT DO NOTHING
   b. INSERT CustomerInteraction(email) [projekcja]
      externalMessageId = MessageChannelLink.id
      channelProviderKey = 'office365'
      source = 'office365:mail:{externalMessageId}'  ← klucz dedup
      ON CONFLICT (source) DO NOTHING
      ↓
5. Brak dopasowania → mail trafia do huba (widoczny w inbox),
   ale nie pojawia się w osi czasu klienta CRM
```

**Heurystyka głównego linku:**
- Email przychodzący (direction: inbound): główny link → osoba pasująca do `from`
- Email wychodzący (direction: outbound): główny link → pierwsza osoba pasująca do `to[0]`

**Znane ograniczenia auto-linkowania (świadome, bez zmian architektonicznych):**

| Sytuacja | Zachowanie |
|---|---|
| Dwa rekordy CRM z tym samym emailem | Oba dostają link. Primary link = pierwszy z wyników `findWithDecryption`. |
| Kontakt scalony (stary soft-deleted) | Stary rekord filtrowany przez `deletedAt IS NULL`. Mail trafia tylko do rekordu docelowego. Stare `ActivityLink` do usuniętego rekordu zostają jako osierocone (brak błędów). |
| Adres współdzielony (biuro@firma.pl) | Wszystkie rekordy CRM z tym adresem dostają link, do limitu AUTO_LINK_CAP. |
| Brak dopasowania | Mail w hubie, niewidoczny w osi czasu żadnego klienta. |

---

## Nowe komponenty (do zbudowania)

### `channel_office365/lib/graph-mail-adapter.ts`

Implementuje `ChannelAdapter` z `@open-mercato/core/modules/communication_channels/lib/adapter`.

**Wymagane metody:**

| Metoda | Implementacja | Uwagi |
|---|---|---|
| `fetchHistory()` | Graph Delta API (`/me/mailFolders/inbox/messages/delta`) | Cursor = deltaLink, osobny dla inbox i sentItems |
| `normalizeInbound()` | Graph message JSON → `NormalizedInboundMessage` | **`body` w `$select` delta query** — zero N+1 (patrz niżej) |
| `sendMessage()` | `POST /me/sendMail` | Treść z `MessageContent.html ?? text` |
| `refreshCredentials()` | OAuth refresh token flow | Istniejący mechanizm z `lib/adapter.ts` |
| `validateCredentials()` | `GET /me` (Graph ping) | |
| `resolveContact()` | Zwraca `{email, displayName}` z payload | Brak Global Address List lookup (v1) |
| `verifyWebhook()` | No-op (zwraca `{eventType: 'other'}`) | Delta polling zamiast webhooków w v1 |

**`body` w Delta API — brak N+1:**

Graph Delta API obsługuje `body` bezpośrednio w `$select`. Zmiana w `MAIL_SELECT`:

```typescript
// Przed (Sprint 5 P2-1 — tylko preview):
'bodyPreview',   // max 260 znaków, plain text

// Po:
'body',          // { contentType: 'html'|'text', content: '...' } — inline w delta response
```

Zero dodatkowych requestów per wiadomość. Pełna treść przychodząca inline w tym samym wywołaniu Delta API.

**`NormalizedInboundMessage` — mapowanie z Graph:**

```typescript
{
  externalMessageId:       msg.id,
  externalConversationId:  msg.conversationId,
  senderIdentifier:        msg.from.emailAddress.address,
  senderDisplayName:       msg.from.emailAddress.name,
  subject:                 msg.subject ?? '(bez tematu)',
  body:                    msg.body.content,           // inline z delta $select=body
  bodyFormat:              msg.body.contentType,       // 'html' | 'text'
  timestamp:               msg.receivedDateTime ?? msg.sentDateTime,
  channelPayload: {
    from:            msg.from.emailAddress.address,
    to:              msg.toRecipients.map(r => r.emailAddress.address),
    cc:              msg.ccRecipients.map(r => r.emailAddress.address),
    subject:         msg.subject,
    hasAttachments:  msg.hasAttachments,
    // Uzupełniane po Delta sync przez email-attachment-fetcher subscriber:
    attachments?:    AttachmentSyncRecord[],
  },
  channelMetadata:         {} // uzupełniane dla outbound
}
```

`attachments[]` w `channelPayload` jest `undefined` w momencie ingest — uzupełniany asynchronicznie przez subscriber (patrz sekcja Obsługa Załączników). `hasAttachments` informuje UI o tym, że wiadomość ma załączniki zanim subscriber skończy pracę.

### `channel_office365/subscribers/email-attachment-fetcher.ts`

Subscriber reagujący na `communication_channels.message.received`. Pobiera i zapisuje załączniki asynchronicznie po ingest.

**Dlaczego deferred fetch (nie eager):**

| Podejście | Pros | Cons |
|---|---|---|
| **Eager** (bloking w fetchHistory) | Załącznik dostępny natychmiast | Blokuje Delta polling dla WSZYSTKICH kont; N+1 niemożliwy do uniknięcia |
| **Deferred** (subscriber po ingest) ✅ | Polling szybki; jeden subscriber per wiadomość | Lekkie opóźnienie (~sekunda) zanim załącznik jest dostępny |
| **On-demand proxy** (pobierz z O365 gdy kliknie) | Zero storage; najprostsze | Wymaga aktywnego połączenia O365; usunięty plik = brak dostępu |

**Decyzja: Deferred fetch.** Delta sync rejestruje `hasAttachments: true`, subscriber pobiera i zapisuje po commicie ingest.

**Przepływ:**

```
communication_channels.message.received
  ↓
email-attachment-fetcher.ts
  ↓ sprawdź: channelLink.channelPayload.hasAttachments === true
  ↓ sprawdź: channelSettings.syncAttachments === true  // domyślnie false → brak akcji
  ↓
GET /me/messages/{graphMessageId}/attachments?$top=50
  → lista załączników (z base64 content dla <4MB inline)
  ↓ dla każdego attachment:
  ├─ isInline: true  → pomiń (embedded images; domyślnie nie pobierane)
  ├─ fileSize > maxAttachmentSizeMb → zapisz metadane { status: 'too_large' }
  └─ w limicie → StorageDriverFactory.resolveForPartition('email_attachments')
                   .store(buffer, fileName)
                → em.create(Attachment, {
                    entityId:      'communication_channels.message_channel_link',
                    recordId:      channelLink.id,
                    partitionCode: 'email_attachments',
                    fileName, mimeType, fileSize, storagePath
                  })
                → { status: 'stored', omAttachmentId: attachment.id }
  ↓
em.nativeUpdate(MessageChannelLink, { id }, {
  channelPayload: { ...existing, attachments: syncRecords }
})
```

**`AttachmentSyncRecord` — typ w channelPayload:**

```typescript
type AttachmentSyncRecord = {
  fileName:      string
  mimeType:      string
  fileSizeBytes: number
  inline:        boolean
  status:        'stored' | 'too_large' | 'fetch_error' | 'skipped_inline'
  omAttachmentId?: string   // present when status === 'stored'
}
```

**API call budget per wiadomość:**
- 1 × `GET /me/messages/{id}/attachments` (list — zawiera content dla załączników < 4MB inline)
- 0–N × osobne download calls dla większych plików (Graph zwraca `contentBytes: null` dla > 4MB; osobne `GET /me/messages/{id}/attachments/{attachmentId}/$value`)
- Dla typowej wiadomości z 1–3 załącznikami: 1–4 dodatkowe API calls, całkowity czas ~200–800ms

**Obsługa błędów:** subscriber `persistent: true`. Tymczasowy błąd Graph (429, 503) = retry przez event bus. Trwały błąd (403, 404 = wiadomość usunięta) = zapisz `status: 'fetch_error'`, nie blokuj.

**`channelSettings` — konfiguracja kanału emailowego:**

```typescript
// Przechowywane w CommunicationChannel.channelSettings (JSONB)
{
  syncAttachments:    false,  // domyślnie false — użytkownik musi włączyć świadomie
  maxAttachmentSizeMb: 10,    // domyślnie 10MB; hard max = 25MB (EMAIL_MAX_ATTACHMENT_BYTES)
  syncInlineImages:   false,  // domyślnie false — osadzone obrazy pomijane
}
```

Użytkownik włącza `syncAttachments` świadomie w ustawieniach kanału. Domyślnie wyłączone — brak zaskoczenia zużyciem storage przy pierwszym połączeniu. Zmiana z `true` na `false` nie usuwa już pobranych plików.

**UX — widoczność ustawienia:**

Strona ustawień kanału emailowego (O365) MUSI wyświetlić dedykowany `Alert` gdy `syncAttachments: false`:

```
┌─────────────────────────────────────────────────────────────┐
│ ℹ  Synchronizacja załączników jest wyłączona.              │
│    Załączniki z emaili nie są kopiowane do Open Mercato.   │
│    [Włącz synchronizację załączników →]                    │
└─────────────────────────────────────────────────────────────┘
```

Toggle w sekcji ustawień kanału:
```
Synchronizacja załączników
[OFF / ON]
Kiedy włączona, załączniki z emaili będą kopiowane do Open Mercato
i zajmować miejsce na dysku. Domyślny limit: 10 MB na plik.
```

Zasady UX:
- Alert `variant="info"` widoczny bezpośrednio na stronie ustawień kanału (nie za modal)
- Opis uwzględnia konsekwencje storage: "zajmują miejsce na dysku"
- Limit per plik (`maxAttachmentSizeMb`) edytowalny, z informacją o domyślnej wartości
- Po włączeniu: alert znika; `StatusBadge` zielony "Załączniki: aktywne" obok nazwy kanału

**Partition setup (`attachments.setup.ts` contribution lub channel_office365/setup.ts):**

```typescript
// Upewnij się, że partition 'email_attachments' istnieje
// (idempotent: INSERT ... ON CONFLICT DO NOTHING)
await ensureAttachmentPartition(em, {
  code: 'email_attachments',
  title: 'Email Attachments',
  storageDriver: 'local',   // lub S3 driver z env config
})
```

**Zużycie storage:** przy 100 emailach/dzień z średnio 1 załącznikiem 2MB = ~200MB/dzień. Przy `maxAttachmentSizeMb: 10` bufor bezpieczeństwa wystarczy dla typowej firmy.

---

### `channel_office365/subscribers/crm-email-linker.ts`

```typescript
export const metadata = {
  event: 'communication_channels.message.received',
  id: 'channel_office365.crm-email-linker',
}

// Handler: patrz przepływ auto-linkowania powyżej
```

### Auto-provisioning po OAuth callback

**Klucz unikalności kanału emailowego:** `(provider_key='office365_mail', external_account_id, organization_id)` gdzie `external_account_id` = O365 user ID z `GET /me`.

**State machine — wszystkie ścieżki:**

```
Pierwsze połączenie:
  OAuth callback → GET /me → {id: "aad-uuid", mail: "user@firma.pl"}
  → SELECT channel WHERE provider_key='office365_mail' AND external_account_id='aad-uuid'
  → brak → INSERT nowy kanał emailowy (Active)

Ponowne kliknięcie / reautoryzacja:
  OAuth callback → GET /me → {id: "aad-uuid"}
  → SELECT → znaleziony istniejący kanał
  → UPDATE token + grantedScopes (bez duplikatu)

Disconnect O365:
  → kaskadowo deaktywuje powiązany kanał emailowy
  → CommunicationChannel.channelState.emailChannelId przechowuje powiązanie
```

**Guard:** `INSERT ... ON CONFLICT (provider_key, external_account_id, organization_id) DO UPDATE SET credentials = EXCLUDED.credentials, updated_at = NOW()`

---

## Polityka załączników przy odłączeniu kanału O365

### Co dzieje się z plikami po disconnect

| Sytuacja | Zachowanie | Uzasadnienie |
|---|---|---|
| Użytkownik odłącza kanał O365 | Pliki w OM **pozostają** | Zostały skopiowane do OM storage — są niezależne od O365 |
| Token O365 wygasa i nie jest odnawiany | Pliki w OM **pozostają** | Subscriber nie może pobierać nowych, ale stare pliki są nienaruszone |
| Kanał emailowy zostaje usunięty z bazy | Pliki w OM **pozostają** (brak kaskadowego delete) | Bezpieczniejszy default — lepsza utrata miejsca niż utrata danych |
| Admin chce zwolnić storage | Ręczne czyszczenie przez moduł `attachments` lub CLI | Celowe działanie administratora |

**Rekomendowana polityka: brak automatycznego usuwania.**

Racjonale:
1. Załącznik pobrany do OM jest kopią użytkownika — może zawierać kluczowe dokumenty (faktury, umowy)
2. Usunięcie attachmentu po disconnect byłoby nieodwracalne i zaskakujące dla użytkownika
3. Storage (lokalny dysk lub S3) tańszy niż utrata zaufania do systemu

**Informacja dla użytkownika przy disconnect:**

```
Odłączasz konto Microsoft 365.
Pobrane wcześniej załączniki emaili pozostają dostępne w Open Mercato.
Nowe załączniki nie będą synchronizowane po odłączeniu.
[Odłącz]  [Anuluj]
```

**Edge case — reconnect innego konta O365:**
Jeśli użytkownik połączy inne konto O365 (inny AAD user ID), auto-provisioning tworzy nowy kanał emailowy. Stare załączniki pozostają powiązane ze starym `MessageChannelLink.id` — bez mieszania z historią nowego konta.

---

## Komponenty do usunięcia

| Plik | Powód |
|---|---|
| `workers/mail-sync.ts` | Hub przejmuje polling |
| `lib/email-thread-builder.ts` | Hub przejmuje threading |
| `lib/graph-mail-client.ts` | Zastąpiony przez `graph-mail-adapter.ts` |
| `lib/customer-linker.ts` (email część) | Zastąpiony przez `crm-email-linker.ts` |
| UI `/backend/.../microsoft-365` — sekcja "Synchronizacja email" | Duplikat konfiguracji huba |
| Worker queue config `channel-office365-mail-sync` | Usunięty worker |

---

## Komponenty zostające w channel_office365

| Plik | Co robi |
|---|---|
| `workers/calendar-sync.ts` | Inbound sync kalendarza — BEZ ZMIAN |
| `subscribers/activity-o365-outbound-*.ts` | Outbound spotkań (create/update/delete) — BEZ ZMIAN |
| `subscribers/customer-activity-backfill.ts` | Backfill linków do nowych klientów — BEZ ZMIAN |
| `lib/graph-client.ts` | Klient Graph dla kalendarza — BEZ ZMIAN |
| `data/entities.ts` (ExternalSyncRegistry) | Registry dla kalendarza — BEZ ZMIAN |
| OAuth flow + token management | Współdzielony przez email i kalendarz |
| `lib/graph-mail-adapter.ts` | NOWY — adapter emailowy dla huba |
| `subscribers/crm-email-linker.ts` | NOWY — projekcja CRM |

---

## API Contracts

### Nowe scopy OAuth (wymagane w Azure App Registration)

Obecne: `Calendars.ReadWrite`, `Mail.ReadWrite`, `User.Read`, `offline_access`

**Bez zmian** — `Mail.ReadWrite` wystarczy dla Graph API email read/send. Nie potrzeba Exchange Online IMAP scopes.

### Nowe endpointy channel_office365

Brak nowych endpointów — adapter rejestruje się w hubie przez istniejące `POST /api/communication_channels/channels/connect`.

### Hub endpoints (istniejące, teraz dostępne dla O365)

| Endpoint | Cel |
|---|---|
| `POST /api/communication_channels/send-as-user` | Wysyłanie emaila przez compose UI huba |
| `GET /api/communication_channels/me/channels` | Lista połączonych kanałów (email O365 pojawi się tutaj) |
| `POST /api/communication_channels/channels/{id}/poll-now` | Ręczne wyzwolenie sync emaili |
| `POST /api/communication_channels/channels/{id}/import-history` | Import historii (opcjonalny backfill na żądanie) |

---

## Migracja historyczna

**Strategia: archiwum bez backfill.**

```
PRZED migracją:
  CustomerInteraction(email) ← tworzony przez mail-sync worker
  [widoczny w osi czasu i zakładce E-maile]

PO migracji:
  Nowe emaile → hub → crm-email-linker → CustomerInteraction(email) projekcja
  Stare emaile → zostają jako CustomerInteraction(email) legacy records
               → nadal widoczne w osi czasu aktywności
               → E-maile tab (oparty o MessageChannelLink) pokaże tylko nowe

Punkt odcięcia: data deployu adaptera
```

**Dlaczego brak obowiązkowego backfill:**
- Istniejące `CustomerInteraction(email)` pozostają w bazie bez zmian
- Oś czasu aktywności renderuje oba: legacy + nowe projekcje (brak regresji)
- `E-maile tab` (query via MessageChannelLink) pokaże tylko nowe — to świadome ograniczenie
- Koszt operacyjny backfill (SQL migration + ryzyko duplikatów) nie jest uzasadniony

**UX mitygacja — banner w zakładce E-maile:**

```
┌─────────────────────────────────────────────────────────────┐
│ ℹ  Synchronizacja emaili przez nową ścieżkę od 2026-06-XX. │
│    Starsze wiadomości są widoczne w Osi czasu aktywności.   │
│    [Zaimportuj historię]  ← POST /channels/{id}/import-history │
└─────────────────────────────────────────────────────────────┘
```

Przycisk "Zaimportuj historię" = jednorazowy, opcjonalny, na żądanie użytkownika. Uruchamia `fetchHistory` od najstarszego dostępnego maila. Dla użytkowników z dużą historią może trwać kilka minut.

---

## Plan wdrożenia (fazy)

### Faza 1 — Adapter emailowy (tydzień 1)
1. Napisać `graph-mail-adapter.ts` implementujący `ChannelAdapter`
2. Zaimplementować `fetchHistory()` z Graph Delta API (osobne cursory: inbox + sentItems)
3. Zaimplementować `normalizeInbound()` z pełnym body fetch
4. Zaimplementować `sendMessage()` via `POST /me/sendMail`
5. Zarejestrować adapter w DI (`di.ts`)
6. Testy: wysyłanie + odczyt z prawdziwym kontem O365 (tenant testowy)

### Faza 2 — CRM linker + auto-provisioning (tydzień 1-2)
1. Napisać `subscribers/crm-email-linker.ts`
2. Mechanizm auto-provisioning kanału emailowego po OAuth callback
3. Dedup guard: `source = 'office365:mail:{id}'` (ON CONFLICT DO NOTHING)
4. Testy: email od klienta → pojawia się w osi czasu

### Faza 2b — Obsługa załączników (tydzień 2)
1. Napisać `subscribers/email-attachment-fetcher.ts`
2. Upewnić się, że partition `email_attachments` jest tworzona w `setup.ts`
3. Zintegrować z modułem `attachments` (StorageDriverFactory lub `storePartitionFile`)
4. Dodać `channelSettings: { syncAttachments, maxAttachmentSizeMb, syncInlineImages }` do UX kanału emailowego
5. Testy: email z załącznikiem PDF → plik dostępny przez `/api/attachments/file/{id}` w E-maile tab

### Faza 3 — Usunięcie starego mail-sync (tydzień 2)
1. Wyłączyć `workers/mail-sync.ts` (usunąć z setupu, zachować plik przez 1 sprint)
2. Usunąć `email-thread-builder.ts`, `graph-mail-client.ts`
3. Uprościć `customer-linker.ts` (usunąć email-specific logic)
4. Wyczyścić UI `/backend/.../microsoft-365` (usunąć sekcję email sync)
5. Usunąć worker queue `channel-office365-mail-sync`

### Faza 4 — Porządki i QA (tydzień 2-3)
1. Weryfikacja E-maile tab (nowe emaile przez hub)
2. Weryfikacja osi czasu (legacy + nowe razem)
3. Weryfikacja wysyłania (compose UI z huba, reply threading)
4. TypeScript check + `yarn generate`
5. Usunąć plik `mail-sync.ts`

---

## Definition of Done

**Producent emaili:**
- [ ] Po cutover istnieje dokładnie jeden producent nowych emaili (hub przez adapter)
- [ ] `workers/mail-sync.ts` wyrejestrowany z `setup.ts` w dniu deployu (plik zostaje przez 1 sprint)
- [ ] Brak duplikatu emaili przy awarii (dedup przez `source` key, ON CONFLICT DO NOTHING)

**Funkcjonalność:**
- [ ] Użytkownik klika "Connect Microsoft 365" → jeden OAuth flow → działają email + kalendarz
- [ ] Nowe emaile pojawiają się w zakładce E-maile i osi czasu klienta (auto-link po adresie email)
- [ ] Wysyłanie emaila przez compose UI huba działa (pojawia się w sent items O365)
- [ ] Stare emaile (sprzed migracji) nadal widoczne w osi czasu klienta

**Reconnect / auto-provisioning:**
- [ ] Ponowne kliknięcie "Connect Microsoft 365" aktualizuje token na istniejącym kanale, nie tworzy duplikatu
- [ ] Disconnect O365 dezaktywuje kaskadowo kanał emailowy
- [ ] Kanał emailowy ma unikalny constraint `(provider_key, external_account_id, organization_id)`

**Historia:**
- [ ] Banner informacyjny w zakładce E-maile widoczny po migracji
- [ ] Przycisk "Zaimportuj historię" wywołuje `/channels/{id}/import-history` i działa poprawnie

**Załączniki:**
- [ ] Subscriber `email-attachment-fetcher.ts` zapisuje pliki w OM (`attachments` module) gdy `syncAttachments: true`
- [ ] Domyślna wartość `channelSettings.syncAttachments: false` — brak storage bez świadomej decyzji
- [ ] Pliki powyżej limitu (`maxAttachmentSizeMb: 10`) zapisywane jako `status: 'too_large'` (bez content)
- [ ] Inline images (`isInline: true`) pomijane domyślnie (`syncInlineImages: false`)
- [ ] Błąd Graph API przy pobieraniu załącznika → `status: 'fetch_error'`, nie blokuje innych wiadomości

**Jakość:**
- [ ] TypeScript 0 errors, `yarn generate` bez błędów
- [ ] Żadne nowe uprawnienia Azure nie są wymagane (Mail.ReadWrite wystarczy)

---

## Rollback Strategy

### Warunki uruchomienia

- Emaile przestają pojawiać się w osi czasu klientów po cutover
- Hub adapter zgłasza powtarzające się błędy (Graph API, token refresh, hub event failures)
- Regresja wydajności (hub polling blokuje inne workery)
- Zakładka E-maile pusta bez wyraźnej przyczyny po ponad 15 minutach

### Procedura (szacowany czas: 15–30 minut)

```
Krok 1 — setup.ts: przywrócić mail-sync w harmonogramie (1 linia)
Krok 2 — di.ts:    wykomentować rejestrację graph-mail-adapter
Krok 3 — deploy:   tylko config, zero migracji DB
Krok 4 — verify:   sprawdzić logi mail-sync po ~15 min od deployu
```

### Bezpieczeństwo danych

| Dane | Stan po rollbacku |
|---|---|
| `Message` / `MessageChannelLink` zapisane przez hub | Pozostają w bazie — nie są kasowane |
| `CustomerInteraction` projekcje z huba | Pozostają — widoczne w osi czasu |
| Delta cursor mail-sync | Wznawia od kursora sprzed migracji; jeśli przeterminowany (>30 dni) — Graph bootstrapuje automatycznie |

**Brak ryzyka utraty danych.** Emaile odebrane w oknie cutover → rollback są w hubie jako `Message` i widoczne w osi czasu przez projekcję CRM — nie znikają.

---

## Sent Items — decyzja projektowa

| Przypadek | v1 (inbox + sentItems) |
|---|---|
| Email wysłany przez OM | ✅ Hub tworzy `Message` przy `sendMessage()`. Dedup po `externalMessageId` zapobiega duplikatowi gdy polling znajdzie tę samą wiadomość. |
| Email wysłany z Outlooka / telefonu / webmaila | ✅ Pobierany przez polling Sent Items — zachowanie identyczne z obecnym mail-sync |

**Decyzja: Sent Items w v1. Paritet z obecnym mail-sync.**

Rezygnacja z Sent Items byłaby regresją — obecny mail-sync synchronizuje oba foldery i użytkownicy widzą w CRM maile wysłane z Outlooka. Koszt techniczny zachowania tego zachowania to ~1 dzień.

**Dedup wiadomości wysłanych przez OM:**

`POST /me/sendMail` zwraca `204 No Content` bez ID wiadomości — nie można deduplikować. Zamiast tego używamy **2-step send**:

```
POST /me/messages          → tworzy draft, zwraca { id: "AAMk..." }
POST /me/messages/{id}/send → wysyła, 202 Accepted
```

`sendMessage()` zwraca `{ externalMessageId: "AAMk..." }`. Hub zapisuje ID w `MessageChannelLink`. Gdy Sent Items delta znajdzie tę wiadomość — `ON CONFLICT (externalMessageId) DO NOTHING`.

**`channelState.mail`:**
```typescript
{
  inbox:     { deltaToken: '...' },
  sentItems: { deltaToken: '...' },  // osobny kursor, osobna pętla w fetchHistory()
}
```

---

## Ryzyka

| Ryzyko | Waga | Mitygacja |
|---|---|---|
| ~~Pełny body fetch N+1~~ | ~~ŚREDNIE~~ | **WYELIMINOWANE** — `body` dostępne inline w Delta `$select` |
| Duplikat kanału emailowego przy reconnect | ŚREDNIE | Unique constraint + ON CONFLICT DO UPDATE w auto-provisioning |
| Legacy emaile znikają z zakładki E-maile po migracji | NISKIE | Banner informacyjny + przycisk "Zaimportuj historię" |
| Hub nie linkuje automatycznie emaili do CRM klientów | WYSOKIE | `crm-email-linker.ts` — core functionality fazy 2, bez niej feature niepełny |
| Kolizja delta cursora po wyłączeniu mail-sync | NISKIE | Kanał emailowy huba ma własny cursor; stary cursor w channelState ignorowany |
| Duże payloady HTML przez `$select=body` | NISKIE | HTML emaile 50–200KB; przy `odata.maxpagesize=50` akceptowalne |
| Zużycie storage gdy wiele kont z `syncAttachments: true` | ŚREDNIE | Domyślnie wyłączone. Limit 10MB/plik. Monitorować partition `email_attachments`. |
| Graph API rate limit przy masowym pobieraniu załączników | NISKIE | Subscriber persistent — retry automatyczny; jedno konto nie blokuje innych |
| Plik usunięty w O365 po pobraniu przez subscriber | BRAK RYZYKA | Plik już w OM — dostęp niezależny od O365 |

---

## Changelog

| Data | Zmiana |
|---|---|
| 2026-06-19 | Spec initial — po analizie wpływu i wyjaśnieniu 3 kwestii architektonicznych |
| 2026-06-19 | v2 — doprecyzowanie 5 edge case'ów: cutover strategy, auto-linking limits, N+1 wyeliminowany, banner migracyjny, reconnect guard |
| 2026-06-19 | v3 — dodano rollback strategy + błędna decyzja o Sent Items |
| 2026-06-19 | v4 — przywrócono Sent Items do v1 (paritet z obecnym mail-sync); 2-step send dla dedup. Spec zamknięty. |
| 2026-06-19 | v5 — dodano obsługę załączników: deferred fetch subscriber `email-attachment-fetcher.ts`, storage w module `attachments`, `channelSettings.syncAttachments` domyślnie `false`. Szacunkowy wpływ na harmonogram: +1 tydzień. |
| 2026-06-19 | v6 — UX dla syncAttachments (Alert gdy wyłączone, toggle z opisem konsekwencji). Polityka przy disconnect: pliki pozostają w OM, brak automatycznego usuwania. Spec ZAMKNIĘTY. |
