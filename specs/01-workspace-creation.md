# SPEC 1 — Workspace Creation Rework

## 1. Goal & Non-Goals

### Goal

Replace fragmented workspace creation with **ONE canonical, idempotent creation entry point** owned by the `Workspace` domain and exposed only via `workspaceGate`. All current creation paths (manager, seed, ad-hoc script, VFS self-heal, boot bootstrap) must route through it. Preserve the stable contracts the FS-mount rework will depend on:

* `workspaces.id` / `workspaces.rootPath` / `workspaces.status` shape and semantics.
* `workspace_nodes(workspace_id, path)` unique invariant.
* Guard jail (`resolveWorkspacePath` / `Guard.validatePath`) containment.

### Non-goals

* **No FS-mount implementation in this spec.** Do not replace `LocalVFS` disk I/O here. Only isolate the handoff point so the later FS-mount rework swaps the storage backend without changing the creation contract.
* **No new multi-workspace UX / HTTP CRUD surface beyond what is needed to wire dead methods.** If a creation HTTP endpoint is added, it is a thin validator → gate call only.
* **No status-machine redesign.** Keep `CREATED → INITIALIZING → ACTIVE → PAUSED/TERMINATED → ARCHIVED`. Only enforce it in one place.
* **No permission-model redesign.** Keep `permissions.maxAgents`, `constraints`, `workspace_agents` roster semantics.
* **No migration of existing rows.** No backfill, no `rootPath` rewrite, no enum change.

---

## 2. Current State (verified, with file:line)

> All paths below live under `packages/server/src/`. Line numbers verified by direct read.

### 2.1 `WorkspaceManager.createWorkspace` — canonical logic, zero callers

**File:** `Workspace/workspaceManager.ts:56-112`

Steps:

* `57-59`: `id = ws_<8hex>`, `rootPath = join(sandboxRoot, id)` with backslash → `/` normalization.
* `61-68`: merge `DEFAULT_PERMISSIONS` (`26-30`: `maxAgents: 8`) and `DEFAULT_CONSTRAINTS` (`32-37`).
* `73-84`: `db.insert(workspaces)` with `status: "CREATED"`, `ownerId ?? "human_operator"`.
* `87-90`: transition to `"INITIALIZING"`.
* `93-98`: `new LocalVFS({ workspaceId: id, workspaceRoot: rootPath, actorId }).initialize()`.
* `101-104`: transition to `"ACTIVE"`.
* `107`: `emitEvent(id, "workspace.created", ...)`.
* `109-111`: re-read and return; throw if missing.

Sibling lifecycle / roster methods in the same file:

* `114-120`: `getWorkspace(id)`.
* `122-126`: `listWorkspaces()`.
* `128-151`: `deleteWorkspace(id)` — `ACTIVE|PAUSED → TERMINATED` (`134-139`), `fs.rm(rootPath)` (`142-146`), `db.delete(workspaces)` cascade (`149`).
* `153-180`: `updateWorkspaceStatus(id, status)` — transition table `159-166`:
  `CREATED:[INITIALIZING]`, `INITIALIZING:[ACTIVE]`, `ACTIVE:[PAUSED,TERMINATED]`, `PAUSED:[ACTIVE,TERMINATED]`, `TERMINATED:[ARCHIVED]`, `ARCHIVED:[]`; throws on illegal transition (`168-170`).
* `184-218`: `mountAgent(workspaceId, input)` — requires `ACTIVE` (`188`), enforces `maxAgents` (`194-198`), rejects duplicate `agentId` (`201-204`), inserts `wsa_<8hex>` row (`215`), emits `agent.joined` (`216`).
* `220-232`: `unmountAgent(workspaceId, agentId)`.
* `234-240`: `getAgentSessions(workspaceId)`.
* `244-253`: `getVFS(workspaceId, workspace, actorId)` — `new LocalVFS(...)` with `onEvent → emitEvent`.
* `257-289`: `emitEvent` / `getEvents`.

**Dead-code verification:** repo-wide grep for `new WorkspaceManager` returns **0 hits**. Grep for `createWorkspace|deleteWorkspace|mountAgent` (manager verbs) returns only the definitions in `workspaceManager.ts:56,128,184` plus the unrelated local helper `seed.ts:307` (`const mountAgent = async (agentName) => ...`, not a call to the manager). `updateWorkspaceStatus`, `unmountAgent`, `getAgentSessions`, `getVFS`, `listWorkspaces` likewise have no callers outside the class itself.

