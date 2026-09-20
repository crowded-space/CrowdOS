// CrowdOS §21 Capabilities — domain gate.
//
// Sole import surface for the Capabilities domain (Domain Facade Standard).

import {
  listDescriptors,
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
  /** All descriptors (built-in vocabulary + workspace manifest overlay). */
  list: () => listDescriptors(),
  /** Discovery-first view for an agent: id + domain + summary, no schemas. */
  visibleFor: (agentId: string) => visibleFor(agentId),
  /** Lazy expansion: full tool schemas for one capability, agent-scoped. */
  expand: (agentId: string, capabilityId: string) => expand(agentId, capabilityId),
  /** One descriptor by id (diagnostics/tests). */
  get: (capabilityId: string) => getDescriptor(capabilityId),
};

