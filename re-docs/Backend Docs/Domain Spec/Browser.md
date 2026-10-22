# Browser

## Purpose
Owns the real browser CrowdOS drives: a Playwright persistent, headed Chrome context per workspace, one page per workspace, and the single-actor command queue that serializes every page operation. The Tools domain exposes `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_read`, `browser_wait`, and `browser_state`; this domain owns the session, profile, and page they act on. It also owns the 1 fps live-view capture loop the operator watches, and the operator control ports (open, close, click/type/navigate, coordinate-click/focused-type takeover).

## Feature Scope
In-scope:
- Per-workspace persistent browser profile under `<workspaceFolder>/vfs/.crowdos/browser/profile` (`resolveBrowserProfileDir`).
- Lazy Playwright launcher (`createPlaywrightLauncher`) plus the test seam (`setBrowserLauncherForTests`/`getBrowserLauncher`).
- Launch options that keep the browser acceptable to Google sign-in (`buildLaunchOptions`, `findChromeExecutable`): the installed Chrome when the machine has one, and no automation signal ever.
- One browser + one page per workspace, all commands serialized on a per-workspace promise chain (`enqueueCommand`).
- Navigation behavior with the shared URL guard (`navigateBrowser`) and PNG screenshot capture as an artifact (`screenshotBrowser`).
- Page control: click and fill (`clickBrowser`, `typeBrowser`), panel takeover by viewport coordinates and focused typing (`clickAtBrowser`, `typeTextBrowser`), capped body-text read (`readBrowser`), selector/load-state wait (`waitBrowser`), and a non-launching open/URL/title probe (`getBrowserState`).
- Session teardown: one workspace (`closeWorkspaceSession`), all workspaces (`closeAllSessions`), and the server-stop hook in `create-app.ts`.
- Open-without-navigation (`openBrowser`) so the operator can log in on `about:blank` before handing control to an agent.
- Live view: a refcounted 1 fps JPEG capture loop per workspace (`subscribeBrowserStream`/`unsubscribeBrowserStream`) that feeds an injected sink. Frames exist only while a session is open; `{open,url,title}` state is emitted on change only.
Non-goals (other domains):
- Tool definitions, authorization, schemas → Tools (`tools/browser-tools.ts` registers the seven verbs; `browser-tools.ts` calls the gate).
- URL policy vocabulary → Shared (`shared/core/url-guard.ts`; this domain only reuses it).
- Artifact storage, rows, retention → Artifacts (`artifactsGate.create`).
- Workspace folder layout → Workspace/Shared (`resolveLocalStoreDir`).
- Agent-facing capability vocabulary → Capabilities (`browse.web` descriptor maps the seven tool ids into the `observation` domain).

