# Desktop Shell Delta

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose
Reference description of the Discord **Electron main-process shell** as an implementation source for CrowdOS's own Electron shell (`packages/desktop`), plus an explicit version delta between the analysed shell (1.0.9262) and the installed client (1.0.9264). Window/tray/menu/protocol/IPC structure is in scope; visual style is not.
## How it works
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

### Version delta (state explicitly)
| Item | Analysed shell | Installed client |
| --- | --- | --- |
| Version | **1.0.9262** (extracted `app.asar`) | **1.0.9264** (`app.asar` sha256 `0025c02c7241045a12464309604ec4d5b8ec7ed2ce43cce05d5dacb8f253f672`) |
| Package description | `"Discord Client for Desktop - Bootstrapper"` | — |
| Entry | `"main": "bundle.js"` | — |
| Electron (declared) | devDependency `electron: 42.7.1` | runtime reports **Electron 42.11.15** (`ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461`) |
| Chromium | — | **148.0.7778.280** (same evidence) |
| Native addons in the app folder | not present in the 1.0.9262 extraction | `updater.node` (4,550,072 B) and `discord_wer.dll` (451,512 B) |
| `Discord.exe` | — | 219,700,152 B, sha256 `a3b0cf011eb75f568963fd0942648455e125b030b4b578fec652dc0b4e747561` (`ev_0e5a620c465f50fc5deddd43770a59450773aac1a68ebbf4c8118cba092c986d`) |

**Critical scope correction**: [Observed] the extracted 1.0.9262 `bundle.js` is the **bootstrapper**, not the full application host. `package.json` names it `"Discord Client for Desktop - Bootstrapper"`. It creates only a **splash window**; [Inferred] the real application window, its BrowserWindow options, its tray, and its window-state persistence are **not present in this artifact** (see Gaps). Everything below describes the bootstrapper's own main-process implementation, which is a complete and self-contained shell stage in its own right (splash, updater, protocol registration, crash reporter, IPC).

## Structural inventory
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

### BrowserWindow — the only window in the artifact (splash)
| Option | Value | Evidence |
| --- | --- | --- |
| `width` | `300` | `bundle.js` @ `91449` `windowConfig={width:300,height:LOADING_WINDOW_HEIGHT,...}` |
| `height` | `LOADING_WINDOW_HEIGHT` (module constant) | same |
| `transparent` | `false` | same |
| `frame` | `false` (frameless) | same |
| `resizable` | `false` | same |
| `center` | `true` | same |
| `show` | `false` (shown later) | same |
| `webPreferences.nodeIntegration` | `false` | same |
| `webPreferences.sandbox` | **`false`** | same |
| `webPreferences.contextIsolation` | `true` | same |
| `webPreferences.preload` | `path.join(__dirname,"splashScreenPreload.js")` | same |
| `webPreferences.additionalArguments` | `` [`--splash-media-format=${useWebp?"webp":"webm"}`] `` | same |
| `vibrancy` / `titleBarStyle` / `backgroundColor` | **not used** (0 occurrences) | census over `bundle.js` |
| `ready-to-show` | **not used** (0 occurrences) | census over `bundle.js` |
| `minWidth` / `minHeight` | **not used** (0 occurrences) | census over `bundle.js` |
| Window-state persistence | not applicable (fixed 300×N splash) | census |

Splash window hardening:
- [Observed] `splashWindow.webContents.on("will-navigate",e=>e.preventDefault())` — navigation inside the splash is blocked.
- [Observed] `splashWindow.webContents.setWindowOpenHandler(details=>((0,securityUtils_1.saferShellOpenExternal)(details.url),setTimeout(electron_1.app.quit,500),{action:"deny"}))` — popups are **denied**; the URL is handed to the OS browser, then the app quits after 500 ms.
- [Observed] `splashWindow.loadURL(url.format({protocol:"file",slashes:!0,pathname:path.join(__dirname,"splash","index.html")}))`.
- [Observed] `console-message` is piped to `logger.ipcMainRendererLogger`; `did-fail-load` and `preload-error` are logged.

### Tray
- [Observed] **No tray is created.** `Tray` = 0 occurrences, `new Tray` = 0 occurrences, `tray` = 4 occurrences — all of them unrelated (`getKnownFolder("programs")` stray-path cleanup, shortcut update). The only `tray` literal inside a window-creation path is the Sentry screenshot integration enumerating `BrowserWindow.getAllWindows()`.

