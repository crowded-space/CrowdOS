import { useEffect, useState, useCallback } from 'react';
import {
  Folder,
  FolderOpen,
  HardDrive,
  Check,
  X,
  Loader2,
  AlertCircle,
  CornerLeftUp,
  ExternalLink,
  ChevronRight,
  Compass,
  RefreshCw
} from 'lucide-react';
import { apiClient } from '@/src/api/client';
import { canPickDirectoryNative, pickDirectoryNative } from './desktop-bridge';

interface Props {
  targetType: 'channel' | 'category' | 'workspace';
  targetId: string;
  /** Scopes the in-app navigator to this workspace's mount jail. Without it
   *  the browser falls back to the default roots, which can offer folders the
   *  workspace's own allowedMountRoots would then refuse on attach. */
  workspaceId?: string | null;
  initialPath?: string | null;
  onClose?: () => void;
  onSaved?: (path: string | null) => void;
}

interface BrowseEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string;
}

export default function FolderMountPicker({ targetType, targetId, workspaceId, initialPath, onClose, onSaved }: Props) {
  const [path, setPath] = useState(initialPath ?? '');
  const [saving, setSaving] = useState(false);
  const [pickingNative, setPickingNative] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // In-app folder browser state
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browsingPath, setBrowsingPath] = useState<string>('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [allowedRoots, setAllowedRoots] = useState<string[]>([]);
  const [browserLoading, setBrowserLoading] = useState(false);

  useEffect(() => {
    setPath(initialPath ?? '');
  }, [initialPath]);


  async function handleSave(pathOverride?: string | null) {
    const pathToSave = ((pathOverride !== undefined ? pathOverride : path) ?? '').trim();
    setSaving(true);
    setError(null);
    try {
      // Through the API client so the route's own message reaches the panel
      // (`readApiError` surfaces `message`, not a bare status).
      await apiClient.setMount(targetType, targetId, pathToSave || null);
      onSaved?.(pathToSave || null);
      onClose?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setPath('');
    setSaving(true);
    setError(null);
    try {
      await apiClient.setMount(targetType, targetId, null);
      onSaved?.(null);
      onClose?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handlePickNative() {
    setPickingNative(true);
    setError(null);
    try {
      if (canPickDirectoryNative()) {
        const outcome = await pickDirectoryNative(path || null);
        if (outcome.canceled || !outcome.path) {
          setPickingNative(false);
          return;
        }
        setPath(outcome.path);
        // Auto-save on desktop selection (validated server-side via attach)
        await handleSave(outcome.path);
        return;
      }
      // No desktop bridge (plain browser): the OS-dialog route is gone —
      // `POST /api/fs/pick-folder` answers 410 — so hand the user the in-app
      // navigator instead of a call that can only fail.
      setBrowserOpen(true);
      await loadDirectory(path || undefined);
    } catch (e: any) {
      setError(`Native picker error: ${e.message}`);
      setBrowserOpen(true);
    } finally {
      setPickingNative(false);
    }
  }

  const loadDirectory = useCallback(async (targetDir?: string) => {
    setBrowserLoading(true);
    setError(null);
    try {
      // Same jail the attach will validate against — picker and saver must
      // never disagree about which folders are mountable.
      const data = await apiClient.browseFilesystem(targetDir ?? null, workspaceId ?? null);
      setBrowsingPath(data.path);
      setParentPath(data.parent);
      setEntries(data.entries || []);
      if (Array.isArray(data.allowedRoots)) {
        setAllowedRoots(data.allowedRoots);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBrowserLoading(false);
    }
  }, []);

  useEffect(() => {
    if (browserOpen && !browsingPath) {
      loadDirectory(path || undefined);
    }
  }, [browserOpen, browsingPath, path, loadDirectory]);

  return (
    <div className="space-y-3 p-3 bg-zinc-900 border border-zinc-800 rounded-xl">
      <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
        <Folder size={14} className="text-indigo-400" />
        <span className="capitalize">{targetType} Mount</span>
        <span className="ml-auto text-[10px] text-zinc-500">
          {targetType === 'channel'
            ? 'inherits category / workspace'
            : targetType === 'category'
            ? 'inherits workspace'
            : 'applies to all channels in workspace'}
        </span>
      </div>

      {/* Primary Native OS Picker button */}
      <button
        onClick={handlePickNative}
        disabled={pickingNative || saving}
        className="w-full py-2 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition disabled:opacity-50 cursor-pointer shadow-sm"
        title="Open operating system native folder browser dialog"
      >
        {pickingNative ? (
          <>
            <Loader2 size={13} className="animate-spin" />
            <span>Waiting for OS Dialog...</span>
          </>
        ) : (
          <>
            <ExternalLink size={13} />
            <span>Browse with Native OS Dialog</span>
          </>
        )}
      </button>

      {/* Manual Path input with direct Save */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-zinc-500">
          <span>Host Folder Path</span>
          <button
            type="button"
            onClick={() => setBrowserOpen((v) => !v)}
            className="text-indigo-400 hover:text-indigo-300 text-[10.5px] font-mono flex items-center gap-1 cursor-pointer transition"
          >
            <Compass size={11} />
            <span>{browserOpen ? 'Hide Navigator' : 'In-App Navigator'}</span>
          </button>
        </div>
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="C:\repos\my-repo or /home/user/projects/my-repo"
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700"
          />
          <button
            onClick={() => handleSave()}
            disabled={saving || pickingNative}
            className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 rounded-lg text-xs font-semibold disabled:opacity-50 flex items-center gap-1 cursor-pointer"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save
          </button>
        </div>
        {path && (
          <p className="text-[11px] text-zinc-400 flex items-center gap-1.5 font-mono truncate">
            <HardDrive size={11} className="text-zinc-500 shrink-0" />
            <span className="truncate">{path}</span>
          </p>
        )}
      </div>

      {/* In-App Visual OS Directory Navigator */}
      {browserOpen && (
        <div className="p-2.5 bg-zinc-950 border border-zinc-800 rounded-lg space-y-2 animate-fade-in text-xs">
          {/* Drive & Root selector row */}
          {allowedRoots.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-mono text-zinc-500">Roots:</span>
              {allowedRoots.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => loadDirectory(r)}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono border transition ${
                    browsingPath.toLowerCase().startsWith(r.toLowerCase())
                      ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/40'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          )}

          {/* Current browsing location bar */}
          <div className="flex items-center gap-1.5 bg-zinc-900/90 border border-zinc-800/80 px-2 py-1.5 rounded text-[11px] font-mono text-zinc-300 min-w-0">
            {parentPath && (
              <button
                type="button"
                onClick={() => loadDirectory(parentPath)}
                disabled={browserLoading}
                className="p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded transition shrink-0"
                title="Go up to parent directory"
                aria-label="Go up to parent directory"
              >
                <CornerLeftUp size={12} aria-hidden="true" />
              </button>
            )}
            <span className="truncate flex-1" title={browsingPath}>
              {browsingPath || 'Browsing host filesystem...'}
            </span>
            <button
              type="button"
              onClick={() => loadDirectory(browsingPath)}
              disabled={browserLoading}
              className="p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded transition shrink-0"
              title="Refresh directory"
              aria-label="Refresh directory"
            >
              <RefreshCw size={11} className={browserLoading ? 'animate-spin' : ''} aria-hidden="true" />
            </button>
          </div>

          {/* Directory entries list */}
          <div className="max-h-44 overflow-y-auto space-y-0.5 scrollbar-thin pr-1">
            {browserLoading ? (
              <div className="py-4 flex items-center justify-center gap-2 text-zinc-500 text-xs font-mono">
                <Loader2 size={12} className="animate-spin" /> Loading directories...
              </div>
            ) : entries.filter((e) => e.isDirectory).length === 0 ? (
              <div className="py-3 text-center text-zinc-600 text-[11px] font-mono">
                No subdirectories in this folder
              </div>
            ) : (
              entries
                .filter((e) => e.isDirectory)
                .map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => loadDirectory(entry.path)}
                    className="w-full flex items-center gap-2 px-2 py-1 hover:bg-zinc-900 rounded text-left text-zinc-300 hover:text-zinc-100 transition group font-mono text-[11.5px]"
                  >
                    <Folder size={13} className="text-indigo-400/80 shrink-0 group-hover:text-indigo-300" />
                    <span className="truncate flex-1">{entry.name}</span>
                    <ChevronRight size={11} className="text-zinc-600 group-hover:text-zinc-400 shrink-0" />
                  </button>
                ))
            )}
          </div>

          {/* Quick Mount current browsing directory */}
          <div className="flex gap-2 pt-1 border-t border-zinc-900">
            <button
              type="button"
              onClick={() => {
                setPath(browsingPath);
                handleSave(browsingPath);
              }}
              disabled={!browsingPath || saving}
              className="flex-1 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 text-indigo-300 rounded text-xs font-semibold flex items-center justify-center gap-1.5 transition"
            >
              <Check size={12} /> Mount this directory
            </button>
          </div>
        </div>
      )}

      {/* Clear mount action */}
      <div className="flex gap-2">
        <button
          onClick={handleClear}
          disabled={saving || pickingNative}
          className="flex-1 py-1.5 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded-lg text-xs flex items-center justify-center gap-1 cursor-pointer transition disabled:opacity-50"
        >
          <X size={11} /> {targetType === 'workspace' ? 'Reset to default workspace sandbox' : 'Clear mount (inherit)'}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-1.5 text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-2.5 py-1.5">
          <AlertCircle size={12} className="shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}
    </div>
  );
}
