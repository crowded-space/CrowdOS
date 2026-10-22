# Settings and Authority

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose
Reference description of CrowdOS's settings surface (the "Admin Console" modal) and of the two authority layers behind it: the **enforced** tier (`AgentLevel` → `AuthorityLevel` → `agents.authority_level`) and the **unenforced** parallel permission/role blobs. Covers the 13-tab registry, what each tab is authoritative for, the role model and its two divergent permission vocabularies, the agent identity fields the client projection loses, the avatar situation, and the identity slots a spec can fill without removing anything. Visual style is out of scope.

## How it works

### The settings surface is one modal, not a routed app

CrowdOS's settings is a single modal overlay — `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx` — opened over the workspace and dismissed by the X (`:1074-1081`) or the backdrop (`:981-987`). It is not URL-routable and it is not a second window.

Inside, a flat **13-entry array** (`tabs`, `:959-973`) drives the left navigation; the header title is derived from the same array (`:1072`), and the body is a chain of `workspaceSettingsTab === '<id>' && (...)` branches (`:1096-3121`) inside one `AnimatePresence` block keyed by the active tab id (`:1088`).

Two consequences follow from the array-and-branches shape:
* Adding a tab is **two edits** — one array entry and one branch — with no registry to keep in sync.
* Tab state is **one string in the store** (`workspaceSettingsTab`, `packages/client/stores/crowdOsStore.ts:548`), not a route. There is no deep link into a tab, no per-tab URL, and no back/forward behaviour.

### Two authority layers

**Layer (a) — the enforced tier.** Three names for one integer:

| Name | Where | Type |
|---|---|---|
| `AgentLevel` | client `packages/client/types/crowdOs.ts:4` | `0 \| 1 \| 2 \| 3` |
| `AuthorityLevel` | server `packages/server/src/agents/agent-types.ts:3` | `0 \| 1 \| 2 \| 3` |
| `agents.authority_level` | `packages/server/src/db/schema.ts:224` | `integer NOT NULL` |

The client sends it as `authorityLevel` on create (`crowdOsStore.ts:3012`) and on update (`:3056`); the server maps it back to `authorityLevel` (`packages/server/src/agents/agent-service.ts:50`). This is the only authority in CrowdOS that anything enforces:
* The Router treats authority level as a routing input and **forbids inverting** the mapping — "L0-L1 reasoning/specialist work → Research, Agentic, or Conversational; L2 orchestration → Swarm; L3 narrow execution → Agentic (or Conversational)" (`CrowdOS.md:1253`, `CrowdOS.md:1258-1271`, §25).
* The escalation chain walks the level downward — L3→L2, L2→L1, L1→User — and pauses the failing agent first (`packages/server/src/agents/agent-errors.ts:100-117`).

The rule that governs the whole layer: **authority comes from the level, never from the name or the label** (`CrowdOS.md:1502-1519`, §31; `UX_GUIDELINE.md:21` — "Name (e.g. Owl) carries no authority"). The client obeys this everywhere it renders the level.

**Layer (b) — the unenforced parallel blobs.** Two jsonb columns on `agents`:
* `permissions` — `{ spawnAgents, patchRuntime, accessAllChannels }` (`schema.ts:235`), typed as `AgentAuthorityPermissions` (`agent-types.ts:8-12`).
* `categoryPermissions` — `string[]` (`schema.ts:234`).

Both are **merged deny-by-default** on the server: `DEFAULT_PERMISSIONS` is all-`false` (`agent-service.ts:39-43`) and `normalizePermissions` merges a partial input over the existing blob without force-granting (`agent-service.ts:64-73`; `re-docs/Backend Docs/Domain Spec/Agents.md:131`). That merge is correct — but **nothing reads the result**: `re-docs/Backend Docs/Domain Spec/Agents.md:163` records that `categoryPermissions`, `isOmniscient` and the `permissions` blob "have no in-domain enforcement observed", and the Agents domain spec's own rule is explicit — "Permission blobs with no enforcement must be labeled advisory or wired to enforcement. Stored-but-unenforced permissions are not acceptable as a security boundary." (`Agents.md:147`).

**Stored-but-unenforced permissions are not a security boundary.** CrowdOS's real boundary is the tier.

### The role model is a cosmetic, client-side list

`Role` is a four-field client type — `{ id, name, color, permissions }` (`packages/client/types/crowdOs.ts:325-330`). The store holds `roles: Role[]` (`crowdOsStore.ts:523`), seeded from `initialRoles` (`crowdOsStore.ts:1903`, `packages/client/stores/initialData.ts:14-19`) and mutated by four local actions — `addRole` / `updateRole` / `reorderRoles` / `deleteRole` (`crowdOsStore.ts:677-680` for the signatures, `:3738-3763` for the bodies). Every one of them is a pure `set()` on the local array.

