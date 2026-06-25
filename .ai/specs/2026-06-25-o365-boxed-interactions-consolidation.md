# O365 Sync → Boxed Interactions Consolidation (odwrócenie dual-write)

**Date**: 2026-06-25
**Status**: DEFERRED (decyzja 2026-06-25)

> **Decyzja (2026-06-25)**: Odłożone. Konsolidacja na `CustomerInteraction` wymagałaby zmiany NOT NULL → nullable na `entity_id` w **encji rdzenia** (`@open-mercato/core`, nie ejectowana). User świadomie rezygnuje: kontakt ze schematem/encjami core grozi konfliktami przy aktualizacjach frameworka („jak jedzie aktualizacja, będzie burdel"). **Zostaje obecna architektura dual-write** (`activities` + `customer_interactions`) z naprawionym dedupem (filtr w `interactions-get-override.ts`). Wrócić do tematu, jeśli: (a) zaczniemy kontrolować/forkować core, albo (b) pojawi się natywne wsparcie nullable `entity` w OM. Analiza + decyzje D1–D6 i ścieżki A/B/C/D/E poniżej zachowane jako materiał na przyszłość.

## TLDR

**Key Points:**
- Odwrócić obecny dual-write: zamiast pisać O365-maile/spotkania do custom `activities` **i** do boxed `customer_interactions`, oprzeć się na boxed `customer_interactions` (+ `messages`/wątki) jako jedynym źródle prawdy.
- Lukę po `activities` zasypać cienkim kodem reaktywnym (firmy po osobach, korekta czasu, spotkania jako CI) i przepiąć custom UI na `customer_interactions`.

**Scope (proponowany — do potwierdzenia):**
- Email→osoba: zostaje rdzeniowi (`link-channel-message-handler`); usuwamy dublujący source-CI z `crm-email-linker`.
- Email→firma (i inne encje): reaktywnie po zdarzeniu `customers.email.linked` (rdzeń je emituje), po relacjach osoba→firma.
- Korekta `occurred_at` rdzeniowego CI na realny `receivedAt` (rdzeń daje czas syncu).
- Kalendarz/spotkania: `calendar-sync` pisze bezpośrednio `customer_interactions` (typ `meeting`) zamiast `activities`.
- Przepięcie UI: `/backend/activities`, statystyki, widget M365 → czyt z `customer_interactions`.
- Migracja istniejących danych `activities`.

## Decyzje produktowe (potwierdzone 2026-06-25)

- **D1 (zakres)**: Pełne usunięcie modułu `activities`. Jeden model „aktywności" = `CustomerInteraction`. Bez utrzymywania dwóch równoległych bytów.
- **D2 (bez klienta)**: `CustomerInteraction.entity` staje się **opcjonalne (NULLABLE)**. Interakcja może być powiązana z klientem albo ogólna (bez klienta).
- **D3 (O365 unmatched)**: Spotkanie/mail bez dopasowanego klienta importujemy jako CI z `entity = NULL` + znacznik `matchingStatus = 'unmatched'` (do późniejszego ręcznego przypisania). Nie tracimy danych.
- **D4 (UI)**: `/backend/activities`, statystyki i widget M365 → zastąpione przez `customer_interactions` (jeden timeline, jeden widget, jedne statystyki, jeden zestaw endpointów `/customer-interactions`).
- **D5 (migracja)**: Migrujemy **wszystko**. Każda `Activity` → `CustomerInteraction`. Z klientem → zachować powiązanie; bez klienta → `entity = NULL`. Bez archiwizacji/kasowania.
- **D6 (typy + custom fields)**: `activity_types` → `interactionType`; custom fields activities → custom fields CI. Bez utraty konfiguracji użytkownika.

## ⚠️ Bariera implementacyjna: `CustomerInteraction` to encja RDZENIA

Zweryfikowane w kodzie (2026-06-25):
- `customers` to moduł **core** (`@open-mercato/core`), **NIE ejectowany** w `src/modules/`.
- `CustomerInteraction.entity` → `ManyToOne(CustomerEntity, { fieldName: "entity_id" })` **bez `nullable`** = NOT NULL w schemacie core.
- CI **ma** wsparcie custom fields (`ce.js` → `customers:customer_interaction`) — `matchingStatus` można dodać jako custom field bez zmiany schematu core.

Czyli D2 (nullable `entity`) + ewentualna kolumna `matchingStatus` wymagają zmiany **encji, której repo nie jest właścicielem**. To nie jest „stara decyzja" — to kwestia własności pakietu. Stąd jedno blokujące pytanie:

## Open Questions *(remove before finalizing — STOP, czekam na odpowiedź)*

- **Q7 — Ścieżka zmiany encji core (BLOKUJĄCE)**: Jak zmieniamy `CustomerInteraction.entity` na nullable?
  - **(A) Zmiana w rdzeniu `@open-mercato/core`** (PR/own fork): dodać `nullable: true` do relacji + (opcjonalnie) kolumnę `matching_status`, uodpornić ścieżki odczytu core na `entity = null`. **Najczystsze i docelowe.** Wykonalne tylko jeśli **kontrolujesz/utrzymujesz `@open-mercato/core`** (jesteś autorem frameworka / możesz wydać zmianę). Czy tak jest?
  - **(B) Eject modułu `customers`** do `src/modules/` i lokalna zmiana: pełna kontrola, ale `customers` to jeden z największych modułów core (osoby, firmy, szanse, interakcje, słowniki…) — tracimy ścieżkę aktualizacji dla całego modułu. Bardzo ciężkie.
  - **(C) Obejście app-level bez zmiany kodu core**: migracja DB zdejmuje `NOT NULL` z `entity_id`; nasze zapisy customer-less idą własną komendą/SQL (nie przez core `create`); `matchingStatus` jako custom field CI; globalny timeline/statystyki/widget to NASZ override (czyta też `entity = null`); per-klient zakładki core naturalnie pomijają wiersze bez `entity`. Wykonalne bez ejectu, ALE: (i) ryzyko, że odczyt core nie toleruje `entity = null` (część kodu używa `?.`, ale nie wszędzie — do weryfikacji), (ii) dryf snapshotu przy kolejnej migracji core. Pragmatyczne, ale kruche.

  **Którą ścieżką idziemy (A / B / C)?** To determinuje cały Data Model i Implementation Plan. Moja rekomendacja: **A jeśli kontrolujesz core**, w przeciwnym razie **C** (z twardą weryfikacją tolerancji `null` w core na etapie Fazy 0).

---

## Overview

*(do uzupełnienia po odpowiedziach na Q1–Q6)*

## Problem Statement

*(do uzupełnienia)*

## Proposed Solution

*(do uzupełnienia — zależne od Q1/Q2)*

## Data Models

*(do uzupełnienia)*

## API Contracts

*(do uzupełnienia)*

## Implementation Plan

*(do uzupełnienia — fazy + migracja)*

## Risks

| Risk | Severity | Mitigation | Residual |
|------|----------|------------|----------|
| Utrata aktywności bez klienta przy usunięciu `activities` | High | Zależne od Q1/Q2 | TBD |
| Migracja danych nieodwracalna (ręczne aktywności) | High | Zależne od Q5 | TBD |

## Changelog

| Date | Change |
|------|--------|
| 2026-06-25 | Initial skeleton + Open Questions |
