import { useEffect, useState } from 'react';
import { KeyRound, Check, Loader2, Lock, LockOpen } from 'lucide-react';
import { apiClient } from '@/src/api/client';
import { setPin, clearPin } from '@/src/config/pin';
import { useCrowdOSStore } from '@/stores/crowdOsStore';

interface Props {
  workspaceId: string;
}

/**
 * Workspace screenlock PIN — explicit opt-in surface-level screenlock.
 * Only scrypt hashes are stored server-side; this panel never displays the
 * PIN, only an enabled/disabled flag. Setting a new PIN also unlocks this
 * client (setPin) so subsequent API calls keep authenticating; disabling
 * drops the local copy (clearPin).
 */
export default function ScreenLockSettingsPanel({ workspaceId }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const status = await apiClient.getScreenLockStatus(workspaceId);
      setEnabled(status.enabled);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load screenlock status.');
    }
    setLoading(false);
  }

  useEffect(() => {
    setNewPin('');
    setConfirmPin('');
    setCurrentPin('');
    setNotice(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  function markEnabled(next: boolean) {
    setEnabled(next);
    try {
      const { workspaces } = useCrowdOSStore.getState();
      useCrowdOSStore.setState({
        workspaces: workspaces.map((ws: any) =>
          ws.id === workspaceId ? { ...ws, screenLockEnabled: next } : ws,
        ),
      });
    } catch {}
  }

  async function save() {
    setError(null);
    setNotice(null);
    const pin = newPin.trim();
    if (pin.length < 4) {
      setError('PIN must be at least 4 characters.');
      return;
    }
    if (pin.length > 128) {
      setError('PIN must be at most 128 characters.');
      return;
    }
    if (pin !== confirmPin.trim()) {
      setError('New PIN and confirmation do not match.');
      return;
    }
    if (enabled && !currentPin.trim()) {
      setError('Enter the current PIN to change it.');
      return;
    }
    setSaving(true);
    try {
      const res = await apiClient.setScreenLockPin(
        workspaceId,
        pin,
        enabled ? currentPin.trim() : undefined,
      );
      setPin(pin);
      markEnabled(res.enabled);
      setNewPin('');
      setConfirmPin('');
      setCurrentPin('');
      setNotice(enabled ? 'Screenlock PIN changed.' : 'Screenlock PIN enabled on this client.');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to set screenlock PIN.');
    }
    setSaving(false);
  }

  async function disable() {
    setError(null);
    setNotice(null);
    if (enabled && !currentPin.trim()) {
      setError('Enter the current PIN to disable the screenlock.');
      return;
    }
    setSaving(true);
    try {
      const res = await apiClient.disableScreenLockPin(
        workspaceId,
        enabled ? currentPin.trim() : undefined,
      );
      clearPin();
      markEnabled(res.enabled);
      setNewPin('');
      setConfirmPin('');
      setCurrentPin('');
      setNotice('Screenlock disabled.');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to disable screenlock.');
    }
    setSaving(false);
  }

  if (loading) {
    return (
      <div className="text-xs text-zinc-500 p-3 flex items-center gap-2">
        <Loader2 size={12} className="animate-spin" /> Loading screenlock status…
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 bg-zinc-900 border border-zinc-800 rounded-xl">
      <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
        <KeyRound size={14} className="text-indigo-400" />
        <span>Screen Lock PIN</span>
        <span
          className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-medium border ${
            enabled
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-zinc-800 border-zinc-700 text-zinc-400'
          }`}
        >
          {enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      <p className="text-[11px] text-zinc-500">
        Low-friction screenlock against casual physical access (not full auth). Disabled by
        default. Set a PIN to opt in. Only a hash is stored server-side.
      </p>

      {enabled && (
        <div className="space-y-1">
          <label className="text-[11px] text-zinc-500">Current PIN (required to change or disable)</label>
          <input
            type="password"
            value={currentPin}
            onChange={(e) => setCurrentPin(e.target.value)}
            autoComplete="off"
            placeholder="••••"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500/60"
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[11px] text-zinc-500">{enabled ? 'New PIN' : 'New PIN (min 4 chars)'}</label>
          <input
            type="password"
            value={newPin}
            onChange={(e) => setNewPin(e.target.value)}
            autoComplete="new-password"
            placeholder="••••"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500/60"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-zinc-500">Confirm PIN</label>
          <input
            type="password"
            value={confirmPin}
            onChange={(e) => setConfirmPin(e.target.value)}
            autoComplete="new-password"
            placeholder="••••"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500/60"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
          {enabled ? 'Change PIN' : 'Enable screenlock'}
        </button>
        {enabled && (
          <button
            onClick={disable}
            disabled={saving}
            className="flex-1 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
          >
            <LockOpen size={12} /> Disable
          </button>
        )}
      </div>

      {notice && (
        <div className="text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2 py-1 flex items-center gap-1">
          <Check size={11} /> {notice}
        </div>
      )}
      {error && <div className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-2 py-1">{error}</div>}
    </div>
  );
}
