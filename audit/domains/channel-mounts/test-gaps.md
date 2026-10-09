# ChannelMounts Domain - Test Gaps (read-only audit, 2026-10-06)

## Baseline (Phase 4)
- Typecheck: `npx tsc -p tsconfig.json --noEmit` (packages/server) -> EXIT 0 (clean).
- Unit: `npx vitest run src/channel-mounts/channel-mount-gate.test.ts src/channel-mounts/channel-mount-chain.test.ts` -> 2 files, 55 tests, ALL PASS (7.81s).
- Adjacent: `npx vitest run src/routes/index.test.ts src/Filesystem/entry-visibility.test.ts src/channels/channel-local-mode.test.ts` -> 3 files, 16 tests, ALL PASS (15.43s).
- Lint: `node scripts/check-gates.mjs` (packages/server) -> 0 production violations; 46 TEST-ONLY findings (non-fatal); 3 allowlisted pre-existing violations elsewhere. channel-mounts test findings: channel-local-mode.test.ts:25 -> channel-mount-service.js; channel-mount-gate.test.ts:21,24 -> workspace-registry.js (x3), :86 -> tool-registry.js (x2); channel-mount-chain.test.ts:13,15 -> workspace-registry.js/workspace-runtime.js.
- No production file modified; audit/ is the only write. Branch main; tree dirty pre-existing.

## Gaps (no new tests written per instructions)
| # | Gap | Risk (CM id) | Suggested test |
| --- | --- | --- | --- |
| T1 | PG tier entirely untested: resolveWorkspaceMount metadata.customMountPath branch, attachWorkspaceMount PG write, dualWrite replica, isConnectionError fallback | CM-001, CM-006, CM-013 | PG-gated integration: attach (PG tier) -> resolve -> assert; set DATABASE_URL empty -> assert mount invisible (documents CM-001); concurrent attaches |
| T2 | Tier switch / split-brain: mount stored in registry mountPath, then DATABASE_URL configured (and inverse) | CM-001 | Characterization: attach local, flip env flag, resolve -> documents "invisible mount" behavior |
| T3 | Jail fail-open on registry read failure (corrupt registry / unreadable file) | CM-002 | Corrupt workspaces.json (invalid JSON) with record.allowedMountRoots narrow; assert allowedRoots widens to [sandbox, home] today (pin the bug) |
| T4 | vfs refusal beyond depth 4 | CM-004 | Fixture <ws>/vfs/a/b/c/d/e; validate(deep path) -> currently valid; assert refusal after fix |
| T5 | No ownership check: PUT /api/workspaces/:id/mount with another workspace's id | CM-003 | Route test with x-workspace-id: ws-A targeting ws-B; assert current behavior (no check) and desired 403 |
| T6 | Concurrent attachWorkspace (same ws) local tier: cached record wholesale write / lost update | CM-006 | Two parallel attachWorkspace calls with different fields; assert no field reversion after fix |
| T7 | setEffectiveMounts unknown channelId/categoryId + workspaceId -> silently writes workspace set | CM-008 | Call setEffectiveMounts({workspaceId, channelId:'missing', mounts}); assert current fallthrough then desired error |
| T8 | scope() with channelId only: workspaceRoot = sandbox base | CM-009 | scope({channelId}) -> assert workspaceRoot equals channel's workspace Zone A after fix |
| T9 | Socket fan-out of category:mount-updated with null workspaceId | CM-017 | Broker emit with payload.workspaceId null; assert it does not reach unrelated workspace rooms after fix |
| T10 | Slash round-trip win32: attach local (forward slashes) vs PG (native) | CM-010 | win32-only round-trip test for both tiers |
| T11 | browse with huge directory: readdir before 300 cap | CM-011 | Perf/behavior test with >10k entries; assert bounded work after fix |
| T12 | resolveChannelMount: channel.workspaceId null but category.workspaceId set -> workspace fallback skipped | CM-020 | Fixture with null-workspace channel + category; assert workspace mount of category's workspace is consulted after fix |
| T13 | Error-cause preservation in attach/setEffectiveMounts (swallowed .catch) | CM-007 | Store failure injection; assert error message distinguishes not-found vs store failure |
| T14 | Canon virtual mounts have no transport: no route/socket exposes effectiveMounts/setEffectiveMounts | CM-015 | Decide: add route + contract test, or delete surface |
| T15 | Cross-domain test imports (gate lint TEST-ONLY) | hygiene | Route channel-mounts tests through gates (workspace-gate exports registry test hooks) or accept documented exception |

