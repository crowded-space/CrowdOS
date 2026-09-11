# Workspace Flow Audit

> Historical: database-per-workspace was evaluated and rejected. Single shared DB + workspace_id scoping is current.

## Executive summary

Your intended architecture appears to be:

```text
                 ┌──────────────────────┐
                 │ Workspace Registry   │
                 │ workspaces.json      │
                 └──────────┬───────────┘
                            │
                     workspaceId
                            │
             ┌──────────────▼──────────────┐
             │ Workspace DB Resolver       │
             │ getWorkspaceDb(workspaceId) │
             └──────────────┬──────────────┘
                            │
              ┌─────────────▼─────────────┐
              │ Tenant / Workspace DB     │
              │                            │
              │ agents                    │
              │ categories                │
              │ channels                  │
              │ messages                  │
              │ runs                      │
              │ artifacts                 │
              │ memories                  │
              └────────────────────────────┘
```

That works reasonably well for **HTTP requests**.

But several paths currently do this:

```text
workspaceId
    │
    X
    │
    └── getDb() → GLOBAL DB
```

The most problematic paths are:

1. **Socket runtime snapshot → global agents**
2. **Socket `user:message` → global agents/channels/messages**
3. **Socket runs → hardcoded `"default"`**
4. **Socket workspace join → can join multiple workspaces**
5. **Socket channel join → doesn't verify channel belongs to workspace**
6. **Socket auth → API-key identity is always `"default"` workspace**
7. **Socket durable event persistence → global DB**
8. **BullMQ workers → workspace ID is carried, but DB context isn't**
9. **Several REST endpoints use tenant DB correctly only because ALS happens to save them**
10. **Workspace sync events are broadcast globally**
11. **Run/approval/artifact APIs aren't consistently workspace-scoped**
12. **The old `WorkspaceManager` model and newer database-per-workspace model overlap**

So I would **not patch only the roster**.

You need to repair the **Workspace Boundary**.

---

# P0 — Phantom roster root cause

## 1. `runtime:snapshot` loads ALL agents from the global DB

### Culprit

`server/src/shared/sockets/register-socket-server.ts`

Around lines **167–258**:

```ts
async function emitRuntimeSnapshot(target: any): Promise<void> {
  const db = getDb();

  const [dbWorkspaces, dbAgents, ...] = await Promise.all([
    ...
    db.query.agents.findMany({
      where: isNull(agents.archivedAt),
      ...
    }),
  ]);
```

There is no workspace ID.

Therefore:

```text
Workspace A socket
       │
       └── runtime:snapshot
               │
               └── GLOBAL DB
                      │
                      ├── Agent A
                      ├── Agent B
                      ├── Agent C
                      └── Agent D
```

That's the direct source of the phantom roster.

### Why it gets worse

The snapshot is also periodically generated:

```ts
emitRuntimeSnapshot(io);
```

every 15 seconds.

So even if the UI initially gets the correct roster from REST, the next snapshot can reintroduce the global roster.

### Fix

Make snapshot workspace-aware.

Instead of:

```ts
emitRuntimeSnapshot(io)
```

you need something conceptually like:

```ts
emitRuntimeSnapshot(socket, socket.data.workspaceId)
```

and:

```ts
const { db } = await getWorkspaceDb(workspaceId);
```

Then query the tenant DB.

Better still, split the snapshot:

```text
Global snapshot
  ├── workspace metadata

Workspace snapshot
  ├── agents
  ├── categories
  ├── channels
  ├── runtime state
  ├── swarms
  └── workspace-specific telemetry
```

Don't make a supposedly global snapshot contain tenant-owned data.

---

# P0 — Socket execution is currently not workspace-aware

## 2. `user:message` uses global DB

At approximately line **589**:

```ts
const db = getDb();
```

But Socket.IO isn't running inside the Fastify `runWithDb()` request context.

Therefore this:

```ts
getDb()
```

means:

```text
global DB
```

not:

```text
current workspace DB
```

This affects:

```ts
messages
channels
categories
agents
```

and anything else reached through that DB.

### Fix

At the beginning of each socket operation:

```ts
const workspaceId = socket.data.workspaceId;
const { db } = await getWorkspaceDb(workspaceId);
```

Then pass that DB explicitly or establish a workspace execution context.

I'd actually create a helper:

```ts
withWorkspaceDb(workspaceId, async (db) => {
   ...
});
```

so Socket handlers can't accidentally fall back to `getDb()`.

---

# P0 — Hardcoded default workspace

