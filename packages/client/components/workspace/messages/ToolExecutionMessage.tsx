import { useState } from 'react';
import { Settings, ChevronDown, ChevronUp, Cpu, Timer, Copy, Check } from 'lucide-react';
import { ToolExecution } from '@/types/crowdOs';

interface ToolExecutionMessageProps {
  toolExecution?: ToolExecution;
  timestamp: string;
  inline?: boolean;
}

export default function ToolExecutionMessage({ toolExecution, timestamp, inline = false }: ToolExecutionMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const [copiedInput, setCopiedInput] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);

  if (!toolExecution) return null;

  const { name, input, output, durationMs, status } = toolExecution;

  const isSuccess = status === 'success';
  const isWorking = status === 'working';

  const handleCopyInput = () => {
    navigator.clipboard.writeText(input);
    setCopiedInput(true);
    setTimeout(() => setCopiedInput(false), 2000);
  };

  const handleCopyOutput = () => {
    if (output) {
      navigator.clipboard.writeText(output);
      setCopiedOutput(true);
      setTimeout(() => setCopiedOutput(false), 2000);
    }
  };

  // Dynamic pill style mappings based on tool category
  const getToolPillStyle = (toolName: string) => {
    const memoryTools = ['open_memory', 'remember', 'discard_memory_from_context'];
    const fileTools = ['read_file', 'write_file', 'list_directory', 'delete_file'];
    const bashTools = ['execute_bash', 'execute_safe', 'sandbox.exec'];
    const dbTools = ['query_database', 'db.query'];
    const swarmTools = ['dispatch_agent', 'system_scheduler', 'search_all_channels', 'agent.orchestrate'];

    if (memoryTools.includes(toolName)) {
      return 'bg-blue-500/10 text-blue-400 border border-blue-500/30 rounded-full px-2.5';
    }
    if (fileTools.includes(toolName)) {
      return 'bg-teal-500/10 text-teal-400 border border-teal-500/30 rounded px-1.5';
    }
    if (bashTools.includes(toolName)) {
      return 'bg-rose-500/10 text-rose-400 border border-rose-500/30 rounded px-1.5';
    }
    if (dbTools.includes(toolName)) {
      return 'bg-amber-500/10 text-amber-400 border border-amber-500/30 rounded px-1.5';
    }
    if (swarmTools.includes(toolName)) {
      return 'bg-purple-500/10 text-purple-400 border border-purple-500/30 rounded px-1.5';
    }
    return 'bg-zinc-950 text-zinc-100 border border-zinc-800 rounded px-1.5';
  };

  let statusBadgeClass = 'bg-rose-500/10 text-rose-400 border border-rose-500/20';
  let statusText = 'ERROR';
  let settingsColor = 'text-rose-400';

  if (isSuccess) {
    statusBadgeClass = 'bg-teal-500/10 text-teal-400 border border-teal-500/20';
    statusText = 'SUCCESS';
    settingsColor = 'text-teal-400';
  } else if (isWorking) {
    statusBadgeClass = 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
    statusText = 'RUNNING';
    settingsColor = 'text-amber-400 animate-spin';
  }

  const containerClass = inline
    ? "w-full border border-zinc-800 bg-zinc-950/60 rounded-xl overflow-hidden font-mono text-xs"
    : "max-w-xl mx-auto border border-zinc-800 bg-zinc-950/40 rounded-lg overflow-hidden my-2 font-mono text-xs shadow-md";

  return (
    <div 
      id="tool-execution-message"
      className={containerClass}
    >
      {/* Header clickable to expand */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 bg-zinc-900/40 hover:bg-zinc-900/70 transition border-b border-zinc-900 text-left cursor-pointer focus:outline-none select-none"
      >
        <div className="flex items-center gap-2">
          <Settings 
            size={13} 
            className={`${settingsColor}`} 
            style={!isWorking ? { animation: 'spin 4s linear infinite' } : undefined} 
          />
          <div>
            <span className="font-semibold text-zinc-300">TOOL CALL:</span>
            <span className={`ml-1.5 py-0.5 font-mono text-[10px] uppercase font-bold tracking-wide transition ${getToolPillStyle(name)}`}>
              {name}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-[10px] text-zinc-500 font-mono">
            <Timer size={10} />
            <span>{isWorking ? '--' : `${durationMs}ms`}</span>
          </span>
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${statusBadgeClass}`}>
            {statusText}
          </span>
          {expanded ? <ChevronUp size={14} className="text-zinc-500" /> : <ChevronDown size={14} className="text-zinc-500" />}
        </div>
      </button>

      {/* Expanded parameter trees */}
      {expanded && (
        <div className="p-3 bg-zinc-950/80 space-y-3 border-t border-zinc-900 text-zinc-400 select-text selection:bg-indigo-500/30">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-zinc-500 font-bold flex items-center gap-1">
                <Cpu size={10} />
                <span>INPUT SCHEMATICS:</span>
              </span>
              <button
                onClick={handleCopyInput}
                className="text-[9px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 transition cursor-pointer"
              >
                {copiedInput ? <Check size={9} className="text-emerald-400" /> : <Copy size={9} />}
                <span>{copiedInput ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <pre className="p-2.5 rounded bg-zinc-900/60 font-mono text-[10px] overflow-x-auto max-h-40 scrollbar-thin text-zinc-300 pointer-events-auto leading-relaxed">
              {input}
            </pre>
          </div>

          {(output || isWorking) && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-zinc-500 font-bold flex items-center gap-1">
                  <span>SYSTEM OUTFALL:</span>
                </span>
                {output && (
                  <button
                    onClick={handleCopyOutput}
                    className="text-[9px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 transition cursor-pointer"
                  >
                    {copiedOutput ? <Check size={9} className="text-emerald-400" /> : <Copy size={9} />}
                    <span>{copiedOutput ? 'Copied' : 'Copy'}</span>
                  </button>
                )}
              </div>
              <pre className={`p-2.5 rounded font-mono text-[10px] overflow-x-auto max-h-60 scrollbar-thin border border-zinc-900 pointer-events-auto leading-normal ${
                isWorking ? 'bg-zinc-900/40 text-amber-300/80 animate-pulse' : isSuccess ? 'bg-zinc-900 text-teal-300/95' : 'bg-zinc-900 text-rose-350'
              }`}>
                {isWorking ? 'Executing in virtual sandbox container...' : output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
