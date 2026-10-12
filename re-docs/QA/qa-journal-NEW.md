# QA Journal NEW - ThisCrowd Electron App (first-time end user, visual-first)

Date: 2026-09-29. Persona: curious newcomer + QA, never touched the app. Method: Computer Use only (oa/sky). Only doc read: README.md.

Environment: Electron window Crowd OS already running on http://127.0.0.1:22077/. Exploratory resources: model http://localhost:20128/v1 oc/mimo-v2.6-flash-free / DB postgresql://postgres:nemoid148@localhost:5432/Nightly.

> Phase 1 is blind. Findings logged IMMEDIATELY when seen, then exploration continues. No batch recall.

## Chronological Findings Log

- [F1] OBSERVED (setup screen, first-run): both action buttons are DISABLED on a fresh view with empty name field; typing a workspace name enables Create local workspace. As a newcomer this reads as a dead screen until I discover the name field drives the buttons. Repro: launch app, look at setup screen before touching anything; buttons 44 and 45 disabled; enter name; button 45 enables. Severity: low (confusion).

- [F2] SURPRISE (after Create local workspace named QA Fresh Eyes): app lands in the workspace but the right panel shows a raw SQL failure: Failed query: select ... from workspaces ... where id=$1 with workspace id ws_6e971de939ec. As a newcomer I just created a local workspace and the first thing I see is a database error. Repro: enter name > Create local workspace > look at right Repository panel. Severity: high (trust-breaking first impression; local mode should not surface SQL).

- [F3] CONFUSION (workspace chrome, top status): yellow banner reads Database unavailable. Running on local files; memory search is degraded. I explicitly chose no-database local mode, so being warned that the database is unavailable feels contradictory. Repro: create local workspace > read top status line. Severity: low (wording).

- [F4] DEFECT? (Channels drawer, + beside General): clicking the Create Channel + button shows no dialog and no visible reaction after repeated clicks. Repro: in left nav click element Create channel in General 3 times > nothing appears. Severity: medium (core creation flow looks dead).

- [F4-CORRECTION] CORRECTION to F4: the Create Channel dialog DID open, but only after a delay/re-observe (dialog element 125 Create Channel appeared on a later read). As a newcomer the button still felt dead because there was no instant feedback. Revised: not a dead flow, but a responsiveness problem (no immediate acknowledgement). Repro: click + > wait > re-read screen. Severity: low-medium.

- [F5] CONFUSION (Create Channel dialog): the X close button did not visibly dismiss the dialog on first click (dialog still present on re-read); pressing Escape did dismiss it. Repro: open Create Channel > click X > re-read > still open > press Escape > gone. Severity: low.

