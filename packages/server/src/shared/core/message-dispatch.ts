// ─── One owner for "a message reaches agents" ───────────────────────────
// An operator posting in a channel and a cron waking an agent must decide the
// SAME way who answers: an explicit @mention, else the channel's PINNED agent
// (§7 pinned mention), else the channel default, else the category owner,
// else the L0 roster, else the default assistant. That ladder lives here so
// the two callers cannot drift - a cron that picked its own target would wake
// an agent the operator never pinned.
//
// The ladder is also where "default composer settings" live: the channel's
// runtime pin is a PREFERENCE, while an explicit runtime (the composer mode,
// or a cron wake) wins outright at the Router.

import { agentGate } from "../../agents/agent-gate.js";
import { channelGate } from "../../channels/channel-gate.js";
import { messageGate } from "../../messages/message-gate.js";
import { runtimeGate } from "../../runtime/runtime-gate.js";
import { runtimeTypeFromString } from "../../runtime/types.js";
import type { RuntimeType } from "../../runtime/types.js";
import type { AgentProfile } from "../../agents/agent-gate.js";
import type { EventBroker } from "../../event-broker/event-broker-gate.js";
import { beginRun, endRun, runKey, DuplicateRunError } from "./active-runs.js";
import { logWarn } from "./structured-log.js";

export type messageAuthor = {
  id: string;
  name: string;
  level: string;
  type: "user" | "agent" | "system";
  tag?: string;
};

/** How a target was chosen - the audit trail for "why did this agent answer". */
export type messageTargetVia = "mention" | "pinned" | "default";

export type messageTarget = {
  agent: AgentProfile;
  via: messageTargetVia;
};

export type resolvedMention = { type: string; targetId: string };

export type dispatchChannelMessageInput = {
  channelId: string;
  /** Fallback scope when the channel row carries none. */
  workspaceId?: string | null;
  content: string;
  author: messageAuthor;
  /** Already-resolved mentions. Empty = the pinned-mention ladder applies. */
  mentions?: resolvedMention[];
  /** Composer mode / cron wake: wins over the channel pin at the Router. */
  explicitRuntime?: RuntimeType | null;
  /** Channel runtime pin. */
  preferredRuntime?: RuntimeType | null;
  operatorContext?: { name: string; tag: string; preference: string } | null;
  broker?: EventBroker | null;
  /** "queue" books a run (BullMQ); "inline" executes it now. */
  mode?: "inline" | "queue";
  /** Test seam: override the run executor. */
  executeRun?: (req: Parameters<typeof runtimeGate.execute>[0]) => Promise<unknown>;
};

export type dispatchChannelMessageResult = {
  messageId: string | null;
  workspaceId: string;
  dispatched: string[];
  skipped: { id: string; reason: string }[];
};

/** The Librarian is never a default target - an explicit @mention still reaches it. */
export function isLibrarianAgent(agent: { id: string; name: string }): boolean {
  if (agent.id === "agent-librarian") return true;
  const n = agent.name?.toLowerCase();
  return n === "owl" || n === "librarian";
}

/** System notice on the channel (paused/offline/busy). */
export async function appendSystemWarning(
  channelId: string,
  content: string,
  broker?: EventBroker | null,
): Promise<void> {
  // Messages owns the table: sequence + insert + emit live in messageGate.append.
  await messageGate.append(
    {
      channelId,
      authorId: "system",
      authorName: "System Warning",
      authorLevel: "stakeholder",
      authorType: "system",
      content,
    },
    broker ? { broker } : undefined,
  );
}

/**
 * Who answers this message. An explicit mention wins outright; otherwise the
 * channel's pinned agent, then the channel default, then the category owner,
 * then the L0 roster, then the default assistant.
 */
