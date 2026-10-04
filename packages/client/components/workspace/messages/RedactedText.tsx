import { useState } from 'react';
import { splitSecrets } from './secret-redaction';

// Phase E: shown-as-redacted + click-reveal. Secrets render masked by
// default; each mask is a button that reveals that span only. Code/text
// contexts share this component (MentionParser + ToolExecutionMessage +
// ThreadDrawer run branch). No logging of raw values anywhere.
export function RedactedText({ text, mono }: { text: string; mono?: boolean }): React.JSX.Element {
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  if (!text) return <></>;
  const parts = splitSecrets(text);
  if (!parts.some(function (p) { return p.redacted; })) return <>{text}</>;
  const cls = mono ? 'font-mono' : '';
  return (
    <span className={cls}>
      {parts.map(function (part, i) {
        if (!part.redacted) return <span key={i}>{part.text}</span>;
        const open = !!revealed[i];
        if (open) {
          return (
            <button key={i} type="button" onClick={function () { setRevealed(function (prev) { return { ...prev, [i]: false }; }); }} title="Hide secret" aria-label="Hide redacted secret" className="rounded border border-amber-500/30 bg-amber-500/10 px-1 font-mono text-[11px] text-amber-200 cursor-pointer">
              {part.text}
            </button>
          );
        }
        return (
          <button key={i} type="button" onClick={function () { setRevealed(function (prev) { return { ...prev, [i]: true }; }); }} title="Reveal redacted secret" aria-label="Reveal redacted secret" className="rounded border border-zinc-700 bg-zinc-900 px-1 font-mono text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer">
            [redacted] · reveal
          </button>
        );
      })}
    </span>
  );
}
