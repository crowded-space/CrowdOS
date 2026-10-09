# dom-db — PLAN (post-audit)

## Small, reviewable fixes proposed (no code changed yet; awaiting approval)
1. DB-001: fail fast in backfill-encrypt-secrets --apply when CREDENTIALS_ENCRYPTION_KEY is unset (no false 'encrypted' report).
2. DB-002: make check.ts self-sufficient — insert-if-missing workspaces row 'default' before the probe.
3. DB-012: set process.exitCode=1 in create-workspace-crowdos catch.
4. DB-003: annotate legacy ensureSchema messages_channel_sequence_idx (or gate LEGACY_BOOTSTRAP path) to stop re-breaking 0025; deletion of the legacy path is the cleaner follow-up.

## Needs explicit approval (schema/tooling/behavior)
- DB-004: drop approval_requests.scope_hash + index via new migration.
- DB-005: regenerate drizzle snapshots / add consistency check.
- DB-007: seed workspace scoping.
- DB-009: wire or delete check-single-db.mjs.

## Docs sync (same task as any code change)
- re-docs/Backend Docs/Domain Spec/: no db domain doc exists (no gate). Add a db section to _index.md when the area gets a gate; until then record audit notes here.
- re-docs/Backend Docs/Feature and Flow Spec/: update 'Workspace provisioning flow' if DB-002/DB-012 fix lands; 'API-key auth and roles' if DB-001 fix lands.

