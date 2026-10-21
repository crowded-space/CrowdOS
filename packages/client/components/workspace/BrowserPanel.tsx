import React, { useEffect, useState } from 'react';
import { Globe, Send } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { fetchJsonOrThrow, resolveApiUrl } from '@/src/api/client';

const BTN =
  'px-2 py-1 rounded-md text-[11px] font-mono font-medium bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer';

// Operator takeover: the stream is an image, so clicks are scaled from rendered
// pixels to viewport pixels and typing goes to whatever already has focus.
// Mounting the panel is the watch lifecycle; frames arrive over the socket.
export default function BrowserPanel() {
  const { activeWorkspaceId, browserFrameByWorkspace, browserStateByWorkspace, startBrowserWatch, stopBrowserWatch } =
    useCrowdOSStore(useShallow(s => ({
      activeWorkspaceId: s.activeWorkspaceId,
      browserFrameByWorkspace: s.browserFrameByWorkspace,
      browserStateByWorkspace: s.browserStateByWorkspace,
      startBrowserWatch: s.startBrowserWatch,
      stopBrowserWatch: s.stopBrowserWatch,
    })));
  const [urlInput, setUrlInput] = useState('');
  const [textInput, setTextInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ws = activeWorkspaceId;
    startBrowserWatch(ws ?? undefined);
    return () => stopBrowserWatch(ws ?? undefined);
  }, [activeWorkspaceId]);

  const frame = activeWorkspaceId ? browserFrameByWorkspace[activeWorkspaceId] : undefined;
  const state = activeWorkspaceId ? browserStateByWorkspace[activeWorkspaceId] : undefined;
  const isOpen = state?.open === true;

  async function post(path: string, payload: Record<string, unknown>, fallback: string) {
    if (!activeWorkspaceId) return;
    setError(null);
    try {
      await fetchJsonOrThrow(
        resolveApiUrl(path),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: activeWorkspaceId, ...payload }),
        },
        fallback,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    }
  }

  function go() {
    if (!isOpen) return;
    const url = urlInput.trim();
    if (!url) {
      setError('Enter a URL first.');
      return;
    }
    void post('/api/browser/action', { action: 'navigate', url }, 'Navigation failed.');
  }

  function clickAt(event: React.MouseEvent<HTMLImageElement>) {
    if (!isOpen) return;
    const img = event.currentTarget;
    if (!img.naturalWidth || !img.naturalHeight || !img.clientWidth || !img.clientHeight) return;
    const x = Math.round(event.nativeEvent.offsetX * (img.naturalWidth / img.clientWidth));
    const y = Math.round(event.nativeEvent.offsetY * (img.naturalHeight / img.clientHeight));
    void post('/api/browser/action', { action: 'clickAt', x, y }, 'Click failed.');
  }

  function sendText() {
    if (!isOpen || !textInput) return;
    void post('/api/browser/action', { action: 'typeText', text: textInput }, 'Typing failed.');
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3.5 border-b border-zinc-900 flex items-center justify-between shrink-0 select-none">
        <h2 className="text-[13px] font-medium text-zinc-300 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center" aria-hidden="true">
            <Globe size={12} className="text-zinc-500" aria-hidden="true" />
          </span>
          Browser
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void post('/api/browser/open', {}, 'Open failed.')}
            className={BTN}
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => void post('/api/browser/close', {}, 'Close failed.')}
            disabled={!isOpen}
            className={BTN}
          >
            Close
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 scrollbar-thin overscroll-contain">
        <div className="flex items-center gap-1.5">
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
            placeholder="https://example.com"
            aria-label="Browser URL"
            disabled={!isOpen}
            className="min-w-0 flex-1 bg-zinc-900 border border-zinc-800 rounded-md px-2 py-1.5 text-[11px] font-mono text-zinc-200 placeholder:text-zinc-600 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
          />
          <button type="button" onClick={go} disabled={!isOpen} className={BTN}>
            Go
          </button>
        </div>

        <p aria-live="polite" className="text-[10px] font-mono text-zinc-500 truncate">
          {state
            ? `${state.open ? 'open' : 'closed'}${state.title ? ' · ' + state.title : ''}${state.url ? ' · ' + state.url : ''}`
            : 'closed'}
        </p>

        {!isOpen ? (
          <div className="text-center py-10 px-3">
            <div className="w-12 h-12 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-3 text-zinc-500" aria-hidden="true">
              <Globe size={18} aria-hidden="true" />
            </div>
            <p className="text-xs text-zinc-400">Browser closed — Open, then log in manually; credentials never go to the agent.</p>
          </div>
        ) : frame ? (
          <img
            src={frame.dataUrl}
            alt="Live browser view"
            onClick={clickAt}
            title="Click to send a click to the page"
            className="w-full rounded-md border border-zinc-800 cursor-crosshair select-none"
          />
        ) : (
          <p className="text-[11px] text-zinc-500 py-6 text-center">Waiting for the first frame…</p>
        )}

        <div className="flex items-center gap-1.5">
          <input
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') sendText(); }}
            placeholder="Type into the focused field"
            aria-label="Browser text input"
            disabled={!isOpen}
            className="min-w-0 flex-1 bg-zinc-900 border border-zinc-800 rounded-md px-2 py-1.5 text-[11px] font-mono text-zinc-200 placeholder:text-zinc-600 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
          />
          <button
            type="button"
            onClick={sendText}
            disabled={!isOpen || !textInput}
            className={BTN}
            aria-label="Send text to the focused field"
          >
            <Send size={11} aria-hidden="true" />
          </button>
        </div>

        {error && (
          <p role="alert" className="text-[10px] font-mono text-rose-400 break-words">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
