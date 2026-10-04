import React from 'react';
import { ScrollText, Download, Check } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useToast } from '@/components/ui/ToastProvider';

// Settings Audit tab (UX_GUIDELINE S7): filterable events (approvals, mount
// changes, model changes, restores) with actor/time/scope plus export.
// Every row projects a real store slice — never mock rows. Fields the store
// does not record render as an honest dash, never an invented value.
// Actor honesty (S14 open decision): only locally-performed actions
// (composer mount snapshots, confirmed restores) claim 'local-operator';
// anything unattributable (seeded model rows, inbound approval requests
// without a requester) renders unknown.
type auditKind = 'approval' | 'mount' | 'model' | 'restore';

type auditRow = {
  key: string;
  kind: auditKind;
  summary: string;
  detail: string | null;
  actor: string | null;
  time: string | null;
  scope: string | null;
  scopeLabel: string | null;
  status: string | null;
};

const KIND_FILTERS: Array<{ id: auditKind | 'all'; label: string }> = [
  { id: 'all', label: 'All events' },
  { id: 'approval', label: 'Approvals' },
  { id: 'mount', label: 'Mounts' },
  { id: 'model', label: 'Models' },
  { id: 'restore', label: 'Restores' },
];

function formatTime(iso: string | null): string {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function kindLabel(kind: auditKind): string {
  if (kind === 'approval') return 'Approval';
  if (kind === 'mount') return 'Mount';
  if (kind === 'model') return 'Model';
  return 'Restore';
}

export default function AuditTab(): React.JSX.Element {
  const { showSuccess, showError } = useToast();
  const approvalRequests = useCrowdOSStore((s) => s.approvalRequests);
  const draftByChannel = useCrowdOSStore((s) => s.draftByChannel);
  const modelProfiles = useCrowdOSStore((s) => s.modelProfiles);
  const modelModules = useCrowdOSStore((s) => s.modelModules);
  const restoreAuditByRun = useCrowdOSStore((s) => s.restoreAuditByRun);
  const workspaces = useCrowdOSStore((s) => s.workspaces);
  const activeWorkspaceId = useCrowdOSStore((s) => s.activeWorkspaceId);
  const [kind, setKind] = React.useState<auditKind | 'all'>('all');
  const [query, setQuery] = React.useState('');
  const [exported, setExported] = React.useState(false);

  const channelNames = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const ws of workspaces) {
      for (const ch of ws.channels ?? []) map.set(ch.id, ch.name);
      for (const cat of ws.categories ?? []) {
        for (const ch of cat.channels ?? []) map.set(ch.id, ch.name);
      }
    }
    return map;
  }, [workspaces]);

  const rows: auditRow[] = React.useMemo(() => {
    const out: auditRow[] = [];
    for (const req of approvalRequests) {
      const argKeys =
        req.argsPreview && typeof req.argsPreview === 'object'
          ? Object.keys(req.argsPreview)
          : [];
      out.push({
        key: 'approval:' + req.id,
        kind: 'approval',
        summary: req.tool + ' (' + req.riskClass + ')',
        detail:
          'Run ' + req.runId +
          (req.scope ? ' \u00b7 scope ' + req.scope : '') +
          (argKeys.length > 0 ? ' \u00b7 args: ' + argKeys.join(', ') : '') +
          (req.expiresAt ? ' \u00b7 expires ' + formatTime(req.expiresAt) : ''),
        actor: req.requestedBy ?? null,
        // ApprovalRequest carries no recorded-at timestamp: honest dash.
        time: null,
        scope: req.channelId ?? req.runId,
        scopeLabel: req.channelId
          ? (channelNames.get(req.channelId) ?? req.channelId)
          : req.runId,
        status: req.status,
      });
    }
    for (const [channelId, draft] of Object.entries(draftByChannel)) {
      const snap = draft.mountSnapshot;
      if (!snap || !snap.path) continue;
      out.push({
        key: 'mount:' + channelId,
        kind: 'mount',
        summary: 'Mount snapshot ' + snap.path,
        detail:
          'Composer-observed effective mount' +
          (snap.source ? ' (source ' + snap.source + ')' : ''),
        actor: 'local-operator',
        time: draft.updatedAt ?? null,
        scope: channelId,
        scopeLabel: channelNames.get(channelId) ?? channelId,
        status: null,
      });
    }
    for (const profile of modelProfiles) {
      out.push({
        key: 'model:profile:' + profile.id,
        kind: 'model',
        summary: 'Profile ' + profile.label + ' (' + profile.provider + '/' + profile.modelName + ')',
        detail: profile.apiKeyConfigured ? 'Key configured' : 'No key configured',
        actor: null,
        time: profile.updatedAt ?? profile.createdAt ?? null,
        scope: profile.id,
        scopeLabel: profile.label,
        status: null,
      });
    }
    for (const mod of modelModules) {
      out.push({
        key: 'model:module:' + mod.id,
        kind: 'model',
        summary: 'Module ' + mod.name,
        detail: mod.description ?? null,
        actor: null,
        time: mod.createdAt ?? null,
        scope: mod.id,
        scopeLabel: mod.name,
        status: null,
      });
    }
    for (const [runId, audit] of Object.entries(restoreAuditByRun)) {
      out.push({
        key: 'restore:' + runId,
        kind: 'restore',
        summary: 'Restore run ' + runId,
        detail:
          audit.files.length > 0
            ? audit.files.length + ' file' + (audit.files.length === 1 ? '' : 's') + ': ' + audit.files.join(', ')
            : 'No files listed',
        actor: 'local-operator',
        time: audit.restoredAt ?? null,
        scope: runId,
        scopeLabel: runId,
        status: 'restored',
      });
    }
    out.sort((a, b) => {
      if (a.time && b.time) return b.time < a.time ? -1 : b.time > a.time ? 1 : 0;
      if (a.time) return -1;
      if (b.time) return 1;
      return a.key < b.key ? -1 : 1;
    });
    return out;
  }, [approvalRequests, draftByChannel, modelProfiles, modelModules, restoreAuditByRun, channelNames]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (kind !== 'all' && r.kind !== kind) return false;
      if (!q) return true;
      const hay = (r.summary + ' ' + (r.detail ?? '') + ' ' + (r.scopeLabel ?? '') + ' ' + (r.status ?? '')).toLowerCase();
      return hay.includes(q);
    });
  }, [rows, kind, query]);

  const exportJson = React.useCallback(() => {
    try {
      const payload = {
        exportedAt: new Date().toISOString(),
        workspaceId: activeWorkspaceId,
        filter: { kind, query: query.trim() || null },
        // Real projected events only: ids, scopes, statuses, times, actors.
        // Approval arg VALUES are excluded (keys stay in the detail line);
        // no message content, file contents, secrets, keys, or PINs.
        events: filtered.map((r) => ({
          kind: r.kind,
          summary: r.summary,
          detail: r.detail,
          actor: r.actor,
          time: r.time,
          scope: r.scope,
          status: r.status,
        })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'audit-export-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setExported(true);
      showSuccess('Audit exported', filtered.length + ' real event(s) downloaded as JSON.');
      window.setTimeout(() => setExported(false), 2500);
    } catch (err) {
      showError('Export failed', err instanceof Error ? err.message : 'Could not build the export file.');
    }
  }, [filtered, kind, query, activeWorkspaceId, showSuccess, showError]);

  return (
    <div className="space-y-4 text-xs font-sans leading-relaxed">
      <div className="space-y-1 bg-zinc-950 p-4 border border-zinc-900 rounded-lg">
        <h4 className="font-semibold text-zinc-300 text-xs flex items-center gap-1.5">
          <ScrollText size={13} className="text-indigo-400" aria-hidden="true" />
          <span>Audit</span>
        </h4>
        <p className="text-zinc-500 leading-normal">
          Filterable approvals, mount snapshots, model registry entries, and confirmed
          restores from live store state only. Rows without a recorded source field
          show a dash instead of an invented value.
        </p>
      </div>

      <div className="space-y-2 bg-zinc-950 p-4 border border-zinc-900 rounded-lg">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter audit events by kind">
          {KIND_FILTERS.map((f) => {
            const active = kind === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setKind(f.id)}
                aria-pressed={active}
                className={
                  'px-2.5 py-1.5 min-h-[36px] rounded-lg border text-[12px] font-semibold transition cursor-pointer focus-visible:outline-2 focus-visible:outline-indigo-400 ' +
                  (active
                    ? 'border-indigo-500/60 bg-indigo-500/15 text-indigo-200'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800')
                }
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="audit-search" className="sr-only">Search audit events</label>
          <input
            id="audit-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tool, path, run, channel..."
            className="flex-1 min-w-[180px] bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 min-h-[36px] text-[12px] text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500/60"
          />
          <button
            type="button"
            onClick={exportJson}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-[12px] font-semibold transition cursor-pointer focus-visible:outline-2 focus-visible:outline-indigo-200"
          >
            {exported ? <Check size={13} aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
            <span>{exported ? 'Exported audit' : 'Export real events (JSON)'}</span>
          </button>
        </div>
        <div role="status" aria-live="polite">
          <p className="text-zinc-500 text-[12px]">
            Showing {filtered.length} of {rows.length} event(s).
          </p>
        </div>
        {filtered.length === 0 ? (
          <p className="text-zinc-400 text-[12px] rounded-lg border border-zinc-900 bg-zinc-900/20 p-3">
            {rows.length === 0
              ? 'No audit events yet. Approve a tool run, change a mount, register a model, or restore a checkpoint and they appear here.'
              : 'No events match this filter. Clear the search or pick another kind.'}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-900">
            <table className="w-full text-left border-collapse min-w-[560px]">
              <thead>
                <tr className="bg-zinc-900/40 text-zinc-400 text-[11px] uppercase tracking-wide">
                  <th scope="col" className="px-3 py-2 font-semibold">Event</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Actor</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Time</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Scope</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.key} className="border-t border-zinc-900 align-top">
                    <td className="px-3 py-2 min-w-0">
                      <p className="font-semibold text-zinc-200 text-[12px]">
                        <span className="mr-1.5 inline-flex items-center rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400">
                          {kindLabel(r.kind)}
                        </span>
                        {r.summary}
                      </p>
                      {r.detail && (
                        <p className="text-zinc-500 font-mono text-[11px] mt-0.5 break-words">{r.detail}</p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-zinc-300 text-[12px] whitespace-nowrap">{r.actor ?? '\u2014'}</td>
                    <td className="px-3 py-2 text-zinc-300 text-[12px] whitespace-nowrap tnum">{formatTime(r.time)}</td>
                    <td className="px-3 py-2 text-zinc-400 font-mono text-[11px] break-all">{r.scopeLabel ?? r.scope ?? '\u2014'}</td>
                    <td className="px-3 py-2 text-zinc-300 text-[12px] whitespace-nowrap">{r.status ?? '\u2014'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-zinc-500 font-mono text-[11px]">
          Sources: approvals from live approvalRequests (no recorded-at timestamp exists,
          so approval rows show no time); mounts from composer-observed mount snapshots
          (no server mount-change log exists, so unsnapshotted mount edits leave no row);
          models from the live registry (seeded vs user-added rows are indistinguishable,
          so model actors stay unknown); restores from confirmed restoreAuditByRun entries.
        </p>
      </div>
    </div>
  );
}
