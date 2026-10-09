# Capabilities — Inventory (read-only audit, phases 1–4)

Date: 2026-10-06. Domain: `packages/server/src/capabilities`. No production edits.

## Files
| File | Bytes | Role |
|---|---|---|
| capabilities-gate.ts | 1609 | Thin facade: wires ports, re-exports catalog/types |
| capability-types.ts | 3346 | Types: CapabilityDomain, CapabilityDescriptor, VisibleCapability, ExpandedCapability, CapabilityManifest, CapabilitySource, CAPABILITY_DOMAINS |
| capability-catalog.ts | 8178 | 27 built-in descriptors, 8 domains, frozen array |
| capability-service.ts | 12039 | mergeManifest, loadManifest (private), listDescriptors, visibleFor, expand, getDescriptor, usableBy, resolveAuthority, sanitize* |
| capabilities.test.ts | 19242 | 36 tests, mocked tiers |
| capability-catalog.integrity.test.ts | 2534 | 4 tests vs live registry (no mocks) |

## Gate exports (exact — capabilities-gate.ts:25–46)
- const capabilitiesGate = { visibleFor(agentId, workspaceId?), expand(agentId, capabilityId, workspaceId?), get(capabilityId, workspaceId?) }
- Re-exports (tests/diagnostics): CAPABILITY_DOMAINS, BUILTIN_CAPABILITIES, mergeManifest
- Types: CapabilityDescriptor, CapabilityDomain, CapabilityManifest, CapabilitySource, ExpandedCapability, VisibleCapability

## Importers of capabilities-gate (all found)
| Caller | file:line | Uses |
|---|---|---|
| runtime/kernel/middlewares/tool-schema-middleware.ts | 130–131 | dynamic import + visibleFor → packet.visibleCapabilities |
| tools/tool-registry.ts (open_detail) | 1138, 1180, 1198 | dynamic import + visibleFor + expand |
| runtime/kernel/context-types.ts | 28 | type VisibleCapability |
| runtime/types.ts | 3, 111 | type VisibleCapability |
| runtime/kernel/tool-deferral-invariant.test.ts | 15 | BUILTIN_CAPABILITIES (via gate) |
| tools/open-detail-expansion.test.ts | 28–29 | mocks capabilities-gate |
| self tests | capabilities.test.ts, integrity test | gate + internal capability-service (in-domain OK) |

No routes/jobs/sockets/queues/events/DB callers. No REST surface. `routes/modules.ts:351 "/api/modules/capabilities/:id"` is a DIFFERENT feature (toolkit-module capabilities) — naming collision only.

## Runtime call graph
tool-schema-middleware.ts:130 → capabilitiesGate.visibleFor → capability-service.ts:206 → skillsGate.getResolvedToolsForAgent (:210) + agentGate.getById (:184) + toolsGate.get (:194) + readJsonObject (:155)
tool-registry.ts:1198 → capabilitiesGate.expand → capability-service.ts:239 → same deps + toolsGate.get (:262) → recordToolExpansion (shared/core/tool-expansion-registry.ts:64)
Gate re-export BUILTIN_CAPABILITIES ← tool-deferral-invariant.test.ts:15.

## Persistence / events / config
- Reads `<workspaceFolder>/vfs/.crowdos/capabilities.json` (read-only; local-file.ts:27 canon). No DB tables, no events, no flags, no env.
- Per-run expansion store lives in Shared (out of domain): TTL 30 min, cap 64 tools/run.

## Baseline (exact commands, packages/server)
- `npx tsc -p tsconfig.json --noEmit` → exit 2; 1 PRE-EXISTING error unrelated to capabilities: src/memories/memory-retrieval.ts(168,41) TS2559. Log: audit/domains/capabilities/tsc-baseline.log
- `npx vitest run src/capabilities/capabilities.test.ts src/capabilities/capability-catalog.integrity.test.ts` → 2 files, 40 passed, exit 0
- Related flow: `npx vitest run src/runtime/kernel/tool-deferral-invariant.test.ts src/tools/open-detail-expansion.test.ts src/runtime/kernel/discovery-context.test.ts` → 3 files, 19 passed, exit 0
- `node scripts/check-gates.mjs` → 361 files / 23 domains, 0 violations; capabilities clean (no findings listed)
- git: branch main; capabilities sources unmodified; no commit; only audit/ added (untracked).
