# Agent Studio

## Purpose

Edit an existing agent's modular slot manifest (model, instruction stack, skills) and inspect its compiled prompt, via a modal. Edit-only: there is no create flow in this component.

## Feature Scope

In-scope: loading an agent's slot manifest, hot-swapping model / instruction / skill slots, read-only view of resolved tools, X-Ray prompt inspection, saving the manifest.

Non-goals (other areas): agent CRUD (Agent Profile modal + `crowdOsStore` agent actions), module catalog management (Workspace Settings), skills/MCP server administration (server-side), chat/composer UX (Main Chat).

## Expect

- `[Observed]` Renders nothing unless `open` is true AND the agent exists in the store (`AgentStudioModal.tsx:156`).
- `[Observed]` Rack tab shows four slot cards: model select, instruction stack add/remove, skill toggle cards, and a read-only resolved-tools list.
- `[Observed]` Skill cards toggle attach/detach locally; nothing persists until Save.
- `[Observed]` Save PUTs the manifest, shows a success toast, and closes the modal on success (`AgentStudioModal.tsx:142-144`).
- `[Observed]` X-Ray tab compiles context on first visit and renders token estimate, provider, tool count, history count, and the full system prompt text.
- `[Observed]` The `'patch'` tab value exists in state but has no button and no content — unreachable.
- `[Observed]` Toolkit / constraints selections load from the manifest but have no UI controls — not editable here.
- `[Inferred]` Changes take effect next turn via socket hot-swap (footer copy only; the client verifies nothing after save).

## Flow

1. Open from profile: user clicks Studio in `AgentProfileModal` (`AgentProfileModal.tsx:211` sets `studioOpen`; `AgentProfileModal.tsx:533-536` renders `<AgentStudioModal agentId open onClose>`).
2. Load: on `open && agentId`, effect GETs manifest, skills catalog, and MCP servers (`AgentStudioModal.tsx:50-93`).
3. Edit rack: model select (`AgentStudioModal.tsx:245-254`); instruction add (`AgentStudioModal.tsx:321-338`) / remove (`AgentStudioModal.tsx:304-312`); skill toggle (`AgentStudioModal.tsx:354-396`).
4. Inspect: switching to X-Ray auto-runs inspection when no result exists (`AgentStudioModal.tsx:203-207`); Re-Compile posts test input (`AgentStudioModal.tsx:441-448` → `96-123`); stats and system prompt render (`AgentStudioModal.tsx:459-491`).
5. Save: Save & Commit PUTs slot ids (`AgentStudioModal.tsx:509-516` → `126-154`); Cancel discards silently (`AgentStudioModal.tsx:503-508`).
6. Dead path: `WorkspaceSettingsModal` Studio button sets `studioAgentId` (`WorkspaceSettingsModal.tsx:1610`, state `:335`) but no `<AgentStudioModal` render site was observed in that file.

## Current Implementation

| Piece | Role |
|---|---|
| `AgentStudioModal` (`components/studio/AgentStudioModal.tsx`, single file, no subcomponents) | Modal shell + all slot UIs + X-Ray + save logic; all state local `useState` |
| Header (`AgentStudioModal.tsx:169-222`) | Agent identity (avatar, name, tier, species) + Rack / X-Ray tab buttons + close |
| Slot 1 card (`AgentStudioModal.tsx:229-263`) | Model-module `<select>`; empty value = default Gemini Flash |
| Slot 2 card (`AgentStudioModal.tsx:266-340`) | Ordered instruction-layer list with remove buttons + "snap brick" add select |
| Slot 3 card (`AgentStudioModal.tsx:343-397`) | Skills catalog as toggle cards with required-tool chips |
| Slot 4 card (`AgentStudioModal.tsx:400-429`) | Resolved tools as read-only badges (native vs MCP) |
| X-Ray panel (`AgentStudioModal.tsx:434-493`) | Test-input box, Re-Compile button, 4 stat tiles, system-prompt `<pre>` |
| Footer (`AgentStudioModal.tsx:497-518`) | Hot-swap note + Cancel / Save & Commit |

## Props & Store

Props: `agentId: string | null`, `open: boolean`, `onClose: () => void` (`AgentStudioModal.tsx:11-15`).

Store slices read (no writes): `agents`, `modelModules`, `instructionModules`, `toolkitModules`, `constraintsModules` (`AgentStudioModal.tsx:18-24`). Toast via `useToast` (`ToastProvider`). Everything else is local `useState`.

## Relations

