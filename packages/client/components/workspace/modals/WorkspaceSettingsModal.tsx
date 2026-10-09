import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  X, Laptop, Users, Shield, ShieldAlert, Cpu, Hammer, Hash, FolderOpen, BarChart3,
  Trash2, Plus, ArrowRight, UserCheck, Play, ToggleLeft, ToggleRight, Radio,
  Layers, Brain, Wrench, Edit, Save, RotateCcw, FileCode, GripVertical, Check,
  Copy, Download, Upload, Coins, Lock, ScrollText, HardDrive
} from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { AgentLevel, AgentStatus } from '@/types/crowdOs';
import ModelCardsTab from '../settings/ModelCardsTab';
import { WorkspaceDatabaseField, initialDatabaseState, resolveDatabaseUrl } from '@/components/portal/WorkspaceManageDialogs';
import CrowIcon from '@/components/ui/CrowIcon';
import { useToast } from '@/components/ui/ToastProvider';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import AgentStudioModal from '@/components/studio/AgentStudioModal';
import ScreenLockSettingsPanel from '../ScreenLockSettingsPanel';
import AutostartToggle from '@/components/ui/AutostartToggle';
import { useOverlayFocus } from '@/components/ui/use-overlay-focus';
import MountsInspector from '../MountsInspector';
import DiagnosticsTab from '../settings/DiagnosticsTab';
import AuditTab from '../settings/AuditTab';
import StorageTab from '../settings/StorageTab';

const ROLE_PERMISSIONS = [
  { id: 'administrator', label: 'Administrator', description: 'Grants all permissions and bypasses channel restrictions.' },
  { id: 'view_channels', label: 'View Channels', description: 'Allows members to view channels by default.' },
  { id: 'manage_channels', label: 'Manage Channels', description: 'Allows members to create, edit, or delete channels.' },
  { id: 'manage_roles', label: 'Manage Roles', description: 'Allows members to create or edit roles lower than their highest role.' },
  { id: 'manage_agents', label: 'Manage Agents', description: 'Allows members to spawn, patch, and deprovision agents.' },
  { id: 'manage_skills', label: 'Manage Skills', description: 'Allows members to create and edit custom skills.' },
  { id: 'manage_tools', label: 'Manage Tools', description: 'Allows members to configure tool access and sandbox permissions.' },
  { id: 'send_messages', label: 'Send Messages', description: 'Allows members to send messages in channels.' },
  { id: 'read_history', label: 'Read Message History', description: 'Allows members to read previous messages.' },
  { id: 'mention_roles', label: 'Mention Everyone and Roles', description: 'Allows members to use @everyone or mention all roles.' }
];

const ROLE_COLORS = [
  '#99AAB5', '#1ABC9C', '#2ECC71', '#3498DB', '#9B59B6', '#E91E63', '#F1C40F', '#E67E22', 
  '#E74C3C', '#95A5A6', '#11806A', '#1F8B4C', '#206694', '#71368A', '#AD1457', '#C27C0E', 
  '#A84300', '#992D22', '#979C9F', '#546E7A', '#1D4E89', '#00B0FF', '#00E5FF', '#1DE9B6', 
  '#00E676', '#76FF03', '#C6FF00', '#FFEA00', '#FFC400', '#FF9100', '#FF3D00', '#F50057'
];

function StorageSyncSection(props: {
  activeWS: any;
  dbSyncStatus: any;
  isSyncing: boolean;
  workspaceError: string | null;
  fetchDbSync: (id?: string) => Promise<void>;
  setStoragePreference: (id: string, p: 'default' | 'local') => Promise<void>;
  updateWorkspace: (id: string, patch: { databaseUrl?: string | null }) => Promise<void>;
  resolveDbConflict: (id: string, c: 'flush-local' | 'flush-db' | 'change-db') => Promise<any>;
  syncNow: (id: string) => Promise<any>;
  rebuildRag: (id: string) => Promise<any>;
  showInfo: (t: string, d?: string) => void;
  showSuccess: (t: string, d?: string) => void;
  showError: (t: string, d?: string) => void;
  askConfirmation: (o: { title: string; description: string; confirmLabel?: string; isDanger?: boolean; onConfirm: () => void }) => void;
}) {
  const {
    activeWS, dbSyncStatus, isSyncing, workspaceError, fetchDbSync,
    setStoragePreference, updateWorkspace, resolveDbConflict, syncNow, rebuildRag,
    showInfo, showSuccess, showError, askConfirmation,
  } = props;
  const [dbState, setDbState] = React.useState(initialDatabaseState());
  const notifiedBacklogRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (activeWS?.id) void fetchDbSync(activeWS.id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWS?.id]);

  React.useEffect(() => {
    if (dbSyncStatus?.backlogNotice && dbSyncStatus.backlog > 0 && activeWS?.id) {
      const key = `${activeWS.id}:${dbSyncStatus.backlog}`;
      if (notifiedBacklogRef.current !== key) {
        notifiedBacklogRef.current = key;
        showInfo(
          `Sync backlog: ${dbSyncStatus.backlog} local writes pending upload`,
          'They will backfill automatically when the database is reachable. Nothing is blocked.',
        );
      }
    }
  }, [dbSyncStatus?.backlog, dbSyncStatus?.backlogNotice, activeWS?.id, showInfo]);

  React.useEffect(() => {
    setDbState(initialDatabaseState());
  }, [activeWS?.id]);

  if (!activeWS) return null;
  const dbConfigured = !!activeWS?.database?.configured;
  const pendingDbUrl = resolveDatabaseUrl(dbState);
  const preference = (activeWS?.storagePreference === 'local' ? 'local' : 'default') as 'default' | 'local';
  const syncState = dbSyncStatus?.dbSync?.state ?? activeWS?.dbSync?.state ?? null;
  const backlog = dbSyncStatus?.backlog ?? 0;
  const tier = dbSyncStatus?.tier ?? (dbConfigured ? 'dual' : 'local');

  const runQuiet = async (fn: () => Promise<any>, okMsg: string) => {
    try {
      const res = await fn();
      if (res && res.ok === false) {
        showError('Sync action deferred', res?.reason ? String(res.reason) : res?.detail ? String(res.detail) : okMsg);
        return;
      }
      showSuccess(okMsg, res?.detail ? String(res.detail) : undefined);
    } catch (err: any) {
      showError('Sync action failed', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-3 bg-zinc-950 p-4 border border-zinc-900 rounded-lg text-left">
      <h4 className="font-semibold text-zinc-300 text-xs">Storage &amp; Sync</h4>

      {workspaceError && (
        <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
          {String(workspaceError)}
        </div>
      )}

      <div className="space-y-2 rounded-lg border border-zinc-900 bg-zinc-900/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-zinc-400 font-semibold text-[12px]">Database Connection</span>
          {dbConfigured ? (
            <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-300/90">
              <span className="w-1 h-1 rounded-full bg-emerald-400" />
              {activeWS?.database?.host ?? 'Connected'}{activeWS?.database?.database ? `/${activeWS.database.database}` : ''}
            </span>
          ) : (
            <span className="text-[10px] font-mono text-zinc-600">Not connected</span>
          )}
        </div>
        <WorkspaceDatabaseField initial={activeWS?.database ?? null} state={dbState} onChange={setDbState} />
        {pendingDbUrl !== undefined && (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={isSyncing}
              onClick={() => setDbState(initialDatabaseState())}
              className="px-2.5 py-1.5 min-h-[36px] rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-semibold text-zinc-300 hover:bg-zinc-800 transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isSyncing}
              onClick={() => void runQuiet(async () => {
                await updateWorkspace(activeWS.id, { databaseUrl: pendingDbUrl });
                setDbState(initialDatabaseState());
                await fetchDbSync(activeWS.id).catch(() => {});
              }, pendingDbUrl === null ? 'Database disconnected' : 'Database connected')}
              className="px-2.5 py-1.5 min-h-[36px] rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-[12px] font-semibold transition cursor-pointer"
            >
              {pendingDbUrl === null ? 'Disconnect & Save' : 'Connect & Save'}
            </button>
          </div>
        )}
      </div>

      {!dbConfigured && (
        <p className="text-zinc-500 leading-normal font-sans">
            Local files only, no database connected. Chat, channels, and files work fully offline.
          Connect a Postgres database above to enable dual-boot sync and semantic memory.
        </p>
      )}

      {dbConfigured && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-zinc-500 font-semibold">Storage mode:</span>
            <button
              type="button"
              disabled={isSyncing}
              onClick={() => void runQuiet(() => setStoragePreference(activeWS.id, 'default'), 'Dual-write enabled (database first-class)')}
              className={`px-2.5 py-1.5 min-h-[36px] rounded-lg border text-[12px] font-semibold transition cursor-pointer ${preference === 'default' ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-200' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
            >
              Default (sync Local + DB)
            </button>
            <button
              type="button"
              disabled={isSyncing}
              onClick={() => void runQuiet(() => setStoragePreference(activeWS.id, 'local'), 'Local-first enabled (database writes paused)')}
              className={`px-2.5 py-1.5 min-h-[36px] rounded-lg border text-[12px] font-semibold transition cursor-pointer ${preference === 'local' ? 'bg-amber-500/15 border-amber-500/40 text-amber-200' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
            >
              Local-first
            </button>
          </div>
          <p className="text-zinc-500 leading-normal font-sans">
            Serving from: <span className="text-zinc-300 font-semibold">{tier === 'dual' ? 'Database + local mirror' : 'Local files'}</span>
            {dbSyncStatus && !dbSyncStatus.dbReachable && dbConfigured && (
              <span className="text-amber-300"> (database unreachable, local fallback active)</span>
            )}
          </p>
        </div>
      )}

      {syncState === 'conflict' && (
        <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 space-y-2">
          <p className="text-[12px] text-rose-200 font-semibold">Database conflict. Serving local files only until you choose.</p>
          <p className="text-zinc-400 leading-normal font-sans">The connected database holds a different workspace. Pick how to resolve (a snapshot of local files is taken first):</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isSyncing}
              onClick={() => askConfirmation({
                title: 'Pull from database?',
                description: 'Replace local files with the database content. A snapshot backup is kept automatically.',
                confirmLabel: 'Flush local (pull)',
                onConfirm: () => void runQuiet(() => resolveDbConflict(activeWS.id, 'flush-local'), 'Local state replaced from database'),
              })}
              className="px-2.5 py-1.5 min-h-[36px] rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-semibold text-zinc-200 hover:bg-zinc-800 transition cursor-pointer"
            >
              Flush local (pull)
            </button>
            <button
              type="button"
              disabled={isSyncing}
              onClick={() => askConfirmation({
                title: 'Push to database?',
                description: 'Overwrite database rows with local files (union-merged, local wins). A snapshot backup is kept automatically.',
                confirmLabel: 'Flush DB (push)',
                onConfirm: () => void runQuiet(() => resolveDbConflict(activeWS.id, 'flush-db'), 'Database updated from local files'),
              })}
              className="px-2.5 py-1.5 min-h-[36px] rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-semibold text-zinc-200 hover:bg-zinc-800 transition cursor-pointer"
            >
              Flush DB (push)
            </button>
            <button
              type="button"
              disabled={isSyncing}
              onClick={() => void runQuiet(() => resolveDbConflict(activeWS.id, 'change-db'), 'Database disconnected')}
              className="px-2.5 py-1.5 min-h-[36px] rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-semibold text-zinc-200 hover:bg-zinc-800 transition cursor-pointer"
            >
              Change DB
            </button>
          </div>
        </div>
      )}

      {dbConfigured && backlog > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 flex items-center justify-between gap-2">
          <span className="text-[12px] text-amber-200">Sync backlog: {backlog} local write{backlog === 1 ? '' : 's'} pending upload. Nothing is blocked.</span>
          <button
            type="button"
            disabled={isSyncing}
            onClick={() => void runQuiet(() => syncNow(activeWS.id), 'Backfill drained')}
            className="px-2.5 py-1.5 min-h-[36px] rounded-lg border border-amber-500/40 bg-amber-500/10 text-[12px] font-semibold text-amber-100 hover:bg-amber-500/20 transition cursor-pointer shrink-0"
          >
            Sync now
          </button>
        </div>
      )}

      {dbConfigured && syncState !== 'conflict' && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={isSyncing}
            onClick={() => void runQuiet(() => syncNow(activeWS.id), 'Backfill drained')}
            className="px-2.5 py-1.5 min-h-[36px] rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-semibold text-zinc-200 hover:bg-zinc-800 transition cursor-pointer"
          >
            Sync now
          </button>
          <button
            type="button"
            disabled={isSyncing}
            onClick={() => askConfirmation({
              title: 'Rebuild search index?',
              description: 'Re-index channel content for semantic search. Memories stay deferred; nothing is deleted.',
              confirmLabel: 'Rebuild index',
              onConfirm: () => void runQuiet(() => rebuildRag(activeWS.id), 'Search index rebuilt'),
            })}
            className="px-2.5 py-1.5 min-h-[36px] rounded-lg border border-zinc-700 bg-zinc-900 text-[12px] font-semibold text-zinc-200 hover:bg-zinc-800 transition cursor-pointer"
          >
            Rebuild search index
          </button>
        </div>
      )}
    </div>
  );
}

