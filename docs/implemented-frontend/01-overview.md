# Frontend Overview — CrowdOS

> **Package:** \packages/client\
> **Type:** Reverse-engineered implementation spec
> **Tech Stack:** React 19, TypeScript, Vite 6, Zustand 5, Socket.io, Tailwind CSS v4, Framer Motion, Lucide

---

## 1. File Structure

packages/client/
├── index.html
├── package.json / tsconfig.json / vite.config.ts
├── public/                    # Static logos
├── src/
│   ├── main.tsx               # React entry (StrictMode -> App)
│   ├── App.tsx                 # State-driven router (portal vs workspace)
│   ├── index.css               # Tailwind v4 + theme + 6 animations
│   └── config/socket.ts        # Socket.io client -> localhost:3001
├── types/crowd-os.ts           # All interfaces (168 lines)
├── stores/crowd-os-store.ts    # Monolithic Zustand store (1599 lines)
└── components/
    ├── portal/WorkspacePortal.tsx       # Onboarding/DB connect
    ├── ui/crow-icon.tsx                 # SVG crow (8 variants)
    └── workspace/
        ├── workspace-sidebar.tsx        # Channel tree + user bar
        ├── workspace-dropdown.tsx       # Workspace menu
        ├── main-chat-area.tsx           # Chat panel + composer
        ├── right-sidebar.tsx            # Roster + telemetry
        ├── file-explorer.tsx            # Sandbox file tree + editor
        ├── messages/ (8 files)          # Message type renderers
        ├── modals/ (2 files)            # Agent profile + Settings
        ├── settings/model-cards-tab.tsx # Model module CRUD
        ├── mobile/ (2 files)            # Bottom nav + drawer
        └── ui/ (2 files)                # Status dot + badge

**28 source files total** (.ts/.tsx)

---

## 2. Dependencies

react ^19.0.1 | react-dom ^19.0.1 | zustand ^5.0.13
socket.io-client ^4.8.1 | lucide-react ^0.546.0 | motion ^12.23.24
tailwindcss ^4.1.14 | @tailwindcss/vite ^4.1.14
@vitejs/plugin-react-swc ^4.3.1 | vite ^6.3.0

### Commands
- npm run dev     -> Vite on :3000 (proxies /api and /socket.io to :3001)
- npm run build   -> Production build
- npm run lint    -> tsc --noEmit

---

## 3. Routing (State-Driven, No Router Library)

activeWorkspaceId === null  -> WorkspacePortal (onboarding)
activeWorkspaceId !== null  -> 3-panel layout + modals

### Modals
- agentProfileModalOpen  -> AgentProfileModal
- settingsModalOpen      -> WorkspaceSettingsModal (8 tabs)

### Settings Tabs (workspaceSettingsTab state)
overview      | Workspace stats, agent/channel counts
agents        | Full CRUD + presets + import/export JSON
roles         | Drag-reorder, 32 colors, 10 permission toggles
tools         | 5 tool enable/disable toggles
model_cards   | ModelModule CRUD + test connection
skills_manager| InstructionModule + ToolkitModule CRUD + agent linking
channels      | Category/channel CRUD, reorder, archive/restore
safety        | Budget bar, per-provider caps, kill switch

### Mobile
- BottomNav: Channels (left drawer), Agents (right drawer), Settings (modal)
