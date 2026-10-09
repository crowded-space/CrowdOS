# ChannelMounts Domain - Invariants (read-only audit, 2026-10-06)

Status legend: [Holds] verified in code+tests; [Holds*] holds except noted condition; [Violated] see CM id; [Intentional] documented behavior.

1. [Holds] Resolvers never throw on unknown ids or unusable mounts; they return a value with source in {channel,category,workspace,none}. Evidence: channel-mount-service.ts:342-343,403-404,161-179; tests channel-mount-gate.test.ts:310-354, routes/index.test.ts:22-30.
2. [Holds] Precedence channel > category > workspace; an invalid level falls through; the FIRST configured-but-unusable reason is preserved. Evidence: service:358-398; tests :254-339.
3. [Holds] validateMountPath never throws for bad input; returns {valid,resolved?,error?} with the pinned strings: Path required / Invalid path / Path does not exist / Path is not a directory / Path outside allowed roots: <roots> / vfs message. Evidence: service:86-132; tests :157-229.
4. [Holds] Containment = realpath(candidate) under some allowed root, win32-normalized (lowercase, \\?\ strip, sep trim), checked AFTER the vfs refusal. Evidence: service:114-131,68-84.
5. [Holds*] vfs/ is never a mount target when it carries workspace markers (.crowdos or sibling workspace.json) - BUT the upward walk is depth-limited to 4, so a target 5+ levels below <ws>/vfs/ evades the refusal (CM-004). Evidence: service:141-159.
6. [Holds] Clear (null/empty) attach never validates and clears when the row exists; detach succeeds even when the old path is gone. Evidence: service:300-306,321-327,440-445,457-460; tests :484-494.
7. [Holds] attachWorkspaceMount writes Zone B only (record.mountPath / metadata.customMountPath); Zone A rootPath is never written. Evidence: service:309-311,322-326; test :465-482.
8. [Holds] effectiveRoot always returns a path: zone "mounted" iff a mount resolved, else zone "workspace-local" with source "workspace-local"; reason is non-null only when a mount was configured but unusable. Evidence: service:233-276; tests :233-345.
9. [Violated] MountScope.workspaceRoot must be the Zone A root of the workspace the scope resolved for - for channelId-only callers it is the sandbox base (input.workspaceId undefined), so workspaceRoot and path can describe different workspaces (CM-009). Evidence: service:283-286 vs workspace-registry.ts:161-163.
10. [Holds] Canon chain: first override wins (channel > category > workspace default); inherit and empty sets are skipped; empty workspace set resolves as none. Evidence: service:581-618; tests channel-mount-chain.test.ts:112-190.
11. [Holds] setEffectiveMounts refuses mode "default" below workspace, drops mounts missing source/target, and surfaces workspace write failure as {ok:false,error}. Evidence: service:644-672; tests :172-227.
12. [Holds*] resolveWorkspaceMount local tier reads record.mountPath only (never rootPath); PG tier reads metadata.customMountPath only - the two tiers are NOT kept in sync, so a tier switch makes existing mounts invisible (CM-001). Evidence: service:161-221,294-338.
13. [Holds*] Jail = record.allowedMountRoots (resolved, blanks dropped) else [sandboxBase, home]; no env read. BUT any registry read failure falls back to the WIDE default (CM-002). Evidence: service:47-66; workspace-registry.ts:237-248; tests :122-155.
14. [Holds] The domain emits no events; routes emit channel/category/workspace:mount-updated only after a successful attach, then re-resolve. Evidence: routes/channel-mounts.ts:50-56,69-74,87-92.
15. [Holds] All production cross-domain access goes through gates (lint: 0 violations, 361 files). Tests bypass (46 non-fatal findings incl. channel-mounts tests importing workspace-registry/tool-registry/service internals). Evidence: check-gates.mjs output 2026-10-06.
16. [Holds] attach persists the validated realpath, never the raw user string; workspace local tier persists forward slashes. Evidence: service:311,334.
17. [Holds] browse is clamped to the jail and dotfile-filtered through the shared isVisibleEntryName rule; 300-entry cap; dirs-first sort. Evidence: service:469-527; entry-visibility.ts:24-30; tests :408-460.
18. [Holds*] Attach/clear operations are replace-semantics and safe to retry, BUT concurrent writers race: local tier writes a possibly stale cached record wholesale (60s TTL) and the PG tier does an unguarded metadata read-modify-write (CM-006).
19. [Holds] Resolver read path degrades on PG connection errors to the registry record (resolveWorkspaceMount), but the WRITE path (attachWorkspaceMount PG branch) has no such fallback and rejects mid-outage (CM-013).

