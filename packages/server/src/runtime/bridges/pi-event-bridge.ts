import type { AgentEvent, EventStream } from '@crowdos/pi-core';
import type { EventBroker } from '../../event-broker/event-broker-gate.js';
import { createChunkCoalescer, type ChunkCoalescer } from '../../shared/core/stream-coalescer.js';
import type { ToolCallRecord, RuntimeEvent } from '../types.js';

export interface PiEventBridgeContext {
  agentId: string;
  agentName: string;
  channelId: string;
  workspaceId: string;
  broker: EventBroker;
}

export class PiEventBridge {
  static pipeToBroker(
    stream: EventStream,
    ctx: PiEventBridgeContext
  ): {
    toolCallRecords: ToolCallRecord[];
    runtimeEvents: RuntimeEvent[];
    waitForCompletion: () => Promise<{ finalContent: string; finalThoughts: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }>;
  } {
    const { agentId, channelId, broker } = ctx;
    const toolCallRecords: ToolCallRecord[] = [];
    const runtimeEvents: RuntimeEvent[] = [];
    let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    let resolveCompletion: (val: { finalContent: string; finalThoughts: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }) => void;
    let rejectCompletion: (err: any) => void;

    const completionPromise = new Promise<{ finalContent: string; finalThoughts: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    let collectedContent = '';
    let collectedThoughts = '';

    // PERF-6: coalesce per-delta socket emissions on the coding-run path at
    // the same STREAM_BATCH_MS cadence as the kernel path, so socket write
    // rate matches regardless of runtime. One instance per channel:agent
    // thought/content key, mirroring RuntimeKernel.streamKey granularity.
    const streamCoalescers = new Map<string, ChunkCoalescer>();

    const coalesceDelta = (suffix: 't' | 'c', isThoughts: boolean, content: string): void => {
      const key = `${channelId}:${agentId}:${suffix}`;
      let coalescer = streamCoalescers.get(key);
      if (!coalescer) {
        coalescer = createChunkCoalescer((chunk) => {
          broker.emit('message:stream', {
            channelId,
            agentId,
            chunk,
            isThoughts,
            streamed: true,
          }, { channelId });
        });
        streamCoalescers.set(key, coalescer);
      }
      coalescer.push(content);
    };

    const flushStreamCoalescers = (): void => {
      for (const coalescer of [...streamCoalescers.values()]) {
        coalescer.flush();
      }
      streamCoalescers.clear();
    };

    stream.on((event: AgentEvent) => {
      switch (event.type) {
        case 'thought_delta':
          if (event.content) {
            collectedThoughts += event.content;
            coalesceDelta('t', true, event.content);
          }
          break;

        case 'message_delta':
          if (event.content) {
            collectedContent += event.content;
            coalesceDelta('c', false, event.content);
          }
          break;

        case 'tool_call_start':
          if (event.toolCall) {
            broker.emit('tool:start', {
              callId: event.toolCall.id,
              agentId,
              channelId,
              toolName: event.toolCall.name,
              input: event.toolCall.arguments,
            });
            runtimeEvents.push({
              type: 'tool:start',
              payload: {
                callId: event.toolCall.id,
                toolName: event.toolCall.name,
                agentId,
                channelId,
              },
              timestamp: new Date(event.timestamp),
            });
          }
          break;

        case 'tool_call_end':
          if (event.toolResult) {
            const structuredToolCall = {
              name: event.toolResult.name,
              args: {},
              result: event.toolResult.output || event.toolResult.error || '',
              truncated: false,
              durationMs: event.toolResult.durationMs ?? null,
              callId: event.toolResult.id ?? null,
            };

            broker.emit('tool:complete', {
              callId: event.toolResult.id,
              agentId,
              channelId,
              toolName: event.toolResult.name,
              output: event.toolResult.success ? event.toolResult.output : undefined,
              error: event.toolResult.error,
              success: event.toolResult.success,
              durationMs: event.toolResult.durationMs,
              structuredToolCall,
            });

            runtimeEvents.push({
              type: 'tool:complete',
              payload: {
                callId: event.toolResult.id,
                toolName: event.toolResult.name,
                success: event.toolResult.success,
                durationMs: event.toolResult.durationMs,
                agentId,
                channelId,
              },
              timestamp: new Date(event.timestamp),
            });

            toolCallRecords.push({
              toolName: event.toolResult.name,
              input: {},
              output: event.toolResult.output || event.toolResult.error || '',
              success: event.toolResult.success,
              durationMs: event.toolResult.durationMs,
            });
          }
          break;

        case 'agent_end':
          flushStreamCoalescers();
          if (event.usage) {
            totalUsage = event.usage;
          }
          resolveCompletion({
            finalContent: event.content || collectedContent,
            finalThoughts: event.thoughts || collectedThoughts,
            usage: totalUsage,
          });
          break;

        case 'error':
          flushStreamCoalescers();
          rejectCompletion(new Error(event.error || 'Unknown Pi execution error'));
          break;
      }
    });

    return {
      toolCallRecords,
      runtimeEvents,
      waitForCompletion: () => completionPromise,
    };
  }
}
