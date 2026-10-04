/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react';
import { socket } from '@/src/config/socket';
import { CheckCircle2, ChevronDown, Clock, Database, RotateCcw, Send, TriangleAlert, Wifi, WifiOff, X } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import type { outboxEntry } from '@/stores/crowdOsStore';
import { useShallow } from 'zustand/react/shallow';

// Distinguishes API-down (socket disconnected + fetch failing) from
// DB-degraded (connected, workspace.database.configured === false).
// Offline center (UX guideline section 7): the strip stays a single
// hairline summary with one context-appropriate recovery action; Details
// expands works-now vs waits (real transports only) plus the real outbox
// queue in queuedAt order with will-send copy. No mock rows: every queue
// row traces to the store outbox mirror (crowdos_outbox); an empty outbox
// renders honest empty copy. Static panel, no motion.
interface OfflineBannerProps {
  dbDegraded: boolean;
  onOpenDatabaseSettings: () => void;
  queuedCount?: number;
}

type capabilityRow = { label: string; detail: string };

const WORKS_NOW: ReadonlyArray<capabilityRow> = [
  { label: 'Drafting', detail: 'Drafts keep saving on this device, per channel.' },
  { label: 'Queueing sends', detail: 'New sends wait in the outbox and flush in order.' },
  { label: 'Reading cached history', detail: 'Previously loaded messages stay readable.' },
];

const WAITS_RECONNECT: ReadonlyArray<capabilityRow> = [
  { label: 'Sending queued messages', detail: 'The outbox flushes in queued order after reconnect.' },
  { label: 'Live agent replies', detail: 'New turns need the workspace connection.' },
  { label: 'Missed-event replay', detail: 'The while-you-were-away digest replays after reconnect.' },
];

const DB_WAIT: capabilityRow = { label: 'Memory search', detail: 'Degraded while the database is unavailable.' };

const QUEUE_PREVIEW_LEN = 140;
const QUEUE_VISIBLE_CAP = 20;

function previewText(entry: outboxEntry): string {
  const text = entry.content.trim().replace(/\s+/g, ' ');
  if (text.length > 0) {
    return text.length > QUEUE_PREVIEW_LEN ? text.slice(0, QUEUE_PREVIEW_LEN) + '…' : text;
  }
  if (entry.mentionIds.length > 0) {
    return `No text, ${entry.mentionIds.length} mention${entry.mentionIds.length === 1 ? '' : 's'}.`;
  }
  return 'Empty message.';
}