## 3. Socket execution explicitly sends runs to `"default"`

At approximately line **668**:

```ts
workspaceId: 'default',
```

Then again around **752**:

```ts
workspaceId: "default",
```

and **764**:

```ts
workspaceId: "default",
```

This is worse than merely displaying the wrong roster.

A user can be inside:

```text
Workspace X
```

but the actual runtime gets:

```text
workspaceId = "default"
```

So you can end up with:

```text
UI
└── Workspace X
    └── Agent X

Runtime
└── default
    └── Agent default
```

### Fix

Never use `"default"` as a runtime fallback when a workspace has been explicitly selected.

Use:

```ts
const workspaceId = socket.data.workspaceId;
```

and require it.

I'd make `workspaceId` mandatory for runtime execution.

---

# P0 — Socket workspace identity is broken under API-key auth

## 4. Strict API-key sockets always become `default`

`server/src/shared/sockets/socket-auth.ts`

Around line **99**:

```ts
workspaceId: "default",
```

So in strict auth:

```text
API key
  ↓
verified
  ↓
SocketIdentity
  ↓
workspaceId = "default"
```

That means the socket itself has no actual workspace identity.

Then later:

```ts
workspace:join
```

changes it.

That's backwards.

### Fix

You need to decide where workspace authorization comes from.

For example:

```text
API key
   │
   ├── identity
   └── allowed workspace IDs
             │
             ▼
       requested workspace
```

Then handshake can receive:

```ts
workspaceId
```

but the server must validate:

```ts
requestedWorkspace ∈ identity.allowedWorkspaces
```

The client declaration should **not be trusted**, but it can be a requested target.

---

# P0 — `workspace:join` lets a socket accumulate workspace rooms

## 5. Old workspace room is never left

Initial connection:

```ts
socket.join(`workspace:${identity.workspaceId}`);
```

Then:

```ts
socket.on("workspace:join", async (data) => {
   ...
   socket.join(`workspace:${wid}`);
   socket.data.workspaceId = wid;
});
```

Notice what doesn't happen:

```ts
socket.leave(`workspace:${oldWorkspace}`);
```

So:

```text
Socket
 ├── workspace:A
 ├── workspace:B
 └── workspace:C
```

can happen.

This is a major isolation bug.

### Example

User:

```text
Workspace A → Workspace B
```

Socket is now:

```text
rooms:
  workspace:A
  workspace:B
```

If an event is emitted to A:

```ts
io.to("workspace:A").emit(...)
```

the user still receives it.

### Fix

Workspace room must be **exclusive**:

```ts
const previous = socket.data.workspaceId;

if (previous && previous !== wid) {
    socket.leave(`workspace:${previous}`);
}

socket.join(`workspace:${wid}`);
socket.data.workspaceId = wid;
```

But only after authorization.

---

# P0 — Channel room admission is not workspace-scoped

## 6. `channel:join` only checks whether channel exists

Current:

```ts
const canJoinChannelRoom = async (cid: string): Promise<boolean> => {
    ...
    return Boolean(await channelGate.get(cid));
};
```

This asks:

> "Does channel X exist?"

It does **not** ask:

> "Does channel X belong to the current workspace?"

Therefore:

```text
Workspace A
   │
   └── channel:join(channel-from-B)
                     │
                     └── channel exists → YES
```

Then the socket joins:

```text
channel:B
```

### Fix

Resolve channel and verify:

```ts
channel.workspaceId === socket.data.workspaceId
```

or, if workspace DB isolation is authoritative:

```ts
channel exists in current workspace DB
```

I'd do both conceptually:

```ts
const channel = await db.query.channels.findFirst(...);

if (!channel) deny(...);
```

because the DB itself is already the workspace boundary.

---

# P0 — `workspace:join` checks the global DB

## 7. Workspace admission uses `getDb()`

Around line **477**:

```ts
const ws = await getDb().query.workspaces.findFirst({
    where: eq(workspaces.id, wid)
});
```

Again this is global DB.

So the socket can ask:

```text
"Does workspace B exist?"
```

against the global DB.

But it doesn't establish that:

```text
current identity → authorized for B
```

### Fix

Workspace admission should be:

```text
requested workspace
        ↓
registry
        ↓
authorization
        ↓
workspace DB resolution
        ↓
workspace DB reachable
```

not just:

```text
global workspaces table says yes
```

---

# P0 — Durable event replay is also global

## 8. `channel:join` replays events from global DB

Around line **524**:

