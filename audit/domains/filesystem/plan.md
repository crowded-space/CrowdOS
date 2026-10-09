# Filesystem Domain — Fix Plan (incremental; READ-ONLY audit deliverable)

## Rewrite decision: INCREMENTAL (no rewrite)
The domain is small (451 lines src), cohesive, and the facade is exactly the AGENTS.md §2 shape (thin wire + re-export, gate-to-gate clean, check-gates 0 violations). Security-critical path-guard logic is sound and heavily commented; all defects are localized (list() error tolerance, binary truncation signal, dead onEvent surface, test gaps). A rewrite would re-open the realpath/containment core with zero test coverage gain. Fix forward; no facade contract change required.

## Ordered fix plan
1. FS-001 list() per-entry tolerance (local-filesystem.ts:171). Wrap the batch stat in try/catch; on failure emit a placeholder node (type from dirent, size 0) or skip. Compat: strictly widens behavior (dir with a broken entry now lists). Tests: G2 unit + route 200 test. Verify: `npx vitest run src/Filesystem`. Rollback: revert the try/catch.
2. FS-010 path-guard test suite (new src/Filesystem/path-guard.test.ts). Pure functions first (isPathSafe matrix incl. "..." / "..foo" / ADS ":" / null / drive), then resolveWorkspacePath with temp roots, symlink escape + missing-ancestor walk (use junctions on Windows to avoid EPERM). Verify: suite green on win32.
3. FS-002 readBinary truncation signal (local-filesystem.ts:100-112). Preferred: return `{ data, truncated, size }` (type-only widening; no in-repo callers so compat risk ~0) or throw typed error; add boundary tests (G3). Decide with user if shape change preferred over marker append.
4. FS-003 onEvent decision (local-filesystem.ts:25). Either wire at construction sites (routes/filesystem.ts:21-27 + create-app bootstrap) into eventBroker, or delete the option and update the docs (Domain Spec Emits-Listens + Feature doc). User decision required — do not half-wire.
5. FS-004 root cache hardening (path-guard.ts:105). Shorten TTL or add invalidation on mount/root change; optionally revalidate on mutating ops. Tests: symlink-flip probe (G1 extension).
6. FS-006/FS-007 docs+status sync (same task as the code fixes per AGENTS.md §6): fix stale line refs in Domain Spec Flow; resolve the registry-root gap text in the Feature doc; record FS-001/002/003 in Alignment notes.
7. FS-005/FS-008/FS-009 smalls: delete dead index.ts barrel (or document), decide workspace.json write atomicity (temp+rename), trim or annotate unused surface (readBinary/mkdir/stat/exists/rename) — all cheap, do last.
8. G8 stabilize channel-mount-gate.test.ts:379 (warm dynamic import in beforeAll or set per-test timeout) so `npx vitest run src/channel-mounts` is deterministic without flags.

## Docs sync (per AGENTS.md §3/§6 — NOT performed, read-only audit)
When fixes land: re-docs/Backend Docs/Domain Spec/Filesystem.md (Ports if any shape change, Gaps, Decisions, Failure + Resume) + Feature and Flow Spec/Filesystem and metadata mirror.md + _flow-index.md links if renamed; record FS-006 drift notes.

## Migration / rollback
- No schema changes (domain owns no table). No flags needed; each fix is independently revertible. No production edits made in this audit; git untouched except audit/.

## Verify (per fix)
- `npx tsc -p tsconfig.json --noEmit` (packages/server)
- `npx vitest run src/Filesystem` and affected suites (routes/channel-mounts when touched)
- `node scripts/check-gates.mjs`
- AGENTS.md §4: finish → checks → stop → ask user to live review → ask `commit?` (main only; git-crow for push/pull).