There is **no `localStorage` key for roles**. The store's persisted keys are `crowdos_workspaces`, `crowdos_agents`, `crowdos_model_profiles`, `crowdos_model_modules`, `crowdos_instruction_modules`, `crowdos_toolkit_modules`, `crowdos_constraints_modules`, `crowdos_capabilities_modules`, `crowdos_messages`, `crowdos_active_workspace`, `crowdos_active_channel`, `crowdos_pinned_modes`, `crowdos_muted_channels`, `crowdos_seq_cursors` (`crowdOsStore.ts:786-861`, `:2056`, `:2431-2435`, `:3046`) — no `crowdos_roles`. And there is **no server-side `roles` table**: `packages/server/src/db/schema.ts` declares no `roles` table and no `roleId` column on `agents`.

The role list is therefore **GLOBAL, not per-workspace** — one list for every workspace on the device — and it resets to `initialRoles` on reload.

The UI says so in two places, both inside the Permissions & Roles tab:
* `:1723` — the list header reads `Roles · local only`.
* `:1728` — "Display labels on this device — no server enforcement behind them."

### Two permission vocabularies that never meet

The Permissions & Roles tab renders switches from `ROLE_PERMISSIONS` (`WorkspaceSettingsModal.tsx:25-36`) — a **10-id** vocabulary: `administrator`, `view_channels`, `manage_channels`, `manage_roles`, `manage_agents`, `manage_skills`, `manage_tools`, `send_messages`, `read_history`, `mention_roles`.

The **seeded** roles use a **different** vocabulary (`initialData.ts:14-19`): `all`, `spawn_agents`, `patch_runtime`, `manage_budgets`, `kill_switch`, `task_assign`, `tool_invoke`, `patch_temporary`, `sandbox_exec`.

The two sets do not intersect except through the special case `'all'` and the explicit `administrator` check in the switch renderer (`:1820-1822`). Consequence: a seeded role's `permissions` array is not a subset of any `ROLE_PERMISSIONS` id, so the switches for a seeded role render **off** even though the role is seeded as privileged. The stored vocabulary is a leftover from an earlier authority model; the rendered vocabulary is the current one. Nothing reconciles them.

### The broken link: `Agent.roleId` never reaches the server

`Agent.roleId?: string` is declared (`packages/client/types/crowdOs.ts:19`). It is **set** in the Agents Board forms — the create form has a role `<select>` (`:1367-1372`) bound to `newAgentRoleId`, the edit form has one (`:1490-1495`) bound to `editAgentRoleId` — and both submit it: `roleId: newAgentRoleId || undefined` (`:649`) and `roleId: editAgentRoleId || undefined` (`:720`).

It is **never persisted**, because the store drops it on the way to the server:
* `addAgent` builds `body` from a fixed field list (`crowdOsStore.ts:3007-3021`) — `roleId` is not in it.
* `updateAgent` builds `body` field-by-field (`:3052-3065`) — `roleId` is not in it either.
* The hydration mappers do not read it back: the socket roster mapper (`:1556-1570`) and the REST roster mapper (`:2322-2337`) both copy `id, name, species, level, status, avatar, instructionModuleId, modelModuleId, toolkitModuleId, description, isOmniscient, createdAt, lastActive` — no `roleId`.

**Observable consequence:** a role badge on an agent would be blank after any reload. The selection survives only until the next `fetchWorkspaces()` (`crowdOsStore.ts:3028`, `:3074`), which replaces the roster wholesale.

### The avatar is derived, not chosen

`avatar` is a server column of type `text` holding **one emoji glyph** (`schema.ts:223`; `agent-types.ts:22`). There is no image path, no upload, no URL, no icon id.

It is **computed from the agent's level at create/edit time**:
* create — `avatar: newAgentLevel === 0 ? '🦅' : newAgentLevel === 1 ? '🐦' : newAgentLevel === 2 ? '🦉' : '🤖'` (`:641`)
* edit — the same mapping over `editAgentLevel` (`:721`)

So the avatar is a **function of the tier**, not an independent identity slot: L0 eagle, L1 bird, L2 owl, L3 robot. There is **no UI control** for it anywhere in the Agents Board create or edit form. Changing the level silently overwrites the glyph. The store's own fallbacks agree: `avatar: agent.avatar || '🤖'` on create (`crowdOsStore.ts:3011`) and `'🤖'` in both hydration mappers (`:1562`, `:2328`).

Three renderers print the glyph raw, with no fallback component and no image handling:
* `packages/client/components/workspace/AgentRow.tsx:82-87` — the roster tile (`{avatar || <Bot size={16} …/>}`).
* `packages/client/components/workspace/modals/AgentProfileModal.tsx:219-225` — the profile avatar disc (`{agent.avatar || '🤖'}`).
* `packages/client/components/studio/AgentStudioModal.tsx:188-190` — the studio header chip (`{agent.avatar || '🤖'}`).

**The house pattern that already exists for a picker** is the *workspace* icon model, not the agent avatar:
* `Workspace.icon` is a stored field.
* `WORKSPACE_ICONS` is a named-variant set (`packages/client/components/portal/WorkspaceManageDialogs.tsx:8`) rendered through `CrowIcon` (`:57`).
* `packages/client/components/ui/CrowIcon.tsx` declares **8 named vector variants** (`:3-12`) plus `mapEmojiToCrowVariant` (`:21-46`), which maps a known emoji to a variant and otherwise **hashes the string** into one of the 8.

