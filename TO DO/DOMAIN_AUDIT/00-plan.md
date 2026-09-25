# Backend Domain Audit — Plan

**Status:** PLAN ONLY. Not executed. No code, no docs, no commits change until this plan is approved.
**Scope:** `packages/server/src` — every backend domain, one by one, in batches of 5.
**Date:** 2026-09-25

---

## 0. Guardrails (bind this audit to AGENTS.md)

| Rule | How it applies here |
|---|---|
| §4 Git | Work stays on `main`. **No branch, ever.** Pre-flight blocks on the dirty tree (below). No auto pull/rebase/stash. No commit unless the user says `commit?` → yes. |
| §5 Routing | Audit = research task → `flash` subagents. Later fixes = `inherit`. |
| §6 Docs sync | Audit is read-only, so no doc sync fires. Each **fix** task must carry its Domain Spec / Feature+Flow doc update in the same task. |
| §2 Gate rule | The audit's job is to *find* boundary violations (including the two allowlisted ones), not to fix them. |
| §1 Naming | Any fix later: new files `kebab-case`, `*.tsx` PascalCase, types camelCase. Existing camelCase frozen; renames only via codemod, never inside feature work. |

### 0.1 Pre-flight (must pass before Batch 1)

1. **Dirty-tree gate.** `main` is currently dirty: 11 modified + 1 untracked (`agents/*`, `modules/*`, `routes/agents.ts`, `routes/modules.ts`, client store + WorkspaceSettingsModal), and `main` is **ahead of origin by 6**. Per §4 → stop and ask the user first: commit / continue dirty / park. No auto-resolve.
2. **Baseline capture** (record pass/fail so findings can be tagged *pre-existing* vs *new*):
   `npm run typecheck` · `npm run lint:gates --workspace @crowdspace/server` · `npm test` · `npm run db:check --workspace @crowdspace/server`.
3. **Baseline artifacts** to diff against, so we never re-report settled items: `TO DO/AUDIT_REPORT.md` (V1), `AUDIT_REPORT_2026-08-26.md` (V2), `REMEDIATION_SPEC.md` (status matrix), `re-docs/QA/qa-journal.md`, `QA_AUDIT_ELECTRON_2026-09-23.md`, `Workspace Flow Audit.md`, `re-docs/Backend Docs/_index.md` + `_flow-index.md`.

---

## 1. Backend domain inventory — 30 audit units

24 gated folders, 26 gate files. `runtime/` is split into 3 units (Runtime / Context / Providers) because it is 43 files and 6.4k lines. Ungated surfaces (`routes`, `shared/sockets`, `shared/core`, `db`, `types`, `shared/config`, orphan `core/`) are audited too — they are where the gates cannot protect anything.