export default function WorkspaceSettingsModal() {
  const { 
    workspaces, 
    activeWorkspaceId, 
    settingsModalOpen, 
    setSettingsModalOpen,
    workspaceSettingsTab,
    setWorkspaceSettingsTab,
    deleteWorkspace,
    agents,
    addAgent,
    deleteAgent,
    roles,
    addRole,
    deleteRole,
    tools,
    toggleToolEnabled,
    instructionModules,
    modelModules,
    toolkitModules,
    addInstructionModule,
    updateInstructionModule,
    deleteInstructionModule,
    addToolkitModule,
    updateToolkitModule,
    deleteToolkitModule,
    updateAgent,
    constraintsModules,
    capabilitiesModules,
    deleteCategory,
    createCategory,
    createChannel,
    deleteChannel,
    archiveChannel,
    reorderCategory,
    reorderChannel,
    archivedChannels,
    globalSoftCap,
    perProviderBudget,
    totalTokensConsumed,
    fetchBudget,
    updateBudget,
    resetBudget,
    dbSyncStatus,
    isSyncing,
    fetchDbSync,
    setStoragePreference,
    updateWorkspace,
    resolveDbConflict,
    syncNow,
    rebuildRag,
    workspaceError
  } = useCrowdOSStore();

  const { showSuccess, showError, showInfo } = useToast();
  const [studioAgentId, setStudioAgentId] = useState<string | null>(null);
  const activeWS = workspaces.find(ws => ws.id === activeWorkspaceId);
  const dialogRef = React.useRef<HTMLDivElement>(null);

  useOverlayFocus(settingsModalOpen && !!activeWS, dialogRef, {
    fallbackFocusSelector: '[aria-label="Open workspace menu"], [aria-label="Open settings"]',
  });

  // Styled Confirm Modal State
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    isDanger?: boolean;
    onConfirm: () => void;
    onCancel?: () => void;
  }>({
    open: false,
    title: '',
    description: '',
    onConfirm: () => {}
  });

  const askConfirmation = (opts: {
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    isDanger?: boolean;
    onConfirm: () => void;
    onCancel?: () => void;
  }) => {
    setConfirmModal({
      open: true,
      title: opts.title,
      description: opts.description,
      confirmLabel: opts.confirmLabel || 'Confirm',
      cancelLabel: opts.cancelLabel,
      isDanger: opts.isDanger !== false,
      onConfirm: () => {
        opts.onConfirm();
        setConfirmModal(prev => ({ ...prev, open: false }));
      },
      onCancel: opts.onCancel,
    });
  };

  // Skills Manager state handles
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [skillFormName, setSkillFormName] = useState('');
  const [skillFormDesc, setSkillFormDesc] = useState('');
  const [skillFormPrompt, setSkillFormPrompt] = useState('');
  const [skillFormSandboxPath, setSkillFormSandboxPath] = useState('');
  const [skillFormModelProfileId, setSkillFormModelProfileId] = useState('');
  const [isCreatingSkill, setIsCreatingSkill] = useState(false);

  // Tools Manager state handles
  const [editingToolModuleId, setEditingToolModuleId] = useState<string | null>(null);
  const [toolFormName, setToolFormName] = useState('');
  const [toolFormDesc, setToolFormDesc] = useState('');
  const [toolFormCapabilities, setToolFormCapabilities] = useState<string[]>([]);
  const [toolFormSchema, setToolFormSchema] = useState('');
  const [isCreatingToolModule, setIsCreatingToolModule] = useState(false);

  // Budget settings local states
  const [editedGlobalSoftCap, setEditedGlobalSoftCap] = useState<string>('');
  const [isSavingBudget, setIsSavingBudget] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string>('google');
  const [provSoftCapInput, setProvSoftCapInput] = useState<string>('500000');
  const [provResetPeriodInput, setProvResetPeriodInput] = useState<'daily' | 'weekly' | 'monthly' | 'never'>('monthly');

  // Agent Presets: name/species/level/description only. Module bindings are
  // deliberately blank — the live catalogs decide what exists, and the
  // create path leaves blank modules unassigned for the server to resolve.
  // Presets that hardcoded seed ids (mod-inst-l1, mod-model-heavy, …)
  // bound profiles a workspace may not have.
  const PRESETS = [
    {
      id: 'ceo',
      label: '📋 Generic CEO (L1 Admin)',
      name: 'CEO_Falcon',
      species: 'Falcon',
      level: 1,
      description: 'Systems coordinator, pipeline executive monitor, and compliance auditor.',
      instructionModuleId: '',
      modelModuleId: '',
      toolkitModuleId: '',
      isOmniscient: true
    },
    {
      id: 'manager',
      label: '📋 Generic Manager (L2 Coordinator)',
      name: 'Manager_Owl',
      species: 'Owl',
      level: 2,
      description: 'Orchestrates autonomic work units, evaluates deliverables, and structures sub-agents.',
      instructionModuleId: '',
      modelModuleId: '',
      toolkitModuleId: '',
      isOmniscient: false
    },
    {
      id: 'coder',
      label: '📋 Generic Coder (L3 Worker)',
      name: 'Coder_Sparrow',
      species: 'Sparrow',
      level: 3,
      description: 'Standard software development autonomic worker unit rendering clean frontend UI/UX components.',
      instructionModuleId: '',
      modelModuleId: '',
      toolkitModuleId: '',
      isOmniscient: false
    },
    {
      id: 'qa',
      label: '📋 Generic QA (L3 Supervisor)',
      name: 'QA_Pigeon',
      species: 'Pigeon',
      level: 3,
      description: 'Validates code execution deliverables, measures latency, and tests compliance criteria.',
      instructionModuleId: '',
      modelModuleId: '',
      toolkitModuleId: '',
      isOmniscient: false
    },
    {
      id: 'writer',
      label: '📋 Generic Writer (L3 Worker)',
      name: 'Writer_Raven',
      species: 'Raven',
      level: 3,
      description: 'Composes high-altitude strategic summaries, updates progress logs, and outputs markdown.',
      instructionModuleId: '',
      modelModuleId: '',
      toolkitModuleId: '',
      isOmniscient: false
    }
  ];

  // Agent Creation form fields
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentSpecies, setNewAgentSpecies] = useState('Raven');
  const [newAgentLevel, setNewAgentLevel] = useState<AgentLevel>(3);
  const [newAgentParentId, setNewAgentParentId] = useState('');
  const [newAgentDesc, setNewAgentDesc] = useState('');
  const [newAgentInstructionModuleId, setNewAgentInstructionModuleId] = useState('');
  const [newAgentModelModuleId, setNewAgentModelModuleId] = useState('');
  const [newAgentToolkitModuleId, setNewAgentToolkitModuleId] = useState('');
  const [newAgentConstraintsModuleId, setNewAgentConstraintsModuleId] = useState('');
  const [newAgentCapabilitiesModuleId, setNewAgentCapabilitiesModuleId] = useState('');
  const [newAgentIsOmniscient, setNewAgentIsOmniscient] = useState(false);
  const [newAgentRoleId, setNewAgentRoleId] = useState('');
  const [agentFormOpen, setAgentFormOpen] = useState(false);

  // Agent Edit form fields
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [editAgentName, setEditAgentName] = useState('');
  const [editAgentSpecies, setEditAgentSpecies] = useState('Raven');
  const [editAgentLevel, setEditAgentLevel] = useState<AgentLevel>(2);
  const [editAgentDesc, setEditAgentDesc] = useState('');
  const [editAgentInstructionModuleId, setEditAgentInstructionModuleId] = useState('');
  const [editAgentInstructionPrompt, setEditAgentInstructionPrompt] = useState('');
  const [editAgentModelModuleId, setEditAgentModelModuleId] = useState('');
  const [editAgentToolkitModuleId, setEditAgentToolkitModuleId] = useState('');
  const [editAgentConstraintsModuleId, setEditAgentConstraintsModuleId] = useState('');
  const [editAgentCapabilitiesModuleId, setEditAgentCapabilitiesModuleId] = useState('');
  const [editAgentRoleId, setEditAgentRoleId] = useState('');
  const [editAgentIsOmniscient, setEditAgentIsOmniscient] = useState(false);

  // Roles Management state
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [draggedRoleId, setDraggedRoleId] = useState<string | null>(null);
  
  // Update the crowdOS store with reorder functionality
  const { reorderRoles, updateRole } = useCrowdOSStore.getState();

  const handleCreateRole = () => {
    addRole({
      name: 'New Role',
      color: ROLE_COLORS[0],
      permissions: ['read_history', 'send_messages']
    });
  };

  const selectedRole = roles.find(r => r.id === selectedRoleId);

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedRoleId(id);
    e.dataTransfer.effectAllowed = 'move';
    // Small delay to allow the drag image to be generated before styling the original element
    setTimeout(() => {
      const el = document.getElementById(`role-${id}`);
      if (el) el.style.opacity = '0.5';
    }, 0);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedRoleId || draggedRoleId === targetId) {
      if (draggedRoleId) {
        const el = document.getElementById(`role-${draggedRoleId}`);
        if (el) el.style.opacity = '1';
      }
      setDraggedRoleId(null);
      return;
    }

    const draggedIndex = roles.findIndex(r => r.id === draggedRoleId);
    const targetIndex = roles.findIndex(r => r.id === targetId);
    
    if (draggedIndex !== -1 && targetIndex !== -1) {
      reorderRoles(draggedIndex, targetIndex);
    }

    const el = document.getElementById(`role-${draggedRoleId}`);
    if (el) el.style.opacity = '1';
    setDraggedRoleId(null);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    if (draggedRoleId) {
      const el = document.getElementById(`role-${draggedRoleId}`);
      if (el) el.style.opacity = '1';
    }
    setDraggedRoleId(null);
  };

  const togglePermission = (permissionId: string) => {
    if (!selectedRole) return;
    const hasPerm = selectedRole.permissions.includes(permissionId);
    const newPerms = hasPerm 
      ? selectedRole.permissions.filter(p => p !== permissionId)
      : [...selectedRole.permissions, permissionId];
    updateRole(selectedRole.id, { permissions: newPerms });
  };
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelDesc, setNewChannelDesc] = useState('');
  const [newChannelCategory, setNewChannelCategory] = useState('');

  // Category Creation
  const [newCategoryName, setNewCategoryName] = useState('');

  // Validation derived state
  const trimmedCategoryName = newCategoryName.trim();
  const isCategoryTooShort = trimmedCategoryName.length > 0 && trimmedCategoryName.length < 2;
  const isCategoryTooLong = trimmedCategoryName.length > 40;
  const isCategoryDuplicate = !!trimmedCategoryName && !!activeWS && activeWS.categories.some(c => c.name.toLowerCase() === trimmedCategoryName.toLowerCase());

  const formattedNewChannelName = newChannelName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
  const isChannelEmpty = !formattedNewChannelName;
  const isChannelTooShort = formattedNewChannelName.length > 0 && formattedNewChannelName.length < 2;
  const isChannelTooLong = formattedNewChannelName.length > 40;
  const isChannelDuplicate = !!formattedNewChannelName && !!activeWS && (
    (activeWS.channels || []).some(c => c.name.toLowerCase() === formattedNewChannelName) ||
    activeWS.categories.some(cat => cat.channels.some(c => c.name.toLowerCase() === formattedNewChannelName))
  );
  const isChannelCategoryMissing = !newChannelCategory;

  React.useEffect(() => {
    if (!settingsModalOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsModalOpen(false);
    };
    window.addEventListener('keydown', onEsc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onEsc);
      document.body.style.overflow = prev;
    };
  }, [settingsModalOpen, setSettingsModalOpen]);

  // Local safety option toggles (display-only preferences: nothing behind
  // them enforces server-side, so the copy must say so — a silent checkbox
  // would imply enforcement that does not exist).
  const [humanApproval, setHumanApproval] = useState(true);
  const [rateLimit, setRateLimit] = useState(true);
  const [emergencyKill, setEmergencyKill] = useState(false);

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAgentName.trim()) return;

    const sanitizedName = newAgentName.replace(/[^A-Za-z0-9_-]/g, '');
    if (!sanitizedName) {
      showError('Validation Error', 'Name must contain letters, numbers, hyphens, or underscores.');
      return;
    }

    try {
      await addAgent({
        name: sanitizedName,
        species: newAgentSpecies,
        level: newAgentLevel,
        status: 'idle',
        avatar: newAgentLevel === 0 ? '🦅' : newAgentLevel === 1 ? '🐦' : newAgentLevel === 2 ? '🦉' : '🤖',
        parentId: newAgentParentId || undefined,
        description: newAgentDesc,
        instructionModuleId: newAgentInstructionModuleId || undefined,
        modelModuleId: newAgentModelModuleId || undefined,
        toolkitModuleId: newAgentToolkitModuleId || undefined,
        constraintsModuleId: newAgentConstraintsModuleId || undefined,
        capabilitiesModuleId: newAgentCapabilitiesModuleId || undefined,
        roleId: newAgentRoleId || undefined,
        isOmniscient: newAgentIsOmniscient
      });

      setNewAgentName('');
      setNewAgentSpecies('Raven');
      setNewAgentLevel(3);
      setNewAgentParentId('');
      setNewAgentDesc('');
      setNewAgentInstructionModuleId('');
      setNewAgentModelModuleId('');
      setNewAgentToolkitModuleId('');
      setNewAgentConstraintsModuleId('');
      setNewAgentCapabilitiesModuleId('');
      setNewAgentIsOmniscient(false);
      setNewAgentRoleId('');
      setAgentFormOpen(false);
    } catch (err) {
      showError('Agent Creation Failed', err instanceof Error ? err.message : 'Failed to create agent.');
    }
  };

  const startEditingAgent = (agent: any) => {
    setEditingAgentId(agent.id);
    setEditAgentName(agent.name);
    setEditAgentSpecies(agent.species || 'Crow'); 
    setEditAgentLevel(agent.level);
    setEditAgentDesc(agent.description || '');
    setEditAgentInstructionModuleId(agent.instructionModuleId || '');
    setEditAgentModelModuleId(agent.modelModuleId || '');
    setEditAgentToolkitModuleId(agent.toolkitModuleId || '');
    setEditAgentConstraintsModuleId(agent.constraintsModuleId || '');
    setEditAgentCapabilitiesModuleId(agent.capabilitiesModuleId || '');
    setEditAgentRoleId(agent.roleId || '');
    setEditAgentIsOmniscient(agent.isOmniscient || false);

    const selectedModule = instructionModules.find(m => m.id === agent.instructionModuleId);
    setEditAgentInstructionPrompt(selectedModule?.systemPrompt || '');
  };

  const handleSaveAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAgentId) return;

    const sanitizedName = editAgentName.replace(/[^A-Za-z0-9_-]/g, '');
    if (!sanitizedName) {
      showError('Validation Error', 'Name must contain letters, numbers, hyphens, or underscores.');
      return;
    }
    
    try {
      if (editAgentInstructionModuleId) {
        const currentModule = instructionModules.find(m => m.id === editAgentInstructionModuleId);
        if (currentModule) {
          await updateInstructionModule(editAgentInstructionModuleId, {
            name: currentModule.name,
            systemPrompt: editAgentInstructionPrompt
          });
        }
      }

      await updateAgent(editingAgentId, {
        name: sanitizedName,
        species: editAgentSpecies,
        level: editAgentLevel,
        description: editAgentDesc,
        instructionModuleId: editAgentInstructionModuleId || undefined,
        modelModuleId: editAgentModelModuleId || undefined,
        toolkitModuleId: editAgentToolkitModuleId || undefined,
        constraintsModuleId: editAgentConstraintsModuleId || undefined,
        capabilitiesModuleId: editAgentCapabilitiesModuleId || undefined,
        roleId: editAgentRoleId || undefined,
        avatar: editAgentLevel === 0 ? '🦅' : editAgentLevel === 1 ? '🐦' : editAgentLevel === 2 ? '🦉' : '🤖',
        isOmniscient: editAgentIsOmniscient,
      });
      setEditingAgentId(null);
    } catch (err) {
      showError('Update Failed', err instanceof Error ? err.message : 'Failed to update agent.');
    }
  };

  const handleDuplicateAgent = async (agent: any) => {
    const targetName = `copy_of_${agent.name}`.slice(0, 30);
    const sanitizedName = targetName.replace(/[^A-Za-z0-9_-]/g, '');
    
    try {
      await addAgent({
        name: sanitizedName,
        species: agent.species,
        level: agent.level,
        status: 'idle',
        avatar: agent.avatar,
        parentId: agent.parentId || undefined,
        description: agent.description,
        instructionModuleId: agent.instructionModuleId,
        modelModuleId: agent.modelModuleId,
        toolkitModuleId: agent.toolkitModuleId,
        roleId: agent.roleId
      });
    } catch (err) {
      showError('Duplication Failed', err instanceof Error ? err.message : 'Failed to duplicate agent.');
    }
  };

  const handleExportAgent = (agent: any) => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({
      name: agent.name,
      species: agent.species,
      level: agent.level,
      description: agent.description,
      instructionModuleId: agent.instructionModuleId,
      modelModuleId: agent.modelModuleId,
      toolkitModuleId: agent.toolkitModuleId,
      roleId: agent.roleId
    }, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `${agent.name}_config.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleImportAgent = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileReader = new FileReader();
    if (e.target.files && e.target.files[0]) {
      fileReader.readAsText(e.target.files[0], "UTF-8");
      fileReader.onload = (event) => {
        try {
          const parsed = JSON.parse(event.target?.result as string);
          if (!parsed.name) {
            showError('Invalid Config', 'Missing "name" field in JSON configuration.');
            return;
          }
          setNewAgentName(parsed.name.replace(/[^A-Za-z0-9_-]/g, ''));
          setNewAgentSpecies(parsed.species || 'Raven');
          setNewAgentLevel(parsed.level !== undefined ? parsed.level : 3);
          setNewAgentDesc(parsed.description || '');
          setNewAgentInstructionModuleId(parsed.instructionModuleId || '');
          setNewAgentModelModuleId(parsed.modelModuleId || '');
          setNewAgentToolkitModuleId(parsed.toolkitModuleId || '');
          setNewAgentRoleId(parsed.roleId || '');
          setAgentFormOpen(true);
        } catch {
          showError('Import Error', 'Failed to parse JSON configuration file.');
        }
      };
    }
  };



  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelName.trim() || !formattedNewChannelName || isChannelDuplicate || isChannelTooShort || isChannelTooLong) {
      if (!formattedNewChannelName) showError('Channel Error', 'Channel name must contain at least one letter or number.');
      else if (isChannelDuplicate) showError('Channel Error', `Channel #${formattedNewChannelName} already exists.`);
      else if (isChannelTooShort) showError('Channel Error', 'Channel name must be at least 2 characters.');
      else if (isChannelTooLong) showError('Channel Error', 'Channel name must be 40 characters or fewer.');
      return;
    }
    if (isChannelCategoryMissing) {
      showError('Channel Error', 'Select a target category.');
      return;
    }
    try {
      await createChannel(newChannelCategory || null, formattedNewChannelName, newChannelDesc);
      setNewChannelName('');
      setNewChannelDesc('');
    } catch (err) {
      showError('Channel Error', err instanceof Error ? err.message : 'Failed to create channel.');
    }
  };

  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = newCategoryName.trim();
    if (!t || isCategoryDuplicate || isCategoryTooShort || isCategoryTooLong) {
      if (!t) return;
      if (isCategoryDuplicate) showError('Category Error', `Category "${t}" already exists.`);
      else if (isCategoryTooShort) showError('Category Error', 'Category name must be at least 2 characters.');
      else if (isCategoryTooLong) showError('Category Error', 'Category name must be 40 characters or fewer.');
      return;
    }
    try {
      await createCategory(t);
      setNewCategoryName('');
    } catch (err) {
      showError('Category Error', err instanceof Error ? err.message : 'Failed to create category.');
    }
  };

  const runCrudAction = async (action: () => Promise<void>, fallbackMessage: string) => {
    try {
      await action();
    } catch (err) {
      showError('Action Failed', err instanceof Error ? err.message : fallbackMessage);
    }
  };

  // Skill Manager Handler helpers
  const startEditingSkill = (skill: any) => {
    setEditingSkillId(skill.id);
    setSkillFormName(skill.name);
    setSkillFormDesc(skill.description || '');
    setSkillFormPrompt(skill.systemPrompt);
    setSkillFormSandboxPath(skill.sandboxPath || `/src/skills/${skill.name.toLowerCase().replace(/\s+/g, '-')}.md`);
      // Keep a genuinely-unset model unset: falling back to a hardcoded id
      // would bind a profile this workspace may not have.
      setSkillFormModelProfileId(skill.modelProfileId || '');
  };

  const handleSaveSkill = async (id: string) => {
    try {
      await updateInstructionModule(id, {
        name: skillFormName,
        description: skillFormDesc,
        systemPrompt: skillFormPrompt,
        sandboxPath: skillFormSandboxPath,
        modelProfileId: skillFormModelProfileId
      });
      setEditingSkillId(null);
    } catch (err) {
      showError('Skill Error', err instanceof Error ? err.message : 'Failed to update skill.');
    }
  };

  const handleCreateSkillSubmit = async () => {
    if (!skillFormName.trim() || !skillFormPrompt.trim()) return;
    try {
      await addInstructionModule({
        name: skillFormName,
        description: skillFormDesc,
        systemPrompt: skillFormPrompt,
        sandboxPath: skillFormSandboxPath || `/src/skills/${skillFormName.toLowerCase().replace(/\s+/g, '-')}.md`,
        modelProfileId: skillFormModelProfileId || undefined,
        persona: 'Expert Consultant',
        rules: []
      });
      setIsCreatingSkill(false);
      // Reset forms
      setSkillFormName('');
      setSkillFormDesc('');
      setSkillFormPrompt('');
      setSkillFormSandboxPath('');
      setSkillFormModelProfileId('');
    } catch (err) {
      showError('Skill Error', err instanceof Error ? err.message : 'Failed to create skill.');
    }
  };

  // Tool Manager Handler helpers
  const startEditingToolModule = (toolMod: any) => {
    setEditingToolModuleId(toolMod.id);
    setToolFormName(toolMod.name);
    setToolFormDesc(toolMod.description || '');
    setToolFormCapabilities(toolMod.enabledToolIds || []);
    setToolFormSchema(JSON.stringify(toolMod.sandboxConfig || {}, null, 2));
  };

  const handleSaveToolModule = async (id: string) => {
    let parsedConfig = {};
    try {
      parsedConfig = JSON.parse(toolFormSchema);
    } catch (err) {
      showError('Syntax Error', 'Invalid JSON schema syntax. Please verify function declarations.');
      return;
    }
    try {
      await updateToolkitModule(id, {
        name: toolFormName,
        description: toolFormDesc,
        enabledToolIds: toolFormCapabilities,
        sandboxConfig: parsedConfig
      });
      setEditingToolModuleId(null);
    } catch (err) {
      showError('Toolkit Error', err instanceof Error ? err.message : 'Failed to update toolkit.');
    }
  };

  const handleCreateToolModuleSubmit = async () => {
    if (!toolFormName.trim()) return;
    let parsedConfig = {};
    if (toolFormSchema.trim()) {
      try {
        parsedConfig = JSON.parse(toolFormSchema);
      } catch (err) {
        showError('Syntax Error', 'Invalid JSON schema syntax. Please verify function declarations.');
        return;
      }
    }
    try {
      await addToolkitModule({
        name: toolFormName,
        description: toolFormDesc,
        enabledToolIds: toolFormCapabilities,
        sandboxConfig: parsedConfig
      });
      setIsCreatingToolModule(false);
      // Reset fields
      setToolFormName('');
      setToolFormDesc('');
      setToolFormCapabilities([]);
      setToolFormSchema('');
    } catch (err) {
      showError('Failed to create toolkit', err instanceof Error ? err.message : 'Failed to create toolkit.');
    }
  };

  const tabs = [
    { id: 'overview', label: 'Workspace', icon: Laptop },
    { id: 'agents', label: 'Agents Board', icon: Users },
    { id: 'roles', label: 'Permissions & Roles', icon: Shield },
    { id: 'tools', label: 'Security Tools Whitelist', icon: Hammer },
    { id: 'model_cards', label: 'Model Modules', icon: Cpu },
    { id: 'skills_manager', label: 'Skills Manager', icon: Brain },
    { id: 'channels', label: 'Category & Channels', icon: Hash },
    { id: 'mounts', label: 'Mounts', icon: FolderOpen },
    { id: 'storage', label: 'Storage', icon: HardDrive },
    { id: 'diagnostics', label: 'Diagnostics', icon: BarChart3 },
    { id: 'audit', label: 'Audit', icon: ScrollText },
    { id: 'safety', label: 'Safety Policies', icon: ShieldAlert },
    { id: 'screen_lock', label: 'Screen Lock', icon: Lock }
  ];

  return (
    <>
      <AnimatePresence>
        {settingsModalOpen && activeWS && (
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Workspace Settings" className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-10 select-none" id="workspace-settings-modal">
          {/* Black Translucent Backdrop */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSettingsModalOpen(false)}
            className="absolute inset-0 bg-black/80 backdrop-blur-xs transition-opacity" 
          />

          {/* Primary Board View */}
          <motion.div 
            initial={{ opacity: 0, scale: 0.96, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 15 }}
            transition={{ type: "spring", duration: 0.4, bounce: 0.15 }}
            className="relative w-full max-w-4xl bg-[#0c0c0e] border border-zinc-900 rounded-xl overflow-hidden shadow-2xl flex flex-col md:flex-row h-[85vh] md:h-[75vh] max-h-[85vh]"
          >
        
        {/* Left Hand Navigation side panel */}
        <div className="w-full md:w-[200px] bg-[#09090b] border-r border-zinc-900 shrink-0 flex flex-col pt-3 py-2 scrollbar-none border-b md:border-b-0">
          <div className="px-4 pb-2 text-[13px] font-medium text-zinc-400 flex items-center gap-1.5 select-none">
            <Shield size={10} />
            <span>Admin Console</span>
          </div>

          <div className="flex-1 overflow-y-auto px-2 space-y-1">
            {tabs.map(tab => {
              const Icon = tab.icon;
              const active = workspaceSettingsTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setWorkspaceSettingsTab(tab.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-sans tracking-tight text-left rounded-md transition select-none cursor-pointer focus:outline-none ${
                    active 
                      ? 'bg-zinc-800 text-zinc-100 font-medium' 
                      : 'text-zinc-400 hover:bg-zinc-900/40 hover:text-zinc-200'
                  }`}
                >
                  <Icon size={13.5} className={active ? 'text-indigo-400' : 'text-zinc-600'} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          <div className="border-t border-zinc-950 p-2 select-none">
            <button
              onClick={() => {
                askConfirmation({
                  title: 'Delete this workspace?',
                  description: 'This removes the workspace from this device. Channel history, agent roster, and local settings for this workspace are removed. This cannot be undone.',
                  confirmLabel: 'Delete Workspace',
                  cancelLabel: 'Keep workspace',
                  isDanger: true,
                  onConfirm: () => {
                    const workspaceId = activeWS.id;
                    const workspaceName = activeWS.name;
                    askConfirmation({
                      title: 'Also reset the database tables?',
                      description: 'Flushing clears the synced database tables so the workspace id can be reused cleanly. Keeping leaves the database tables intact.',
                      confirmLabel: 'Flush tables',
                      cancelLabel: 'Keep DB intact',
                      isDanger: true,
                      onConfirm: () => {
                        void deleteWorkspace(workspaceId, { flush: true });
                        setSettingsModalOpen(false);
                        showSuccess('Workspace deleted', workspaceName);
                      },
                      onCancel: () => {
                        void deleteWorkspace(workspaceId);
                        setSettingsModalOpen(false);
                        showSuccess('Workspace deleted', workspaceName);
                      },
                    });
                  }
                });
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-rose-500/10 text-rose-450 hover:text-rose-400 font-semibold text-xs rounded-md transition focus:outline-none cursor-pointer"
            >
              <Trash2 size={13.5} />
              <span>Delete Workspace</span>
            </button>
          </div>
        </div>

        {/* Right Hand Option content panel */}
        <div className="flex-1 bg-[#0c0c0e] p-6 flex flex-col overflow-hidden min-w-0">
          
          {/* Header */}
          <div className="flex justify-between items-center pb-4 border-b border-zinc-900 mb-5 select-none shrink-0 leading-none">
            <h2 className="text-zinc-200 font-bold text-sm tracking-tight font-sans">
              {tabs.find(t => t.id === workspaceSettingsTab)?.label} Settings
            </h2>
            <button
              onClick={() => setSettingsModalOpen(false)}
              aria-label="Close settings panel"
              className="w-7 h-7 hover:bg-zinc-900 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-100 transition focus:outline-none cursor-pointer"
              title="Close settings panel"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>

          {/* Settings Tabs Router Area */}
          <div className="flex-1 overflow-y-auto pr-1 scrollbar-thin select-text">
            <AnimatePresence mode="wait">
              <motion.div
                key={workspaceSettingsTab}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
              >
            
            {/* TAB: WORKSPACE (id 'overview' kept for compat) */}
            {workspaceSettingsTab === 'overview' && (
              <div className="space-y-4 text-xs font-sans leading-relaxed">
                <div className="flex items-center gap-4 bg-zinc-950/45 p-4 rounded-lg border border-zinc-900 select-none">
                  <CrowIcon variant={activeWS.icon} className="w-14 h-14 rounded-xl border border-zinc-800" iconSize={65} />
                  <div className="space-y-1">
                    <h3 className="font-bold text-zinc-200 text-sm tracking-tight leading-none">{activeWS.name}</h3>
                    <p className="tnum text-[10px] text-zinc-500 font-mono">Workspace ID: {activeWS.id}</p>
                    <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-300">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      Active
                    </span>
                  </div>
                </div>

                  <div className="grid grid-cols-3 gap-3 text-left pt-1 select-none">
                  <div className="bg-zinc-900/20 border border-zinc-900 p-3 rounded-lg leading-tight">
                    <span className="text-[11px] font-medium text-zinc-400 block mb-1">Agents</span>
                    <span className="tnum text-lg font-semibold text-zinc-200">{agents.length}</span>
                  </div>
                  <div className="bg-zinc-900/20 border border-zinc-900 p-3 rounded-lg leading-tight">
                    <span className="text-[11px] font-medium text-zinc-400 block mb-1">Channels</span>
                    <span className="tnum text-lg font-semibold text-zinc-200">{activeWS.categories.reduce((n, c) => n + c.channels.length, 0) + (activeWS.channels?.length ?? 0)}</span>
                  </div>
                  <div className="bg-zinc-900/20 border border-zinc-900 p-3 rounded-lg leading-tight">
                    <span className="text-[11px] font-medium text-zinc-400 block mb-1">Storage</span>
                    <span className="text-lg font-semibold text-emerald-400">{activeWS.database?.configured ? 'Synced' : 'Local'}</span>
                  </div>
                </div>

                <div className="space-y-1 bg-zinc-950 p-4 border border-zinc-900 rounded-lg">
                  <h4 className="font-semibold text-zinc-300 text-xs">How this workspace runs</h4>
                  <p className="text-zinc-500 leading-normal font-sans">
                    This is a single-user, local-first workspace. Files stay on disk; a database is optional and only adds semantic memory and sync. You can add, edit, or remove agents in the tabs on the left.
                  </p>
                </div>

                <StorageSyncSection
                  activeWS={activeWS}
                  dbSyncStatus={dbSyncStatus}
                  isSyncing={isSyncing}
                  workspaceError={workspaceError}
                  fetchDbSync={fetchDbSync}
                  setStoragePreference={setStoragePreference}
                  updateWorkspace={updateWorkspace}
                  resolveDbConflict={resolveDbConflict}
                  syncNow={syncNow}
                  rebuildRag={rebuildRag}
                  showInfo={showInfo}
                  showSuccess={showSuccess}
                  showError={showError}
                  askConfirmation={askConfirmation}
                />
              </div>
            )}

            {/* TAB: AGENTS */}
            {workspaceSettingsTab === 'agents' && (
              <div className="space-y-4 text-xs font-sans">
                <div className="flex items-center justify-between select-none">
                  <div>
                    <h3 className="font-semibold text-zinc-200">Agents</h3>
                    <p className="text-zinc-500 font-sans">Add, edit, and organize the agents that work in this workspace.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input 
                      type="file" 
                      accept=".json" 
                      onChange={handleImportAgent} 
                      style={{ display: 'none' }} 
                      id="import-agent-input" 
                    />
                    <label 
                      htmlFor="import-agent-input" 
                      className="px-2.5 py-1.5 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900 text-zinc-300 rounded-md font-semibold flex items-center gap-1.5 transition cursor-pointer select-none"
                    >
                      <Upload size={13} />
                      <span>Import agent</span>
                    </label>
                    {!agentFormOpen && (
                      <button
                        onClick={() => setAgentFormOpen(true)}
                        className="px-2.5 py-1.5 bg-indigo-500 text-white rounded-md font-semibold hover:bg-indigo-650 flex items-center gap-1 transition cursor-pointer focus:outline-none"
                      >
                        <Plus size={13} />
                        <span>Assemble Mind</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Agent Creation Form */}
                <AnimatePresence>
                {agentFormOpen && (
                  <motion.form 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    onSubmit={handleCreateAgent} 
                    className="bg-zinc-950 border border-zinc-900 p-4 rounded-lg space-y-3.5 select-text overflow-hidden"
                  >
                    {/* Presets dropdown */}
                    <div className="space-y-1">
                      <label className="text-zinc-500 font-medium text-[11px] block">Preset template</label>
                      <select
                        onChange={(e) => {
                          const preset = PRESETS.find(p => p.id === e.target.value);
                          if (preset) {
                            setNewAgentName(preset.name);
                            setNewAgentSpecies(preset.species);
                            setNewAgentLevel(preset.level as AgentLevel);
                            setNewAgentDesc(preset.description);
                            setNewAgentInstructionModuleId(preset.instructionModuleId);
                            setNewAgentModelModuleId(preset.modelModuleId);
                            setNewAgentToolkitModuleId(preset.toolkitModuleId);
                            setNewAgentIsOmniscient(preset.isOmniscient);
                          }
                        }}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        defaultValue=""
                      >
                        <option value="" disabled>-- Select a Built-in Preset to Auto-fill --</option>
                        {PRESETS.map(p => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-3 leading-snug">
                      <div className="space-y-1">
                        <label className="text-zinc-500 font-medium text-[11px] block">Name</label>
                        <input
                          required
                          type="text"
                          value={newAgentName}
                          onChange={(e) => setNewAgentName(e.target.value)}
                          placeholder="alphanumeric_with_underscores"
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 focus:outline-none font-mono text-xs text-zinc-100 placeholder-zinc-650"
                        />
                        {newAgentName && !/^[A-Za-z0-9_-]+$/.test(newAgentName) && (
                          <span className="text-[10px] text-rose-400 font-sans block mt-1">âš ï¸ Only letters, numbers, hyphens, and underscores allowed.</span>
                        )}
                        {newAgentName && agents.some(a => a.name.toLowerCase() === newAgentName.toLowerCase()) && (
                          <span className="text-[10px] text-amber-500 font-sans block mt-1">âš ï¸ Name already exists in this workspace.</span>
                        )}
                      </div>

                      <div className="space-y-1">
                        <label className="text-zinc-500 font-medium text-[11px] block">Species</label>
                        <select
                          value={newAgentSpecies}
                          onChange={(e) => setNewAgentSpecies(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="Falcon">Falcon</option>
                          <option value="Raven">Raven</option>
                          <option value="Crow">Crow</option>
                          <option value="Sparrow">Sparrow</option>
                          <option value="Pigeon">Pigeon</option>
                          <option value="Owl">Owl</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 leading-snug">
                      <div className="space-y-1">
                        <label className="text-zinc-500 font-medium text-[11px] block">Authority tier</label>
                        <select
                          value={newAgentLevel}
                          onChange={(e) => setNewAgentLevel(parseInt(e.target.value) as AgentLevel)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value={0}>L0 (Surveillance)</option>
                          <option value={1}>L1 (Admin)</option>
                          <option value={2}>L2 (Coordinator)</option>
                          <option value={3}>L3 (Worker)</option>
                        </select>
                      </div>

                      <div className="space-y-1 animate-fade-in">
                        <label className="text-zinc-500 font-medium text-[11px] block">Supervising agent</label>
                        <select
                          value={newAgentParentId}
                          onChange={(e) => setNewAgentParentId(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="">None (Top-Level Node)</option>
                          {agents.filter(a => a.level < newAgentLevel).map(ag => (
                            <option key={ag.id} value={ag.id}>{ag.name} (L{ag.level})</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* Modular composition selectors */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 leading-snug">
                      <div className="space-y-1">
                        <label className="text-zinc-500 font-medium text-[11px] block">Instructions module</label>
                        <select
                          value={newAgentInstructionModuleId}
                          onChange={(e) => setNewAgentInstructionModuleId(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="">No instructions (unassigned)</option>
                          {instructionModules.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-zinc-550 font-medium text-[11px] block">Model module</label>
                        <select
                          value={newAgentModelModuleId}
                          onChange={(e) => setNewAgentModelModuleId(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="">No model (unassigned)</option>
                          {modelModules.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-zinc-550 font-medium text-[11px] block">Toolkit module</label>
                        <select
                          value={newAgentToolkitModuleId}
                          onChange={(e) => setNewAgentToolkitModuleId(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="">No allowed tools</option>
                          {toolkitModules.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-zinc-550 font-medium text-[11px] block">Constraints module</label>
                        <select
                          value={newAgentConstraintsModuleId}
                          onChange={(e) => setNewAgentConstraintsModuleId(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="">No constraints</option>
                          {constraintsModules.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-zinc-550 font-medium text-[11px] block">Capabilities module</label>
                        <select
                          value={newAgentCapabilitiesModuleId}
                          onChange={(e) => setNewAgentCapabilitiesModuleId(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="">No capabilities</option>
                          {capabilitiesModules.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 leading-snug">
                      <div className="space-y-1">
                        <label className="text-zinc-550 font-bold font-mono text-[10px] block">ASSIGN ROLE / PERMISSIONS</label>
                        <select
                          value={newAgentRoleId}
                          onChange={(e) => setNewAgentRoleId(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="">No Custom Role</option>
                          {roles.map(r => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                      </div>

                      {(newAgentLevel === 0 || newAgentLevel === 1) && (
                        <div className="flex items-center gap-2 pt-4 select-none">
                          <input
                            type="checkbox"
                            id="newAgentIsOmniscient"
                            checked={newAgentIsOmniscient}
                            onChange={(e) => setNewAgentIsOmniscient(e.target.checked)}
                            className="bg-zinc-900 border border-zinc-800 rounded focus:ring-1 focus:ring-zinc-700 focus:outline-none text-indigo-500 h-4 w-4 cursor-pointer"
                          />
                          <label htmlFor="newAgentIsOmniscient" className="text-zinc-300 font-bold font-mono text-[10px] cursor-pointer">
                            ACTIVATE L0 OMNISCIENT OVERWATCH TAG
                          </label>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <label className="text-zinc-500 font-medium text-[11px] block">Description</label>
                      <textarea
                        value={newAgentDesc}
                        onChange={(e) => setNewAgentDesc(e.target.value)}
                        placeholder="Write specific cognitive boundaries or summary task loops here..."
                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-2 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-700/45 resize-none placeholder-zinc-650 h-20"
                        rows={2}
                      />
                    </div>

                    <div className="flex justify-end gap-2 pt-1 select-none">
                      <button
                        type="button"
                        onClick={() => setAgentFormOpen(false)}
                        className="px-2.5 py-1.5 border border-zinc-800 rounded hover:bg-zinc-900 text-zinc-400 font-semibold cursor-pointer focus:outline-none"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={Boolean(newAgentName && !/^[A-Za-z0-9_-]+$/.test(newAgentName))}
                        className="px-2.5 py-1.5 bg-indigo-500 text-white rounded font-semibold hover:bg-indigo-650 cursor-pointer disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed"
                      >
                        Launch Assembly
                      </button>
                    </div>
                  </motion.form>
                )}
                </AnimatePresence>

                {/* Edit Agent Form */}
                <AnimatePresence>
                {editingAgentId && (
                  <motion.form 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    onSubmit={handleSaveAgent} 
                    className="bg-[#101014] border border-indigo-900/60 p-4 rounded-lg space-y-3.5 select-text overflow-hidden"
                  >
                    <div className="flex items-center justify-between border-b border-indigo-900/40 pb-2 select-none">
                      <span className="font-medium text-indigo-400 text-[12px]">Editing agent</span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 leading-snug">
                      <div className="space-y-1">
                        <label className="text-indigo-300 font-medium text-[11px] block">Name</label>
                        <input
                          required
                          type="text"
                          value={editAgentName}
                          onChange={(e) => setEditAgentName(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-indigo-700 focus:ring-1 focus:ring-indigo-700/40 focus:outline-none font-mono text-xs text-zinc-100"
                        />
                        {editAgentName && !/^[A-Za-z0-9_-]+$/.test(editAgentName) && (
                          <span className="text-[10px] text-rose-450 font-sans block mt-1">âš ï¸ Only letters, numbers, hyphens, and underscores allowed.</span>
                        )}
                      </div>

                      <div className="space-y-1">
                        <label className="text-indigo-300 font-medium text-[11px] block">Species</label>
                        <select
                          value={editAgentSpecies}
                          onChange={(e) => setEditAgentSpecies(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-indigo-700 focus:ring-1 focus:ring-indigo-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="Falcon">Falcon</option>
                          <option value="Raven">Raven</option>
                          <option value="Crow">Crow</option>
                          <option value="Sparrow">Sparrow</option>
                          <option value="Pigeon">Pigeon</option>
                          <option value="Owl">Owl</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 leading-snug">
                      <div className="space-y-1">
                        <label className="text-indigo-300 font-medium text-[11px] block">Authority tier</label>
                        <select
                          value={editAgentLevel}
                          onChange={(e) => setEditAgentLevel(parseInt(e.target.value) as AgentLevel)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-indigo-700 focus:ring-1 focus:ring-indigo-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value={0}>L0</option>
                          <option value={1}>L1</option>
                          <option value={2}>L2</option>
                          <option value={3}>L3</option>
                        </select>
                      </div>

                      <div className="space-y-1 animate-fade-in">
                        <label className="text-indigo-300 font-bold font-mono text-[10px] block">ASSIGN ROLE / PERMISSIONS</label>
                        <select
                          value={editAgentRoleId}
                          onChange={(e) => setEditAgentRoleId(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-indigo-700 focus:ring-1 focus:ring-indigo-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="">No Custom Role</option>
                          {roles.map(r => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {(editAgentLevel === 0 || editAgentLevel === 1) && (
                      <div className="flex items-center gap-2 pt-2 pb-1 select-none animate-fade-in">
                        <input
                          type="checkbox"
                          id="editAgentIsOmniscient"
                          checked={editAgentIsOmniscient}
                          onChange={(e) => setEditAgentIsOmniscient(e.target.checked)}
                          className="bg-zinc-950 border border-zinc-800 rounded focus:ring-1 focus:ring-indigo-700 focus:outline-none text-indigo-500 h-4 w-4 cursor-pointer"
                        />
                        <label htmlFor="editAgentIsOmniscient" className="text-zinc-300 font-bold font-mono text-[10px] cursor-pointer">
                          ACTIVATE L0 OMNISCIENT OVERWATCH TAG
                        </label>
                      </div>
                    )}

                    {/* Attached Modules selectors */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 leading-snug">
                      <div className="space-y-1">
                        <label className="text-indigo-300 font-medium text-[11px] block">Instructions module</label>
                        <select
                          value={editAgentInstructionModuleId}
                          onChange={(e) => {
                            const newId = e.target.value;
                            setEditAgentInstructionModuleId(newId);
                            const targetModule = instructionModules.find(m => m.id === newId);
                            setEditAgentInstructionPrompt(targetModule?.systemPrompt || '');
                          }}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-indigo-700 focus:ring-1 focus:ring-indigo-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="">No instructions (unassigned)</option>
                          {instructionModules.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-indigo-300 font-medium text-[11px] block">Model module</label>
                        <select
                          value={editAgentModelModuleId}
                          onChange={(e) => setEditAgentModelModuleId(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-indigo-700 focus:ring-1 focus:ring-indigo-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                            <option value="">No model (unassigned)</option>
                          {modelModules.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-indigo-300 font-medium text-[11px] block">Toolkit module</label>
                        <select
                          value={editAgentToolkitModuleId}
                          onChange={(e) => setEditAgentToolkitModuleId(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-indigo-700 focus:ring-1 focus:ring-indigo-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="">No allowed tools</option>
                          {toolkitModules.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-indigo-300 font-medium text-[11px] block">Constraints module</label>
                        <select
                          value={editAgentConstraintsModuleId}
                          onChange={(e) => setEditAgentConstraintsModuleId(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-indigo-700 focus:ring-1 focus:ring-indigo-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="">No constraints</option>
                          {constraintsModules.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-indigo-300 font-medium text-[11px] block">Capabilities module</label>
                        <select
                          value={editAgentCapabilitiesModuleId}
                          onChange={(e) => setEditAgentCapabilitiesModuleId(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 focus:border-indigo-700 focus:ring-1 focus:ring-indigo-700/40 focus:outline-none text-xs text-zinc-200 cursor-pointer"
                        >
                          <option value="">No capabilities</option>
                          {capabilitiesModules.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-indigo-300 font-medium text-[11px] block">Instructions</label>
                      <textarea
                        value={editAgentInstructionPrompt}
                        onChange={(e) => setEditAgentInstructionPrompt(e.target.value)}
                        placeholder="Write detailed cognitive instructions and system directives..."
                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-2 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-700/45 resize-y min-h-[4rem] placeholder-zinc-650"
                        rows={3}
                      />
                    </div>

                    <div className="flex justify-end gap-2 pt-1 select-none">
                      <button
                        type="button"
                        onClick={() => setEditingAgentId(null)}
                        className="px-2.5 py-1.5 border border-zinc-800 rounded hover:bg-zinc-900 text-zinc-400 font-semibold cursor-pointer focus:outline-none transition"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={Boolean(editAgentName && !/^[A-Za-z0-9_-]+$/.test(editAgentName))}
                        className="px-2.5 py-1.5 bg-indigo-600 text-white rounded font-semibold hover:bg-indigo-500 cursor-pointer transition shadow-xl disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed"
                      >
                        Save Configuration
                      </button>
                    </div>
                  </motion.form>
                )}
                </AnimatePresence>

                {/* Agents List Table */}
                <div className="border border-zinc-900 rounded-lg overflow-hidden bg-zinc-950/20">
                  <table className="w-full text-left font-sans select-none border-collapse">
                    <thead>
                      <tr className="bg-zinc-950 border-b border-zinc-900 text-[11px] font-medium text-zinc-400">
                        <th className="p-3">Agent</th>
                        <th className="p-3">Species</th>
                        <th className="p-3">Tier</th>
                        <th className="p-3">Status</th>
                        <th className="p-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900/40">
                      {agents.map(ag => (
                        <tr key={ag.id} className="hover:bg-zinc-900/10 text-xs">
                          <td className="p-3 font-semibold text-zinc-250 truncate max-w-xs">{ag.name}</td>
                          <td className="p-3 font-mono text-zinc-450">{ag.species}</td>
                          <td className="p-3">
                            <span className="px-1.5 py-0.2 select-none font-mono text-[9px] font-bold rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                              L{ag.level}
                            </span>
                          </td>
                          <td className="p-3 capitalize text-zinc-400">{ag.status}</td>
                          <td className="p-3 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => setStudioAgentId(ag.id)}
                                className="text-indigo-400 hover:text-indigo-300 px-1.5 py-0.5 bg-indigo-500/10 hover:bg-indigo-500/20 rounded border border-indigo-500/30 transition focus:outline-none cursor-pointer flex items-center gap-1 font-mono text-[10px]"
                                title="Open agent studio"
                              >
                                <Layers size={11} />
                                <span>Studio</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDuplicateAgent(ag)}
                                className="text-zinc-400 hover:text-emerald-300 p-1 bg-zinc-950 hover:bg-emerald-900/40 rounded border border-zinc-900 hover:border-emerald-900 transition focus:outline-none cursor-pointer"
                                title={`Duplicate agent ${ag.name}`}
                                aria-label={`Duplicate agent ${ag.name}`}
                              >
                                <Copy size={11} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleExportAgent(ag)}
                                className="text-zinc-400 hover:text-cyan-300 p-1 bg-zinc-950 hover:bg-cyan-900/40 rounded border border-zinc-900 hover:border-cyan-900 transition focus:outline-none cursor-pointer"
                                title={`Export ${ag.name} as JSON`}
                                aria-label={`Export ${ag.name} as JSON`}
                              >
                                <Download size={11} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => startEditingAgent(ag)}
                                className="text-zinc-400 hover:text-indigo-300 p-1 bg-zinc-950 hover:bg-indigo-900/40 rounded border border-zinc-900 hover:border-indigo-900 transition focus:outline-none cursor-pointer"
                                title={`Edit agent ${ag.name}`}
                                aria-label={`Edit agent ${ag.name}`}
                              >
                                <Edit size={11} aria-hidden="true" />
                              </button>
                              {ag.level > 0 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    askConfirmation({
                                      title: `Delete ${ag.name}?`,
                                      description: `This removes the agent from the workspace. Active tasks assigned to it will be unassigned.`,
                                      confirmLabel: 'Delete agent',
                                      isDanger: true,
                                      onConfirm: () => {
                                        runCrudAction(() => deleteAgent(ag.id), 'Failed to delete agent.');
                                      }
                                    });
                                  }}
                                  className="text-rose-400 hover:text-rose-300 p-1 bg-zinc-950 hover:bg-rose-950/40 rounded border border-zinc-900 hover:border-rose-900 transition focus:outline-none cursor-pointer"
                                  title={`Delete agent ${ag.name}`}
                                  aria-label={`Delete agent ${ag.name}`}
                                >
                                  <Trash2 size={11} aria-hidden="true" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
{/* TAB: ROLES */}
            {workspaceSettingsTab === 'roles' && (
              <div className="flex gap-4 h-[500px]">
                {/* Left side: Roles List */}
                <div className="w-1/3 border border-zinc-900 rounded-lg bg-zinc-950/40 flex flex-col">
                  <div className="p-3 border-b border-zinc-900 flex items-center justify-between">
                    <span className="font-medium text-zinc-300 text-[13px]">Roles <span className="text-[10px] font-mono text-zinc-500">· local only</span></span>
                    <button onClick={handleCreateRole} aria-label="Create role" title="Create role" className="p-1 hover:bg-zinc-800 rounded outline-none text-zinc-400 hover:text-zinc-200">
                      <Plus size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <p className="px-3 pt-2 text-[10.5px] leading-snug text-zinc-500">Display labels on this device — no server enforcement behind them.</p>
                  <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {roles.map((r, i) => (
                      <div 
                        key={r.id} 
                        id={`role-${r.id}`}
                        draggable
                        onDragStart={(e) => handleDragStart(e, r.id)}
                        onDragOver={handleDragOver}
                        onDrop={(e) => handleDrop(e, r.id)}
                        onDragEnd={handleDragEnd}
                        onClick={() => setSelectedRoleId(r.id)}
                        className={`flex items-center justify-between gap-2 p-2 rounded cursor-pointer transition ${selectedRoleId === r.id ? 'bg-indigo-900/40 border-[0.5px] border-indigo-700/50' : 'hover:bg-zinc-900 border-[0.5px] border-transparent'}`}
                      >
                        <div className="flex items-center gap-2 overflow-hidden">
                          <GripVertical size={13} className="text-zinc-600 cursor-grab shrink-0" />
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                          <span className="text-sm font-medium truncate text-zinc-200" title={r.name}>
                            {r.name}
                          </span>
                        </div>
                        {selectedRoleId === r.id && <ArrowRight size={14} className="text-indigo-400 shrink-0" />}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Right side: Role Edit Pane */}
                <div className="flex-1 border border-zinc-900 rounded-lg bg-zinc-950/20 flex flex-col overflow-hidden relative">
                  {selectedRole ? (
                    <div className="absolute inset-0 overflow-y-auto">
                      <div className="p-5 border-b border-zinc-900 space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-zinc-200 text-[13px]">Edit role</h3>
                            <span className="text-[11px] text-emerald-400">Autosaved</span>
                          </div>
                          <button
                            onClick={() => {
                              askConfirmation({
                                title: `Delete Role ${selectedRole.name}?`,
                                description: `Are you sure you want to delete role "${selectedRole.name}"? Members with this role will lose assigned permissions.`,
                                confirmLabel: 'Delete Role',
                                isDanger: true,
                                onConfirm: () => {
                                  deleteRole(selectedRole.id);
                                  setSelectedRoleId(null);
                                  showSuccess('Role Deleted', selectedRole.name);
                                }
                              });
                            }}
                            className="flex items-center gap-1.5 px-2 py-1 text-xs text-rose-400 hover:bg-rose-950/40 rounded transition cursor-pointer"
                          >
                            <Trash2 size={12} />
                            <span>Delete</span>
                          </button>
                        </div>
                        
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-zinc-400">Role name</label>
                          <input
                            type="text"
                            value={selectedRole.name}
                            onChange={(e) => updateRole(selectedRole.id, { name: e.target.value })}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-600 text-zinc-200"
                          />
                        </div>

                        <div className="space-y-2">
                          <label className="text-xs font-medium text-zinc-400">Role color</label>
                          <div className="grid grid-cols-8 gap-2">
                            {ROLE_COLORS.map(color => (
                              <button
                                key={color}
                                onClick={() => updateRole(selectedRole.id, { color })}
                                aria-label={`Role color ${color}`}
                                title={`Role color ${color}`}
                                aria-pressed={selectedRole.color === color}
                                className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition ${selectedRole.color === color ? 'border-zinc-200 scale-110' : 'border-transparent hover:scale-110'}`}
                                style={{ backgroundColor: color }}
                              >
                                {selectedRole.color === color && <Check size={14} className="text-black" aria-hidden="true" />}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="p-5 space-y-4">
                        <h4 className="font-semibold text-zinc-200 text-[13px] border-b border-zinc-900 pb-2">Role permissions</h4>
                        <div className="space-y-4">
                          {ROLE_PERMISSIONS.map(perm => {
                            const isGranted = selectedRole.permissions.includes(perm.id) || selectedRole.permissions.includes('all') || selectedRole.permissions.includes('administrator');
                            const isToggled = selectedRole.permissions.includes(perm.id);
                            const disabled = perm.id !== 'administrator' && (selectedRole.permissions.includes('all') || selectedRole.permissions.includes('administrator'));
                            return (
                              <div key={perm.id} className="flex items-start justify-between gap-4 py-2">
                                <div className="space-y-0.5 max-w-[80%]">
                                  <div className={`font-semibold text-sm ${isGranted ? 'text-zinc-200' : 'text-zinc-400'}`}>
                                    {perm.label}
                                  </div>
                                  <div className="text-xs text-zinc-500 leading-tight">
                                    {perm.description}
                                  </div>
                                </div>
                                <button
                                  onClick={() => togglePermission(perm.id)}
                                  disabled={disabled}
                                  aria-label={`${perm.label} permission`}
                                  aria-checked={isToggled}
                                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors focus:outline-none ${isToggled ? 'bg-indigo-500' : 'bg-zinc-700'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                                  role="switch"
                                >
                                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${isToggled ? 'translate-x-2' : '-translate-x-2'}`} />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
                      Select a role to edit
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB: TOOLS */}
            {workspaceSettingsTab === 'tools' && (
              <div className="space-y-4 text-xs font-sans">
                <div>
                    <h3 className="font-semibold text-zinc-200">Agent Capabilities & Toolkit Module <span className="text-[10px] font-mono text-zinc-500">· local only</span></h3>
                    <p className="text-zinc-500">Display toggles on this device — they flip the local tool list only and enforce nothing server-side. Real tool grants come from each agent's toolkit module.</p>
                </div>

                <div className="space-y-2.5 select-none">
                  {tools.map(t => (
                    <div 
                      key={t.id} 
                      className="bg-zinc-900/35 border border-zinc-900 p-3.5 rounded-lg flex items-center justify-between gap-4 font-sans leading-relaxed"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="font-semibold text-zinc-200 font-mono tracking-tight">{t.name}</span>
                          <span className="text-[9px] font-mono text-zinc-550 bg-zinc-950 border border-zinc-900 rounded px-1 inline-block">
                            {t.category}
                          </span>
                        </div>
                        <p className="text-zinc-450 mt-1 truncate max-w-md text-[11px] leading-normal">{t.description}</p>
                      </div>

                      <div className="flex items-center gap-4 shrink-0 font-mono">
                        <button
                          onClick={() => toggleToolEnabled(t.id)}
                          className={`p-1 rounded cursor-pointer transition focus:outline-none ${
                            t.enabled 
                              ? 'text-teal-400 font-medium' 
                              : 'text-zinc-600'
                          }`}
                        >
                          {t.enabled ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TAB: MODEL CARDS */}
            {workspaceSettingsTab === 'model_cards' && (
              <ModelCardsTab />
            )}

            {/* TAB: CHANNELS */}
            {workspaceSettingsTab === 'channels' && (
              <div className="space-y-4 text-xs font-sans">
                <div>
                  <h3 className="font-semibold text-zinc-200">Category & Operational Channels</h3>
                  <p className="text-zinc-500">Scaffold channels inside active categories. Dynamic channels act as isolated session threads.</p>
                </div>

                {/* Create Channel and category forms */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Create Category Form */}
                  <form onSubmit={handleCreateCategory} className="bg-zinc-950 border border-zinc-900 p-4 rounded-lg flex flex-col justify-between space-y-3 animate-fade-in leading-snug select-text">
                    <div className="space-y-3">
                      <span className="text-[13px] font-medium text-zinc-300 flex items-center gap-1.5 select-none">
                        <Layers size={13} /><span>New category</span>
                      </span>
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-zinc-400 block mb-1">Category name</label>
                        <input
                          required
                          type="text"
                          maxLength={40}
                          value={newCategoryName}
                          onChange={(e) => setNewCategoryName(e.target.value)}
                          placeholder="e.g. Core Cognitive Agents"
                          aria-describedby={isCategoryDuplicate || isCategoryTooShort || isCategoryTooLong ? "category-validation" : undefined}
                          className={`w-full bg-zinc-900 border rounded px-2.5 py-1.5 font-sans focus:outline-none text-xs text-zinc-200 placeholder-zinc-650 ${isCategoryDuplicate || isCategoryTooShort || isCategoryTooLong ? 'border-rose-500/40 focus:border-rose-500/60 focus:ring-rose-500/30' : 'border-zinc-800 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40'}`}
                        />
                        {(isCategoryDuplicate || isCategoryTooShort || isCategoryTooLong) && trimmedCategoryName && (
                          <div id="category-validation" className="text-[11px] font-mono px-1 pt-1">
                            {isCategoryDuplicate && <span className="text-rose-400">Category &quot;{trimmedCategoryName}&quot; already exists.</span>}
                            {isCategoryTooShort && !isCategoryDuplicate && <span className="text-amber-400">Must be at least 2 characters.</span>}
                            {isCategoryTooLong && <span className="text-rose-400">Must be 40 characters or fewer.</span>}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex justify-end select-none pt-3">
                      <button
                        type="submit"
                        disabled={!trimmedCategoryName || isCategoryDuplicate || isCategoryTooShort || isCategoryTooLong}
                        className="px-2.5 py-1.5 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-indigo-500 font-semibold text-white rounded flex items-center gap-1 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      >
                        <Plus size={13} aria-hidden="true" />
                        <span>Create category</span>
                      </button>
                    </div>
                  </form>

                  {/* Scaffold Operational Channel */}
                  <form onSubmit={handleCreateChannel} className="bg-zinc-950 border border-zinc-900 p-4 rounded-lg space-y-3 animate-fade-in leading-snug select-text">
                    <span className="text-[13px] font-medium text-zinc-300 flex items-center gap-1.5 select-none"><Hash size={13} /><span>New channel</span></span>
                    <div className="grid grid-cols-2 gap-3 leading-snug">
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-zinc-400 block mb-1">Channel name</label>
                        <input
                          required
                          type="text"
                          maxLength={40}
                          value={newChannelName}
                          onChange={(e) => setNewChannelName(e.target.value)}
                          placeholder="e.g. layout-scaffolding"
                          aria-describedby={isChannelDuplicate || isChannelTooShort || isChannelTooLong || isChannelEmpty ? "channel-validation" : undefined}
                          className={`w-full bg-zinc-900 border rounded px-2.5 py-1.5 font-sans focus:outline-none text-xs text-zinc-200 placeholder-zinc-650 ${isChannelDuplicate || isChannelTooShort || isChannelTooLong || (isChannelEmpty && newChannelName.trim()) ? 'border-rose-500/40 focus:border-rose-500/60 focus:ring-rose-500/30' : 'border-zinc-800 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40'}`}
                        />
                        {(isChannelDuplicate || isChannelTooShort || isChannelTooLong || (isChannelEmpty && newChannelName.trim())) && (
                          <div id="channel-validation" className="text-[11px] font-mono px-1">
                            {isChannelDuplicate && <span className="text-rose-400">Channel #{formattedNewChannelName} already exists.</span>}
                            {isChannelEmpty && newChannelName.trim() && !isChannelDuplicate && <span className="text-rose-400">Must contain at least one letter or number.</span>}
                            {isChannelTooShort && !isChannelDuplicate && !isChannelEmpty && <span className="text-amber-400">Must be at least 2 characters.</span>}
                            {isChannelTooLong && <span className="text-rose-400">Must be 40 characters or fewer.</span>}
                          </div>
                        )}
                        {formattedNewChannelName && !isChannelDuplicate && !isChannelTooShort && !isChannelTooLong && (
                          <div className="text-[10px] font-mono text-zinc-500 px-1">Will be created as #{formattedNewChannelName}</div>
                        )}
                      </div>

                      <div className="space-y-1">
                        <label className="text-[11px] font-medium text-zinc-400 block mb-1">Category</label>
                        <select
                          value={newChannelCategory}
                          required
                          onChange={(e) => setNewChannelCategory(e.target.value)}
                          className="bg-zinc-900 border border-zinc-800 text-zinc-250 text-xs rounded px-2.5 py-1.5 focus:outline-none w-full cursor-pointer focus:ring-1 focus:ring-zinc-700/40"
                        >
                          <option value="">Select Target Category...</option>
                          {activeWS.categories.map(c => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="space-y-1">
                        <label className="text-[11px] font-medium text-zinc-400 block mb-1">Description</label>
                      <input
                        type="text"
                        maxLength={120}
                        value={newChannelDesc}
                        onChange={(e) => setNewChannelDesc(e.target.value)}
                        placeholder="e.g. Scrapes repository structures and tracks layouts"
                        className="w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 rounded px-2.5 py-1.5 text-xs text-zinc-250 focus:outline-none placeholder-zinc-650"
                      />
                    </div>

                    <div className="flex justify-end select-none">
                      <button
                        type="submit"
                        disabled={!formattedNewChannelName || isChannelDuplicate || isChannelTooShort || isChannelTooLong || isChannelCategoryMissing}
                        className="px-2.5 py-1.5 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-indigo-500 font-semibold text-white rounded flex items-center gap-1 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      >
                        <Plus size={13} aria-hidden="true" />
                        <span>Assemble Area</span>
                      </button>
                    </div>
                  </form>
                </div>

                {/* Structured listing */}
                <div className="space-y-4 select-none leading-none">
                  {/* Top-Level Channels */}
                  {activeWS.channels && activeWS.channels.length > 0 && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between px-1 mb-1">
                        <h4 className="text-[13px] font-medium text-zinc-400">
                          Top-level channels
                        </h4>
                      </div>
                      <div className="space-y-1">
                        {activeWS.channels.map(ch => (
                          <div key={ch.id} className="p-3 bg-zinc-900/10 border border-zinc-900 rounded-lg flex items-center justify-between gap-3 text-xs pr-4">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <Hash size={13.5} className="text-zinc-650 shrink-0" />
                              <div className="leading-snug">
                                <span className="font-semibold text-zinc-350">{ch.name}</span>
                                <span className="text-[10.5px] text-zinc-500 block leading-normal mt-0.5 font-sans">{ch.description}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {ch.name !== 'general' && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => runCrudAction(() => archiveChannel(ch.id, true), 'Failed to archive channel.')}
                                    className="px-2 py-0.5 bg-zinc-950 hover:bg-zinc-900 border border-zinc-850 text-zinc-400 text-[10px] rounded cursor-pointer"
                                    title="Archive channel"
                                  >
                                    Archive
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      askConfirmation({
                                        title: `Delete Channel #${ch.name}?`,
                                        description: `Delete channel #${ch.name} permanently? All message history in this channel will be purged. Action is irreversible.`,
                                        confirmLabel: 'Delete channel',
                                        isDanger: true,
                                        onConfirm: () => {
                                          runCrudAction(() => deleteChannel(ch.id), 'Failed to delete channel.');
                                        }
                                      });
                                    }}
                                    className="p-1 bg-zinc-950 hover:bg-rose-950/40 text-rose-450 border border-zinc-800 hover:border-rose-950 rounded cursor-pointer"
                                    title="Delete channel"
                                  >
                                    <Trash2 size={11.5} />
                                  </button>
                                </>
                              )}
                              {ch.name === 'general' && (
                                <span className="text-[10px] text-zinc-500">System channel</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Collapsible Category Channels */}
                  {activeWS.categories.map(c => (
                    <div key={c.id} className="space-y-1 border-t border-zinc-900/60 pt-3 first:border-0 first:pt-0">
                      <div className="flex items-center justify-between px-1 mb-1">
                        <div className="flex items-center gap-2">
                          <h4 className="text-[13px] font-medium text-zinc-300">
                            {c.name}
                          </h4>
                          <div className="flex items-center gap-0.5 select-none">
                            <button
                              type="button"
                              onClick={() => runCrudAction(() => reorderCategory(c.id, 'up'), 'Failed to reorder category.')}
                              className="text-zinc-600 hover:text-zinc-400 p-0.5 text-[9px] cursor-pointer"
                              title="Move Up"
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              onClick={() => runCrudAction(() => reorderCategory(c.id, 'down'), 'Failed to reorder category.')}
                              className="text-zinc-600 hover:text-zinc-400 p-0.5 text-[9px] cursor-pointer"
                              title="Move Down"
                            >
                              ▼
                            </button>
                          </div>
                        </div>
                        {c.name !== '[ADMIN]' && (
                          <button 
                            onClick={() => {
                              askConfirmation({
                                title: `Delete Category "${c.name}"?`,
                                description: `Delete category "${c.name}"? Channels inside it will also be permanently removed. Action is irreversible.`,
                                confirmLabel: 'Delete Category',
                                isDanger: true,
                                onConfirm: () => {
                                  runCrudAction(() => deleteCategory(c.id), 'Failed to delete category.');
                                }
                              });
                            }}
                            className="p-1 hover:bg-rose-950/40 text-rose-455 rounded transition cursor-pointer"
                            title="Delete Category"
                          >
                            <Trash2 size={11.5} />
                          </button>
                        )}
                      </div>
                      <div className="space-y-1">
                        {c.channels.map(ch => (
                          <div key={ch.id} className="p-3 bg-zinc-900/10 border border-zinc-900 rounded-lg flex items-center justify-between gap-3 text-xs pr-4">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <Hash size={13.5} className="text-zinc-650 shrink-0" />
                              <div className="leading-snug">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-zinc-350">{ch.name}</span>
                                  <div className="flex items-center gap-0.5">
                                    <button
                                      type="button"
                                      onClick={() => runCrudAction(() => reorderChannel(ch.id, 'up'), 'Failed to reorder channel.')}
                                      className="text-zinc-600 hover:text-zinc-400 text-[9px] p-0.5 cursor-pointer"
                                      title="Move Up"
                                    >
                                      ▲
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => runCrudAction(() => reorderChannel(ch.id, 'down'), 'Failed to reorder channel.')}
                                      className="text-zinc-600 hover:text-zinc-400 text-[9px] p-0.5 cursor-pointer"
                                      title="Move Down"
                                    >
                                      ▼
                                    </button>
                                  </div>
                                </div>
                                <span className="text-[10.5px] text-zinc-500 block leading-normal mt-0.5 font-sans">{ch.description}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => runCrudAction(() => archiveChannel(ch.id, true), 'Failed to archive channel.')}
                                className="px-2 py-0.5 bg-zinc-950 hover:bg-zinc-900 border border-zinc-805 text-zinc-400 text-[10px] rounded cursor-pointer"
                                title="Archive channel"
                              >
                                Archive
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  askConfirmation({
                                    title: `Delete Channel #${ch.name}?`,
                                    description: `Delete channel #${ch.name} permanently? All message history in this channel will be purged. Action is irreversible.`,
                                    confirmLabel: 'Delete channel',
                                    isDanger: true,
                                    onConfirm: () => {
                                      runCrudAction(() => deleteChannel(ch.id), 'Failed to delete channel.');
                                    }
                                  });
                                }}
                                className="p-1 bg-zinc-950 hover:bg-rose-950/40 text-rose-455 border border-zinc-800 hover:border-rose-950 rounded cursor-pointer"
                                title="Delete channel"
                              >
                                <Trash2 size={11.5} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}

                  {/* Archived Sectors List */}
                  {archivedChannels && archivedChannels.length > 0 && (
                    <div className="space-y-1 border-t border-dashed border-zinc-800 pt-4 mt-4">
                      <div className="flex items-center justify-between px-1 mb-1">
                        <h4 className="text-[13px] font-medium text-amber-400">
                          Archived channels (read-only)
                        </h4>
                      </div>
                      <div className="space-y-1">
                        {archivedChannels.map(ch => (
                          <div key={ch.id} className="p-3 bg-zinc-950/40 border border-amber-950/20 rounded-lg flex items-center justify-between gap-3 text-xs pr-4 hover:border-amber-950/40 transition">
                            <div className="flex items-center gap-1.5 min-w-0 opacity-60">
                              <Hash size={13.5} className="text-zinc-650 shrink-0" />
                              <div className="leading-snug">
                                <span className="font-semibold text-zinc-400 line-through">{ch.name}</span>
                                <span className="text-[10.5px] text-zinc-550 block leading-normal mt-0.5 font-sans">{ch.description}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => runCrudAction(() => archiveChannel(ch.id, false), 'Failed to restore channel.')}
                                className="px-2 py-0.5 bg-amber-950/20 hover:bg-amber-950/40 border border-amber-900/30 text-amber-400 text-[10px] rounded cursor-pointer transition"
                                title="Restore channel"
                              >
                                Restore
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  askConfirmation({
                                    title: `Hard-Delete Channel #${ch.name}?`,
                                    description: `Hard-delete archived channel #${ch.name} permanently? Action is irreversible.`,
                                    confirmLabel: 'Delete channel permanently',
                                    isDanger: true,
                                    onConfirm: () => {
                                      runCrudAction(() => deleteChannel(ch.id), 'Failed to delete channel.');
                                    }
                                  });
                                }}
                                className="p-1 bg-zinc-950 hover:bg-rose-950/40 text-rose-455 border border-zinc-800 hover:border-rose-950 rounded cursor-pointer"
                                title="Delete channel"
                              >
                                <Trash2 size={11.5} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB: SKILLS MANAGER */}
            {workspaceSettingsTab === 'skills_manager' && (
              <div className="space-y-6 text-xs font-sans">
                {/* Board Overview Header */}
                <div className="flex items-center justify-between pb-3 border-b border-zinc-900 select-none">
                  <div>
                    <h3 className="font-semibold text-zinc-200 text-sm tracking-tight flex items-center gap-1.5">
                      <Brain size={15} className="text-zinc-400" />
                      <span>Workspace Skills & Tools Manager</span>
                    </h3>
                    <p className="text-zinc-500 text-[11px] leading-relaxed mt-0.5">Scaffold and wire modular instructions (Skills) and functional capabilities (Tools) to cognitive workspace agents.</p>
                  </div>
                </div>

                {/* Primary split containers mapping Skills & Tools */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
                  
                  {/* Container 1: [Skill] */}
                  <div className="space-y-4 bg-zinc-950/30 border border-zinc-900/60 p-4 rounded-xl leading-relaxed flex flex-col">
                    <div className="flex items-center justify-between bg-zinc-950/20 pb-2 border-b border-zinc-900">
                      <div className="flex items-center gap-1.5">
                        <Brain size={13.5} className="text-indigo-400 shrink-0" />
                        <span className="font-medium text-zinc-200 text-[13px]">
                          Skills <span className="tnum text-zinc-500 text-[11px]">({instructionModules.length})</span>
                        </span>
                      </div>
                      
                      {!isCreatingSkill && !editingSkillId && (
                        <button
                          onClick={() => {
                            setIsCreatingSkill(true);
                            setSkillFormName('');
                            setSkillFormDesc('');
                            setSkillFormPrompt('# Custom Skill Instructions\n\n- Perform deep evaluation\n- Structure outputs as CJS models');
                            setSkillFormSandboxPath('/src/skills/custom-skill.md');
                              // Blank = unassigned: the select offers an
                              // explicit empty option, so a new skill never
                              // binds a profile id this workspace may not have.
                              setSkillFormModelProfileId('');
                          }}
                          className="px-2 py-1 text-[10px] font-mono font-bold text-indigo-400 hover:text-indigo-300 border border-indigo-500/20 hover:border-indigo-500/40 bg-indigo-500/[0.03] rounded transition flex items-center gap-0.5"
                        >
                          <Plus size={10} />
                          <span>New skill</span>
                        </button>
                      )}
                    </div>

                    {/* Skill Create / Edit Forms */}
                    <AnimatePresence>
                    {(isCreatingSkill || editingSkillId) && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                        className="bg-[#0c0c0e] border border-zinc-800 p-3.5 rounded-lg space-y-3 overflow-hidden"
                      >
                        <div className="flex items-center justify-between border-b border-zinc-900 pb-1.5 select-none">
                          <span className="text-[13px] font-medium text-zinc-300">
                            {isCreatingSkill ? 'New skill' : 'Edit skill'}
                          </span>
                          <button 
                            onClick={() => {
                              setIsCreatingSkill(false);
                              setEditingSkillId(null);
                            }}
                            className="text-zinc-500 hover:text-zinc-300 transition"
                          >
                            Cancel
                          </button>
                        </div>
                        
                        <div className="space-y-2.5">
                          <div>
                            <label className="text-[11px] font-medium text-zinc-400 block mb-1">Name</label>
                            <input 
                              type="text"
                              value={skillFormName}
                              onChange={(e) => setSkillFormName(e.target.value)}
                              placeholder="e.g., Deep Web Research"
                              className="w-full bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-zinc-150 text-[11.5px] outline-none focus:border-zinc-700 font-sans"
                            />
                          </div>

                          <div>
                            <label className="text-[11px] font-medium text-zinc-400 block mb-1">Description</label>
                            <input 
                              type="text"
                              value={skillFormDesc}
                              onChange={(e) => setSkillFormDesc(e.target.value)}
                              placeholder="Describe skill directives..."
                              className="w-full bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-zinc-150 text-[11.5px] outline-none focus:border-zinc-700 font-sans"
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-[11px] font-medium text-zinc-400 block mb-1">Model</label>
                              <select
                                value={skillFormModelProfileId}
                                onChange={(e) => setSkillFormModelProfileId(e.target.value)}
                                className="w-full bg-zinc-950 border border-zinc-850 rounded px-2 py-1 text-zinc-200 text-[11.5px] outline-none focus:border-zinc-700 font-mono"
                              >
                                  <option value="">No model (unassigned)</option>
                                {modelModules.map(p => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="text-[11px] font-medium text-zinc-400 block mb-1">Skill file</label>
                              <input 
                                type="text"
                                value={skillFormSandboxPath}
                                onChange={(e) => setSkillFormSandboxPath(e.target.value)}
                                placeholder="e.g., /src/skills/research.md"
                                className="w-full bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1 py-1.5 text-zinc-150 text-[11.5px] outline-none focus:border-zinc-700 font-mono"
                              />
                            </div>
                          </div>

                          <div>
                            <label className="text-[11px] font-medium text-zinc-400 block mb-1 flex items-center justify-between">
                              <span>Instructions</span>
                              <span className="text-[10px] text-zinc-500 font-normal">Markdown</span>
                            </label>
                            <textarea 
                              value={skillFormPrompt}
                              onChange={(e) => setSkillFormPrompt(e.target.value)}
                              rows={5}
                              placeholder="# Directives..."
                              className="w-full bg-zinc-950 border border-zinc-850 rounded p-2.5 text-zinc-200 font-mono text-[11px] leading-relaxed outline-none focus:border-zinc-700 resize-y"
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-900 shrink-0">
                          <button 
                            onClick={() => {
                              if (editingSkillId) {
                                // Revert to original
                                const orig = instructionModules.find(m => m.id === editingSkillId);
                                if (orig) {
                                  setSkillFormName(orig.name);
                                  setSkillFormDesc(orig.description || '');
                                  setSkillFormPrompt(orig.systemPrompt);
                                  setSkillFormSandboxPath(orig.sandboxPath || `/src/skills/${orig.name.toLowerCase().replace(/\s+/g, '-')}.md`);
                                  setSkillFormModelProfileId(orig.modelProfileId || '');
                                }
                              } else {
                                setIsCreatingSkill(false);
                              }
                            }}
                            className="px-2.5 py-1 text-[11px] font-mono text-zinc-450 hover:text-zinc-250 hover:bg-zinc-900 border border-zinc-850/30 rounded transition flex items-center gap-1 cursor-pointer"
                          >
                            <RotateCcw size={10} />
                            <span>Revert</span>
                          </button>
                          <button 
                            onClick={() => {
                              if (editingSkillId) {
                                handleSaveSkill(editingSkillId);
                              } else {
                                handleCreateSkillSubmit();
                              }
                            }}
                            className="px-3 py-1 text-[11px] font-mono bg-indigo-600 hover:bg-indigo-500 text-white rounded transition flex items-center gap-1 cursor-pointer font-bold shadow-md"
                          >
                            <Save size={10} />
                            <span>Save Skill</span>
                          </button>
                        </div>
                      </motion.div>
                    )}
                    </AnimatePresence>

                    {/* Skill Cards Lists */}
                    <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1 scrollbar-thin">
                      {instructionModules.map(skill => (
                        <div 
                          key={skill.id}
                          className={`p-3 rounded-lg border flex flex-col gap-2.5 transition select-none ${
                            editingSkillId === skill.id 
                              ? 'bg-zinc-900/40 border-indigo-500/40' 
                              : 'bg-zinc-900/25 border-zinc-900 hover:bg-zinc-900/35'
                          }`}
                        >
                          <div className="flex items-start justify-between min-w-0 gap-3">
                            <div className="space-y-0.5 min-w-0 leading-snug">
                              <span className="font-semibold text-zinc-200 block text-xs truncate font-mono">
                                {skill.name}
                              </span>
                              {skill.description && (
                                <span className="text-[10.5px] text-zinc-500 block leading-normal">{skill.description}</span>
                              )}
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0 select-none">
                              <button
                                onClick={() => startEditingSkill(skill)}
                                className="p-1 text-zinc-550 hover:text-zinc-350 bg-zinc-950 hover:bg-zinc-900 rounded border border-zinc-900 transition focus:outline-none cursor-pointer"
                                title={`Edit skill ${skill.name}`}
                                aria-label={`Edit skill ${skill.name}`}
                              >
                                <Edit size={10.5} aria-hidden="true" />
                              </button>
                              
                              <button
                                onClick={() => {
                                  askConfirmation({
                                    title: `Delete Skill Card "${skill.name}"?`,
                                    description: `Delete skill "${skill.name}"? Active agents using this skill will revert to default models.`,
                                    confirmLabel: 'Delete Skill',
                                    isDanger: true,
                                    onConfirm: () => {
                                      runCrudAction(() => deleteInstructionModule(skill.id), 'Failed to delete skill.');
                                    }
                                  });
                                }}
                                className="p-1 text-zinc-650 hover:text-rose-450 bg-zinc-950 hover:bg-[#1f0f15] rounded border border-zinc-900 transition focus:outline-none cursor-pointer"
                                title={`Delete skill ${skill.name}`}
                                aria-label={`Delete skill ${skill.name}`}
                              >
                                <Trash2 size={10.5} aria-hidden="true" />
                              </button>
                            </div>
                          </div>

                          {/* Skill Card Custom parameters */}
                          <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-zinc-500 bg-zinc-950/45 border border-zinc-900/80 p-1.5 rounded-md leading-relaxed select-text">
                            <div className="truncate">
                              <span className="text-zinc-650 font-semibold">📁 SANDBOX: </span>
                              <span className="text-zinc-400">{skill.sandboxPath || `/src/skills/${skill.name.toLowerCase().replace(/\s+/g, '-')}.md`}</span>
                            </div>
                            <div className="truncate text-right">
                              <span className="text-zinc-650 font-semibold">⚙️ PROFILE: </span>
                              <span className="text-zinc-400">
                                {modelModules.find(p => p.id === skill.modelProfileId)?.name || 'Default flash'}
                              </span>
                            </div>
                          </div>

                          {/* Attached Agents Row */}
                          <div className="pt-1.5 border-t border-zinc-900/40 select-none">
                            <span className="text-[11px] font-medium text-zinc-400 block mb-1">
                              Linked agents
                            </span>
                            <div className="flex flex-wrap gap-1.5 items-center">
                              {agents.map(agent => {
                                const isAttached = agent.instructionModuleId === skill.id;
                                return (
                                  <button
                                    key={agent.id}
                                    onClick={() => runCrudAction(
                                      () => updateAgent(agent.id, { instructionModuleId: isAttached ? undefined : skill.id }),
                                      'Failed to update agent skill link.'
                                    )}
                                    className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition select-none cursor-pointer border ${
                                      isAttached
                                        ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/35 hover:bg-indigo-500/15'
                                        : 'bg-zinc-950 text-zinc-550 border-zinc-900 hover:text-zinc-400 hover:bg-zinc-900/20'
                                    }`}
                                  >
                                    {isAttached ? '● ' : ''}{agent.name}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                  </div>

                  {/* Container 2: [Tool] */}
                  <div className="space-y-4 bg-zinc-950/30 border border-zinc-900/60 p-4 rounded-xl leading-relaxed flex flex-col">
                    
                    <div className="flex items-center justify-between bg-zinc-950/20 pb-2 border-b border-zinc-900">
                      <div className="flex items-center gap-1.5">
                        <Wrench size={13.5} className="text-teal-400 shrink-0" />
                        <span className="font-medium text-zinc-200 text-[13px]">
                          Tools <span className="tnum text-zinc-500 text-[11px]">({toolkitModules.length})</span>
                        </span>
                      </div>
                      
                      {!isCreatingToolModule && !editingToolModuleId && (
                        <button
                          onClick={() => {
                            setIsCreatingToolModule(true);
                            setToolFormName('');
                            setToolFormDesc('');
                            setToolFormCapabilities(['sandbox.exec', 'web.search']);
                            setToolFormSchema(JSON.stringify({
                              "read_sandbox_file": {
                                "description": "Fetch code contents from current sandbox session directory",
                                "parameters": {
                                  "type": "object",
                                  "properties": {
                                    "filePath": { "type": "string" }
                                  },
                                  "required": ["filePath"]
                                }
                              }
                            }, null, 2));
                          }}
                          className="px-2 py-1 text-[10px] font-mono font-bold text-teal-405 hover:text-teal-400 border border-teal-500/20 hover:border-teal-500/40 bg-teal-500/[0.03] rounded transition flex items-center gap-0.5"
                        >
                          <Plus size={10} />
                          <span>New tool</span>
                        </button>
                      )}
                    </div>

                    {/* Tool Create / Edit Forms */}
                    <AnimatePresence>
                    {(isCreatingToolModule || editingToolModuleId) && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                        className="bg-[#0c0c0e] border border-zinc-800 p-3.5 rounded-lg space-y-3 overflow-hidden"
                      >
                        <div className="flex items-center justify-between border-b border-zinc-900 pb-1.5 select-none">
                          <span className="text-[13px] font-medium text-zinc-300">
                            {isCreatingToolModule ? 'New tool' : 'Edit tool'}
                          </span>
                          <button 
                            onClick={() => {
                              setIsCreatingToolModule(false);
                              setEditingToolModuleId(null);
                            }}
                            className="text-zinc-500 hover:text-zinc-350 transition animate-fade"
                          >
                            Cancel
                          </button>
                        </div>

                        <div className="space-y-2.5">
                          <div>
                            <label className="text-[11px] font-medium text-zinc-400 block mb-1">Name</label>
                            <input 
                              type="text"
                              value={toolFormName}
                              onChange={(e) => setToolFormName(e.target.value)}
                              placeholder="e.g., Code Verification kit"
                              className="w-full bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-zinc-150 text-[11.5px] outline-none focus:border-zinc-700 font-sans"
                            />
                          </div>

                          <div>
                            <label className="text-[11px] font-medium text-zinc-400 block mb-1">Description</label>
                            <input 
                              type="text"
                              value={toolFormDesc}
                              onChange={(e) => setToolFormDesc(e.target.value)}
                              placeholder="e.g. Grants execution schema pipelines..."
                              className="w-full bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-zinc-150 text-[11.5px] outline-none focus:border-zinc-700 font-sans"
                            />
                          </div>

                          {/* Capabilities whitelist checkbox stack */}
                          <div>
                            <label className="text-[11px] font-medium text-zinc-400 block mb-1">Allowed capabilities</label>
                            <div className="grid grid-cols-2 gap-1.5 bg-zinc-950 p-2.5 border border-zinc-850 rounded text-[10.5px] select-none text-zinc-400 leading-normal">
                              {['sandbox.exec', 'web.search', 'github.read', 'db.query', 'agent.orchestrate'].map(capId => {
                                const checked = toolFormCapabilities.includes(capId);
                                return (
                                  <label key={capId} className="flex items-center gap-1.5 cursor-pointer hover:text-zinc-200">
                                    <input 
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => {
                                        setToolFormCapabilities(prev => 
                                          checked 
                                            ? prev.filter(c => c !== capId) 
                                            : [...prev, capId]
                                        );
                                      }}
                                      className="accent-teal-500 cursor-pointer w-3.5 h-3.5 border-zinc-800 bg-zinc-950 text-teal-600 rounded"
                                    />
                                    <span className="font-mono text-[9px] uppercase">{capId}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>

                          {/* Function call schema object definition */}
                          <div>
                            <label className="text-[11px] font-medium text-zinc-400 block mb-1 flex items-center justify-between">
                              <span>Function schemas (JSON)</span>
                              <span className="text-[10px] text-zinc-500 text-right">JSON Schema</span>
                            </label>
                            <textarea 
                              value={toolFormSchema}
                              onChange={(e) => setToolFormSchema(e.target.value)}
                              rows={5}
                              placeholder="{}"
                              className="w-full bg-zinc-950 border border-zinc-850 rounded p-2.5 text-teal-300 font-mono text-[11px] leading-relaxed outline-none focus:border-zinc-700 resize-y"
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-900 shrink-0">
                          <button 
                            onClick={() => {
                              if (editingToolModuleId) {
                                const orig = toolkitModules.find(t => t.id === editingToolModuleId);
                                if (orig) {
                                  setToolFormName(orig.name);
                                  setToolFormDesc(orig.description || '');
                                  setToolFormCapabilities(orig.enabledToolIds || []);
                                  setToolFormSchema(JSON.stringify(orig.sandboxConfig || {}, null, 2));
                                }
                              } else {
                                setIsCreatingToolModule(false);
                              }
                            }}
                            className="px-2.5 py-1 text-[11px] font-mono text-zinc-450 hover:text-zinc-250 hover:bg-zinc-900 border border-zinc-850/30 rounded transition flex items-center gap-1 cursor-pointer"
                          >
                            <RotateCcw size={10} />
                            <span>Revert</span>
                          </button>
                          <button 
                            onClick={() => {
                              if (editingToolModuleId) {
                                handleSaveToolModule(editingToolModuleId);
                              } else {
                                handleCreateToolModuleSubmit();
                              }
                            }}
                            className="px-3 py-1 text-[11px] font-mono bg-teal-600 hover:bg-teal-500 text-white rounded transition flex items-center gap-1 cursor-pointer font-bold shadow-md"
                          >
                            <Save size={10} />
                            <span>Save Tool</span>
                          </button>
                        </div>
                      </motion.div>
                    )}
                    </AnimatePresence>

                    {/* Tool lists */}
                    <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1 scrollbar-thin">
                      {toolkitModules.map(toolMod => (
                        <div 
                          key={toolMod.id}
                          className={`p-3 rounded-lg border flex flex-col gap-2.5 transition select-none ${
                            editingToolModuleId === toolMod.id 
                              ? 'bg-zinc-900/40 border-teal-500/40' 
                              : 'bg-zinc-900/25 border-zinc-900 hover:bg-zinc-900/35'
                          }`}
                        >
                          <div className="flex items-start justify-between min-w-0 gap-3">
                            <div className="space-y-0.5 min-w-0 leading-snug">
                              <span className="font-semibold text-zinc-200 block text-xs truncate font-mono">
                                {toolMod.name}
                              </span>
                              {toolMod.description && (
                                <span className="text-[10.5px] text-zinc-500 block leading-normal">{toolMod.description}</span>
                              )}
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                onClick={() => startEditingToolModule(toolMod)}
                                className="p-1 text-zinc-550 hover:text-zinc-350 bg-zinc-950 hover:bg-zinc-900 rounded border border-zinc-900 transition focus:outline-none cursor-pointer"
                                title={`Edit toolkit ${toolMod.name}`}
                                aria-label={`Edit toolkit ${toolMod.name}`}
                              >
                                <Edit size={10.5} aria-hidden="true" />
                              </button>
                              
                              <button
                                onClick={() => {
                                  askConfirmation({
                                    title: `Delete Toolkit "${toolMod.name}"?`,
                                    description: `Delete toolkit "${toolMod.name}"? Active agents utilizing these tools will lose whitelisting variables.`,
                                    confirmLabel: 'Delete Toolkit',
                                    isDanger: true,
                                    onConfirm: () => {
                                      runCrudAction(() => deleteToolkitModule(toolMod.id), 'Failed to delete toolkit.');
                                    }
                                  });
                                }}
                                className="p-1 text-zinc-650 hover:text-rose-450 bg-zinc-950 hover:bg-[#1f0f15] rounded border border-zinc-900 transition focus:outline-none cursor-pointer"
                                title={`Delete toolkit ${toolMod.name}`}
                                aria-label={`Delete toolkit ${toolMod.name}`}
                              >
                                <Trash2 size={10.5} aria-hidden="true" />
                              </button>
                            </div>
                          </div>

                          {/* Capability pills whitelisted list */}
                          {toolMod.enabledToolIds && toolMod.enabledToolIds.length > 0 && (
                            <div className="flex flex-wrap gap-1 leading-none select-none">
                              {toolMod.enabledToolIds.map(toolId => (
                                <span key={toolId} className="text-[8.5px] font-mono text-zinc-450 bg-zinc-950 px-1.5 py-0.5 border border-zinc-900 rounded select-text">
                                  ⚡ {toolId}
                                </span>
                              ))}
                            </div>
                          )}

                          {/* Attached Agents Row */}
                          <div className="pt-1.5 border-t border-zinc-900/40 select-none">
                            <span className="text-[11px] font-medium text-zinc-400 block mb-1">
                              Linked agents
                            </span>
                            <div className="flex flex-wrap gap-1.5 items-center">
                              {agents.map(agent => {
                                const isAttached = agent.toolkitModuleId === toolMod.id;
                                return (
                                  <button
                                    key={agent.id}
                                    onClick={() => runCrudAction(
                                      () => updateAgent(agent.id, { toolkitModuleId: isAttached ? undefined : toolMod.id }),
                                      'Failed to update agent toolkit link.'
                                    )}
                                    className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition select-none cursor-pointer border ${
                                      isAttached
                                        ? 'bg-teal-500/10 text-teal-400 border-teal-500/35 hover:bg-teal-500/15'
                                        : 'bg-zinc-950 text-zinc-550 border-zinc-900 hover:text-zinc-400 hover:bg-zinc-900/20'
                                    }`}
                                  >
                                    {isAttached ? '● ' : ''}{agent.name}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                        </div>
                      ))}
                    </div>

                  </div>

                </div>
              </div>
            )}

            {/* TAB: SAFETY */}
            {workspaceSettingsTab === 'safety' && (
              <div className="space-y-5 text-xs font-sans select-none leading-relaxed">
                <div>
                  <h3 className="font-semibold text-zinc-200">Swarm Safety & Whitelisting</h3>
                  <p className="text-zinc-500">Configure corporate permission policies, budget bounds, and emergency cutoff overrides.</p>
                </div>

                {/* Retention banner (surfacing only): this tab edits budgets and
                    execution policy. It runs no retention engine and no DLP scanner,
                    and it never deletes server history, scans content, or exports
                    audit data. Static, no motion, live-region safe (role=note). */}
                <div role="note" aria-label="Retention and data handling" className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5">
                  <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-amber-200">No automatic retention or DLP scanning here</p>
                    <ul className="mt-1 space-y-1 text-[11px] leading-snug text-zinc-400">
                      <li>Channel history belongs to the session: clearing a channel removes the local view and local mirror only — the server copy can return when the channel is reopened.</li>
                      <li>Agent memory belongs to each agent: clearing history never clears agent memory.</li>
                      <li>File restores revert to the checkpoint snapshot with a timestamped note; they do not restore cleared history. No audit export in this view.</li>
                    </ul>
                  </div>
                </div>

                <div className="space-y-4">
                  {/* Token Budgets & Safety Caps */}
                  <div className="space-y-4 bg-zinc-950/40 border border-zinc-900 p-4 rounded-lg">
                    <h4 className="font-semibold text-zinc-300 text-xs flex items-center gap-1.5">
                      <Coins size={14} className="text-indigo-400" />
                      <span>Corporate Token Budgets & Telemetry</span>
                    </h4>

                    {/* Progress Bar & Visual Usage */}
                    <div className="space-y-2">
                      <div className="flex justify-between items-center text-[10.5px]">
                        <span className="text-zinc-400 font-medium">Global Swarm Consumption</span>
                        <span className="font-mono text-zinc-350 font-bold">
                          {totalTokensConsumed.toLocaleString()} / {(globalSoftCap).toLocaleString()} Tokens
                        </span>
                      </div>
                      
                      {/* Gradient Bar Container */}
                      <div className="h-2.5 w-full bg-zinc-900 rounded-full overflow-hidden border border-zinc-800/80 p-[1.5px]">
                        <motion.div 
                          initial={{ width: 0 }}
                          animate={{ width: `${Math.min((totalTokensConsumed / (globalSoftCap || 1)) * 100, 100)}%` }}
                          className={`h-full rounded-full transition-all duration-500 shadow-sm ${
                            totalTokensConsumed >= globalSoftCap 
                              ? 'bg-gradient-to-r from-red-600 to-rose-500 shadow-rose-500/20' 
                              : totalTokensConsumed >= globalSoftCap * 0.8
                                ? 'bg-gradient-to-r from-amber-500 to-orange-500 shadow-amber-500/20'
                                : 'bg-gradient-to-r from-teal-500 to-emerald-500 shadow-emerald-500/20'
                          }`}
                        />
                      </div>

                      {/* Warnings Cards */}
                      {totalTokensConsumed >= globalSoftCap && (
                        <div className="bg-red-500/5 border border-red-500/25 text-red-400 p-2.5 rounded text-[11px] font-sans flex items-start gap-2">
                          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                          <div>
                            <span className="font-bold">SYSTEM AUTO-PAUSED:</span> Swarm execution has been frozen. You have exceeded your 100% global token budget. Please increase the soft cap or perform a budget usage reset to restore operations.
                          </div>
                        </div>
                      )}

                      {totalTokensConsumed >= globalSoftCap * 0.8 && totalTokensConsumed < globalSoftCap && (
                        <div className="bg-amber-500/5 border border-amber-500/25 text-amber-400 p-2.5 rounded text-[11px] font-sans flex items-start gap-2">
                          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                          <div>
                            <span className="font-bold">SOFT CAP WARNING (80%+):</span> Swarm consumption is approaching capacity bounds. Worker standbys will be triggered if the limit is fully breached.
                          </div>
                        </div>
                      )}
                    </div>

                    <hr className="border-zinc-900" />

                    {/* Global soft cap input */}
                    <div className="flex flex-col gap-2">
                      <label className="font-semibold text-zinc-300">Global Budget Soft Cap (Tokens)</label>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          value={editedGlobalSoftCap !== '' ? editedGlobalSoftCap : globalSoftCap}
                          onChange={(e) => setEditedGlobalSoftCap(e.target.value)}
                          className="bg-zinc-950 border border-zinc-900 rounded px-2.5 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none focus:border-indigo-500 transition w-full"
                          placeholder="e.g. 1000000"
                        />
                        <button
                          onClick={async () => {
                            setIsSavingBudget(true);
                            const val = parseInt(editedGlobalSoftCap !== '' ? editedGlobalSoftCap : String(globalSoftCap), 10);
                            if (!isNaN(val)) {
                              await updateBudget(val, undefined);
                              setEditedGlobalSoftCap('');
                              showSuccess('Global soft cap updated', 'Budget cap saved successfully.');
                            }
                            setIsSavingBudget(false);
                          }}
                          disabled={isSavingBudget}
                          className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold font-sans px-3.5 py-1.5 rounded transition shadow-sm text-xs shrink-0 cursor-pointer disabled:opacity-50"
                        >
                          Save Cap
                        </button>
                      </div>
                    </div>

                    <hr className="border-zinc-900" />

                    {/* Per-Provider budgets editor */}
                    <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <label className="font-semibold text-zinc-300">Model Provider Budgets</label>
                        <button
                          onClick={() => {
                            askConfirmation({
                              title: 'Reset Token Counters?',
                              description: 'Are you sure you want to reset all token usage counters to 0? Workspace consumption logs will be reset.',
                              confirmLabel: 'Reset Counters',
                              isDanger: true,
                              onConfirm: async () => {
                                await resetBudget();
                                showSuccess('Usage Counters Reset', 'Token counters restored to 0.');
                              }
                            });
                          }}
                          className="text-[10px] text-indigo-400 hover:text-indigo-350 flex items-center gap-1 font-mono transition select-none cursor-pointer"
                        >
                          <RotateCcw size={10} />
                      <span>Reset all counters</span>
                        </button>
                      </div>

                      {/* Select Provider Pills */}
                      <div className="flex gap-1.5">
                        {['google', 'openai', 'anthropic'].map((prov) => {
                          const currentProv = perProviderBudget[prov] || { softCap: 500000, used: 0, resetPeriod: 'monthly' };
                          const isSelected = selectedProvider === prov;
                          return (
                            <button
                              key={prov}
                              onClick={() => {
                                setSelectedProvider(prov);
                                setProvSoftCapInput(String(currentProv.softCap));
                                setProvResetPeriodInput(currentProv.resetPeriod as any);
                              }}
                              className={`px-2.5 py-1 rounded transition text-[10px] font-mono capitalize select-none cursor-pointer border ${
                                isSelected
                                  ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/35'
                                  : 'bg-zinc-950 text-zinc-450 border-zinc-900 hover:text-zinc-300'
                              }`}
                            >
                              <span>{prov}</span>
                              <span className="text-[9px] text-zinc-550 ml-1.5">({(currentProv.used || 0).toLocaleString()})</span>
                            </button>
                          );
                        })}
                      </div>

                      {/* Provider Edit Controls card */}
                      <div className="bg-zinc-950/70 border border-zinc-900/60 p-3 rounded space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="flex flex-col gap-1">
                            <span className="text-[11px] text-zinc-400 font-medium">Provider cap limit</span>
                            <input
                              type="number"
                              value={provSoftCapInput}
                              onChange={(e) => setProvSoftCapInput(e.target.value)}
                              className="bg-zinc-950 border border-zinc-900/80 rounded px-2 py-1 text-zinc-200 font-mono text-[11px] w-full focus:outline-none focus:border-indigo-500/80"
                            />
                          </div>

                          <div className="flex flex-col gap-1">
                            <span className="text-[11px] text-zinc-400 font-medium">Reset cadence</span>
                            <select
                              value={provResetPeriodInput}
                              onChange={(e: any) => setProvResetPeriodInput(e.target.value)}
                              className="bg-zinc-950 border border-zinc-900/80 rounded px-2 py-1 text-zinc-250 text-[11px] w-full focus:outline-none focus:border-indigo-500/80 cursor-pointer"
                            >
                              <option value="daily">Daily</option>
                              <option value="weekly">Weekly</option>
                              <option value="monthly">Monthly</option>
                              <option value="never">Never</option>
                            </select>
                          </div>
                        </div>

                        <div className="flex justify-between items-center text-[10.5px]">
                          <div className="text-zinc-500">
                            Usage: <span className="font-mono font-semibold text-zinc-400">{((perProviderBudget[selectedProvider]?.used ?? 0)).toLocaleString()}</span> tokens consumed
                          </div>
                          <button
                            onClick={async () => {
                              setIsSavingBudget(true);
                              const cap = parseInt(provSoftCapInput, 10);
                              if (!isNaN(cap)) {
                                const perProvPayload = {
                                  [selectedProvider]: {
                                    softCap: cap,
                                    resetPeriod: provResetPeriodInput
                                  }
                                };
                                await updateBudget(undefined, perProvPayload);
                                showSuccess(`Provider budget updated`, `Budget limit for ${selectedProvider} saved successfully.`);
                              }
                              setIsSavingBudget(false);
                            }}
                            disabled={isSavingBudget}
                            className="bg-indigo-600/10 hover:bg-indigo-600/15 text-indigo-400 font-semibold px-3 py-1 rounded transition border border-indigo-500/20 text-[10.5px] cursor-pointer focus:outline-none disabled:opacity-50"
                          >
                            Save Provider Budget
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* General policies */}
                  <div className="space-y-3 bg-zinc-950/40 border border-zinc-900 p-4 rounded-lg">
                    <h4 className="font-semibold text-zinc-300 text-xs flex items-center gap-1">
                      <Shield size={13} className="text-indigo-400" />
                      <span>General Execution Restrictions</span>
                    </h4>

                    <div className="space-y-3 select-none">
                      {/* Form approvals */}
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={humanApproval}
                          onChange={(e) => setHumanApproval(e.target.checked)}
                          className="mt-0.5 cursor-pointer accent-indigo-500"
                        />
                        <div className="leading-snug">
                          <span className="font-semibold text-zinc-250 block">Require Human Approval (L3) <span className="text-[10px] font-mono text-zinc-500">· local view only</span></span>
                          <span className="text-[11.5px] text-zinc-500 leading-normal block mt-0.5">Local display preference only — approvals are still requested by the server whenever a run needs one. Turning this off hides nothing server-side.</span>
                        </div>
                      </label>

                      {/* Rate thresholds */}
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={rateLimit}
                          onChange={(e) => setRateLimit(e.target.checked)}
                          className="mt-0.5 cursor-pointer accent-indigo-500"
                        />
                        <div className="leading-snug">
                          <span className="font-semibold text-zinc-250 block">Aggressive Rate Limiter Checks <span className="text-[10px] font-mono text-zinc-500">· local view only</span></span>
                          <span className="text-[11.5px] text-zinc-500 leading-normal block mt-0.5">Local display preference only — budget caps above are the real enforcement. Turning this off lifts nothing server-side.</span>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Operational Kill-Switch trigger */}
                  <div className="bg-rose-500/[0.02] border border-rose-500/20 p-4 rounded-lg space-y-3">
                      <h4 className="font-semibold text-rose-400 text-[13px] flex items-center gap-1.5">
                      <ShieldAlert size={14} className="animate-pulse" />
                      <span>Stop all running work</span>
                    </h4>
                    <p className="text-[11.5px] text-zinc-400 leading-normal font-sans">
                      Sends a stop to every channel in this workspace with live work, over the same transport as each Stop button. Runs already finished stay finished — this never rewrites history.
                    </p>
                    <button
                      onClick={() => {
                        const nextState = !emergencyKill;
                        setEmergencyKill(nextState);
                        if (nextState) {
                          try {
                            const state = useCrowdOSStore.getState();
                            const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
                            const liveIds = new Set<string>();
                            for (const ch of (ws?.channels ?? [])) liveIds.add(ch.id);
                            for (const cat of (ws?.categories ?? [])) {
                              for (const ch of (cat.channels ?? [])) liveIds.add(ch.id);
                            }
                            let stopped = 0;
                            for (const id of liveIds) {
                              try { state.cancelRun(id); stopped += 1; } catch {}
                            }
                            showError('Stop sent', stopped > 0 ? 'Stop requested on ' + stopped + ' channel' + (stopped === 1 ? '' : 's') + ' with live work.' : 'No live channels found — nothing was sent.');
                          } catch {}
                          } else {
                            showSuccess('System restored', 'Stop state cleared. New runs can start.');
                          }
                      }}
                      className={`px-3 py-1.5 rounded text-xs font-semibold transition select-none cursor-pointer focus:outline-none ${
                        emergencyKill 
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/15' 
                          : 'bg-rose-500/10 text-rose-450 border border-rose-500/25 hover:bg-rose-500/15'
                      }`}
                    >
                      {emergencyKill ? 'Resume agent work' : 'Stop all running work'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {workspaceSettingsTab === 'screen_lock' && (
              <div className="space-y-3">
                <ScreenLockSettingsPanel workspaceId={activeWS.id} />
                <div className="px-3 bg-zinc-900 border border-zinc-800 rounded-xl">
                  <AutostartToggle />
                </div>
              </div>
            )}

            {workspaceSettingsTab === 'mounts' && (
              <MountsInspector />
            )}

            {workspaceSettingsTab === 'storage' && (
              <StorageTab />
            )}

            {workspaceSettingsTab === 'diagnostics' && (
              <DiagnosticsTab />
            )}

            {workspaceSettingsTab === 'audit' && (
              <AuditTab />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  </motion.div>
</div>
)}
</AnimatePresence>

{/* Styled Confirmation Dialog */}
<ConfirmDialog
  open={confirmModal.open}
  title={confirmModal.title}
  description={confirmModal.description}
  confirmLabel={confirmModal.confirmLabel || 'Confirm'}
  cancelLabel={confirmModal.cancelLabel || 'Cancel'}
  isDanger={confirmModal.isDanger !== false}
  onConfirm={confirmModal.onConfirm}
  onCancel={() => {
    const cancel = confirmModal.onCancel;
    setConfirmModal(prev => ({ ...prev, open: false }));
    if (cancel) cancel();
  }}
/>
</>
);
}