**Gate leak:** `Workspace/workspaceGate.ts:1,33` re-exports the whole `WorkspaceManager` class. The actual `workspaceGate` object (`workspaceGate.ts:63-70`) exposes only `requireId, assertMatch, assertExists, getMountedAgentIds, resolveHttpWorkspaceId, requireHttpWorkspace` — **no `create` / `ensure` / `mount` port**. Consumers therefore cannot create through the gate today.

**Types:** `Workspace/workspaceTypes.ts:3` status union; `100-106` `CreateWorkspaceInput { name, ownerId?, permissions?, constraints?, metadata? }`; `108-112` `MountAgentInput { agentId, scope?, permissions? }`.

### 2.2 `db/seed.ts` — real default-workspace creation (bypasses manager)

**File:** `db/seed.ts:193-212`

* `193-195`: `findFirst(workspaces.id == "default")`.
* `197-208`: if missing, `db.insert(workspaces)` with `id: "default"`, `name: "Default Workspace"`, `ownerId: "human_operator"`, `status: "ACTIVE"` (skips `CREATED→INITIALIZING→ACTIVE`), `rootPath: join(process.cwd(),"sandbox","default")` normalized, default permissions/constraints inline.
* `215-226`: `workspaceSettings id:"default"` insert if missing.
* `228-304`: `#general` + `GOVERNANCE & AUDIT` / `ENGINEERING DEPT` categories/channels, all `workspaceId: "default"`.
* `307-326`: local `mountAgent(agentName)` helper — looks up `agents` by name, checks `workspaceAgents(workspaceId:"default", agentId)`, inserts `wsa_<8hex>` with `scope:"shared"`, `permissions:{read:true,write:false,execute:false}`. Called for `"default-assistant"` (`325`) and `"Librarian"` (`326`). **Does not call `WorkspaceManager.mountAgent`; skips `ACTIVE` check, `maxAgents` check is vacuously safe, duplicate check is manual.**

Invoked via `db/bootstrap.ts:496-506` (`applyMigrations → ensurePgVectorExtension → seed()`) and `package.json: db:seed → tsx src/db/seed.ts`.

### 2.3 `db/create-workspace-crowdos.ts` — second ad-hoc creation script (bypasses manager)

**File:** `db/create-workspace-crowdos.ts:1-59` (entire file)

* `9-10`: `id = "crowdos"`, `rootPath = join(process.cwd(),"sandbox",id)` normalized.
* `13-15`: existence check `findFirst(workspaces.id == id)`.
* `22-42`: if missing, `db.insert(workspaces)` with `name:"CrowdOS"`, `ownerId:"human_operator"`, `status:"ACTIVE"` (same status skip as seed), `permissions:{network:true,shell:true,maxAgents:8}`, `constraints:{networkAccess:true,shellExecution:true,memoryLimitMb:512,cpuLimit:1}`.
* `46-50`: `new LocalVFS({ workspaceId:id, workspaceRoot:rootPath, actorId:"human_operator" })`.
* `53`: `await vfs.initialize()`.
* `57-59`: standalone `run().catch().finally(closeDatabaseConnection)` — no gate, no idempotency beyond existence check, no status transitions, no event emission.

### 2.4 `LocalVFS.initialize()` — self-healing third creation path

**File:** `vfs/local-vfs.ts:43-106`

* `43`: `async initialize(): Promise<void>` (part of `VirtualFS` contract `vfs/vfs.interface.ts:25-36`, `initialize` at line `35`).
* `46-74`: ensure `workspaces` row exists — if `findFirst(workspaces.id == workspaceId)` misses, inserts with `name: id=="default" ? "Default Workspace" : workspaceId`, `ownerId: actorId || "human_operator"`, `status:"ACTIVE"` (again skips machine), `rootPath` normalized, default permissions/constraints, `metadata:{}`.
* `77`: `fs.mkdir(workspaceRoot, {recursive:true})`.
* `80-88`: `standardDirs = ["/src","/artifacts","/agents","/.crowdos","/.crowdos/runtime","/.crowdos/cache","/.crowdos/snapshots"]`.
* `90-92`: `for dir: await this.mkdir(dir)` — each `mkdir` (`211-246`) also inserts a `workspaceNodes` directory row if `(workspace_id,path)` missing.
* `94-105`: if `/.crowdos/workspace.json` missing (`exists` at `387-395`), `write()` (`151-209`) default metadata JSON — `write` also upserts the `workspaceNodes` file row and fires `onEvent`.

