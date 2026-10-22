# Evidence Index

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose
Provenance record for the whole Discord RE corpus in `RE/Discord Findings/`. It names every source the corpus drew on — the live REA CDP capture, the shipped static assets, and the desktop-shell extraction — and lists the REA evidence identifiers so that any claim in any sibling doc can be re-derived or re-checked. It is a reference, not a findings document: no behaviour is described here beyond what is needed to identify a source.

## How it works
Every finding in this corpus traces to exactly one of three source classes:

| Source class | What it is | How it was obtained | What it can and cannot establish |
| --- | --- | --- | --- |
| **Live client** | The running Discord desktop app (1.0.9264), observed through a loopback CDP endpoint | REA `list_browser_targets` + `inspect_web_page` against `http://127.0.0.1:9223` | Establishes what was **rendered**: DOM shape, accessibility tree, resource inventory, live targets. Does not establish what the app *would* do on interaction — no interaction was performed. |
| **Static shipped asset** | The webpack/rspack chunks the renderer actually loaded, read from a local chunk folder | Read as text from the running client's own asset directory | Establishes what the code **contains**: string vocabularies, module shapes, route definitions, permission flags. Does not establish what was rendered, nor the runtime state. |
| **Desktop-shell extraction** | The Electron main-process bundle from the installed app's `app.asar` | REA archive extraction of `app.asar` | Establishes what the **main process** contains: windows, tray, protocol registration, IPC, fuses. Does not establish renderer behaviour. |

Two consequences are stated up front because they bound the whole corpus:

* **The shell analysis is version 1.0.9262; the live renderer is version 1.0.9264.** The two are different builds of the same product (`Desktop Shell Delta.md:10-21`).
* **Every live observation is read-only.** Navigation and passive inspection only. No click, no message send, no settings change, no logout, no file write.

### How to read an evidence pointer
Two markers appear in the sibling docs and they mean different things:

| Marker | Meaning | Test |
| --- | --- | --- |
| `[Observed]` / `[Observed-from-bundle]` | Directly present in an artifact | The string, DOM node, accessibility node or module shape is quoted or node-indexed; a reader can find it at the cited offset |
| `[Inferred]` | Reasoned from a string or a DOM shape | The conclusion goes beyond the artifact. The reasoning is stated so it can be checked, but the rendered result was not observed |

The split matters because several of Discord's most interesting behaviours — permission resolution, owner suppression, group ordering, control widget types — exist **only in the bundle**: the UI that would render them was never opened.

## Structural inventory

### Sources

