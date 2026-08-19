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
        <div 
          className="flex items-center gap-1.5 py-1 px-2 hover:bg-zinc-900/60 rounded-md cursor-pointer transition text-zinc-300 hover:text-zinc-100"
          style={{ paddingLeft: `${ level * 12 + 8 }px` }}
          onClick={toggleOpen}
        >
          {isLoading ? (
            <Loader2 size={14} className="text-zinc-500 animate-spin" />
          ) : isOpen ? (
            <ChevronDown size={14} className="text-zinc-500" />
          ) : (
            <ChevronRight size={14} className="text-zinc-500" />
          )}
          {isOpen ? <FolderOpen size={14} className="text-indigo-400" /> : <Folder size={14} className="text-indigo-400/80" />}
          <span className="text-xs font-medium tracking-tight truncate">{node.name}</span>
        </div>
        {isOpen && children.length > 0 && (
          <div className="flex flex-col">
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
    <div 
      onClick={() => onSelectFile && onSelectFile(node)}
      className={`group flex items-center justify-between py-1 px-2 rounded-md cursor-pointer transition select-none ${
        isSelected 
          ? 'bg-indigo-500/15 text-zinc-200 shadow-sm' 
          : 'hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-200'
      }`}
      style={{ paddingLeft: `${ level * 12 + 28 }px` }}
    >
      <div className="flex items-center gap-2 min-w-0">
        {getFileIcon(node.ext)}
        <span className={`text-xs tracking-tight truncate font-sans ${isSelected ? 'font-medium' : ''}`}>{node.name}</span>
      </div>
    </div>
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
    <div className="flex flex-col h-full bg-[#0c0c0e]/95">
      {/* Title */}
      <div className="p-3.5 border-b border-zinc-900 flex items-center justify-between shrink-0 select-none">
        <h2 className="text-[10.5px] font-mono tracking-wider font-bold text-zinc-550 flex items-center gap-1.5 uppercase">
          <Terminal size={12} className="text-zinc-550" />
          <span>Workspace Sandbox</span>
        </h2>
        <div className="flex items-center gap-1">
          <button 
            onClick={() => {
              fetchRoot();
              showSuccess('Refreshed', 'VFS File Tree synced.');
            }} 
            className="text-zinc-500 hover:text-zinc-300 p-1 hover:bg-zinc-800 rounded transition cursor-pointer focus:outline-none"
            title="Refresh File Tree"
          >
            <Search size={12} />
          </button>
          <button 
            onClick={() => useCrowdOSStore.getState().setRightSidebarOpen(true)} 
            className="text-zinc-500 hover:text-zinc-200 p-1 hover:bg-zinc-800 rounded transition cursor-pointer focus:outline-none"
            title="Close Sandbox (Back to Agent Roster)"
          >
            <span className="text-xs font-mono font-bold px-1 text-zinc-400 hover:text-white">✕</span>
          </button>
        </div>
      </div>

      {/* Action Bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-900 bg-zinc-950/50 shrink-0">
        <div className="flex -space-x-1">
          <div className="w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center z-10" title="Sparrow Runner active">
             <Sparkles size={10} className="text-indigo-400" />
          </div>
          <div className="w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center" title="Code indexing">
             <Code2 size={10} className="text-emerald-400" />
          </div>
        </div>
        <span className="text-[10px] text-zinc-500 font-mono truncate">Sandbox live sync</span>
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
