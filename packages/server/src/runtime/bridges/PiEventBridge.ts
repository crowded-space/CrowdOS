import type { AgentEvent, EventStream } from '@crowdos/pi-core';
import type { EventBroker } from '../../EventBroker/eventBrokerGate.js';
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
    waitForCompletion: () => Promise<{ finalContent: string; finalThoughts: string }>;
  } {
    const { agentId, channelId, broker } = ctx;
    const toolCallRecords: ToolCallRecord[] = [];
    const runtimeEvents: RuntimeEvent[] = [];

    let resolveCompletion: (val: { finalContent: string; finalThoughts: string }) => void;
    let rejectCompletion: (err: any) => void;

    const completionPromise = new Promise<{ finalContent: string; finalThoughts: string }>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    let collectedContent = '';
    let collectedThoughts = '';

    stream.on((event: AgentEvent) => {
      switch (event.type) {
        case 'thought_delta':
          if (event.content) {
            collectedThoughts += event.content;
            broker.emit('message:stream', {
              channelId,
              agentId,
              chunk: event.content,
              isThoughts: true,
            });
          }
          break;

        case 'message_delta':
          if (event.content) {
            collectedContent += event.content;
            broker.emit('message:stream', {
              channelId,
              agentId,
              chunk: event.content,
              isThoughts: false,
            });
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
            broker.emit('tool:complete', {
              callId: event.toolResult.id,
              agentId,
              channelId,
              toolName: event.toolResult.name,
              output: event.toolResult.success ? event.toolResult.output : undefined,
              error: event.toolResult.error,
              success: event.toolResult.success,
              durationMs: event.toolResult.durationMs,
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
          resolveCompletion({
            finalContent: event.content || collectedContent,
            finalThoughts: event.thoughts || collectedThoughts,
          });
          break;

        case 'error':
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
