import { useState, useEffect } from 'react';
import { Folder, ChevronDown } from 'lucide-react';
import FolderMountPicker from './FolderMountPicker';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useToast } from '@/components/ui/ToastProvider';

interface Props {
  className?: string;
}

export default function RepositorySelector({ className }: Props) {
  const activeChannelId = useCrowdOSStore((s) => s.activeChannelId);
  const activeWorkspaceId = useCrowdOSStore((s) => s.activeWorkspaceId);
  const filesystemRevision = useCrowdOSStore((s) => s.filesystemRevision);
  const { showSuccess, showError } = useToast();

  const [mountedPath, setMountedPath] = useState<string | null>(null);
  const [source, setSource] = useState<'channel' | 'category' | 'workspace' | 'none'>('none');
  const [loading, setLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picking, setPicking] = useState(false);

  async function fetchMount() {
    if (!activeChannelId) {
      setMountedPath(null);
      setSource('none');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/channels/${activeChannelId}/mount`);
      if (res.ok) {
        const data = await res.json();
        setMountedPath(data.mountedPath ?? null);
        setSource(data.source ?? 'none');
      } else {
        setMountedPath(null);
        setSource('none');
      }
    } catch {
      setMountedPath(null);
      setSource('none');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchMount();
  }, [activeChannelId, activeWorkspaceId, filesystemRevision]);

  const displayName = mountedPath ? mountedPath.split(/[\\/]/).pop() || mountedPath : '.ThisCrowd';
  const isDefault = !mountedPath;

  async function handleChangeClick() {
    if (!activeChannelId) {
      setPickerOpen((v) => !v);
      return;
    }
    setPicking(true);
    try {
      const useDesktopDialog = typeof (window as any)?.crowdos?.pickDirectory === 'function';
      if (useDesktopDialog) {
        const picked = await (window as any).crowdos.pickDirectory({ initialPath: mountedPath || undefined });
        const desktopPath: string | null =
          typeof picked === 'string' ? picked || null : (picked?.path ?? picked?.filePaths?.[0] ?? null);
        const desktopCanceled =
          typeof picked === 'string' ? !picked : (picked?.canceled ?? !desktopPath);
        if (desktopCanceled || !desktopPath) {
          setPicking(false);
          return;
        }
        const putRes = await fetch(`/api/channels/${activeChannelId}/mount`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: desktopPath }),
        });
        const putData = await putRes.json().catch(() => ({}));
        if (!putRes.ok) throw new Error(putData.message || 'Mount failed');
        setMountedPath(desktopPath);
        useCrowdOSStore.getState().incrementFilesystemRevision();
        showSuccess('Repository mounted', desktopPath);
        return;
      }
      const res = await fetch('/api/fs/pick-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialPath: mountedPath || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Picker failed');
      if (data.canceled || !data.path) {
        setPicking(false);
        return;
      }
      const putRes = await fetch(`/api/channels/${activeChannelId}/mount`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: data.path }),
      });
      const putData = await putRes.json().catch(() => ({}));
      if (!putRes.ok) throw new Error(putData.message || 'Mount failed');
      setMountedPath(data.path);
      useCrowdOSStore.getState().incrementFilesystemRevision();
      showSuccess('Repository mounted', data.path);
    } catch (e: any) {
      // Fallback to manual picker on failure (e.g., headless, remote, or error)
      setPickerOpen(true);
      if (e?.message && !e.message.includes('canceled')) showError('Picker failed — use manual browser', e.message);
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className={className}>
      {/* Selector row — VS Code style, quick Change */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-zinc-900 border border-zinc-800 rounded-xl">
        <span className="w-6 h-6 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-center shrink-0">
          <Folder size={13} className={isDefault ? 'text-zinc-500' : 'text-indigo-400'} />
        </span>
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setPickerOpen((v) => !v)}>
          <div className="text-xs font-medium text-zinc-200 truncate" title={mountedPath ?? 'Workspace default (sandbox)'}>
            {loading ? 'Loading...' : displayName}
          </div>
          <div className="text-[10px] font-mono text-zinc-500 truncate">
            {source === 'channel' ? 'Channel mount' : source === 'category' ? 'Category mount' : source === 'workspace' ? 'Workspace mount' : 'Workspace sandbox'}
          </div>
        </div>
        <button
          onClick={handleChangeClick}
          disabled={picking}
          aria-expanded={pickerOpen}
          className="shrink-0 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-xs font-medium flex items-center gap-1.5 transition disabled:opacity-50"
          title="Select folder via native OS dialog"
        >
          {picking ? 'Picking...' : 'Change'}
          <ChevronDown size={12} className={`transition ${pickerOpen ? 'rotate-180' : ''} ${picking ? 'animate-pulse' : ''}`} />
        </button>
      </div>

      {pickerOpen && activeChannelId && (
        <div className="mt-2 animate-fade-in">
          <div className="mb-2 text-[11px] text-zinc-500">Manual path (fallback if picker unavailable):</div>
          <FolderMountPicker
            targetType="channel"
            targetId={activeChannelId}
            initialPath={mountedPath}
            onSaved={(path) => {
              setMountedPath(path);
              useCrowdOSStore.getState().incrementFilesystemRevision();
              showSuccess(path ? 'Repository switched' : 'Mount cleared', path ?? 'Inherits category');
            }}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      )}
      {pickerOpen && !activeChannelId && (
        <div className="mt-2 p-3 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-zinc-500">
          Select a channel to change its repository. Workspace-level mounts can be set in Workspace Settings.
        </div>
      )}
    </div>
  );
}