Exported via `vfs/vfsGate.ts:1-15` (`LocalVFS` re-export line `5`; `vfsGate.createLocalVFS` lines `8-10`). `WorkspaceManager` imports it gate-compliantly (`workspaceManager.ts:11` from `../vfs/vfsGate.js`), but the self-heal means **any `new LocalVFS(...).initialize()` can create a workspace row as a side effect**, defeating single-entry-point guarantees.

### 2.5 `index.ts bootstrapWorkspaces()` — boot-time re-initialization loop

**File:** `index.ts:136-171`, called at `200` before `app.listen`.

* `141`: `db.select().from(workspaces).execute()` — fetches **all** rows regardless of status.
* `144-155`: for each `ws`: `new LocalVFS({workspaceId:ws.id, workspaceRoot:ws.rootPath, actorId:ws.ownerId||"system"})` (`148-152`) + `await vfs.initialize()` (`153`). Because `initialize()` is self-healing + `mkdir`-idempotent, this repairs missing dirs/nodes on every boot but also **masks creation bugs and re-runs storage init for TERMINATED/ARCHIVED rows**.
* `157-166`: unconditional second init for `workspaceId:"default"`, `workspaceRoot: sandbox/default`, `actorId: SYSTEM_ACTOR_ID||"system"`.
* Failure mode: `try/catch` at `137,168-170` logs and continues — boot never fails on VFS errors.

### 2.6 No HTTP creation endpoint

**File:** `routes/workspace.ts:1-211`

* `33-39`: `GET /api/workspace/settings`.
* `42-59`: `PUT /api/workspace/settings`.
* `62-71`: `GET /api/workspace/budget`.
* `74-116`: `PUT /api/workspace/budget`.
* `119-146`: `POST /api/workspace/budget/reset`.
* `151-209`: `POST /api/workspace/database` (gated by `ENABLE_DB_CONFIG_MUTATION` + `WORKSPACE_ADMIN_TOKEN`, connection-test only).
* **No `POST /api/workspaces`, no `DELETE /api/workspaces/:id`, no mount routes.** Confirmed by `routes/index.ts:25-47` (`workspaceRoutes` registered at line `31`; no other workspace-creation registrar).
* File-level VFS routes (`routes/vfs.ts:11-23` `getDynamicVFS`, `40-126` list/read/write/delete) construct `new LocalVFS` directly from the `workspaces` row, bypassing the `Workspace` domain entirely.

### 2.7 Stable contracts that must not change here

* **Schema:** `db/schema.ts:36` `workspace_status` enum (`CREATED,INITIALIZING,ACTIVE,PAUSED,TERMINATED,ARCHIVED`); `461-472` `workspaces` table (`id PK, name, ownerId, status default CREATED, rootPath, permissions, constraints, metadata, timestamps`); `474-490` `workspaceNodes` (`workspaceId FK cascade`, `path`, `name`, `type`, `mimeType`, `size`, `checksum`, `createdBy/updatedBy`, unique `workspace_nodes_ws_path_idx` on `(workspaceId,path)` at `489`); `502-509` `workspaceAgents`; `492-500` `workspaceEvents`. Legacy DDL mirrors in `db/bootstrap.ts:45,68-79,80-94,476`.
* **Guard jail (keep):** `vfs/path-guard.ts:108-135` `resolveWorkspacePath` (safe-check + realpath + `isInsideRoot` `65-75`); `tools/safety/Guard.ts:100-114` `getWorkspaceDir`, `116-129` `isInsideRoot`, `153-173` `validatePath`. The FS-mount rework keeps this jail; only the backend behind it changes.

---

## 3. Target Design

### 3.1 One creation entry point

**Owner file:** `Workspace/workspaceService.ts` (new, private to domain; alternatively refactor `workspaceManager.ts` into functions — either way the class is no longer the public surface).

**Canonical signature (exact):**

