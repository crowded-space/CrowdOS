/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

// Shared primitive kit: square Badge, single Toggle language, composed Empty
// and Skeleton. Only NotificationCenter consumes it today; the Button, Input,
// and Modal shells were removed with zero consumers (each modal hand-rolls
// its own shell).
// Shape: 2-4px controls, 6px cards, 8px shells. Accent #465EDB only.

export type badgeTone = 'neutral' | 'accent' | 'good' | 'bad' | 'warn';

export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: badgeTone;
  children: React.ReactNode;
  className?: string;
}) {
  const styles: Record<badgeTone, string> = {
    neutral: 'bg-zinc-900 text-zinc-400 border-zinc-800',
    accent: 'bg-[#465EDB]/10 text-indigo-300 border-[#465EDB]/25',
    good: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
    bad: 'bg-rose-500/10 text-rose-300 border-rose-500/25',
    warn: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] border text-[11px] font-medium leading-none ${styles[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-[2px] bg-zinc-800 border border-zinc-700 transition duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 cursor-pointer data-[on=true]:bg-[#465EDB] data-[on=true]:border-[#465EDB]"
      data-on={checked}
    >
      <span
        aria-hidden
        className="inline-block h-[12px] w-[12px] rounded-[2px] bg-zinc-400 transition-transform duration-200 translate-x-[2px] data-[on=true]:translate-x-[16px] data-[on=true]:bg-white"
        data-on={checked}
      />
    </button>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-1.5 py-8 px-2" role="status">
      <p className="text-[13px] font-semibold text-zinc-200">{title}</p>
      <p className="text-[12px] text-zinc-500 leading-relaxed max-w-[52ch]">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}
