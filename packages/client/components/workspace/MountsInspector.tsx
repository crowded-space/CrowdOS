import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { apiClient } from '@/src/api/client';
import type { MountInfoDto, MountScopeDto } from '@/src/api/client';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import FolderMountPicker from './FolderMountPicker';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { sourceHint, sourceLabel } from './explorer-model';

type levelKey = 'workspace' | 'category' | 'channel';

type levelSnapshot = {
  path: string | null;
  reason: string | null;
  error: string | null;
  loading: boolean;
};

type clearTarget = {
  level: levelKey;
  targetId: string;
  currentPath: string | null;
} | null;

const TOP_LEVEL_SENTINEL = '__top';

const emptySnapshot: levelSnapshot = { path: null, reason: null, error: null, loading: false };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed.';
}

function isJailDenial(message: string): boolean {
  return /outside (the )?allowed roots|allowed mount roots|not inside/i.test(message);
}

function inheritCopy(level: levelKey): string {
  if (level === 'channel') return 'Not set. This channel inherits its category or workspace mount.';
  if (level === 'category') return 'Not set. Channels in this category fall back to the workspace mount.';
  return 'Not set. Channels without their own mount resolve to the workspace sandbox.';
}

export function MountsInspector(): React.JSX.Element {
  const workspaces = useCrowdOSStore((s) => s.workspaces);
  const activeWorkspaceId = useCrowdOSStore((s) => s.activeWorkspaceId);
  const activeChannelId = useCrowdOSStore((s) => s.activeChannelId);
  const incrementFilesystemRevision = useCrowdOSStore((s) => s.incrementFilesystemRevision);

  const activeWS = useMemo(
    () => workspaces.find((ws) => ws.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );
  const categories = useMemo(() => activeWS?.categories ?? [], [activeWS]);
  const topLevelChannels = useMemo(() => activeWS?.channels ?? [], [activeWS]);

  const defaultCategoryId = useMemo(() => {
    if (!activeWS) return null;
    if (activeChannelId) {
      const owner = categories.find((c) => c.channels.some((ch) => ch.id === activeChannelId));
      if (owner) return owner.id;
      if (topLevelChannels.some((ch) => ch.id === activeChannelId)) return TOP_LEVEL_SENTINEL;
    }
    if (categories.length > 0) return categories[0].id;
    if (topLevelChannels.length > 0) return TOP_LEVEL_SENTINEL;
    return null;
  }, [activeWS, activeChannelId, categories, topLevelChannels]);

  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  const resolvedCategoryId = selectedCategoryId ?? defaultCategoryId;
  const channelOptions = useMemo(() => {
    if (resolvedCategoryId === TOP_LEVEL_SENTINEL) return topLevelChannels;
    return categories.find((c) => c.id === resolvedCategoryId)?.channels ?? [];
  }, [resolvedCategoryId, categories, topLevelChannels]);

  const defaultChannelId = useMemo(() => {
    if (activeChannelId && channelOptions.some((ch) => ch.id === activeChannelId)) return activeChannelId;
    return channelOptions[0]?.id ?? null;
  }, [activeChannelId, channelOptions]);

  const resolvedChannelId = selectedChannelId ?? defaultChannelId;

  const [workspaceSnap, setWorkspaceSnap] = useState<levelSnapshot>(emptySnapshot);
  const [categorySnap, setCategorySnap] = useState<levelSnapshot>(emptySnapshot);
  const [channelSnap, setChannelSnap] = useState<levelSnapshot>(emptySnapshot);
  const [effective, setEffective] = useState<MountScopeDto | null>(null);
  const [effectiveError, setEffectiveError] = useState<string | null>(null);
  const [allowedRoots, setAllowedRoots] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState<Record<levelKey, boolean>>({
    workspace: false,
    category: false,
    channel: false,
  });
  const [clearTarget, setClearTarget] = useState<clearTarget>(null);

  useEffect(() => {
    setSelectedCategoryId(null);
    setSelectedChannelId(null);
  }, [activeWorkspaceId]);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!activeWorkspaceId) return;
      setLoading(true);
      setLoadError(null);
      setEffectiveError(null);
      setWorkspaceSnap((s) => ({ ...s, loading: true, error: null }));
      setCategorySnap((s) => ({ ...s, loading: true, error: null }));
      setChannelSnap((s) => ({ ...s, loading: true, error: null }));
      try {
        const workspaceId = activeWorkspaceId;
        const categoryId =
          resolvedCategoryId && resolvedCategoryId !== TOP_LEVEL_SENTINEL ? resolvedCategoryId : null;
        const channelId = resolvedChannelId;
        const [wsR, catR, chR, effR, rootsR] = await Promise.allSettled([
          apiClient.getWorkspaceMount(workspaceId),
          categoryId ? apiClient.getCategoryMount(categoryId) : Promise.resolve(null),
          channelId ? apiClient.getChannelMount(channelId) : Promise.resolve(null),
          apiClient.getEffectiveMount(workspaceId, channelId ?? undefined),
          apiClient.getAllowedRoots(workspaceId),
        ]);
        if (cancelled) return;
        if (wsR.status === 'fulfilled') {
          const info = wsR.value as MountInfoDto;
          setWorkspaceSnap({ path: info.mountedPath ?? null, reason: info.reason ?? null, error: null, loading: false });
        } else {
          setWorkspaceSnap({ path: null, reason: null, error: messageOf(wsR.reason), loading: false });
        }
        if (!categoryId) {
          setCategorySnap({ path: null, reason: null, error: null, loading: false });
        } else if (catR.status === 'fulfilled') {
          const info = catR.value as MountInfoDto | null;
          setCategorySnap({
            path: info?.mountedPath ?? null,
            reason: info?.reason ?? null,
            error: null,
            loading: false,
          });
        } else {
          setCategorySnap({ path: null, reason: null, error: messageOf(catR.reason), loading: false });
        }
        if (!channelId) {
          setChannelSnap({ path: null, reason: null, error: null, loading: false });
        } else if (chR.status === 'fulfilled') {
          const info = chR.value as MountInfoDto | null;
          setChannelSnap({
            path: info?.mountedPath ?? null,
            reason: info?.reason ?? null,
            error: null,
            loading: false,
          });
        } else {
          setChannelSnap({ path: null, reason: null, error: messageOf(chR.reason), loading: false });
        }
        if (effR.status === 'fulfilled') {
          setEffective(effR.value);
        } else {
          setEffective(null);
          setEffectiveError(messageOf(effR.reason));
        }
        if (rootsR.status === 'fulfilled') {
          setAllowedRoots(Array.isArray(rootsR.value) ? rootsR.value : []);
        } else {
          setAllowedRoots([]);
        }
      } catch (err) {
        if (!cancelled) setLoadError(messageOf(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setWorkspaceSnap((s) => ({ ...s, loading: false }));
          setCategorySnap((s) => ({ ...s, loading: false }));
          setChannelSnap((s) => ({ ...s, loading: false }));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, resolvedCategoryId, resolvedChannelId, revision]);

  function reload(reason: string): void {
    setStatusMessage(reason);
    incrementFilesystemRevision();
    setRevision((n) => n + 1);
  }

  function handleSaved(level: levelKey): void {
    setBrowseOpen((prev) => ({ ...prev, [level]: false }));
    reload(level === 'workspace' ? 'Workspace mount saved.' : level === 'category' ? 'Category mount saved.' : 'Channel mount saved.');
  }

  function targetIdFor(level: levelKey): string | null {
    if (level === 'workspace') return activeWorkspaceId;
    if (level === 'category') {
      return resolvedCategoryId && resolvedCategoryId !== TOP_LEVEL_SENTINEL ? resolvedCategoryId : null;
    }
    return resolvedChannelId;
  }

  async function confirmClear(): Promise<void> {
    if (!clearTarget) return;
    const { level, targetId } = clearTarget;
    setClearTarget(null);
    setBusy(true);
    try {
      await apiClient.setMount(level, targetId, null);
      reload(level === 'workspace' ? 'Workspace mount cleared. Channels resolve to the workspace sandbox.' : level === 'category' ? 'Category mount cleared. Channels fall back to the workspace mount.' : 'Channel mount cleared. This channel inherits its category or workspace mount.');
    } catch (err) {
      setStatusMessage(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  function winnerFor(level: levelKey): boolean {
    return effective?.source === level;
  }

  function renderLevelCard(level: levelKey, title: string, targetName: string | null, snap: levelSnapshot): React.JSX.Element {
    const targetId = targetIdFor(level);
    const isWinner = winnerFor(level);
    const browse = browseOpen[level];
    const jailHit = snap.error && isJailDenial(snap.error);
    return (
      <section
        aria-label={title + ' mount'}
        className={'rounded-lg border p-3 space-y-2 min-w-0 ' + (isWinner ? 'border-indigo-500/60 bg-indigo-500/5' : 'border-zinc-800 bg-zinc-950/60')}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <HardDrive size={13} className={isWinner ? 'text-indigo-300 shrink-0' : 'text-zinc-500 shrink-0'} aria-hidden="true" />
          <h4 className="font-semibold text-zinc-200 text-[12px] truncate">{title}</h4>
          {isWinner && (
            <span className="ml-auto inline-flex items-center gap-1 rounded bg-indigo-600/20 border border-indigo-500/40 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-200 shrink-0">
              <Check size={10} aria-hidden="true" />
              <span>Winner</span>
            </span>
          )}
        </div>
        {targetName && <p className="text-[11px] text-zinc-500 truncate">{targetName}</p>}
        {snap.loading ? (
          <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <Loader2 size={11} className="motion-safe:animate-spin shrink-0" aria-hidden="true" />
            <span>Reading mount…</span>
          </p>
        ) : snap.error ? (
          <div role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] leading-relaxed">
            <p className="font-semibold text-rose-300">Could not read this mount</p>
            <p className="text-rose-200/90 break-words">{snap.error}</p>
            {jailHit && allowedRoots.length > 0 && (
              <div className="mt-1 text-rose-200/90">
                <p>Allowed roots:</p>
                <ul className="list-disc pl-4 font-mono break-all">
                  {allowedRoots.map((root) => (
                    <li key={root}>{root}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => setBrowseOpen((prev) => ({ ...prev, [level]: true }))}
                  className="mt-1 inline-flex items-center gap-1 rounded border border-rose-400/40 px-2 py-1 font-semibold text-rose-100 hover:bg-rose-500/20 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
                >
                  <FolderOpen size={11} aria-hidden="true" />
                  <span>Browse an allowed folder</span>
                </button>
              </div>
            )}
          </div>
        ) : snap.path ? (
          <p className="truncate font-mono text-[11px] text-zinc-200" title={snap.path}>
            {snap.path}
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-zinc-500">{inheritCopy(level)}</p>
        )}
        {snap.reason && (
          <p role="note" className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-200">
            <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>Configured but unusable: {snap.reason}</span>
          </p>
        )}
        {targetId && (
          <div className="flex items-center gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={() => setBrowseOpen((prev) => ({ ...prev, [level]: !prev[level] }))}
              aria-expanded={browse}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-800 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              <FolderOpen size={11} aria-hidden="true" />
              <span>{snap.path ? 'Change' : 'Browse'}</span>
            </button>
            {snap.path && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setClearTarget({ level, targetId, currentPath: snap.path })}
                className="inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-[11px] font-semibold text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300 disabled:opacity-50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                title={level === 'workspace' ? 'Reset to the workspace sandbox' : 'Clear and inherit the parent mount'}
              >
                <X size={11} aria-hidden="true" />
                <span>Clear</span>
              </button>
            )}
          </div>
        )}
        {browse && targetId && (
          <FolderMountPicker
            targetType={level}
            targetId={targetId}
            workspaceId={activeWorkspaceId}
            initialPath={snap.path}
            onSaved={() => handleSaved(level)}
            onClose={() => setBrowseOpen((prev) => ({ ...prev, [level]: false }))}
          />
        )}
      </section>
    );
  }

  if (!activeWS || !activeWorkspaceId) {
    return (
      <section aria-label="Mounts inspector" className="space-y-3 text-xs font-sans">
        <h3 className="font-semibold text-zinc-200 text-sm tracking-tight">Mounts</h3>
        <p className="text-[12px] leading-relaxed text-zinc-500">Open a workspace to inspect its mounts.</p>
      </section>
    );
  }

  const categoryName =
    resolvedCategoryId === TOP_LEVEL_SENTINEL
      ? 'Top-level channels (no category)'
      : categories.find((c) => c.id === resolvedCategoryId)?.name ?? 'No category selected';
  const channelName = channelOptions.find((ch) => ch.id === resolvedChannelId)?.name;
  const hasScope = categories.length > 0 || topLevelChannels.length > 0;

  return (
    <section aria-label="Mounts inspector" className="space-y-4 text-xs font-sans">
      <div className="space-y-1">
        <h3 className="font-semibold text-zinc-200 text-sm tracking-tight">Mounts</h3>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          A channel mount replaces its category and workspace mounts. Nothing merges, and there is no virtual
          filesystem: each level points at one host folder or inherits.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="space-y-1 block">
          <span className="text-[11px] font-medium text-zinc-400">Category</span>
          <select
            value={resolvedCategoryId ?? ''}
            onChange={(e) => {
              setSelectedCategoryId(e.target.value || null);
              setSelectedChannelId(null);
            }}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {topLevelChannels.length > 0 && <option value={TOP_LEVEL_SENTINEL}>Top-level channels</option>}
          </select>
        </label>
        <label className="space-y-1 block">
          <span className="text-[11px] font-medium text-zinc-400">Channel</span>
          <select
            value={resolvedChannelId ?? ''}
            onChange={(e) => setSelectedChannelId(e.target.value || null)}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            {channelOptions.map((ch) => (
              <option key={ch.id} value={ch.id}>
                #{ch.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setRevision((n) => n + 1)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          <RefreshCw size={11} className={loading ? 'motion-safe:animate-spin' : ''} aria-hidden="true" />
          <span>{loading ? 'Reading mounts…' : 'Refresh'}</span>
        </button>
        <div aria-live="polite" role="status" className="min-w-0 flex-1 truncate text-[11px] text-zinc-500">
          {statusMessage ?? (loading ? 'Reading workspace, category, and channel mounts…' : 'Mounts are read live. No sample data.')}
        </div>
      </div>

      {loadError && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
          <AlertCircle size={12} className="shrink-0" aria-hidden="true" />
          <span className="flex-1">{loadError}</span>
          <button
            type="button"
            onClick={() => setRevision((n) => n + 1)}
            className="rounded border border-rose-400/40 px-2 py-0.5 font-semibold hover:bg-rose-500/20 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
            Retry
          </button>
        </div>
      )}

      {!hasScope ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-4 text-[12px] leading-relaxed text-zinc-400">
          <p className="font-semibold text-zinc-200">No categories or channels yet</p>
          <p className="mt-0.5 text-zinc-500">Create a category and channel in the Category and Channels tab, then return here to mount a folder per level.</p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 space-y-1">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-200">
              <HardDrive size={12} className="text-indigo-300 shrink-0" aria-hidden="true" />
              <span>
                Effective:{' '}
                {effective ? (
                  <>
                    <span className="font-mono break-all">{effective.path}</span>
                    <span className="ml-1.5 rounded bg-indigo-600/20 border border-indigo-500/40 px-1.5 py-px text-[10px] text-indigo-200">
                      {sourceLabel(effective.source)}
                    </span>
                  </>
                ) : (
                  <span className="text-zinc-500">{effectiveError ?? 'No effective mount to show.'}</span>
                )}
              </span>
            </p>
            {effective && <p className="text-[11px] leading-relaxed text-zinc-500">{sourceHint(effective.source)}</p>}
            {effective?.reason && (
              <p role="note" className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-200">
                <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>Configured but unusable: {effective.reason}</span>
              </p>
            )}
            {effectiveError && (
              <p role="alert" className="text-[11px] leading-relaxed text-rose-300">{effectiveError}</p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {renderLevelCard('workspace', 'Workspace', activeWS.name, workspaceSnap)}
            {resolvedCategoryId === TOP_LEVEL_SENTINEL || !resolvedCategoryId ? (
              <section aria-label="Category mount" className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-2">
                <div className="flex items-center gap-1.5">
                  <HardDrive size={13} className="text-zinc-500 shrink-0" aria-hidden="true" />
                  <h4 className="font-semibold text-zinc-200 text-[12px]">Category</h4>
                </div>
                <p className="text-[11px] leading-relaxed text-zinc-500">
                  No category in scope. Top-level channels inherit the workspace mount directly.
                </p>
              </section>
            ) : (
              renderLevelCard('category', 'Category', categoryName, categorySnap)
            )}
            {renderLevelCard('channel', 'Channel', channelName ? '#' + channelName : null, channelSnap)}
          </div>

          <div className="rounded-lg border border-zinc-900 bg-zinc-950/40 px-3 py-2">
            <p className="text-[11px] font-medium text-zinc-400">Mount jail (allowed roots)</p>
            {allowedRoots.length > 0 ? (
              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-zinc-500 break-all">
                {allowedRoots.map((root) => (
                  <li key={root}>{root}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-0.5 text-[11px] text-zinc-600">The server did not report allowed roots.</p>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={clearTarget !== null}
        title={clearTarget?.level === 'workspace' ? 'Reset workspace mount?' : 'Clear mount?'}
        description={
          clearTarget?.level === 'workspace'
            ? 'This resets the workspace mount' + (clearTarget?.currentPath ? ' (currently ' + clearTarget.currentPath + ')' : '') + ' to the workspace sandbox. Channels without their own mount resolve here next.'
            : clearTarget?.level === 'category'
              ? 'This clears this category mount' + (clearTarget?.currentPath ? ' (currently ' + clearTarget.currentPath + ')' : '') + '. Channels in this category fall back to the workspace mount next.'
              : 'This clears this channel mount' + (clearTarget?.currentPath ? ' (currently ' + clearTarget.currentPath + ')' : '') + '. This channel inherits its category or workspace mount next.'
        }
        confirmLabel={clearTarget?.level === 'workspace' ? 'Reset to sandbox' : 'Clear mount'}
        cancelLabel="Cancel"
        isDanger={true}
        onConfirm={() => void confirmClear()}
        onCancel={() => setClearTarget(null)}
      />
    </section>
  );
}

export default MountsInspector;
