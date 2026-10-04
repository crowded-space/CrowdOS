/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Notification center (Phase G): reviewable history UI over the persisted
// notification-history-model. Reads real history only - the toast stack
// appends via ToastProvider and dispatch projections via their owners, so
// this view never invents rows. Each row deep-links back through
// applyDeepLink (channel activation plus the existing fetchArtifacts run
// path). DND is a local quiet-hours schedule that gates the header badge
// only; history keeps recording while DND is active.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AtSign,
  Bell,
  BellOff,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  Info,
  Moon,
  ShieldAlert,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { useOverlayFocus } from '@/components/ui/use-overlay-focus';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { Badge, EmptyState, Skeleton, Toggle, type badgeTone as primitiveBadgeTone } from '@/components/ui/Primitives';
import {
  DEFAULT_DND_SCHEDULE,
  clearNotificationHistory,
  formatDndLabel,
  isDndActive,
  loadDndSchedule,
  loadNotificationHistory,
  markAllNotificationsRead,
  markNotificationRead,
  saveDndSchedule,
  subscribeNotificationHistory,
  type dndSchedule,
  type notificationHistoryEntry,
  type notificationKind,
} from '@/components/ui/notification-history-model';
import { applyDeepLink } from '@/src/config/deep-link';

interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
  channelId?: string | null;
  channelName?: string | null;
  isChannelMuted?: boolean;
  onToggleMute?: () => void;
}

function kindMeta(kind: notificationKind, assertive: boolean): { label: string; tone: primitiveBadgeTone } {
  if (kind === 'approval') return { label: 'Approval', tone: 'warn' };
  if (kind === 'failure') return { label: 'Failure', tone: 'bad' };
  if (kind === 'mention') return { label: 'Mention', tone: 'bad' };
  if (kind === 'run') return { label: 'Run', tone: 'accent' };
  if (assertive) return { label: 'Alert', tone: 'bad' };
  return { label: 'Notice', tone: 'neutral' };
}

function KindIcon({ kind, assertive }: { kind: notificationKind; assertive: boolean }): React.JSX.Element {
  const cls = 'shrink-0 mt-0.5';
  if (kind === 'approval') return <ShieldAlert size={15} className={cls + ' text-amber-300'} aria-hidden="true" />;
  if (kind === 'failure') return <CircleAlert size={15} className={cls + ' text-rose-300'} aria-hidden="true" />;
  if (kind === 'mention') return <AtSign size={15} className={cls + ' text-rose-300'} aria-hidden="true" />;
  if (kind === 'run') return <Zap size={15} className={cls + ' text-indigo-300'} aria-hidden="true" />;
  if (assertive) return <CircleAlert size={15} className={cls + ' text-rose-300'} aria-hidden="true" />;
  return <Info size={15} className={cls + ' text-zinc-400'} aria-hidden="true" />;
}

function formatReceivedAt(value: string): string {
  if (!value) return 'time unknown';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'time unknown';
  return d.toLocaleString();
}

function clampHourInput(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(23, Math.floor(value)));
}

function readHistorySafe(): notificationHistoryEntry[] {
  try {
    return loadNotificationHistory();
  } catch {
    return [];
  }
}

function readDndSafe(): dndSchedule {
  try {
    return loadDndSchedule();
  } catch {
    return { ...DEFAULT_DND_SCHEDULE };
  }
}

