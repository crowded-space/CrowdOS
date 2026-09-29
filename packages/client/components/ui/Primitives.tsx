/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';

// Single prestige-minimal primitive kit: one Modal shell (z-50), one Button
// scale, one Input, square Badge, single Toggle language, composed Empty and
// Skeleton. New UI uses these; legacy modals migrate incrementally.
// Shape: 2-4px controls, 6px cards, 8px shells. Accent #465EDB only.

export type buttonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: buttonVariant }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-[3px] text-[13px] font-medium transition duration-200 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 disabled:opacity-50 disabled:pointer-events-none cursor-pointer';
  const styles: Record<buttonVariant, string> = {
    primary: 'bg-[#465EDB] hover:bg-[#5A73E6] text-white shadow-sm',
    secondary: 'bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800',
    danger: 'bg-rose-600 hover:bg-rose-500 text-white shadow-sm',
    ghost: 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900',
  };
  return <button {...props} className={`${base} ${styles[variant]} ${className}`} />;
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full px-2.5 py-1.5 rounded-[3px] bg-zinc-950 border border-zinc-800 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 focus-visible:ring-2 focus-visible:ring-indigo-500/30 transition duration-200 ${props.className ?? ''}`}
    />
  );
}

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

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  maxWidth = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 font-sans select-none"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={`relative w-full ${maxWidth} bg-[#101013] border border-zinc-800 rounded-[8px] overflow-hidden shadow-2xl`}
          >
            <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-3 border-b border-zinc-900">
              <div>
                <h2 className="text-[14px] font-semibold text-zinc-100 tracking-tight">{title}</h2>
                {description && <p className="text-[12px] text-zinc-500 mt-0.5">{description}</p>}
              </div>
              <button
                onClick={onClose}
                aria-label={`Close ${title}`}
                className="text-zinc-500 hover:text-zinc-200 p-1 rounded-[3px] hover:bg-zinc-900 transition cursor-pointer"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <div className="p-4">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
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