That is a complete "pick an icon" implementation already living in the repo — it is simply not wired to agents.

### Agent identity: server field set vs client projection

Server `AgentProfile` (`packages/server/src/agents/agent-types.ts:16-47`): `id`, `workspaceId`, `name`, `title`, `species`, `avatar`, `authorityLevel`, `l3Subtype`, `modelModuleId`, `instructionModuleId`, `toolkitModuleId`, `constraintsModuleId`, `capabilitiesModuleId`, `memorySharingPolicy`, `isOmniscient`, `fallbackAgentId`, `categoryPermissions`, `permissions`, `status`, `isTemplate`, `contextTokenCap`, `createdAt`, `updatedAt`.

The client `Agent` type (`packages/client/types/crowdOs.ts:6-25`) has 15 fields and **loses nine server fields on the way in**:

| Server field | Client | Note |
|---|---|---|
| `title` | → `description` | renamed, not lost (`crowdOsStore.ts:1566`, `:2333`) |
| `l3Subtype` | — | lost |
| `memorySharingPolicy` | — | lost (the client computes it on create, `crowdOsStore.ts:3018`) |
| `fallbackAgentId` | — | lost |
| `categoryPermissions` | — | lost |
| `permissions` | — | lost |
| `isTemplate` | — | lost |
| `workspaceId` | — | lost (scoping happens server-side) |
| `roleId` | declared, never sent | the broken link above |

`workspaceId` loss is benign (the client scopes by its own active workspace); the other seven mean the Agent Profile dossier can only ever show what the client happens to hold.

## Structural inventory

### The Admin Console tab registry

| Tab | Purpose | File:line | Configures | Server-authoritative? |
|---|---|---|---|---|
| Workspace | Workspace identity, agent/channel counts, storage sync + DB conflict resolution | `WorkspaceSettingsModal.tsx:960` (body `:1096-1149`) | workspace name, `storagePreference`, `databaseUrl` | **Yes** — workspace row + DB sync state |
| Agents Board | Agent create/edit/delete/duplicate, module refs, tier, role pick, avatar (derived) | `:961` (body `:1152-1716`) | `agents` row: name, species, `authorityLevel`, module ids, `isOmniscient`, `contextTokenCap`, `title` | **Partly** — the agent row is; `roleId` is dropped (`crowdOsStore.ts:3007-3021`, `:3052-3065`) and `avatar` is recomputed from the level (`:641`, `:721`) |
| Permissions & Roles | Cosmetic role list (name, colour, permission switches), drag-reorder | `:962` (body `:1718-1856`) | client-only `Role[]` | **No** — "local only" (`:1723`), "no server enforcement behind them" (`:1728`) |
| Security Tools Whitelist | Local enable/disable toggles over the tool catalogue | `:963` (body `:1859-1900`) | client-only `Tool[].enabled` | **No** — "they flip the local tool list only and enforce nothing server-side" (`:1863`) |
| Model Modules | Model module records | `:964` (body `:1901-1905`) → `<ModelCardsTab />` (`:1902`) | `model_modules` | **Yes** — Modules domain |
| Skills Manager | Skill / instruction / toolkit / constraints / capabilities module records | `:965` (body `:2253-2797`) | `instruction_modules`, `toolkit_modules`, … | **Yes** — Modules + Skills domains |
| Category & Channels | Category and channel CRUD | `:966` (body `:1906-2252`) | `categories`, `channels` | **Yes** — Channels domain |
| Mounts | Filesystem mount chain inspector (Workspace → Category → Channel) | `:967` (body `:3107-3110`) → `<MountsInspector />` (`:3108`) | `fs_mounts` on categories, `fs_policy` on `channel_settings` | **Yes** — Channels / ChannelMounts domains |
| Storage | Per-workspace bytes, cache clear, vacuum, reindex, verify, export | `:968` (body `:3111-3114`) → `<StorageTab />` (`:3112`) | local storage tier + optional DB | **Partly** — local files are authoritative; the DB tier is optional (`schema.ts:1053-1072`) |
| Diagnostics | Observability counters and spans | `:969` (body `:3115-3118`) → `<DiagnosticsTab />` (`:3116`) | read-only | Read-only |
| Audit | Filterable audit events + export | `:970` (body `:3119-3121`) → `<AuditTab />` (`:3120`) | read-only | Read-only |
| Safety Policies | Human approval / rate limit / emergency kill, plus the safety settings payload | `:971` (body `:2798-3097`) | **mixed**: `humanApproval`, `rateLimit`, `emergencyKill` are component-local `useState` (`:618-623`, rendered `:3027`, `:3041`, `:3086`) with **no server write**; the rest of the tab reads the server safety payload | **Partly** — the three headline toggles are local-only display; the payload behind them is server-held |
| Screen Lock | Screen-lock PIN | `:972` (body `:3098-3106`) → `<ScreenLockSettingsPanel />` (`:3100`) | screen-lock store | **Local** — device-scoped |

Tab registry source: `WorkspaceSettingsModal.tsx:959-973`. Body router: `:1096-3121`. Left nav: `:1005-1024` (the label `Admin Console` is at `:1002`). Delete-Workspace is pinned below the nav (`:1026-1063`), not a tab.

