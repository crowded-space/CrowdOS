import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Database, Eye, EyeOff, Loader2, Plug, Trash2, X, XCircle } from 'lucide-react';
import CrowIcon, { type CrowIconVariant } from '@/components/ui/CrowIcon';
import { apiClient, isPostgresUrl } from '@/src/api/client';
import type { WorkspaceDatabaseInfo } from '@/types/crowdOs';

export const WORKSPACE_ICONS: Array<{ variant: CrowIconVariant; label: string }> = [
  { variant: 'crow-white-rounded', label: 'Arctic Sentinel' },
  { variant: 'crow-dark-rounded', label: 'Ivory Scout' },
  { variant: 'crow-indigo-circle', label: 'Indigo Command' },
  { variant: 'crow-amber-cyber', label: 'Amber Telemetry' },
  { variant: 'crow-cyan-radar', label: 'Cyan Radar' },
  { variant: 'crow-rose-governance', label: 'Rose Governance' },
  { variant: 'crow-matrix-terminal', label: 'Matrix Terminal' },
  { variant: 'crow-cosmos', label: 'Deep Cosmos' },
];

export function countWorkspaceChannels(ws: { channels?: Array<unknown> | null; categories: Array<{ channels: Array<unknown> }> }): number {
  const top = ws.channels?.length ?? 0;
  const nested = ws.categories.reduce((n, c) => n + c.channels.length, 0);
  return top + nested;
}

// ─── Workspace icon picker (shared by portal create/edit + settings) ────

