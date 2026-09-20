import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ContextPacket, RuntimeResult, LLMRequest, ModelModuleConfig } from '../types.js';
import type { EventBroker } from '../../event-broker/event-broker-gate.js';
import { BaseRuntime } from './base-runtime.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import { AgentSession, type PiModelAdapter, type PiMessage, type PiToolSchema } from '@crowdspace/pi-core';
import { PiToolBridge } from '../bridges/pi-tool-bridge.js';
import { PiEventBridge } from '../bridges/pi-event-bridge.js';

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// Channel-mount-aware root: channel → category → workspace → workspace dir.
// Dynamic import keeps the Runtime → ChannelMounts gate edge lazy (no module cycle).
async function resolveRuntimeRoot(packet: { channelId?: string; workspaceId?: string }): Promise<string> {
  if (packet?.channelId) {
    try {
      const { channelMountGate } = await import('../../channel-mounts/channel-mount-gate.js');
      const mount = await channelMountGate.resolve(packet.channelId);
      if (mount?.effectivePath) return mount.effectivePath;
    } catch {}
  }
  const { Guard } = await import('../../tools/safety/guard.js');
  return Guard.getWorkspaceDir(packet?.workspaceId);
}

function generateNaivePatch(filePath: string, before: string, after: string): string {
  if (before === after) return `--- a/${filePath}\n+++ b/${filePath}\n(no changes)`;
  const bLines = before.split('\n');
  const aLines = after.split('\n');
  let out = `--- a/${filePath}\n+++ b/${filePath}\n`;
  out += `@@ -1,${bLines.length} +1,${aLines.length} @@\n`;
  let i = 0;
  let j = 0;
  while (i < bLines.length || j < aLines.length) {
    if (i < bLines.length && j < aLines.length && bLines[i] === aLines[j]) {
      out += ` ${bLines[i]}\n`;
      i++;
      j++;
    } else {
      if (i < bLines.length) { out += `-${bLines[i]}\n`; i++; }
      if (j < aLines.length) { out += `+${aLines[j]}\n`; j++; }
    }
  }
  return out;
}