```ts
const recent = await getDb().query.durableEvents.findMany({
    where: and(eq(durableEvents.channelId, cid)),
    ...
});
```

This is the same problem.

If channel IDs are ever duplicated or if global durable events contain events from multiple workspace contexts, the wrong history can be replayed.

### Fix

Replay from the workspace DB:

```ts
const { db } = await getWorkspaceDb(workspaceId);

const recent = await db.query.durableEvents.findMany(...)
```

---

# P0 — Event persistence is not workspace-safe

## 9. Broker persistence always calls global `getDb()`

In the broker listener:

```ts
void getDb().insert(durableEvents).values(...)
```

This is around line **358**.

The event itself may belong to:

```text
Workspace X
```

but persistence can happen in:

```text
GLOBAL DB
```

because EventBroker has no workspace context.

This becomes particularly problematic for:

* Socket runtime
* BullMQ worker
* background execution
* scheduler
* maintenance tasks

### Fix

Add workspace context to the event itself.

I would change the broker contract from effectively:

```ts
broker.emit(type, payload, { channelId })
```

to:

```ts
broker.emit(type, payload, {
    channelId,
    workspaceId,
})
```

Then routing becomes deterministic:

```ts
event.workspaceId
```

rather than:

```ts
payload.workspaceId
```

---

# P1 — `workspace:sync` is currently global

## 10. REST mutations emit an unscoped sync

For example:

```ts
globalBroker?.emit("workspace:sync", {});
```

appears in:

* agents
* channels
* categories
* skills
* modules
* MCP
* studio

This results in the broker seeing:

```text
workspaceId = undefined
```

Then the Socket server intentionally does:

```ts
for (const room of io.sockets.adapter.rooms.keys()) {
    if (room.startsWith("workspace:"))
        io.to(room).emit(...)
}
```

So every workspace receives the sync.

### This may not directly cause data leakage

If the frontend responds by requesting:

```text
/api/agents
```

with the current workspace header, the returned data can still be correct.

But it causes:

* unnecessary refreshes
* cross-workspace invalidation
* race conditions
* unnecessary DB queries
* stale/global snapshot interactions

### Fix

Emit:

```ts
broker.emit("workspace:sync", {}, {
    workspaceId: request.workspaceId
});
```

Then:

```ts
io.to(`workspace:${workspaceId}`)
```

Only.

---

# P1 — REST agent API is actually one of the healthier paths

## 11. `/api/agents` is correctly tenant-routed

This part is good:

```ts
agentGate.list(..., request.db)
```

and the request middleware resolves:

```text
x-workspace-id
        ↓
getWorkspaceDb()
        ↓
request.db
        ↓
agentGate
```

So:

```http
GET /api/agents
x-workspace-id: workspace-A
```

is workspace A's DB.

This is why you can see the confusing behavior:

```text
REST roster → correct
Socket snapshot → wrong
```

That strongly supports the phantom-roster diagnosis.

---

# P1 — Agent cache is already designed for tenant isolation

## 12. Roster cache itself is not the culprit

`agent-service.ts` does something good:

```ts
getCachedRoster(
    `${dbScopeKey()}:roster:${JSON.stringify(filters)}`,
    ...
)
```

The cache is namespaced by DB context.

There are tests explicitly covering:

> workspace A's roster must not be served to workspace B.

So I would **not touch the roster cache first**.

The bug is upstream:

```text
Socket snapshot
    ↓
getDb()
    ↓
global agents
```

rather than:

```text
workspace DB
    ↓
bad cache
```

---

# P1 — WorkspaceManager is a second/legacy workspace model

## 13. `WorkspaceManager` and database-per-workspace architecture overlap

You have:

```ts
WorkspaceManager
```

with:

```ts
workspaceAgents
```

and:

```ts
mountAgent()
getAgentSessions()
validateAgentAccess()
```

This implies a model:

```text
GLOBAL DB

workspace
  └── workspace_agents
         ├── agent A
         └── agent B
```

But the newer architecture appears to be:

```text
Workspace A DB
  ├── agents
  ├── channels
  └── messages

Workspace B DB
  ├── agents
  ├── channels
  └── messages
```

Those are two different isolation models.

### Why this matters

`workspace_agents` says:

> agents are globally defined and mounted into workspaces.

But database-per-workspace says:

> agents already belong to the workspace DB.

You need to decide which is authoritative.

### My recommendation

Given the current implementation, I'd make:

```text
Workspace DB = authoritative tenant boundary
```

and treat:

```text
workspace_agents
```

as optional membership/configuration metadata, not the primary tenant isolation mechanism.