### Application menu
- [Observed] A native `Menu` **is** built, from a per-platform template module.

| Platform | Template | Evidence |
| --- | --- | --- |
| macOS | `[{label:"Discord",submenu:[{label:"Quit",click:()=>app.quit(),accelerator:"Command+Q"}]}]` | `bundle.js` @ `106075` region |
| Windows / Linux | `[{label:"&File",submenu:[{label:"&Exit",click:()=>app.quit(),accelerator:"Control+Q"}]}]` | `bundle.js` @ `106075` region |
| Build | `module.exports = electron_1.Menu.buildFromTemplate(menu)` where `menu = __webpack_require__(80345)("./"+process.platform)` | same |

- [Observed] The menu is a **quit-only** menu: one accelerator, no edit/view/window submenus.

### Global shortcuts / summon hotkey
- [Observed] **None.** `globalShortcut.register` = 0 occurrences; `globalShortcut` is not referenced. There is no global summon hotkey in this shell stage. (Shortcut *files* are updated via `updateShortcuts(updater)` — an installer artefact, not a runtime hotkey.)

### Preload / bridge surface
| Preload | Exposed to the page | Notes |
| --- | --- | --- |
| `splashScreenPreload.js` (9,333 B) | **Nothing via `contextBridge`.** The preload uses `ipcRenderer` directly in its own isolated context | `splashScreenPreload.js` lines 1–30: `electron_1.ipcRenderer.send(...)`, `electron_1.ipcRenderer.on(...)`, `electron_1.ipcRenderer.invoke(...)` |

Splash preload behaviour:
- [Observed] Reads its media format from `process.argv` (`--splash-media-format=webp|webm`).
- [Observed] Renders the splash DOM imperatively into `#splash-mount` (`mount.innerHTML = ...`).
- [Observed] Progress states: `checking-for-updates`, `downloading-updates`, `installing-updates`, `update-failure`, `launching`, `update-manually`.
- [Observed] Countdown timer: `setInterval(..., 1e3)` for the retry countdown.
- [Observed] Linux manual-download fallback: `LINUX_DOWNLOAD_URL_BASE = https://discord.com/api/download/${releaseChannel}?platform=linux&format=` with `DOWNLOAD_OPTIONS = [{value:"deb",label:"Ubuntu (deb)"},{value:"tar.gz",label:"Linux (tar.gz)"},{value:"nope",label:"I'll figure it out"}]`.
- [Observed] External open is guarded by the same `saferShellOpenExternal` as the main process.

Context-bridge surfaces installed by the main bundle into the renderer:
| Global | Purpose | Evidence |
| --- | --- | --- |
| `__SENTRY_IPC__` | Sentry renderer→main transport (`start`, `sendScope`, `sendEnvelope`, `sendStatus`, `sendStructuredLog`, `sendMetric`) | `bundle.js` @ `1647548` `electron.contextBridge.exposeInMainWorld("__SENTRY_IPC__",window.__SENTRY_IPC__)` |
| `__electronLog` | `electron-log` renderer→main log shipper (`sendToMain`) | `bundle.js` @ `2246118` `contextBridge.exposeInMainWorld("__electronLog",electronLog)` |

### IPC channels
- [Observed] Two naming schemes coexist.

**Scheme A — `DISCORD_` prefix (application IPC).** [Observed] A wrapper module normalises every channel: `let discordPrefixRegex=/^DISCORD_/;function getDiscordIPCEvent(ev){return discordPrefixRegex.test(ev)?ev:`DISCORD_${ev}`}` and exposes `{on, removeListener, handle}` over `ipcMain` / `ipcRenderer` (`bundle.js` @ `52852`).

