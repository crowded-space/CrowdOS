import React, { useState, useRef, useEffect } from 'react';
import { Folder, FolderOpen, File, FileText, Image as ImageIcon, ChevronRight, ChevronDown, Terminal, FileCode2, Package, Search, Sparkles, Code2, Database, Loader2 } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
import { useToast } from '@/components/ui/toast-provider';

const BACKEND_URL = '';

export interface VfsNode {
  name: string;
  path: string;
  type: 'folder' | 'file';
  ext?: string;
  size?: number;
}

const getFileIcon = (ext?: string) => {
  switch (ext) {
    case 'tsx':
    case 'ts':
      return <FileCode2 size={14} className="text-blue-400" />;
    case 'json':
      return <Package size={14} className="text-yellow-400" />;
    case 'css':
      return <FileCode2 size={14} className="text-pink-400" />;
    case 'svg':
    case 'ico':
    case 'png':
      return <ImageIcon size={14} className="text-purple-400" />;
    case 'md':
      return <FileText size={14} className="text-zinc-400" />;
    default:
      return <File size={14} className="text-zinc-500" />;
  }
};

const FileTreeNode: React.FC<{ 
  node: VfsNode, 
  level?: number, 
  selectedFile?: string,
  activeWorkspaceId?: string | null,
  onSelectFile?: (node: VfsNode) => void 
}> = ({ node, level = 0, selectedFile, activeWorkspaceId, onSelectFile }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [children, setChildren] = useState<VfsNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const toggleOpen = async () => {
    if (node.type === 'file') return;
    
    if (!isOpen && children.length === 0) {
      setIsLoading(true);
      try {
        const res = await fetch(`${BACKEND_URL}/api/workspace/files?path=${encodeURIComponent(node.path)}&workspaceId=${activeWorkspaceId || 'default'}`);
        if (res.ok) {
          const data = await res.json();
          setChildren(data.map((n: any) => ({
            name: n.name,
            path: n.path,
            type: n.type === 'directory' ? 'folder' : 'file',
            ext: n.name.split('.').pop(),
            size: n.size
          })));
        }
      } catch (err) {
        console.error("Failed to fetch dir:", node.path, err);
      } finally {
        setIsLoading(false);
      }
    }
    setIsOpen(!isOpen);
  };

  if (node.type === 'folder') {
    return (
      <div className="select-none">
        <button
          onClick={toggleOpen}
          className="w-full flex items-center gap-2 py-2.5 px-2 hover:bg-zinc-900/60 rounded-xl cursor-pointer transition text-zinc-300 hover:text-zinc-100 text-left touch-manipulation active:scale-[0.99]"
          style={{ paddingLeft: `${ level * 14 + 10 }px` }}
        >
          <span className="w-6 h-6 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
            {isLoading ? (
              <Loader2 size={11} className="text-zinc-500 animate-spin" />
            ) : isOpen ? (
              <ChevronDown size={11} className="text-zinc-500" />
            ) : (
              <ChevronRight size={11} className="text-zinc-500" />
            )}
          </span>
          {isOpen ? <FolderOpen size={15} className="text-indigo-400 shrink-0" /> : <Folder size={15} className="text-indigo-400/80 shrink-0" />}
          <span className="text-[13px] font-medium tracking-[-0.01em] truncate">{node.name}</span>
        </button>
        {isOpen && children.length > 0 && (
          <div className="flex flex-col gap-0.5 mt-0.5">
            {children.map((child, i) => (
              <FileTreeNode key={i} node={child} level={level + 1} selectedFile={selectedFile} activeWorkspaceId={activeWorkspaceId} onSelectFile={onSelectFile} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isSelected = selectedFile === node.path;

  return (
    <button
      onClick={() => onSelectFile && onSelectFile(node)}
      className={`group w-full flex items-center gap-2.5 py-2.5 px-2 rounded-xl cursor-pointer transition select-none text-left touch-manipulation active:scale-[0.99] ${
        isSelected 
          ? 'bg-indigo-600 text-white shadow-md border border-indigo-500/20' 
          : 'hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 border border-transparent'
      }`}
      style={{ paddingLeft: `${ level * 14 + 30 }px` }}
    >
      <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border ${isSelected ? 'bg-white/15 border-white/20' : 'bg-zinc-900 border-zinc-800'}`}>
        {getFileIcon(node.ext)}
      </span>
      <span className={`text-[13px] tracking-[-0.01em] truncate font-sans ${isSelected ? 'font-semibold' : ''}`}>{node.name}</span>
    </button>
  );
};

export default function FileExplorer() {
  const { selectedSandboxFile, setSelectedSandboxFile, activeWorkspaceId, vfsRevision } = useCrowdOSStore();
  const { showSuccess } = useToast();
  const [rootNodes, setRootNodes] = useState<VfsNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchRoot = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/workspace/files?path=/&workspaceId=${activeWorkspaceId || 'default'}`);
      if (res.ok) {
        const data = await res.json();
        setRootNodes(data.map((n: any) => ({
          name: n.name,
          path: n.path,
          type: n.type === 'directory' ? 'folder' : 'file',
          ext: n.name.split('.').pop(),
          size: n.size
        })));
      } else {
        setErrorMsg(`HTTP Error: ${res.status}`);
        console.error("Failed to fetch root nodes", res.status);
      }
    } catch (err: any) {
      setErrorMsg(`Fetch Error: ${err.message}`);
      console.error("VFS fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRoot();
  }, [activeWorkspaceId, vfsRevision]);

  const handleSelectFile = (node: VfsNode) => {
    setSelectedSandboxFile(node.path);
  };

  return (
    <div className="flex flex-col h-full bg-[#0c0c0f]">
      {/* Title */}
      <div className="px-4 py-3.5 border-b border-zinc-900 flex items-center justify-between shrink-0 select-none">
        <h2 className="text-[11px] font-mono tracking-[0.07em] font-bold text-zinc-400 flex items-center gap-2 uppercase">
          <span className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <Terminal size={12} className="text-zinc-500" />
          </span>
          Sandbox
        </h2>
        <div className="flex items-center gap-1.5">
          <button 
            onClick={() => {
              fetchRoot();
              showSuccess('Refreshed', 'VFS File Tree synced.');
            }} 
            className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 flex items-center justify-center transition cursor-pointer focus:outline-none active:scale-95 touch-manipulation"
            title="Refresh File Tree"
          >
            <Search size={14} />
          </button>
          <button 
            onClick={() => useCrowdOSStore.getState().setRightSidebarOpen(true)} 
            className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 flex items-center justify-center transition cursor-pointer focus:outline-none active:scale-95 touch-manipulation"
            title="Close Sandbox (Back to Agent Roster)"
          >
            <span className="text-[11px] font-mono font-bold">✕</span>
          </button>
        </div>
      </div>

      {/* Action Bar */}
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-zinc-900 bg-zinc-900/30 shrink-0">
        <div className="flex -space-x-1.5">
          <div className="w-6 h-6 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center z-10 shadow-sm" title="Sparrow Runner active">
             <Sparkles size={11} className="text-indigo-400" />
          </div>
          <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shadow-sm" title="Code indexing">
             <Code2 size={11} className="text-emerald-400" />
          </div>
        </div>
        <span className="text-[11px] text-zinc-400 font-sans truncate font-medium">Sandbox live sync</span>
        <span className="ml-auto w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)] animate-pulse" />
      </div>

      {/* File Tree */}
      <div className="flex-1 overflow-y-auto w-full py-2 px-1 scrollbar-thin">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-xs text-zinc-500 animate-pulse">
            Connecting...
          </div>
        ) : errorMsg ? (
          <div className="flex items-center justify-center h-full text-xs text-red-500 text-center px-4">
            {errorMsg}
          </div>
        ) : rootNodes.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-zinc-500">
            Empty Workspace
          </div>
        ) : (
          rootNodes.map((node, i) => (
            <FileTreeNode key={i} node={node} selectedFile={selectedSandboxFile || undefined} activeWorkspaceId={activeWorkspaceId} onSelectFile={handleSelectFile} />
          ))
        )}
      </div>
      
      {/* Footer Info */}
      <div className="p-3 border-t border-zinc-900 bg-zinc-950/30 shrink-0">
        <div className="flex items-center justify-between text-[10px] text-zinc-500 font-mono">
          <div className="flex items-center gap-1">
            <Database size={10} />
            <span>VFS Connected</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Re-export for compatibility with main-chat-area
export const mockFileContent: Record<string, string> = {
  'main.tsx': 'import React from "react";\nimport ReactDOM from "react-dom";\n\nReactDOM.render(<App />, document.getElementById("root"));',
  'App.tsx': 'export default function App() {\n  return <div>Hello World</div>;\n}',
};

export const SimpleSyntaxHighlighter: React.FC<{ code: string; editable?: boolean }> = ({ code, editable }) => {
  return (
    <textarea 
      className="w-full h-full bg-transparent text-zinc-300 font-mono text-xs resize-none focus:outline-none p-2"
      defaultValue={code}
      readOnly={!editable}
    />
  );
};