- [F6] BLOCKER? (chat send, #general): my plain hello message was delivered, but every agent reply is a 403 GoogleAdapter PERMISSION_DENIED error (unregistered callers / use API Key). Four error messages stack up with no plain-language guidance. The app gave me no way at send time to know the model backend was not configured. Repro: type any message in #general > Send > watch agent replies. Severity: high as first-use experience (chat looks broken out of the box).

- [F7] DISCOVERY (settings console): clicking Open settings DOES work (opens Admin Console panel on the right with Workspace/Agents/Permissions/Model Modules/Skills Manager/etc). So the app does expose configuration, but as a newcomer I had to hunt for the model backend after the chat errors. No defect here; noting the path: gear icon > Admin Console > Model Modules presumably holds the fix for F6.

- [F8] ROOT-CAUSE CLUE (Admin Console > Model Modules): panel states No model providers configured / Register a provider above to enable agent orchestration. No default provider is assumed. This explains F6 (GoogleAdapter 403 with no key). As a newcomer, the setup flow never told me a model key was required before chatting. Repro: gear > Model Modules > read Registered Model Providers. Severity: medium (onboarding gap, not a crash).

- [F9] POSITIVE (New model module form): the provider form offers Provider dropdown, Model field, temperature, max tokens, CUSTOM BASE ENDPOINT URL, and API key. The endpoint hint even shows http://localhost:11434 as an example, which matches my exploratory resource (localhost:20128). As a newcomer this is the first screen that looks like it can fix chat. No defect; will try wiring the provided local endpoint next.

- [F10] POSITIVE (register provider): filling Module name + Model + custom endpoint + API key and clicking Initialize Register DOES create a row (QA Local Brain / google / oc/mimo-v2.6-flash-free / Base http://localhost:20128/v1) with Test/Edit/De-register. No defect; the happy path works. Next I will Test handshake, then retry chat.

- [F11] DEFECT (Model Modules > Test handshake): Test returns a truncated bare error Google API returned status 404: with no detail, no hint that my custom endpoint uses an OpenAI-style proxy path while the Provider is Google Gemini. As a newcomer I cannot tell whether the URL, model id, key, or provider choice is wrong. Repro: register provider with Base http://localhost:20128/v1 + Google Gemini > Test > read row. Severity: medium (diagnostics).

- [F12] DEFECT? (Model Modules > Edit): clicking Edit shows no edit form on re-read (panel still lists the provider row, no 264 New model module fields). Either the click missed or Edit does nothing visible. Repro: Model Modules row > Edit > re-read panel. Severity: low-medium, needs verification.

- [F12-CORRECTION] CORRECTION to F12: retrying Edit DID open the edit form (Module name fields present). First attempt was likely a timing artifact. Downgrade F12 to responsiveness note, not a dead button.

- [F13] DISCOVERY (Edit provider > Provider dropdown): options include Google Gemini / OpenAI / Anthropic / Ollama (Local) / Custom OpenAI-Compatible API. My endpoint is OpenAI-compatible, so Google Gemini was the wrong provider choice. The form never suggested which provider matches a custom URL. As a newcomer I guessed Google because it was preselected. Severity: low (guidance gap). Will switch to Custom and retest.

- [F14] GLITCH (Edit provider dropdown): clicking the Custom option threw an over-Chrome-Legacy-Window targeting error, yet on re-read the Provider field DID change to Custom OpenAI-Compatible API. So the selection worked despite the error. As a newcomer the error text (visible only to automation) was invisible; I only see the value changed. Repro: open Provider dropdown > click Custom > targeting warning. Severity: low (overlay/focus quirk).

- [F15] STALE-UI (Model Modules row after provider switch): Commit Update changed the row provider google > custom (visible after ~5s settle), but the old error Google API returned status 404: remains pinned under the row. As a newcomer I cannot tell whether the error belongs to the old Google config or the new custom one. Repro: Edit > Provider Custom > Commit Update > wait > read row. Severity: low-medium.

- [F16] DEAD-END (Test handshake on Custom provider): Test now reports Unknown provider custom: no probe endpoint, configuration not validated. So Google gives a bare 404 and Custom cannot be validated at all. As a newcomer with an OpenAI-compatible local proxy, both paths leave me stuck with no working Test. Repro: Custom provider row > Test > read message. Severity: medium.

- [F17] TIMING NOTE (Close Settings Panel): first re-read after clicking Close still showed the modal; a second re-read showed it gone. Same delayed-dismiss pattern as F4. Not a defect on its own, but the app repeatedly gives no instant feedback. Severity: info.

- [F18] MAJOR (chat still uses GoogleAdapter after Custom provider registered): second message still gets GoogleAdapter 403 replies at 10:32 PM. Registering a Custom provider did not rebind the agent; there is no visible default-provider switch. As a newcomer I did everything the UI offered and chat is still broken. Repro: register Custom provider > send another message > same Google 403s. Severity: high.

- [F19] INFO (Agents Board): lists one agent default-assistant / AI Assistant / L1 / Idle with Studio/Duplicate/Export/Edit/Delete. Same delayed-open pattern: first re-read still showed Workspace tab, second showed Agents Board. No defect; noting navigation works but sluggish.

- [F20] KEY DISCOVERY (agent Edit > Model module): agent default-assistant is bound to Model module Default flagship profile, while my working provider is QA Local Brain. This explains F18: nothing in the agent form told me to switch modules, and there is no Set-as-default on the provider row. As a newcomer the two screens (Model Modules vs agent Edit) feel disconnected. Repro: Agents Board > Edit agent > read Model module dropdown. Severity: high (binding gap). Will try switching the agent to QA Local Brain next.

- [F21] BLOCKER-ISH (agent Edit > Model module dropdown): the QA Local Brain option is visible but clicking it twice hits an over-Chrome-Legacy-Window targeting error and keyboard Down+Enter does not change the value (still Default flagship profile). As a newcomer I am now stuck: I found the binding but cannot switch it. Repro: Agents Board > Edit > Model module dropdown > click QA Local Brain (x2) / Down+Enter. Severity: high (blocks the F18 workaround).

- [F21-CORRECTION] CORRECTION to F21: on a fresh re-read the Model module field DOES show QA Local Brain. The keyboard Enter must have committed despite the overlay errors. Downgrade F21 from blocker to overlay-noise note; will Save and retest chat.

- [F22] UNCERTAIN SAVE (agent Edit > Save Configuration): after clicking Save, the Editing agent form closed (good), but there is no toast/confirmation and the table row shows no model-module column, so I cannot confirm the QA Local Brain binding persisted. Repro: Edit > pick QA Local Brain > Save > read Agents table. Severity: low (missing save feedback). Will verify via chat retry.

- [F23] CONFIRMED-ISH (agent rebind did not take effect for chat): third message still yields GoogleAdapter 403 at 10:37 PM despite agent Edit showing QA Local Brain + Save closing the form. Either Save did not persist, the running channel still pins the old module, or chat ignores the agent module. As a newcomer this is the third identical failure with no new guidance. Repro: rebind agent > Save > close settings > send message. Severity: high.

- [F24] NO-OP? (channel header Search button): clicking Search shows no search UI on re-read (same chat tree, no search field/dialog). Either it needs Ctrl+K only or the click did nothing visible. Repro: #general header > Search > re-read. Severity: low.

- [F24-CORRECTION] CORRECTION to F24: the header button I clicked (index 76) actually opened Omni search (dialog: Search channels, agents, history), not a broken Search. It lists general + default-assistant + enabled tools (web.search/sandbox.exec/github.read/db.query). So Search works; I misread which control it was. Downgrade F24 to label-confusion note.

- [F25] INFO (Omni search auto-dismiss): on the next re-read the Omni search dialog was already gone (no explicit close). It likely dismisses on focus loss. Not a defect; noting ephemeral behavior.

- [F26] NO-FEEDBACK (Pin mode toggle): clicking Pin mode for this channel shows no visible state change on re-read (same label, no pressed/selected announcement). I cannot tell whether it is on or off. Repro: composer > pin toggle > re-read. Severity: low.

- [F26-CORRECTION + F27] CORRECTION: Pin DID engage (now reads Mode pinned for this channel. Click to unpin) on the next settle; my F26 read was too early. New F27: Attach files button shows no attach/trigger menu on re-read (only the tooltip text). Either it opens a system dialog I cannot see via tree or the click did nothing. Repro: composer > Attach > re-read. Severity: low.

- [F27-CORRECTION + F28] CORRECTION: Attach DID open (Add photos & files / Recent files appeared one read later). New F28: Insert emoji shows no emoji grid on re-read (only the tooltip), while Attach needed a settle to appear. Either emoji opens nothing or it needs longer. Repro: composer > Insert emoji > re-read. Severity: low.

- [F29] NO-FEEDBACK (Mute channel toggle): clicking Mute shows no mute state/icon change on re-read (same label Mute Channel Notifications). I cannot tell whether the channel is muted. Repro: #general header > Mute > re-read header. Severity: low.

- [F28-CORRECTION + F30] CORRECTION: emoji picker DID open (Quick Emojis grid with Close emoji picker). My F28 read was too early again. New F30: Clear channel logs click shows no confirm dialog and no visible change (chat history intact); the only new UI is the emoji grid that appeared late. So Clear either did nothing or needs a confirm I never saw. Repro: header > Clear channel logs > re-read. Severity: medium (destructive action with no feedback). Leaving emoji picker open for now.

- [F31] STUCK-POPOVER (Quick Emojis picker): Close button (x2 reads), Escape, and picking an emoji all leave the Quick Emojis grid open, and the picked glyph never appears in the message box. The popover looks undismissable. Repro: Insert emoji > Close / Escape / pick glyph > re-read. Severity: medium (popover trap).

- [F31-CORRECTION] CORRECTION to F31: clicking the Insert emoji toolbar button again DID dismiss the picker. So Close/Escape/pick fail but toggle-off works. Downgrade from trap to inconsistent-dismissal note.

- [F32] INFO (emoji actually inserted): the composer now contains a grinning glyph (Document text shows it) even though the earlier read after picking showed an empty box. The insert worked with a delay. Also roster toggle swaps Repository panel for Operations roster correctly. No defect; noting delayed-visibility pattern again.

- [F33] ODD (panels vs emoji): toggling Workspace Sandbox left Operations roster in place (no sandbox/repository view appeared), and the Quick Emojis grid is open again even though I dismissed it. Either the toggle missed or panel switching is broken from this state. Repro: roster toggle > sandbox toggle > read right panel. Severity: low-medium.

- [F33-CORRECTION + F34] CORRECTION: sandbox toggle DID work on settle (Repository panel is back with the same SQL error as F2). New F34: workspace menu button (QA Fresh Eyes, index 63) shows no menu on re-read. Either it needs a longer settle or it did nothing. Also emoji grid reopened yet again. Repro: left nav > workspace name button > re-read. Severity: low.

- [F35] POSITIVE (Repository Manual mount): Manual opens an inline form (Channel Mount inherits category/workspace, Host Folder Path field, Browse/In-App Navigator, Save, Clear mount). No defect; this is the clearest repo-mount UI so far. Will try mounting a real folder next.

- [F36] DEFECT (Repository mount Save): entering a real local path and clicking Save keeps the panel on No repository / Not mounted with the same workspace SQL error. The typed path echoes below the field but nothing mounts and no success/error toast appears. Repro: Manual > type repo path > Save > wait > read Repository panel. Severity: medium-high (mount looks broken in local mode).

- [F37] RETRY-DEAD (Repository Try again): clicking Try again under The server could not read this folder leaves the identical SQL error in place after 5s. No retry spinner, no change, no guidance. Repro: Repository panel > Try again > wait. Severity: medium.

- [F38] NO-VALIDATION (bad mount path): saving Z:\does\not\exist\xyz produces no invalid-path message; panel still shows the generic workspace SQL error. Bad input is silently accepted into the field. Repro: Manual mount > type bogus path > Save. Severity: medium (input validation gap). Restoring the real path next would be ideal but continuing exploration.

- [F39] POSITIVE (Category & Channels settings): exposes New category + New channel forms plus General list with move/archive/delete. Validation looks sane (Create category / Assemble Area disabled while empty). No defect on sight; will try creating a channel here since the drawer + felt slow.

- [F40] POSITIVE (Category & Channels create): filling Channel name + keyboard-picking General + Assemble Area DID create qa-probe-two under General. Mouse-clicking the dropdown option hit the Chrome-Legacy overlay error twice, but keyboard Down+Enter worked. So channel creation works via settings even though the drawer + felt unresponsive. No defect; noting mouse-vs-keyboard gap. Will check whether the drawer shows the new channel after closing settings.

- [F41] POSITIVE (drawer sync): after closing settings, the left drawer lists qa-probe-two alongside general. Creation propagated. No defect. Will open qa-probe-two and probe its empty state next.

- [F42] EMPTY-STATE + MENTION (qa-probe-two): fresh channel shows Welcome + @default-assistant chip correctly (good empty state). But an @default-assistant mention still returns GoogleAdapter 403, confirming F23 across channels: the agent rebind did not change runtime behavior. Repro: open qa-probe-two > send @default-assistant hello > read replies. Severity: high (same root as F18/F23). Ending blind exploration here; moving to verification.

---

Phase 1 exploration ends. Total blind findings above (F1-F42 with corrections). Below is Phase 2 verification against the codebase.
