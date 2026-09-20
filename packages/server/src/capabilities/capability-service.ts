// Capability service — externalize / discover / lazily expand (§21).
//
// Design notes:
//
// 1. AVAILABILITY FILTER. A descriptor whose tools are all absent from the live
//    registry is NOT discoverable. §21 lists a vocabulary larger than today’s
//    implementation; surfacing an unrealized capability would invite the model to
//    plan around a tool that cannot run. The vocabulary stays declared in full
//    (capability-catalog.ts) and becomes real automatically as tools land.
//
// 2. AGENT SCOPING. `visibleFor` intersects each capability with the tools the
//    agent is actually authorized for, reusing skillsGate.getResolvedToolsForAgent
//    — the SAME resolver ToolExecutor authorizes against. Discovery therefore
//    cannot drift from enforcement: a capability is advertised only when the
//    agent could really invoke it.
//
// 3. MANIFEST OVERLAY. A workspace may add/override/hide capabilities via
//    <localstore>/capabilities.json (the §17 JSON-on-disk config rule). The
//    overlay is applied per workspace, so two workspaces can expose different
//    vocabularies over the same built-in set (§30 isolation).

import { readJsonObject } from "../shared/core/local-file.js";
import { toolsGate } from "../tools/tools-gate.js";
import { skillsGate } from "../skills/skills-gate.js";
import { BUILTIN_CAPABILITIES } from "./capability-catalog.js";
import { CAPABILITY_DOMAINS } from "./capability-types.js";
import type {
  CapabilityDescriptor,
  CapabilityDomain,
  CapabilityManifest,
  ExpandedCapability,
  VisibleCapability,
} from "./capability-types.js";

const MANIFEST_FILE = "capabilities.json";

function isDomain(value: unknown): value is CapabilityDomain {
  return typeof value === "string" && (CAPABILITY_DOMAINS as readonly string[]).includes(value);
}

/**
 * Merge the workspace manifest over the built-in vocabulary.
 *
 * Manifest entries override by id; `disabled` removes ids entirely. A malformed
 * manifest degrades to the built-in vocabulary rather than throwing — capability
 * discovery must never be the reason a run cannot start.
 */
export function mergeManifest(
  builtins: readonly CapabilityDescriptor[],
  manifest: CapabilityManifest | null,
): CapabilityDescriptor[] {
  const byId = new Map<string, CapabilityDescriptor>();
  for (const c of builtins) byId.set(c.id, c);

  if (manifest?.capabilities) {
    for (const entry of manifest.capabilities) {
      if (!entry || typeof entry.id !== "string" || !entry.id.trim()) continue;
      const id = entry.id.trim();
      const existing = byId.get(id);
      const domain = isDomain(entry.domain) ? entry.domain : existing?.domain;
      if (!domain) continue; // cannot place an unknown id in a domain
      byId.set(id, {
        id,
        domain,
        summary: typeof entry.summary === "string" && entry.summary.trim()
          ? entry.summary.trim()
          : existing?.summary ?? id,
        tools: Array.isArray(entry.tools)
          ? entry.tools.filter((t): t is string => typeof t === "string")
          : existing?.tools ?? [],
        source: "manifest",
      });
    }
  }

  if (manifest?.disabled) {
    for (const id of manifest.disabled) {
      if (typeof id === "string") byId.delete(id.trim());
    }
  }

  return [...byId.values()];
}

async function loadManifest(): Promise<CapabilityManifest | null> {
  try {
    const raw = await readJsonObject<unknown>(MANIFEST_FILE);
    if (!raw || Object.keys(raw).length === 0) return null;
    return raw as unknown as CapabilityManifest;
  } catch {
    return null;
  }
}

/** Descriptors after the manifest overlay, in stable domain/id order. */
export async function listDescriptors(): Promise<CapabilityDescriptor[]> {
  const merged = mergeManifest(BUILTIN_CAPABILITIES, await loadManifest());
  const domainRank = new Map(CAPABILITY_DOMAINS.map((d, i) => [d, i]));
  return merged.sort((a, b) => {
    const dr = (domainRank.get(a.domain) ?? 99) - (domainRank.get(b.domain) ?? 99);
    return dr !== 0 ? dr : a.id.localeCompare(b.id);
  });
}

/**
 * Discovery-first view for an agent: capability ids, domains, one-line summaries.
 *
 * This is what replaces wholesale tool-schema injection. Argument schemas are
 * deliberately absent — expanding them is `expand()` below.
 */
export async function visibleFor(agentId: string): Promise<VisibleCapability[]> {
  let authorized: string[] = [];
  try {
    authorized = await skillsGate.getResolvedToolsForAgent(agentId);
  } catch {
    // No PG / no roster: no capabilities are provably invocable, so advertise none.
    return [];
  }
  const allowed = new Set(authorized);
  const descriptors = await listDescriptors();
  const out: VisibleCapability[] = [];
  for (const d of descriptors) {
    const live = d.tools.filter((t) => allowed.has(t) && toolsGate.has(t));
    if (live.length === 0) continue; // availability filter — never advertise vapor
    out.push({ id: d.id, domain: d.domain, summary: d.summary, available: true });
  }
  return out;
}

/**
 * Lazy expansion: full tool schemas for ONE capability, scoped to the agent.
 *
 * Returns null when the capability is unknown, hidden by the manifest, or has no
 * live tool for this agent — the same three conditions under which it was never
 * advertised, so an agent cannot expand its way past the availability filter.
 */
export async function expand(agentId: string, capabilityId: string): Promise<ExpandedCapability | null> {
  const descriptors = await listDescriptors();
  const descriptor = descriptors.find((d) => d.id === capabilityId);
  if (!descriptor) return null;

  let authorized: string[] = [];
  try {
    authorized = await skillsGate.getResolvedToolsForAgent(agentId);
  } catch {
    return null;
  }
  const allowed = new Set(authorized);

  const toolSchemas = descriptor.tools
    .filter((t) => allowed.has(t))
    .map((t) => toolsGate.get(t))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as unknown as Record<string, unknown> }));

  if (toolSchemas.length === 0) return null;
  return { ...descriptor, tools: toolSchemas.map((t) => t.name), toolSchemas };
}

/** Resolve one capability descriptor by id (manifest applied). Diagnostics/tests. */
export async function getDescriptor(capabilityId: string): Promise<CapabilityDescriptor | null> {
  return (await listDescriptors()).find((d) => d.id === capabilityId) ?? null;
}