```ts
// Workspace/workspaceService.ts
import type { CreateWorkspaceInput, Workspace } from "./workspaceTypes.js";

export interface EnsureWorkspaceInput extends CreateWorkspaceInput {
  /** Fixed id for seeded/system workspaces ("default", "crowdos"). Omitted → generated ws_<8hex>. */
  id?: string;
  /** Actor recorded as ownerId/createdBy. Defaults to input.ownerId ?? "system". Never hard-code a human id inside the service. */
  actorId?: string;
}

export async function createWorkspace(input: EnsureWorkspaceInput): Promise<Workspace>;
export async function ensureWorkspace(id: string, input: Omit<EnsureWorkspaceInput, "id">): Promise<Workspace>;
```

Semantics:

* `createWorkspace({id?, ...})`:
  1. Validate `name` non-empty; validate `permissions.maxAgents >= mounted count invariant (>=1)`; normalize `rootPath = join(sandboxRoot, id ?? ws_<8hex>)` with `/` normalization (preserve current scheme; do not change existing rows).
  2. `INSERT workspaces(status:"CREATED")` — fail on duplicate `id` (unique violation surfaces; do not swallow).
  3. `UPDATE status:"INITIALIZING"`.
  4. Call **storage handoff** `ensureWorkspaceStorage({ workspaceId, rootPath, actorId })` (see 3.3).
  5. `UPDATE status:"ACTIVE"`.
  6. Insert `workspace.created` event row. Return re-read row.
  7. On failure after INSERT, attempt `UPDATE status:"TERMINATED"` (best-effort) then rethrow; never leave `INITIALIZING` silently.
* `ensureWorkspace(id, input)` (idempotent, for seeds/bootstrap/scripts):
  1. `findFirst(workspaces.id == id)` → return if found (and optionally repair storage via handoff if `repair:true` passed — default `false` for seeds, `true` for boot path).
  2. Else delegate to `createWorkspace({ ...input, id })`.

**Gate facade (only cross-domain surface):**

```ts
// Workspace/workspaceGate.ts (add; keep existing context/guard re-exports)
import { createWorkspace, ensureWorkspace } from "./workspaceService.js";
import { mountAgent, unmountAgent } from "./workspaceService.js"; // moved from manager
import { getWorkspaceById, listWorkspaces, removeWorkspace, setWorkspaceStatus } from "./workspaceService.js";

export const workspaceGate = {
  // ...existing: requireId, assertMatch, assertExists, getMountedAgentIds, resolveHttpWorkspaceId, requireHttpWorkspace,
  create: createWorkspace,
  ensure: ensureWorkspace,
  getById: getWorkspaceById,
  list: listWorkspaces,
  remove: removeWorkspace,
  setStatus: setWorkspaceStatus,
  mountAgent,
  unmountAgent,
};
export type { EnsureWorkspaceInput } from "./workspaceService.js";
```

Rules:

* Other domains (`routes/*`, `index.ts`, `db/seed.ts`, scripts) import **only** `workspaceGate` (and workspace types) — never `workspaceManager.js`, `workspaceService.js`, `local-vfs.js`, or `schema.js` workspace tables directly. Enforced by `scripts/check-gates.mjs`.
* `WorkspaceManager` class is deleted (preferred) or reduced to a deprecated thin wrapper delegating to the service functions. Do not keep both as parallel implementations.
* `db/schema.ts` type-only import from `workspaceGate.js` stays (types are allowed through the gate).

### 3.2 Unify the three seed paths

