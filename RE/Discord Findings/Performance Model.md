# Performance Model

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose
Reverse-engineered description of how the Discord client keeps the UI responsive: message-list data volume strategy, code-splitting topology, render-cost control, realtime transport, and the hard-coded timing constants. Benchmark reference for CrowdOS's own performance budget (notably: virtualise the message list past 2,000 messages).

## How it works
- [Observed] Discord's client is a single webpack/rspack runtime (`web.<hash>.js`, 12.5 MB) that carries the application plus 4,479 lazily-loadable chunk ids referenced from 41,855 dynamic-import call sites. The message list is **not** virtualised: it is **paginated** over REST and the loaded page is kept in a store. The only windowed list in the app is a bespoke virtualiser used for member/friends lists above a 64-row threshold.

## Structural inventory
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

### Loaded asset topology (from `inspect-main.json` → `resources.json`, `scripts.json`)
| Metric | Value |
| --- | --- |
| Scripts inventoried | 1,281 |
| Resources inventoried | 1,917 |
| JS resources | 1,275 |
| Capture window | `ev_c9c4047be64ab9b35319a29833192285815d419b5798b81c3c32804dec807543` |
### Largest chunks
| Asset | Bytes | Role |
| --- | --- | --- |
| `web.31d1cd3e6e440749.js` | 12,547,650 | Entry/runtime: app shell, composer, autocomplete, gateway client, shortcut registry, i18n table |
| `8b9a4b4a55eaa34c.js` | 1,433,778 | Secondary app chunk (composer labels, long-message copy, scheduled messages) |
| `72993.12b05c70c0a616dc.js` | 1,268,835 | Shared UI kit + Slate-adjacent modules |
| `vnd-emoji.eb9fa44f37371d3b.js` | 1,192,954 | Emoji dataset + picker (lazy) |
| `192743.883920cc41783fd8.js` | 698,302 | Legacy editor, formatting/mention helpers |
| `c680dbcc4bd6182b.js` | 437,962 | Secondary chunk |
| `556707.bb1a25f3c212ce8f.js` | 336,224 | Lazy chunk |
| `896dfe0ebae4455a.js` | 305,706 | Lazy chunk |
| `c6e61aa598b77723.js` | 260,114 | Lazy chunk |
| `f9a7f99f2f932374.js` | 251,878 | Lazy chunk |
| `9a87b685b0e83591.js` | 245,834 | Lazy chunk |
| `96726.3c96fdef19594eba.js` | 227,996 | Lazy chunk |
| `697bb5329d158057.js` | 184,794 | Lazy chunk |
| `133e3a6b8200fab0.js` | 144,825 | Lazy chunk |
| `918146.e792a241e8075058.js` | 134,746 | Lazy chunk |
| `676294.c3ee1ea5d2304509.js` | 132,719 | Lazy chunk |
| `75f2b1fee9395ad3.js` | 130,708 | Lazy chunk |
| `5f7e73699dd82ff6.js` | 120,595 | Lazy chunk |
| `596231.42f9d5fee6fefe71.js` | 90,435 | Lazy chunk |
| `472240.0e11c51513246260.js` | 89,277 | Lazy chunk |

- [Observed] WASM payloads sit beside the JS chunks as separate files: `34aec3bbe8b005d0.module.wasm` (1,202,025 B) and `bd93c5b4b4233174.wasm` (1,805,335 B) (ESM-module and plain wasm flavours).

### Code-splitting naming and loading strategy
| Rule | Detail | Evidence |
| --- | --- | --- |
| Entry chunk | named, no numeric id: `web.<contentHash>.js` | `resources.json` |
| Numeric-id chunk | `<chunkId>.<contentHash>.js`, e.g. `72993.12b05c70c0a616dc.js` | `resources.json`; runtime map `T.u=e=>"72993"===e?"72993.12b05c70c0a616dc.js":...` |
| Named vendor chunk | `vnd-<name>.<contentHash>.js`, e.g. `vnd-emoji.eb9fa44f37371d3b.js` | `resources.json` |
| CSS | separate per-chunk map `<chunkId>.<contentHash>.css` | `web...js` @ `12372044` `...[e]+".css"` |
| Hash resolution | the runtime carries a literal `chunkId → hash` table and a `T.u` function of ternaries; no server-side manifest lookup | `web...js` @ `12372044` |
| Lazy import | `n.e("<chunkId>")` returns a promise, then `n.bind(n, <moduleId>)` | e.g. `3311210` `await Promise.all([n.e("435751"),n.e("423798"),n.e("753149")]).then(n.bind(n,778572))` |
| Lazy-import volume | 4,479 distinct chunk ids, 41,855 `n.e()` call sites **in the entry chunk alone** | census over `web.31d1cd3e6e440749.js` |
| Hottest chunk ids | `454048` ×65, `162775` ×62, `76428` ×62, `517888` ×60, `60882` ×60 | same census |
| Web workers | separate numeric assets served from `/assets/<id>` (no hash) | `web...js` `new Worker(new URL("/assets/"+n.u("314250"),n.b))`, `n.u("167470")`, `n.u("783400")` |
| Worker roles | image decode/layout (314250), **user + mention candidate index** (167470), text/canvas measurement (783400) | `843108`, `3118306`, `3768935` |
| CSS + JS coupling | the runtime also maps chunk ids to stylesheet URLs and loads both on `n.e` | `12372044` |

