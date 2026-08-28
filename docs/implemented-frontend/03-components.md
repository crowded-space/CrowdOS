# Component Specification

---

## 1. WorkspacePortal (279 lines)

**File:** \components/portal/WorkspacePortal.tsx\

Onboarding gate. User enters PostgreSQL URL, tests connection (POST /api/workspace/database), picks a name + icon (8 crow variants), creates workspace. Shows existing workspaces for quick re-entry.

State: testStatus (idle/testing/success/failed), logs[], workspaceName, selectedIcon, dbUrl

---

## 2. WorkspaceSidebar (164 lines)

**File:** \components/workspace/workspace-sidebar.tsx\

Left panel (245px). Top: WorkspaceDropdown. Middle: top-level channels + categorized/channel tree with collapse, unread badges, mention dots. Bottom: user profile (Juan Hamzah) with settings button.

---

## 3. WorkspaceDropdown (112 lines)

**File:** \components/workspace/workspace-dropdown.tsx\

Animated dropdown (motion). Items: Workspace Settings, Create Category, Copy Workspace ID, Leave Space Portal. Click-outside-auto-close via useEffect.

---

## 4. MainChatArea (647 lines)

**File:** \components/workspace/main-chat-area.tsx\

Central chat panel. Contains:
- Channel header (name, desc, trash, bell, roster/sandbox toggle)
- Message list with grouping (same author, <5min apart)
- @mention autocomplete (detected via selectionStart)
- Composer: mentions chips, attachment chips, textarea, attachment popover (files, recent, image gen, research, web search), send button
- Sandbox code preview popup (expandable, editable)
- File drag-and-drop support
- Empty channel placeholder state

---

## 5. RightSidebar (277 lines)

**File:** \components/workspace/right-sidebar.tsx\

Togglable (roster vs sandbox). Roster: agents grouped by tier (L0-L3), status dots, click to profile. Telemetry dashboard: tokens, cost, active agents, channels, CH/GL toggle. Uses motion AnimatePresence for switching.

---

## 6. FileExplorer (284 lines)

**File:** \components/workspace/file-explorer.tsx\

Mock file tree (src/, public/, package.json, etc.). Recursive FileTreeNode with folder open/close, file icons by extension. SimpleSyntaxHighlighter: textarea overlay on syntax-highlighted pre, line numbers, inline editing.

---

## 7. Message Components

### Message (90 lines) — Router
Routes by \message.type\: human -> HumanMessage, agent -> AgentMessage, system -> SystemMessage, delegation -> DelegationMessage, tool_execution -> ToolExecutionMessage, governance -> styled alert

### HumanMessage (52 lines)
Amber left border, amber operator badge, mention tags, attachments

### AgentMessage (106 lines)
Level-themed avatar border + badge, monologue toggle (Eye/EyeOff), MentionParser, attachments

### SystemMessage (25 lines)
Centered terminal-style, monospace

### DelegationMessage (84 lines)
From->To arrow card, task directive, tokens/cost, status badge (pending/executing/completed/failed)

### ToolExecutionMessage (78 lines)
Collapsible card: tool name, input schematics, output, duration, success/error

### MentionParser (41 lines)
Regex @Mention -> styled pills (amber for user, indigo for agents)

### AttachmentsView (154 lines)
Image cards with lightbox + download, file cards with download. Grid layout.

---

## 8. AgentProfileModal (472 lines)

Banner gradient (level-themed), floating avatar + status, identity, description, 3 module assembly cards, active overrides list with toggle/delete, PATCH RUNTIME collapsible panel (instruction/model/toolkit patch forms), hierarchy chain (parent + subordinates), DM composer.

---

## 9. WorkspaceSettingsModal (2431 lines)

Left nav (8 tabs), right content panel. Massive CRUD for everything. Key sub-sections:
- **Agents**: Presets (CEO/Manager/Coder/QA/Writer), full form, validation, table with duplicate/export/edit/delete/import
- **Roles**: Drag-reorder, 32 colors, 10 permissions with toggle switches
- **Tools**: 5 tool cards with enable/disable toggles + usage counts
- **Channels**: Create category + channel forms, structured listings, reorder, archive/restore
- **Safety**: Token budget bar (green->amber->red), soft cap editor, per-provider budgets, reset, emergency kill switch

---

## 10. Small Utility Components

### crow-icon.tsx (136 lines)
SVG crow path. 8 variants: white-rounded, dark-rounded, indigo-circle, amber-cyber, cyan-radar, rose-governance, matrix-terminal, cosmos. Also exports CrowdOSWordmark and CrowdOSFullLogo (img tags).

### presence-indicator.tsx (44 lines)
Colored dot (OKLCH colors) - 3 sizes (sm/md/lg), 6 statuses

### status-badge.tsx (52 lines)
Full badge: dot + label + border, OKLCH colors

### bottom-nav.tsx (54 lines)
Mobile bottom bar: Channels, Agents, Settings (desktop hidden via md:hidden)

### mobile-drawer.tsx (45 lines)
Slide-in overlay (left/right) with backdrop blur, close button, 245px width