// Badge source of truth for the header trigger. During DND the badge count
// reports 0 so the badge hides; the DND label carries the reason and the
// raw count stays available for the center. History keeps recording either
// way - DND never deletes or suppresses rows.
export function useNotificationCenterBadge(): { unreadCount: number; rawUnread: number; dndActive: boolean; dndLabel: string } {
  const [entries, setEntries] = useState<notificationHistoryEntry[]>(() => readHistorySafe());
  const [dnd, setDnd] = useState<dndSchedule>(() => readDndSafe());
  useEffect(() => {
    const refresh = (): void => {
      setEntries(readHistorySafe());
      setDnd(readDndSafe());
    };
    refresh();
    const unsubscribe = subscribeNotificationHistory(refresh);
    const timer = setInterval(refresh, 60000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  const rawUnread = useMemo(() => entries.filter((e) => !e.read).length, [entries]);
  const dndActive = isDndActive(dnd);
  return { unreadCount: dndActive ? 0 : rawUnread, rawUnread, dndActive, dndLabel: formatDndLabel(dnd) };
}

export function NotificationCenter({ open, onClose, channelId, channelName, isChannelMuted, onToggleMute }: NotificationCenterProps): React.JSX.Element {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [entries, setEntries] = useState<notificationHistoryEntry[]>([]);
  const [cause, setCause] = useState<string | null>(null);
  const [dnd, setDnd] = useState<dndSchedule>(() => readDndSafe());
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const shouldReduceMotion = useReducedMotion();

  useOverlayFocus(open, containerRef, {
    initialFocusRef: closeRef,
    fallbackFocusSelector: '[title="Open notifications"]',
  });

  const reload = useCallback((): void => {
    setCause(null);
    setPhase("loading");
    try {
      setEntries(loadNotificationHistory());
      setDnd(loadDndSchedule());
      setPhase("ready");
    } catch (err) {
      setCause(err instanceof Error ? err.message : "Notification history could not be read on this device.");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    reload();
    return subscribeNotificationHistory(() => {
      try {
        setEntries(loadNotificationHistory());
        setPhase("ready");
      } catch (err) {
        setCause(err instanceof Error ? err.message : "Notification history could not be read on this device.");
        setPhase("error");
      }
    });
  }, [reload]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const unreadCount = useMemo(() => entries.filter((e) => !e.read).length, [entries]);
  const dndActive = isDndActive(dnd);
  const dndLabel = formatDndLabel(dnd);
  const statusLine = dndActive
    ? 'Paused by ' + dndLabel + ' - history still records'
    : unreadCount > 0
      ? unreadCount + ' unread'
      : 'All caught up';

  const updateDnd = (patch: Partial<dndSchedule>): void => {
    setDnd((prev) => {
      const next: dndSchedule = {
        enabled: patch.enabled ?? prev.enabled,
        startHour: patch.startHour === undefined ? prev.startHour : clampHourInput(patch.startHour),
        endHour: patch.endHour === undefined ? prev.endHour : clampHourInput(patch.endHour),
      };
      try {
        saveDndSchedule(next);
      } catch {
        // Editor keeps the in-memory value for this mount.
      }
      return next;
    });
  };

  const markRead = (id: string): void => {
    markNotificationRead(id);
    setEntries(readHistorySafe());
  };

  const markAllRead = (): void => {
    markAllNotificationsRead();
    setEntries(readHistorySafe());
  };

  const openEntry = async (entry: notificationHistoryEntry): Promise<void> => {
    setLinkError(null);
    try {
      if (entry.runId || entry.channelId) {
        await applyDeepLink({
          channelId: entry.channelId ?? undefined,
          runId: entry.runId ?? undefined,
        });
        onClose();
        return;
      }
      if (entry.approvalId) {
        await applyDeepLink({ view: 'inbox' });
        onClose();
        return;
      }
      setLinkError("This notification has no channel or run to open.");
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Could not open this notification.");
    }
  };

  const activeChannelLabel = channelName ? '#' + channelName : channelId ? 'channel ' + channelId : 'this channel';

  const motionProps = shouldReduceMotion ? { duration: 0 } : { duration: 0.18 };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80] font-sans select-none">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionProps}
            onClick={onClose}
            aria-hidden="true"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm motion-reduce:transition-none"
          />
          <motion.div
            ref={containerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Notification center"
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, x: 24 }}
            animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, x: 24 }}
            transition={motionProps}
            className="absolute right-0 top-0 bottom-0 w-full max-w-md bg-[#0e0e11] border-l border-zinc-800 shadow-2xl flex flex-col min-h-0 motion-reduce:transition-none"
          >
            <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 border-b border-zinc-900">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100 tracking-tight">
                  <Bell size={15} className="text-zinc-400 shrink-0" aria-hidden="true" />
                  <span>Notifications</span>
                  {dndActive && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-zinc-900 border border-zinc-700 text-[10px] font-medium text-zinc-300">
                      <Moon size={10} aria-hidden="true" />
                      <span>{dndLabel}</span>
                    </span>
                  )}
                </h2>
                <p className="text-[11px] text-zinc-500 mt-1" aria-live="polite">{statusLine}</p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close notification center"
                className="text-zinc-500 hover:text-zinc-200 p-2 rounded-lg hover:bg-zinc-900 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 cursor-pointer shrink-0 motion-reduce:transition-none"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            <div className="px-4 py-3 border-b border-zinc-900 space-y-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={markAllRead}
                  disabled={unreadCount === 0}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[32px] rounded-lg text-[11px] font-medium border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-zinc-900 border-zinc-800 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 motion-reduce:transition-none"
                >
                  <CheckCheck size={13} aria-hidden="true" />
                  <span>Mark all read</span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClearOpen(true)}
                  disabled={entries.length === 0}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[32px] rounded-lg text-[11px] font-medium border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-zinc-900 border-zinc-800 text-zinc-300 hover:text-rose-300 hover:bg-rose-500/10 motion-reduce:transition-none"
                >
                  <Trash2 size={13} aria-hidden="true" />
                  <span>Clear</span>
                </button>
              </div>
              {typeof onToggleMute === "function" && (
                <div className="flex items-center justify-between gap-2 rounded-xl bg-zinc-950 border border-zinc-900 px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400 min-w-0">
                    {isChannelMuted
                      ? <BellOff size={13} className="text-rose-400 shrink-0" aria-hidden="true" />
                      : <Bell size={13} className="text-zinc-500 shrink-0" aria-hidden="true" />}
                    <span className="truncate">{activeChannelLabel} is {isChannelMuted ? "muted" : "audible"}</span>
                  </span>
                  <button
                    type="button"
                    onClick={onToggleMute}
                    aria-pressed={!!isChannelMuted}
                    className="px-2.5 py-1 min-h-[30px] rounded-lg text-[11px] font-medium border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 cursor-pointer bg-zinc-900 border-zinc-800 text-zinc-300 hover:text-zinc-100 motion-reduce:transition-none"
                  >
                    {isChannelMuted ? "Unmute" : "Mute"}
                  </button>
                </div>
              )}
              <section aria-label="Do not disturb schedule" className="rounded-xl bg-zinc-950 border border-zinc-900 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <Moon size={13} className="shrink-0" aria-hidden="true" />
                    <span>Do not disturb is {dnd.enabled ? "on" : "off"} - {dndLabel}</span>
                  </span>
                  <Toggle checked={dnd.enabled} onChange={(next) => updateDnd({ enabled: next })} label="Do not disturb" />
                </div>
                {dnd.enabled && (
                  <div className="flex items-center gap-3 mt-2.5">
                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                      <span>Start</span>
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={dnd.startHour}
                        aria-label="Do not disturb start hour"
                        onChange={(e) => updateDnd({ startHour: clampHourInput(Number(e.target.value)) })}
                        className="w-16 px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-[12px] text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                      />
                      <span className="text-zinc-600">h</span>
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                      <span>End</span>
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={dnd.endHour}
                        aria-label="Do not disturb end hour"
                        onChange={(e) => updateDnd({ endHour: clampHourInput(Number(e.target.value)) })}
                        className="w-16 px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-[12px] text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                      />
                      <span className="text-zinc-600">h</span>
                    </label>
                  </div>
                )}
                <p className="text-[10px] text-zinc-600 mt-2 leading-relaxed">Quiet hours live on this device only. The header badge pauses while active; history keeps recording.</p>
              </section>
            </div>

            {linkError && (
              <div role="alert" className="mx-4 mt-3 px-3 py-2 rounded-xl bg-rose-500/10 border border-rose-500/25 text-[11px] text-rose-200">
                {linkError}
              </div>
            )}
            <div aria-live="polite" className="flex-1 min-h-0 overflow-y-auto px-4 py-3 scrollbar-thin">
              {phase === "loading" && (
                <div>
                  <p role="status" className="text-[11px] text-zinc-500 mb-2">Loading notifications...</p>
                  <Skeleton className="h-16 rounded-xl mb-2" />
                  <Skeleton className="h-16 rounded-xl mb-2" />
                  <Skeleton className="h-16 rounded-xl" />
                </div>
              )}
              {phase === "error" && (
                <div role="alert" className="rounded-xl bg-rose-500/10 border border-rose-500/25 px-3.5 py-3">
                  <p className="text-[12px] font-semibold text-rose-200">Notifications failed to load</p>
                  <p className="text-[11px] text-rose-200/80 mt-1 leading-relaxed">{cause ?? "Unknown storage error."}</p>
                  <button
                    type="button"
                    onClick={reload}
                    className="mt-2.5 px-3 py-1.5 min-h-[32px] rounded-lg text-[11px] font-semibold bg-rose-600 hover:bg-rose-500 text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/50 cursor-pointer motion-reduce:transition-none"
                  >
                    Retry
                  </button>
                </div>
              )}
              {phase === "ready" && entries.length === 0 && (
                <EmptyState
                  title="No notifications yet"
                  body="Toasts, approvals, run updates, and mentions land here as they happen. An empty list means no events reached this device yet - nothing is fabricated."
                  action={
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-3 py-1.5 min-h-[32px] rounded-lg text-[11px] font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 cursor-pointer motion-reduce:transition-none"
                    >
                      Back to {activeChannelLabel}
                    </button>
                  }
                />
              )}
              {phase === "ready" && entries.length > 0 && (
                <ol className="space-y-2">
                  {entries.map((entry) => {
                    const meta = kindMeta(entry.kind, entry.assertive);
                    const canOpen = Boolean(entry.channelId || entry.runId || entry.approvalId);
                    return (
                      <li key={entry.id}>
                        <article aria-label={entry.title} className="flex items-start gap-2.5 p-3 rounded-xl bg-zinc-950 border border-zinc-900 hover:border-zinc-700 transition motion-reduce:transition-none">
                          <KindIcon kind={entry.kind} assertive={entry.assertive} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <p className="text-[12px] font-semibold text-zinc-100 truncate flex-1">{entry.title}</p>
                              {!entry.read && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-indigo-500/15 border border-indigo-500/30 text-[10px] font-medium text-indigo-200 shrink-0">
                                  <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-indigo-300" />
                                  <span>Unread</span>
                                </span>
                              )}
                            </div>
                            {entry.detail && (
                              <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed break-words">{entry.detail}</p>
                            )}
                            <div className="flex flex-wrap items-center gap-1.5 mt-2">
                              <Badge tone={meta.tone}>{meta.label}</Badge>
                              {entry.channelId && (
                                <span className="text-[10px] font-mono text-zinc-500">channel {entry.channelId}</span>
                              )}
                              {entry.runId && (
                                <span className="text-[10px] font-mono text-zinc-500">run {entry.runId}</span>
                              )}
                              <span className="text-[10px] text-zinc-600">{formatReceivedAt(entry.receivedAt)}</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5 mt-2">
                              {canOpen && (
                                <button
                                  type="button"
                                  onClick={() => void openEntry(entry)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 min-h-[30px] rounded-lg text-[11px] font-medium bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100 hover:border-zinc-700 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 cursor-pointer motion-reduce:transition-none"
                                >
                                  <span>Open</span>
                                  <ChevronRight size={12} aria-hidden="true" />
                                </button>
                              )}
                              {!entry.read && (
                                <button
                                  type="button"
                                  onClick={() => markRead(entry.id)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 min-h-[30px] rounded-lg text-[11px] font-medium bg-transparent border border-transparent text-zinc-500 hover:text-zinc-200 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 cursor-pointer motion-reduce:transition-none"
                                >
                                  <CheckCheck size={12} aria-hidden="true" />
                                  <span>Mark read</span>
                                </button>
                              )}
                            </div>
                          </div>
                        </article>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>

            <p className="px-4 py-2.5 border-t border-zinc-900 text-[10px] text-zinc-600 leading-relaxed">Badge pauses during do not disturb. Tray badge and OS quiet hours are not bridged on this client.</p>
          <ConfirmDialog
            open={confirmClearOpen}
            title="Clear notifications?"
            description="This clears the persisted notification history on this device only (crowdos_notification_history). New toasts and dispatch events will start recording again from empty. This cannot be undone."
            confirmLabel="Clear history"
            isDanger={true}
            onConfirm={() => {
              clearNotificationHistory();
              setEntries(readHistorySafe());
              setConfirmClearOpen(false);
            }}
            onCancel={() => setConfirmClearOpen(false)}
          />          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export default NotificationCenter;