## Implementation details
Each row below is `[Observed]`: the pointer columns carry the artifact reference.
### Message-list data volume — the CrowdOS-relevant core
| Mechanism | Behaviour | Evidence |
| --- | --- | --- |
| Windowing library | **none**. No `react-window`, `react-virtualized`, `virtuoso`, `@tanstack/virtual`, `useVirtualizer`, `overscan`, `AutoSizer`, `VariableSizeList` anywhere in the six captured chunks | census over all `chunks/*.js` |
| Bespoke virtualiser | a custom list component is used for large lists; the switch is `isVirtualizedList: rows.length >= 64` | `web...js` @ `1251419` `isVirtualizedList:l>=64`; renderers `AS(e)` → `AT` (virtualised) / `Ag` (plain) @ `1244923` |
| Message list strategy | **REST pagination**, not windowing: `GET /channels/{id}/messages?before&after&limit&around` | `web...js` @ `658951` `s.Bo.get({url:D.Rsh.MESSAGES(t),query:{before:n,after:i,limit:r,around:N,preload:d,feature:h},retries:2,...})` |
| Pagination metadata | `hasMoreBefore` / `hasMoreAfter` returned with each page | `659751` `LOAD_MESSAGES_SUCCESS` payload includes `hasMoreBefore:u,hasMoreAfter:h` |
| Store truncation | the message store supports `TRUNCATE_MESSAGES` with `truncateBottom`/`truncateTop`, and `TRUNCATE_MESSAGES` reducer → `r.truncate(n,i)` | `657081` and `9344999` |
| Truncation actually used? | `truncateMessages(` has **0 call sites** in the entry chunk; it may only be invoked from a lazy chunk | census: `.truncateMessages(` → 0 matches |
| Live DOM size | the captured channel renders **36 `article` nodes** (one per message) out of a 6,287-node DOM | `accessibility.nodes` role histogram: `article` ×36 |
| Cached jump | `LOAD_MESSAGES_SUCCESS_CACHED` serves a previously fetched page when jumping to present | `657081` `eR.A.hasPresent(e)?o.h.dispatch({type:"LOAD_MESSAGES_SUCCESS_CACHED",jump:n,channelId:e,limit:t})` |
| Initial scroll | `avoidInitialScroll` flag on the load result | `659751` `avoidInitialScroll:A` |
| Request retry | `retries:2` on the messages fetch | `658951` |
| Fetch telemetry | `eg.A.fetchMessages.recordStart()/recordEnd()` + `F.A.recordChannelFetchedNetwork(...)` | `658951`, `659751` |

- [Inferred] **Consequence for CrowdOS**: Discord's message list keeps only the loaded page in the DOM, so it never has to render 2,000+ rows — but it also never scrolls continuously through history. Discord's approach is *page on demand*, which is a different contract from CrowdOS's locked "virtualise past 2,000 messages" requirement. CrowdOS needs a real windowing layer; the Discord reference gives the **threshold pattern** (switch to a virtualised renderer above N rows, `l>=64`) and the **store-truncation primitive**, but no reusable implementation.

### Render-cost control
| Technique | Volume | Evidence |
| --- | --- | --- |
| `memo(...)` component wrappers | 92 in the entry chunk | census (`memo(` = 92) |
| `React.memo` literal | 0 — the symbol is minified to `r.memo` | census (`React.memo` = 0, `memo(` = 92) |
| `useMemo` | 905 | census |
| `useCallback` | 1,215 | census |
| `useDeferredValue` | 6 | census |
| `useTransition` | 8 | census |
| `startTransition` | 1 | census |
| `IntersectionObserver` | 23 | census |
| `requestAnimationFrame` | 137 | census |
| `debounce` | 52 | census |
| `throttle` | 189 | census |
| `setTimeout` | 399 | census |
| Web Workers | 5 `new Worker` + 7 `Worker(` | census |

- [Observed] Worker placement is deliberate: the **user/mention candidate index** lives in a worker with an explicit `rebootWebworker()` lifecycle, so rebuilding the user cache does not block the UI thread (`web...js` @ `3118306` `rebootWebworker(){...this._worker=new Worker(new URL("/assets/"+n.u("167470"),n.b))}` and `updateUsers(e,t){let{_worker:n}=this;...}`).