Otherwise you'll end up with:

```text
DB isolation
+
workspace_agents isolation
+
workspaceId columns
```

three competing concepts.

---

# P1 — `workspace_agents` isn't even seeded with the default agents

Your workspace seed creates:

```text
Raven
Owl
```

but I don't see corresponding:

```text
workspace_agents
```

mount records being created.

So if `workspace_agents` is supposed to define the roster, the seeded roster and mounted roster already disagree.

This is another sign that the old WorkspaceManager model isn't fully integrated with the newer workspace DB model.

### Fix

Choose one:

### Option A — DB-per-workspace

Don't require `workspace_agents` to define the roster.

### Option B — global agent catalog

Then agents should remain global and roster must always be:

```sql
workspace_agents
JOIN agents
```

But don't mix the two.

---

# P1 — Runs are not consistently tenant-bound

## 14. Run repository relies entirely on `getDb()`

`runs-repository.ts` does:

```ts
const db = getDb();
```

for:

* create
* get
* transition
* checkpoint
* heartbeat
* compensation
* list

This is okay **only if execution is inside the correct ALS workspace context**.

HTTP requests generally have that.

But:

```text
Socket
BullMQ
scheduler
maintenance
background runtime
```

do not automatically have it.

Therefore the same run code can silently operate against the global DB.

### Fix

Background execution must establish workspace DB context.

---

# P0/P1 — BullMQ worker carries workspaceId but doesn't resolve the DB

## 15. `run-worker.ts`

The worker correctly receives:

```ts
const {
    channelId,
    agentId,
    ...
    workspaceId,
} = job.data;
```

and passes:

```ts
workspaceId: workspaceId ?? "default"
```

to the runtime.

That's good.

But it doesn't do:

```ts
getWorkspaceDb(workspaceId)
```

or:

```ts
runWithDb(workspaceDb, ...)
```

before executing.

Therefore runtime code that calls:

```ts
getDb()
```

still sees the global DB.

### This is a major hidden bug

You effectively have:

```text
BullMQ job
workspaceId = A
       │
       ├── runtime knows A
       │
       └── getDb() → GLOBAL
```

The workspace ID is being **carried as metadata**, but not actually establishing the DB boundary.

### Fix

Worker should conceptually do:

```ts
const { db } = await getWorkspaceDb(workspaceId);

return runWithDb(db, () =>
    runtimeGate.execute(...)
);
```

This one change fixes a large class of downstream calls because your architecture already uses ALS.

---

# P1 — Scheduler worker has the same problem

`SchedulerJobData` has:

```ts
workspaceId?: string;
```

and:

```ts
const workspaceId = data.workspaceId || "default";
```

Good metadata.

But then it uses:

```ts
withTransaction(...)
```

which ultimately uses:

```ts
getDb()
```

Since the worker isn't inside a workspace context:

```text
scheduled Workspace A task
        ↓
GLOBAL DB
```

### Fix

Wrap the entire scheduled execution:

```ts
withWorkspaceDb(workspaceId, async () => {
    ...
});
```

---

# P1 — Maintenance worker / snapshot worker needs the same treatment

You have a maintenance worker emitting:

```ts
runtime:snapshot
```

This is especially important because the snapshot worker is another source of workspace state.

If it constructs a global snapshot, moving the socket snapshot alone won't completely solve the problem.

### Fix

Maintenance snapshots should be generated **per workspace**:

```text
for each workspace
    ↓
resolve workspace DB
    ↓
build snapshot
    ↓
emit workspace-scoped event
```

Not:

```text
one global snapshot
    ↓
broadcast to everyone
```

---

# P1 — Resume flow has workspace correctness issues

## 16. `/api/runs/:id/resume`

The run already has:

```ts
run.workspaceId
```

which is good.

But the inline resume path obtains the agent with:

```ts
agentGate.getById(run.agentId)
```

and the repository uses ambient DB context.

The endpoint itself may be operating under the selected HTTP workspace, but **the URL contains only the run ID**.

So the server should verify:

```text
run.workspaceId === request.workspaceId
```

before allowing the operation.

### Fix

Every workspace-owned object lookup should have an ownership check.

For example:

```ts
assertRunBelongsToWorkspace(run, request.workspaceId)
```

---

# P1 — Run endpoints aren't explicitly workspace-scoped

These:

```text
GET /api/runs/:id
GET /api/runs/:id/compensations
POST /api/runs/:id/resume
POST /api/runs/:id/compensations/:compId/undo
```