## Expect
- `[Observed]` The profile directory is derived from the workspace store dir: `join(resolveLocalStoreDir(workspaceId), "browser", "profile")`; a test-pinned store base therefore yields `<base>/<workspaceId>/vfs/.crowdos/browser/profile`.
- `[Observed]` Playwright is loaded only when a session opens (`await import("playwright")` inside the launcher); importing the domain or the tools never loads it.
- `[Observed]` The launcher runs headed (`headless: false`) with `launchPersistentContext`, so cookies/storage in the profile survive between sessions.
- `[Observed]` The launcher drives the INSTALLED Google Chrome when the machine has one (`findChromeExecutable` → `executablePath`), and Playwright's bundled Chromium when it has none. The installed Chrome is what makes the browser advertise the "Google Chrome" client-hint brand instead of "Chromium"; Google's sign-in gate rejects the unbranded build. Candidates are the platform install paths (`%PROGRAMFILES%`, `%PROGRAMFILES(X86)%`, `%LOCALAPPDATA%`, `HOMEDRIVE\Program Files[ (x86)]` on Windows; `/Applications/Google Chrome.app` and `~/Applications/Google Chrome.app` on macOS; `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`, `/opt/google/chrome/chrome` on Linux). The first existing path wins; none existing means no `executablePath` at all.
- `[Observed]` The launch options carry NO Chromium-only switch. `--disable-blink-features=AutomationControlled` would clear the automation signal, but it is Chromium-only and Chrome-branded answers it with its own yellow "unsupported command-line flag" banner — so the signal is hidden in the page instead: `HIDE_WEBDRIVER_SCRIPT` overrides the `Navigator.prototype.webdriver` getter and is injected with `context.addInitScript`, so it runs before any page script in every frame. It is a STRING, not a function: a transpiled function leaks its helpers (`__name`) into the page, where they do not exist, and the script throws there instead of overriding anything.
- `[Observed]` Measured end to end on the installed Chrome: the command line carries none of `--no-sandbox`, `--enable-automation`, `--disable-blink-features`, `--enable-blink-features`, `--disable-component-extensions-with-background-pages` (no bad-flags banner), and the page reads `navigator.webdriver === false` with the `Google Chrome` client-hint brand.
- `[Observed]` The installed Chrome is launched with its sandbox on (`chromiumSandbox: true`), which keeps Playwright from adding `--no-sandbox`. Chrome-branded answers `--no-sandbox` with the yellow "unsupported command-line flag" banner, and Playwright's bundled Chromium does not show it. The policy (`shouldEnableSandbox`): the installed Chrome always asks for the sandbox, EXCEPT on Linux as root (root cannot use it); the bundled Chromium fallback keeps Playwright's default, because its Linux build usually ships without a sandbox helper. Measured on Windows: with the sandbox on, the launched Chrome's command line carries no `--no-sandbox`; with it off, it does.
- `[Observed]` The launch options ignore Playwright's `--enable-automation` and `--disable-component-extensions-with-background-pages` defaults: the first is the automation switch (and its infobar), the second would take the Google account helper down with it.
- `[Observed]` A workspace has exactly one page at a time. Concurrent commands are chained, not interleaved: command N+1 starts only after command N settles.
- `[Observed]` A rejected command reaches its own caller, but the chain continues; a failed navigation cannot wedge later commands for that workspace.
- `[Observed]` `navigateBrowser` rejects non-http(s), loopback, and private URLs through `isSafeHttpUrl` BEFORE a session is opened; rejection covers trailing-dot `localhost.`/`sub.localhost.`, bare `::1`/`::`, and IPv4-mapped IPv6 (`::ffff:7f00:1`). The page is never touched.
- `[Observed]` A successful navigation waits for `domcontentloaded` with a 30s timeout and reports the page's actual final `url()` plus `title()`.
- `[Observed]` `screenshotBrowser` captures PNG bytes, stores them as a `file` artifact whose `contentRef` is `data:image/png;base64,...`, and returns `{ artifactId, path, url, title }`. The PNG data URI is written as binary bytes by the Artifacts repository.
- `[Observed]` `path` in the screenshot result may be an empty string when the filesystem write failed; the artifact row id is still returned (the row is the durable pointer).
- `[Observed]` `clickBrowser`/`typeBrowser` run `page.click(selector)`/`page.fill(selector, text)` through the workspace queue and return the page's current `{ url, title }` afterwards.
- `[Observed]` `readBrowser` reads `page.innerText("body")`, caps the text at 20000 characters, and sets `truncated: true` only when the raw text was longer; short text is returned intact with `truncated: false`.
- `[Observed]` `waitBrowser` requires a selector or a load state and throws before enqueue when neither is given. A selector waits in `visible` state; otherwise `waitForLoadState(loadState ?? "load")` runs. The timeout defaults to 30000 ms and is passed to either call.
- `[Observed]` `getBrowserState` returns `{ open: false, url: null, title: null }` when no session exists and never calls the launcher. When open, it reports `{ open: true, url, title }` through the same queue. `enqueueIfOpen` does not create a session entry, and its identity check returns `null` if the entry was closed while the probe waited.
- `[Observed]` `closeAllSessions` is best-effort and never throws, including when an individual `close()` rejects. `resetBrowserSessionsForTests` is the same drain for tests.
- `[Observed]` `openBrowser` queues the same lazy launch as every other command but performs no navigation; it reports the page's current `{ url, title }` (`about:blank` on a fresh session).
- `[Observed]` `subscribeBrowserStream(workspaceId, sink)` starts the loop when the workspace has no timer: one tick fires immediately, then `setInterval` every 1000 ms. Resubscribing replaces the sink and keeps the existing timer. The timer is `unref`'d.
- `[Observed]` Each tick runs through `enqueueIfOpen`, so a closed workspace is never launched. The capture is `page.url()`, `page.title()`, and `page.screenshot({ type: "jpeg", quality: 60 })`; the frame is `{ workspaceId, mimeType: "image/jpeg", data: <base64>, ts }`.
- `[Observed]` A tick already in flight makes the next interval skip (`ticking` guard), so a slow page cannot queue captures. `{open,url,title}` is serialized and emitted only when it changes; the first closed tick emits one `{ open: false, url: null, title: null }`.
- `[Observed]` `unsubscribeBrowserStream` clears the timer and deletes the entry, so a later resubscribe starts fresh and re-emits state immediately. `resetBrowserStreamsForTests` clears every timer and entry.
- `[Observed]` Sink calls are wrapped per call: a dead emitter (closed socket) cannot kill the interval. A rejected page capture also cannot kill it; the next tick re-probes.

