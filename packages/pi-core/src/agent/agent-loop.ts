import type { AgentLoopOptions, AgentEvent } from './types.js';
import type { PiMessage, PiToolSchema } from '../ai/types.js';
import { EventStream } from './event-stream.js';

export function runAgentLoop(options: AgentLoopOptions): EventStream {
  const stream = new EventStream();

  (async () => {
    const {
      modelConfig,
      modelAdapter,
      systemPrompt,
      history,
      userInput,
      tools,
      maxSteps = 15,
      abortSignal,
    } = options;

    const messages: PiMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    if (history && history.length > 0) {
      messages.push(...history);
    }

    messages.push({ role: 'user', content: userInput });

    stream.emit({
      type: 'agent_start',
      timestamp: Date.now(),
      data: { model: modelConfig.modelName, provider: modelConfig.provider },
    });

    const toolSchemas: PiToolSchema[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const toolMap = new Map(tools.map((t) => [t.name, t]));

    let step = 0;
    let finalContent = '';
    let finalThoughts = '';

    try {
      while (step < maxSteps) {
        if (abortSignal?.aborted) {
          throw new Error('Agent execution aborted by user or timeout.');
        }

        step++;

        let stepThoughts = '';
        let stepContent = '';

        const response = await modelAdapter(
          modelConfig,
          messages,
          toolSchemas,
          (chunk) => {
            if (chunk.isThoughts && chunk.content) {
              stepThoughts += chunk.content;
              stream.emit({
                type: 'thought_delta',
                timestamp: Date.now(),
                content: chunk.content,
                thoughts: stepThoughts,
              });
            } else if (chunk.content) {
              stepContent += chunk.content;
              stream.emit({
                type: 'message_delta',
                timestamp: Date.now(),
                content: chunk.content,
              });
            }
          },
          abortSignal
        );

        finalContent = response.content || stepContent;
        if (response.thoughts) finalThoughts = response.thoughts;

        // Check if there are tool calls
        if (response.toolCalls && response.toolCalls.length > 0) {
          // Record assistant message with tool calls
          messages.push({
            role: 'assistant',
            content: response.content || '',
            thoughts: response.thoughts,
            toolCalls: response.toolCalls,
          });

          for (const call of response.toolCalls) {
            if (abortSignal?.aborted) {
              throw new Error('Agent execution aborted during tool execution.');
            }

            stream.emit({
              type: 'tool_call_start',
              timestamp: Date.now(),
              toolCall: call,
            });

            const startTime = Date.now();
            const tool = toolMap.get(call.name);

            let toolResult: { success: boolean; output: string; error?: string };

            if (!tool) {
              toolResult = {
                success: false,
                output: '',
                error: `Tool "${call.name}" is not authorized or not found.`,
              };
            } else {
              try {
                toolResult = await tool.execute(call.arguments, abortSignal);
              } catch (err: any) {
                toolResult = {
                  success: false,
                  output: '',
                  error: String(err?.message || err),
                };
              }
            }

            const durationMs = Date.now() - startTime;

            stream.emit({
              type: 'tool_call_end',
              timestamp: Date.now(),
              toolResult: {
                id: call.id,
                name: call.name,
                success: toolResult.success,
                output: toolResult.output,
                error: toolResult.error,
                durationMs,
              },
            });

            // Append tool result turn into messages
            messages.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: toolResult.success ? toolResult.output : `ERROR: ${toolResult.error || 'Tool execution failed'}`,
            });
          }

          // Continue next turn to let model interpret tool results
          continue;
        }

        // No tool calls -> model finished
        stream.emit({
          type: 'turn_complete',
          timestamp: Date.now(),
          content: finalContent,
          thoughts: finalThoughts,
        });

        break;
      }

      stream.emit({
        type: 'agent_end',
        timestamp: Date.now(),
        content: finalContent,
        thoughts: finalThoughts,
      });
    } catch (err: any) {
      stream.emit({
        type: 'error',
        timestamp: Date.now(),
        error: String(err?.message || err),
      });
    }
  })();

  return stream;
}
