import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.__SOCKET_FAKE_DB__ = "1";
});

import { EventBroker } from '../EventBroker/eventBrokerGate.js';
import type { StructuredToolCall } from '../Messages/messageGate.js';
import { messageGate } from '../Messages/messageGate.js';
import { RuntimeKernel } from './kernel/RuntimeKernel.js';

const CHANNEL_ID = 'db5-roundtrip-channel';
const AGENT_ID = 'db5-roundtrip-agent';
const AGENT_NAME = 'DB5 Agent';

function emojiContent(toolName: string, outcome: string): string {
  return `🛠️ [Tool Result: ${toolName}]\n${outcome}`;
}

describe('DB-5 structured tool-call records round-trip', () => {
  it('extracts identical tool cards from structured column and legacy emoji strings', async () => {
    const broker = new EventBroker();
    const kernel = new RuntimeKernel();
    // persistMessage resolves message tenancy from the channel row.
    const databaseModule = await import('../Shared/config/database.js');
    const testDb = (databaseModule as any).__socketTestDb as {
      store: { channels: Record<string, unknown>[] };
      reset(): void;
    };
    testDb.reset();
    testDb.store.channels.push({ id: CHANNEL_ID, workspaceId: 'default', name: 'roundtrip' });
    const messageNewPayloads: Array<{ id: string; content: string; toolCalls?: StructuredToolCall[] }> = [];
    broker.on('message:new', undefined, (event: any) => {
      messageNewPayloads.push({ id: event.payload.id, content: event.payload.content, toolCalls: event.payload.toolCalls });
    });

    const sourceStructured: StructuredToolCall[] = [
      {
        name: 'web_search',
        args: { query: 'crowdos', limit: 5 },
        result: 'found 3 matches for crowdos',
        truncated: false,
        durationMs: 421,
        callId: 'call_db5_success',
      },
      {
        name: 'run_shell',
        args: { command: 'exit 1' },
        result: 'Error: command failed with code 1',
        truncated: true,
        durationMs: 88,
        callId: 'call_db5_error',
      },
    ];

    await kernel.persistMessage(
      broker, CHANNEL_ID, AGENT_ID, AGENT_NAME, 3,
      'Thinking. <call_tool name="read_file">{"path":"src/index.ts"}</call_tool> then more thoughts.',
      true
    );

    await kernel.persistMessage(
      broker, CHANNEL_ID, AGENT_ID, AGENT_NAME, 3,
      emojiContent('read_file', 'export const answer = 42;'),
      true
    );

    await kernel.persistMessage(
      broker, CHANNEL_ID, AGENT_ID, AGENT_NAME, 3,
      emojiContent('web_search', String(sourceStructured[0].result)),
      true,
      { runId: 'db5-run' },
      [sourceStructured[0]]
    );

    await kernel.persistMessage(
      broker, CHANNEL_ID, AGENT_ID, AGENT_NAME, 3,
      emojiContent('run_shell', String(sourceStructured[1].result)),
      true,
      { runId: 'db5-run' },
      [sourceStructured[1]]
    );

    expect(messageNewPayloads).toHaveLength(4);
    expect(messageNewPayloads[2].toolCalls).toEqual([sourceStructured[0]]);
    expect(messageNewPayloads[3].toolCalls).toEqual([sourceStructured[1]]);
    expect(messageNewPayloads[0].toolCalls).toBeUndefined();
    expect(messageNewPayloads[1].toolCalls).toBeUndefined();

    const merged = await messageGate.getChannelMessages(CHANNEL_ID, true);
    const cards = merged.filter((m: any) => m.type === 'tool_execution');
    expect(cards).toHaveLength(3);

    const legacyCard = cards.find((c: any) => c.toolExecution.name === 'read_file');
    expect(legacyCard).toMatchObject({
      type: 'tool_execution',
      authorId: AGENT_ID,
      authorType: 'agent',
      content: '',
      toolExecution: {
        name: 'read_file',
        input: '{"path":"src/index.ts"}',
        output: 'export const answer = 42;',
        status: 'success',
        durationMs: 0,
      },
    });

    const successSource = sourceStructured[0];
    const successCard = cards.find((c: any) => c.toolExecution.name === 'web_search');
    expect(successCard.id).toBe(`tool-${messageNewPayloads[2].id}`);
    expect(successCard.toolExecution).toEqual({
      name: successSource.name,
      input: JSON.stringify(successSource.args),
      output: successSource.result,
      status: 'success',
      durationMs: successSource.durationMs,
    });

    const errorSource = sourceStructured[1];
    const errorCard = cards.find((c: any) => c.toolExecution.name === 'run_shell');
    expect(errorCard.toolExecution).toEqual({
      name: errorSource.name,
      input: JSON.stringify(errorSource.args),
      output: errorSource.result,
      status: 'error',
      durationMs: errorSource.durationMs,
    });
  });
});
