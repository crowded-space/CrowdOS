# ChannelMounts Domain - Phase 7 Plan Proposal (read-only audit output)

Preference: INCREMENTAL FIX, no rewrite. The domain is small (1 service, 1 gate, 2 tests), the facade contract is stable and consumed by four production call sites; a rewrite would re-open the panel/tool drift class the domain was built to close. Target: close the storage split-brain and jail fail-open first (S2), then the rest.

Ordered fix plan (each step = one review-gated task on main, docs synced in the same task per AGENTS.md §6):

P1. Unify workspace mount storage (CM-001, CM-013) - S2
- Files/symbols: channel-mount-service.ts resolveWorkspaceMountFromRecord/resolveWorkspaceMount/attachWorkspaceMount; workspace-gate exports.
- Decision needed (User Decision section): which tier is truth for mountPath? Proposal: registry record.mountPath is the single local truth; PG metadata.customMountPath becomes a mirrored column written via workspace-gate only, with read fallback record -> metadata; add a one-shot migration helper that backfills missing side on read (no destructive move).
- Tests: T1, T2, T13. Compat: facade unchanged. Rollback: revert service + no schema change (metadata already exists). Verify: attach under both tiers resolves; outage attach degrades like read.
- DoD: same workspace id resolves the same mountPath with DATABASE_URL set/unset; docs Ports/Owns updated.

P2. Jail fail-closed on registry read error (CM-002) - S2 security
- Files: channel-mount-service.ts getAllowedRoots; workspace-registry readAllRaw error policy (currently swallows all).
- Fix: distinguish "no record" from "registry unreadable"; on unreadable, do not widen to home - return [sandboxBase] or fail the validate with reason. Keep no-record default as-is.
- Tests: T3. Rollback: revert. DoD: corrupt registry cannot widen a narrow workspace's jail.

P3. vfs refusal depth + robust walk (CM-004) - S2
- Files: channel-mount-service.ts refuseWorkspaceVfs.
- Fix: walk to filesystem root (bounded by root of the candidate's drive) or walk until an allowed root; keep the marker check. Guard against symlinked vfs parents (post-realpath call already exists).
- Tests: T4. DoD: any path under <ws>/vfs/ is refused at any depth.

P4. Ownership check on mount routes (CM-003) - S2 (multi-tenant)
- Files: routes/channel-mounts.ts (compare request.workspaceId / x-workspace-id against target's workspaceId; channel/category lookups via channelGate to resolve owner); possibly shared/auth helper.
- Note: single-user local trust model - confirm intended blast radius before implementing (User Decision).
- Tests: T5. DoD: cross-workspace mount write is 403; same-workspace unaffected.

P5. setEffectiveMounts strictness (CM-008, CM-014) - S3
- Fix: unknown channelId/categoryId -> {ok:false} instead of workspace fallthrough; reject/ignore semantics for mode at workspace level made explicit (or accept "inherit" meaning "clear to default").
- Tests: T7. DoD: no silent write to the wrong level.

P6. Error fidelity (CM-007) + scope.workspaceRoot (CM-009) - S3
- Fix: keep cause in attach/setEffectiveMounts errors; resolveMountScope uses effectiveWorkspaceId (channel's workspace when caller omitted).
- Tests: T8, T13. DoD: messages distinguish not-found/store-failure; scope.workspaceRoot always matches resolved workspace.

P7. Event scoping for null-workspace category (CM-017) - S3
- Fix: routes pass workspaceId option when known; register-socket-server: category events without channelId and without workspaceId should not hit the global fan-out (drop or route to observed scope).
- Tests: T9. DoD: no cross-workspace delivery.

P8. Hygiene batch (CM-010, CM-011, CM-012, CM-015, CM-016, CM-018) - S3
- Remove pick-folder-win32.ps1 + pickFolderSchema dead code (or wire transport for canon mounts first); normalize slashes for PG tier too; browse cap before map/sort where possible; docs line-number refresh; decide canon mounts transport or removal.
- Tests: T10, T11, T14. DoD: no dead assets; docs cite current lines.

Explicitly NOT planned: rewrite of resolvers, changes to facade shape, changes to precedence or the clear-without-validate detach rule (all intentional per docs and tests).

Docs to sync when P1-P8 land: re-docs/Backend Docs/Domain Spec/ChannelMounts.md (Ports/Relations/Owns/Gaps), Feature and Flow Spec/Mount resolution flow.md + Channel mounts.md, _flow-index.md if links change, Backend _index.md if gate moves (it does not).