export async function resolveMessageTargets(input: {
  channelId: string;
  workspaceId: string;
  mentions: resolvedMention[];
  agents: AgentProfile[];
}): Promise<messageTarget[]> {
  const { channelId, workspaceId, mentions, agents } = input;
  const live = (agent: AgentProfile | undefined): AgentProfile | undefined =>
    agent && !isLibrarianAgent(agent) && agent.status !== "offline" && agent.status !== "paused"
      ? agent
      : undefined;

  if (mentions.length > 0) {
    const targets: messageTarget[] = [];
    for (const mention of mentions) {
      if (mention.type === "agent") {
        const agent = agents.find((a) => a.id === mention.targetId);
        if (agent) targets.push({ agent, via: "mention" });
      } else if (mention.type === "role") {
        const levelStr = mention.targetId.replace("role-l", "");
        const levelNum = parseInt(levelStr, 10);
        if (!isNaN(levelNum)) {
          for (const agent of agents.filter((a) => a.authorityLevel === levelNum)) {
            targets.push({ agent, via: "mention" });
          }
        }
      }
    }
    return targets;
  }

  // Pinned mention (§7) first, then the §8 hierarchy.
  const settings = await channelGate.getSettings(channelId, undefined, workspaceId).catch(() => null);
  const pinned = live((settings as any)?.activeAgentId ? agents.find((a) => a.id === (settings as any).activeAgentId) : undefined);
  if (pinned) return [{ agent: pinned, via: "pinned" }];

  const channelDefault = live((settings as any)?.defaultAgentId ? agents.find((a) => a.id === (settings as any).defaultAgentId) : undefined);
  if (channelDefault) return [{ agent: channelDefault, via: "default" }];

  const channel = await channelGate.get(channelId).catch(() => null);
  if (channel?.categoryId) {
    const category = await channelGate.getCategory(channel.categoryId).catch(() => null);
    if (category?.ownedByAgentId) {
      const owner = live(agents.find((a) => a.id === category.ownedByAgentId));
      if (owner) return [{ agent: owner, via: "default" }];
    }
  }

  const l0Agents = agents.filter((a) => !isLibrarianAgent(a) && a.authorityLevel === 0 && a.status !== "offline" && a.status !== "paused");
  if (l0Agents.length > 0) return l0Agents.map((agent) => ({ agent, via: "default" }));

  const defaultAgent = agents.find((a) => !isLibrarianAgent(a) && a.name === "default-assistant" && a.status !== "offline" && a.status !== "paused")
    || agents.find((a) => !isLibrarianAgent(a) && (a.status === "idle" || a.status === "working"));
  if (defaultAgent) return [{ agent: defaultAgent, via: "default" }];

  return [];
}

/**
 * XD-016/ART-2: inline execution must run inside the message workspace's ALS
 * handle, or run/artifact writes land on the ambient pool instead of the
 * workspace DB (lost or cross-tenant rows in split-DB deployments).
 *
 * An injected executor (test seam) runs unscoped - the caller owns its scope.
 */
export async function executeRunScoped(
  req: Parameters<typeof runtimeGate.execute>[0],
  executeRunOverride?: (req: Parameters<typeof runtimeGate.execute>[0]) => Promise<unknown>,
): Promise<unknown> {
  const ws = (req as unknown as Record<string, unknown>).workspaceId as string | undefined;
  const executeRun = executeRunOverride ?? ((r: Parameters<typeof runtimeGate.execute>[0]) => runtimeGate.execute(r));
  if (!ws || executeRunOverride) return executeRun(req);
  // SH-005: the degrade below is fail-open by design (local-first), but it
  // must not be silent - without a warn line a record-only workspace run is
  // indistinguishable from a scoped one in the field (lost-artifact reports).
  const warnDegraded = (reason: string): void => {
    try {
      // The stage key keeps its "socket.run." prefix even though the scoped
      // executor is now shared: it is an observable alert/dashboard key, and
      // renaming it would silently break whatever watches it. The scope it
      // reports (a workspace record run) is the same one.
      logWarn({ stage: "socket.run.scope_degraded", workspaceId: ws, reason });
    } catch {
      // logging must never break the degrade path
    }
  };
  try {
    const { runWithDb, dbForWorkspace } = await import("../config/database.js");
    let degradeReason: string | null = null;
    const db = await dbForWorkspace(ws).catch((err: unknown) => {
      degradeReason = err instanceof Error ? err.message : String(err);
      return null;
    });
    if (!db) {
      warnDegraded(degradeReason ?? "resolver_null");
      return executeRun(req);
    }
    return await runWithDb(db, () => executeRun(req));
  } catch (err) {
    warnDegraded(err instanceof Error ? err.message : String(err));
    return executeRun(req);
  }
}

/**
 * Run with cancellation support (HM2/CAN-1). Registers the run's
 * AbortController under `${channelId}:${agentId}` - a duplicate trigger for a
 * busy key throws DuplicateRunError instead of overwriting the live
 * controller.
 */
async function executeWithCancel(
  req: Parameters<typeof runtimeGate.execute>[0],
  executeRunOverride?: (req: Parameters<typeof runtimeGate.execute>[0]) => Promise<unknown>,
): Promise<any> {
  const key = runKey(req.channelId, req.agent.id);
  const entry = beginRun(key, req.agent.name);
  try {
    return await executeRunScoped({ ...req, abortSignal: entry.controller.signal }, executeRunOverride);
  } finally {
    endRun(key, entry);
  }
}
/**
 * Post a message into a channel and let the standard ladder decide who
 * answers. This is the ONLY path from "a message exists" to "an agent runs",
 * for an operator's message and for a scheduled wake alike.
 */