| Channel | Direction | Purpose | Evidence |
| --- | --- | --- | --- |
| `DISCORD_SPLASH_SCREEN_READY` | renderer → main | splash DOM is ready; main records `performance.mark("splash-screen-ready")` | `bundle.js` `ipcMain_1.default.on("SPLASH_SCREEN_READY",...)`; `splashScreenPreload.js` `ipcRenderer.send("DISCORD_SPLASH_SCREEN_READY")` |
| `DISCORD_SPLASH_SCREEN_QUIT` | renderer → main | quit the bootstrapper | `bundle.js` `ipcMain_1.default.on("SPLASH_SCREEN_QUIT",()=>{...app.quit()})`; preload `ipcRenderer.send("DISCORD_SPLASH_SCREEN_QUIT")` |
| `DISCORD_UPDATED_QUOTES` | renderer → main | new splash quotes; main writes `quotes.json` under `getUserData()` | `bundle.js` `ipcMain_1.default.on("UPDATED_QUOTES",(_event,quotes)=>{...fs.writeFile(quoteCachePath,JSON.stringify(quotes1),...)})` |
| `DISCORD_SPLASH_UPDATE_STATE` | main → renderer | updater state pushed to the splash | `splashScreenPreload.js` `ipcRenderer.on("DISCORD_SPLASH_UPDATE_STATE",(_,state)=>{...})` |
| `DISCORD_SPLASH_SCREEN_QUOTE` | main → renderer | quote payload | `splashScreenPreload.js` `ipcRenderer.on("DISCORD_SPLASH_SCREEN_QUOTE",...)` |
| `DISCORD_GET_BUILD_OVERRIDE_STATUS` | renderer → main (invoke) | read the build-override cookie | `splashScreenPreload.js` `ipcRenderer.invoke("DISCORD_GET_BUILD_OVERRIDE_STATUS")` |
| `DISCORD_CLEAR_BUILD_OVERRIDE` | renderer → main (invoke) | clear the build-override cookie | `splashScreenPreload.js` `ipcRenderer.invoke("DISCORD_CLEAR_BUILD_OVERRIDE")` |
| `__ELECTRON_LOG__` | renderer → main | `electron-log` payload (not `DISCORD_`-prefixed) | `bundle.js` @ `2246118` `ipcRenderer.send("__ELECTRON_LOG__",{cmd:"errorHandler",...})` |

**Scheme B — namespaced Sentry IPC.** [Observed] `ipcChannelUtils(namespace)` produces `createKey: channel => `${namespace}.${channel}`` and `createUrl: channel => `${namespace}://${channel}/sentry_key``.

| Key family | Direction | Purpose | Evidence |
| --- | --- | --- | --- |
| `<ns>.start` | renderer → main | register the renderer as a known Sentry renderer (`KNOWN_RENDERERS` set keyed by `sender.id`) | `ipcMain.on(ipcUtil.createKey("start"),({sender})=>{...})` |
| `<ns>.scope` | renderer → main | push a Sentry scope | `ipcMain.on(ipcUtil.createKey("scope"),(_,jsonScope)=>handleScope(options,jsonScope))` |
| `<ns>.envelope` | renderer → main | push a Sentry envelope | `ipcMain.on(ipcUtil.createKey("envelope"),({sender},env)=>...)` |
| `<ns>.structured-log` | renderer → main | structured log record | `ipcMain.on(ipcUtil.createKey("structured-log"),({sender},log)=>handleLogFromRenderer(...))` |
| `<ns>.status` | renderer → main | renderer status (ANR / event-loop block) | `ipcMain.on(ipcUtil.createKey("status"),({sender},status)=>rendererStatusChanged(status,sender))` |
| `<ns>.metric` | renderer → main | metric sample | `ipcRenderer.send(ipcUtil.createKey("metric"),metric)` |

- [Observed] Sentry's IPC mode enum: `IPCMode.Classic=1`, `IPCMode.Protocol=2`, `IPCMode.Both=3`; the Protocol mode registers a privileged custom scheme per namespace and proxies `protocol.registerSchemesAsPrivileged` so other registrations inherit the Sentry scheme (`bundle.js` @ `1618959`).
### Custom protocol (`disclip`)
| Aspect | Behaviour | Evidence |
| --- | --- | --- |
| Scheme name | `disclip` | `bundle.js` `exports.DISCORD_CLIP_PROTOCOL="disclip"` |
| Registration | happens **before** `app.ready` | `exports.beforeReadyProtocolRegistration=function(){...protocol.registerSchemesAsPrivileged([{scheme:DISCORD_CLIP_PROTOCOL,privileges:{standard:!0,secure:!0,corsEnabled:!0,supportFetchAPI:!0,stream:!0}}])}` |
| Privileges | `standard`, `secure`, `corsEnabled`, `supportFetchAPI`, `stream` | same |
| Sentry scheme | additionally registered with `bypassCSP:!0` and proxied into every later `registerSchemesAsPrivileged` call | `bundle.js` @ `1618959` |

