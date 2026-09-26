// CrowdOS §21 Capabilities — domain gate.
//
// Sole import surface for the Capabilities domain (Domain Facade Standard).

import {
  visibleFor,
  expand,
  getDescriptor,
  mergeManifest,
} from "./capability-service.js";
import { BUILTIN_CAPABILITIES } from "./capability-catalog.js";
import { CAPABILITY_DOMAINS } from "./capability-types.js";
import type {
  CapabilityDescriptor,
  CapabilityDomain,
  CapabilityManifest,
  CapabilitySource,
  ExpandedCapability,
  VisibleCapability,
} from "./capability-types.js";

// NOTE: CAPABILITY_DOMAINS / BUILTIN_CAPABILITIES / mergeManifest are re-exported
// for tests and diagnostics only. External domains should use `capabilitiesGate`.
/** @internal pure merge helper, pinned by unit tests — not a runtime port. */
export { CAPABILITY_DOMAINS, BUILTIN_CAPABILITIES, mergeManifest };
export type {
  CapabilityDescriptor,
  CapabilityDomain,
  CapabilityManifest,
  CapabilitySource,
  ExpandedCapability,
  VisibleCapability,
};

export const capabilitiesGate = {
  /** Discovery-first view for an agent: id + domain + summary, no schemas. */
  visibleFor: (agentId: string, workspaceId?: string | null) => visibleFor(agentId, workspaceId),
  /** Lazy expansion: full tool schemas for one capability, agent-scoped. */
  expand: (agentId: string, capabilityId: string, workspaceId?: string | null) =>
    expand(agentId, capabilityId, workspaceId),
  /** One descriptor by id (diagnostics/tests). */
  get: (capabilityId: string, workspaceId?: string | null) => getDescriptor(capabilityId, workspaceId),
};
