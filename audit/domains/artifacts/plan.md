# Artifacts Domain — Plan (READ-ONLY audit; no production edits made)
> Rewrite decision: INCREMENTAL. The domain is 4 files / ~250 LOC, the gate is already thin and rule-compliant, and the persistence/event contract is sound. Fix the contract leaks (client full-body apply, tenant routing, retention wiring) in place; a rewrite would discard a working facade and risk the runtime callers for no gain.

## Ordered fix plan (each step = one reviewable change; AGENTS.md: docs updated in the SAME task)
1. ART-1 (S1) — Client full-body apply/revert: fetch GET /api/artifacts/:id (getById) before applyDiff/revertDiff; keep list truncation. Files: packages/client/stores/crowdOsStore.ts (applyDiff, revertDiff), maybe DiffViewer conflict check. Tests: TG-1/TG-2. Compat: API unchanged. Rollback: revert client change. DoD: applying artifact with contentRef>500 writes full body; list payloads unchanged.
2. ART-2 (S1) — Tenant routing for runtime artifact writes: wrap socket executeRun in runWithDb(await dbForWorkspace(workspaceId)) or thread tenant db. Files: register-socket-server.ts (~:323-334), possibly runtime-executor. Tests: TG-9. Rollback: revert wrapper. DoD: socket-run artifact lands in workspace DB; DATABASE_URL-unset local-first still persists where workspace DB exists.
3. ART-3 (S2) — Wire retention: handleRetention calls artifactsGate.runRetentionSweep() (with error isolation) or add dedicated repeatable. Files: queue/maintenance-worker.ts, docs. Tests: TG-3. Rollback: remove call. DoD: expired artifacts purged on schedule; log line appears.
4. ART-4 (S2) — Bind listByWorkspace to identity: reject mismatched workspaceId (403) unless admin. Files: routes/artifacts.ts, auth util. Tests: TG-8. DoD: mismatched workspaceId rejected.
5. ART-7 (S2) — Sanitize runId path segment (UUID/slug) in writeArtifactFile. Files: artifacts-repository.ts:76-79. Tests: TG-5. DoD: traversal runId cannot write outside artifactDir.
6. ART-13 + ART-8 (S2) — Remove as-never casts; keep caller path in metadata.sourcePath, store only written path in path. Files: artifacts-repository.ts. Tests: TG-4/TG-6. DoD: typecheck enforces payload; path semantics documented.
7. ART-5 + ART-6 (S2) — Batched purge + documented retry semantics (dedupe key optional). Files: artifacts-repository.ts. Tests: TG-7. DoD: purge bounded per statement; retry behavior documented.
8. ART-9..ART-12, ART-14 (S3) — Docs sync (Ports/listByRunAndType removal, scheduling owner, env clamp, warn text), client error propagation, add unit tests so CI without DB still covers the domain.

## Verification per step
- npx tsc -p tsconfig.json --noEmit (packages/server)
- npx vitest run <affected test paths> (packages/server)
- node scripts/check-gates.mjs
- Manual: create artifact >500 chars -> list -> apply; retention tick; socket run without env DB.

## Docs sync checklist (AGENTS.md §6)
- re-docs/Backend Docs/Domain Spec/Artifacts.md: Ports (remove listByRunAndType mention; writeFile/purge/retention consumers), Relations, Gaps resolution.
- re-docs/Backend Docs/Feature and Flow Spec/Artifacts and retention.md: scheduling owner, client apply flow.
- Any gate-shape change -> Ports table + _index.md check.

## Out of scope / not performed
- No production edits, no branch, no commits. Docs noted, not modified. Full worker/listener subscription scan and client store exhaustive trace marked Low-confidence where noted in inventory.md.