### The other settings-adjacent surfaces

| Surface | File | What it is | Authority |
|---|---|---|---|
| Agent Studio | `packages/client/components/studio/AgentStudioModal.tsx` | Modular rack (instruction / model / toolkit / constraints / capabilities slots) + prompt x-ray | **Server-authoritative** — manifest `GET /api/studio/agents/{id}/manifest` (`:65`), `PUT` (`:147`), prompt inspection `POST /api/studio/inspect-prompt` (`:117`), skills `GET /api/skills` (`:84`), MCP `GET /api/mcp/servers` (`:94`) |
| Agent Profile | `packages/client/components/workspace/modals/AgentProfileModal.tsx` | Identity dossier: name, Level badge (`:237`), species, status, description, modular-assembly summary, per-agent context cap (`:136`, `:155-158`), avatar disc (`:219-225`) | Display of a lossy client projection (see above) |
| Omni-search palette | `packages/client/components/workspace/modals/OmniSearchModal.tsx` + `modals/palette-verbs.ts` | Search over agents (`:159-161`), channels, tools and messages, plus **16 verbs** with a `scope` (`channel`/`workspace`/`run`/`global`) and a `risk` (`safe`/`confirm`/`destructive`) — `switch-channel`, `switch-workspace`, `set-runtime`, `pin-runtime`, `mute-channel`, `clear-history`, `mount-folder`, `open-diff`, `approve-first`, `deny-first`, `retry-run`, `cancel-run`, `open-inbox`, `lock-screen`, `open-quick-ask`, `ask-l0-in-place` (`palette-verbs.ts:82-99`) | Every verb `run()` calls a real store action (`palette-verbs.ts:72-79`); read-only otherwise. The agent row prints `{species} · L{level}` (`OmniSearchModal.tsx:371`) |
| QuickAsk | `packages/client/components/workspace/QuickAsk.tsx` | Direct-to-agent capture prompt, opened by the `crowdos:quick-ask-open` window event (`palette-verbs.ts:97`) | None — transient |
| Operator Profile | `packages/client/components/workspace/operator-profile-model.ts` + `modals/OperatorProfileModal.tsx` | Operator identity `{ name, tag, preference }` (`operator-profile-model.ts:3-8`) stored under `crowdos_operator` (`:10`); defaults `Local operator` / `Human` (`:11-12`) | **Local only** |
| Workspace icon picker | `packages/client/components/portal/WorkspaceManageDialogs.tsx:8`, `:57` + `packages/client/components/ui/CrowIcon.tsx` | The existing named-icon picker: 8 `crow-*` vector variants (`CrowIcon.tsx:3-12`), emoji→variant map with a hash fallback (`:21-46`) | **Server-authoritative** via `Workspace.icon` |

### Where the tier is displayed

| Surface | Form | File:line |
|---|---|---|
| Roster | tier groups `L0 — Surveillance` / `L1 — Executive` / `L2 — Coordinators` / `L3 — Workers`, each with a count badge | `packages/client/components/workspace/RightSidebar.tsx:179-182`, `:377-482` |
| Roster row | `L{level}` chip next to species | `packages/client/components/workspace/AgentRow.tsx:98` |
| Agent Profile | `Level {agent.level}` badge | `packages/client/components/workspace/modals/AgentProfileModal.tsx:237` |
| Agents Board | `Tier` column, `L{ag.level}` chip | `WorkspaceSettingsModal.tsx:1633`, `:1643-1646` |
| Agent Studio header | `Tier L{agent.level ?? 3}` | `packages/client/components/studio/AgentStudioModal.tsx:197` |
| Omni-search | `{species} · L{level}` | `packages/client/components/workspace/modals/OmniSearchModal.tsx:371` |

Every one of these prints the **level**. None prints the role. That is the correct posture against `UX_GUIDELINE.md:21` and `CrowdOS.md:1502-1519`.

### The four identity slots a spec can fill without removing anything

1. **An avatar/icon control beside Species in the Agents Board create/edit forms.** The field, the type and the server column already exist (`schema.ts:223`); only the *control* is missing, and the house pattern for it (`WORKSPACE_ICONS` + `CrowIcon`) already exists. It needs no new table, no new column and no new endpoint — only a picker, plus a store change so the avatar stops being overwritten from the level (`:641`, `:721`).
2. **The Agent Profile dossier.** The surface is already rich; its gap is the **lossy projection**, not a missing surface. Recovering `l3Subtype`, `memorySharingPolicy`, `fallbackAgentId`, `permissions` and `categoryPermissions` on the client is a mapper change (`crowdOsStore.ts:1556-1570`, `:2322-2337`), not a UI change.
3. **Per-agent authority display on `AgentRow`.** Needs either the server `permissions` blob surfaced to the client, or a persisted `roleId` mapped back in. Either way the display must sit **beside** the tier chip, never replace it.
4. **A channel-scoped agent list.** Needs a channel-membership model that **does not exist today**: `channel_settings` carries only `fsPolicy`, `safetySettings`, `pinnedRuntime`, `activeAgentId`, `defaultAgentId` (`schema.ts:1059-1072`), there is no `channel_members` table (`schema.ts` declares none), and the only per-channel participant set is derived from message authors.