| Source | Identity | How obtained | Used for |
| --- | --- | --- | --- |
| Discord desktop (live) | Discord 1.0.9264; `Discord.exe` 219,700,152 B, sha256 `a3b0cf011eb75f568963fd0942648455e125b030b4b578fec652dc0b4e747561`; Electron 42.11.15 / Chromium 148.0.7778.280 | Installed app at `C:\Users\Asus\AppData\Local\Discord\app-1.0.9264\` | Target of every live observation; identity of the analysed renderer |
| CDP endpoint | `http://127.0.0.1:9223` | Discord launched with remote debugging | The transport for every `list_browser_targets` / `inspect_web_page` call |
| Main page target | `A726384904E087D2F74FC6B86E22A4BD` — `https://discord.com/channels/@me` | `rea_list_browser_targets` | The page every live capture was taken against |
| Live capture (REA evidence) | `ev_c9c4047be64ab9b35319a29833192285815d419b5798b81c3c32804dec807543` | `rea_inspect_web_page` | The 2.7 MB capture: DOM node list, accessibility tree, script + resource inventories |
| Live capture (local file) | `C:\Users\Asus\AppData\Local\Temp\opencode\discord-re\inspect-main.json` (2,701,058 B) | written by the capture | The same content, addressed by node index in the sibling docs (`accessibility.nodes[N]`, `dom.nodes[N]`) |
| Live capture (screenshot) | `C:\Users\Asus\AppData\Local\Temp\opencode\discord-re\screenshot-main.png` (401,441 B) | viewport capture | Corroborating cross-check only; the accessibility tree is authoritative wherever the two disagree (`Shell and Navigation.md:229`) |
| Entry chunk | `web.31d1cd3e6e440749.js` — 12,547,650 B, sha256 `5e48910d7993de9164fc0be6d4762276d5a195946014a9825546df5b04e91424` | read from the local chunk folder | The majority of the corpus: routes, permission model, role model, message store, composer, shortcuts, settings registry |
| Sibling chunks | `8b9a4b4a55eaa34c.js` 1,433,778 B · `72993.12b05c70c0a616dc.js` 1,268,835 B · `vnd-emoji.eb9fa44f37371d3b.js` 1,192,954 B · `192743.883920cc41783fd8.js` 698,302 B · `c680dbcc4bd6182b.js` 437,962 B | same | UI kit, composer copy, emoji dataset, legacy editor |
| Further chunks (downloaded by the message-list agent) | `9a87b685b0e83591.js` 245,834 B · `727ee9421e324cee.js` · `681e846fab87a0c8.js` · `8b980d157af44f08.js` · `e921316e4ac02b0c.js` · `d5621fd9c10fcdb0.js` · `80607ee23894299a.js` · `697bb5329d158057.js` 184,794 B · `5f7e73699dd82ff6.js` 120,595 B · `c859f3f5e6fac4b2.js` · `c6e61aa598b77723.js` 260,114 B · `063734acaba763c6.js` · `193433.213ada0bddfee7ee.js` | same | Message-list DOM, scroll host, context-menu vocabulary, thread copy |
| Stylesheets | `193433.6c7be9d5d6e8b51f.css` · `97585.c5d9b4ece02fa77e.css` | same | Scroll host and content-column CSS (`Scroll Model.md:29`, `:163-164`) |
| WASM payloads | `bd93c5b4b4233174.wasm` 1,805,335 B · `34aec3bbe8b005d0.module.wasm` 1,202,025 B | same | Two wasm flavours loaded beside the JS chunks (`Performance Model.md:45`) |
| Desktop-shell extraction | `C:\Users\Asus\AppData\Local\Temp\rea-extracted-28ad0afc-7933-4aca-85f7-86872b24a99c` — Discord **1.0.9262** bootstrapper: `bundle.js` 3,066,301 B, `splashScreenPreload.js` 9,333 B, `package.json` 883 B, `splash/` (index.html 198 B, index.css 5,394 B, 2 woff2 fonts, 1 png, `connecting.webm` 160,381 B, `connecting.webp` 309,074 B), `data/quotes_copy.json` 410 B | REA archive extraction of the 1.0.9262 `app.asar` | Main-process shell: windows, protocols, IPC, updater, crash reporter, external-open guard |
| 1.0.9262 `app.asar` | sha256 `cbd26748b01c1b4847dc5471c4d2e1e46d69b0eb6f6c3347aa66ca992267e9b8` | the archive that was extracted | Identity of the analysed shell build |
| Installed 1.0.9264 `app.asar` | sha256 `0025c02c7241045a12464309604ec4d5b8ec7ed2ce43cce05d5dacb8f253f672` | read from the installed app folder (not extracted) | Identity of the installed build; the version delta |
| Electron fuses | `ev_0e5a620c465f50fc5deddd43770a59450773aac1a68ebbf4c8118cba092c986d` | `rea_inspect_electron_fuses` on the installed 1.0.9264 `Discord.exe` | The 9 fuse states; sentinel at file offset 182,144,240, one sentinel found, slice 0 complete |

### REA evidence identifiers

Every `ev_` identifier referenced anywhere in the 12 sibling docs or in `../Implementation Spec/Traceability Matrix.md`, with what it shows. Ids are listed once regardless of how many docs cite them. The "Cited by" column is the result of grepping the corpus: the denominator is the 13 corpus documents that can carry an `ev_` id (the 12 sibling findings documents plus the Traceability Matrix).