| # | Unit | Folder(s) | Gate(s) | Code files / lines | Tests | Doc | Batch |
|---|---|---|---:|---:|---:|---|---|
| 1 | Agents | `agents/` | `agent-gate.ts` | 7 / 1292 | 2 | `Domain Spec/Agents.md` | 1 |
| 2 | Modules | `modules/` | `module-gate.ts` | 5 / 1195 | 1 | `Modules.md` | 1 |
| 3 | Skills | `skills/` | `skills-gate.ts` | 7 / 682 | 1 | `Skills.md` | 1 |
| 4 | Capabilities | `capabilities/` | `capabilities-gate.ts` | 4 / 495 | 2 | `Capabilities.md` | 1 |
| 5 | Tools | `tools/` | `tools-gate.ts` | 9 / 3091 | 10 | `Tools.md` | 1 |
| 6 | Channels | `channels/` | `channel-gate.ts` | 5 / 1124 | 2 | `Channels.md` (⚠ drifting) | 2 |
| 7 | Messages | `messages/` | `message-gate.ts` | 5 / 656 | 1 | `Messages.md` | 2 |
| 8 | Threads | `threads/` | `thread-gate.ts` | 3 / 197 | **0** | `Threads.md` | 2 |
| 9 | ChannelMounts | `channel-mounts/` | `channel-mount-gate.ts` | 3 / 795 | 2 | `ChannelMounts.md` | 2 |
| 10 | Filesystem | `Filesystem/` | `filesystem-gate.ts` | 6 / 453 | 1 | `Filesystem.md` | 2 |
| 11 | Runtime | `runtime/` (executor, router, runtimes, lifecycle) | `runtime-gate.ts` | ~20 / ~3400 | many | `Runtime.md` | 3 |
| 12 | Context | `runtime/kernel/` | `context-gate.ts` | 25 / 1800 | 9 | `Context.md` (index says `Runtime/Context.md` ⚠) | 3 |
| 13 | Providers | `runtime/providers/` | *(via runtime-gate)* | 13 / 1496 | 2 | `Runtime.md` | 3 |
| 14 | State | `state/` | `state-gate.ts` | 1 / 53 | **0** | `State.md` | 3 |
| 15 | SearchProviders | `search-providers/` | `search-provider-gate.ts` | 5 / 475 | 1 | `SearchProviders.md` | 3 |
| 16 | Runs | `runs/` | `runs-gate.ts` | 4 / 583 | 4 | `Runs.md` | 4 |
| 17 | Queue | `queue/` | `queue-gate.ts` | 7 / 983 | 2 | `Queue.md` | 4 |
| 18 | Approvals | `approvals/` | `approval-gate.ts` | 4 / 437 | 2 | `Approvals.md` | 4 |
| 19 | Swarm | `swarm/` | `swarm-gate.ts` | 10 / 1629 | 7 | `Swarm.md` | 4 |
| 20 | Events | `events/` | `events-gate.ts` | 5 / 459 | 3 | `Events.md` | 4 |
| 21 | Workspace | `workspace/` | `workspace-gate.ts` (⚠ migrate) | 8 / 1717 | 5 | `Workspace.md` | 5 |
| 22 | Memories | `memories/` | `memories-gate.ts` | 10 / 2167 | 3 | `Memories.md` | 5 |
| 23 | Artifacts | `artifacts/` | `artifacts-gate.ts` | 3 / 228 | 1 | `Artifacts.md` | 5 |
| 24 | Observability | `observability/` | `observability-gate.ts` | 3 / 518 | 1 | `Observability.md` | 5 |
| 25 | EventBroker | `event-broker/` | `event-broker-gate.ts` | 4 / 315 | **0** | `EventBroker.md` | 5 |
| 26 | Auth & Pin | `shared/auth/` | `auth-gate.ts`, `pin-gate.ts` | 4 / 632 | 1 | `Auth/Pin.md` (⚠ migrate) | 6 |
| 27 | Routes (HTTP) | `routes/` | *none* | 29 / 3559 | 3 | *uncovered* | 6 |
| 28 | Sockets (realtime) | `shared/sockets/` | *none* | 5 / 1349 | 1 | *uncovered* | 6 |
| 29 | Shared core & orphans | `shared/core/` + orphan `core/` | *none* | 51 / 4576 | 14 | *uncovered* | 6 |
| 30 | Foundations | `db/`, `types/`, `shared/config/` | *none* | 18 / 2917 | 4 | `02-database-schema.md` | 6 |

**Total:** ~268 files, ~39k lines of backend TypeScript, 102 test files.

---

## 2. What "strictly one by one" means

Each unit gets a **standalone pass** over: its gate + all internals + its Domain Spec doc + its Feature/Flow doc + every consumer that imports it. No unit inherits another unit's conclusions. A cross-domain finding is written into **both** unit reports and linked in the findings index — never resolved once and skipped elsewhere.

## 3. Per-unit checklist (fixed 9 sections — same order, every unit)