identify objects solely by:

```text
runId
```

The repository then searches the current DB.

With separate DBs that's somewhat protected.

But if a request is missing `x-workspace-id`, the fallback can become global/default.

### Fix

For workspace-owned routes:

```text
workspace context REQUIRED
```

No implicit `"default"` fallback.

---

# P1 — Artifacts API trusts a client-supplied `workspaceId`

`/api/artifacts` accepts:

```ts
workspaceId?: string
```

and then:

```ts
artifactsGate.listByWorkspace(query.workspaceId)
```

This is dangerous conceptually.

The user shouldn't be able to say:

```http
?workspaceId=some-other-workspace
```

and determine the tenant.

### Fix

Ignore the query parameter for authorization purposes.

Use:

```ts
request.workspaceId
```

as the authoritative workspace.

If you want a global/admin endpoint, make that a separate explicitly privileged endpoint.

---

# P1 — Safety routes can have the same ambiguity

`routes/safety.ts` does:

```ts
request.params.id
```

for workspace safety settings.

But the DB is resolved from:

```text
x-workspace-id
```

So there are potentially two workspace identities:

```text
header = A
params.id = B
```

The code should explicitly reject:

```text
A !== B
```

unless this is intentionally an admin/global operation.

---

# P1 — Search is only safe because ALS happens to work

`routes/search.ts` does:

```ts
const db = getDb();
```

That is actually fine for HTTP because your request hook establishes ALS.

So:

```text
HTTP search
 → x-workspace-id
 → getWorkspaceDb()
 → runWithDb()
 → getDb()
```

works.

But this pattern is fragile because a service can be called from:

```text
HTTP
Socket
Worker
Timer
CLI
```

and behave differently.

### Recommendation

Make workspace context explicit at architectural boundaries, while retaining ALS as convenience inside the boundary.

---

# P1 — Threads depend on ambient DB context

`thread-service.ts` repeatedly uses:

```ts
getDb()
```

This is fine in HTTP.

But Socket/thread/background paths must establish the workspace context before calling it.

Otherwise threads can silently operate on the global DB.

---

# P1 — Memories have the same ambient-context dependency

A lot of:

```text
memory-lifecycle
memory-retrieval
agent-memory-store
embeddings
memory-builder
```

use:

```ts
getDb()
```

Again:

```text
HTTP → safe if ALS exists
Socket/worker → dangerous
```

This is particularly important because memory is exactly the sort of data that should never cross workspace boundaries.

---

# P1 — Agent heartbeat is global

`agent-heartbeat.ts` uses:

```ts
getDb()
```

and updates:

```ts
agents
```

without workspace context.

If agents exist independently in each workspace DB, the heartbeat system needs to iterate over workspace DBs.

Otherwise it only updates the global DB.

### Fix

Use the existing:

```ts
forEachWorkspaceDb()
```

pattern.

You already have infrastructure for this.

---

# P1 — Agent spawn manager is ambient/global

`agent-spawn-manager.ts` uses:

```ts
getDb()
```

multiple times.

It emits:

```ts
workspace:sync
```

using only:

```ts
channelId
```

This means spawning an agent in Workspace A can potentially cause a global sync.

### Fix

Pass:

```ts
workspaceId
```

through the entire spawn operation and event.

---

# P1 — Runtime event emissions often don't include workspaceId

A lot of runtime events are emitted with:

```ts
{ channelId }
```

instead of:

```ts
{ channelId, workspaceId }
```

For example:

```ts
broker.emit("agent:status", ..., { channelId })
```

The Socket server then tries to determine scope from:

```ts
event.payload.workspaceId
```

which often doesn't exist.

So the event becomes:

```text
channelId exists
workspaceId undefined
```

and can only reliably route to:

```text
channel:<id>
```

not:

```text
workspace:<id>
```

### Fix

Make workspace scope a first-class EventBroker field.

I'd change the event model itself.

---

# P0 architectural recommendation: workspace context should be a first-class object

Right now you have workspace information scattered across:

```text
socket.data.workspaceId
request.workspaceId
x-workspace-id
run.workspaceId
payload.workspaceId
channel.workspaceId
default
```

That's too many sources of truth.

I recommend defining:

```ts
interface WorkspaceContext {
    workspaceId: string;
    db: DbInstance;
}
```

Then establish it at boundaries.

### HTTP

```text
HTTP request
   ↓
resolveWorkspaceContext()
   ↓
WorkspaceContext
   ↓
runWithDb()
```

### Socket

