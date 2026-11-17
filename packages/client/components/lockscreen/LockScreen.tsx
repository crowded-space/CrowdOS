import React from 'react';
import { useScreenLockStore } from '@/stores/screenLockStore';
import { CrowSigil } from '@/components/ui/CrowSigil';

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
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-md p-6"
    >
      <div className="w-full max-w-xs rounded-xl border border-zinc-800 bg-[#101013]/95 shadow-2xl p-6 text-center">
        <div className="mx-auto mb-4 w-12 h-12 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-center">
          <CrowSigil size={30} tone="auto" detail="full" />
        </div>
        <h2 className="text-sm font-semibold text-zinc-100">Screen Locked</h2>
        <p className="mt-1 text-xs text-zinc-500">Enter your screenlock PIN to resume.</p>
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
            className="w-full min-h-[42px] bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-100 text-center tracking-[0.3em] placeholder:tracking-normal placeholder-zinc-600 focus:outline-none focus:border-[#465EDB] focus:ring-2 focus:ring-[#465EDB]/20 transition disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!pin.trim() || unlocking}
            className="w-full min-h-[42px] py-2 rounded-md bg-[#465EDB] hover:bg-[#5A73E6] text-white text-sm font-medium transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {unlocking ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
        {failed && (
          <p role="alert" className="mt-2.5 text-xs text-rose-400">
            That PIN was not accepted. Try again.
          </p>
        )}
      </div>
    </div>
  );
}