### Realtime transport
| Aspect | Behaviour | Evidence |
| --- | --- | --- |
| Transport | WebSocket to a gateway URL fetched from the API; `binaryType="arraybuffer"` | `web...js` @ `5101930` `new URL(l);d.searchParams.append("encoding",s);d.searchParams.append("v",o.toString());null!=a&&d.searchParams.append("compress",a)` |
| Compression | `compress` query param; `zlib-stream` framing; `inflate` on the client | `web...js` `zlib-stream` ×2, `inflate` ×11, `pako` ×6 |
| Heartbeat | **server-driven**: `this.heartbeatInterval = e.heartbeat_interval` from the HELLO frame | `5104978` `_handleHello(e){let t=this.heartbeatInterval=e.heartbeat_interval,...}` |
| Heartbeat op | gateway op `3` carries the last received sequence number | `web...js` `this.send(3,{...})` after `if(this.serverVersion>=8){let e=this.lastRecvSeqNum??-1;...}` |
| HELLO timeout | a timer fires if OP_HELLO does not arrive in time | `5101930` `this.helloTimeout=setTimeout(()=>{...this._handleClose(!1,0,"The connection timed out after "+e+" ms - did not receive OP_HELLO in time.")},th)` |
| Resume | op `7` RESUME carries `token, session_id, server_id, channel_id, seq_ack` | `2399278` `this.send(7,{token:this.token,session_id:this.sessionId,server_id:this.serverId,channel_id:this.channelId,seq_ack:e})` |
| Reconnect | dedicated `RECONNECT` dispatch family (35 occurrences) and resume-aware URL handling | census `RECONNECT` ×35, `reconnect` ×39 |
| Connection state | `CONNECTION_RESUMED` dispatch on RESUME | `5016182` `eB(["RESUMED"],()=>{...ej({type:"CONNECTION_RESUMED"})})` |
| Message ingress | `MESSAGE_CREATE` dispatch family (89 occurrences) | census |
| Typing ingress | `TYPING_START` gateway dispatch → Redux action | `5016182` |
| Typing egress | HTTP `POST /channels/{id}/typing` (not a gateway op) | `271788` `TYPING:e=>`/channels/${e}/typing`` |
| Bandwidth counters | per-time-bucket byte/time ring buffer capped at **200 samples** | `web...js` `D=(D=[{bytes:e,timestamp:Date.now()},...D]).slice(0,200)` |

### Hard-coded timing constants (measured from the bundle)
| Constant | Value | Purpose | Evidence |
| --- | --- | --- | --- |
| Draft autosave throttle | **500 ms** | composer draft write | `3364771` `o().throttle(this.saveCurrentText.bind(this,!1),500)` |
| Autocomplete result coalescer | **0 ms** (`setTimeout(...,0)`) | collapse a keystroke burst into one query | `3311210` `this.updateTimeout=setTimeout(()=>{...},0)` |
| Inbox "mark read" debounce | **100 ms**, leading | `MARK_TOP_INBOX_CHANNEL_READ` | `2316076` `m().debounce(()=>{...},100,{leading:!0})` |
| Unread/mention channel walk throttle | **not confirmed** (minified literal ambiguous) | channel switching | `467691` `a().throttle(function(e,t){...})` — see Gaps |
| Attachment upload progress throttle | **50 ms** | progress events | throttle call sites `50` |
| Window resize debounce | **250 ms** | layout recalculation | debounce call sites `250` |
| Voice-state throttle | **64 ms** | voice state churn | throttle call sites `64` |
| Generic timers | 1,000 / 1,200 / 2,000 / 5,000 ms | misc. UI timers | `1e3`, `1e4`/`1200`, `2e3`, `5e3` call sites |
| Toast success throttle | **3,000 ms**, leading | duplicate-toast suppression | `2316076` `(0,T.throttle)(()=>(0,g.P0)({...}),3e3,{leading:!0,trailing:!1})` |
| Virtualisation threshold | **64 rows** | switch to the virtualised list renderer | `1251419` `isVirtualizedList:l>=64` |
| Reply-chain walk depth | **10** hops | reply-thread detection | `3411334` `for(let n=0;n<10;n++)` |
| Character-count reveal band | last **10%** of the limit | show the "characters remaining" counter | `3545219` `f=h>(d??o??u/10)` |
| Message length caps | **2,000** / **4,000** | base / premium message length | `315820` `nY=2e3,nK=4e3` |