export function WorkspaceIconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (variant: string) => void;
}) {
  return (
    <div>
      <p className="text-zinc-500 font-bold font-mono text-[10px] uppercase tracking-widest mb-2">
        Workspace Icon
      </p>
      <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Workspace icon">
        {WORKSPACE_ICONS.map(({ variant, label }) => {
          const selected = value === variant;
          return (
            <button
              key={variant}
              type="button"
              role="radio"
              aria-checked={selected}
              title={label}
              aria-label={label}
              onClick={() => onChange(variant)}
              className={`group flex flex-col items-center gap-1 rounded-xl border p-2 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 ${
                selected
                  ? 'border-white/30 bg-white/[0.06]'
                  : 'border-white/[0.07] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.05]'
              }`}
            >
              <CrowIcon variant={variant} className="w-9 h-9 rounded-lg bg-transparent border-0 shadow-none" iconSize={70} />
              <span className={`text-[9px] font-mono leading-none truncate w-full text-center ${selected ? 'text-zinc-200' : 'text-zinc-600 group-hover:text-zinc-400'}`}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Workspace database field (BYODB, shared by create/edit + settings) ─

export interface WorkspaceDatabaseState {
  /** keep: leave untouched · set: save a new URL · clear: disconnect */
  mode: 'keep' | 'set' | 'clear';
  url: string;
  /** True once the Provision step succeeded for the current url. */
  provisioned: boolean;
}

export function initialDatabaseState(): WorkspaceDatabaseState {
  return { mode: 'keep', url: '', provisioned: false };
}

/** Resolve the form state to a PATCH/POST value. `undefined` = untouched. */
export function resolveDatabaseUrl(state: WorkspaceDatabaseState): string | null | undefined {
  if (state.mode === 'clear') return null;
  if (state.mode === 'set') {
    const trimmed = state.url.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

type DbTestStatus = 'idle' | 'testing' | 'ok' | 'failed';

export function WorkspaceDatabaseField({
  initial,
  state,
  onChange,
}: {
  /** Current server-known descriptor (`null` = never configured). */
  initial: WorkspaceDatabaseInfo | null | undefined;
  state: WorkspaceDatabaseState;
  onChange: (s: WorkspaceDatabaseState) => void;
}) {
  const [showSecret, setShowSecret] = React.useState(false);
  const [test, setTest] = React.useState<{ status: DbTestStatus; message?: string }>({ status: 'idle' });
  const [provision, setProvision] = React.useState<{ status: 'idle' | 'working' | 'ok' | 'failed'; message?: string }>({ status: 'idle' });
  const [confirmClear, setConfirmClear] = React.useState(false);

  const configured = Boolean(initial?.configured);
  const editing = state.mode === 'set' || !configured;
  const trimmed = state.url.trim();
  const shapeInvalid = trimmed.length > 0 && !isPostgresUrl(trimmed);

  const setUrl = (url: string) => {
    onChange({ ...state, url, provisioned: false });
    setTest({ status: 'idle' });
    setProvision({ status: 'idle' });
  };

  const runTest = async () => {
    if (!trimmed || shapeInvalid || test.status === 'testing') return;
    setTest({ status: 'testing' });
    try {
      const res = await apiClient.testWorkspaceDatabase(trimmed);
      setTest({ status: 'ok', message: res.host ? `Connected — ${res.host}${res.database ? `/${res.database}` : ''}` : 'Connected.' });
    } catch (err) {
      setTest({ status: 'failed', message: err instanceof Error ? err.message : 'Connection failed.' });
    }
  };

  const runProvision = async () => {
    if (!trimmed || shapeInvalid || provision.status === 'working') return;
    setProvision({ status: 'working' });
    try {
      const res = await apiClient.provisionWorkspaceDatabase(trimmed);
      onChange({ ...state, provisioned: true });
      setProvision({
        status: 'ok',
        message: res.message ?? `Schema ready — ${res.migrationsApplied ?? 0} migrations recorded.`,
      });
    } catch (err) {
      onChange({ ...state, provisioned: false });
      setProvision({ status: 'failed', message: err instanceof Error ? err.message : 'Provisioning failed.' });
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="ws-form-db-url" className="text-zinc-500 font-bold font-mono text-[10px] uppercase tracking-widest flex items-center gap-1.5">
          <Database size={11} />
          <span>Database · BYODB</span>
        </label>
        {configured ? (
          <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-300/90">
            <span className="w-1 h-1 rounded-full bg-emerald-400" /> Connected
          </span>
        ) : (
          <span className="text-[10px] font-mono text-zinc-600">Optional</span>
        )}
      </div>

      {configured && state.mode === 'keep' ? (
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 space-y-2">
          <p className="text-xs text-zinc-300 font-mono truncate" title={initial?.host ?? ''}>
            {initial?.host ?? 'Connected database'}
            {initial?.database ? <span className="text-zinc-500">/{initial.database}</span> : null}
          </p>
          {confirmClear ? null : (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onChange({ mode: 'set', url: '', provisioned: false })}
                className="h-7 px-2.5 rounded-md border border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05] text-[11px] transition cursor-pointer"
              >
                Replace…
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="h-7 px-2.5 rounded-md text-zinc-600 hover:text-rose-300 hover:bg-rose-400/10 text-[11px] transition cursor-pointer"
              >
                Disconnect
              </button>
            </div>
          )}
          {confirmClear && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-zinc-400 flex-1">Remove this database on save?</span>
              <button
                type="button"
                onClick={() => { onChange({ mode: 'clear', url: '', provisioned: false }); setConfirmClear(false); }}
                className="h-7 px-2.5 rounded-md bg-rose-600/90 hover:bg-rose-500 text-white text-[11px] font-medium transition cursor-pointer"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="h-7 px-2.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05] text-[11px] transition cursor-pointer"
              >
                Keep
              </button>
            </div>
          )}
        </div>
      ) : null}

      {configured && initial && initial.schemaReady === false && state.mode === 'keep' ? (
        <p className="text-[11px] text-amber-200/80">
          Schema not provisioned on this database yet — Replace the URL above, Test it, then Provision schema.
        </p>
      ) : null}

      {state.mode === 'clear' ? (
        <div className="rounded-xl border border-amber-200/15 bg-amber-400/[0.06] px-3 py-2.5 flex items-center gap-2">
          <p className="text-[11px] text-amber-200/90 flex-1">Database will be disconnected when you save. Its `.env` entry is removed.</p>
          <button
            type="button"
            onClick={() => onChange({ mode: 'keep', url: '', provisioned: false })}
            className="h-7 px-2.5 rounded-md border border-white/10 text-zinc-300 hover:bg-white/[0.05] text-[11px] transition cursor-pointer shrink-0"
          >
            Undo
          </button>
        </div>
      ) : null}

      {editing && state.mode !== 'clear' ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <input
                id="ws-form-db-url"
                type={showSecret ? 'text' : 'password'}
                value={state.url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void runTest(); } }}
                placeholder="postgresql://user:password@host:5432/dbname"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="url"
                aria-label="Workspace Postgres database URL"
                className="w-full bg-white/[0.03] border border-white/[0.08] focus:border-white/25 focus:ring-2 focus:ring-white/10 rounded-xl px-3 py-2.5 pr-10 min-h-[44px] text-[13px] sm:text-xs font-mono text-zinc-100 focus:outline-none placeholder-zinc-600"
              />
              <button
                type="button"
                onClick={() => setShowSecret(v => !v)}
                aria-label={showSecret ? 'Hide database URL' : 'Show database URL'}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition flex items-center justify-center cursor-pointer"
              >
                {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={!trimmed || shapeInvalid || test.status === 'testing'}
              className={`h-[44px] px-3 rounded-xl text-xs font-medium flex items-center gap-1.5 transition shrink-0 cursor-pointer ${
                trimmed && !shapeInvalid && test.status !== 'testing'
                  ? 'border border-white/15 text-zinc-100 hover:bg-white/[0.06]'
                  : 'border border-white/[0.07] text-zinc-600 cursor-not-allowed'
              }`}
            >
              {test.status === 'testing' ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
              Test
            </button>
          </div>
          {shapeInvalid && (
            <p className="text-[11px] text-amber-400">Must be a valid <span className="font-mono">postgresql://</span> URL.</p>
          )}
          {test.status === 'testing' && (
            <p className="text-[11px] text-zinc-400 flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" /> Testing connection…
            </p>
          )}
          {test.status === 'ok' && (
            <p className="text-[11px] text-emerald-300 flex items-center gap-1.5">
              <CheckCircle2 size={12} /> {test.message}
            </p>
          )}
          {test.status === 'failed' && (
            <p role="alert" className="text-[11px] text-rose-300 flex items-start gap-1.5">
              <XCircle size={12} className="mt-0.5 shrink-0" /> {test.message}
            </p>
          )}
          {/* Provision step: migrations only, idempotent — Test first, then provision, then save. */}
          {trimmed && !shapeInvalid && (
            <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <p className="text-[11px] text-zinc-400 flex-1">
                  {state.provisioned
                    ? 'Schema provisioned for this URL.'
                    : 'Apply the Crowd OS schema to this database (fresh databases need it).'}
                </p>
                {!state.provisioned && (
                  <button
                    type="button"
                    onClick={() => void runProvision()}
                    disabled={provision.status === 'working'}
                    className="h-7 px-2.5 rounded-md border border-white/15 text-zinc-100 hover:bg-white/[0.06] text-[11px] font-medium flex items-center gap-1.5 transition shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                  >
                    {provision.status === 'working' && <Loader2 size={11} className="animate-spin" />}
                    {provision.status === 'working' ? 'Provisioning…' : 'Provision schema'}
                  </button>
                )}
              </div>
              {provision.status === 'ok' && (
                <p className="text-[11px] text-emerald-300 flex items-center gap-1.5">
                  <CheckCircle2 size={12} /> {provision.message} Included on save.
                </p>
              )}
              {provision.status === 'failed' && (
                <p role="alert" className="text-[11px] text-rose-300 flex items-start gap-1.5">
                  <XCircle size={12} className="mt-0.5 shrink-0" />
                  <span>{provision.message} You can still save — retry provisioning later from settings.</span>
                </p>
              )}
            </div>
          )}
          {configured && (
            <button
              type="button"
              onClick={() => { onChange({ mode: 'keep', url: '', provisioned: false }); setTest({ status: 'idle' }); }}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 transition cursor-pointer"
            >
              ← Back to current database
            </button>
          )}
        </div>
      ) : null}

      <p className="text-[10px] text-zinc-600 leading-relaxed">
        Saved to the local <span className="font-mono">.env</span> as <span className="font-mono">CROWDOS_WS_&lt;ID&gt;_DATABASE_URL</span> — takes effect immediately, no restart.
      </p>
    </div>
  );
}

// ─── Create / Edit workspace modal ───────────────────────────────────────

export function WorkspaceFormModal({
  open,
  mode,
  initialName,
  initialIcon,
  initialDatabase,
  isSaving,
  error,
  existingNames,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  initialName: string;
  initialIcon: string;
  initialDatabase?: WorkspaceDatabaseInfo | null;
  isSaving: boolean;
  error: string | null;
  existingNames: string[];
  onCancel: () => void;
  onSubmit: (name: string, icon: string, databaseUrl: string | null | undefined, schemaReady?: boolean) => void;
}) {
  const [name, setName] = React.useState(initialName);
  const [icon, setIcon] = React.useState(initialIcon);
  const [dbState, setDbState] = React.useState<WorkspaceDatabaseState>(initialDatabaseState());

  React.useEffect(() => {
    if (open) {
      setName(initialName);
      setIcon(initialIcon);
      setDbState(initialDatabaseState());
    }
  }, [open, initialName, initialIcon]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  const trimmed = name.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < 2;
  const tooLong = trimmed.length > 100;
  const duplicate =
    trimmed.length > 0 &&
    existingNames.some(n => n.toLowerCase() === trimmed.toLowerCase() && n !== initialName);
  const dbTrimmed = dbState.url.trim();
  const dbInvalid = dbState.mode === 'set' && dbTrimmed.length > 0 && !isPostgresUrl(dbTrimmed);
  const canSubmit = trimmed.length >= 1 && !tooShort && !tooLong && !dbInvalid && !isSaving;

  return (
    <AnimatePresence>
      {open && (
        <div role="dialog" aria-modal="true" aria-label={mode === 'create' ? 'Create workspace' : 'Edit workspace'} className="fixed inset-0 z-[9990] flex items-center justify-center p-4">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onCancel} className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0.1 }}
            className="relative w-full max-w-md bg-[#101013] border border-white/10 rounded-2xl shadow-2xl p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100 tracking-tight">
                  {mode === 'create' ? 'Create workspace' : 'Edit workspace'}
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                  {mode === 'create'
                    ? 'Workspaces are isolated — channels and mounts stay inside.'
                    : 'Rename or re-skin this workspace. Channels are untouched.'}
                </p>
              </div>
              <button onClick={onCancel} aria-label="Close workspace form" className="text-zinc-500 hover:text-zinc-200 p-1.5 rounded-lg hover:bg-zinc-900 transition cursor-pointer">
                <X size={15} />
              </button>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="ws-form-name" className="text-zinc-500 font-bold font-mono text-[10px] uppercase tracking-widest">
                Workspace name
              </label>
              <input
                id="ws-form-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Swarm Research Core"
                maxLength={100}
                autoComplete="off"
                className="w-full bg-white/[0.03] border border-white/[0.08] focus:border-white/25 focus:ring-2 focus:ring-white/10 rounded-xl px-3 py-2.5 min-h-[44px] text-sm text-zinc-100 focus:outline-none placeholder-zinc-600"
              />
              {tooShort && <p className="text-[11px] text-amber-400">Name must be at least 2 characters.</p>}
              {tooLong && <p className="text-[11px] text-rose-400">Name must be 100 characters or fewer.</p>}
              {duplicate && <p className="text-[11px] text-amber-400">A workspace with this name already exists.</p>}
            </div>

            <WorkspaceIconPicker value={icon} onChange={setIcon} />

            <WorkspaceDatabaseField initial={initialDatabase ?? null} state={dbState} onChange={setDbState} />

            {error && (
              <p role="alert" className="text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-1 border-t border-white/[0.07]">
              <button onClick={onCancel} className="px-3.5 py-2 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05] transition cursor-pointer">
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!canSubmit) return;
                  const dbUrl = resolveDatabaseUrl(dbState);
                  onSubmit(trimmed, icon, dbUrl, dbUrl ? dbState.provisioned : undefined);
                }}
                disabled={!canSubmit}
                className={`px-4 py-2 rounded-lg text-xs font-medium transition flex items-center gap-1.5 cursor-pointer ${
                  canSubmit ? 'bg-zinc-100 text-zinc-900 hover:bg-white' : 'bg-white/[0.04] text-zinc-600 cursor-not-allowed'
                }`}
              >
                {isSaving && <Loader2 size={13} className="animate-spin" />}
                {mode === 'create' ? 'Create workspace' : 'Save changes'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

// ─── Strict 3-step workspace deletion wizard ─────────────────────────────

export interface DeleteWizardWorkspace {
  id: string;
  name: string;
  icon: string;
  categoryCount: number;
  channelCount: number;
}

export function DeleteWorkspaceWizard({
  open,
  workspace,
  isDeleting,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  workspace: DeleteWizardWorkspace | null;
  isDeleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [step, setStep] = React.useState(1);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [nameInput, setNameInput] = React.useState('');
  const [destroyInput, setDestroyInput] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setStep(1);
      setAcknowledged(false);
      setNameInput('');
      setDestroyInput('');
    }
  }, [open, workspace?.id]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isDeleting) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isDeleting, onCancel]);

  if (!workspace) return null;
  const nameMatches = nameInput.trim() === workspace.name;
  const destroyMatches = destroyInput.trim() === 'DELETE';

  const steps = ['Acknowledge', 'Verify name', 'Destroy'];

  return (
    <AnimatePresence>
      {open && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="delete-wizard-title" aria-describedby="delete-wizard-desc" className="fixed inset-0 z-[9991] flex items-center justify-center p-4">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !isDeleting && onCancel()} className="absolute inset-0 bg-black/75 backdrop-blur-sm" />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0.1 }}
            className="relative w-full max-w-md bg-[#101013] border border-rose-400/20 rounded-2xl shadow-2xl p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-rose-500/10 border border-rose-500/25 text-rose-400 flex items-center justify-center shrink-0">
                <AlertTriangle size={18} />
              </div>
              <div className="min-w-0">
                <h3 id="delete-wizard-title" className="text-sm font-semibold text-zinc-100 tracking-tight">
                  Delete “{workspace.name}”?
                </h3>
                <p id="delete-wizard-desc" className="text-xs text-zinc-500 mt-1">
                  Step {step} of 3 — {steps[step - 1]}. This is irreversible.
                </p>
              </div>
            </div>

            {/* Stepper */}
            <ol className="flex items-center gap-1.5" aria-label="Deletion progress">
              {steps.map((label, i) => {
                const n = i + 1;
                const done = n < step;
                const current = n === step;
                return (
                  <li key={label} className="flex-1">
                    <div className={`h-1.5 rounded-full ${done ? 'bg-rose-500' : current ? 'bg-rose-400/70' : 'bg-zinc-800'}`} />
                    <p className={`text-[9px] font-mono uppercase tracking-widest mt-1 ${current ? 'text-rose-300' : done ? 'text-rose-400/70' : 'text-zinc-600'}`}>
                      {n}. {label}
                    </p>
                  </li>
                );
              })}
            </ol>

            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 flex items-center gap-2.5">
              <CrowIcon variant={workspace.icon} className="w-8 h-8 rounded-lg shrink-0" iconSize={65} />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-zinc-200 truncate">{workspace.name}</p>
                <p className="text-[10px] font-mono text-zinc-500 truncate">
                  {workspace.id} · {workspace.categoryCount} categories · {workspace.channelCount} channels
                </p>
              </div>
            </div>

            {step === 1 && (
              <div className="space-y-3">
                <ul className="text-xs text-zinc-400 space-y-1.5 leading-relaxed list-disc pl-4">
                  <li>Permanently deletes all categories, channels and message history in this workspace.</li>
                  <li>Removes the workspace sandbox directory and unmounts its agents.</li>
                  <li>This cannot be undone. Other workspaces are not affected.</li>
                </ul>
                <label className="flex items-start gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 cursor-pointer hover:border-zinc-700 transition">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={e => setAcknowledged(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-rose-500 cursor-pointer"
                  />
                  <span className="text-xs text-zinc-300 leading-relaxed">
                    I understand that deleting <span className="font-semibold text-zinc-100">“{workspace.name}”</span> is permanent
                    and removes its {workspace.channelCount} channel{workspace.channelCount === 1 ? '' : 's'}.
                  </span>
                </label>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-2">
                <p className="text-xs text-zinc-400 leading-relaxed">
                  To confirm you selected the right workspace, type its exact name below.
                </p>
                <p className="text-[11px] font-mono text-zinc-500">
                  Expected: <span className="text-zinc-200 select-all">{workspace.name}</span>
                </p>
                <input
                  type="text"
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  placeholder={workspace.name}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Type workspace name to confirm"
                  className="w-full bg-zinc-900 border border-zinc-800 focus:border-rose-500/60 focus:ring-2 focus:ring-rose-500/20 rounded-xl px-3 py-2.5 min-h-[44px] text-sm font-mono text-zinc-100 focus:outline-none placeholder-zinc-600"
                />
                {nameInput.length > 0 && !nameMatches && (
                  <p className="text-[11px] text-amber-400">Name does not match yet — check casing and spacing.</p>
                )}
                {nameMatches && <p className="text-[11px] text-emerald-400">Name matches. You may continue.</p>}
              </div>
            )}

            {step === 3 && (
              <div className="space-y-2">
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Final step. Type <span className="font-mono font-bold text-rose-300">DELETE</span> in capitals to arm the
                  delete button.
                </p>
                <input
                  type="text"
                  value={destroyInput}
                  onChange={e => setDestroyInput(e.target.value)}
                  placeholder="DELETE"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Type DELETE to confirm"
                  className="w-full bg-zinc-900 border border-zinc-800 focus:border-rose-500/60 focus:ring-2 focus:ring-rose-500/20 rounded-xl px-3 py-2.5 min-h-[44px] text-sm font-mono tracking-[0.2em] text-zinc-100 focus:outline-none placeholder-zinc-600"
                />
                {error && (
                  <p role="alert" className="text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
                    {error}
                  </p>
                )}
              </div>
            )}

            {step !== 3 && error && (
              <p role="alert" className="text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex items-center justify-between gap-2 pt-1 border-t border-zinc-900">
              <div>
                {step > 1 ? (
                  <button
                    onClick={() => setStep(s => Math.max(1, s - 1))}
                    disabled={isDeleting}
                    className="px-3 py-2 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    <ArrowLeft size={13} /> Back
                  </button>
                ) : (
                  <button
                    onClick={onCancel}
                    disabled={isDeleting}
                    className="px-3 py-2 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition cursor-pointer disabled:opacity-50"
                  >
                    Cancel
                  </button>
                )}
              </div>
              {step === 1 && (
                <button
                  onClick={() => acknowledged && setStep(2)}
                  disabled={!acknowledged}
                  className={`px-4 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 cursor-pointer ${acknowledged ? 'bg-rose-600/90 text-white hover:bg-rose-500' : 'bg-zinc-900 text-zinc-600 cursor-not-allowed'}`}
                >
                  Continue <ArrowRight size={13} />
                </button>
              )}
              {step === 2 && (
                <div className="flex items-center gap-2">
                  <button onClick={onCancel} disabled={isDeleting} className="px-3 py-2 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition cursor-pointer disabled:opacity-50">
                    Cancel
                  </button>
                  <button
                    onClick={() => nameMatches && setStep(3)}
                    disabled={!nameMatches}
                    className={`px-4 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 cursor-pointer ${nameMatches ? 'bg-rose-600/90 text-white hover:bg-rose-500' : 'bg-zinc-900 text-zinc-600 cursor-not-allowed'}`}
                  >
                    Continue <ArrowRight size={13} />
                  </button>
                </div>
              )}
              {step === 3 && (
                <div className="flex items-center gap-2">
                  <button onClick={onCancel} disabled={isDeleting} className="px-3 py-2 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition cursor-pointer disabled:opacity-50">
                    Cancel
                  </button>
                  <button
                    onClick={onConfirm}
                    disabled={!destroyMatches || isDeleting}
                    className={`px-4 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 cursor-pointer ${destroyMatches && !isDeleting ? 'bg-rose-600 text-white hover:bg-rose-500 shadow-[0_4px_16px_rgba(244,63,94,0.35)]' : 'bg-zinc-900 text-zinc-600 cursor-not-allowed'}`}
                  >
                    {isDeleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    {isDeleting ? 'Deleting…' : 'Delete forever'}
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