## Implementation details

* The tab array and the body router are two separate places to edit for a new tab (`WorkspaceSettingsModal.tsx:959-973` and `:1096-3121`). The header title is derived from the array, so a tab added to the array but not to the router renders an empty body under a correct title (`:1072`).
* Only the **Workspace**, **Agents Board**, **Model Modules**, **Skills Manager**, **Category & Channels**, **Mounts** and **Storage** tabs reach the server. The Agents Board does so through the store's `addAgent` / `updateAgent` actions, not directly from the component (`:636`, `:710`).
* The Agents Board form calls `addAgent` / `updateAgent` with a **client-shaped** payload (`Agent`), and the store is the only place that translates it into the server's wire shape (`crowdOsStore.ts:3007-3021`, `:3052-3065`). That translation is where `roleId` is lost — the component does send it.
* `updateAgent` deliberately sends only changed fields, and the comment says so: "Permissions are advisory-only here; the backend merges partial updates over the existing deny-by-default blob. Never force-grant." (`crowdOsStore.ts:3066-3067`). No permission field is sent at all.
* `addAgent` computes `memorySharingPolicy` from the level — `full` for L0/L1, `vertical` otherwise (`:3018`) — and hard-codes a full permission grant `permissions: { spawnAgents: true, patchRuntime: true, accessAllChannels: true }` (`:3019`). The latter contradicts the deny-by-default merge on the server and is one reason the blob is not a boundary.
* The Agents Board offers a **preset template** dropdown that fills name, species, level, description and module ids (`WorkspaceSettingsModal.tsx:1199-1209`), plus an "Import agent" JSON file input (`:1160-1173`) whose parser reads `roleId` (`:790`) — so an imported agent's role lands in the same dead end.
* `handleDuplicateAgent` copies name, species, level and module refs (`:730-740`); because the avatar is recomputed from the level, the duplicate inherits the tier glyph.
* The Safety tab's three headline toggles are plain `useState` in the modal component (`:618-623`) with an explicit comment: "Local safety option toggles (display-only preferences: nothing behind them enforces server-side, so the copy must say so — a silent checkbox would imply enforcement that does not exist." (`:618-620`). This is the same honesty rule the roles and tools tabs follow.
* The Agents Board table renders `Agent`, `Species`, `Tier`, `Status`, `Actions` (`:1630-1636`) — there is **no Role column**, which is why the broken link is invisible in the UI.
* The `Role` type has no hierarchy field. There is no "position", no "higher than", no precedence — unlike Discord's `position`-ordered roles.

## Interaction model

| Action | Target | Result | Evidence |
|---|---|---|---|
| Open the console | workspace header | modal opens; last tab persists in `workspaceSettingsTab` | `WorkspaceSettingsModal.tsx:978`, `crowdOsStore.ts:548` |
| Switch tab | left nav | branch swaps inside one `AnimatePresence`; title follows the array | `:1006-1023`, `:1085-1093`, `:1072` |
| Create an agent | Agents Board form | `addAgent` → `POST /api/agents` → `fetchWorkspaces()` reloads the roster | `:636`, `crowdOsStore.ts:3023-3028` |
| Edit an agent | Agents Board row | `updateAgent` → `PUT /api/agents/{id}`; avatar recomputed from the new level | `:710-723`, `crowdOsStore.ts:3069-3074` |
| Pick a role for an agent | role `<select>` | sets local state only; the value **does not survive a reload** | `:1367-1372`, `:1490-1495`, `crowdOsStore.ts:3007-3021` |
| Toggle a role permission | permission switch | flips `selectedRole.permissions` in memory; the `'all'` / `'administrator'` entries disable the rest | `:1819-1845`, `:1820-1822` |
| Create / rename / recolour / reorder / delete a role | roles list | pure local `set()`; no persistence, no server call | `:1738-1763` |
| Toggle a tool | Security Tools tab | flips the local tool list only | `:1859-1900`, `:1863` |
| Open Agent Studio | Agents Board "Studio" action, or profile "Modular assembly" | manifest fetched from the server; slot edits committed with `PUT` | `:1653-1659`, `AgentStudioModal.tsx:65`, `:147` |
| Read an agent's tier | roster / profile / board / omni-search | `L{n}` or `Level n` rendered | `RightSidebar.tsx:381-475`, `AgentRow.tsx:98`, `AgentProfileModal.tsx:237`, `WorkspaceSettingsModal.tsx:1645`, `OmniSearchModal.tsx:371` |
| Run a palette verb | Omni-search palette | one of 16 verbs; each calls a real store action | `palette-verbs.ts:82-99` |
| Change the workspace icon | workspace manage dialog | picks from `WORKSPACE_ICONS`; rendered via `CrowIcon` | `WorkspaceManageDialogs.tsx:8`, `:57`, `CrowIcon.tsx:48` |

## Performance notes