```text
Socket
   ↓
resolveWorkspaceContext()
   ↓
socket.data.workspaceContext
```

### BullMQ

```text
Job.workspaceId
   ↓
resolveWorkspaceContext()
   ↓
runWithDb()
```

### Scheduler

Same.

Then every internal service can safely use:

```ts
getDb()
```

because the context is guaranteed.

---

# P0 — Remove `"default"` as an implicit workspace

This is probably the biggest architectural cleanup I'd recommend.

Currently `"default"` is used everywhere as:

```ts
workspaceId ?? "default"
```

That hides bugs.

For example:

```text
workspaceId accidentally missing
        ↓
"default"
        ↓
looks like valid execution
```

Instead:

```ts
workspaceId ?? throw new WorkspaceContextRequiredError()
```

Use `"default"` only where you **explicitly mean the legacy/default workspace**.

This will turn silent tenant leaks into immediate errors.

---

# P1 — Workspace creation itself has duplicated responsibilities

The newer route:

```text
POST /api/workspaces
```

does:

```text
validate DB
provision DB
create registry record
seed workspace DB
insert workspaces row
```

This is reasonable.

But `WorkspaceManager.createWorkspace()` is another creation system that:

```text
creates workspace row
creates VFS
changes status
```

These should not both remain as independent creation mechanisms.

### Recommendation

Have exactly one:

```ts
WorkspaceService.create()
```

and let it own:

```text
registry
database provisioning
workspace metadata
VFS initialization
seed
status transitions
```

---

# P1 — Global `workspaces` table is confusing

You have a `workspaces` table inside workspace databases.

At the same time:

```text
workspaces.json
```

is the registry.

And the code also uses the global DB's:

```ts
workspaces
```

table.

So there are potentially:

```text
Registry
Global DB workspaces
Workspace A DB workspaces
Workspace B DB workspaces
```

That's four representations of workspace identity.

### Recommendation

Define one canonical architecture.

For example:

```text
GLOBAL
 ├── workspaces registry
 ├── API keys
 └── global configuration

WORKSPACE DB
 ├── agents
 ├── channels
 ├── messages
 ├── runs
 ├── memories
 ├── artifacts
 └── workspace-local configuration
```

If a workspace DB needs a local workspace row, it should be a **tenant-local identity row**, not used for global discovery.

---

# P1 — Provider/module/skill scope needs an explicit decision

Some systems currently use `getDb()`:

```text
modules
skills
providers
MCP
tools
```

If these are meant to be **global**, that's fine.

If they are meant to be workspace-specific, they're currently inconsistent.

For example:

```text
/api/skills
/api/modules
/api/providers
```

don't consistently pass workspace DB overrides.

### You should explicitly classify every data domain

I recommend:

| Domain                    | Scope                                    |
| ------------------------- | ---------------------------------------- |
| API keys                  | Global                                   |
| Workspace registry        | Global                                   |
| Workspace DB credentials  | Global                                   |
| Agents                    | Workspace                                |
| Channels                  | Workspace                                |
| Categories                | Workspace                                |
| Messages                  | Workspace                                |
| Threads                   | Workspace                                |
| Runs                      | Workspace                                |
| Artifacts                 | Workspace                                |
| Memories                  | Workspace                                |
| VFS                       | Workspace                                |
| Safety settings           | Workspace                                |
| Workspace settings        | Workspace                                |
| Provider definitions      | Probably global                          |
| Model profiles            | Probably global                          |
| Skills                    | Depends                                  |
| Tools                     | Probably global                          |
| MCP connections           | Probably global or workspace, but choose |
| Observability             | Workspace unless intentionally global    |
| Queue infrastructure      | Global                                   |
| Runtime process telemetry | Global                                   |

This decision will eliminate a lot of ambiguity.

---

# P2 — Desktop is mostly not the culprit

I inspected the desktop package as well.

The Electron layer mainly handles:

```text
IPC
embedded backend
navigation
config
desktop lifecycle
VFS/database bootstrap
```

I don't see the phantom-roster source originating there.

The important thing is:

```text
Desktop
   ↓
HTTP / Socket
   ↓
Server workspace boundary
```

So I'd fix the server boundary first.

---

# P2 — `dist/` needs rebuilding after fixing `src/`

Your ZIP contains compiled:

```text
server/dist
```

alongside:

```text
server/src
```

So after changing:

```text
src/shared/sockets/register-socket-server.ts
```

etc., make sure the packaged/desktop runtime isn't still executing stale:

```text
dist/
```