### External-URL guard
| Aspect | Behaviour | Evidence |
| --- | --- | --- |
| Blocked protocols | `["file:","javascript:","vbscript:","data:","about:","chrome:","ms-cxh:","ms-cxh-full:","ms-word:","shell:","ms-msdt:","search-ms:","ms-officecmd:","ms-appinstaller:"]` | `bundle.js` @ `152199` `let ... BLOCKED_URL_PROTOCOLS=[...]` |
| Rule | reject if the protocol is blocked **or** the protocol (minus `:`) is shorter than 2 characters | `function shouldOpenExternalUrl(externalUrl){let protocol;try{protocol=new URL(externalUrl).protocol.toLowerCase()}catch(_){return!1}return!BLOCKED_URL_PROTOCOLS.includes(protocol)&&!(protocol.replace(/:$/,"").length<2)}` |
| Safe wrapper | `saferShellOpenExternal` rejects with `Error("External url open request blocked")` instead of throwing synchronously | `exports.saferShellOpenExternal=function(externalUrl){return shouldOpenExternalUrl(externalUrl)?electron_1.shell.openExternal(externalUrl):Promise.reject(Error("External url open request blocked"))}` |
| Origin check | `checkUrlOriginMatches(urlA,urlB)` → same `protocol` **and** same `host` | `exports.checkUrlOriginMatches=function(urlA,urlB){...return parsedUrlA.protocol===parsedUrlB.protocol&&parsedUrlA.host===parsedUrlB.host}` |
| Unparseable URL | `new URL()` throws → treated as **not** openable (fail-closed) | same |

### Notifications, theme, updater, crash reporter
| Area | Behaviour | Evidence |
| --- | --- | --- |
| Native notifications | **none** — `new Notification` = 0; `Notification(` ×2 are JSON-RPC validation helpers | census over `bundle.js` |
| Native theme | **none** — `nativeTheme` = 0 | census |
| Updater (Windows) | `AutoUpdaterWin32` — Squirrel: `squirrelUpdate.updateExistsSync()?squirrelUpdate.restart(app,version):quitAndInstall()` | `bundle.js` @ `49325` |
| Updater (Linux) | `AutoUpdaterLinux` — `checkForUpdates()` GETs the feed; `quitAndInstall()` does `app.relaunch(); app.quit()`; a 204 response means "no update" | `bundle.js` @ `49806` |
| Updater (macOS) | Electron `autoUpdater` with `setFeedURL`; feed base `${_endpoint}/modules/${_buildInfo.releaseChannel}` and query `host_version` | `bundle.js` @ `61266` |
| Updater kill switch | `build_info.json` → `disableUpdater` (also true for `development` release channel) | `splashScreenPreload.js` module `55405` |
| Pending installs | `moduleUpdater.installPendingUpdates()` is invoked on boot | `bundle.js` @ `93582` region |
| Crash reporter | `electron.crashReporter.start({companyName:"", ignoreSystemCrashHandler:!0, productName:app.name||app.getName(), submitURL, uploadToServer:!0, compress:!0, globalExtra})` | `bundle.js` @ `1584418` |
| Minidump path | `SentryMinidump` integration starts `crashReporter` with `uploadToServer:!1, submitURL:"https://f.a.k/e"` and reads minidumps from a local `BufferedWriteStore` under the Sentry cache path, then uploads them itself | `bundle.js` @ `1602735` |
| Crash handling | `app.on("render-process-gone",(_,__,details)=>{CRASH_REASONS.includes(details.reason)&&sessions.sessionCrashed()})` | `bundle.js` @ `1584418` |
| Windows WER | `discord_wer.dll` (451,512 B) is shipped by 1.0.9264 next to `Discord.exe` — the OS-level Windows Error Reporting handler | installed app folder listing |

### Electron fuses (1.0.9264 `Discord.exe`)
| Fuse | State | Consequence |
| --- | --- | --- |
| `RunAsNode` | **disabled** | `ELECTRON_RUN_AS_NODE` is not honoured |
| `EnableCookieEncryption` | disabled | cookies are not encrypted at rest |
| `EnableNodeOptionsEnvironmentVariable` | **enabled** | `NODE_OPTIONS` is honoured by the process — a local code-execution lever |
| `EnableNodeCliInspectArguments` | disabled | `--inspect` CLI args are not honoured |
| `EnableEmbeddedAsarIntegrityValidation` | **disabled** | a modified `app.asar` is **not** detected or rejected at load |
| `OnlyLoadAppFromAsar` | disabled | the app may also be loaded from an unpacked `resources/app/` directory |
| `LoadBrowserProcessSpecificV8Snapshot` | disabled | the browser process uses the generic V8 snapshot |
| `GrantFileProtocolExtraPrivileges` | **enabled** | `file://` gets the extra privileges Electron grants for local content |
| `WasmTrapHandlers` | enabled | Wasm traps are handled in-process |