export async function dispatchChannelMessage(
  input: dispatchChannelMessageInput,
): Promise<dispatchChannelMessageResult> {
  const channel = await channelGate.get(input.channelId).catch(() => null);
  const workspaceId = channel?.workspaceId ?? input.workspaceId ?? "default";
  const broker = input.broker ?? null;
  const mode = input.mode ?? "inline";

  // §6: the channel's runtime pin is a PREFERENCE (tier rules and rollback
  // flags still apply), resolved once here so every caller - a typed message
  // and a cron wake - routes the same way. An explicit runtime (composer mode
  // or a cron wake) wins outright at the Router.
  const settings = await channelGate.getSettings(input.channelId, undefined, workspaceId).catch(() => null);
  const pinnedRuntime = runtimeTypeFromString(
    typeof (settings as any)?.pinnedRuntime === "string" ? (settings as any).pinnedRuntime : null,
  );
  const preferredRuntime = input.preferredRuntime ?? pinnedRuntime;

  // 1. Persist the message: the channel history and the agent's input are the
  //    same row, exactly like an operator's message.
  const message = await messageGate.append(
    {
      channelId: input.channelId,
      authorId: input.author.id,
      authorName: input.author.name,
      authorLevel: input.author.level,
      authorType: input.author.type,
      content: input.content,
      mentions: input.mentions ?? [],
      metadata: input.author.tag ? { authorTag: input.author.tag } : undefined,
    },
    broker ? { broker: broker as never } : undefined,
  );
  const messageId = message?.id ?? null;

  // 2. Roster, workspace-scoped (templates excluded).
  const allAgents = (await agentGate
    .list({ isTemplate: false, workspaceId } as never, undefined)
    .catch(() => [] as AgentProfile[])) as AgentProfile[];

  // 3. Who answers.
  const targets = await resolveMessageTargets({
    channelId: input.channelId,
    workspaceId,
    mentions: input.mentions ?? [],
    agents: allAgents,
  });

  const dispatched: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  // 4. Dispatch, serial (§10).
  for (const target of targets) {
    const agent = target.agent;
    if (agent.status === "paused") {
      await appendSystemWarning(input.channelId, `Agent @${agent.name} is currently paused.`, broker);
      skipped.push({ id: agent.id, reason: "paused" });
      continue;
    }
    if (agent.status === "offline") {
      await appendSystemWarning(input.channelId, `Agent @${agent.name} is currently offline.`, broker);
      skipped.push({ id: agent.id, reason: "offline" });
      continue;
    }
    console.log(`[dispatch] Triggering agent @${agent.name} (${agent.id}) via ${target.via} in #${input.channelId}`);

    if (mode === "queue") {
      const { runsGate } = await import("../../runs/runs-gate.js");
      const { queueGate } = await import("../../queue/queue-gate.js");
      // H4: persist first so the queued job + run.queued carry the real DB UUID.
      const persisted = await runsGate
        .create({
          agentId: agent.id,
          channelId: input.channelId,
          workspaceId,
          runtimeType: input.explicitRuntime ?? preferredRuntime ?? "auto",
        })
        .catch(() => null);
      if (!persisted?.id) {
        await appendSystemWarning(input.channelId, `System error queueing @${agent.name}: could not persist run.`, broker);
        skipped.push({ id: agent.id, reason: "run_persist_failed" });
        continue;
      }
      await queueGate.enqueueRun({
        runId: persisted.id,
        channelId: input.channelId,
        agentId: agent.id,
        messageId,
        userInput: input.content,
        workspaceId,
        explicitRuntime: input.explicitRuntime ?? null,
        preferredRuntime: preferredRuntime ?? null,
        operatorContext: input.operatorContext ?? null,
      });
      broker?.emit("run.queued" as never, { runId: persisted.id, channelId: input.channelId, agentId: agent.id } as never, { channelId: input.channelId });
      dispatched.push(agent.id);
      continue;
    }

    const executeRun = input.executeRun;
    try {
      const res = await executeWithCancel(
        {
          agent,
          channelId: input.channelId,
          workspaceId,
          userInput: input.content,
          broker: broker as never,
          explicitRuntime: input.explicitRuntime ?? undefined,
          preferredRuntime: preferredRuntime ?? undefined,
          librarianAgentId: "agent-librarian",
          operatorContext: input.operatorContext ?? null,
        } as Parameters<typeof runtimeGate.execute>[0],
        executeRun as never,
      );
      dispatched.push(agent.id);
      if (res && res.status === "cancelled") {
        console.log(`[dispatch] Run cancelled for agent @${agent.name}`);
      } else if (res && res.status === "failed") {
        console.error(`[dispatch] Execution failed for agent @${agent.name}:`, res.finalResponse);
        await appendSystemWarning(input.channelId, res.finalResponse, broker);
      }
    } catch (err: any) {
      if (err instanceof DuplicateRunError) {
        // CAN-1: a second trigger for a live channel:agent pair is rejected
        // with a system warning; the in-flight run keeps its controller.
        await appendSystemWarning(input.channelId, err.message, broker);
        skipped.push({ id: agent.id, reason: "busy" });
        continue;
      }
      console.error(`[dispatch] Execution failed for agent @${agent.name}:`, err?.message || err);
      await appendSystemWarning(input.channelId, `System error processing @${agent.name}: ${err?.message || err}`, broker);
      skipped.push({ id: agent.id, reason: "error" });
    }
  }

  return { messageId, workspaceId, dispatched, skipped };
}
