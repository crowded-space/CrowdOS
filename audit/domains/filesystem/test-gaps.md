# Filesystem Domain — Test Gaps (Phase 4)

## Existing tests
| File | Tests | Covers |
|---|---|---|
| src/Filesystem/entry-visibility.test.ts | 8 | visibility rule (pure), list() filter/order, tree↔picker agreement, hidden-but-addressable |
| src/runtime/runtime-lifecycle.test.ts:555-560 | 1 | facade-shape smoke (createLocalFilesystem/normalizePath/isPathSafe/resolveWorkspacePath/isInsideRoot defined) |
| src/channel-mounts/channel-mount-gate.test.ts:613-637 | 2 | route root-listing shape (scope+nodes) vs bare array below |
| src/workspace/workspace-database-routes.test.ts:59 | — | mocks the gate (LocalFilesystem stub, isInsideRoot re-impl) — mock itself is a maintenance hazard |

## Gaps (ranked)
| # | Gap | Risk | Proposed test |
|---|---|---|---|
| G1 | path-guard has ZERO direct tests (isPathSafe matrix, isInsideRoot win32 fold, resolveWorkspacePath fast path vs ancestor walk, symlink escape rejection, 60s root cache behavior) | High | new path-guard.test.ts (temp dirs + symlink probes; guard against Windows EPERM by skipping or using junctions) |
| G2 | No test that a dangling symlink/junction entry does not break list() (FS-001) | High | unit: seed dangling junction → list() still resolves remaining entries |
| G3 | read/readBinary truncation boundary untested (exactly 1MB, 1MB+1) | Medium | unit: files at 1048576 and 1048577 bytes; assert marker presence/absence |
| G4 | write/mkdir/delete/rename behavior untested at domain level (only exercised indirectly via routes) | Medium | unit: CRUD round-trip incl. ENOENT on delete, rename parent creation |
| G5 | initialize() sector bootstrap untested (seven dirs + workspace.json seed + idempotent re-run + concurrent runs) | Medium | unit: fresh root → assert dirs/json; re-run no-clobber |
| G6 | Route error mapping (404 vs 400 vs 500) partially pinned; traversal/unsafe → 500 not asserted | Low | route tests: ENOENT → 404, "/" content → 400, traversal → current behavior pinned |
| G7 | onEvent emissions untested (updated/deleted/renamed payloads) | Low | unit: capture callbacks, assert normalized paths + metadata |
| G8 | Panel↔tool root agreement for the files route pinned only via channel-mount-gate.test.ts (flaky: needs --testTimeout=20000; default run times out 5s) | Medium | stabilize: warm dynamic import in beforeAll or raise per-test timeout in that file |

## Commands + results (this audit, read-only)
- `npx tsc -p tsconfig.json --noEmit` (packages/server) → EXIT 0, no output.
- `npx vitest run src/Filesystem` → 1 file, 8 passed, EXIT 0.
- `npx vitest run src/channel-mounts/channel-mount-gate.test.ts` → 1 failed (timeout 5000ms at :379 panel/tool agreement), 44 passed, EXIT 1; rerun with `--testTimeout=20000` → 45 passed, EXIT 0 (flake, not a Filesystem-domain failure).
- `node scripts/check-gates.mjs` → EXIT 0; 361 files / 23 domains, 0 violations; TEST-ONLY findings include `Filesystem/entry-visibility.test.ts -> ../workspace/workspace-registry.js` (non-fatal, §2: route via workspace-gate).
- Live probes: isPathSafe matrix (see invariants.md); list() dangling-junction repro (FS-001).
