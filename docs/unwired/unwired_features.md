# Unwired Features Specification

> **Date:** 2026-05-24
> **Purpose:** Document features and APIs that are implemented on one side of the stack (Backend/Frontend) but remain unwired or mocked on the other side. This serves as a bridging roadmap.

## 1. Virtual Filesystem (VFS) and Sandbox
**Status:** Mismatched Implementation
- **Backend:** Fully implemented `local-vfs.ts` connected to `workspace_nodes` and `artifacts` tables in PostgreSQL. Enforces path traversal safety and MIME typing.
- **Frontend:** The `FileExplorer` component (`components/workspace/file-explorer.tsx`) currently renders a **Mock** file tree (e.g., hardcoded `src/`, `public/`, `package.json`).
- **Gap to Wire:**
  - Need to create REST endpoints (e.g., `/api/workspace/files/*`) in the backend to expose VFS `list()`, `read()`, `write()`, etc.
  - Frontend `FileExplorer` needs to be wired to fetch the actual directory structure from the backend and save edits via the API instead of relying on the mockup.

## 2. Missing Socket Events in Frontend Store
**Status:** Backend emitting, Frontend ignoring
- **Backend Emits:**
  - `agent:spawned` (pairs spawned)
  - `agent:despawned`
  - `agent:paused`
  - `runtime:override`
  - `runtime:state`
  - `escalation` (L3 -> L2 -> L1 escalations)
- **Frontend Listens To:** Only `message:new`, `message:stream`, `agent:status`, `agent:thinking`, `workspace:sync`, and budget warnings.
- **Gap to Wire:**
  - The Zustand store (`stores/crowd-os-store.ts`) must add listeners for the missing events.
  - `agent:spawned` and `agent:paused` should update the right sidebar roster and UI badges without requiring a full workspace re-fetch.
  - `escalation` should trigger the `governance` style message or system alerts.
  - `runtime:state` and `runtime:override` should visually reflect active patches in the `AgentProfileModal`.

## 3. Discrepancy in Modules Ecosystem
**Status:** Frontend missing types
- **Backend Schema:** Contains 5 identity-driven module tables: `ModelModule`, `InstructionModule`, `ToolkitModule`, **`ConstraintsModule`**, and **`CapabilitiesModule`**.
- **Frontend Store & UI:** Only supports `ModelModule`, `InstructionModule`, and `ToolkitModule`. Settings tabs (`model_cards`, `skills_manager`) only offer CRUD for these three.
- **Gap to Wire:**
  - Frontend needs to add state slices and UI forms in the `WorkspaceSettingsModal` for `ConstraintsModule` and `CapabilitiesModule`.
  - Agent creation/editing forms must be updated to include references to these missing module IDs.

## 4. Roles vs. Direct Permissions
**Status:** Frontend Mock vs Backend Schema Mismatch
- **Frontend:** Has a full `roles` state slice containing drag-to-reorder roles, 32 color labels, and 10 permission toggles.
- **Backend:** There is **no `roles` table** in the schema. Permissions are stored directly on the `agents` table as `permissions jsonb`, and authority is managed via an integer `authority_level`.
- **Gap to Wire:**
  - Architectural decision required: Either add a `roles` table to the backend schema and associate agents via `role_id` (FK), or remove the `Roles` tab from the frontend settings and move the permission toggles directly into the Agent edit form to match the backend JSONB implementation.

## 5. Spawning, Tasks, and Artifacts
**Status:** Backend heavily structured, Frontend lacks dashboards
- **Backend:** Robust handling of `spawn_requests`, `task_files`, and `scheduled_tasks` via `AgentSpawnManager`.
- **Frontend:** Renders `DelegationMessage` cards nicely, but has no dedicated UI for monitoring active tasks, viewing artifacts produced by workers (`artifacts` table), or manually scheduling/spawning tasks.
- **Gap to Wire:**
  - Need API endpoints to list active/failed `spawn_requests` and `artifacts`.
  - Frontend needs a "Task Manager" or "Artifacts" view (perhaps in the right sidebar or a new modal) to browse worker outputs.

## 6. Legacy Providers Configuration
**Status:** Partial Deprecation / Unused UI
- **Backend:** Supports `/api/providers/generation`, `/embedding`, and `/indexing`.
- **Frontend:** Only loosely references generation models. Embedding and indexing provider setups are not exposed in the UI.
- **Gap to Wire:**
  - If the project is migrating entirely to `ModelModule` for all generations, the legacy providers endpoint should be formally deprecated. If `embedding` and `indexing` models still need configuration (e.g., for `IndexBuilder`), the frontend Settings needs an "Advanced Providers" tab to manage them.

## 7. Memory and Indexing Diagnostics
**Status:** Backend invisible to user
- **Backend:** Actively tracks `channel_index` and `compressed_summaries` for cross-channel context retrieval and memory compression.
- **Frontend:** Users cannot see memory usage, compression thresholds, or force a re-index.
- **Gap to Wire:**
  - Expose memory stats and compression summaries in the Agent Profile or Channel Settings.
  - Add a "Force Re-index" button in Channel Settings (calling a new backend endpoint).
