# Backend Domain Audit — Batch 2 (Conversation & Storage)
**Date:** 2026-09-25 · **Status:** COMPLETE — fixes applied, verification green · **Tree:** uncommitted, awaiting user review/commit (AGENTS.md §4)

Order audited: Channels → Messages → Threads → ChannelMounts → Filesystem.
User approved: continue to Batch 2 on the same uncommitted tree.

## Verification
- `npx vitest run` (packages/server): **95 files / 760 tests passed**, 0 failures (1 new Channels regression test added).
- `npm run typecheck`: clean.
- `npm run lint:gates`: 0 violations (2 pre-existing allowlisted items unchanged).
- Note: one 5s auth-test timeout flake under full-suite parallel load triggered the deeper Auth O(1) fix below; passes consistently after.

## 1) Channels — 2 fixes + 1 regression test
- **P1 (tenant)** Duplicate-name guard scanned ALL workspaces: a null-category channel named "general" in ws-a blocked creating one in ws-b. FIXED: guard scoped to the resolved workspace on both tiers (local scan + PG `workspaceId = ws`).
- **P1 (tenant)** `GET /api/channels` for a registry-only (local-tier) workspace ignored the x-workspace-id scope and served the default folder's channels. FIXED: `listChannels` accepts a workspace scope on both tiers (PG: scoped + legacy-global rows; local: the workspace's own channels.json); the route threads the tenant header. No header keeps the legacy unscoped read.
- Regression test added: same-name null-category channels in two workspaces both succeed; same workspace still collides; scoped lists return exactly one channel each.
- Docs synced: Channels.md.

## 2) Messages — 1 fix
- **P1 (data misrouting)** `appendMessage`'s PG replica leg always ran on the AMBIENT (global pool) handle via `withTransaction`. For a workspace with its own record database the replica row was written into the WRONG database — and because that write SUCCEEDED, no outbox entry was queued, so the row never reached the owning workspace DB except via manual converge. FIXED: the replica leg resolves the workspace-record handle (workspace-gate `getWorkspaceDb`) and falls back to the ambient handle only when none resolves (local-only path never reaches the replica leg).
- Docs synced: Messages.md. Verified by `src/messages` + `src/events` (20 tests), full suite.

## 3) Threads — 2 fixes (domain was 0-test; PG-only by design with the local-mode guard not yet covering it)
- **P1 (state machine)** Duplicate threads per parent message: `createThread` fetched the existing thread anchored to the parent and then VOIDED it (`void existingThread`), so every call minted a second thread on the same parent. FIXED: returns the existing thread idempotently with `created: false` — implementing the comment's stated intent ("inherit root").
- **P1 (state machine)** `POST /api/threads/:id/messages` accepted messages into archived/expired threads, silently resurrecting them (bumping `lastActivityAt`). FIXED: route returns 409 for non-active threads; `incrementThreadMessageCount` additionally filters `status = 'active'` so no caller path can advance a dead thread's counters.
- Docs synced: Threads.md. Remaining uncertainty: threads has no domain tests (pre-existing zero-test unit; heavy fake-db infra would be needed — documented, not added this batch).

## 4) ChannelMounts — 1 fix
- **P2 (contract laxity)** `setEffectiveMounts` accepted `mode: "default"` for channel/category levels; the resolver only honors `override` below workspace, so such writes were stored-but-ignored dead data. FIXED: refused with `{ ok: false }`.
- Docs synced: ChannelMounts.md. Verified by `src/channel-mounts` (55 tests), full suite.

## 5) Filesystem — no code changes
- **No correctness bugs found.** Path guard (traversal/symlink/anchored containment), 1MB read cap, shared entry-visibility rule, and bounded-concurrency listing all verified; `entry-visibility.test.ts` (8 tests) + full suite green.
- Known items left documented: folder naming (`Filesystem/` PascalCase) is a migrate-status item requiring a codemod (AGENTS.md §1 forbids mixing renames into feature work); `read()` truncation assumes utf8 (documented cap).

## Cross-domain fix surfaced during verification
- **P1 (Auth, perf, hardening)** The Batch-1 concurrent-hashing fix still paid N scrypt ops per verification and flaked one 5s test under parallel load. FIXED properly: `createApiKey` now stores `key_hint = sha256(plaintext)` (migration `0023_api_keys_key_hint.sql`, schema mirror, journal entry, local rows), and `verifyKey` selects the single hinted candidate and runs exactly ONE scrypt; rows without a hint (legacy) keep the concurrent full-scan fallback. The hint reveals nothing about a 256-bit random key and scrypt still confirms every match. Auth.md updated.

## Docs synced (AGENTS.md §6)
Channels.md · Messages.md · Threads.md · ChannelMounts.md · Auth.md

## Stopping point
Batch 2 complete (5/5 domains audited, fixed, verified). Awaiting explicit instruction to continue with Batch 3 (Runtime · Context · Providers · State · SearchProviders).

