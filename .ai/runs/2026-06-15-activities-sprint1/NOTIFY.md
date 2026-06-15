# Notify — 2026-06-15-activities-sprint1

> Append-only log. Every entry is UTC-timestamped. Never rewrite prior entries.

## 2026-06-15T00:00:00Z — run started
- Brief: Implement Sprint 1 Activity Module — activities module CRUD API, lifecycle actions, RBAC, encryption maps, events, ActivityTimeline widget injection into customers and sales order pages
- External skill URLs: none
- Decisions:
  - No git remote / gh CLI → PR is local-only; user pushes manually
  - Primary worktree used (no secondary worktree)
  - Migration SQL hand-authored (no live DB connection)
  - Injection spot IDs verified from framework source: customers.person.detail:tabs, detail:customers.company:tabs, sales.document.detail.order:tabs