| Current path | Change |
|---|---|
| `db/seed.ts:193-212` default insert + `307-326` manual mounts | Replace inline `db.insert(workspaces)` with `workspaceGate.ensure("default", { name:"Default Workspace", actorId:"system", permissions:{...}, constraints:{...} })`. Replace manual `workspaceAgents` inserts with `workspaceGate.mountAgent("default", { agentId })` guarded by existence check (keep idempotency; skip if already mounted). Seed keeps channel/category logic untouched. |
| `db/create-workspace-crowdos.ts:22-53` | Replace inline insert + `new LocalVFS().initialize()` with `workspaceGate.ensure("crowdos", { name:"CrowdOS", actorId:"human_operator", permissions:{network:true,shell:true,maxAgents:8}, constraints:{...} })`. Script becomes a 10-line gate client. Long-term: delete script once seed covers it, or keep as documented manual runner that still goes through the gate. |
| `vfs/local-vfs.ts:43-74` row self-heal | **Remove row creation from `LocalVFS.initialize()`.** `initialize()` keeps only: `mkdir root` (`77`), `mkdir standardDirs` (`90-92`), `write workspace.json if missing` (`94-105`). If `workspaces` row is missing, throw `WorkspaceContextRequiredError` (import from `Workspace/workspaceContext.js` or a shared error — one direction only, no cycle: `vfs` may import the error type, never the service). This turns silent creation into a loud failure that forces callers onto the canonical path. |
| `index.ts:136-171` bootstrap loop | Replace per-row `new LocalVFS(...).initialize()` with `workspaceGate.ensure(ws.id, {...from row...}, {repair:true})` or a new `workspaceGate.repairStorage(id)` that calls only the storage handoff. Add status filter: skip `TERMINATED`/`ARCHIVED` rows (log + continue). Keep the explicit `"default"` ensure for first-boot. Keep per-workspace `try/catch` so one bad row does not abort boot. |

### 3.3 FS-mount handoff point (stable contract for the later rework)

Introduce one function, owned by the `Workspace` domain, that is the **only** place that touches disk + `workspace_nodes` during creation/repair:

```ts
// Workspace/workspaceStorage.ts (new, private to domain)
export interface WorkspaceStorageInput { workspaceId: string; rootPath: string; actorId: string; }
export async function ensureWorkspaceStorage(input: WorkspaceStorageInput): Promise<void>;
```

* **Today:** implementation delegates to `vfsGate.createLocalVFS({ workspaceId, workspaceRoot: rootPath, actorId }).initialize()` (post-3.2 version without row creation) — i.e. `mkdir root + standardDirs + workspace.json + nodes sync`. `createWorkspace` and boot-repair call only this.
* **After FS-mount rework:** implementation mounts the FS backend (bind mount / overlay / chroot driver) then performs the same `standardDirs + workspace.json + nodes` sync. Callers do not change. `rootPath` stays the absolute anchor; `(workspace_id,path)` uniqueness stays; `status` machine stays; Guard jail (`resolveWorkspacePath` / `Guard.validatePath`) stays in front of every access.
* `LocalVFS` remains the `VirtualFS` implementation (`vfs.interface.ts:25-36`) until the rework replaces it; the rework must keep the `VirtualFS` method shapes or version the gate.

### 3.4 Dead methods: wire, don't keep dead

* **Delete** `WorkspaceManager` class (or deprecate to delegating wrapper for one release if external consumers exist — verification shows none, so delete is preferred).
* **Wire** `mountAgent` / `unmountAgent` (moved to `workspaceService.ts`): expose via `workspaceGate.mountAgent/unmountAgent`, reuse in `seed.ts`, and optionally add thin HTTP routes (`POST /api/workspaces/:id/agents`, `DELETE ...`) that validate via `workspaceGate.requireHttpWorkspace` + call the gate. If HTTP is out of scope for this slice, still expose the gate ports and leave routes for a follow-up — but do not leave the logic with zero callers.
* **Wire** `deleteWorkspace → removeWorkspace`: expose via `workspaceGate.remove`; add `DELETE /api/workspaces/:id` only if product wants it, otherwise keep gate-only + document. At minimum the function must have a caller (seed-tests + admin script) or be deleted.
* **Keep and enforce** `updateWorkspaceStatus → setWorkspaceStatus` with the existing transition table (`workspaceManager.ts:159-166` moved verbatim). All status writes outside the service (seed, scripts, VFS) are removed; only the service writes `status`.

---

## 4. Expected Files Touched

