// 2026-10-20 (A3): a scheduled fire with a target agent starts a real inline
// run; execution is started, not awaited, so boot re-arm never blocks on it.

import type { EventBroker } from "../event-broker/event-broker-gate.js";
import { beginRun, endRun, runKey, DuplicateRunError } from "../shared/core/active-runs.js";
import { runtimeTypeFromString } from "../runtime/types.js";
import type { scheduleRow } from "./scheduler-local-store.js";

async function postNotice(row: scheduleRow, broker: EventBroker, content: string): Promise<void> {
  try {
    const { messageGate } = await import("../messages/message-gate.js");
    await messageGate.append(
      {
        channelId: row.channelId,
        authorId: "system",
        authorName: "System Warning",
        authorLevel: "stakeholder",
        authorType: "system",
        content,
        workspaceId: row.workspaceId,
      },
      { broker },
    );
  } catch {}
}

export async function dispatchScheduledRun(
  row: scheduleRow,
  userInput: string,
  broker: EventBroker,
): Promise<void> {
  if (!row.targetAgentId) return;

  const { agentGate } = await import("../agents/agent-gate.js");
  const agent = await agentGate.getById(row.targetAgentId, undefined, row.workspaceId);
  if (!agent) {
    await postNotice(row, broker, `Scheduled task ${row.id}: target agent ${row.targetAgentId} not found.`);
    return;
  }
  if (agent.status === "paused") {
    await postNotice(row, broker, `Agent @${agent.name} is currently paused.`);
    return;
  }
  if (agent.status === "offline") {
    await postNotice(row, broker, `Agent @${agent.name} is currently offline.`);
    return;
  }

  const key = runKey(row.channelId, agent.id);
  let entry;
  try {
    entry = beginRun(key, agent.name);
  } catch (err) {
    if (err instanceof DuplicateRunError) {
      await postNotice(row, broker, err.message);
      return;
    }
    throw err;
  }

  try {
    const { channelGate } = await import("../channels/channel-gate.js");
    const settings = await channelGate.getSettings(row.channelId, undefined, row.workspaceId).catch(() => null);
    const preferredRuntime = runtimeTypeFromString((settings as any)?.pinnedRuntime ?? null);

    const { runsGate } = await import("../runs/runs-gate.js");
    const created = await runsGate
      .create({
        agentId: agent.id,
        channelId: row.channelId,
        workspaceId: row.workspaceId,
        runtimeType: preferredRuntime ?? "auto",
      })
      .catch(() => null);

    const { runtimeGate } = await import("../runtime/runtime-gate.js");
    const execution = runtimeGate.execute({
      agent,
      channelId: row.channelId,
      workspaceId: row.workspaceId,
      userInput,
      broker,
      preferredRuntime,
      runId: created?.id ?? null,
      librarianAgentId: "agent-librarian",
      abortSignal: entry.controller.signal,
    });
    void execution
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] run failed for @${agent.name}: ${msg}`);
        await postNotice(row, broker, `System error processing @${agent.name}: ${msg}`);
      })
      .finally(() => endRun(key, entry));
  } catch (err) {
    endRun(key, entry);
    const msg = err instanceof Error ? err.message : String(err);
    await postNotice(row, broker, `System error processing @${agent.name}: ${msg}`);
  }
}