function formatQueuedAt(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'time unknown';
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function channelLabel(channelId: string, names: ReadonlyMap<string, string>): string {
  const name = names.get(channelId);
  if (name) return `#${name}`;
  return `#${channelId.length > 12 ? channelId.slice(0, 12) + '…' : channelId}`;
}

export default function OfflineBanner({ dbDegraded, onOpenDatabaseSettings, queuedCount = 0 }: OfflineBannerProps) {
  const [browserOnline, setBrowserOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [socketDown, setSocketDown] = useState(false);
  const [forcedOffline, setForcedOffline] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const { outbox, workspaces, flushOutbox, removeOutboxEntry, queueSend } = useCrowdOSStore(
    useShallow((s) => ({
      outbox: s.outbox,
      workspaces: s.workspaces,
      flushOutbox: s.flushOutbox,
      removeOutboxEntry: s.removeOutboxEntry,
      queueSend: s.queueSend,
    })),
  );

  useEffect(() => {
    const goOnline = () => setBrowserOnline(true);
    const goOffline = () => setBrowserOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    const onDisconnect = () => setSocketDown(true);
    const onConnect = () => setSocketDown(false);
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
    };
  }, []);

  const queue = useMemo(() => (Array.isArray(outbox) ? [...outbox] : []), [outbox]);
  const ordered = useMemo(
    () => [...queue].sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : 1)),
    [queue],
  );
  const queuedEntries = useMemo(() => queue.filter((e) => e.status === 'queued'), [queue]);
  const failedEntries = useMemo(() => queue.filter((e) => e.status === 'failed'), [queue]);
  const visible = ordered.slice(0, QUEUE_VISIBLE_CAP);

  const channelNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const ws of workspaces ?? []) {
      for (const ch of ws.channels ?? []) {
        if (ch && ch.id && ch.name) map.set(ch.id, ch.name);
      }
      for (const cat of ws.categories ?? []) {
        for (const ch of cat.channels ?? []) {
          if (ch && ch.id && ch.name) map.set(ch.id, ch.name);
        }
      }
    }
    return map;
  }, [workspaces]);

  const online = browserOnline && !forcedOffline;
  const waits = dbDegraded ? [...WAITS_RECONNECT, DB_WAIT] : WAITS_RECONNECT;

  if (online && !socketDown && !dbDegraded && queue.length === 0 && queuedCount === 0) return null;

  const queueBits: string[] = [];
  if (queuedEntries.length > 0) {
    queueBits.push(
      `${queuedEntries.length} message${queuedEntries.length === 1 ? '' : 's'} will send on reconnect.`,
    );
  }
  if (failedEntries.length > 0) {
    queueBits.push(
      `${failedEntries.length} failed send${failedEntries.length === 1 ? '' : 's'} need${failedEntries.length === 1 ? 's' : ''} retry or discard.`,
    );
  }
  const queueCopy = queueBits.length > 0 ? ` ${queueBits.join(' ')}` : '';
  const copy = !online
    ? `Offline. New sends queue on this device until the connection returns.${queueCopy}`
    : socketDown
      ? `Connection to the local workspace lost. Retrying automatically.${queueCopy}`
      : queue.length > 0
        ? queueBits.join(' ')
        : 'Database unavailable. Running on local files. Memory search is degraded.';
  const showRetry = !online || socketDown;

  const handleRetryConnection = () => {
    setForcedOffline(false);
    try {
      if (socket.disconnected) socket.connect();
    } catch {
      // Socket unavailable; the banner stays until the connection returns.
    }
    try {
      flushOutbox();
    } catch {
      // Flush keeps rows queued; nothing is lost.
    }
  };

  const toggleOffline = () => {
    if (forcedOffline) {
      setForcedOffline(false);
      try {
        if (socket.disconnected) socket.connect();
      } catch {
        // Socket unavailable; the banner stays until the connection returns.
      }
      try {
        flushOutbox();
      } catch {
        // Flush keeps rows queued; nothing is lost.
      }
    } else {
      setForcedOffline(true);
      try {
        socket.disconnect();
      } catch {
        // Disconnect failed; the offline flag still gates the banner copy.
      }
    }
  };

  const retryEntry = (entry: outboxEntry) => {
    removeOutboxEntry(entry.id);
    queueSend({
      channelId: entry.channelId,
      content: entry.content,
      mentionIds: entry.mentionIds,
      runtimeMode: entry.runtimeMode,
    });
  };

  const buttonClass =
    'inline-flex min-h-[24px] items-center gap-1 px-2 rounded-md border border-amber-400/30 bg-amber-400/10 text-[11px] font-semibold text-amber-100 hover:bg-amber-400/20 transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60 cursor-pointer shrink-0';

  return (
    <section
      aria-label="Offline center"
      className="shrink-0 border-b border-amber-500/25 bg-amber-500/[0.07] text-[12px] text-amber-200"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-1.5">
        <p role="status" className="inline-flex items-center gap-1.5">
          <WifiOff size={13} aria-hidden="true" className="shrink-0" />
          <span>{copy}</span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              if (showRetry) handleRetryConnection();
              else onOpenDatabaseSettings();
            }}
            className={buttonClass}
          >
            {showRetry ? (
              <>
                <RotateCcw size={12} aria-hidden="true" />
                Retry connection
              </>
            ) : (
              <>
                <Database size={12} aria-hidden="true" />
                Database settings
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            aria-controls="offline-center-panel"
            className={buttonClass}
          >
            <ChevronDown size={12} aria-hidden="true" />
            {detailsOpen ? 'Hide details' : 'Details'}
          </button>
          <button
            type="button"
            onClick={toggleOffline}
            aria-pressed={forcedOffline}
            title={forcedOffline ? 'Reconnect the workspace socket' : 'Disconnect the workspace socket and work offline'}
            className={buttonClass}
          >
            {forcedOffline ? (
              <>
                <Wifi size={12} aria-hidden="true" />
                Go online
              </>
            ) : (
              <>
                <WifiOff size={12} aria-hidden="true" />
                Go offline
              </>
            )}
          </button>
        </div>
      </div>
      {detailsOpen && (
        <div
          id="offline-center-panel"
          className="grid gap-3 border-t border-amber-500/15 px-4 py-2.5 text-amber-100/90 md:grid-cols-3"
        >
          <div>
            <h3 className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-amber-200">
              <CheckCircle2 size={12} aria-hidden="true" />
              Works now
            </h3>
            <ul aria-label="Works while offline" className="mt-1 space-y-1.5">
              {WORKS_NOW.map((row) => (
                <li key={row.label} className="leading-snug">
                  <span className="font-semibold text-amber-100">{row.label}. </span>
                  <span>{row.detail}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-amber-200">
              <Clock size={12} aria-hidden="true" />
              Waits for reconnect
            </h3>
            <ul aria-label="Waits for reconnect" className="mt-1 space-y-1.5">
              {waits.map((row) => (
                <li key={row.label} className="leading-snug">
                  <span className="font-semibold text-amber-100">{row.label}. </span>
                  <span>{row.detail}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-amber-200">
              <Send size={12} aria-hidden="true" />
              Queued sends ({queue.length})
            </h3>
            {queue.length === 0 ? (
              <p className="mt-1 leading-snug">No queued sends. Nothing is waiting.</p>
            ) : (
              <>
                <ul aria-label="Queued sends" className="mt-1 space-y-2">
                  {visible.map((entry) => {
                    const failed = entry.status === 'failed';
                    const label = channelLabel(entry.channelId, channelNames);
                    return (
                      <li key={entry.id} className="rounded-md border border-amber-400/20 bg-amber-400/[0.06] px-2 py-1.5">
                        <p className="inline-flex items-center gap-1 font-semibold text-amber-100">
                          {failed ? (
                            <TriangleAlert size={12} aria-hidden="true" className="shrink-0" />
                          ) : (
                            <Send size={12} aria-hidden="true" className="shrink-0" />
                          )}
                          <span title={entry.channelId}>
                            {label} · {formatQueuedAt(entry.queuedAt)}
                          </span>
                        </p>
                        <p className="mt-0.5 break-words leading-snug" title={entry.content}>
                          {previewText(entry)}
                        </p>
                        <p className="mt-0.5 leading-snug text-amber-200/80">
                          {failed
                            ? 'Failed to emit. Retry re-queues, or discard to clear.'
                            : 'Queued. Will send on reconnect, in order.'}
                          {entry.runtimeMode ? ` Mode ${entry.runtimeMode}.` : ''}
                          {entry.mentionIds.length > 0 ? ` ${entry.mentionIds.length} mention${entry.mentionIds.length === 1 ? '' : 's'}.` : ''}
                        </p>
                        <p className="mt-1 flex flex-wrap gap-1.5">
                          {failed && (
                            <button
                              type="button"
                              onClick={() => retryEntry(entry)}
                              aria-label={`Retry failed send to ${label}`}
                              className={buttonClass}
                            >
                              <RotateCcw size={11} aria-hidden="true" />
                              Retry
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => removeOutboxEntry(entry.id)}
                            aria-label={`Discard queued send to ${label}`}
                            className={buttonClass}
                          >
                            <X size={11} aria-hidden="true" />
                            Discard
                          </button>
                        </p>
                      </li>
                    );
                  })}
                </ul>
                {ordered.length > visible.length && (
                  <p className="mt-1 leading-snug text-amber-200/80">
                    Plus {ordered.length - visible.length} more in the outbox.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
