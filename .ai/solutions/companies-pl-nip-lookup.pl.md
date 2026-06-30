# Wyszukiwarka polskich firm (NIP / KRS / REGON)

> Polska wersja [companies-pl-nip-lookup.md](companies-pl-nip-lookup.md). W razie rozbieżności wersja angielska jest kanoniczna.

Gałąź (przenośny bundle): `integration/companies-pl` · Moduł: `companies_pl`

---

## 1. Opis biznesowy (dla użytkowników końcowych)

Uzupełnij dane polskiej firmy automatycznie z jej numeru NIP, zamiast wpisywać je ręcznie.

**Co dostajesz:**
- Na rekordzie **firmy** (formularz tworzenia i strona szczegółów) jest panel **NIP / KRS / REGON** z
  przyciskiem **„Pobierz dane po NIP"**.
- Wpisujesz NIP, a system pobiera oficjalne dane firmy z **wykazu podatników VAT Ministerstwa Finansów**
  (biała lista) i uzupełnia nazwę firmy oraz numery rejestrowe.
- Pobrane **adresy** (siedziba) można zapisać na firmie jednym kliknięciem.
- Numery są zapisywane jako custom fields (**NIP, KRS, REGON**) na firmie i są filtrowalne na listach.

**Dobrze wiedzieć:** źródłem danych jest biała lista VAT Ministerstwa Finansów (publiczna, bez klucza
API). KRS i REGON są uzupełniane tylko tym, co biała lista zwróci dla danego NIP.

---

## 2. Architektura (jeden akapit)

Pojedynczy route API (`GET /api/companies_pl/company-lookup?nip=…`) proxuje białą listę VAT
Ministerstwa Finansów i normalizuje odpowiedź. UI jest dostarczone wyłącznie przez **widget injection**
do rdzeniowych powierzchni szczegółów/tworzenia firmy w `customers` (bez bezpośredniego sprzężenia ORM
między modułami). Custom fields (`nip`, `krs`, `regon`) są dodawane do rdzeniowej encji
`customers:customer_company_profile` przez `ce.ts`. Czysty helper parsuje free-textowy adres z białej
listy na pola strukturalne.

**Zależy od tych (wbudowanych) modułów:** `customers` (API profilu firmy + adresów), `entities`
(custom fields).

---

## 3. Przenoszenie na inne środowisko

### 3.1 Pliki / moduły do skopiowania
- `src/modules/companies_pl/**`
- Zarejestruj w `src/modules.ts`: `{ id: 'companies_pl', from: '@app' }`
- Uruchom `yarn generate`, potem `yarn db:generate` / `yarn mercato entities install`, żeby custom
  fields `nip`/`krs`/`regon` zostały provisionowane na istniejących tenantach.

### 3.2 Zmienne środowiskowe
Moduł działa **od ręki, bez konfiguracji** (woła publiczne API Ministerstwa Finansów). Obie zmienne to
opcjonalne furtki:

| Zmienna | Cel | Domyślnie | Wymagana |
|---|---|---|---|
| `OM_COMPANY_LOOKUP_API_URL` | Nadpisuje endpoint lookupu własnym proxy (np. agregatorem GUS/KRS). Gdy ustawione, w pełni zastępuje wywołanie białej listy MF; NIP jest doklejany jako `?nip=`/`&nip=`. Oczekiwany JSON: `{ nip, krs, regon, name, legalName }`. | nieustawione (używa białej listy MF) | Nie |
| `OM_USE_WL_API` | Ustaw na `false`, by użyć wbudowanej **atrapy** (mock) (**tylko dev** — zwraca `503` gdy `NODE_ENV=production`, nigdy zmyślonych danych w prod). Każda inna wartość (lub brak) woła żywe API. | brak → żywe API | Nie |

Brak kluczy/sekretów — biała lista MF jest publiczna. Bazowy URL `https://wl-api.mf.gov.pl` jest stałą.

### 3.3 Kroki konfiguracji (środowisko docelowe)
1. Skopiuj `src/modules/companies_pl/**` + zarejestruj w `src/modules.ts`; `yarn generate`.
2. `yarn mercato entities install` (provisioning custom fields NIP/KRS/REGON na encji firmy).
3. Brak własnych migracji, brak sekretów. Otwórz rekord firmy → panel lookup jest na miejscu.

### 3.4 Status hardeningu (po przeglądzie)

**Naprawione w `0960bc2` (hardening NIP-lookup):**
- ✅ **Bramka RBAC** — route lookupu wymaga teraz feature'a `companies_pl.lookup` (zadeklarowanego w
  `acl.ts`, nadawanego przez `setup.ts` `defaultRoleFeatures`), a nie tylko `requireAuth: true`.
- ✅ **Walidacja sumy kontrolnej** — `isValidNip` (standardowe mod-11) odrzuca numery poprawne formalnie
  ale błędne, przed jakimkolwiek wywołaniem API; dodane helpery `isValidRegon` / `isValidKrs`. Pokryte
  testem `__tests__/polishIdentifiers.test.ts`.
- ✅ **Timeout fetcha** — wywołania zewnętrzne idą przez `fetchWithTimeout` (8 s `AbortController`), więc
  zawieszone API MF/proxy nie zawiesi żądania.
- ✅ **Mock odcięty od prod** — `OM_USE_WL_API=false` zwraca `503` gdy `NODE_ENV=production`; zmyślona
  firma (fałszywy KRS `0000123456`) jest tylko dev i nie wycieknie już do produkcji.

**Wciąż otwarte (warte hardeningu przed intensywnym użyciem produkcyjnym):**
- **Brak i18n** — stringi są nadal zahardkodowane po polsku (błędy route'a, etykiety widgetów, etykiety
  pól w `ce.ts`). Dodaj `i18n/{pl,en}.json` + `useT()`, by spełnić regułę design-system/i18n i wspierać
  angielski.
- **PII / szyfrowanie** — NIP/REGON/KRS i pobierane adresy to dane firmy/PII. Potwierdź, czy rdzeniowy
  profil firmy je szyfruje; jeśli te kolumny custom-field trzymają PII, zadeklaruj mapę `encryption.ts`.
- **Nazwa vs rzeczywistość** — moduł nazwany od NIP/KRS/REGON, ale odpytuje tylko białą listę VAT MF (nie
  GUS REGON ani rejestr KRS). Dla bogatszych danych skieruj `OM_COMPANY_LOOKUP_API_URL` na proxy GUS/KRS.
- **Testy** — testy jednostkowe `parsePolishAddress` + sum kontrolnych identyfikatorów istnieją; test
  mapowania odpowiedzi białej listy pozostaje dobrym kandydatem.