- [Observed] Evidence: `ev_0e5a620c465f50fc5deddd43770a59450773aac1a68ebbf4c8118cba092c986d` (sentinel at file offset 182,144,240; one sentinel found; slice 0 complete).

- [Inferred] **"No embedded asar integrity" consequence**: because `EnableEmbeddedAsarIntegrityValidation` is off, the packaged `app.asar` is not hashed/validated before execution. A local attacker who can write the install directory can alter the main process bundle and it will run with the user's privileges. Compounding this, `OnlyLoadAppFromAsar` is off, so an unpacked `resources/app/` directory is an equally valid load source. `EnableNodeOptionsEnvironmentVariable` being on widens the same surface: a `NODE_OPTIONS` value in the environment is applied at process start.

## Implementation details
Each row below is `[Observed]`: the pointer columns carry the artifact reference.
### CrowdOS comparison (current `packages/desktop`)
| Concern | Discord bootstrapper (1.0.9262) | CrowdOS `packages/desktop` | CrowdOS evidence |
| --- | --- | --- | --- |
| Main window creation | not in this artifact (bootstrapper only) | `new BrowserWindow({...stored.windowBounds})` | `packages/desktop/main/index.ts:320-322` |
| Show strategy | splash `show:!1` then explicit show | `ready-to-show` **plus** a 1,500 ms fallback | `packages/desktop/main/index.ts:339-340` |
| Window-state persistence | not applicable | bounds stored and restored on resize/close | `packages/desktop/main/index.ts:362`, `packages/desktop/main/index.ts:373` |
| Tray | none | `new Tray(icon)`, `setToolTip("CrowdOS")`, `setContextMenu(getTrayMenuTemplate({...}))`, click → refocus | `packages/desktop/main/index.ts:475-480`, `packages/desktop/main/index.ts:459-461` |
| Tray template | n/a | `Open Recent` (disabled placeholder when empty), running/approval count labels, `Check for Updates`, `Quit` (`role:"quit"`) | `packages/desktop/main/tray-menu.ts:37-70` |
| Native menu | quit-only, per-platform accelerator | not built | — |
| Custom protocol | `disclip`, privileged (`standard,secure,corsEnabled,supportFetchAPI,stream`), registered before ready | `crowdos://` deep links, `crowdos://c/<channelId>` and `crowdos://w/<ws>/<channelId>` | `packages/desktop/main/app-shell.ts:71`, `packages/desktop/main/notifications.ts:16-20` |
| IPC naming | `DISCORD_` prefix + namespaced `<ns>.<channel>` | zod-enum allowlist: `IPC_INVOKE_CHANNELS` + `IPC_EVENT_CHANNELS` merged into `IPC_ALLOWLIST` | `packages/desktop/ipc-contracts.ts:5`, `:32`, `:52` |
| Preload bridge | splash preload uses raw `ipcRenderer`; only `__SENTRY_IPC__` and `__electronLog` reach the page | `window.crowdos` with `invoke`/`on` over the allowlist + `pickDirectory`; no fs/shell/require | `packages/desktop/preload/bridge.ts:35` |
| External-open guard | protocol blocklist + ≥2-char protocol + `checkUrlOriginMatches` | `setWindowOpenHandler` → `isAllowedExternal(url)` → `shell.openExternal` | `packages/desktop/main/index.ts:399-400`, `packages/desktop/main/navigation-guard.ts:67` |
| CSP | not applied by the bootstrapper | `default-src 'self'; ... connect-src http://127.0.0.1:* ws://127.0.0.1:*; ...` | `packages/desktop/security-policy.ts:11` |
| Crash reporting | `electron.crashReporter` + Sentry minidumps + OS WER (`discord_wer.dll`) | not implemented | — |
| Auto-update | Squirrel (Win), relaunch (Linux), `autoUpdater` (macOS), `disableUpdater` kill switch, manual Linux download fallback | pure policy module `canAutoUpdate` + https-only feed parser; `publish: null`, manual installers | `packages/desktop/main/updater.ts` |