## Flow
1. A tool handler in `tools/browser-tools.ts` receives the call after Tools' normal authorization (`authLevelRequired: 1`) and resolves the workspace id from `ctx.workspaceId ?? "default"`.
2. `browserGate.navigate(workspaceId, url)` first runs `isSafeHttpUrl`; a failure throws with a message naming the guard and no session is created.
3. `enqueueCommand(workspaceId, task)` looks up (or synchronously creates) the workspace session entry and chains the task onto that workspace's promise queue.
4. When the chain reaches the task, the session captured at enqueue time lazily calls the launcher with `resolveBrowserProfileDir(workspaceId)` if its handle is still null. The launcher imports Playwright, opens the persistent headed context on the installed Chrome (with no automation signal), and returns the first page (or a new page).
5. Navigate: `page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })`, then `page.url()` + `page.title()`.
6. Screenshot: `page.screenshot({ type: "png" })`, then `artifactsGate.create` with `type: "file"`, an explicit `browser-screenshot-<ts>.png` path, the base64 data URI as `contentRef`, and `{ url, title }` metadata. Artifacts writes the decoded bytes under the workspace artifact dir and returns the row.
7. Control: click and type run `page.click`/`page.fill` then read `{ url, title }`; read runs `page.innerText("body")` under the 20000-character cap; wait runs `page.waitForSelector(selector, { state: "visible", timeout })` or `page.waitForLoadState(loadState, { timeout })`.
8. State: `getBrowserState` goes through `enqueueIfOpen`, which takes the existing session only. No session, or a session closed while the probe was queued, yields `{ open: false, url: null, title: null }`; it never launches.
9. The tool maps the gate result to `ToolResult`: navigate/click/type/wait return `{ url, title }`; read returns `{ url, title, text, truncated }`; state returns `{ open, url, title }`; screenshot returns `{ artifactId, path, url, title }` plus a `file`/`image/png` artifact entry.
10. Open: `browserGate.open` queues a launch (or reuses the live session) and returns the page's current `{ url, title }` without navigating — `about:blank` until an operator or agent navigates.
11. Live view subscribe: the socket server's `browser:subscribe` validates the workspace, joins `browser:<workspaceId>`, and refcounts the socket. On the first subscriber it calls `browserGate.subscribeStream(workspaceId, sink)`; the stream fires one tick immediately and every 1000 ms thereafter. The sink rebroadcasts `browser:frame` and `browser:state` once to the room.
12. Live view ticks: `enqueueIfOpen` reads `{ url, title, jpeg }` from the page when a session exists; a missing session emits one `{ open: false, url: null, title: null }` and never launches. Open state is emitted only when `{open,url,title}` changes.
13. Live view stop: the last `browser:unsubscribe` (or the last subscriber's disconnect) removes the workspace entry and calls `browserGate.unsubscribeStream`, clearing the interval. A later subscribe starts a fresh entry and re-emits state immediately.
14. On server stop, `create-app.ts` calls `browserGate.closeAll()` beside the scheduler disarm, so no headed window outlives the process.
15. Operator takeover: `POST /api/browser/action` `clickAt` dispatches `browserGate.clickAt(workspaceId, x, y)` (`page.mouseClick`) and `typeText` dispatches `browserGate.typeText(workspaceId, text)` (`page.keyboardType`); both ride the same queue and return `{ url, title }`.

## Current Implementation
| File | Role |
| ---- | ---- |
| `browser-types.ts` | Internal types: `browserPage` (goto/screenshot/click/fill/mouseClick/keyboardType/innerText/waitForSelector/waitForLoadState/title/url), `browserHandle`, `browserLauncher`, `browserLaunchOptions`, load-state/selector-state and option shapes (screenshot type + JPEG quality) |
| `browser-launcher.ts` | Real Playwright adapter (`launchPersistentContext`, lazy import) with the sign-in-safe launch options (`buildLaunchOptions`, `findChromeExecutable`, `shouldEnableSandbox`) and the page-side automation hide (`HIDE_WEBDRIVER_SCRIPT`), plus the test override |
| `browser-session.ts` | Profile-dir resolution, session registry, single-actor queue (`enqueueCommand`) plus the non-launching probe (`enqueueIfOpen`), close/all/reset |
| `browser-service.ts` | `navigateBrowser` (guard + goto), `openBrowser` (launch without navigation), `screenshotBrowser` (PNG → Artifacts), and the control ports (`clickBrowser`, `typeBrowser`, `clickAtBrowser`, `typeTextBrowser`, `readBrowser`, `waitBrowser`, `getBrowserState`) |
| `browser-stream.ts` | Refcounted live-view loop: `subscribeBrowserStream`/`unsubscribeBrowserStream`/`resetBrowserStreamsForTests`, frame/state/sink types, 1 s interval at JPEG quality 60 |
| `browser-gate.ts` | Thin facade: `browserGate` and the live-view types |

Key functions: `resolveBrowserProfileDir`, `enqueueCommand`, `enqueueIfOpen`, `closeWorkspaceSession`, `closeAllSessions`, `resetBrowserSessionsForTests`, `createPlaywrightLauncher`, `buildLaunchOptions`, `findChromeExecutable`, `shouldEnableSandbox`, `setBrowserLauncherForTests`, `getBrowserLauncher`, `navigateBrowser`, `openBrowser`, `screenshotBrowser`, `clickBrowser`, `typeBrowser`, `clickAtBrowser`, `typeTextBrowser`, `readBrowser`, `waitBrowser`, `getBrowserState`, `subscribeBrowserStream`, `unsubscribeBrowserStream`, `resetBrowserStreamsForTests`.

## Ports
Gate exports `browserGate` plus the live-view types `browserFrame`, `browserStreamSink`, `browserStreamState` (no other types or test seams):
- `browserGate.navigate` — `navigateBrowser(workspaceId, url)`: guard-checked navigation, returns `{ url, title }`.
- `browserGate.open` — `openBrowser(workspaceId)`: launches/reuses the browser without navigating, returns `{ url, title }`.
- `browserGate.screenshot` — `screenshotBrowser(workspaceId, { agentId, workspaceId, runId? })`: PNG artifact, returns `{ artifactId, path, url, title }`.
- `browserGate.click` — `clickBrowser(workspaceId, selector)`: queues `page.click`, returns `{ url, title }`.
- `browserGate.type` — `typeBrowser(workspaceId, selector, text)`: queues `page.fill`, returns `{ url, title }`.
- `browserGate.read` — `readBrowser(workspaceId)`: queues `innerText("body")`, returns `{ url, title, text, truncated }` with text capped at 20000 chars.
- `browserGate.wait` — `waitBrowser(workspaceId, { selector?, loadState?, timeoutMs? })`: selector-visible or load-state wait (default 30000 ms), returns `{ url, title }`; throws when neither selector nor loadState is given.
- `browserGate.state` — `getBrowserState(workspaceId)`: never launches; returns `{ open, url, title }`.
- `browserGate.close` — `closeWorkspaceSession(workspaceId)`: best-effort close of one workspace browser; never throws.
- `browserGate.closeAll` — `closeAllSessions()`: best-effort close of every workspace browser; never throws.
- `browserGate.subscribeStream` — `subscribeBrowserStream(workspaceId, sink)`: starts/reuses the workspace 1 fps loop and delivers `browserFrame`/`browserStreamState` to the sink.
- `browserGate.unsubscribeStream` — `unsubscribeBrowserStream(workspaceId)`: stops the loop and forgets its state.
- `browserGate.clickAt` — `clickAtBrowser(workspaceId, x, y)`: queues `page.mouseClick`, returns `{ url, title }`.
- `browserGate.typeText` — `typeTextBrowser(workspaceId, text)`: queues `page.keyboardType`, returns `{ url, title }`.
- `browserFrame` — `{ workspaceId: string; mimeType: "image/jpeg"; data: string; ts: number }`.
- `browserStreamState` — `{ workspaceId: string; open: boolean; url: string | null; title: string | null }`.
- `browserStreamSink` — `{ onFrame(frame: browserFrame): void; onState(state: browserStreamState): void }`.

## Relations
Gates this domain calls:
- `artifacts/artifacts-gate.ts` — `artifactsGate.create` for the screenshot row.
Shared helpers (gate-exempt): `shared/core/local-file.js` (`resolveLocalStoreDir`), `shared/core/url-guard.js` (`isSafeHttpUrl`).
Known outside callers of `browserGate`:
- Tools: `tools/browser-tools.ts` (all seven verbs).
- Boot/lifecycle: `create-app.ts` (`closeAll` on `stop()`).
- Transport: `routes/browser.ts` (state/open/action/close) and `shared/sockets/register-socket-server.ts` (`subscribeStream`/`unsubscribeStream`, refcounted per workspace).
On-disk state owned (not tabular):
- `<workspaceFolder>/vfs/.crowdos/browser/profile` — Chromium profile (cookies, storage, cache).
Tables touched: none directly; Artifacts owns the `artifacts` row and the PNG file.

## Emits-Listens
- No broker events. Artifact creation emits through the Artifacts domain (`artifact.created` / `artifact.updated`), not from Browser.
- Socket-direct live view (not broker): the socket server injects a sink and broadcasts `browser:frame` and `browser:state` to room `browser:<workspaceId>`. The domain itself never touches a socket or the broker.

## Owns
- The browser process, context, page, and persistent profile directory per workspace.
- The per-workspace command queue (process memory only).

## Flags
- None. There is no enable/disable flag; the domain is inert until a browser tool is called.

## Decisions
- `[Observed]` Persistent headed Chrome rather than headless: the profile keeps signed-in state across runs and the operator can see what the agent is doing. The profile lives under the workspace so two workspaces never share cookies.
- `[Observed]` The browser must look like a browser to the sites it logs into. Google's sign-in gate answers "This browser or app may not be secure" for an automated Chromium, so the launcher drives the installed Chrome (real "Google Chrome" brand), hides the automation signal from the page (`navigator.webdriver === false`), and keeps the command line free of Chromium-only switches so no bad-flags banner shows. Ceiling: this is the browser's own fingerprint, not a stealth stack — Google can still refuse a login on other grounds (rate, IP, account state), and a machine without Chrome falls back to Playwright's unbranded Chromium, which is exactly the build Google refuses. The real fix for those hosts is an installed Chrome, not more flags.
- `[Observed]` The sandbox is asked for, not forced: on Linux as root Chrome refuses to start sandboxed, and the bundled Chromium fallback has no sandbox helper on Linux. Both keep the sandbox off rather than trading a banner for a browser that will not launch.
- `[Observed]` One page per workspace behind a single-actor queue: Playwright page operations are not reentrant, and a serial chain makes tool-call order deterministic. A second tab would need its own coordination, not an implicit race.
- `[Observed]` URL policy is reused, not re-invented: `isSafeHttpUrl` encodes http/https plus loopback/private rejection (trailing-dot `localhost.`, `::1`, `::`, IPv4-mapped IPv6). The guard runs before enqueue so an unsafe URL costs no browser work. Ceiling: WHATWG host normalization collapses non-canonical numeric IPv4 forms (`http://127.1/`, `http://2130706433/`, `http://0x7f.0.0.1/`, `http://0177.0.0.1/`) to dotted quads, so the lexical check catches them; DNS rebinding is the remaining ceiling, and a resolver-level check belongs at the deployment edge.
- `[Observed]` Screenshots are `file` artifacts with a base64 data-URI `contentRef`: the existing artifact path handles storage, listing, and retention, and the Artifacts repository decodes the data URI to binary bytes. No new artifact type or input field.
- `[Observed]` Lazy Playwright import: servers and tests that never browse never load the driver, keeping boot and the test suite light.
- `[Observed]` Interaction is classified above navigation: click/type can submit forms and mutate server state, so the tools are `moderate`/`side-effect` while navigate stays `safe`/`side-effect` and the observation verbs stay `safe`/`read`.
- `[Observed]` Read output is capped at 20000 characters because it enters the model's context; `truncated` reports the cut instead of returning a silently shortened page. This matches `query_database`'s 20k output convention.
- `[Observed]` `enqueueIfOpen` exists so the state probe can answer "closed" without turning observation into a launch: it looks up the session map without creating an entry, and re-checks the entry identity inside the queued task so a close that lands while the probe waits cannot resurrect a browser.
- `[Observed]` Live-view room is `browser:<workspaceId>`, deliberately outside the `ws:` room scheme: `isWorkspaceRoom` treats every `ws:*` room without `:channel:` as a workspace room, so a `ws:<id>:browser` room would also receive the global-event fan-out (duplicate delivery on top of the frames).
- `[Observed]` The capture loop lives in the Browser domain, not the socket server, and the socket server injects one sink per workspace. The domain stays transport-free; a sink per socket would emit N duplicate frames for N viewers of the same page.
- `[Observed]` Frames are 1 fps JPEG (quality 60): the operator needs liveness, not fidelity, and a screenshot every second at quality 60 keeps the room payload small. Both are module constants, not flags — one live-view contract.
- `[Observed]` State is change-only (`{open,url,title}` serialized): the UI can update the address/title without a rerender per frame, and a closed browser costs one event, not one per tick.
- `[Observed]` Subscribe carries a per-socket epoch that subscribe and unsubscribe bump. The workspace-access await opens a window where a disconnect cleanup cannot see a not-yet-registered subscription; re-validating the socket and the epoch after the await prevents a stale resume from starting a viewerless loop.
- `[Observed]` Panel coordinates are scaled client-side because the stream carries no DOM: the client maps rendered pixels to viewport pixels and the server only ever sees `page.mouseClick(x, y)`.
- `[Observed]` Focused typing exists because the image has no selector: `page.keyboardType(text)` goes to whatever element the operator focused, instead of inventing a selector the stream cannot provide.

## Failure + Resume
- Unsafe URL: `navigateBrowser` rejects with a guard-naming error before any session exists; the tool returns `{ success: false, error }`.
- Navigation failure/timeout: the page command rejects; the caller sees the error and the queue continues with the next command.
- Click/type failure (missing selector, detached element, timeout): the page command rejects; the tool returns `{ success: false, error }` and the queue continues.
- Wait failure: no selector and no loadState throws before enqueue (no browser opens); a selector that never becomes visible or a load state that never settles rejects at the timeout. The tool surfaces the error.
- Read failure: an `innerText` rejection fails the tool call; truncation is not a failure — it is reported by the `truncated` flag with exactly 20000 characters returned.
- State read: a closed workspace returns `{ open: false, url: null, title: null }` with no launch, including when the session is closed while the probe is queued (`enqueueIfOpen` returns `null`). The state port has no failure path of its own beyond a page call rejecting on an open session.
- Launcher failure: the captured session's open rejects the command; the entry stays with `handle: null`, so the next command retries the launch instead of reusing a broken handle.
- Screenshot artifact write failure: Artifacts is best-effort; the row is still created and `path` may be `null`, surfaced as an empty string. The row id is returned.
- Server stop: `closeAllSessions` swallows per-session close errors so shutdown continues.
- Live-view dead sink: `onFrame`/`onState` calls are individually guarded, so a socket transport that closes mid-emit cannot stop the interval; the next subscriber gets a fresh entry.
- Live-view closed mid-stream: `enqueueIfOpen` returns `null` (including when a close lands while a tick is queued), so the loop emits one `{ open: false, ... }` state and no frame instead of capturing a dying page.
- Live-view slow page: the `ticking` guard skips intervals while a capture is unresolved, so ticks cannot stack behind a stalled page; a thrown capture is swallowed and the next tick re-probes.
- Live-view unsubscribe: every `browser:unsubscribe` removes the socket from `browser:<workspaceId>`; the refcount only stops the loop at zero. The last unsubscribe deletes the entry (timer included), and the capture completion checks entry identity, so an in-flight capture that lands after the delete is discarded instead of reaching a room the viewer left or a new subscriber's sink. A resubscribe starts fresh and re-emits state because `lastState` starts null.
- Live-view subscribe/disconnect race: `browser:subscribe` re-checks `socket.connected` and a per-socket epoch after the `canJoinWorkspaceRoom` await; a disconnect or unsubscribe that lands during the await bumps the epoch, so the resumed handler neither joins nor starts a stream whose subscriber set the cleanup could not see.
- Panel takeover failure: the route rejects missing/negative coordinates and empty text with 400 before any page work; a `mouseClick`/`keyboardType` rejection surfaces as 400 and the workspace queue continues.
- Resume is per-call retry by the agent/operator; there is no session checkpoint or page-state restore beyond the persistent profile.

## Gaps
- The control verbs are one-shot page commands; there is no scripted multi-step sequence that holds the queue across steps.
- One page per workspace; there is no tab management.
- The headed browser is a real child process. `closeAllSessions` covers a clean stop, but a hard process kill can leave the browser running — unverified.
- Profile size and cleanup are unbounded; there is no retention/compaction for `browser/profile`.
- On a host without Google Chrome the launcher falls back to Playwright's bundled Chromium, which advertises the "Chromium" brand; Google sign-in may still refuse it. The browser itself works; only the sign-in gate is at risk.
- The sandbox is asked for, not forced: on Linux as root Chrome refuses to start sandboxed, and the bundled Chromium fallback has no sandbox helper on Linux. Both keep the sandbox off rather than trading a banner for a browser that will not launch.
- The manual headed smoke (open a page, screenshot it, close the server) is an operator checkpoint and was not run by the implementer.
- The live-view operator checkpoint (a socket client receives ~1 fps frames and a close stops them) is manual; automated coverage is the stream unit test plus the route/type presence checks.