| # | Section | What is checked |
|---|---|---|
| A | **Boundary & gate conformance** | Gate purity (AGENTS.md §2: no logic/fetch/DB/branching in gate — flag any gate >100 lines as suspect: `pin-gate` 282, `auth-gate` 207, `search-provider-gate` 194, `module-gate` 190). Exports = contract only. Nothing outside the folder imports past the gate (incl. the 2 allowlisted violations). Gate↔gate cycles (today: 0 gate→gate edges; `state-gate` imports 3 gates — is State a real domain or a misplaced orchestration shim?). Missing gates on ungated surfaces. |
| B | **Doc ↔ code conformance** | `Ports` section must equal gate exports exactly (code is truth). `Expect`/`Flow` line references still valid. `_index.md` status vs reality (`draft`/`migrate`/`uncovered`). `_flow-index.md` status (`Channels and archive.md` = drifting). Folder/file naming vs §1 (case: `Filesystem/`, `workspace/`). |
| C | **Correctness & state machines** | Status transitions, idempotency, null/undefined paths, cursor & pagination math, transaction boundaries, ordering assumptions, duplicate-key races, silent fallbacks that change semantics. |
| D | **Failure, recovery, cancellation** | Timeouts, retries, abort propagation, partial writes, orphan/zombie states, resume paths, checkpoint/compensation correctness, "what happens on process kill mid-operation". |
| E | **Security & isolation** | Authz per entry point (route/socket/tool), tenant/workspace scoping on every read+write, secret handling/redaction, path traversal, command injection, SSRF, prompt-injection surfaces, untrusted-input wrapping. |
| F | **Performance & scale** | N+1 queries, serial awaits that could batch, unbounded result sets, cache correctness **and invalidation**, memory growth (maps/arrays/event buffers), hot-path DB round trips. |
| G | **Observability & operability** | Spans, cost/usage accounting honesty, structured logs (no `console.*` leaks), metrics, feature flags + safe fallbacks, graceful shutdown, drain. |
| H | **Test coverage & gaps** | Existing tests: do they assert behavior or just smoke? Missing contract tests at the gate. Zero-test units flagged: `threads`, `state`, `event-broker`. Cross-domain tests must go through gates. |
| I | **Improvement candidates** | Ranked, each with: blast radius (files + docs), effort (S/M/L), risk, and whether it needs a new domain. |

## 4. Evidence & severity protocol

**Tags** (match the existing audit vocabulary): `Observed` · `Inferred` · `Missing` · `Broken` · `Risk` · `Opportunity`.

**Every finding carries:** ID (`AG-01`, `MOD-03`…) · tag · severity · `file:line` · impact · checklist section (A–I) · status vs prior audits (`New` / `Regression` / `Still-open` / `Fixed-since`) · proposed fix (one line).

**Severity:**
- **P0** — data loss, security hole, or wrong results in normal use.
- **P1** — broken flow, reliability failure under load/crash, or isolation breach in a narrow path.
- **P2** — perf/quality/maintainability with real cost.
- **P3** — cosmetic, naming, doc-only.

**Falsification step (mandatory):** before a finding is written, grep the prior audits + `REMEDIATION_SPEC.md` traceability matrix for that item. A finding that is already `FIXED` must be re-verified or dropped.

**"No finding" is allowed** — but the unit report must list what was checked and found clean.

**Anti-hallucination:** no finding survives without a `file:line` the verifier opened. Unverifiable claims are downgraded to `Inferred` or deleted.

---

## 5. Batch plan — 6 batches × 5 units

One batch per session. Within a batch, the 5 units run **in parallel** (one `flash` research subagent per unit); the main thread then verifies and writes the batch report.

### Batch 1 — Identity & Catalog
`Agents` · `Modules` · `Skills` · `Capabilities` · `Tools`
Focus questions: module-ref validation and the local-first fallback path (`instr-default`/`model-default` seeding, stale preset ids — QA F23/F23a); skill resolution + cache invalidation on toolkit/permission change; capability manifest merge; tool authorization (ToolkitModule union) and Guard coverage vs the deny/ASK lists; gate purity of the 190-line `module-gate`.

### Batch 2 — Conversation & Storage
`Channels` · `Messages` · `Threads` · `ChannelMounts` · `Filesystem`
Focus: sequence numbers and cursor pagination (`parseBeforeCursor`, `MalformedCursorError`); archive/restore; tenant scoping end-to-end; mount resolution precedence and `effectivePath`; path traversal / sandbox escape; listing-cache invalidation; the `Filesystem` PascalCase `migrate` status; `Channels` drifting doc.

### Batch 3 — Execution Core
`Runtime` · `Context` · `Providers` · `State` · `SearchProviders`
Focus: router/executor contract and runtime flavor honesty (chat/agentic/coding/research/swarm); cancellation & resume; context pipeline ordering, parallelism, dedup, token cap enforcement; provider streaming parity + error mapping + usage parsing; whether `state-gate` (53 lines, 0 tests, imports 3 gates) is a real domain or a shim; search fan-out timeouts, dedupe, `url-guard` SSRF.

### Batch 4 — Durable Execution & Delegation
`Runs` · `Queue` · `Approvals` · `Swarm` · `Events`
Focus: run state machine completeness (the 7/22 states finding — verify current); checkpoint + compensation journal correctness; queue dedupe `jobId`, retries, lock renewal/heartbeat, phantom-row risk on provisional ids; orphan sweeps (`orphan-sweep`, `orphan-resume`); approval expiry races; swarm DAG/lease/delegation (is `SwarmRuntime` real or an alias — verify against the audit claim); event ordering, durability, replay, retention.

