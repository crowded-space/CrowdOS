import React from 'react';
import { Lock } from 'lucide-react';
import { useScreenLockStore } from '@/stores/screenLockStore';

/**
 * Literal lock screen: full-viewport blurred veil + PIN gate.
 * Non-dismissible (no close, Escape ignored) — the only way out is a PIN
 * the backend accepts. Rendered at the App root so it covers portal and
 * workspace alike.
 */
export default function LockScreen() {
  const unlockWithPin = useScreenLockStore(s => s.unlockWithPin);
  const [pin, setPinInput] = React.useState('');
  const [unlocking, setUnlocking] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!pin.trim() || unlocking) return;
    setUnlocking(true);
    setFailed(false);
    try {
      const ok = await unlockWithPin(pin);
      if (ok) setPinInput('');
      else setFailed(true);
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Screen locked. Enter PIN to unlock"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-md p-6"
    >
      <div className="w-full max-w-xs rounded-2xl border border-white/10 bg-[#141416]/95 shadow-2xl p-6 text-center">
        <div className="mx-auto mb-4 w-11 h-11 rounded-lg bg-amber-400/10 border border-amber-200/20 flex items-center justify-center">
          <Lock size={18} className="text-amber-200/90" aria-hidden="true" />
        </div>
        <h2 className="text-sm font-semibold text-zinc-100">Locked</h2>
        <p className="mt-1 text-xs text-zinc-500">Enter the screenlock PIN to continue.</p>
        <form onSubmit={e => void submit(e)} className="mt-4 space-y-2.5">
          <input
            ref={inputRef}
            type="password"
            value={pin}
            onChange={e => setPinInput(e.target.value)}
            placeholder="PIN"
            aria-label="Screenlock PIN"
            autoComplete="current-password"
            disabled={unlocking}
            className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-zinc-100 text-center tracking-[0.3em] placeholder:tracking-normal placeholder-zinc-600 focus:outline-none focus:border-amber-200/40 transition disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!pin.trim() || unlocking}
            className="w-full py-2.5 rounded-lg bg-amber-200 hover:bg-amber-100 text-zinc-900 text-sm font-medium transition cursor-pointer disabled:opacity-50"
          >
            {unlocking ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
        {failed && (
          <p role="alert" className="mt-2.5 text-xs text-rose-300/90">
            That PIN was not accepted. Try again.
          </p>
        )}
      </div>
    </div>
  );
}
