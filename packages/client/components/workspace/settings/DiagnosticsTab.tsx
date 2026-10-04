import React from 'react';
import { Activity, Copy, Check, AlertTriangle } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useToast } from '@/components/ui/ToastProvider';
import { useReducedMotion } from 'motion/react';

// S12 reference budgets (UX_GUIDELINE.md S12). Only rows with a live
// measurement can violate; everything else reports "not instrumented".
const FETCH_BUDGET_MS = 800;
const COLD_BUDGET_MS = 4000;

type perfRow = { name: string; budgetMs: number; budgetLabel: string; measuredMs: number | null; source: string };

function readFetchMeasures(): PerformanceMeasure[] {
  try {
    return performance.getEntriesByName('fetchWorkspaces') as PerformanceMeasure[];
  } catch {
    return [];
  }
}

function readNavigationMs(): { ms: number | null; source: string } {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!nav) return { ms: null, source: 'performance navigation entry' };
    const ms = nav.domInteractive > 0 ? nav.domInteractive : nav.duration;
    return { ms: Math.round(ms), source: 'performance navigation entry (domInteractive)' };
  } catch {
    return { ms: null, source: 'performance navigation entry' };
  }
}

function readMemoryMB(): { mb: number | null } {
  try {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
    if (!mem || typeof mem.usedJSHeapSize !== 'number') return { mb: null };
    return { mb: Math.round((mem.usedJSHeapSize / 1048576) * 10) / 10 };
  } catch {
    return { mb: null };
  }
}

function countPulsingSurfaces(): number | null {
  try {
    return document.querySelectorAll('.animate-pulse, .animate-pulse-slow, .skeleton').length;
  } catch {
    return null;
  }
}

