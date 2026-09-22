# Electron App QA Audit — Workspace / Category / Channel Creation

**Date:** 2026-09-23 (Asia/Jakarta)
**App:** CrowdOS desktop shell (@crowdspace/desktop 0.1.1, Electron 44, dev mode via npm run dev:electron)
**Role:** End-user + QA black-box audit, with DevTools protocol tracing and appdata verification
**Verdict:** Workspace creation **PASS** | Category creation **FAIL (silent data misfiling)** | Channel creation **FAIL (visible error)** — one shared root cause

---

## 1. Environment under test

| Item | Value |
|---|---|
| Launch chain | npm run dev:electron -> dev-electron.mjs (build -> Vite :22077 -> Electron with --inspect=9229, CROWDOS_DEV=1) |
| Embedded backend | Fastify on http://127.0.0.1:12077 (inline queue, DESKTOP_MODE=1) |
| Renderer | Vite dev server http://127.0.0.1:22077 loaded in the Electron window |
| Local appdata root | C:\Users\Asus\AppData\Roaming\@crowdspace\desktop |
| Workspace registry | <appdata>\workspaces\workspaces.json |
| Per-workspace store | <appdata>\workspaces\<Folder>\workspace.json + vfs\.crowdos\{categories,channels}.json |
| Postgres | postgresql-x64-18 service running on 127.0.0.1:5432; workspaces under test have databaseUrl "" -> local-file tier |

Method: drove the **real Electron window** through the Chrome DevTools Protocol (attached to the main-process inspector and the window webContents debugger) with real click/type events, captured renderer console/exceptions/network, then diffed the appdata files on disk after each step.

---

## 2. Flow 1 — Workspace Creation: **PASS**

**Steps (as end user):** Workspace dropdown -> "Leave Portal" -> confirm -> Portal -> name "QA Audit WS" -> "Create Local Workspace (no database)" -> auto-entered workspace.

**Result:**
- UI: sidebar header switched to "QA Audit WS", auto-entered, default **General** category + **general** channel seeded (createdBy system).
- Disk (verified):
  - workspaces.json gained a correct record: ws_b7a37ed7a6c1, folderName "QA Audit WS", rootPath ...\workspaces\QA Audit WS, fresh timestamps.
  - Folder created: workspace.json, vfs\.crowdos\categories.json, vfs\.crowdos\channels.json, vfs\agents\agent-default-assistant.json.
- Local tier written synchronously; no console errors; no 4xx/5xx.

**Minor observations (low severity):**
1. Portal DB URL field is not marked optional strongly enough; a first-run user may believe it is mandatory before noticing the local button. Cosmetic/onboarding.
2. Workspace creation bypasses the scoping bug below because it writes the registry directly; the bug hits **entity** creation (categories/channels/agents) only.

---

## 3. Flow 2 — Category Creation: **FAIL — silent mis-scoped write**

**Steps (as end user):** Workspace dropdown -> **Create Category** -> Workspace Settings opens on "Category & Channels" -> name "QA Operations" -> **Assemble Category**.

**Observed:** form accepts, POST /api/categories returns **201**, no toast, no error, modal stays open, **sidebar never shows the category**.

**Disk truth (the bug):**

    <appdata>\workspaces\default\vfs\.crowdos\categories.json   <- rows landed here (WRONG scope)
      "QA Operations" (x3 attempts, 3 duplicate rows)
      "QA Trace Cat"

    <appdata>\workspaces\QA Audit WS\vfs\.crowdos\categories.json  <- where it should live
      only "General" (system)

Repeated attempts created **duplicate rows in the default scope** (localCreateCategory has no duplicate-name guard, unlike channels). The user gets **no feedback** that anything went wrong.

### Root cause (proven end-to-end)

