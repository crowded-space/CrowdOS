import React, { createContext, useContext, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { appendNotificationHistory } from './notification-history-model';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  type: ToastType;
}

interface ToastContextType {
  toast: (title: string, options?: { description?: string; type?: ToastType }) => void;
  showSuccess: (title: string, description?: string) => void;
  showError: (title: string, description?: string) => void;
  showInfo: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

// Phase D toasts: max 3 stacked (drop oldest beyond 3). Quiet
// (success/info) renders role=status aria-live=polite with auto-dismiss;
// assertive (error) renders role=alert and persists until dismissed so
// need-me events survive.
const TOAST_MAX = 3;
const TOAST_QUIET_DISMISS_MS = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = useCallback((title: string, options?: { description?: string; type?: ToastType }) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const type = options?.type || 'info';
    const newToast: ToastItem = {
      id,
      title,
      description: options?.description,
      type,
    };

    setToasts(prev => [...prev, newToast].slice(-TOAST_MAX));

    // Phase G: every toast persists to the history journal (kind toast,
    // errors assertive) so the notification center can review real rows.
    // Best-effort: storage failure must never break the live stack.
    try {
      appendNotificationHistory({
        id,
        kind: 'toast',
        title,
        detail: options?.description ?? null,
        channelId: null,
        runId: null,
        approvalId: null,
        receivedAt: new Date().toISOString(),
        assertive: type === 'error',
      });
    } catch {
      // Ignore: the live toast still renders.
    }

    // Quiet toasts auto-dismiss; assertive errors persist until dismissed.
    if (type !== 'error') {
      setTimeout(() => {
        removeToast(id);
      }, TOAST_QUIET_DISMISS_MS);
    }
  }, [removeToast]);

  const showSuccess = useCallback((title: string, description?: string) => {
    toast(title, { description, type: 'success' });
  }, [toast]);

  const showError = useCallback((title: string, description?: string) => {
    toast(title, { description, type: 'error' });
  }, [toast]);

  const showInfo = useCallback((title: string, description?: string) => {
    toast(title, { description, type: 'info' });
  }, [toast]);

  return (
    <ToastContext.Provider value={{ toast, showSuccess, showError, showInfo }}>
      {children}
      {/* Toast Render Container — safe area aware, thumb offset */}
      <div className="fixed bottom-4 right-0 sm:right-5 z-[70] flex flex-col gap-2 pointer-events-none select-none max-w-[min(92vw,360px)] w-full px-4 sm:px-0 left-1/2 -translate-x-1/2 sm:left-auto sm:translate-x-0">
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div
              key={t.id}
              role={t.type === 'error' ? 'alert' : 'status'}
              aria-live={t.type === 'error' ? 'assertive' : 'polite'}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="pointer-events-auto flex items-start gap-3 p-3.5 bg-zinc-950/95 border border-zinc-800 rounded-xl shadow-2xl backdrop-blur-md text-zinc-100 font-sans"
            >
              {t.type === 'success' && (
                <CheckCircle2 size={18} className="text-emerald-400 shrink-0 mt-0.5" />
              )}
              {t.type === 'error' && (
                <AlertCircle size={18} className="text-rose-400 shrink-0 mt-0.5" />
              )}
              {t.type === 'info' && (
                <Info size={18} className="text-indigo-400 shrink-0 mt-0.5" />
              )}

              <div className="flex-1 min-w-0 leading-tight">
                <div className="text-xs font-semibold text-zinc-100 tracking-tight font-sans">
                  {t.title}
                </div>
                {t.description && (
                  <div className="text-[11px] text-zinc-400 mt-1 leading-normal">
                    {t.description}
                  </div>
                )}
              </div>

              <button
                onClick={() => removeToast(t.id)}
                className="text-zinc-500 hover:text-zinc-300 p-1 rounded-md hover:bg-zinc-900 transition focus:outline-none cursor-pointer"
              >
                <X size={13} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    return {
      toast: (title: string) => console.log('[Toast]', title),
      showSuccess: (title: string) => console.log('[Toast Success]', title),
      showError: (title: string) => console.log('[Toast Error]', title),
      showInfo: (title: string) => console.log('[Toast Info]', title)
    };
  }
  return context;
}