1. **`Workspace/workspaceService.ts` (NEW)** — `createWorkspace`, `ensureWorkspace`, `getWorkspaceById`, `listWorkspaces`, `removeWorkspace`, `setWorkspaceStatus`, `mountAgent`, `unmountAgent` (moved from `workspaceManager.ts:56-240` with identical validation + transition table + event emission). Owns `sandboxRoot` resolution (from `process.cwd()/sandbox` or `WORKSPACE_DIR`, consistent with `Guard.getWorkspaceDir`).
2. **`Workspace/workspaceStorage.ts` (NEW)** — `ensureWorkspaceStorage` handoff (today: delegate to `vfsGate.createLocalVFS().initialize()`; tomorrow: FS-mount driver). Only file allowed to construct storage backend during creation/repair.
3. **`Workspace/workspaceGate.ts` (EDIT)** — remove `WorkspaceManager` re-export (`1,33`); add `create/ensure/getById/list/remove/setStatus/mountAgent/unmountAgent` ports delegating to `workspaceService.js`; export `EnsureWorkspaceInput` type. Keep existing context/guard exports.
4. **`Workspace/workspaceManager.ts` (DELETE preferred)** — remove class; if deletion is deemed risky, replace body with deprecated delegating wrappers marked `@deprecated use workspaceGate` and delete in the next slice. Update any lingering imports (only `workspaceGate.ts:1` today).
5. **`vfs/local-vfs.ts` (EDIT)** — `initialize()` (`43-106`): delete row-ensure block (`46-74`); throw if `workspaces` row missing; keep `77-105` (mkdirs + nodes + `workspace.json`) verbatim. Add regression comment pointing at `workspaceGate.ensure`.
6. **`db/seed.ts` (EDIT)** — replace `193-212` workspace insert with `workspaceGate.ensure("default", ...)`; replace `307-326` manual `workspaceAgents` inserts with `workspaceGate.mountAgent` (idempotent check first). No change to model/instruction/toolkit/agent/channel seeding.
7. **`db/create-workspace-crowdos.ts` (EDIT or DELETE)** — replace `22-53` with `workspaceGate.ensure("crowdos", ...)`; keep script runnable via `tsx`. If seed subsumes it, delete file and document `db:seed` as the replacement.
8. **`index.ts` (EDIT)** — rewrite `bootstrapWorkspaces` (`136-171`): import `workspaceGate` (not `LocalVFS`); filter out `TERMINATED`/`ARCHIVED`; call `ensure`/`repairStorage` per row; keep per-workspace `try/catch` + logging; keep explicit `"default"` ensure. Remove `LocalVFS` import if no longer used here.
9. **`routes/vfs.ts` (EDIT, optional but recommended)** — route `getDynamicVFS` (`11-23`) through `workspaceGate.getById` for the existence check instead of raw `db.select().from(workspaces)`; still constructs `LocalVFS` for I/O until FS-mount rework (I/O path unchanged).
10. **`routes/workspace.ts` (EDIT, only if wiring delete/mount to HTTP)** — add `POST /api/workspaces` (→ `workspaceGate.create`), `DELETE /api/workspaces/:id` (→ `workspaceGate.remove`), mount/unmount routes; all with zod validation + `requireHttpWorkspace`/`assertExists`. If deferred, leave file untouched and note in PR.
11. **Tests (NEW, see §6)** — `Workspace/workspaceCreation.test.ts`, `Workspace/workspaceStatus.test.ts`, `Workspace/workspaceMounts.test.ts` (all inside domain so they may import internals per gate-lint exemption).
12. **`package.json` / docs (EDIT if scripts change)** — only if `create-workspace-crowdos.ts` is deleted (remove any npm script referencing it; none exists today — it is run via bare `tsx`).

Explicitly **not touched**: `db/schema.ts` tables/enums, `db/bootstrap.ts` DDL, `db/migrations/*`, `vfs/path-guard.ts`, `tools/safety/Guard.ts` jail, `Workspace/workspaceTypes.ts` (except possibly adding `EnsureWorkspaceInput` — prefer defining it in the service file).

---

## 5. Ordered Implementation Steps (each verifiable)

