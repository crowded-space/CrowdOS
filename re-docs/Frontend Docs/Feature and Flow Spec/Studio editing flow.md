# Studio editing flow
> Type: Flow · Status: aligned · Updated: 2026-09-13
## Intent
Edit an existing agent's slot manifest (model, instructions, skills) and inspect the compiled prompt, persisting in one explicit save.
## Architectural decision
- [Observed] Local-state editing, single PUT: all slot selections live in `useState` and push in one manifest save — no per-slot saves, no store mirror.
- [Observed] Edit-only: renders nothing unless `open` is true AND the agent exists in the store (`AgentStudioModal.tsx:156`).
- [Inferred] Saved changes take effect next turn via socket hot-swap (footer copy only; the client verifies nothing after save).
## How it works
1. Open: user clicks Studio in `AgentProfileModal`, which sets `studioOpen` and renders `<AgentStudioModal agentId open onClose>` (`AgentProfileModal.tsx:211,533-536`).
2. Load: on `open && agentId`, effect GETs manifest, skills catalog, and MCP servers (`AgentStudioModal.tsx:50-93`).
3. Edit modules: model select (`AgentStudioModal.tsx:245-254`); instruction add (`AgentStudioModal.tsx:321-338`) / remove (`AgentStudioModal.tsx:304-312`); skill toggle cards (`AgentStudioModal.tsx:354-396`); resolved tools are read-only (`AgentStudioModal.tsx:400-429`).
4. Validate: no client-side validation observed — empty instruction/skill sets and empty model are all submittable.
5. Inspect (optional): switching to X-Ray auto-compiles when no result exists (`AgentStudioModal.tsx:203-207`); Re-Compile posts test input (`AgentStudioModal.tsx:441-448`); stats and system prompt render (`AgentStudioModal.tsx:459-491`).
6. Save: Save & Commit PUTs slot ids (`AgentStudioModal.tsx:509-516`), shows a success toast, and closes on success (`AgentStudioModal.tsx:142-144`); Cancel discards silently (`AgentStudioModal.tsx:503-508`).
7. Close: modal unmounts; all edit state is local and discarded.
## Components involved
| Area doc | Role |
|---|---|
| <../Domain Spec/Agent Studio.md> | Owns the Studio modal, slot UIs, X-Ray panel, and save logic |
## Current state
Open → load → edit → save/close matches the area doc. No create flow, no per-slot persistence, no dirty-guard on Cancel. Load failures surface a cause-bearing banner with Retry instead of rendering empty selections; the dead patch tab value was removed so only rack + xray render.
## Alignment notes
- `WorkspaceSettingsModal` Studio button sets `studioAgentId` with no observed `<AgentStudioModal` render site in that file — second open path unverified.
- 2026-09-30 entry hit target: the Agent profile Open studio button is at least 24px high with compensated vertical margins, so opening the studio does not shift the modular-assembly row.
## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked area and domain docs.
* Local-state single-PUT editing stays with no store mirror and no per-slot saves. Edit-only with open plus agent-exists guard stays.
* Save runs client-side validation. Empty model, instructions, and skills submittable silently is forbidden.
* Toolkit and constraints plus MCP list are rendered editable or explicitly read-only with reason. Fetched-but-unrendered state submitting on save is forbidden.
* Load failure surfaces an error state with retry, never silent empty form. Cancel and close with dirty edits confirm. Dead patch tab value is removed or wired.
* Instruction ordering has an explicit array-order or reorder-UI contract. Resolved-tool keys are stable unique ids. Inspect uses the agent actual runtimeType. Authority: Agent Studio area doc.
* Studio entry controls maintain at least 24×24 hit areas without changing surrounding layout. Sub-24px interactive controls are forbidden. Authority: Modals area doc.
## Open gaps
- No client-side validation before save (empty model/instructions/skills submittable).
- Toolkit / constraints selections load from the manifest but have no UI controls; save still submits their ids.
- Instruction ordering is array order only; no reorder UI.