| Evidence ID | Operation | What it shows | Cited by |
| --- | --- | --- | --- |
| `ev_c9c4047be64ab9b35319a29833192285815d419b5798b81c3c32804dec807543` | `inspect_web_page` | The 2.7 MB live capture: DOM node list, accessibility tree, script + resource inventories (1,281 scripts, 1,917 resources, 1,275 JS) | Cited by 4 of 13 corpus documents: Composer, Keyboard and Accessibility, Performance Model, Traceability Matrix |
| `ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` | `list_browser_targets` | Live client identity and page target `A726384904E087D2F74FC6B86E22A4BD` — discord/1.0.9264, Electron 42.11.15, Chromium 148.0.7778.280, `https://discord.com/channels/345096814443233301/345096814443233302` | Cited by 11 of 13 corpus documents (10 Discord findings docs + Traceability Matrix) — the corpus's anchor id; Interaction Vocabulary and Threads cite no `ev_` id at all |
| `ev_3e8a617d71c30123acd91bdd67d5bffa67f95b46a7a234302d5d56011803e6ee` | `list_browser_targets` | Target listing at `https://discord.com/channels/@me/settings` — URL accepted, title still the DM home | Cited by 2 of 13 corpus documents: Settings Surface, Shell and Navigation |
| `ev_8e4577c4c784609722717f3cc11defd43bc608752720c04af6ad8327b262e2f2` | `inspect_web_page` | Full passive inspection of the settings URL page — DM home ("Friends"), **no settings panel mounted, no settings chunk fetched** | Cited by 2 of 13 corpus documents: Settings Surface, Shell and Navigation |
| `ev_ec275e7a45eba270e77a93be6373ef91ad3da2db75e727ae63deea386d94850f` | `inspect_web_page` | Second live capture: the `"new"` unread separator (a11y `7353`), the "Message Actions" hover-toolbar groups (`6981`, `7146`, `7198`, `7250`, `7302`), author and server-tag buttons (`5201` `Falheim`, `5228` `Server Tag: TORN`) | Cited by 3 of 13 corpus documents: Interaction Vocabulary, Message List, Scroll Model |
| `ev_0e5a620c465f50fc5deddd43770a59450773aac1a68ebbf4c8118cba092c986d` | `inspect_electron_fuses` | The 9 Electron fuse states of the installed 1.0.9264 `Discord.exe`; sentinel offset 182,144,240 | Cited by 2 of 13 corpus documents: Desktop Shell Delta, Traceability Matrix |
| `ev_78edfbaacda3d815d39889246e1c469665eadc0e7734238c8044c3a23ecbe6d2` | (screenshot) | Live viewport capture of the client session | Cited by 0 of 13 corpus documents — recorded here for completeness |
| `ev_fb58b03a853cdca32bd762b1dc1bbd29998e55b4f884e8cf91d3d02a33881277` | (target list) | A second CDP target listing | Cited by 0 of 13 corpus documents — recorded here for completeness |

### Electron fuses as read (1.0.9264 `Discord.exe`)

| Fuse | State |
| --- | --- |
| `RunAsNode` | disabled |
| `EnableCookieEncryption` | disabled |
| `EnableNodeCliInspectArguments` | disabled |
| `EnableEmbeddedAsarIntegrityValidation` | disabled |
| `OnlyLoadAppFromAsar` | disabled |
| `LoadBrowserProcessSpecificV8Snapshot` | disabled |
| `EnableNodeOptionsEnvironmentVariable` | **enabled** |
| `GrantFileProtocolExtraPrivileges` | **enabled** |
| `WasmTrapHandlers` | **enabled** |

Source: `ev_0e5a620c465f50fc5deddd43770a59450773aac1a68ebbf4c8118cba092c986d`; tabulated with consequences in `Desktop Shell Delta.md:148-163`.

## Implementation details

### The read-only discipline actually followed
The corpus was produced under a hard constraint: **observe, do not interact**. Concretely, across the whole session:
* No click, no hover activation, no menu open, no double-click.
* No message sent, no message deleted, no reaction added.
* No settings changed, no permission toggled, no role created or edited.
* No logout, no account or server change, no channel join or leave.
* No file written into the application, and no application state mutated by any tool.

Navigation was attempted by URL only, and the results of those attempts are themselves recorded as findings: `/channels/@me/settings` was accepted as a URL but rendered the DM home, and `/settings/account` and `/guilds/<id>/settings` both redirected back to the last channel (`Settings Surface.md:10`, `:46`; `Shell and Navigation.md:228`).

### The one recorded tool failure, and its workaround
The browser-scenario runner failed once, verbatim:

> "Analysis could not complete. Run `rea doctor` and review the reported details; repeating the unchanged request is not expected to succeed."

Provider `rea-playwright-browser-scenario`, detail `"Scenario navigation failed before the initial state was captured."` (`Shell and Navigation.md:227`).

The navigation itself did complete — the console events prove the page loaded and reached `/channels/@me/settings` — so the failure was in the capture step, not the navigation. The workaround was to fall back to the **passive** `rea_inspect_web_page`, which produced `ev_8e4577c4c784609722717f3cc11defd43bc608752720c04af6ad8327b262e2f2` and answered the same question without any interaction. No further scenario-runner attempts were made after the failure.