1. **Extract service with identical behavior.** Create `Workspace/workspaceService.ts` by moving `createWorkspace/getWorkspace/list/delete/updateStatus/mount/unmount/getSessions/emitEvent` from `workspaceManager.ts:56-289` verbatim (rename `deleteWorkspace→removeWorkspace`, `getWorkspace→getWorkspaceById`, `updateWorkspaceStatus→setWorkspaceStatus`). Verify: `npx tsc -p tsconfig.json --noEmit` passes; `node scripts/check-gates.mjs` passes.
2. **Add storage handoff.** Create `Workspace/workspaceStorage.ts:ensureWorkspaceStorage` delegating to `vfsGate.createLocalVFS(...).initialize()`; switch service `createWorkspace` step 4 to call it instead of inline `new LocalVFS`. Verify: existing test suite still passes (`npx vitest run` — no behavior change yet).
3. **Expose gate ports.** Edit `Workspace/workspaceGate.ts`: remove `WorkspaceManager` export, add `create/ensure/getById/list/remove/setStatus/mountAgent/unmountAgent` delegating to service. Verify: `npm run lint:gates` passes; `grep -rn "from.*workspaceManager" src` returns only the (soon deleted) file itself.
4. **Disarm VFS self-heal.** Edit `vfs/local-vfs.ts:43-74`: delete row-insert, throw `WorkspaceContextRequiredError` when row missing. Verify: new test asserting `initialize()` throws on unknown id passes; boot against existing DB still works (rows exist).
5. **Migrate seeds/scripts to gate.** Edit `db/seed.ts:193-212,307-326` and `db/create-workspace-crowdos.ts:22-53` to use `workspaceGate.ensure` / `workspaceGate.mountAgent`. Verify: fresh-DB `db:push + db:seed` twice in a row succeeds (idempotency); `workspaces` contains `default` (+ `crowdos` if script run) with `status ACTIVE`.
6. **Rewrite boot bootstrap.** Edit `index.ts:136-171` to use gate + status filter + per-workspace try/catch. Verify: server boots with existing rows; boot log shows skip lines for `TERMINATED`/`ARCHIVED`; deleting a workspace dir then rebooting recreates dirs/nodes without duplicating rows.
7. **Delete or deprecate manager.** Delete `Workspace/workspaceManager.ts` (preferred — zero external callers). Verify: `grep -rn "WorkspaceManager" src scripts` returns 0 hits; `typecheck` + `lint:gates` green.
8. **(Optional slice) Wire HTTP.** Add creation/deletion/mount routes in `routes/workspace.ts` as thin gate clients. Verify: manual `curl` create → `ACTIVE` row + dirs + nodes; illegal transition returns 400/409; `lint:gates` green.

---

## 6. Verification

### 6.1 Commands (run from `packages/server/`)

```bash
# typecheck
npx tsc -p tsconfig.json --noEmit

# gate discipline (check-gates + check-redaction + check-events)
npm run lint:gates
# subset during development
node scripts/check-gates.mjs

# targeted tests
npx vitest run src/Workspace/workspaceCreation.test.ts
npx vitest run src/Workspace/workspaceStatus.test.ts
npx vitest run src/Workspace/workspaceMounts.test.ts

# full suite before merge
npx vitest run
```

Existing suites to watch for regressions (no workspace-specific suites exist today): `src/db/channelSequences.concurrency.test.ts`, `src/routes/ratelimit.test.ts`, `src/Shared/sockets/registerSocketServer.test.ts` (uses `workspaceGate.getMountedAgentIds`), `src/Artifacts/artifactsGate.test.ts`.

### 6.2 New tests to add (all under `src/Workspace/`, may import internals per gate-lint exemption)

* **`workspaceCreation.test.ts` — creation idempotency:**
  * `createWorkspace({name})` → `status ACTIVE`, `rootPath` under sandbox, `/src /artifacts /agents /.crowdos/*` exist on disk, `workspace_nodes` rows exist, `/.crowdos/workspace.json` exists, `workspace.created` event row exists.
  * `ensureWorkspace("default", ...)` twice → single `workspaces` row, second call returns same id, no duplicate `workspace_nodes` (unique `(workspace_id,path)` holds), no throw.
  * `createWorkspace` with duplicate explicit `id` (non-ensure) → rejects (unique violation), does not leave `INITIALIZING` row (or leaves `TERMINATED` per failure policy — assert whichever is specified).
  * `LocalVFS.initialize()` with unknown `workspaceId` → rejects/throws (self-heal removed).
* **`workspaceStatus.test.ts` — status transitions:**
  * Table-test every edge in `CREATED→INITIALIZING→ACTIVE→PAUSED/TERMINATED→ARCHIVED`: legal edges succeed, all others throw `Invalid transition: X → Y`.
  * `createWorkspace` failure injection (storage throws) → row ends `TERMINATED` (or is removed) and never stays `INITIALIZING`.
  * Boot filter: `TERMINATED`/`ARCHIVED` rows are skipped by bootstrap (mock `ensureWorkspaceStorage`, assert not called).