### Batch 5 — Platform, Memory & Trust
`Workspace` · `Memories` · `Artifacts` · `Observability` · `EventBroker`
Focus: provisioning + tenant boundary; embedding/retrieval isolation (visibility matrix, memory sharing policy); artifact retention sweeps; span + cost accounting honesty (fake/unrecorded usage); broker fan-out, rooms, `workspace:default` mirror leak, replay; EventBroker has the **highest fan-in (15 consumers) with 0 tests** — highest-risk/lowest-coverage unit.

### Batch 6 — Surfaces, Auth & Foundations
`Auth & Pin` · `Routes` · `Sockets` · `Shared core & orphans` · `DB & types & config`
Focus: auth enforcement per route/socket (AUTH_STRICT on/off behavior), pin throttling, rate limiter, room keys; Zod validation coverage and error leakage (raw SQL strings reaching the UI — QA F26); the socket handler as a god-object; orphan `core/` (577 lines, 0 importers); schema/index correctness, migration drift, single-DB guard, config flags + safe fallbacks.

---

## 6. Deliverables

```
TO DO/DOMAIN_AUDIT/
  00-plan.md              ← this file
  01-methodology.md       ← checklist, tags, severity, evidence rules (frozen at Batch 1)
  batch-1-identity-catalog.md
  batch-2-conversation-storage.md
  batch-3-execution-core.md
  batch-4-durable-execution.md
  batch-5-platform-memory-trust.md
  batch-6-surfaces-auth-foundations.md
  findings-index.md       ← every finding, deduped, IDs, severity, status vs prior audits
  fix-program.md          ← prioritized fix batches; each lists its mandatory §6 doc sync
```

Each `batch-N` file contains 5 unit reports (9 sections each) + a batch synthesis (cross-cutting findings, dependency notes, and anything that should reorder later batches).

## 7. Execution mechanics

1. Pre-flight (§0.1) → ask user about the dirty tree.
2. Batch N: spawn 5 unit subagents in parallel → collect reports.
3. **Verification pass (main thread):** re-open every `file:line` for all P0/P1 findings and ≥20% of P2s. Downgrade or delete anything unverifiable.
4. Write `batch-N` report; append to `findings-index.md`.
5. User checkpoint (optional): user can stop, reprioritize, or skip a batch.
6. Batch N+1.
7. After Batch 6: write `fix-program.md` and stop. Fixes are a separate program, each fix task carrying its doc sync.

**Stop conditions:** any P0 security/data-loss finding → pause and report immediately, do not continue the batch silently. Any unit that reveals the audit itself is blocked (missing DB, unreachable service) → mark `blocked`, continue the other 4, report.

**Effort:** 30–60 min per unit, ~1 batch per working session, ~6 sessions total.

## 8. Out of scope

- No fixes, no renames, no codemods, no refactors. Findings only.
- No frontend/desktop domain audit (separate docs exist); only their *contract* with backend is checked (routes/sockets payloads).
- `packages/pi-core` internals — only the boundary via `runtime/bridges/` (`pi-tool-bridge`, `pi-event-bridge`).
- Load testing (k6) — only invoked if a finding needs a number to be credible.
- Docs other than the audit reports are not edited during the audit.

## 9. Success criteria

- 30/30 units have a completed 9-section report.
- Every P0/P1 has a verified `file:line` + repro or code trace.
- Each unit's doc `Ports` section matches its gate exports exactly (code is truth).
- Findings index deduped; each finding mapped to a fix batch or explicitly accepted as `won't fix`.
- Known drift surfaced, not hidden: `Channels` drifting status, `migrate` rows (`Workspace`, `Auth/Pin`, `Filesystem`), the 2 allowlisted gate violations, orphan `core/`.

---

## Appendix A — Recon leads (seeded hypotheses to verify or discard)

Cheap, evidence-backed starting points found while sizing this plan. **Not findings** — each must be confirmed or killed by the owning unit.