* The tab registry is a 13-element array literal rebuilt on every render of the component (`WorkspaceSettingsModal.tsx:959-973`) and mapped to 13 buttons (`:1006`). The `tabs.find(...)` for the header title (`:1072`) is a linear scan of 13 items — negligible, but re-created on every render rather than hoisted.
* Only the **active** tab's branch is mounted: each branch is a `&&` guard on `workspaceSettingsTab`, so an inactive tab's subtree is not rendered. `AnimatePresence mode="wait"` (`:1086`) holds the outgoing branch for the 150 ms transition (`:1092`), which means two tab subtrees are briefly alive at once.
* The role list is a plain array (`roles.map`, `:1730`, `:1819`) with no index, no memoisation and no virtualisation — unbounded in principle, four rows in practice.
* Agent hydration is a **full roster replace**, not a patch: `fetchWorkspaces()` re-fetches agents and re-maps every row (`:2318-2338`), and both `addAgent` and `updateAgent` call it afterwards (`:3028`, `:3074`). The roster is mirrored to `localStorage` on each pass (`:1573`, `:2432`).
* The Agents Board table renders one `<tr>` per agent with no pagination or virtualisation (`:1639-1711`).
* `mapEmojiToCrowVariant` reduces the emoji to a character-code sum and takes it modulo 8 (`CrowIcon.tsx:33-44`) — O(n) in the emoji's code units, constant work.

## Evidence

| Source | What it shows |
|---|---|
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:959-973` | The 13-tab registry |
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:1096-3121` | The body router (13 branches) |
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:1723`, `:1728` | "local only" and "no server enforcement behind them" |
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:1863` | "they flip the local tool list only and enforce nothing server-side" |
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:25-36` | The 10-id `ROLE_PERMISSIONS` vocabulary |
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:641`, `:721` | Level-to-emoji avatar derivation |
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:649`, `:720`, `:1367-1372`, `:1490-1495` | `roleId` set in the forms, never persisted |
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:618-623`, `:3027`, `:3041`, `:3086` | The three local-only safety toggles |
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:1630-1636`, `:1643-1646` | Agents Board columns and the Tier chip |
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:730-740`, `:790`, `:1199-1209` | Duplicate, import and preset paths |
| `packages/client/types/crowdOs.ts:4` | `AgentLevel = 0 \| 1 \| 2 \| 3` |
| `packages/client/types/crowdOs.ts:19` | `roleId?: string` on `Agent` |
| `packages/client/types/crowdOs.ts:325-330` | `Role { id, name, color, permissions[] }` |
| `packages/client/stores/crowdOsStore.ts:523`, `:1903` | `roles: Role[]` slice and its seed |
| `packages/client/stores/crowdOsStore.ts:677-680`, `:3738-3763` | The four role actions, all local |
| `packages/client/stores/crowdOsStore.ts:3007-3021`, `:3052-3065`, `:3066-3067` | `addAgent` / `updateAgent` bodies — no `roleId`; advisory-permissions note |
| `packages/client/stores/crowdOsStore.ts:1556-1570`, `:2322-2337` | The two hydration mappers — no `roleId`, no `permissions` |
| `packages/client/stores/initialData.ts:14-19` | Seeded roles with a **different** permission vocabulary |
| `packages/server/src/agents/agent-types.ts:3`, `:8-12`, `:16-47` | `AuthorityLevel`, `AgentAuthorityPermissions`, `AgentProfile` |
| `packages/server/src/db/schema.ts:215-251` | The `agents` table (`:223` avatar, `:224` authority_level, `:234` category_perms, `:235` permissions) |
| `packages/server/src/db/schema.ts:1059-1072` | `channel_settings` — no membership model |
| `packages/server/src/agents/agent-service.ts:39-43`, `:64-73` | `DEFAULT_PERMISSIONS` deny-by-default and the merge |
| `packages/server/src/agents/agent-errors.ts:100-117` | Pause-first, then the L3→L2→L1→User escalation chain |
| `packages/client/components/workspace/AgentRow.tsx:82-87`, `:98` | Raw avatar render; `L{level}` chip |
| `packages/client/components/workspace/modals/AgentProfileModal.tsx:219-225`, `:237` | Raw avatar render; Level badge |
| `packages/client/components/studio/AgentStudioModal.tsx:65`, `:117`, `:147`, `:188-190`, `:197` | Manifest GET/PUT, prompt inspection, raw avatar render, tier chip |
| `packages/client/components/workspace/modals/palette-verbs.ts:72-99` | The 16 palette verbs and their risk/scope taxonomy |
| `packages/client/components/workspace/operator-profile-model.ts:3-15` | Operator profile shape and the `crowdos_operator` key |
| `packages/client/components/workspace/RightSidebar.tsx:179-182`, `:377-482` | Roster tier groups |
| `packages/client/components/workspace/modals/OmniSearchModal.tsx:159-161`, `:371` | Omni-search agent matching and the `{species} · L{level}` row |
| `packages/client/components/ui/CrowIcon.tsx:3-12`, `:21-46` | 8 named variants and the emoji-to-variant hash fallback |
| `packages/client/components/portal/WorkspaceManageDialogs.tsx:8`, `:57` | The existing workspace icon picker |
| `re-docs/Backend Docs/Domain Spec/Agents.md:131`, `:147`, `:163` | The deny-by-default merge, the "not acceptable as a security boundary" rule, and the no-enforcement observation |
| `CrowdOS.md:1253`, `:1258-1271`, `:1502-1519` | Authority as a Router input, the no-inversion rule, the level model (§25, §31) |
| `UX_GUIDELINE.md:21` | "Name (e.g. Owl) carries no authority" |

