# Capabilities — Contracts (gate = contract)

## Ports (implemented at file:line, wired 1:1 in gate)
| Port | Signature | Impl | Behavior |
|---|---|---|---|
| capabilitiesGate.visibleFor | (agentId, workspaceId?) => Promise<VisibleCapability[]> | capability-service.ts:206 | [] on empty agentId, resolver throw, or unresolvable profile; else descriptors with ≥1 tool that is granted ∧ live ∧ authority-usable; {id,domain,summary,available:true} only |
| capabilitiesGate.expand | (agentId, capabilityId, workspaceId?) => Promise<ExpandedCapability|null> | capability-service.ts:239 | null on empty agentId/unknown id/manifest-disabled/no usable tool/resolver throw; else filtered toolSchemas; descriptor.tools overwritten to schema names (:267–269) |
| capabilitiesGate.get | (capabilityId, workspaceId?) => Promise<CapabilityDescriptor|null> | capability-service.ts:271 | descriptor by id, manifest applied, NO availability/authority filter (diagnostics/tests) |

## Re-exports (non-port, documented)
- mergeManifest(builtins, manifest) — capability-service.ts:102. Pure; override-by-id; disabled removes; malformed → warn+ignore; sanitizeSummary (300 cap, one line, fallback).
- CAPABILITY_DOMAINS (capability-types.ts:26), BUILTIN_CAPABILITIES (capability-catalog.ts:28, 27 ids).

## Inbound dependencies (gate-to-gate + shared only)
- skillsGate.getResolvedToolsForAgent — capability-service.ts:210, 251 (SAME resolver ToolExecutor uses, tool-executor.ts:356)
- agentGate.getById — capability-service.ts:184 (authorityLevel/isOmniscient; ToolExecutor rule tool-executor.ts:372)
- toolsGate.get — capability-service.ts:194, 262 (liveness + authLevelRequired)
- shared/core/local-file.ts readJsonObject — capability-service.ts:155 (gate-exempt per AGENTS.md §2)

## Outbound contract consumers
- Runtime packet: tool-schema-middleware.ts:131 sets visibleCapabilities; context-assembler.ts:96 lifts; runtime/types.ts:111 field. Keys pinned: ["available","domain","id","summary"] (capabilities.test.ts, discovery-context.test.ts:150).
- open_detail tool (tools domain): tool-registry.ts:1180 list, :1198 expand; expansion recorded to run (open-detail-expansion.test.ts).

## Doc alignment (re-docs/Backend Docs/Domain Spec/Capabilities.md)
- Ports section == gate exports: MATCH (visibleFor/expand/get + re-exports; no `list` — matches "Removed 2026-09-25" note).
- Behavior claims (availability, authority mirror, isolation, degrade-never-throw, sanitize) MATCH code+ tests.
- Known doc'd gaps: available dead field; tool_id escape hatch not in published schema; no REST; per-run expansion; advisory-only authorization. All confirmed still true.
