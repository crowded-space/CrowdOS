# Workspace Domain — Phase 7 Fix Plan (proposal, incremental — no rewrite)

Constraints: preserve facade contract (additive only where possible); main branch; review-gated commits; docs synced in the same task as each code change; AGENTS.md gate rules (gate-to-gate only).

## Workstream A — Security/correctness (do first)
1. WS-001 pin-cache invalidation: workspace-pin.ts set/clear -> call pin-gate invalidatePinCache (pin-gate.ts already imported for crypto; add to import list). Tests: enable/clear immediacy. Compat: none. Rollback: revert one call pair.
2. WS-002 honest PIN persistence: set/clear verify registry (or DB) write succeeded; return 5xx on failure. Route already maps errors to 400; add explicit message. Tests: failure path. Compat: response on success unchanged.
3. WS-005 corrupt-registry fail-open: workspace-registry.readAllRaw distinguishes ENOENT vs parse error (log + rethrow for non-ENOENT on get-by-id paths, or keep last-known-good). Coordinate with pin-gate resolver behavior. Tests: corrupt file.
4. WS-004 conflict quarantine in tier resolution: tierContextFor/resolveTier return local when record.dbSync.state === 'conflict' (or gate dualWrite). Files: workspace-registry.ts tierContextFor, shared/config/database.ts resolveTier, shared/core/workspace-sync.ts. Tests: conflict -> local-only writes.

## Workstream B — Data lifecycle
5. WS-003 reset coverage: derive drop list from migrations journal (or versioned constant + coverage test comparing schema tables vs list). Migration: none (code-only), but add integration test reset->provision->seed. Rollback: revert list.
6. WS-016 seed status: return {seeded: boolean, partial?: string[]}; route logs/surfaces; optionally transactional per step. Tests: injected failure.
7. WS-017 outbox cleanup on disconnect: routes PATCH databaseUrl null -> clearWorkspaceOutbox(id). Tests: backlog 0.
8. WS-018 delete mirror: removeWorkspaceRecord (or delete route) deletes <folder>/workspace.json when folder kept. Tests: scope enumeration excludes it.

## Workstream C — Paths/FS edges
9. WS-014 rename ordering + case-only rename (win32 case-insensitive compare; compensate on save failure).
10. WS-013 rootPath validation/flag on create/patch.
11. WS-019 toFolderRelative win32 case-insensitivity; WS-020 single sanitizer + dead branch removal; WS-025 sanitize fallback id.

## Workstream D — Contract hygiene
12. WS-009/WS-010 dead ports: remove .env machinery + unused exports (or mark internal); update gate + docs + gate-shape test.
13. WS-015 route->channel-local-store: add channels gate ports; drop check-gates allowlist entry.
14. WS-008/WS-022 fan-out observability + churn: warn per skip; consider short-lived connections for sweeps.
15. WS-011 docs sync: Workspace.md Expect/Flow/Ports/Gaps updated with items 1-14 in the same tasks (AGENTS.md section 6).

## Ordering, verification, DoD
Order: A1-A4 -> B5-B8 -> C9-C11 -> D12-D15. Each step: implement -> npx vitest run src/workspace (plus affected suites) -> tsc --noEmit -> node scripts/check-gates.mjs -> stop for live review -> commit only on explicit yes (git-crow for push/pull).
DoD per step: ledger ID closed with file:line change; tests added for the documented outcome; docs updated same task; facade contract unchanged or additive (documented); no new cross-domain imports past gates.
Rollback: each workstream is independently revertible; WS-003 and WS-005 carry the only cross-module behavioral changes (reset semantics, registry error surface) and should ship with a short release note.