## Gaps
1. **Roles are not persisted.** No `localStorage` key, no server table, no hydration. A role the user creates is lost on reload and the seeded set returns.
2. **Roles are global, not per-workspace.** One `roles: Role[]` slice for every workspace on the device, with no `workspaceId` on `Role` (`packages/client/types/crowdOs.ts:325-330`).
3. **The role-to-server link is broken.** `Agent.roleId` is set by the UI and dropped by the store (`crowdOsStore.ts:3007-3021`, `:3052-3065`), so a role badge is blank after a reload.
4. **Two permission vocabularies.** `ROLE_PERMISSIONS` (`WorkspaceSettingsModal.tsx:25-36`) and the seeded roles' vocabulary (`initialData.ts:14-19`) do not intersect; a seeded role renders as having no permissions.
5. **Permission enforcement does not exist.** `permissions` and `categoryPermissions` are stored, merged deny-by-default, and never read (`re-docs/Backend Docs/Domain Spec/Agents.md:163`).
6. **The safety tab's three headline toggles are local-only** (`humanApproval`, `rateLimit`, `emergencyKill`, `WorkspaceSettingsModal.tsx:618-623`) while the tab reads as a policy surface.
7. **No avatar control.** No image, photo, icon, URL or upload path for an agent; the glyph is derived from the level (`:641`, `:721`) and printed raw by three renderers.
8. **No binary avatar serving.** The `avatar` column is `text` holding one glyph (`schema.ts:223`); there is no artifact/blob path for an agent image, and no content-type or size story for one.
9. **No channel-membership model.** `channel_settings` carries only `fsPolicy`, `safetySettings`, `pinnedRuntime`, `activeAgentId`, `defaultAgentId` (`schema.ts:1059-1072`); there is no `channel_members` table, and the only per-channel participant set is derived from message authors.
10. **The client loses seven server identity fields** (`l3Subtype`, `memorySharingPolicy`, `fallbackAgentId`, `categoryPermissions`, `permissions`, `isTemplate`, `workspaceId`) in the two hydration mappers (`crowdOsStore.ts:1556-1570`, `:2322-2337`).
11. **The settings surface is a modal, not a routed app.** No URL per tab, no deep link, no back/forward, no per-tab history. This is the structural difference from Discord's registry-driven settings — see `## Comparison hooks`.
12. **No unsaved-changes guard.** Every role edit and module edit applies immediately ("Autosaved", `:1763`); there is no Save/Reset bar and no discard prompt, because there is nothing to discard.

## User Decision:

## Target Contract
> Status: Target. CrowdOS's authority contract is locked and takes precedence over any Discord pattern: authority comes from the agent **level**, never from a name, label, colour, badge or role (`UX_GUIDELINE.md:21`, `CrowdOS.md:1502-1519`, `CrowdOS.md:1258-1271`). Nothing below may weaken that.

* Authority MUST remain a function of `authorityLevel` alone. A `Role`, a colour, a badge, or a display label MUST NOT grant, imply, or gate any capability.
* Any surface that displays a role MUST display the agent's tier next to it, so a role can never be read as authority.
* Stored-but-unenforced permission blobs MUST NOT be presented as a security boundary. Either wire `permissions` / `categoryPermissions` to enforcement, or label them advisory wherever they are visible.
* If roles are persisted, they MUST be either per-workspace (scoped by `workspaceId`) or explicitly declared global and device-local, and that declaration MUST appear in the Domain Spec.
* If `Agent.roleId` is wired to the server, it MUST be added to the `agents` table (or a dedicated table) and hydrated back into the client mapper. A role that is settable but not readable is a defect, not a placeholder.
* The two permission vocabularies MUST be reconciled to one list, or one of them MUST be removed. A role whose permissions render as empty is a false statement in the UI.
* An agent avatar, if a control is added, MUST be independent of the tier. The tier MAY seed a default, but it MUST NOT overwrite a user-chosen avatar on edit.
* If an avatar control is added, it SHOULD reuse the existing `WORKSPACE_ICONS` + `CrowIcon` named-variant pattern rather than inventing a second icon system.
* Any channel-scoped agent surface MUST be backed by an explicit membership model; deriving membership from message authorship MUST NOT be presented as membership.
* If the client is to display the agent's authority, the projection MUST be widened to carry the server fields it needs. A dossier that silently omits `l3Subtype`, `memorySharingPolicy`, `fallbackAgentId` and `permissions` is a partial dossier and MUST be described as one.

## Comparison hooks

