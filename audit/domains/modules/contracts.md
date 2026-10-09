# Modules Domain — Contracts (Phase 2)

Contract = what the gate exports vs what callers actually use. Code is truth; re-docs/Backend Docs/Domain Spec/Modules.md reviewed but not modified (docs sync noted, not performed).

## C1. Gate shape (module-gate.ts:74-188) — VERIFIED
Gate contains only wiring: imports from ./module-service.js + ./module-validators.js + ./module-types.js, re-exports, moduleGate literal. No logic/branching/fetch/DB in gate. PASS per AGENTS.md §2.

## C2. Namespace ports
| Port | Contract | Evidence |
|---|---|---|
| model.list(opts) | ListModulesOpts & {workspaceId} -> rows (limit 1-500 default 500, offset>=0) | service:486-494 |
| model.get(id, ws?) | row or null | :495-500 |
| model.create(body, ws?) | mints UUID, encrypts apiKey, defaults stopSequences[]/enableCompression true; returns row | :501-521 |
| model.update(id, body, ws?) | null if missing; mask-sentinel keep-existing; encrypts real keys; invalidates runtime cache | :522-554 |
| model.remove(id, ws?) | deleted rows array ([] if missing); PG: unscoped plural 409 guard; local: scoped guard | :555-568 |
| model.test(id, ws?) | ConnectionTestResult or null | :569-589 |
| instruction/toolkit/constraints/capabilities.{list,get,create,update,remove} | same pattern; toolkit writes also invalidate skills caches; PG deletes assertNoPgBlockers | :591-847 |
| findReferencingAgent(type,id,ws?) | first referencing agent or null; ws=null/undefined -> legacy cross-workspace roster | :122-130 |
| findReferencingAgents(type,id,ws?) | all referencing agents (roster filter) | :114-120 |
| validateReferences(ids, db?, ws?) | throws Error("X not found: id") on missing; ws!==undefined selects local store; PG path otherwise | :169-213 |
| ensureDefaults(ws?) | local tier only, seeds instr-default; unscoped -> no-op | :385-410 |
| testConnectionHelper(provider,model,key?,url?) | never throws; {success,message,offline?} | :222-353 |
| listAllModules(opts) | 5 arrays; PG cached 10s keyed ws:dbScope:page; local sliced | :449-483 |
| DEFAULT_INSTRUCTION_MODULE_ID | "instr-default" | :374 |

## C3. Error contract
| Condition | Shape | Evidence |
|---|---|---|
| missing id get/update | null (route 404) | :495-500 etc |
| missing id delete | [] (route 404) | routes/modules.ts:153 |
| agent still references module (route pre-check) | 409 {error:"Conflict"} first blocker | routes/modules.ts:144-149 |
| PG delete with any blocker (service) | Error{code:"MODULE_IN_USE",statusCode:409} naming all | :147-155 |
| corrupt local file on write | Error{code:"MODULE_STORE_CORRUPT",statusCode:500} | local-store:92-112 |
| unscoped local write (non-vitest) | Error (workspaceId required) | local-store:51-56,162 |
| tier registry non-connection failure | Error{code:"INVALID_WORKSPACE",statusCode:400} | :65-78 |
| connection probe timeout/offline | {success:false,offline:true} never throw | :263-273, :344-350 |
| unknown provider | {success:false} no network call | :336-338 |

## C4. Facade usage vs exports (drift check)
- All 11 external importers use module-gate.ts. No external file imports past the gate except TEST-ONLY fixtures: module-local-mode.test.ts -> agent-local-store (agent domain internal), context-model-routing.test.ts -> module-local-store (this domain internal, cross-domain test).
- Bare exports testConnectionHelper/listAllModules are used by routes/providers.ts and routes/modules.ts respectively — both contract-correct.
- Unused-by-outsiders but exported: findReferencingAgents (used internally + tests), validateModuleReferences bare (Agents uses moduleGate.validateReferences alias), ModuleUnion (types/index.ts only).
- Gate exports bare ensureDefaultModules AND ensureDefaults alias: Agents uses moduleGate.ensureDefaults; bare alias un-used externally. Low-severity surface bloat, not a violation.

## C5. Docs contract check (read-only)
- Domain doc Ports list matches gate exports (spot-checked all names; no extra/missing).
- Docs reference stale line numbers (e.g. ":561/:569/:578" vs actual :564/:565, :651-652) — documentation drift, noted.