### The version delta
| Item | Analysed shell | Live renderer |
| --- | --- | --- |
| Version | 1.0.9262 (extracted `app.asar`) | 1.0.9264 (installed `app.asar`, sha256 `0025c02c7241045a12464309604ec4d5b8ec7ed2ce43cce05d5dacb8f253f672`) |
| Electron | devDependency 42.7.1 | runtime 42.11.15 |
| Chromium | — | 148.0.7778.280 |
| Extra native artefacts | none | `updater.node` (4,550,072 B), `discord_wer.dll` (451,512 B) |

The delta is stated rather than smoothed over: the shell findings describe a **bootstrapper**, because the 1.0.9262 `package.json` names it `"Discord Client for Desktop - Bootstrapper"` and the only `BrowserWindow` it constructs is the splash (`Desktop Shell Delta.md:21`, `:230`).

## Interaction model
This corpus contains **no interactions**. It contains observations of state. A reader should therefore treat every evidence pointer as one of two things:

| Pointer kind | What it licenses the reader to claim | Example |
| --- | --- | --- |
| **Observed** | "In the artifact, at the cited location, this string / node / module is present." | `inspect-main.json` → `accessibility.nodes[609]` carries `, Private Channel (locked)` — a locked private voice channel existed in the live channel list (`Roles and Authority.md:64`) |
| **Inferred** | "Given the artifact, this is the most likely explanation." The reasoning is stated and can be disagreed with. | "The settings window is a separate browser context" — inferred from `isAppRoute` excluding `/settings/*` plus the observed redirect (`Settings Surface.md:47`) |

Two practical rules for re-checking a claim:
1. **Node indices are positional, not stable.** `accessibility.nodes[7353]` identifies a node in the capture as taken; a fresh capture will not reproduce the same index.
2. **A bundle quote is stronger than a rendered observation** for structure (routes, flags, module shapes) and weaker for behaviour (what the user sees when a rule fires). The corpus labels this difference inline rather than flattening it.

## Performance notes
| Artifact | Size | Consequence |
| --- | --- | --- |
| `web.31d1cd3e6e440749.js` | 12,547,650 B | The entry chunk alone is ~12.5 MB; a full text read is impractical, so findings are cited by module id or byte offset (`Performance Model.md:47-60`) |
| Five sibling chunks | 1,433,778 / 1,268,835 / 1,192,954 / 698,302 / 437,962 B | Secondary chunks carry the long UI copy that the corpus quotes most often |
| Two WASM payloads | 1,805,335 / 1,202,025 B | Loaded as separate assets; not decompiled |
| `inspect-main.json` | 2,701,058 B | 3,215 accessibility nodes and 6,287 DOM nodes in one file (`Shell and Navigation.md:210-211`); the DOM capture strips attribute **values**, so class names come from the bundle instead (`Shell and Navigation.md:211`) |
| `screenshot-main.png` | 401,441 B | Used sparingly as a corroborating cross-check |
| `bundle.js` (shell) | 3,066,301 B | Main-process bundle; a census by string count is the practical read technique |
| One page load | 1,281 scripts, 1,917 resources | The full asset inventory of the session |

**Why the corpus does not vendor Discord's code.** No third-party source is committed into this repository. Every Discord artifact lives outside the repo — in the temp capture directory, the local chunk folder, or the installed application folder — and is referenced by **name, size and digest** in this index and in the sibling docs. A reader can therefore verify that they are looking at the same artifact the findings were read from, without the repo carrying a licence problem or a 12 MB binary. The single sha256 recorded for the entry chunk (`5e48910d7993de9164fc0be6d4762276d5a195946014a9825546df5b04e91424`) is the anchor for that check; the remaining chunk digests were not recorded and are listed here by name and size only.