This is especially relevant because I found the same buggy logic already compiled under `dist`.

---

# The actual culprit chain

This is the important part.

Your current flow can be represented as:

```text
                USER SELECTS WORKSPACE A
                           │
                           ▼
                    frontend/socket
                           │
                           ▼
                  socket.data.workspaceId
                           │
                           │
                ┌──────────┴──────────┐
                │                     │
                ▼                     ▼
          HTTP requests          Socket handlers
                │                     │
                ▼                     ▼
       getWorkspaceDb(A)          getDb()
                │                     │
                ▼                     ▼
         Workspace A DB          GLOBAL DB
                │                     │
                ▼                     ▼
          correct roster       ALL AGENTS
                                      │
                                      ▼
                              runtime:snapshot
                                      │
                                      ▼
                               workspace:A room
                                      │
                                      ▼
                              👻 PHANTOM AGENTS
```

And execution has an even nastier path:

```text
Workspace A
    │
    ▼
user:message
    │
    ├── agents → GLOBAL
    ├── channel → GLOBAL
    ├── message → GLOBAL
    │
    └── run
          │
          └── workspaceId = "default"
```

So the **phantom roster is just the visible symptom**.

---

# What I would fix first

## Phase 1 — Stop the bleeding

### 1. Fix Socket snapshot

```text
emitRuntimeSnapshot(socket, workspaceId)
```

and resolve:

```text
workspace DB
```

instead of `getDb()`.

### 2. Fix Socket `user:message`

Replace every:

```ts
workspaceId: "default"
```

with the verified workspace context.

And make the DB workspace-specific.

### 3. Fix socket workspace switching

When switching:

```text
leave old workspace room
join new workspace room
```

and verify authorization.

### 4. Fix channel admission

Require:

```text
channel.workspace === socket.workspace
```

### 5. Remove default fallback from runtime execution

Turn:

```ts
workspaceId ?? "default"
```

into:

```ts
workspaceId ?? throw
```

for workspace-owned operations.

---

# Phase 2 — Fix background execution

Create:

```ts
withWorkspaceDb(workspaceId, fn)
```

Then use it in:

```text
Socket runtime
BullMQ run worker
Scheduler worker
Maintenance worker
heartbeat
orphan sweeper
spawn manager
background memory jobs
```

The desired pattern becomes:

```ts
await withWorkspaceDb(workspaceId, async () => {
    await runtimeGate.execute(...)
});
```

Then all the existing:

```ts
getDb()
```

inside runtime/services become safe.

This is much better than manually adding `db` to 150 functions.

---

# Phase 3 — Fix event architecture

Change the event contract from:

```ts
broker.emit(type, payload, {
    channelId
})
```

to:

```ts
broker.emit(type, payload, {
    channelId,
    workspaceId
})
```

Then routing becomes:

```text
workspaceId + channelId
       │
       ├── channel room
       └── workspace room
```

And:

```text
no workspaceId
```

means genuinely global.

No more guessing workspace from payload.

---

# Phase 4 — Establish scope rules

I would create explicit helpers:

```ts
requireWorkspaceContext()
```

```ts
withWorkspaceDb()
```

```ts
assertWorkspaceObject()
```

For example:

```ts
const ctx = await requireWorkspaceContext(request);

await withWorkspaceDb(ctx.workspaceId, async () => {
    ...
});
```

And make workspace-owned functions impossible to call without context.

---

# Phase 5 — Test isolation properly

You need a dedicated matrix like:

```text
Workspace A
  Agent A1
  Agent A2
  Channel A

Workspace B
  Agent B1
  Agent B2
  Channel B
```

Then test:

### Roster

```text
A → [A1, A2]
B → [B1, B2]
```

### Snapshot

```text
A socket never receives B1/B2
B socket never receives A1/A2
```

### Channel join

```text
A cannot join B channel
```

### Message

```text
A message exists only in A DB
B cannot see it
```

### Runtime

```text
A run.workspaceId === A
B run.workspaceId === B
```

### Worker

```text
A BullMQ job → A DB
B BullMQ job → B DB
```

### Event

```text
A event → A room
B event → B room
```

### Switching

```text
A → B

socket.rooms:
  workspace:B

NOT:
  workspace:A
```

### Replay

```text
A channel replay → A events only
```

### Memory

```text
A agent cannot retrieve B memory
```

### Artifacts

```text
A cannot request B artifacts
```

---

# Priority matrix