- Parents: `AgentProfileModal` (live render); `WorkspaceSettingsModal` (imports + state, render unobserved).
- Children: none — raw elements + `lucide-react` icons + `motion/react` wrappers.
- Store: `crowdOsStore` (read-only lookup `agents.find`, `AgentStudioModal.tsx:47`).
- API (bare `fetch`; PIN attached by the global patch, see Client Infra): `GET /api/studio/agents/:id/manifest`, `GET /api/skills`, `GET /api/mcp/servers`, `POST /api/studio/inspect-prompt`, `PUT /api/studio/agents/:id/manifest`.

## Emits-Listens

- Socket sent: none. Socket received: none.
- Store actions called: none.
- Toasts: `showSuccess` (context assembled, manifest committed), `showError` (inspection/save failures).

## Owns

Local state only: `activeTab`, `loading`, `saving`, `inspecting`, slot selections (`selectedModelId`, `selectedInstructionIds`, `selectedSkillIds`, `selectedToolkitId`, `selectedConstraintsId`), `availableSkills`, `resolvedTools`, `mcpServers`, `testUserInput`, `inspectionResult`. No cache, no persistence.

## Flags

None. No env vars or toggles.

## Decisions

- `[Observed]` Manifest editing state lives entirely in local `useState` and is pushed in one PUT — no per-slot saves, no store mirror.
- `[Observed]` `runtimeType: 'agentic'` is hardcoded in the inspect request (`AgentStudioModal.tsx:106`).
- `[Observed]` Empty model selection sends `undefined` (server default) rather than an explicit id (`AgentStudioModal.tsx:134`).
- `[Inferred]` MCP servers and toolkit/constraints ids are fetched/loaded for a fuller rack UI that was never built (state set at `AgentStudioModal.tsx:60-69,79-84`, never rendered).

## User Decision:

## Architectural Standard (Target)
> Status: Target. Local-state single-PUT editing stays; validation, loading, dead paths, and typing are the gaps.
Manifest editing stays local useState with one PUT and no store mirror. Per-slot saves are forbidden.
Save MUST run client-side validation: empty model, empty instruction stack, and empty skill sets are either rejected with an explicit message or confirmed as an intentional minimal config. Silent submittable-empty is forbidden.
Load failure MUST surface an error state with retry, never a silent empty form that drops the agent current config from view.
Loading MUST render a skeleton. Existing-but-unrendered loading state is forbidden.
Cancel and close with dirty edits MUST confirm. Silent discard is forbidden.
Dead patch tab value MUST be removed or wired to a real panel. Unreachable state values are forbidden.
Toolkit and constraints slots plus MCP server list are either rendered as editable controls or explicitly read-only with a documented reason. Fetched-but-unrendered state that still submits on save is forbidden.
WorkspaceSettingsModal Studio button MUST have a verified render site or be removed. State nothing consumes is forbidden.
Skill, tool, and inspection responses MUST be typed and shape-validated. any-typed server responses are forbidden.
Instruction ordering MUST have an explicit contract: array-order only with documented no-reorder, or a reorder UI. Silent order dependence is forbidden.
Resolved-tool keys MUST be stable unique ids. Collision-prone id-or-name fallback keys are forbidden.
Inspect MUST use the agent actual runtimeType, not a hardcoded agentic value, or document why agentic is canonical for inspection.
## Failure + Resume

- Manifest/skills/MCP load failure: `console.warn` only; modal still renders with empty selections, silently dropping the agent's current config from view (`AgentStudioModal.tsx:85-89`).
- Inspect/save failure: error toast; modal stays open with state intact; no retry helper.
- No dirty-guard: Cancel or X-close discards edits without confirmation.
- No loading skeleton: no `loading` state is rendered anywhere (state exists, unused in JSX).
- No socket or reconnect handling; stale catalogs if modules change while open (loads once per open).

## Gaps

- No agent-create flow: early return requires the agent to already be in the store (`AgentStudioModal.tsx:47,156`).
- `'patch'` tab is dead state (no button, no panel).
- Toolkit / constraints slots and MCP server list are fetched but unrendered — save still submits their ids.
- `WorkspaceSettingsModal` Studio button appears to set state nothing consumes (no render site observed; verify before relying on it).
- `availableSkills`, `resolvedTools`, `inspectionResult` are `any`-typed; no response-shape validation.
- No client-side validation before save (empty instruction/skill sets and empty model are all submittable).
- Instruction ordering is array order only; no reorder UI.
- `resolvedTools` keyed by `t.id || t.name` (`AgentStudioModal.tsx:411`) — collision-prone if ids missing.