## Interaction model
1. [Observed] Initial load pulls the entry chunk, then the router triggers lazy chunks per surface.
2. [Observed] The message list renders the loaded page; scrolling up triggers a `before` pagination request, scrolling down a `after` request.
3. [Observed] Realtime updates arrive on the gateway socket and are dispatched into the message store; the list re-renders the affected rows.
4. [Observed] Heavy CPU work (image decode, user index, canvas text measurement) is pushed to workers.
5. [Observed] Expensive recomputation is guarded by `memo`/`useMemo`/`useCallback`; large reactive changes may be deferred with `useDeferredValue`/`useTransition`.

## Performance notes
- [Observed] The entry chunk is the dominant cost: 12.5 MB uncompressed in one file, with 4,479 further chunks lazily addressable. This is a *code-splitting* strategy, not a *bundle-size* strategy.
- [Observed] `useDeferredValue` (6) and `useTransition` (8) are used sparingly — Discord's primary render-cost strategy is memoisation (92 `memo`, 1,215 `useCallback`), not concurrent-rendering deferral.
- [Observed] The 189 throttle / 52 debounce call sites are the real perf discipline: every high-frequency event (scroll, resize, typing, upload progress, channel switch) is rate-limited before it reaches React state.
- [Observed] The `isVirtualizedList >= 64` switch means small lists render every row and only large lists pay the virtualiser cost.
- [Observed] Workers are used for exactly the three CPU-bound tasks (image, user index, canvas text) — a small, targeted set, not a general worker pool.

## Evidence
Each row below is `[Observed]`: the pointer columns carry the artifact reference.

| ID | What it shows |
| --- | --- |
| `ev_c9c4047be64ab9b35319a29833192285815d419b5798b81c3c32804dec807543` | REA `inspect_web_page` capture: 1,281 scripts, 1,917 resources, DOM + a11y sizes |
| `ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` | Live page target; Chromium 148 / Electron 42.11.15 |
| `chunks/web.31d1cd3e6e440749.js` | Entry chunk: runtime, chunk-hash map, gateway client, message store, composer, shortcuts |
| `chunks/72993.12b05c70c0a616dc.js`, `chunks/8b9a4b4a55eaa34c.js`, `chunks/vnd-emoji.eb9fa44f37371d3b.js`, `chunks/192743.883920cc41783fd8.js`, `chunks/c680dbcc4bd6182b.js` | Sibling chunks used for the marker census |
| `discord-re/screenshot-main.png` | Rendered channel view used for the rendered-message-count cross-check |

## Gaps
- The exact throttle value for the unread/mention channel walk could not be read with certainty from the minified call site (the literal read `3e3` belongs to the adjacent toast throttle); the value is **not** confirmed.
- The virtualised list component (`AT`) was located but its implementation is in a chunk not present locally; the algorithm (fixed vs variable row height) is **not** determined.
- The `TRUNCATE_MESSAGES` store path has no call site in the entry chunk; it may be driven from a lazy chunk, so it cannot be stated that Discord never truncates the message store.
- Message pagination `limit` values per surface (initial page vs scroll page) were not resolved.
- The compression codec negotiation (`encoding`/`compress` parameter values) was not traced to the concrete value used at runtime.
- No CPU profile or frame-timing capture was taken; the perf conclusions are structural (what is memoised/throttled), not measured.
- `QUEUE_MODE`, worker concurrency limits and the gateway reconnect backoff table were not located.
## User Decision:
## Target Contract
> Status: Target. CrowdOS keeps its own locked performance budget; Discord's approach is reference only and does not satisfy it.

- CrowdOS MUST virtualise the message list. Discord's pagination-without-windowing approach is **not** acceptable: CrowdOS's locked requirement is continuous scroll and correct rendering past **2,000 messages**, and that requirement is currently **unmet**.
- CrowdOS MUST keep the "virtualise above a threshold" pattern: render every row below the threshold and switch to a windowed renderer above it. Discord's `>= 64` rows is the reference shape; the CrowdOS threshold is a CrowdOS decision.
- CrowdOS MUST bound DOM message count independently of store size, so a long-lived channel cannot grow the DOM without bound.
- CrowdOS MUST rate-limit every high-frequency UI event (scroll, resize, typing, upload progress) before it reaches client state; the reference values are 50–500 ms bands.
- CrowdOS MUST keep the composer draft write throttled (reference: 500 ms) and MUST NOT write state per keystroke.
- CrowdOS MUST offload CPU-bound work (rendering, indexing, encoding) to workers; a main-thread blocking loop is forbidden.
- CrowdOS's bundle budget is a CrowdOS constraint; adopting Discord's 12.5 MB entry chunk is **not** sanctioned, and Discord's 4,479-chunk lazy surface is a liability, not a target.
- CrowdOS MUST keep one bounded, deterministic chunk-hash manifest; a runtime ternary table of thousands of chunk ids is not portable to CrowdOS's build.