### What CrowdOS should copy
1. [Observed] **Channel-name discipline.** Discord's `getDiscordIPCEvent` guarantees every application channel carries a stable prefix, so renderer and main cannot collide. [Inferred] CrowdOS already does this better with a zod-enum allowlist; keep it.
2. [Observed] **Pre-`ready` protocol registration.** `beforeReadyProtocolRegistration` registers the privileged scheme before `app.whenReady()`. CrowdOS must register `crowdos://` the same way or the first deep link can be missed.
3. [Observed] **Fail-closed external-URL parsing.** `new URL()` failure ⇒ refuse to open. CrowdOS's `isAllowedExternal` must keep the same posture.
4. [Observed] **Origin equality check** (protocol **and** host) as a second, independent guard next to the protocol blocklist.
5. [Observed] **Deny-then-hand-off** for popups: the renderer must never be allowed to open a window; the URL goes to the OS browser.
6. [Observed] **`will-navigate` cancellation** on any window that is not supposed to navigate.
7. [Observed] **Local minidump collection before upload** (`uploadToServer:false` + own shipper) if CrowdOS ever adds crash reporting. [Inferred] It keeps PII out of the crash pipeline.
8. [Observed] **`ready-to-show` + timeout fallback** — CrowdOS already has this; the reference confirms the pattern. [Inferred] Discord's splash uses `show:false` + explicit show instead, which also works.
9. [Observed] **A `disableUpdater` build-info kill switch** for non-release channels.

### What CrowdOS must NOT copy
1. [Observed] **`sandbox:false` in a preload-bearing window.** Discord's splash sets `sandbox:false` and `contextIsolation:true` together. CrowdOS must keep `sandbox:true` where possible; `contextIsolation` alone is not a substitute.
2. [Observed] **A disabled `EnableEmbeddedAsarIntegrityValidation` fuse.** CrowdOS's packaged build must validate `app.asar` integrity, and must keep `OnlyLoadAppFromAsar` **enabled** so a stray `resources/app/` directory cannot shadow the packaged app.
3. [Observed] **`EnableNodeOptionsEnvironmentVariable` left enabled.** CrowdOS must disable it (and `EnableNodeCliInspectArguments`) so an environment variable cannot inject code into the shell.
4. [Observed] **A `DISCORD_`-style implicit prefix instead of an allowlist.** [Inferred] CrowdOS's zod allowlist is strictly better; do not loosen it to a prefix convention.
5. [Observed] **A global `electron-log`/`__electronLog` bridge that bypasses the allowlist.** CrowdOS's `window.crowdos` must remain the only renderer→main surface.
6. [Observed] **A quit-only native application menu** as CrowdOS's only menu. CrowdOS's tray already carries the real actions; if a native menu is added it must not be the only place actions live.
7. [Observed] **Discord's updater channel/feed model** (`${endpoint}/modules/${releaseChannel}` + `host_version` query). CrowdOS's `publish: null` + manual-installer policy is the locked contract.
8. [Observed] **Discord's fuse posture on cookie encryption.** CrowdOS must not ship `EnableCookieEncryption` disabled for a loopback-only local app; it is unnecessary exposure.

## Interaction model
1. [Observed] `app.whenReady` → `beforeReadyProtocolRegistration()` registers `disclip` as privileged.
2. [Observed] The splash window is created hidden (`show:false`), loads `splash/index.html` from disk, and is shown when the updater state allows.
3. [Observed] The preload renders the splash DOM and reports readiness over `DISCORD_SPLASH_SCREEN_READY`.
4. [Observed] The updater polls the feed; states are pushed to the splash over `DISCORD_SPLASH_UPDATE_STATE`.
5. [Observed] On completion the bootstrapper hands off (installs pending updates, or quits).

