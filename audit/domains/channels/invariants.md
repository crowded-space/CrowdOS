# Channels Domain — Invariants (as implemented, 2026-10-06)

Legend: **Enforced** (code/DB), **Partially** (enforced on some paths), **Broken** (violable today), **Intentional** (documented design choice).

| ID | Invariant | Status | Evidence |
| --- | --- | --- | --- |
| INV-1 | Channel names are unique per (workspace, category, lower(name)) | **Partially** | create: local scan lowercased (channel-local-store.ts:296-304) but PG check compares stored name to lowercased input (channel-service.ts:366-373) and no DB unique index exists (schema.ts:272-291); update: no dup check at all (channel-service.ts:418-485) |
| INV-2 | Category names unique per workspace | **Partially** | local dup throws (channel-local-store.ts:170-177); PG has no unique index; dbOverride path has no dup check (channel-service.ts:119-121) |
| INV-3 | A channel's category belongs to the same workspace | **Broken** | categoryExists is unscoped (channel-service.ts:39-51, 345); a category from ws B satisfies create into ws A |
| INV-4 | No write lands in the default scope without an explicit workspace | **Partially** | createChannel/createCategory fail closed (channel-service.ts:101-106, 348-352); settings writes fall back to "default" on lookup failure (channel-service.ts:512-522) and dbOverride create stores workspaceId null (channel-service.ts:334) |
| INV-5 | `#general` (uncategorized) can never be deleted | **Partially** | delete guard keys on name (channel-service.ts:582,594); rename to another name then delete destroys it (CHN-028); nested general deletable by design |
| INV-6 | Archived channels are hidden from `list` | **Enforced** | channel-service.ts:274,290; local-store.ts:246 |
| INV-7 | Archived channels remain readable via `get` | **Intentional** | channel-service.ts:409-416; documented in Channels.md |
| INV-8 | `list`/merge ordering is (position asc, id asc) with keyset cursor | **Enforced** | channel-service.ts:222-242, 271-281 |
| INV-9 | Deleting a category cascades to its channels | **Partially** | PG txn (channel-service.ts:188-216); local cascade (channel-local-store.ts:222-225) but settings rows and message logs are NOT cascaded locally (CHN-019/CHN-031) |
| INV-10 | Local write is the commit point; PG is best-effort replica with outbox | **Enforced** (shared dualWrite) | database.ts dualWrite; but settings bypass dualWrite (CHN-008) and guard-failure unions do not stop the PG leg (CHN-033) |
| INV-11 | Settings key is (channelId, workspaceId) | **Enforced** (PG PK + local scope file) | schema.ts:1056; migration 0020; local-store settingsScope |
| INV-12 | Settings scope resolution never throws | **Enforced** | channel-service.ts:512-522 |
| INV-13 | Reads never 500 on a dead PG | **Enforced** (get/list/categoryExists via pgCatchNull) | channel-service.ts:31-37 |
| INV-14 | Writes surface business failures as unions, not throws | **Partially** | channel ops yes; createCategory dup throws (channel-local-store.ts:176) → route has no try/catch → 500 |
| INV-15 | Routes distinguish duplicate_name from category errors | **Broken** | routes/channels.ts:63-67 maps both to "Category not found: …" (undefined categoryId for duplicates) |
| INV-16 | Channel workspaceId is immutable after create | **Assumed** | message-service.ts:24-26 comment; no writer in update path; not enforced anywhere |
| INV-17 | Positions have no uniqueness/reorder helper; concurrent default-0 creates are unordered | **Intentional** | docs Gaps; sort tiebreak by id keeps listing stable |
| INV-18 | All domain writes go through the gate (no cross-domain past-gate imports) | **Broken (allowlisted)** | routes/workspace.ts:274-278 dynamic-imports channel-local-store; KNOWN_VIOLATIONS in scripts/check-gates.mjs |