| # | Lead | Evidence | Owning unit |
|---|---|---|---|
| L1 | Orphan code: `core/memory-builder.ts` + `core/prompt-formatter.ts` (577 lines) have no importer outside `core/` | repo-wide grep: only `memory-builder → prompt-formatter` self-import | 29 |
| L2 | Gate purity risk: 4 gates exceed 100 lines | `pin-gate` 282, `auth-gate` 207, `search-provider-gate` 194, `module-gate` 190 | 26, 15, 2 |
| L3 | `state-gate` imports 3 gates (`runs`, `messages`, `event-broker`) at 53 lines / 0 tests — real domain or shim? | `state/state-gate.ts` | 14 |
| L4 | Allowlisted gate violations still live | `create-app.ts → ./approvals/approval-sweeper.js` (gate→sweeper→gate cycle); `swarm-runtime.ts → ../../swarm/swarm-worker-resolver.js` | 18, 19 |
| L5 | Highest fan-in / zero tests: `event-broker-gate` (15 consumers, 0 test files) | gate-consumer scan | 25 |
| L6 | Zero-test units: `threads` (197 lines), `state` (53), `event-broker` (315) | test scan | 8, 14, 25 |
| L7 | Index/doc path drift: `_index.md` points to `Runtime/Context.md`, folder has `Context.md`; `_flow-index.md` marks `Channels and archive.md` drifting | `re-docs/Backend Docs/` | 12, 6 |
| L8 | Naming/migrate drift: `Filesystem/` (PascalCase), `workspace/` (kebab) vs §1 | folder scan | 10, 21 |
| L9 | Ungated surfaces carry the biggest untested mass: `routes/` 3559 lines / 3 tests, `shared/sockets/` 1349 / 1, `shared/core/` 3999 / 14 | line + test scan | 27, 28, 29 |
| L10 | Static-hygiene hotspots measured per domain: `as any`/`@ts-ignore` (runtime 52, routes 45, channels 21, tools 15, modules 12, memories 11, swarm 11), `console.*` outside structured logging (shared 60, runtime 32, queue 31, tools 23), `Date.now()` used as id/order (db 38, shared 21, tools 19), hardcoded `C:/Users` paths, empty catches | pattern scan | all |

## Appendix B — Coverage baseline (for prioritization)

| Unit | Files | Lines | Tests | Gate lines | Risk signal |
|---|---:|---:|---:|---:|---|
| Runtime | ~20 | ~3400 | many | 138 | largest surface |
| Context | 25 | 1800 | 9 | 15 | 9 tests but gate is 15 lines |
| Providers | 13 | 1496 | 2 | — | 5 adapters, 2 tests |
| Tools | 9 | 3091 | 10 | 42 | security-critical |
| Memories | 10 | 2167 | 3 | 112 | gate >100 lines |
| Swarm | 10 | 1629 | 7 | 84 | |
| Workspace | 8 | 1717 | 5 | 136 | `migrate` status |
| Queue | 7 | 983 | 2 | 99 | durability-critical |
| Agents | 7 | 1292 | 2 | 61 | |
| Modules | 5 | 1195 | 1 | 190 | gate >100 lines |
| Channels | 5 | 1124 | 2 | 74 | doc drifting |
| Messages | 5 | 656 | 1 | 26 | |
| Skills | 7 | 682 | 1 | 58 | |
| SearchProviders | 5 | 475 | 1 | 194 | gate >100 lines |
| Runs | 4 | 583 | 4 | 135 | gate >100 lines |
| Approvals | 4 | 437 | 2 | 89 | |
| Events | 5 | 459 | 3 | 55 | |
| ChannelMounts | 3 | 795 | 2 | 57 | |
| Capabilities | 4 | 495 | 2 | 44 | |
| Observability | 3 | 518 | 1 | 27 | |
| Filesystem | 6 | 453 | 1 | 28 | `migrate` status |
| Artifacts | 3 | 228 | 1 | 16 | |
| EventBroker | 4 | 315 | **0** | 16 | fan-in 15 |
| Threads | 3 | 197 | **0** | 25 | |
| State | 1 | 53 | **0** | 58 | 3 gate imports |
| Auth & Pin | 4 | 632 | 1 | 207 + 282 | gates >100 lines |
| Routes | 29 | 3559 | 3 | — | no gate |
| Sockets | 5 | 1349 | 1 | — | no gate |
| Shared core & orphans | 51 | 4576 | 14 | — | no gate, orphan code |
| Foundations (db/types/config) | 18 | 2917 | 4 | — | no gate |