* **`workspaceMounts.test.ts` — mount limits:**
  * `mountAgent` on non-`ACTIVE` workspace → throws.
  * Mount beyond `permissions.maxAgents` (e.g. `maxAgents:1`, two mounts) → second throws `reached max agents`.
  * Duplicate `agentId` mount → throws `already mounted`.
  * `unmountAgent` then re-mount same agent → succeeds.
  * Seed idempotency: `ensure + mountAgent("default-assistant")` twice → single `workspace_agents` row.

All new tests use real DB or hermetic temp `sandboxRoot` + transaction rollback; no network.

---

## 7. Risks & Rollback

| Risk | Mitigation / Rollback |
|---|---|
| Removing VFS row self-heal breaks a hidden caller that relied on auto-creation (e.g. `routes/vfs.ts:getDynamicVFS`, ad-hoc scripts). | Grep shows only `index.ts`, `workspaceManager.ts`, `create-workspace-crowdos.ts` call `initialize()`; `routes/vfs.ts` never calls `initialize()`. Still: land step 4 behind steps 1-3+5 so gate path exists first; keep per-workspace boot try/catch. Rollback: revert `local-vfs.ts` hunk only (restore `46-74`). |
| Boot skips `TERMINATED`/`ARCHIVED` and an operator expected repair of those rows. | Log skipped ids at `warn`; document `workspaceGate.repairStorage(id)` manual repair. Rollback: remove status filter (one-line revert in `index.ts`). |
| Deleting `WorkspaceManager` breaks an out-of-tree importer. | Verification shows zero in-repo callers; npm package is `private`. Prefer delete; fallback is deprecated wrapper (step 7 alternative) — no behavior risk either way. |
| `ensureWorkspace` races (two seeds concurrently) create duplicate `workspace_nodes` or duplicate workspace rows. | `workspaces.id` PK + `workspace_nodes_ws_path_idx` unique make races fail loudly; service catches unique violation on second writer and re-reads. Tests cover double-ensure. |
| Status failure window (`INITIALIZING` left behind on crash between steps). | Failure handler best-effort `TERMINATED` + boot repair only touches non-terminal rows; orphan `INITIALIZING` rows are visible in `list` and repairable via `setStatus`. Document manual `setStatus(id,"ACTIVE")` only after verifying storage. |
| Scope creep into FS-mount rework. | `ensureWorkspaceStorage` is the only shared surface; this spec forbids changing jail, `rootPath` scheme, or `VirtualFS` shapes. Any FS-mount experiment branches from that one function. |

Rollback overall: each step is independently revertible (service extract → gate → VFS disarm → seeds → boot → delete). If post-merge boot fails, revert `index.ts` + `local-vfs.ts` hunks first (restores old self-healing boot), then re-land.

---

## 8. Dependencies on Other Specs (FS-Mount Rework)

* **Contract freeze assumed by FS-mount spec:** `workspaces.id` (PK, `ws_<8hex>` generated vs `"default"`/`"crowdos"` fixed), `rootPath` (absolute, `/`-normalized, `sandbox/<id>` default), `status` enum + transition table, `workspace_nodes(workspace_id,path)` uniqueness, `workspace_agents` roster shape, `/.crowdos/workspace.json` presence. This spec **must land first**; the FS-mount spec must assert these unchanged.
* **Handoff consumed by FS-mount spec:** `Workspace/workspaceStorage.ts:ensureWorkspaceStorage({workspaceId,rootPath,actorId})` is the replacement seam. FS-mount spec replaces its body (mount driver + same post-mount `standardDirs + workspace.json + nodes` sync) and adds mount-specific tests (symlink escape, stale-mount cleanup, cross-platform paths). It must keep calling Guard jail (`path-guard.ts:108-135`, `Guard.ts:153-173`) before any FS access.
* **Boot behavior shared:** this spec defines boot as `ensure + repair-if-active`; FS-mount spec extends repair to include mount-health checks (is-mounted? remount?) without changing the status filter or idempotency guarantees.
* **No circular dependency:** `Workspace/*Gate.ts` is the only cross-domain import allowed (`check-gates.mjs`). The FS-mount implementation must live inside `Workspace/` (private) or `vfs/` behind `vfsGate`, never as a third domain importing both services directly. If both gates end up needing each other, extract the shared mount primitive into its own domain per facade standard.
