import { useMemo, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import { useCrowdOSStore, type ArtifactRow } from '@/stores/crowdOsStore';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

/** Props for the checkpoint row. `runtime` gates Coding/Swarm; honest empty is the caller's job. */
export interface CheckpointRowProps {
  runId: string;
  runtime: string;
}

function formatSnapshotTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/**
 * Checkpoint row for a Coding/Swarm run (UX_GUIDELINE section 8): snapshot
 * time + files touched + diff count + Restore. Snapshot time is the earliest
 * artifact createdAt in the run (no snapshot endpoint exists, so the minimum
 * is the honest derivation); files are the distinct artifact paths; the audit
 * line renders back the store's confirmed-restore entry when one exists.
 * Restore runs under the shared diffBusy lock and previews its file scope in
 * a ConfirmDialog before calling restoreRun.
 */
export function CheckpointRow({ runId, runtime }: CheckpointRowProps): React.JSX.Element | null {
  const artifactsByRun = useCrowdOSStore(s => s.artifactsByRun);
  const fetchArtifacts = useCrowdOSStore(s => s.fetchArtifacts);
  const restoreRun = useCrowdOSStore(s => s.restoreRun);
  const diffBusy = useCrowdOSStore(s => s.diffBusy);
  const restoreAuditByRun = useCrowdOSStore(s => s.restoreAuditByRun);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const rows: ArtifactRow[] = useMemo(
    () => (artifactsByRun[runId] as ArtifactRow[] | undefined) || [],
    [artifactsByRun, runId],
  );
  const diffs = useMemo(
    () => rows.filter(a => a.artifactType === 'diff' || a.patch),
    [rows],
  );
  const files = useMemo(() => {
    const out: string[] = [];
    for (const a of diffs) {
      if (a.path && !out.includes(a.path)) out.push(a.path);
    }
    return out;
  }, [diffs]);
  const snapshotAt = useMemo(() => {
    if (rows.length === 0) return null;
    let min = rows[0].createdAt;
    for (const a of rows) {
      if (a.createdAt < min) min = a.createdAt;
    }
    return min;
  }, [rows]);
  const audit = restoreAuditByRun[runId];
  const busy = diffBusy !== null || restoring;

  if (diffs.length === 0) return null;

  const scopePreview = files.length > 0 ? files.join(', ') : 'no files listed';

  const handleConfirm = async () => {
    setConfirmOpen(false);
    setRestoring(true);
    try {
      await restoreRun(runId);
    } catch {
      // Cause is already in diffError via the store; the row stays honest.
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="border border-zinc-800 bg-zinc-950/40 rounded-xl px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-7 h-7 rounded-[4px] bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
          <History size={13} className="text-zinc-400" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[12px] font-mono font-semibold text-zinc-200 truncate">
            Checkpoint - {runtime} run
          </h3>
          <p className="text-[11px] font-mono text-zinc-500 truncate">
            Snapshot {snapshotAt ? formatSnapshotTime(snapshotAt) : 'unknown time'} - {diffs.length} diff{diffs.length === 1 ? '' : 's'} - {files.length} file{files.length === 1 ? '' : 's'}
          </p>
          {files.length > 0 && (
            <p className="text-[11px] font-mono text-zinc-400 truncate" title={scopePreview}>
              {scopePreview}
            </p>
          )}
          {audit && (
            <p className="text-[11px] font-mono text-emerald-300/80 truncate" title={audit.files.join(', ')}>
              Restored {formatSnapshotTime(audit.restoredAt)} - {audit.files.length} file{audit.files.length === 1 ? '' : 's'}
            </p>
          )}
        </div>
        <button
          onClick={() => { void fetchArtifacts(runId); setConfirmOpen(true); }}
          disabled={busy}
          aria-label={`Restore run ${runId} (${files.length} files)`}
          className="shrink-0 px-3 py-1.5 min-h-[30px] rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-[11px] font-mono font-semibold border border-zinc-700 flex items-center gap-1.5 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
        >
          <RotateCcw size={12} aria-hidden="true" /> {restoring ? 'Restoring...' : 'Restore'}
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Restore this run?"
        description={`This reverts ${files.length} file${files.length === 1 ? '' : 's'} to the checkpoint snapshot: ${scopePreview}. Files only — cleared channel history stays cleared and agent memory is untouched. A timestamped restore note is kept on this row.`}
        confirmLabel={restoring ? 'Restoring...' : 'Restore run'}
        cancelLabel="Cancel"
        isDanger={true}
        onConfirm={() => { void handleConfirm(); }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

export default CheckpointRow;
