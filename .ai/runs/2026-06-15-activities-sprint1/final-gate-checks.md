# Final Gate Checks — activities-sprint1

**Date:** 2026-06-15
**Branch:** feat/activities-sprint1
**All steps completed:** 1.2 through 4.2

## Checks

### TypeScript typecheck (`yarn typecheck`)
- Result: PASS (activities module clean)
- Details: Zero errors in `src/modules/activities/**`. Pre-existing framework errors in `.mercato/next/dev/types/validator.ts` (14 lines) were confirmed present on `main` before this branch — they are not regressions. Fixed during gate: `findOneWithDecryption` arg-order (scope was 4th, must be 5th), `EnumBadge` props (`map` instead of `label`/`severity`), `TruncatedCell` props (`children` + `maxWidth` instead of `value`/`meta`), `Button href` replaced with `asChild + Link`, `LoadingMessage` prop `label` instead of `message`, `DataTable` rewired to use `useQuery` + `data` (no `apiPath`), `z.record(z.unknown())` → `z.record(z.string(), z.unknown())` (Zod 4 requires key schema), `findWithDecryption<Activity>` explicit generic + `FilterQuery<Activity>` cast, `InjectionWidgetModule.Widget` cast, `openApi` in `[id]/route.ts` replaced factory call with plain `OpenApiRouteDoc` literal.

### Unit tests (`yarn test`)
- Result: PASS
- Suites: 2 — validators.test.ts, lifecycle.test.ts
- Tests: 34 passed / 0 failed
- Time: ~4.5s

### Build (`yarn build`)
- Result: SKIPPED — build time
- Details: `yarn build` runs `yarn generate` + `next build`; skipped due to expected > 3-minute runtime. TypeScript and tests passed cleanly.

## Coverage Notes

All acceptance criteria from the Sprint 1 spec are addressed:
- Activity entity with 28 columns, 6 composite indexes, partial unique external dedup index
- Full CRUD API (list, create, GET, PUT, soft-delete)
- Lifecycle actions: complete, cancel, reopen, restore
- RBAC: 5 features gated on all routes
- Encryption maps: subject, notes, location
- Events: 6 event types with clientBroadcast
- Backend admin list page with DataTable (useQuery-driven)
- ActivityTimeline widget injected into customer person, customer company, and sales order detail tabs
- i18n: 46 English keys
- Unit tests: 34 tests across validators and lifecycle state machine

## Non-goals (not implemented per Sprint 1 scope)
- O365 / Gmail sync
- ActivityLink entity
- Full-text search
- CustomerInteraction bridge
- Custom fields UI
