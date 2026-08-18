import type { PiMessage, PiModelConfig, PiModelAdapter } from '../ai/types.js';
import type { AgentTool } from '../agent/types.js';
import { runAgentLoop } from '../agent/agent-loop.js';
import { EventStream } from '../agent/event-stream.js';
import { compactHistory, type CompactionConfig } from './compaction.js';

export interface AgentSessionOptions {
  sessionId: string;
  modelConfig: PiModelConfig;
  modelAdapter: PiModelAdapter;
  systemPrompt?: string;
  tools?: AgentTool[];
  initialHistory?: PiMessage[];
  compactionConfig?: CompactionConfig;
}

export class AgentSession {
  readonly sessionId: string;
  private modelConfig: PiModelConfig;
  private modelAdapter: PiModelAdapter;
  private systemPrompt: string;
  private history: PiMessage[] = [];
  private tools: Map<string, AgentTool> = new Map();
  private compactionConfig?: CompactionConfig;

  constructor(options: AgentSessionOptions) {
    this.sessionId = options.sessionId;
    this.modelConfig = options.modelConfig;
    this.modelAdapter = options.modelAdapter;
    this.systemPrompt = options.systemPrompt || '';
    if (options.initialHistory) {
      this.history = [...options.initialHistory];
    }
    if (options.tools) {
      for (const t of options.tools) {
        this.tools.set(t.name, t);
      }
    }
    this.compactionConfig = options.compactionConfig;
  }

  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  unregisterTool(toolName: string): void {
    this.tools.delete(toolName);
  }

  getTools(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  getHistory(): PiMessage[] {
    return [...this.history];
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  updateModelConfig(config: Partial<PiModelConfig>): void {
    this.modelConfig = { ...this.modelConfig, ...config };
  }

  prompt(userInput: string, abortSignal?: AbortSignal): EventStream {
    // Compact history if necessary
    const { messages: compactedHistory } = compactHistory(this.history, this.compactionConfig);
    this.history = compactedHistory;

    const stream = runAgentLoop({
      modelConfig: this.modelConfig,
      modelAdapter: this.modelAdapter,
      systemPrompt: this.systemPrompt,
      history: this.history,
      userInput,
      tools: this.getTools(),
      abortSignal,
    });

    // Track completed turn in session history
    stream.on((event) => {
      if (event.type === 'agent_end') {
        this.history.push({ role: 'user', content: userInput });
        this.history.push({
          role: 'assistant',
          content: event.content || '',
          thoughts: event.thoughts,
        });
      }
    });

    return stream;
  }
}
