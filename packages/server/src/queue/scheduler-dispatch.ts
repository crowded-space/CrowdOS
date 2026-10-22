// 2026-10-20 (A3): a scheduled fire wakes an agent.
// 2026-10-22: a wake is an automated MESSAGE, not a private side channel.
//
// The wake posts the prompt into the channel and lets the standard ladder
// decide who answers - an explicit target if the schedule names one, else the
// channel's PINNED agent (the same default an operator's message resolves).
// The only difference from a message the operator typed is the runtime: a
// wake always routes AGENTIC, whatever the channel's runtime pin says.
//
// The dispatch itself lives in shared/core/message-dispatch.ts so an operator
// message and a cron wake cannot drift apart.

import type { EventBroker } from "../event-broker/event-broker-gate.js";
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
  // The shared dispatch pulls the agents/channels/messages/runtime gates in.
  // It is loaded lazily so the Queue gate's own import graph stays light.
  const { dispatchChannelMessage } = await import("../shared/core/message-dispatch.js");
  const { agentGate } = await import("../agents/agent-gate.js");

  // An explicit target is expressed as a MENTION - the same shape as an
  // operator typing "@Name ..." - so the shared ladder treats it identically.
  if (row.targetAgentId) {
    const agent = await agentGate.getById(row.targetAgentId, undefined, row.workspaceId).catch(() => null);
    if (!agent) {
      await postNotice(row, broker, `Scheduled task ${row.id}: target agent ${row.targetAgentId} not found.`);
      return;
    }
  }

  // WHO wrote the wake message decides how it is delivered. An agent that
  // scheduled its own next wake gets its own words back, under its own sender
  // id - the message is the agent's, not the scheduler's. A task the operator
  // created (the watchdog) is a system message.
  const author = row.authorAgentId
    ? await agentGate.getById(row.authorAgentId, undefined, row.workspaceId).catch(() => null)
    : null;
  const messageAuthor = author
    ? {
        id: author.id,
        name: author.name,
        level: String(author.authorityLevel ?? "agent"),
        type: "agent" as const,
      }
    : {
        id: "system-scheduler",
        name: "Scheduler",
        level: "system",
        type: "system" as const,
      };

  await dispatchChannelMessage({
    channelId: row.channelId || "general",
    workspaceId: row.workspaceId,
    content: userInput,
    author: messageAuthor,
    mentions: row.targetAgentId ? [{ type: "agent", targetId: row.targetAgentId }] : [],
    // A wake always runs on the Agentic runtime: it is a task, not a chat.
    explicitRuntime: "agentic",
    broker: broker as never,
    mode: "inline",
  });
}