export default function DiagnosticsTab(): React.JSX.Element {
  const { showSuccess, showError } = useToast();
  const reduceMotion = useReducedMotion();
  const workspaces = useCrowdOSStore((s) => s.workspaces);
  const activeWorkspaceId = useCrowdOSStore((s) => s.activeWorkspaceId);
  const agents = useCrowdOSStore((s) => s.agents);
  const dbSyncStatus = useCrowdOSStore((s) => s.dbSyncStatus);
  const globalSoftCap = useCrowdOSStore((s) => s.globalSoftCap);
  const perProviderBudget = useCrowdOSStore((s) => s.perProviderBudget);
  const totalTokensConsumed = useCrowdOSStore((s) => s.totalTokensConsumed);
  const [copied, setCopied] = React.useState(false);
  const [tick, setTick] = React.useState(0);

  const activeWS = React.useMemo(
    () => workspaces.find((ws) => ws.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );

  const measures = React.useMemo(() => readFetchMeasures(), [tick]);
  const lastFetch = measures.length > 0 ? measures[measures.length - 1] : null;
  const lastFetchMs = lastFetch ? Math.round(lastFetch.duration) : null;
  const nav = React.useMemo(() => readNavigationMs(), [tick]);
  const mem = React.useMemo(() => readMemoryMB(), [tick]);
  const pulsing = React.useMemo(() => countPulsingSurfaces(), [tick]);
  const channelCount = React.useMemo(() => {
    if (!activeWS) return 0;
    const cats = (activeWS.categories ?? []).reduce((n, c) => n + (c.channels?.length ?? 0), 0);
    return cats + (activeWS.channels?.length ?? 0);
  }, [activeWS]);

  const rows: perfRow[] = [
    {
      name: 'Workspace fetch',
      budgetMs: FETCH_BUDGET_MS,
      budgetLabel: '800ms (S12 first-fetch reference)',
      measuredMs: lastFetchMs,
      source: 'performance.measure(\'fetchWorkspaces\')',
    },
    {
      name: 'Cold start to interactive shell',
      budgetMs: COLD_BUDGET_MS,
      budgetLabel: '4000ms cold (S12)',
      measuredMs: nav.ms,
      source: nav.source,
    },
  ];
  const violations = rows.filter((r) => r.measuredMs !== null && r.measuredMs > r.budgetMs);

  const refresh = React.useCallback(() => setTick((t) => t + 1), []);

  const copyBundle = React.useCallback(async () => {
    const bundle = {
      capturedAt: new Date().toISOString(),
      workspace: activeWS
        ? {
            id: activeWS.id,
            name: activeWS.name,
            storagePreference: activeWS.storagePreference ?? 'default',
            databaseConfigured: activeWS.database?.configured ?? false,
            tier: dbSyncStatus?.tier ?? null,
            dbReachable: dbSyncStatus?.dbReachable ?? null,
            backlog: dbSyncStatus?.backlog ?? null,
            agentCount: agents.length,
            channelCount,
          }
        : null,
      budgets: {
        globalSoftCap,
        totalTokensConsumed,
        perProviderBudget,
      },
      perf: {
        fetchWorkspaces: measures.map((m) => ({ durationMs: Math.round(m.duration), startTime: Math.round(m.startTime) })),
        navigationMs: nav.ms,
        rendererMemoryMB: mem.mb,
      },
      motion: {
        prefersReducedMotion: reduceMotion ?? false,
        pulsingSurfaces: pulsing,
        singlePulseRule: 'mention chips pulse once on arrival; roster rows tick without pulse; approval cards pulse until decided',
        cssStaticGate: 'prefers-reduced-motion collapses pulse/spring/shimmer to static (index.css)',
      },
      client: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        theme: typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null,
      },
    };
    const textOut = JSON.stringify(bundle, null, 2);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(textOut);
      } else {
        const ta = document.createElement('textarea');
        ta.value = textOut;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      showSuccess('Diagnostics copied', 'Real workspace, budget, perf, and motion state copied. No secrets included.');
      window.setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      showError('Copy failed', err instanceof Error ? err.message : 'Clipboard write failed.');
    }
  }, [activeWS, agents.length, channelCount, dbSyncStatus, globalSoftCap, perProviderBudget, totalTokensConsumed, measures, nav.ms, mem.mb, pulsing, reduceMotion, showSuccess, showError]);

  return (
    <div className="space-y-4 text-xs font-sans leading-relaxed">
      <div className="space-y-1 bg-zinc-950 p-4 border border-zinc-900 rounded-lg">
        <h4 className="font-semibold text-zinc-300 text-xs flex items-center gap-1.5">
          <Activity size={13} className="text-indigo-400" aria-hidden="true" />
          <span>Diagnostics</span>
        </h4>
        <p className="text-zinc-500 leading-normal">
          Performance violations from real measured marks only, plus motion-budget and accessibility gates.
          Rows without a live measurement report honestly instead of inventing numbers.
        </p>
      </div>

      <div className="space-y-2 bg-zinc-950 p-4 border border-zinc-900 rounded-lg">
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-semibold text-zinc-300 text-xs">Performance budget violations</h4>
          <button
            type="button"
            onClick={refresh}
            className="px-2.5 py-1.5 min-h-[36px] rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-semibold text-zinc-200 hover:bg-zinc-800 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-indigo-400"
          >
            Re-check measurements
          </button>
        </div>
        <div role="status" aria-live="polite" className="space-y-2">
          {rows.map((r) => {
            const violated = r.measuredMs !== null && r.measuredMs > r.budgetMs;
            return (
              <div key={r.name} className="rounded-lg border border-zinc-900 bg-zinc-900/20 p-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-zinc-200 text-[12px]">{r.name}</p>
                  <p className="text-zinc-500 font-mono text-[11px]">Budget {r.budgetLabel}</p>
                  <p className="text-zinc-500 font-mono text-[11px]">Source: {r.source}</p>
                  {r.measuredMs === null ? (
                    <p className="text-zinc-400 text-[12px] mt-1">No measured runs yet in this session.</p>
                  ) : (
                    <p className="tnum text-zinc-300 text-[12px] mt-1">Measured {r.measuredMs}ms</p>
                  )}
                </div>
                <span
                  className={'shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold ' +
                    (violated
                      ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                      : 'border-zinc-800 bg-zinc-950 text-zinc-400')}
                >
                  {violated ? <AlertTriangle size={12} aria-hidden="true" /> : null}
                  <span>{r.measuredMs === null ? 'No data' : violated ? 'Over budget' : 'Within budget'}</span>
                </span>
              </div>
            );
          })}
          {violations.length === 0 && (
            <p className="text-zinc-500 text-[12px]">No budget violations in the measured rows above.</p>
          )}
        </div>
        <p className="text-zinc-500 font-mono text-[11px]">
          S12 channel-switch (150ms rail / 600ms full), tree-expand cached (200ms), palette keystroke (50ms),
          ledger poll (30s), and renderer memory (600MB) have no live marks in this client yet, so they are
          listed here as not instrumented rather than guessed.
          {mem.mb !== null ? ' Renderer memory now: ' + mem.mb + 'MB.' : ''}
        </p>
      </div>

      <div className="space-y-2 bg-zinc-950 p-4 border border-zinc-900 rounded-lg">
        <h4 className="font-semibold text-zinc-300 text-xs">Motion budget and accessibility gates</h4>
        <ul className="space-y-2 text-[12px]">
          <li className="rounded-lg border border-zinc-900 bg-zinc-900/20 p-3">
            <p className="font-semibold text-zinc-200">Single-pulse rule</p>
            <p className="text-zinc-500 leading-normal mt-0.5">
              Mention chips pulse once on arrival; roster rows tick elapsed time without pulsing; approval cards
              pulse only until decided. Live pulsing surfaces now:{' '}
              <span className="tnum font-mono text-zinc-300">{pulsing === null ? 'unknown' : pulsing}</span>.
              Known gap: skeleton shimmer stays continuous by design while loading; the channel mention dot is
              now pulse-once bounded (ChannelButton.tsx) and approval cards pulse only until decided.
            </p>
          </li>
          <li className="rounded-lg border border-zinc-900 bg-zinc-900/20 p-3">
            <p className="font-semibold text-zinc-200">Reduced motion</p>
            <p className="text-zinc-500 leading-normal mt-0.5">
              <span className="font-mono text-zinc-300">prefers-reduced-motion</span> collapses pulse, spring, and
              shimmer to static; the grain overlay hides; the roster spring renders as a plain div. This session:{' '}
              <span className="font-semibold text-zinc-200">{reduceMotion ? 'Reduce requested: static on' : 'No reduce request: motion on'}</span>.
            </p>
          </li>
          <li className="rounded-lg border border-zinc-900 bg-zinc-900/20 p-3">
            <p className="font-semibold text-zinc-200">Toast and live-region policy</p>
            <p className="text-zinc-500 leading-normal mt-0.5">
              Toasts stack max 3 with icon plus text; quiet toasts use polite live regions and auto-dismiss, errors
              use assertive alerts and persist until dismissed. This panel reports violations in a polite status
              region; every control here is keyboard reachable with a visible focus ring.
            </p>
          </li>
        </ul>
      </div>

      <div className="space-y-2 bg-zinc-950 p-4 border border-zinc-900 rounded-lg">
        <h4 className="font-semibold text-zinc-300 text-xs">Diagnostics bundle</h4>
        <p className="text-zinc-500 leading-normal">
          Copies real workspace, budget, measured performance, motion-gate, and client state only. No message
          content, file contents, secrets, keys, or PINs are included.
        </p>
        <button
          type="button"
          onClick={() => void copyBundle()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-[12px] font-semibold transition cursor-pointer focus-visible:outline-2 focus-visible:outline-indigo-200"
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span>{copied ? 'Copied diagnostics' : 'Copy diagnostics bundle'}</span>
        </button>
      </div>
    </div>
  );
}