async function buildPatch(filePath: string, before: string, after: string): Promise<string> {
  try {
    const diffMod: any = await import('diff').catch(() => null);
    if (diffMod?.createTwoFilesPatch) {
      return diffMod.createTwoFilesPatch(filePath, filePath, before, after, 'original', 'modified');
    }
    const piDiff: any = await import('@crowdspace/pi-core').catch(() => null);
    if (piDiff?.createTwoFilesPatch) {
      return piDiff.createTwoFilesPatch(filePath, filePath, before, after, 'original', 'modified');
    }
  } catch {}
  return generateNaivePatch(filePath, before, after);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class CodingRuntime extends BaseRuntime {
  readonly type = 'coding' as const;

  async execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult> {
    try {
      // Cancellation checkpoint (HM2)
      if (packet.abortSignal?.aborted) {
        return {
          requestId: packet.requestId,
          agentId: packet.agentId,
          channelId: packet.channelId,
          finalResponse: 'Run cancelled by user.',
          runtimeEvents: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          status: 'cancelled',
        };
      }

      await this.kernel.setAgentStatus(broker, packet.agentId, 'working');
      this.kernel.emitThinking(broker, packet.agentId, packet.channelId);

      const modelConfig: ModelModuleConfig = (packet as any)._modelConfig || {
        provider: 'google',
        modelName: 'gemini-2.0-flash',
        temperature: 0.2,
        maxOutputTokens: 4096,
      };

      const adapter = ProviderRegistry.get(modelConfig.provider);

      // Construct dynamic PiModelAdapter that invokes the registered ProviderAdapter.
      // The run's abortSignal rides through pi-core (CAN-1): loop boundaries,
      // tool dispatch, and provider fetches all observe it.
      const piAdapter: PiModelAdapter = async (config, messages, tools, onChunk, signal) => {
        const history: any[] = [];
        let systemPrompt = '';
        let userPrompt = '';

        for (const msg of messages) {
          if (msg.role === 'system') {
            systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
          } else if (msg.role === 'user') {
            if (userPrompt) {
              history.push({ role: 'user', content: userPrompt, timestamp: new Date() });
            }
            userPrompt = msg.content;
          } else if (msg.role === 'assistant') {
            const rawCalls = (msg as any).toolCalls?.map((tc: any) => ({
              id: tc.id,
              name: tc.name,
              input: tc.arguments || tc.input || {},
            }));
            history.push({
              role: 'assistant',
              content: msg.content || '',
              timestamp: new Date(),
              toolCalls: rawCalls && rawCalls.length > 0 ? rawCalls : undefined,
            });
          } else if (msg.role === 'tool') {
            history.push({
              role: 'tool',
              content: msg.content,
              toolCallId: (msg as any).toolCallId || 'call_' + Date.now(),
              toolName: (msg as any).name || 'tool',
              timestamp: new Date(),
            });
          }
        }

        const llmRequest: LLMRequest = {
          systemPrompt: systemPrompt || packet.systemPrompt,
          userPrompt: userPrompt || packet.userInput,
          history,
          temperature: config.temperature ?? modelConfig.temperature ?? 0.2,
          maxTokens: config.maxOutputTokens ?? modelConfig.maxOutputTokens ?? 4096,
          tools: tools.map((t: PiToolSchema) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters as any,
          })),
        };

        // CAN-1: pre-stream retry policy + caller signal into the provider fetch
        const response = await this.invokeProviderWithPreStreamRetry(async (markStreamStarted) =>
          adapter.call(
            {
              ...modelConfig,
              ...config,
            },
            llmRequest,
            (chunk) => {
              markStreamStarted();
              if (onChunk) {
                onChunk({
                  content: chunk.content,
                  thoughts: chunk.thoughts,
                  isThoughts: chunk.isThoughts,
                });
              }
            },
            { signal: signal ?? packet.abortSignal }
          )
        );

        // Read native tool calls from adapter response
        const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> =
          (response.toolCalls || []).map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.input as Record<string, unknown>,
          }));

        return {
          content: response.content,
          thoughts: response.thoughts,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: response.usage,
          finishReason: response.finishReason,
        };
      };

      // Create coding tools and custom agent tools (run signal aborts long tools)
      // APR-1: runId + broker forwarded so execute_bash ASK can pause WAITING_FOR_APPROVAL
      const rawCodingTools = PiToolBridge.createCodingTools({
        agentId: packet.agentId,
        channelId: packet.channelId,
        workspaceId: packet.workspaceId,
        authorityLevel: packet.authorityLevel,
        broker,
        runId: packet.runId ?? null,
        abortSignal: packet.abortSignal,
      });

      const codingTools = rawCodingTools.map((tool) => {
        if (tool.name === 'write_file') {
          return {
            ...tool,
            execute: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
              const targetPath = args?.path as string | undefined;
              const content = args?.content as string | undefined;
              if (typeof targetPath !== 'string' || typeof content !== 'string') {
                return { success: false, output: '', error: 'write_file requires path and content' };
              }
              let resolved: string;
              try {
                const { Guard } = await import('../../tools/safety/guard.js');
                resolved = await Guard.validatePath(targetPath, await resolveRuntimeRoot(packet));
              } catch (e: any) {
                return { success: false, output: '', error: e?.message || String(e) };
              }
              let beforeContent: string | null = null;
              let existed = false;
              try { beforeContent = await fs.readFile(resolved, 'utf8'); existed = true; } catch { existed = false; beforeContent = null; }
              const beforeHash = beforeContent !== null ? sha256Hex(beforeContent) : null;
              try {
                await fs.mkdir(path.dirname(resolved), { recursive: true });
                await fs.writeFile(resolved, content, 'utf8');
              } catch (e: any) {
                return { success: false, output: '', error: `Failed to write ${targetPath}: ${e?.message || String(e)}` };
              }
              const afterHash = sha256Hex(content);
              let patch = '';
              try { patch = await buildPatch(targetPath, beforeContent ?? '', content); } catch { patch = generateNaivePatch(targetPath, beforeContent ?? '', content); }
              if (packet.runId) {
                try {
                  const { runsGate } = await import('../../runs/runs-gate.js');
                  const inverse = runsGate.buildCompensationInverse({ existed, priorContent: beforeContent, path: targetPath });
                  await runsGate.addCompensation(packet.runId as string, { toolName: 'write_file', targetPath, inverseOp: inverse });
                } catch {}
              }
              if (packet.runId) {
                try {
                  const { artifactsGate } = await import('../../artifacts/artifacts-gate.js');
                  await artifactsGate.create({
                    runId: packet.runId as string,
                    workspaceId: packet.workspaceId,
                    producerAgent: packet.agentId,
                    type: existed ? 'diff' : 'file',
                    path: targetPath,
                    beforeHash,
                    afterHash,
                    patch,
                    contentRef: content.length > 20000 ? content.slice(0, 20000) : content,
                  });
                } catch {}
              }
              try {
                const { globalBroker } = await import('../../shared/sockets/register-socket-server.js');
                globalBroker?.emit("sandbox:updated", {
                  sandboxId: packet.workspaceId || "default-sandbox",
                  workspaceId: packet.workspaceId || "default",
                  path: targetPath,
                  changeType: "modify",
                  timestamp: new Date().toISOString()
                });
              } catch {}
              return { success: true, output: patch || `Successfully wrote file to ${targetPath}` };
            },
          };
        }
        if (tool.name === 'edit_file') {
          return {
            ...tool,
            execute: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
              const targetPath = args?.path as string | undefined;
              const targetContent = args?.targetContent as string | undefined;
              const replacementContent = args?.replacementContent as string | undefined;
              const allowMultiple = Boolean(args?.allowMultiple);
              const startLine = args?.startLine as number | undefined;
              const endLine = args?.endLine as number | undefined;
              if (typeof targetPath !== 'string' || typeof targetContent !== 'string' || typeof replacementContent !== 'string') {
                return { success: false, output: '', error: 'edit_file requires path, targetContent, replacementContent' };
              }
              let resolved: string;
              try {
                const { Guard } = await import('../../tools/safety/guard.js');
                resolved = await Guard.validatePath(targetPath, await resolveRuntimeRoot(packet));
              } catch (e: any) {
                return { success: false, output: '', error: e?.message || String(e) };
              }
              let originalContent: string;
              try {
                originalContent = await fs.readFile(resolved, 'utf8');
              } catch (e: any) {
                return { success: false, output: '', error: `Failed to read ${targetPath}: ${e?.message || String(e)}` };
              }
              const beforeHash = sha256Hex(originalContent);
              let contentToSearch = originalContent;
              let prefix = '';
              let suffix = '';
              if (startLine || endLine) {
                const lines = originalContent.split('\n');
                const start = startLine ? Math.max(1, startLine) - 1 : 0;
                const end = endLine ? Math.min(lines.length, endLine) : lines.length;
                prefix = lines.slice(0, start).join('\n') + (start > 0 ? '\n' : '');
                contentToSearch = lines.slice(start, end).join('\n');
                suffix = (end < lines.length ? '\n' : '') + lines.slice(end).join('\n');
              }
              const occurrences = (contentToSearch.match(new RegExp(escapeRegExp(targetContent), 'g')) || []).length;
              if (occurrences === 0) {
                const normalizedSearch = contentToSearch.replace(/\r\n/g, '\n');
                const normalizedTarget = targetContent.replace(/\r\n/g, '\n');
                if (!normalizedSearch.includes(normalizedTarget)) {
                  return { success: false, output: '', error: `Target content not found in ${targetPath}${startLine ? ` (within lines ${startLine}-${endLine})` : ''}. Ensure whitespace and line numbers match exactly.` };
                }
              }
              if (occurrences > 1 && !allowMultiple) {
                return { success: false, output: '', error: `Target content found ${occurrences} times in ${targetPath}. Specify startLine/endLine or set allowMultiple: true to disambiguate.` };
              }
              let modifiedSlice: string;
              if (allowMultiple) {
                modifiedSlice = contentToSearch.split(targetContent).join(replacementContent);
              } else {
                modifiedSlice = contentToSearch.replace(targetContent, replacementContent);
              }
              const finalContent = prefix + modifiedSlice + suffix;
              try {
                await fs.mkdir(path.dirname(resolved), { recursive: true });
                await fs.writeFile(resolved, finalContent, 'utf8');
              } catch (e: any) {
                return { success: false, output: '', error: `Failed to edit ${targetPath}: ${e?.message || String(e)}` };
              }
              const afterHash = sha256Hex(finalContent);
              let diffText = '';
              try { diffText = await buildPatch(targetPath, originalContent, finalContent); } catch { diffText = generateNaivePatch(targetPath, originalContent, finalContent); }
              if (packet.runId) {
                try {
                  const { runsGate } = await import('../../runs/runs-gate.js');
                  const inverse = runsGate.buildCompensationInverse({ existed: true, priorContent: originalContent, path: targetPath });
                  await runsGate.addCompensation(packet.runId as string, { toolName: 'edit_file', targetPath, inverseOp: inverse });
                } catch {}
              }
              if (packet.runId) {
                try {
                  const { artifactsGate } = await import('../../artifacts/artifacts-gate.js');
                  await artifactsGate.create({
                    runId: packet.runId as string,
                    workspaceId: packet.workspaceId,
                    producerAgent: packet.agentId,
                    type: 'diff',
                    path: targetPath,
                    beforeHash,
                    afterHash,
                    patch: diffText,
                    contentRef: finalContent.length > 20000 ? finalContent.slice(0, 20000) : finalContent,
                  });
                } catch {}
              }
              return { success: true, output: diffText || `Edited ${targetPath}: ${occurrences || 1} occurrence(s) replaced` };
            },
          };
        }
        return tool;
      });

      const customTools = await PiToolBridge.createAgentCustomTools({
        agentId: packet.agentId,
        channelId: packet.channelId,
        workspaceId: packet.workspaceId,
        authorityLevel: packet.authorityLevel,
        broker,
        runId: packet.runId ?? null,
        abortSignal: packet.abortSignal,
      });

      const allTools = [...codingTools, ...customTools];

      // Convert packet history to PiMessage[]
      const initialHistory: PiMessage[] = (packet.history || []).map((h) => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content,
        name: h.authorName,
      }));

      // Initialize Pi AgentSession
      const session = new AgentSession({
        sessionId: `session_${packet.agentId}_${packet.channelId}`,
        modelConfig: {
          provider: modelConfig.provider as any,
          modelName: modelConfig.modelName || 'gemini-2.0-flash',
          temperature: modelConfig.temperature ?? 0.2,
          maxOutputTokens: modelConfig.maxOutputTokens ?? 4096,
        },
        modelAdapter: piAdapter,
        systemPrompt: packet.systemPrompt,
        tools: allTools,
        initialHistory,
      });

      // Prompt session and stream events to broker (CAN-1: run signal plumbed in)
      const stream = session.prompt(packet.userInput, packet.abortSignal);

      const bridge = PiEventBridge.pipeToBroker(stream, {
        agentId: packet.agentId,
        agentName: packet.agentName,
        channelId: packet.channelId,
        workspaceId: packet.workspaceId,
        broker,
      });

      const { finalContent, finalThoughts, usage } = await bridge.waitForCompletion();

      // Persist thoughts if present
      if (finalThoughts) {
        await this.kernel.persistMessage(
          broker,
          packet.channelId,
          packet.agentId,
          packet.agentName,
          packet.authorityLevel,
          finalThoughts,
          true,
          packet.runId ? { runId: packet.runId } : undefined,
          undefined,
          packet.workspaceId
        );

        // Auto-write monologue reflection memory note — off the hot path (HQ3)
        const { hook, brief: cleanBrief } = this.summarizeThoughts(finalThoughts)
        this.writeReflectionNoteAsync({
          agentId: packet.agentId,
          channelId: packet.channelId,
          importanceScore: 0.7,
          hook,
          brief: cleanBrief,
          observed: `Coding execution completed for task: "${packet.userInput.slice(0, 100)}"`,
          interpreted: finalThoughts.trim(),
          futureRelevance: 'Retain code modifications and architecture context for future implementation sessions.',
        })
      }

      // Persist final user-facing response message in DB
      await this.kernel.persistMessage(
        broker,
        packet.channelId,
        packet.agentId,
        packet.agentName,
        packet.authorityLevel,
        finalContent,
        false,
        packet.runId ? { runId: packet.runId } : undefined
      );

      await this.kernel.setAgentStatus(broker, packet.agentId, 'idle');

      return {
        requestId: packet.requestId,
        agentId: packet.agentId,
        channelId: packet.channelId,
        finalResponse: finalContent,
        toolCalls: bridge.toolCallRecords,
        runtimeEvents: bridge.runtimeEvents,
        usage,
        status: 'completed',
      };
    } catch (err) {
      console.error('[CodingRuntime] Execution Error:', err);
      await this.kernel.setAgentStatus(broker, packet.agentId, 'idle');
      return await this.buildFailedResult(packet, err, broker);
    }
  }
}
