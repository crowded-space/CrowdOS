// CrowdOS §21 capability vocabulary — the built-in descriptor catalog.
//
// Mapping policy (the part the document leaves to the implementation):
//   * The IDS are the document’s, verbatim, grouped into its eight domains.
//   * A descriptor lists the registry tool ids that ALREADY realize it.
//   * A descriptor whose tools are all absent from the live registry is filtered
//     out of discovery (capability-service), so the §21 vocabulary can be
//     declared here in full without advertising vapor. As tools land, the same
//     descriptor becomes real with no vocabulary change.
//
// This is the mechanism that replaces wholesale tool-schema injection: the
// agent sees ~a dozen one-line capability summaries instead of every tool’s
// full JSON schema, and expands only the one it needs (§21 token economy).

import type { CapabilityDescriptor } from "./capability-types.js";

export const BUILTIN_CAPABILITIES: readonly CapabilityDescriptor[] = [
  // ── Workspace ───────────────────────────────────────────────
  {
    id: "filesystem.read",
    domain: "workspace",
    summary: "Read files and list directories inside the channel’s mounted filesystem.",
    tools: ["read_file", "list_directory"],
    source: "builtin",
  },
  {
    id: "filesystem.write",
    domain: "workspace",
    summary: "Create, edit, or delete files inside the channel’s mounted filesystem.",
    tools: ["write_file", "edit_file", "delete_file"],
    source: "builtin",
  },
  {
    id: "workspace.snapshot",
    domain: "workspace",
    summary: "Capture the current workspace state for later comparison or restore.",
    tools: [],
    source: "builtin",
  },
  {
    id: "artifact.create",
    domain: "workspace",
    summary: "Produce a durable artifact (diff, report, citations) attached to the run.",
    tools: [],
    source: "builtin",
  },

  // ── Memory ─────────────────────────────────────────────────
  {
    id: "memory.find",
    domain: "memory",
    summary: "Search this agent’s private memory notes for relevant prior context.",
    tools: ["open_memory"],
    source: "builtin",
  },
  {
    id: "memory.expand",
    domain: "memory",
    summary: "Pull a memory note’s full content into the working context.",
    tools: ["open_memory"],
    source: "builtin",
  },
  {
    id: "memory.commit",
    domain: "memory",
    summary: "Persist a durable note about something worth remembering.",
    tools: ["remember"],
    source: "builtin",
  },
  {
    id: "memory.link",
    domain: "memory",
    summary: "Drop a memory from the working context without deleting it.",
    tools: ["discard_memory_from_context"],
    source: "builtin",
  },

  // ── Tooling ────────────────────────────────────────────────
  {
    id: "tool.search",
    domain: "tooling",
    summary: "Discover which capabilities and tools are available for this task.",
    tools: ["open_detail"],
    source: "builtin",
  },
  {
    id: "tool.invoke",
    domain: "tooling",
    summary: "Call a tool that has been expanded into the working context.",
    tools: [],
    source: "builtin",
  },
  {
    id: "open_detail",
    domain: "tooling",
    summary: "Expand a capability’s full tool schemas so they can be invoked.",
    tools: ["open_detail"],
    source: "builtin",
  },

  // ── Planning ───────────────────────────────────────────────
  {
    id: "task.plan",
    domain: "planning",
    summary: "Produce an explicit ordered plan before executing.",
    tools: [],
    source: "builtin",
  },
  {
    id: "task.breakdown",
    domain: "planning",
    summary: "Decompose a goal into independently executable subtasks.",
    tools: [],
    source: "builtin",
  },
  {
    id: "objective.track",
    domain: "planning",
    summary: "Track progress against the run’s stated objective.",
    tools: [],
    source: "builtin",
  },

  // ── Execution ──────────────────────────────────────────────
  {
    id: "sandbox.exec",
    domain: "execution",
    summary: "Run a shell command in the sandboxed working directory.",
    tools: ["execute_bash", "execute_safe"],
    source: "builtin",
  },
  {
    id: "runtime.spawn",
    domain: "execution",
    summary: "Start a new runtime execution for a delegated unit of work.",
    tools: [],
    source: "builtin",
  },
  {
    id: "job.await",
    domain: "execution",
    summary: "Wait for a previously scheduled or delegated job to finish.",
    tools: [],
    source: "builtin",
  },

  // ── Swarm ──────────────────────────────────────────────────
  {
    id: "agent.spawn",
    domain: "swarm",
    summary: "Create a new agent instance to carry part of the work.",
    tools: [],
    source: "builtin",
  },
  {
    id: "swarm.create",
    domain: "swarm",
    summary: "Form a multi-agent swarm over a sharded task.",
    tools: [],
    source: "builtin",
  },
  {
    id: "task.delegate",
    domain: "swarm",
    summary: "Hand a bounded subtask to another agent and collect its result.",
    tools: [],
    source: "builtin",
  },
  {
    id: "result.aggregate",
    domain: "swarm",
    summary: "Merge partial results from several agents into one answer.",
    tools: [],
    source: "builtin",
  },

  // ── Observation ─────────────────────────────────────────────
  {
    id: "workspace.scan",
    domain: "observation",
    summary: "Survey the workspace to establish what exists before acting.",
    tools: [],
    source: "builtin",
  },
  {
    id: "dependency.inspect",
    domain: "observation",
    summary: "Inspect declared dependencies and their resolved versions.",
    tools: [],
    source: "builtin",
  },
  {
    id: "anomaly.detect",
    domain: "observation",
    summary: "Flag behavior that deviates from expectation without being asked to fix it.",
    tools: [],
    source: "builtin",
  },

  // ── Knowledge ────────────────────────────────────────────────
  {
    id: "web.search",
    domain: "knowledge",
    summary: "Search the public web and read back results.",
    tools: ["web_search"],
    source: "builtin",
  },
  {
    id: "repo.map",
    domain: "knowledge",
    summary: "Build a navigable map of a repository’s structure and entry points.",
    tools: [],
    source: "builtin",
  },
  {
    id: "docs.index",
    domain: "knowledge",
    summary: "Index documentation or channel history so it can be searched.",
    tools: ["search_all_channels"],
    source: "builtin",
  },
];
