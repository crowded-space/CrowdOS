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
//    — the SAME resolver ToolExecutor authorizes against — and then applies the
//    executor's authority-level rule (agent.authorityLevel vs the tool's
//    authLevelRequired, fail-closed `?? 0` default and omniscient bypass
//    included) via agentGate.getById.
//    Discovery therefore cannot drift from enforcement: a capability is
//    advertised only when the agent could really invoke it. A capability whose
//    tools all fail either gate is excluded; a partially authorized one is
//    advertised with only the authorized subset.
//
// 3. MANIFEST OVERLAY. A workspace may add/override/hide capabilities via
//    <workspaceFolder>/vfs/.crowdos/capabilities.json (the §17 JSON-on-disk
//    config rule; canon path from mock-structure-polished). The overlay is
//    applied per workspace, so two workspaces can expose different
//    vocabularies over the same built-in set (§30 isolation).

import { readJsonObject } from "../shared/core/local-file.js";
import { toolsGate } from "../tools/tools-gate.js";
import { skillsGate } from "../skills/skills-gate.js";
import { agentGate } from "../agents/agent-gate.js";
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

const SUMMARY_MAX_LEN = 300;

/** Strip prompt-injectable control/newline chars and cap length (summaries ride on the packet). */
function sanitizeSummary(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.replace(/[\r\n\x00-\x1F\x7F]+/g, " ").trim().slice(0, SUMMARY_MAX_LEN);
  return cleaned || fallback;
}

/**
 * Coerce a raw manifest object to shape (permissive: warn + ignore bad parts, never throw).
 * `capabilities` must be an array of {id}; `disabled` an array of strings.
 */
function sanitizeManifest(raw: Record<string, unknown>): CapabilityManifest {
  const out: CapabilityManifest = {};
  const caps = (raw as { capabilities?: unknown }).capabilities;
  if (caps !== undefined && caps !== null) {
    if (!Array.isArray(caps)) {
      console.warn("[capabilities] manifest.capabilities is not an array; ignoring");
    } else {
      const kept: NonNullable<CapabilityManifest["capabilities"]> = [];
      for (const entry of caps) {
        if (entry && typeof (entry as { id?: unknown }).id === "string" && (entry as { id: string }).id.trim()) {
          kept.push(entry as (typeof kept)[number]);
        } else {
          console.warn("[capabilities] ignoring malformed manifest capability entry");
        }
      }
      out.capabilities = kept;
    }
  }
  const disabled = (raw as { disabled?: unknown }).disabled;
  if (disabled !== undefined && disabled !== null) {
    if (!Array.isArray(disabled)) {
      console.warn("[capabilities] manifest.disabled is not an array; ignoring");
    } else {
      const kept: string[] = [];
      for (const id of disabled) {
        if (typeof id === "string" && id.trim()) kept.push(id);
        else console.warn("[capabilities] ignoring malformed manifest disabled entry");
      }
      out.disabled = kept;
    }
  }
  return out;
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
  for (const c of builtins) byId.set(c.id, { ...c, tools: [...c.tools] });

  const caps = manifest?.capabilities;
  if (caps !== undefined && caps !== null) {
    if (!Array.isArray(caps)) {
      console.warn("[capabilities] manifest.capabilities is not an array; ignoring");
    } else {
      for (const entry of caps) {
        if (!entry || typeof entry.id !== "string" || !entry.id.trim()) continue;
        const id = entry.id.trim();
        const existing = byId.get(id);
        const domain = isDomain(entry.domain) ? entry.domain : existing?.domain;
        if (!domain) continue; // cannot place an unknown id in a domain
        byId.set(id, {
          id,
          domain,
          summary: sanitizeSummary(entry.summary, existing?.summary ?? id),
          tools: Array.isArray(entry.tools)
            ? entry.tools.filter((t): t is string => typeof t === "string")
            : existing ? [...existing.tools] : [],
          source: "manifest",
        });
      }
    }
  }

  const disabled = manifest?.disabled;
  if (disabled !== undefined && disabled !== null) {
    if (!Array.isArray(disabled)) {
      console.warn("[capabilities] manifest.disabled is not an array; ignoring");
    } else {
      for (const id of disabled) {
        if (typeof id === "string") byId.delete(id.trim());
      }
    }
  }

  return [...byId.values()].map((d) => ({ ...d, tools: [...d.tools] }));
}

/**
 * Read the manifest overlay for ONE workspace. Unscoped callers get the
 * built-in vocabulary only — never another workspace's overlay (§30 isolation).
 */
async function loadManifest(workspaceId?: string | null): Promise<CapabilityManifest | null> {
  const scope = typeof workspaceId === "string" ? workspaceId.trim() : "";
  if (!scope) return null;
  try {
    const raw = await readJsonObject<unknown>(MANIFEST_FILE, scope);
    if (Object.keys(raw).length === 0) return null;
    return sanitizeManifest(raw);
  } catch (err) {
    console.warn("[capabilities] manifest read failed; using built-in vocabulary", err);
    return null;
  }
}