1. **Client:** packages/client/stores/crowdOsStore.ts uses its **own** fetchJsonOrThrow (line ~153) which does **not** inject the x-workspace-id header. (packages/client/src/api/client.ts -> buildHeaders() does inject it, but the store's createCategory/createChannel do not use that wrapper.)
2. **Server:** create-app.ts onRequest hook resolves the tenant **only** from the x-workspace-id header; absent header -> request.workspaceId = null.
3. **Service:** route passes workspaceId ?? null -> localCreateCategory / tierContextFor(null) fall back to DEFAULT_WORKSPACE_SCOPE = "default".
4. **Proof:** identical POST with header x-workspace-id: ws_b7a37ed7a6c1 -> **201** and the row is written into the correct workspace folder.

The client then refreshes (fetchWorkspaces), but list endpoints are equally mis-scoped for the active workspace, so the phantom category never appears — a perfectly "successful" failure.

---

## 4. Flow 3 — Channel Creation: **FAIL — visible 400 for every workspace**

**Path A (sidebar "+" on a category):** modal "Create channel in General" -> name "QA Smoke Tests" -> **Create Channel** ->

    POST /api/channels -> 400 Bad Request
    Error: Category not found: bfde4b67-56d7-4bd6-a066-7457f604e908
      at createChannel (crowdOsStore.ts:2937)   <- stack captured from DevTools
      at handleCreate (InlineChannelModal.tsx:53)

The category **does exist** in the active workspace, but the server checked the default scope (same root cause: no x-workspace-id header). Modal stays open; error toast shown. **Channel creation is broken for every portal-created workspace** in local mode.

**Path B (Settings -> "Scaffold Operational Channel"):** identical 400 with the bound category.

**Proof:** identical POST with the header -> **201**, row correctly persisted to QA Audit WS\vfs\.crowdos\channels.json.

Note: **category/channel DELETE works** because DELETE /:id scans **all** scopes (scopesFor(null) -> every registered workspace). Delete-works / create-broken is consistent with the same scoping asymmetry.

---

## 5. DevTools / logs — unwanted errors traced

Captured from the live renderer (CDP Runtime/Log/Network) during the whole session:

| # | Signal | Count | Assessment |
|---|---|---|---|
| 1 | GET /api/workspace/budget -> 501 Not Implemented + "Failed to load resource" console errors | recurring (every workspace refresh / channel switch) | **Unwanted.** Server-side this is the intentional local-mode guard (local-mode-guard.ts: budgets require a database). But the client calls fetchBudget() unconditionally after every fetchWorkspaces() even when the workspace has database.configured === false. Result: guaranteed console error spam in the default local experience. Fix: skip the call (or degrade to an empty state) when no DB is configured. |
| 2 | 400 Bad Request + "Failed to create channel." error with stack | every channel create attempt | Real defect (see section 4). |
| 3 | "[Socket] Authoritative runtime snapshot received" every ~15 s | continuous | Debug-level noise printed via console.log in the production dev shell. Should be console.debug / gated. |
| 4 | Uncaught page exceptions | **0** | Good — no crashes during any flow. |

### File-log gap (finding)

<appdata>\@crowdspace\desktop\logs\desktop.log **does not exist** and is never created. The desktop package documents a file log written via the crowdos:log:write IPC (ipc-handlers.ts implements it), but **no code in the client ever calls it**, and the main process itself does not write to it. All backend/Fastify/boot logs only go to the parent terminal stdout and vanish when the terminal closes. In a packaged build there is **no persistent log at all** — a support/ops gap.

**Recommendation:** wire crowdos:log:write into the renderer console/error funnels and tee the embedded backend stdout into logs\desktop.log (rotating, capped).

---

## 6. Blast radius of the scoping bug

The missing-tenant-header pattern is not limited to categories/channels:

- POST /api/agents -> agent-service.create -> localUpsertAgent({ workspaceId: input.workspaceId ?? null }) -> agent files written to <appdata>\workspaces\default\vfs\agents when no header is present. Same silent misfile risk.
- Message append paths resolve the owning workspace from the **channel row** (defense in depth worked here), so messages inherit the channel stored scope — but a channel created through the broken UI flow cannot exist at all, so chat in new workspaces is effectively blocked.
- Read paths that take an id (get/update/delete) scan all scopes, which is why single-entity edits/deletes "work" while create/list mis-scope — a confusing half-broken surface for users.

## 7. Recommended fixes (priority order)

1. **[P0]** In crowdOsStore.ts, route all API calls through the shared apiClient (or make its local fetchJsonOrThrow use buildHeaders() from src/api/client.ts) so x-workspace-id is always sent. Small fix; unblocks category + channel + agent creation.
2. **[P1]** Server hardening: in the local stores, **reject** writes when workspaceId is null for tenant-scoped entities instead of silently falling back to "default" (or log a loud warning). Silent fallback converts a bug into data corruption.
3. **[P1]** Add a duplicate-name guard to localCreateCategory (channels already have one) to stop duplicate accumulation.
4. **[P2]** Client: skip fetchBudget() when activeWS.database.configured === false; log the local-mode degrade once, not per refresh.
5. **[P2]** Implement the desktop file log (tee backend + renderer errors to logs\desktop.log) as documented in dev-electron.mjs / ipc-handlers.ts.
6. **[P3]** Demote the socket snapshot console.log spam.
7. **[P3]** Portal copy: clarify the DB URL is optional.

## 8. Repro (fast)

1. npm run dev:electron -> create a local workspace "X" in the portal.
2. Dropdown -> Create Category -> name "Y" -> Assemble Category -> silent 201, nothing appears.
3. Inspect %APPDATA%\@crowdspace\desktop\workspaces\default\vfs\.crowdos\categories.json -> "Y" is there.
4. Sidebar "+" -> channel name -> Create Channel -> error "Category not found: ..." (DevTools shows 400).

## 9. Test artifacts

- Screenshots: C:\Users\Asus\.codex\visualizations\2026\09\22\01a0ca96-8014-72f3-9c55-02031c5f606f\qa\shots\ (00 baseline, 01 after workspace create, 02 after category create, 03 re-entered Local Test).
- State left behind by the audit (deliberately not cleaned without approval):
  - Workspace **"QA Audit WS"** (ws_b7a37ed7a6c1) + folder in appdata.
  - Channel qa-header-probe-channel inside QA Audit WS (header-proof artifact).
  - 4 orphaned category rows in workspaces\default\vfs\.crowdos\categories.json ("QA Operations" x3, "QA Trace Cat").
  - "QA Probe Cat" was deleted via UI during delete-path verification.
  - The app was left running, back in the pre-existing **"Local Test"** workspace.

## 10. What was NOT covered (next audit passes)

DB-backed (dual-tier) workspaces via the Portal DB flow, message send/receive, agent creation via UI (verified only at code level), screen lock, deep links, packaged (npm run dist) build, updater, tray.

---

*Prepared by CodeBuddy QA audit session. No repository source files were modified; this report is the only file added to the project root.*