## Performance notes
- [Observed] The splash window is fixed-size and non-resizable; it exists only for the update phase.
- [Observed] Updater progress is throttled to **1,000 ms** in the splash (`setInterval(...,1e3)`).
- [Observed] The Sentry IPC uses a `KNOWN_RENDERERS` set keyed by `sender.id` so repeated `start` messages from the same renderer are ignored.
- [Observed] Minidump upload is off the crash path (`uploadToServer:false`), so a crash does not block the main thread on network I/O.
## Evidence
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| ID | What it shows |
| --- | --- |
| `ev_0e5a620c465f50fc5deddd43770a59450773aac1a68ebbf4c8118cba092c986d` | REA `inspect_electron_fuses` on the installed 1.0.9264 `Discord.exe`: 9 fuses, sentinel offset 182,144,240 |
| `ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` | Live client identity: discord/1.0.9264, Electron/42.11.15, Chromium 148.0.7778.280 |
| `rea-extracted-28ad0afc-.../bundle.js` | 3,066,301 B — Discord 1.0.9262 bootstrapper main process (rspack bundle) |
| `rea-extracted-28ad0afc-.../splashScreenPreload.js` | 9,333 B — splash renderer preload |
| `rea-extracted-28ad0afc-.../package.json` | `"Discord Client for Desktop - Bootstrapper"`, `main: bundle.js`, `electron 42.7.1`, `@sentry/electron 7.13.0`, `electron-log 5.2.0` |
| `C:\Users\Asus\AppData\Local\Discord\app-1.0.9264\` | Installed 1.0.9264 app folder: `updater.node` (4,550,072 B), `discord_wer.dll` (451,512 B), `Discord.exe` (219,700,152 B) |
| `packages/desktop/**` | CrowdOS shell source used for the comparison table |
## Gaps
- **The main application window is not in the analysed artifact.** `BrowserWindow` occurs 7 times in `bundle.js` and the only construction is the splash. The real app window's options, tray, window-state persistence, and its own IPC live in the separately downloaded application package, which was not extracted. Any claim about Discord's main-window options would be guesswork.
- The shell is **1.0.9262**; the running client is **1.0.9264** with two extra native artefacts. Whether the 1.0.9264 main-process bundle changes the window/tray/IPC surface is **not verified** — the 1.0.9264 `app.asar` was not extracted.
- `discord_wer.dll` is present but its integration points (registration flags, dump directory) are inside the DLL and were not analysed; only its presence and size are observed.
- `updater.node` (4,550,072 B) is a native addon whose interface is unknown; the JS-side updater classes above are the Squirrel/Electron paths, and whether 1.0.9264 routes through the addon instead is **unverified**.
- The `LOADING_WINDOW_HEIGHT` constant value was not extracted (module constant).
- The `submitURL` used by `crashReporter.start` in the SentryElectron integration is a parameter, not a literal; the SentryMinidump variant uses the placeholder `https://f.a.k/e`.
- Discord's IPC channel list for the *application* (not the bootstrapper) was not observed.

## User Decision:

## Target Contract
> Status: Target. Discord's shell is a reference; CrowdOS's locked desktop design contract takes precedence.

- CrowdOS MUST keep `packages/desktop` as the only shell surface, with `desktopGate.ts` as the sole public entry; a second shell entry point is forbidden.
- CrowdOS MUST keep the zod-enum IPC allowlist as the single source of truth for renderer→main and main→renderer channels, and `window.crowdos` as the only renderer-visible bridge. Prefix conventions, log bridges and any `__`-prefixed globals are forbidden.
- CrowdOS MUST register `crowdos://` before `app.whenReady()` and MUST keep the deep-link shapes `crowdos://c/<channelId>` and `crowdos://w/<workspaceId>/<channelId>`.
- CrowdOS MUST keep `contextIsolation: true` and MUST enable `sandbox` for every window that loads a preload. `sandbox: false` is forbidden.
- CrowdOS's packaged build MUST enable `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar`, and MUST disable `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` and `EnableCookieEncryption`.
- CrowdOS MUST keep the fail-closed external-URL posture: unparseable URLs are refused, and the blocked-protocol list plus a protocol+host origin check both apply.
- CrowdOS MUST keep `ready-to-show` plus a bounded timeout fallback, and MUST persist window bounds.
- CrowdOS's updater policy (`publish: null`, manual installers, `canAutoUpdate` gate) is locked; a Discord-style channel feed and auto-install path is out of scope for now.
- CrowdOS MUST NOT add a native application menu that duplicates or replaces tray actions; the tray template in `packages/desktop/main/tray-menu.ts` is the single menu surface.
- CrowdOS MUST NOT adopt a `DISCORD_`-prefix convention or a namespace-dot convention; the allowlist stays explicit.