| Priority | Finding                                                | Severity                         |
| -------- | ------------------------------------------------------ | -------------------------------- |
| **P0**   | Socket snapshot queries global agents                  | 👻 Direct phantom roster         |
| **P0**   | Socket `user:message` uses global DB                   | 🔴 Cross-workspace data          |
| **P0**   | Socket runs hardcoded to `default`                     | 🔴 Wrong execution target        |
| **P0**   | API-key socket identity forced to `default`            | 🔴 Broken workspace identity     |
| **P0**   | `workspace:join` doesn't leave old room                | 🔴 Cross-workspace event leakage |
| **P0**   | Channel join doesn't verify workspace ownership        | 🔴 Cross-workspace access        |
| **P0**   | Durable event persistence uses global DB               | 🔴 Event contamination           |
| **P0**   | Background workers don't establish tenant DB context   | 🔴 Hidden cross-workspace writes |
| **P1**   | Global `workspace:sync` fan-out                        | 🟠 Cross-workspace invalidation  |
| **P1**   | Run APIs lack explicit workspace ownership checks      | 🟠 Isolation weakness            |
| **P1**   | Artifact API accepts arbitrary workspaceId             | 🟠 Tenant-boundary weakness      |
| **P1**   | Scheduler doesn't establish workspace DB               | 🟠 Wrong DB                      |
| **P1**   | Heartbeat is global                                    | 🟠 Wrong agent state             |
| **P1**   | Spawn manager relies on ambient DB                     | 🟠 Wrong workspace risk          |
| **P1**   | Runtime events lack first-class workspaceId            | 🟠 Routing ambiguity             |
| **P1**   | `WorkspaceManager` vs DB-per-workspace models overlap  | 🟠 Architectural debt            |
| **P1**   | `workspace_agents` isn't integrated with seeded roster | 🟠 Model inconsistency           |
| **P1**   | Multiple workspace metadata authorities                | 🟠 Architecture ambiguity        |
| **P2**   | Desktop layer                                          | 🟢 Not primary culprit           |
| **P2**   | Compiled `dist` must be rebuilt                        | 🟡 Deployment risk               |

---

# The architecture I'd aim for

Ultimately:

```text
                         ┌─────────────────┐
                         │ Workspace ID    │
                         │ = one source    │
                         │ of truth        │
                         └────────┬────────┘
                                  │
                ┌─────────────────▼─────────────────┐
                │        WorkspaceContext           │
                │                                    │
                │ workspaceId                        │
                │ db                                 │
                └───────┬───────────────┬────────────┘
                        │               │
              ┌─────────▼──────┐   ┌───▼────────────┐
              │ HTTP           │   │ Socket         │
              │                │   │                │
              │ ALS context    │   │ socket context │
              └─────────┬──────┘   └───┬────────────┘
                        │               │
                        └───────┬───────┘
                                │
                        ┌───────▼────────┐
                        │ Runtime/Service│
                        │                │
                        │ getDb()        │
                        │ = workspace DB │
                        └───────┬────────┘
                                │
                    ┌───────────▼───────────┐
                    │ Workspace A DB        │
                    │                       │
                    │ agents                │
                    │ channels              │
                    │ messages              │
                    │ threads               │
                    │ runs                  │
                    │ memories              │
                    │ artifacts             │
                    └───────────────────────┘
```

And events:

```text
Event
 ├── workspaceId   ← mandatory for workspace events
 ├── channelId     ← optional
 ├── agentId       ← optional
 └── payload
```

Routing:

```text
workspaceId
    │
    └── workspace:<id>

channelId
    │
    └── channel:<id>
```

No guessing.

No `"default"` fallback.

No global snapshot containing tenant state.

No socket that belongs to five workspace rooms simultaneously.

---

## Bottom line

**The phantom roster culprit is confirmed:** `emitRuntimeSnapshot()` reads `agents` through global `getDb()` and then broadcasts that global roster into workspace rooms.

But I would **not stop there**.

The audit shows that the same broken boundary exists in the Socket message path, runtime execution, event persistence, workspace/channel room admission, and background workers. If you only change the snapshot query, you'll make the UI look fixed while the backend can still execute Workspace A work against `default` or the global DB.

The clean fix is to establish a **real `WorkspaceContext` at every execution boundary**—HTTP, Socket, BullMQ, scheduler, maintenance—and make `workspaceId` a first-class field on events and runtime operations.

That gives you one rule:

> **If code is executing on behalf of a workspace, it must have an explicit WorkspaceContext. There is no silent fallback to `default`.**

That's the architectural change I'd make before doing any more roster-specific patches.