## Evidence
| ID / pointer | What it shows |
| --- | --- |
| `ev_c9c4047be64ab9b35319a29833192285815d419b5798b81c3c32804dec807543` | Live capture: DOM, accessibility tree, script + resource inventories (2.7 MB) |
| `ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` | Live client identity and page target `A726384904E087D2F74FC6B86E22A4BD` |
| `ev_3e8a617d71c30123acd91bdd67d5bffa67f95b46a7a234302d5d56011803e6ee` | Target listing at the settings URL — URL accepted, DM home still rendered |
| `ev_8e4577c4c784609722717f3cc11defd43bc608752720c04af6ad8327b262e2f2` | Passive inspection of the settings URL page — no settings panel mounted, no settings chunk fetched |
| `ev_ec275e7a45eba270e77a93be6373ef91ad3da2db75e727ae63deea386d94850f` | Second live capture: unread separator, hover toolbar, author / server-tag buttons |
| `ev_0e5a620c465f50fc5deddd43770a59450773aac1a68ebbf4c8118cba092c986d` | Electron fuses of the installed 1.0.9264 `Discord.exe` (9 fuses) |
| `ev_78edfbaacda3d815d39889246e1c469665eadc0e7734238c8044c3a23ecbe6d2` | Live screenshot capture (not cited by any sibling doc) |
| `ev_fb58b03a853cdca32bd762b1dc1bbd29998e55b4f884e8cf91d3d02a33881277` | Second CDP target listing (not cited by any sibling doc) |
| `C:\Users\Asus\AppData\Local\Temp\opencode\discord-re\inspect-main.json` (2,701,058 B) | The live capture as a local file; node-indexed in the sibling docs |
| `C:\Users\Asus\AppData\Local\Temp\opencode\discord-re\screenshot-main.png` (401,441 B) | Corroborating viewport capture of the guild-channel session |
| `C:\Users\Asus\AppData\Local\Temp\opencode\discord-re\{a11y,dom,resources,scripts}.json` | Per-section extracts of the same capture |
| `C:\Users\Asus\AppData\Local\Temp\rea-extracted-28ad0afc-7933-4aca-85f7-86872b24a99c\bundle.js` (3,066,301 B) | Discord 1.0.9262 bootstrapper main process |
| `…\splashScreenPreload.js` (9,333 B) | Splash renderer preload |
| `…\package.json` (883 B) | `"Discord Client for Desktop - Bootstrapper"`, `main: bundle.js`, `electron 42.7.1` |
| `…\splash\{index.html, index.css, fonts\, images\, videos\}` | Splash window assets |
| `…\data\quotes_copy.json` (410 B) | Splash quote source |
| 1.0.9262 `app.asar` | sha256 `cbd26748b01c1b4847dc5471c4d2e1e46d69b0eb6f6c3347aa66ca992267e9b8` — the archive that was extracted |
| Installed 1.0.9264 `app.asar` | sha256 `0025c02c7241045a12464309604ec4d5b8ec7ed2ce43cce05d5dacb8f253f672` |
| `Discord.exe` (1.0.9264) | 219,700,152 B, sha256 `a3b0cf011eb75f568963fd0942648455e125b030b4b578fec652dc0b4e747561` |
| `chunks/web.31d1cd3e6e440749.js` | 12,547,650 B, sha256 `5e48910d7993de9164fc0be6d4762276d5a195946014a9825546df5b04e91424` — entry/runtime chunk |
| `chunks/8b9a4b4a55eaa34c.js` | 1,433,778 B — composer copy, long-message copy, scheduled messages |
| `chunks/72993.12b05c70c0a616dc.js` | 1,268,835 B — shared UI kit |
| `chunks/vnd-emoji.eb9fa44f37371d3b.js` | 1,192,954 B — emoji dataset + picker |
| `chunks/192743.883920cc41783fd8.js` | 698,302 B — legacy editor, mention helpers |
| `chunks/c680dbcc4bd6182b.js` | 437,962 B — secondary chunk |
| `chunks/9a87b685b0e83591.js` (245,834 B) · `727ee9421e324cee.js` · `681e846fab87a0c8.js` · `8b980d157af44f08.js` · `e921316e4ac02b0c.js` · `d5621fd9c10fcdb0.js` · `80607ee23894299a.js` · `697bb5329d158057.js` (184,794 B) · `5f7e73699dd82ff6.js` (120,595 B) · `c859f3f5e6fac4b2.js` · `c6e61aa598b77723.js` (260,114 B) · `063734acaba763c6.js` · `193433.213ada0bddfee7ee.js` | Further chunks downloaded for the message-list and scroll work |
| `chunks/193433.6c7be9d5d6e8b51f.css` · `chunks/97585.c5d9b4ece02fa77e.css` | Scroll-host and content-column stylesheets |
| `chunks/bd93c5b4b4233174.wasm` (1,805,335 B) · `chunks/34aec3bbe8b005d0.module.wasm` (1,202,025 B) | WASM payloads |