| CrowdOS surface | Discord counterpart | Discord findings doc | What differs |
|---|---|---|---|
| Admin Console modal, 13 tabs in one array (`WorkspaceSettingsModal.tsx:959-973`, body `:1096-3121`) | Registry-driven settings: 42 section slugs → 25 sidebar items → 31 panels → 85 categories → 102 settings, all from **one contiguous enum of 535 ids**; nav state in the URL (`/settings/<section>/<subsection?>`) | [Settings Surface.md](../Discord%20Findings/Settings%20Surface.md) | Discord's settings is **routed, URL-addressable and registry-driven**; CrowdOS's is a **modal with an array and a branch chain**, so a tab is two edits, has no deep link, and has no per-tab identity |
| Permissions & Roles tab (`:1718-1856`) | Guild roles page: per-role card (name, colour, gradient, icon, hoist, mentionable, description, permission counts, position), reordered by a server-assigned `position`; channel-permission matrix with Basic ↔ Advanced views and 8 subject kinds | [Roles and Authority.md](../Discord%20Findings/Roles%20and%20Authority.md) | Discord's roles are **server-owned, ordered and enforced**; CrowdOS's are a **client-only, unordered, unpersisted** list whose own UI says "no server enforcement behind them" (`:1728`) |
| `ROLE_PERMISSIONS` 10-id vocabulary (`:25-36`) | ~43 named permission **bits** grouped into 14 named groups, each entry carrying title + description + flag; searchable with an explicit empty state | [Roles and Authority.md](../Discord%20Findings/Roles%20and%20Authority.md) | Discord's matrix is **flag-keyed and server-resolved**; CrowdOS's is a **string-id list on a local array**, and the seeded roles use a third, different vocabulary (`initialData.ts:14-19`) |
| `Role` type with no hierarchy, no position (`packages/client/types/crowdOs.ts:325-330`) | Role hierarchy by `position`; "higher role than you" is a position comparison; hoisted roles define member-list groups; the owner is a guild field with all permissions | [Roles and Authority.md](../Discord%20Findings/Roles%20and%20Authority.md) | CrowdOS has **no hierarchy and no elevated comparison** — it does not need one, since tier is the hierarchy — and it also has **no owner concept**, which is a deliberate absence, not an omission |
| Agents Board `Tier` column, roster tier groups, `L{n}` chips | Member list grouped by **hoisted role**, not by tier; role colour applied to the member's name, plus a crown decorator for the owner | [Right Panel and Members.md](../Discord%20Findings/Right%20Panel%20and%20Members.md), [Roles and Authority.md](../Discord%20Findings/Roles%20and%20Authority.md) | Both group a member list, but Discord's groups are **authority-bearing** (hoisted role) while CrowdOS's are **tier-bearing** and authority-neutral by contract |
| `AgentRow` avatar tile (`AgentRow.tsx:82-87`), level chip (`:98`) | Member row: role-coloured name, avatar, presence dot; a separate "Show / Hide Member List" toggle in the channel header | [Right Panel and Members.md](../Discord%20Findings/Right%20Panel%20and%20Members.md) | CrowdOS's avatar is a **tier-derived emoji** with no control; Discord's is an **uploaded avatar** with its own upload surface. CrowdOS already has the analogous control for **workspaces** (`WORKSPACE_ICONS` + `CrowIcon`), which is the pattern to reuse |
| `Agent.level` → `authorityLevel` → `agents.authority_level` (three names, one integer) | Discord has **no tier at all** — authority is a role/permission resolution recomputed at render time from roles + channel overwrites | [Roles and Authority.md](../Discord%20Findings/Roles%20and%20Authority.md) | Discord is **role-derived**; CrowdOS is **level-derived**. Discord's model cannot be copied without inverting `CrowdOS.md:1258-1271` |
| Omni-search palette: 16 verbs with `scope` + `risk` (`palette-verbs.ts:82-99`), search over agents / channels / tools / messages | Discord has **two** search surfaces: a settings search (four-event telemetry chain over the registry) and a chat command palette ("Search, members, media, pins, threads, and more") | [Settings Surface.md](../Discord%20Findings/Settings%20Surface.md), [Interaction Vocabulary.md](../Discord%20Findings/Interaction%20Vocabulary.md) | CrowdOS has **one** palette with an explicit risk taxonomy; Discord has a settings-registry search that CrowdOS's settings modal has no equivalent of |
| Admin Console: no unsaved-changes guard; edits apply immediately ("Autosaved", `:1763`) | Explicit `"Save Changes"` + `"Settings successfully updated."`; leaving with edits raises `"Discard unsaved changes?"` with `"Keep Editing"` / `"Discard"`, scoped per editor | [Settings Surface.md](../Discord%20Findings/Settings%20Surface.md) | Discord **stages then commits**; CrowdOS **applies immediately** — safe only because most of the surface is cosmetic |
| Safety Policies tab: three headline toggles are local `useState` (`:618-623`) | Discord's safety surfaces are registry-backed server settings (Automod, Content Moderation) reachable under `Server Settings > Community` | [Settings Surface.md](../Discord%20Findings/Settings%20Surface.md) | Discord's safety settings are **server-owned and routed**; CrowdOS's headline toggles are **component-local and explicitly labelled as enforcing nothing** |
