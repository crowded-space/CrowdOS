import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Database } from 'lucide-react';
import { apiClient } from '@/src/api/client';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { highlightCode, languageFromPath } from './code-highlight';
import { isWorkspaceLocalRoot, sandboxRootLabel, type sandboxRoot } from './explorer-model';

export default function SandboxCodeViewer({ path, workspaceId, channelId, root }: { path: string; workspaceId?: string | null; channelId?: string | null; root?: sandboxRoot | null }) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // `channelId` matters for the effective root: the panel resolves the mount
  // through the channel chain (§16), so reading without it can open a different
  // root than the tree showed. `root` names which root this path belongs to —
  // Zone A paths must never be read through the effective root. Callers may
  // omit it (MainChatArea untouched); the store selection root is the fallback.
  const storeRoot = useCrowdOSStore((s) => s.selectedSandboxRoot);
  const effectiveRoot: sandboxRoot = root ?? storeRoot ?? 'effective';
  const readOnly = isWorkspaceLocalRoot(effectiveRoot);
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    apiClient
      .getWorkspaceFileContent(path, workspaceId || 'default', channelId, effectiveRoot)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setOriginalContent(text);
      })
      // The viewer used to swallow this into a fake "// File not found" comment,
      // which reads as file content. Report the failure instead.
      .catch((error: any) => {
        if (cancelled) return;
        setContent('');
        setOriginalContent('');
        setLoadError(error?.message || 'Could not read this file');
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [path, workspaceId, channelId, effectiveRoot]);

  const handleSave = async () => {
    // No-save guard: Zone A is read-only here. The transport would reject it,
    // but the button must never offer a write it cannot perform.
    if (readOnly) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await apiClient.saveWorkspaceFileContent(path, content, workspaceId || 'default', channelId, effectiveRoot);
      setOriginalContent(content);
    } catch (error: any) {
      setSaveError(error?.message || 'Could not save this file');
    } finally {
      setIsSaving(false);
    }
  };

  const isDirty = content !== originalContent;

  // Highlighted mirror behind the textarea: same font/padding/nowrap so the
  // two layers stay pixel-aligned while the textarea keeps caret + editing.
  // One shared class string is the alignment invariant — if the two layers
  // ever declare typography separately, the caret drifts off the text.
  const preRef = useRef<HTMLPreElement | null>(null);
  const highlighted = useMemo(() => highlightCode(content, languageFromPath(path)), [content, path]);

  const LAYER = 'absolute inset-0 m-0 p-2 px-4 font-mono text-xs leading-4 whitespace-pre';

  return (
    <>
      {readOnly && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-900 bg-zinc-950/50 shrink-0">
          <Database size={11} className="text-zinc-500 shrink-0" aria-hidden="true" />
          <span className="text-[11px] text-zinc-400">{sandboxRootLabel(effectiveRoot)} — read-only</span>
          <span
            className="ml-auto shrink-0 rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500"
            title="Reachable only by Level 0 (Omniscient) agents"
          >
            L0
          </span>
        </div>
      )}
      <div className="flex-1 overflow-hidden py-3 relative">
        {isLoading ? (
          <div className="text-zinc-500 text-xs p-4 font-mono">Loading content...</div>
        ) : loadError ? (
          <div className="p-4 text-xs font-mono text-rose-300/90 break-words">
            <div className="text-rose-400 font-semibold mb-1">Could not open this file</div>
            <div className="text-zinc-500 break-all">{path}</div>
            <div className="mt-1 text-zinc-400">{loadError}</div>
          </div>
        ) : (
          <div className="relative w-full h-full">
            <pre
              ref={preRef}
              aria-hidden
              className={`hljs ${LAYER} overflow-hidden text-zinc-300 pointer-events-none select-none`}
              dangerouslySetInnerHTML={{ __html: highlighted + '\n' }}
            />
            <textarea
              wrap="off"
              className={`${LAYER} w-full h-full bg-transparent resize-none focus:outline-none text-transparent caret-indigo-400 selection:bg-indigo-500/30`}
              value={content}
              onChange={e => setContent(e.target.value)}
              readOnly={readOnly}
              aria-readonly={readOnly || undefined}
              onScroll={e => {
                const ta = e.currentTarget;
                preRef.current?.scrollTo(ta.scrollLeft, ta.scrollTop);
              }}
              spellCheck={false}
            />
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-zinc-900 bg-zinc-950/50 shrink-0">
        {saveError && (
          <span className="mr-auto text-[11px] text-rose-400 truncate" title={saveError}>{saveError}</span>
        )}
        <button
          onClick={() => setContent(originalContent)}
          disabled={readOnly || !isDirty || !!loadError}
          title={readOnly ? 'Workspace Local files are read-only here' : undefined}
          className="px-3 py-1.5 min-h-[32px] text-[11px] font-medium text-zinc-400 hover:text-zinc-200 disabled:opacity-50 border border-transparent hover:bg-zinc-800 rounded transition cursor-pointer"
        >
          Revert
        </button>
        <button
          onClick={handleSave}
          disabled={readOnly || !isDirty || isSaving || !!loadError}
          title={readOnly ? 'Workspace Local files are read-only here' : undefined}
          className="px-3.5 py-1.5 min-h-[32px] text-[11px] font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 text-white rounded transition cursor-pointer shadow-sm"
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </>
  );
}