## Gaps
- **The member list was never observed open.** The right-panel member list was captured **closed** — the channel header shows `button "Show Member List"` (`inspect-main.json` → `accessibility.nodes[333]`) and no sibling right column exists in the captured tree (`accessibility.nodes[108]`). Everything in `Right Panel and Members.md` about the member list is read from the bundle; only the header affordances and the closed state are live observations.
- **The settings surface never rendered.** `/channels/@me/settings` loaded the DM home (title `"Friends"`, `accessibility.nodes[99]`) and no settings chunk was fetched (`ev_8e4577c4c784609722717f3cc11defd43bc608752720c04af6ad8327b262e2f2`). Discord's settings open in a separate window reachable only by activating the UI, which the read-only constraint forbids. The whole of `Settings Surface.md` is therefore bundle-derived.
- **The live application window is not in the analysed 1.0.9262 artifact.** That artifact is a bootstrapper: it creates only a 300×N splash window. The real application window's `BrowserWindow` options, tray, window-state persistence and its own IPC live in a separately downloaded package that was not extracted (`Desktop Shell Delta.md:230`).
- **The 1.0.9264 `app.asar` was not extracted.** Its digest is recorded, but its contents were never read, so whether the main-process surface changed between 1.0.9262 and 1.0.9264 is unverified (`Desktop Shell Delta.md:231`).
- **Permission bit values were never extracted.** The flags live behind a re-export, so names and semantics are evidenced but the numeric values are not (`Roles and Authority.md:249`).
- **The `@everyone` role's permission set for the observed server was not read** — no live guild settings or role list was ever opened (`Roles and Authority.md:251`).
- **Digests are missing for most static assets.** Only the entry chunk has a recorded sha256. The sibling chunks, further chunks, stylesheets and WASM payloads are referenced by name and size only, so a reader can identify them but cannot verify them cryptographically.
- **Two evidence ids are unanchored.** `ev_78edfbaacda3d815d39889246e1c469665eadc0e7734238c8044c3a23ecbe6d2` and `ev_fb58b03a853cdca32bd762b1dc1bbd29998e55b4f884e8cf91d3d02a33881277` are recorded here but cited by no sibling doc, so their exact content is described by label only.
- **The local chunk folder is not named in the corpus.** The sibling docs cite chunk files by bare filename; the absolute folder path that holds them is not recorded anywhere in the corpus, so the chunks are not directly openable from this repo.
- **Two workspace-native assets were not analysed.** `updater.node` (a native addon with an unknown interface) and `discord_wer.dll` (the Windows Error Reporting handler) are observed by presence and size only (`Desktop Shell Delta.md:232-233`).

## User Decision:

## Target Contract
> Status: Target. This index is the provenance contract for the Discord RE corpus. It governs how Discord findings are written from here on; it does not constrain CrowdOS's own design, which stays governed by `CrowdOS.md` and `UX_GUIDELINE.md`.

* Every Discord finding in this corpus MUST carry an evidence pointer — a file, a byte offset, a module id, a node index, or a REA evidence id — that a reader can follow to the artifact it came from.
* A finding MUST NOT restate the corpus without a new pointer. If a claim is already evidenced elsewhere in the corpus, the new doc MUST cite the existing evidence rather than re-deriving or re-paraphrasing it.
* Every claim MUST be labelled `[Observed]` or `[Inferred]`. A claim with neither label, or with a label that contradicts its pointer, is a defect.
* A node index (`accessibility.nodes[N]`, `dom.nodes[N]`) MUST be reported as positional — "the node at index N in the capture as taken" — and never as a stable identifier for a UI element.
* A version MUST be named with every claim. The shell is 1.0.9262, the renderer is 1.0.9264; a claim that mixes the two must say so explicitly.
* A claim about a behaviour that was never exercised MUST be labelled `[Inferred]` and MUST state that the rendering path was not observed. This applies to permission resolution, owner suppression, group ordering, control widget types and settings save/discard.
* Discord source MUST NOT be committed into this repository. Artifacts are referenced by name, size and digest; if a digest is unavailable, the gap is stated rather than filled with a guess.
* A tool failure MUST be recorded verbatim, with its provider and detail, together with the workaround that produced the answer instead.
* A new Discord finding that requires interaction MUST either be marked as outside the read-only boundary or be carried in a separate, explicitly interactive session document; it MUST NOT be smuggled into this corpus as an observation.
