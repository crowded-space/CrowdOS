import { useState } from 'react';
import { AlertCircle, Copy, Check, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';

export function getErrorNextAction(raw: string): string {
  const t = (raw || '').toLowerCase();
  if (/cancelled|abort/.test(t)) return 'Run was cancelled. Retry only if you did not stop it.';
  if (/timeout|timed out|etimedout|statement timeout/.test(t)) return 'Request timed out. Retry; shorten context if it repeats.';
  if (/429|rate limit|quota/.test(t)) return 'Provider is rate-limited. Wait a minute, then Retry.';
  if (/503|unavailable|overloaded|bad gateway|502|504/.test(t)) return 'Provider is unavailable. Retry; check provider status if it persists.';
  if (/network|fetch failed|econnrefused|enotfound|eai_again|socket|offline/.test(t)) return 'Connection issue. Check connection, then Retry.';
  if (/database|sql|postgres|57014/.test(t)) return 'Database issue. Retry; open Database settings if it persists.';
  if (/mutation blocked|not allowed|allowlist|allowed:/.test(t)) return 'Query was blocked by policy. Adjust the query, then Retry.';
  return 'Request failed. Retry; expand Details for the technical message.';
}

export function isProviderErrorText(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes('execution failed') ||
    t.includes('agent runtime warning') ||
    t.includes('system error processing') ||
    t.includes('[runtimeexecutor]') ||
    t.includes('runtime execution failed') ||
    t.includes('request could not be completed') ||
    t.includes('provider')
  );
}

function truncateRaw(raw: string, max = 600): string {
  if (raw.length <= max) return raw;
  return raw.slice(0, max) + `...[truncated ${raw.length - max} chars]`;
}

interface ProviderErrorCardProps {
  raw: string;
  title?: string;
  timestamp?: string;
  onRetry?: () => void;
}

export function ProviderErrorCard({ raw, title, timestamp, onRetry }: ProviderErrorCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const nextAction = getErrorNextAction(raw);
  const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div id="provider-error-card" className="max-w-xl mx-auto border border-rose-500/25 bg-rose-500/[0.04] rounded-xl overflow-hidden my-2">
      <div className="flex items-start gap-2.5 px-3.5 py-3">
        <AlertCircle size={14} className="text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-zinc-100 leading-snug">{title || 'Request failed'}</p>
          <p className="text-[12px] text-zinc-400 leading-snug mt-0.5">Next: {nextAction}</p>
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {onRetry && (
              <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-md bg-zinc-900 border border-zinc-700 text-zinc-100 hover:bg-zinc-800 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30">
                <RefreshCw size={11} aria-hidden="true" />
                <span>Retry</span>
              </button>
            )}
            <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500/30">
              {expanded ? <ChevronUp size={11} aria-hidden="true" /> : <ChevronDown size={11} aria-hidden="true" />}
              <span>{expanded ? 'Hide details' : 'Show details'}</span>
            </button>
            <button type="button" onClick={handleCopy} className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500/30">
              {copied ? <Check size={11} className="text-emerald-400" aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
            {timeStr && <span className="ml-auto text-[10px] font-mono text-zinc-600">{timeStr}</span>}
          </div>
          {expanded && (
            <pre className="mt-2 p-2.5 rounded-lg bg-zinc-950 border border-zinc-900 font-mono text-[10px] leading-relaxed text-zinc-400 overflow-x-auto max-h-48 whitespace-pre-wrap break-words select-text">{truncateRaw(raw)}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

export default ProviderErrorCard;
