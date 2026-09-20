// ─── Per-run tool expansion registry (§21 lazy expansion) ────────────
//
// §21 requires capabilities to be "externalized, discoverable, lazily expanded"
// to cut token usage, context pollution, and tool confusion. Discovery alone is
// not enough: in the native function-calling path a model can only invoke a tool
// whose schema is in the request, so an expanded capability has to become
// callable on the NEXT iteration.
//
// This registry is that hand-off. `open_detail` records the schemas it disclosed;
// the agentic runtime unions them into the packet before each model call.
//
// Lives in Shared (gate-exempt per the Domain Facade Standard) because both the
// Tools domain (the expansion verb) and the Runtime domain (the re-injection)
// need it, and a gate-to-gate edge between them would be a cycle.
//
// Bounding: entries are keyed by run id, cleared when the run finishes, and
// swept by TTL so a crashed run cannot pin memory. A run with no id (e.g. a
// direct runtime invocation in a test) simply gets no expansions — the caller
// then sees the un-deferred reflex set only, which is the honest fallback.

import type { LLMToolDefinition } from "../../runtime/types.js";

/** Longest a run’s expansions are retained after the last write. */
const TTL_MS = 30 * 60 * 1000;
/** Hard cap per run — a runaway expansion loop must not grow without bound. */
const MAX_TOOLS_PER_RUN = 64;

interface RunExpansions {
  tools: Map<string, LLMToolDefinition>;
  capabilities: Set<string>;
  updatedAt: number;
}

const runs = new Map<string, RunExpansions>();

function sweep(now: number): void {
  for (const [runId, entry] of runs) {
    if (now - entry.updatedAt > TTL_MS) runs.delete(runId);
  }
}

function bucket(runId: string): RunExpansions {
  const now = Date.now();
  if (runs.size > 500) sweep(now);
  let entry = runs.get(runId);
  if (!entry) {
    entry = { tools: new Map(), capabilities: new Set(), updatedAt: now };
    runs.set(runId, entry);
  }
  entry.updatedAt = now;
  return entry;
}

/**
 * Record that a run expanded a capability, disclosing these tool schemas.
 * Returns the number of NEWLY added tools (0 when everything was already known).
 */
export function recordToolExpansion(
  runId: string | null | undefined,
  capabilityId: string,
  toolSchemas: readonly LLMToolDefinition[],
): number {
  if (!runId) return 0;
  const entry = bucket(runId);
  entry.capabilities.add(capabilityId);
  let added = 0;
  for (const schema of toolSchemas) {
    if (!schema?.name) continue;
    if (entry.tools.has(schema.name)) continue;
    if (entry.tools.size >= MAX_TOOLS_PER_RUN) break;
    entry.tools.set(schema.name, schema);
    added++;
  }
  return added;
}

/** Schemas disclosed so far for this run (empty when unknown/expired). */
export function expandedToolSchemas(runId: string | null | undefined): LLMToolDefinition[] {
  if (!runId) return [];
  const entry = runs.get(runId);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > TTL_MS) {
    runs.delete(runId);
    return [];
  }
  return [...entry.tools.values()];
}

/** Capability ids expanded by this run (diagnostics/tests). */
export function expandedCapabilities(runId: string | null | undefined): string[] {
  if (!runId) return [];
  return [...(runs.get(runId)?.capabilities ?? [])];
}

/** Drop a finished run’s expansions. Called when the run reaches a terminal state. */
export function clearToolExpansions(runId: string | null | undefined): void {
  if (!runId) return;
  runs.delete(runId);
}

/** Test seam: drop every run’s expansions. */
export function resetToolExpansionsForTests(): void {
  runs.clear();
}