/** Descriptors after the manifest overlay, in stable domain/id order. */
export async function listDescriptors(workspaceId?: string | null): Promise<CapabilityDescriptor[]> {
  const merged = mergeManifest(BUILTIN_CAPABILITIES, await loadManifest(workspaceId));
  const domainRank = new Map(CAPABILITY_DOMAINS.map((d, i) => [d, i]));
  return merged.sort((a, b) => {
    const dr = (domainRank.get(a.domain) ?? 99) - (domainRank.get(b.domain) ?? 99);
    return dr !== 0 ? dr : a.id.localeCompare(b.id);
  });
}

/**
 * The agent's authority tier for the executor's authLevel rule, or null when
 * the profile cannot be resolved (unknown agent / lookup failed). Mirrors
 * ToolExecutor step 4: `authorityLevel > (authLevelRequired ?? 0)` rejects
 * unless the agent is omniscient — a tool with no declared level is L0-only.
 */
type agentAuthority = { authorityLevel: number; isOmniscient: boolean };

async function resolveAuthority(agentId: string, workspaceId?: string | null): Promise<agentAuthority | null> {
  try {
    const agent = await agentGate.getById(agentId, undefined, workspaceId);
    return agent ? { authorityLevel: agent.authorityLevel, isOmniscient: agent.isOmniscient } : null;
  } catch (err) {
    console.warn("[capabilities] agent lookup failed; advertising none", err);
    return null;
  }
}

/** Live AND within the agent's authority — registry presence plus the executor's authLevel check. */
function usableBy(toolId: string, authority: agentAuthority): boolean {
  const def = toolsGate.get(toolId);
  if (!def) return false;
  const required = def.authLevelRequired ?? 0; // fail-closed: no level means L0-only, as ToolExecutor reads it
  return authority.isOmniscient || authority.authorityLevel <= required;
}

/**
 * Discovery-first view for an agent: capability ids, domains, one-line summaries.
 *
 * This is what replaces wholesale tool-schema injection. Argument schemas are
 * deliberately absent — expanding them is `expand()` below.
 */
export async function visibleFor(agentId: string, workspaceId?: string | null): Promise<VisibleCapability[]> {
  if (typeof agentId !== "string" || !agentId.trim()) return [];
  let authorized: string[] = [];
  try {
    authorized = await skillsGate.getResolvedToolsForAgent(agentId);
  } catch (err) {
    // No PG / no roster: no capabilities are provably invocable, so advertise none.
    console.warn("[capabilities] tool resolution failed; advertising none", err);
    return [];
  }
  const allowed = new Set(authorized);
  const authority = await resolveAuthority(agentId, workspaceId);
  // No profile (or lookup failed): the authority rule cannot be evaluated, so
  // nothing is provably invocable — same stance as the resolver failure above.
  if (!authority) return [];
  const descriptors = await listDescriptors(workspaceId);
  const out: VisibleCapability[] = [];
  for (const d of descriptors) {
    const live = d.tools.filter((t) => allowed.has(t) && usableBy(t, authority));
    if (live.length === 0) continue; // availability filter — never advertise vapor
    out.push({ id: d.id, domain: d.domain, summary: d.summary, available: live.length > 0 });
  }
  return out;
}

/**
 * Lazy expansion: full tool schemas for ONE capability, scoped to the agent.
 *
 * Returns null when the capability is unknown, hidden by the manifest, or has
 * no live AND authority-authorized tool for this agent — the same conditions
 * under which it was never advertised, so an agent cannot expand its way past
 * the availability filter.
 */
export async function expand(
  agentId: string,
  capabilityId: string,
  workspaceId?: string | null,
): Promise<ExpandedCapability | null> {
  if (typeof agentId !== "string" || !agentId.trim()) return null;
  const descriptors = await listDescriptors(workspaceId);
  const descriptor = descriptors.find((d) => d.id === capabilityId);
  if (!descriptor) return null;

  let authorized: string[] = [];
  try {
    authorized = await skillsGate.getResolvedToolsForAgent(agentId);
  } catch (err) {
    console.warn("[capabilities] tool resolution failed; cannot expand", err);
    return null;
  }
  const allowed = new Set(authorized);
  const authority = await resolveAuthority(agentId, workspaceId);
  if (!authority) return null;

  const toolSchemas = descriptor.tools
    .filter((t) => allowed.has(t) && usableBy(t, authority))
    .map((t) => toolsGate.get(t))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as unknown as Record<string, unknown> }));

  if (toolSchemas.length === 0) return null;
  return { ...descriptor, tools: toolSchemas.map((t) => t.name), toolSchemas };
}

/** Resolve one capability descriptor by id (manifest applied). Diagnostics/tests. */
export async function getDescriptor(
  capabilityId: string,
  workspaceId?: string | null,
): Promise<CapabilityDescriptor | null> {
  return (await listDescriptors(workspaceId)).find((d) => d.id === capabilityId) ?? null;
}
