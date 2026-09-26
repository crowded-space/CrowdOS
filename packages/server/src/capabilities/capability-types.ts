// CrowdOS §21 — Capabilities: what the system can operationally do.
//
// A capability is NOT a tool and NOT a runtime. It is an operational-domain
// grouping of tools, externalized so an agent can be told what is possible
// without being handed every JSON schema up front. The vocabulary is fixed by
// the document (§21); the mapping from capability -> tools is this codebase’s.
//
// The three properties §21 requires are encoded in the three shapes below:
//   externalized  -> CapabilityDescriptor (data, not prompt prose)
//   discoverable  -> VisibleCapability   (id + domain + one-line summary)
//   lazily expanded -> ExpandedCapability (full tool schemas, on request)

import type { LLMToolDefinition } from "../runtime/types.js";

/** The eight operational domains named in §21. */
export type CapabilityDomain =
  | "workspace"
  | "memory"
  | "tooling"
  | "planning"
  | "execution"
  | "swarm"
  | "observation"
  | "knowledge";

export const CAPABILITY_DOMAINS: readonly CapabilityDomain[] = [
  "workspace",
  "memory",
  "tooling",
  "planning",
  "execution",
  "swarm",
  "observation",
  "knowledge",
] as const;

/** Where a descriptor came from — the built-in §21 vocabulary, or a workspace manifest. */
export type CapabilitySource = "builtin" | "manifest";

/**
 * A capability as DATA (the §21 "externalized" property).
 *
 * `tools` is the lazy-expansion payload: the registry tool ids that realize
 * the capability. A capability with no tool that is live, authorized, and
 * within the agent's authority level is NOT exposed to agents — see
 * capability-service's availability filter. The document’s vocabulary is
 * larger than today’s implementation, and advertising an unrealized capability
 * would be a lie the model then acts on.
 */
export interface CapabilityDescriptor {
  /** §21 vocabulary id, e.g. "memory.find", "sandbox.exec". */
  id: string;
  domain: CapabilityDomain;
  /** One line. This is the ONLY text an agent sees during discovery. */
  summary: string;
  /** Registry tool ids that realize this capability. */
  tools: string[];
  source: CapabilitySource;
}

/**
 * Discovery-first view (§21 "discoverable"): enough to choose a capability,
 * deliberately without argument schemas. This is what rides on the packet.
 */
export interface VisibleCapability {
  id: string;
  domain: CapabilityDomain;
  summary: string;
  /**
   * Always true as advertised: a descriptor with no live, authorized,
   * authority-level-usable tool is excluded from `visibleFor` entirely, so
   * false is never returned. Kept because the packet shape and consumers
   * assert the key (dropping it needs a runtime test change).
   */
  available: boolean;
}

/** Lazy expansion (§21 "lazily expanded"): the full schemas, on request. */
export interface ExpandedCapability extends CapabilityDescriptor {
  toolSchemas: LLMToolDefinition[];
}

/** Optional workspace manifest overlay: `<localstore>/capabilities.json`. */
export interface CapabilityManifest {
  /** Extra or overriding descriptors, merged over the built-in vocabulary. */
  capabilities?: Array<Partial<CapabilityDescriptor> & { id: string }>;
  /** Vocabulary ids to hide entirely in this workspace. */
  disabled?: string[];
}

