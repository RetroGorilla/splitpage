# Stage 0 audit 6: browser and desktop boundaries

What a shared session will cross today: stores, credentials, boot order, outside-the-editor update sources, app-data export, restart assumptions and the hosting environment. It describes today's code only; it proposes no design.

Baseline: `0ca1929177ffc84bced412ad2be3aa99690761d0` (main). Plan references are to `docs/COLLABORATION-PLAN.md` (section 12 items 6 and 8, sections 2, 3, 8, 9).

Tags: T01 to T24, MOVE, PROJ, SLICE, STORE, PERF as in the brief; `S2` serves no Stage 1 experiment.

## 1. Storage today

Browser stores are scoped by origin. The desktop app runs at `splitpage://app`, one default session, so all tabs and windows of the install share one origin and one localStorage; sessionStorage is per tab. Desktop moves history, blobs and drafts out of the renderer into main-process files (rows at the end of this section).

| Store | Holds | Scope | Owner (location) | Serves |
| --- | --- | --- | --- | --- |
| IndexedDB `splitpage-history` v3: `index` (keyPath `bucket`), `bodies` (keyPath `sha`) | Snapshot history per docId: title, lastOpenedAt, snapshot index, content-addressed bodies | Origin, browser only. Closes on `versionchange` | `src/adapters/storage/03c-history-idb.ts`; opened by `history-backends.ts` `historyOpenIdb`; used by `src/application/recovery/history.ts` | STORE, T17 |
| IndexedDB `splitpage-blobs` v1: `blobs` | Picture bytes keyed by sha256; record `{mime, size, bytes: Blob, addedAt, usedAt}`; strict durability; no eviction | Origin, browser only, global (not per document) | `src/adapters/storage/blob-store.ts` | STORE, T16 |
| IndexedDB `splitpage-files` v1: `handles` | One `FileSystemFileHandle` under key `last` | Origin, browser only | `src/adapters/files/last-file.ts` | S2 |
| localStorage `splitpage-snapshots` | Legacy snapshot list, migrated into history by `startHistoryMigration` | Origin | `src/application/recovery/legacy-snapshots.ts` | STORE |
| localStorage `splitpage-*` preference keys (autosave, clock, comment author, comments sort and filter, default wpm, desktop-notice, export directions, hide shot, microphone, onboarding, panel grouping, person color, prompter flip, mirror and scene mode, rundown, script scale, tag icons, tagging help, theme, tour, video thumbs, writer size) | Per-user settings and flags | Origin; shared by all desktop tabs | `src/application/preferences/preferences.ts` `KEYS` (plus the legacy key `splitpage-comments-hide-resolved`) | T02, S2 |
| localStorage `splitpage-broll-view` | B-roll panel view | Origin | `preferences.ts` `BROLL_VIEW_KEY` (outside `KEYS`); read and written in `src/bootstrap/wiring/preferences-owner.ts` | S2 |
| localStorage `splitpage-panel-widths`, `splitpage-comments-panel-width` | Panel widths | Origin | `src/application/preferences/panel-widths.ts` | S2 |
| localStorage `splitpage-recent-commands` | Command-menu recents | Origin | `src/features/command-menu/command-menu.ts` | S2 |
| localStorage `splitpage-last-export` | Last export choice | Origin | `src/features/file-menu/export-dialog.ts` | S2 |
| localStorage `splitpage-import-scans` | Import scan state | Origin | `src/features/imports/imports.ts` | S2 |
| sessionStorage `splitpage-conflict-stash`, `splitpage-conflict-reloaded` | Unsaved work held across a conflict reload; a guard against reload loops | Per tab | `src/application/recovery/conflict-stash.ts` | STORE |
| sessionStorage `splitpage-prompter-launch`, `splitpage-prompter-voice` | Prompter share token; voice relay port and token | Per tab | `src/features/prompter/prompter.ts` `readPrompterLaunch`; `src/adapters/desktop/voice-relay.ts` `setVoiceRelay` | S2 |
| In-memory `PAGE_NONCE` home | Identity of a document with no file | Per page load | `src/application/identity/document-identity.ts` | S2 |
| Cache Storage `splitpage-<VERSION>` | The five precached shell files, plus every other same-origin GET without a query that answered ok (cache-first branch of `sw.js`: for example `help.md`, `VERSION`) | Origin; browser only (the worker is not registered on desktop or `file:`) | `sw.js` | STORE |
| Desktop `userData/drafts/` | `session.json` (running, clean-exit, session-end); per-tab folder `<tabId>/` with two generations of state and `base-<sha12>.json`; `corrupt/` sits beside the tab folders and holds set-aside copies named `<tabId>-<ts>`. Durable tmp, fsync, rename | Per install; per tab id | `desktop/drafts.ts` `createDraftStore` (`corruptDir`) | STORE |
| Desktop `userData/history/` | `index.json`, `index.prev.json`, `FORMAT`, `bodies/`, `v1-backup/`, with caps | Per install | `desktop/history-fs-backend.ts` `createHistoryFsBackend`, wrapped by `createHistoryStore` | STORE |
| Desktop `userData/blobs/sha256/` plus `FORMAT` | Picture and video bytes by sha | Per install, global | `desktop/blob-store.ts` `createBlobStore` | STORE |
| Desktop `userData/desktop-state.json` v2 | Windows, bounds, tabs `{tabId, source, lastKnownTitle}`, recents (max 20), `lastSavedFolder` | Per install | `desktop/desktop-state.ts` `createDesktopStateStore` | STORE, T24 |
| Desktop `theme.json`, `updates/` | Theme at startup (plain `fs.writeFileSync`, not the durable writer: `desktop/window-appearance.ts` `createThemeChoice.write`); update downloads | Per install | `desktop/main.ts` | S2 |
| Desktop partitions `splitpage-update-download` and the print partition | Update download and print rendering; both opened with `cache: false` and no `persist:` prefix, so non-persistent | Per run | `desktop/main.ts`; `desktop/print-pdf.ts` | S2 |

What scopes data per document today:

| Key | Used by | Serves |
| --- | --- | --- |
| `docId` (a field of the document, dropped by Standalone export) | History `index` bucket and `historyListDocs`; the `splitpage-doc-ids` channel; desktop `doc-claims`; draft headers | STORE, T24 |
| Absolute path, as `pathKey(absPath)` | Desktop tab ownership (`pathToTabId`), claims (`"file:" + pathKey`), draft restore, recents | T24, STORE |
| Draft folder per `tabId` | Desktop drafts | STORE |
| Single `last` file handle | Browser resume; one handle for the whole origin | S2 |
| sha256 | Blobs: shared across documents, not owned by one | T16 |

Where new stores would sit (placement only):

| Store | Browser | Desktop | Serves |
| --- | --- | --- | --- |
| Local replica | A fourth IndexedDB database beside the three, in `src/adapters/storage/`, using the same open-and-close-on-`versionchange` pattern; keyed by instance id, not docId (shared docIds have no snapshots today) | A main-process store reached over IPC (plan section 8), beside `drafts/`, `history/`, `blobs/` under `userData`; initialised in `desktop/main.ts` next to `initDraftStore`, `initHistoryStore`, `initBlobStore` | STORE |
| Credential | None exists. Nothing in the browser is encrypted. `localStorage` is readable by any script in the origin | None exists. `safeStorage` and `keytar` are not used anywhere in `desktop/` | STORE |

## 2. Credentials today

| Question | Answer from code | Location | Serves |
| --- | --- | --- | --- |
| Any auth token, cookie or `Authorization` header stored or sent? | No account, session or collaboration credential. The only token-bearing traffic is the teleprompter share (rows below): tokens kept in sessionStorage and sent in a URL path | whole tree searched | STORE |
| Any WebSocket, beacon or remote `EventSource`? | No WebSocket or beacon. One `EventSource` exists: the prompter's voice relay opens `http://127.0.0.1:<port>/prompter-voice/<token>` (loopback, token in the path). Remote `fetch` uses `credentials: "omit"` (video oEmbed) or `"same-origin"` (prompter script) | `src/adapters/desktop/voice-relay.ts` `createRelayRecognition`; `shared/video-embed.ts`; `src/features/prompter/prompter.ts` | S2 |
| Where those tokens are kept and sent | `setVoiceRelay` stores `<port>-<token>` in sessionStorage `splitpage-prompter-voice`; `launchPrompterFromScript` fetches `prompter-script/<token>` (token in the path, `credentials: "same-origin"`); both tokens are also in the share URL fragment | `voice-relay.ts` `setVoiceRelay`; `prompter.ts` `launchPrompterFromScript` | T18 |
| Leftovers of the removed server and collab code (2026-10-28) | One: a test input `{ focus: "settings-collab-server" }`. Other "collaborator" hits are test wording only | `src/features/settings/actions.test.ts` | S2 |
| Secret-like value that exists today | Teleprompter share: a 32-byte hex token and a voice token, in memory, with a time limit, in the URL `http://host:port/?teleprompter=1#script=<token>&voice=<port>-<token>` over plain HTTP; `hostAllowed` checks the Host header | `desktop/prompter-share.ts` `createPrompterShare`, `SHARE_TTL_MS` | S2 |
| How the renderer treats that fragment | `readPrompterLaunch` strips query and fragment with `history.replaceState` and keeps the tokens in sessionStorage (`splitpage-prompter-launch`) | `src/features/prompter/prompter.ts` | T18 |
| Other in-memory grants | Video file grants; bundle export plan tokens | `desktop/ipc-shell.ts` `videoFileGrants`; `desktop/bundle-jobs.ts` | S2 |
| Share server response headers | `referrer-policy: no-referrer`, `cache-control: no-store`. `server/server.ts` and `src/page.html` set no referrer policy | `desktop/prompter-share.ts`; `server/server.ts` | T18 |
| Where desktop keeps anything secret-like | Nowhere on disk in the main process; share and grant tokens live in memory. The renderer keeps the prompter tokens in sessionStorage (browser tab opened from the share link) | `desktop/`; sessionStorage rows in section 1 | STORE |
| A stored capability that is not a secret | The file handle in `splitpage-files` | `src/adapters/files/last-file.ts` | S2 |
| Guard against secrets in app data | `assertNoSecrets` rejects bundle key names matching token, api key, client id, secret, password or pin, on export and import. It checks key names, not values | `src/features/settings/app-data.ts` | STORE |

## 3. Hydration entry

Read from the code; not traced at runtime. The document itself comes from the page's embedded `#state-data` (or the seed when `seedCheckPasses`), but stores are read during startup: appearance and other preferences (localStorage, at mount), the conflict stash (sessionStorage, step 7), the desktop draft (IPC call, step 7) and the last file handle (IndexedDB, step 8). The synchronous part of startup (steps 1 to 6) finishes before any queued microtask runs; the embedded state is read inside it, in step 4.

| # | Step | Location | Serves |
| --- | --- | --- | --- |
| 1 | `wireLegacyApp`, then `mountAndStart` mounts owners and features in the fixed order pinned by `tests/bootstrap/composition-root.test.ts` (`wireApp` builds location, page effects, action registry, export services, project file services, undo, session, saves, save destinations, transitions, document sources, merge, recovery, editor, production editing, preferences, shot hiding, export capture) | `src/bootstrap/main.ts`; `src/bootstrap/wiring.ts` | SLICE |
| 2 | `startAppWhenReady`: `mountAppearanceFeature` early, then `whenDocumentReady`, then `startApp` | `src/bootstrap/app.ts` | SLICE |
| 3 | `startApp`: `startActions`; `beginStartup`, which calls `takeDesktopDraft`: on desktop it only queues the IPC taker as a microtask, so no draft call happens yet | `src/bootstrap/app.ts`; `src/bootstrap/startup.ts`; `src/bootstrap/startup/desktop-draft.ts` | SLICE |
| 4 | `startApp` mounts the cell editing, preference watch, screen, chrome, panels and view features, then `openInitialDocument(startup)` calls `startup.openDocument()`, which calls `load` synchronously: `loadInitialState` (declared `async` but has no `await`) reads the embedded `#state-data` and calls `markWrittenOut` now, and only its already-resolved promise is picked up later, in step 7 | `src/bootstrap/app.ts`; `src/bootstrap/wiring/startup.ts`; `src/bootstrap/startup/document-entry.ts` `loadInitialState` | STORE, SLICE |
| 5 | `startApp` mounts the remaining features (comments, video, rows, history, broll, save, prompter, writer, clipboard, focus, composition) | `src/bootstrap/app.ts` | SLICE |
| 6 | `startup.finish()` runs synchronously, before the document is adopted: history-migration storage listener, `beforeunload` guard, service-worker registration on window load (browser only), and on desktop `startDesktopShell` then `initDesktop` (swaps blobs to the desktop backend and installs the IPC handlers, including `splitpage:open-file`) | `src/bootstrap/startup.ts`; `src/bootstrap/startup/page-lifetime.ts`; `src/features/desktop/desktop.ts` | STORE, T19 |
| 7 | Microtasks after `startApp` returns. First the one queued in step 3: on desktop `takeDesktopDraft` calls the IPC taker (the draft read starts here, after `startup.finish()`). Then the adoption of the step-4 state, `adopt`: `applyStash` (sessionStorage conflict stash); `documentTransitions().open` with `BOOT_OPEN_REASON`; `firstDraw` (`renderFirstDraw`: first editable paint); refresh chrome; report recovery or `toastLastEditor` | `src/bootstrap/startup/desktop-draft.ts` `takeDesktopDraft`; `src/bootstrap/startup/initial-document.ts` | STORE, T02 |
| 8 | Same microtask, only when the loaded document was never written out, no recovery report exists and the page is not desktop: `resumeLastProject` (async IndexedDB read; can replace the document after the first paint) | `src/application/transitions/local-files.ts` `tryResumeLastProject`, `adoptProjectState` | STORE |
| 9 | Same microtask, right after `adopt`: `setUpIdentityAndHistory`: `syncIdentity`; desktop `notifyDesktop` or browser `initDocIdentityChannel`; `startHistoryMigration` | `src/bootstrap/startup/initial-document.ts` | STORE, T24 |
| 10 | Desktop only, after open resolves: `draft.resume` then `applyTakenDraft` can replace the document | `src/bootstrap/startup/desktop-draft.ts`; `src/bootstrap/wiring/drafts.ts` | STORE |

Where a replica must finish: before step 7's `documentTransitions().open` adopts the loaded state, and so before `firstDraw`. The contract already allows it: `InitialDocumentPorts.load(pristine)` returns `PromiseLike<Loaded>`, and step 6 shows the desktop handlers are live before adoption, so a replica load also has to tolerate an early `splitpage:open-file`. Steps 8 and 10, and `splitpage:open-file`, can each replace the document after step 7, so a replica must also order against them (a shared tab should not be replaced by any of them). Serves: STORE, SLICE.

## 4. Inbound update sources

Everything that can change the live document or its stores without the user typing in the focused editor. "Repaints editable" means it can rewrite an element the user may be typing in. Whole-document replacements all go through a full render (`ABSORBED = adopt, disk, recovery, reload`; `replay` runs `whileApplying(render)`).

| Source | Env | What it changes | Repaints editable? | Location | Serves |
| --- | --- | --- | --- | --- | --- |
| `storage` event, key `splitpage-snapshots` | Browser, desktop | Starts history migration only | No | `src/bootstrap/startup/page-lifetime.ts` `watchHistoryMigration` | S2 |
| `storage` event, preference keys | Browser, desktop (all tabs share localStorage) | Preference cache; `SHOWN_PREFERENCES = {clock, commentAuthor, personColor}` trigger a full `render()` of rows | **Yes**: full row render rewrites the focused beat | `src/bootstrap/wiring/preference-watch.ts` then `notePreferenceChange`; `src/features/rows/render.ts` `screenListeners().preference`, `SHOWN_PREFERENCES` | T02, T04 |
| Same preference event, other consumers | Same | Panels and dialogs: comments, broll, prompter, overlay, tags, rundown, settings; script zoom keeps the caret in view (layout only) | No | `src/bootstrap/wiring/ports/preferences.ts` `changes.onChange` | S2 |
| `BroadcastChannel` `splitpage-doc-ids` | Browser only (desktop returns null) | `reassignDocId` stamp. `docId` is not in `SHOWN_DOC_FIELDS`, so no row repaint is expected. Claims exist only for `file:` homes | No | `src/application/identity/document-identity.ts` `onDocIdentityMessage`; `src/bootstrap/wiring/ports/document-identity.ts` | S2 |
| Desktop `splitpage:reassign-doc-id` | Desktop | Same stamp, when `doc-claims` finds a duplicate docId | No | `desktop/doc-claims.ts` `askToReassign`; `src/features/desktop/desktop.ts` | S2 |
| Shared IndexedDB data, file watching, service-worker messages | | None. No cross-tab notification of IDB data changes (only `versionchange`, below), no `fs.watch` or `FileSystemObserver` (disk conflicts are found only at save by `checkFileConflict`, or by explicit reload and merge). The worker has no message listener and the page no `controllerchange` handler | n/a | `src/application/save/`; `sw.js` | T19 |
| Session effect scheduler (idle 180 ms, max 1000 ms) | Both | `paintRowTimes` and production refresh | No (no narration repaint) | `src/application/session/effects.ts` | T02 |
| Shot-hiding grace timer | Both | Calls `onHiding`, which does a full `render()` | **Yes** | `src/application/shot-hiding.ts` `armGrace`, `SHOT_HIDE_GRACE_MS` | T02, T04 |
| Autosave idle and max timers | Both | Writes the file; no paint | No | `src/application/save/autosave.ts` | STORE |
| History capture schedule | Both | Writes a snapshot to the history store | No | `src/application/recovery/history.ts` | STORE |
| Draft debounce, `splitpage:draft-flush` | Desktop | Reads and writes the draft | No | `src/bootstrap/wiring/drafts.ts`; `desktop/drafts.ts` | STORE |
| Update-status poll (1.5 s, 20 times) | Browser, desktop | Banner | No | `src/features/update/update.ts` | S2 |
| UI confirm timers (scene boundary 2 s, production selection, draft edit) | Both | Affordance state | S2 | `src/features/` (rows, production) | S2 |
| `visibilitychange` (hidden), `pagehide`, window `blur`; `beforeunload` guard | Both | Flush save and draft; no paint | No | `src/bootstrap/wiring/drafts.ts`; `src/bootstrap/wiring/file-saving.ts` | T19, STORE |
| Cell blur (`focusout` on a script cell) | Both | `blurredCell`: re-sanitizes the cell's `innerHTML` and rewrites it when it differs from the stored form; `cellEditing().sync(cell)` writes the cell's text into the document (a session edit); `anchorBrollInLeftCell` anchors b-roll (skipped while undo applies). Suppressed during undo or a screen paint (`blurSuppressed`) | **Yes** (rewrites the blurred cell; the sync edit can trigger the repaint paths above) | `src/bootstrap/wiring/editor.ts` `editorFocusPorts.blurredCell`; `src/features/editing/focus.ts` | T02, T04, T21 |
| Writer host blur | Both | `onHostBlur` (when focus moves to a real element and no IME composition is active): ends the current beat, `leavePendingHeading(true)` and `leaveEmptyHeadings(true)` finalize or remove empty scene headings through `apply("remove-empty-heading")`, clears beat selection | **Yes** (document edit that removes a heading) | `src/features/writer/flow-surface.ts` `onHostBlur`, `removeEmptyHeading` | T08, T04 |
| Scene-name input blur and window blur | Both | `nameAt` `settle(false)` saves the scene name (`renameSceneCommand` or `addSceneCommand`) when the input loses focus to another element, on `pointercancel` and on window `blur`; a session edit | Yes (scene headers are `SHOWN_DOC_FIELDS: sections`, so a full render) | `src/features/rows/scene-controls.ts` `nameAt`, `rename` | T08 |
| Beat-length input blur | Both | `onEditorBlur` calls `closeReadTimeEditor(true, true)`: commits the typed length via `setBeatLength` (after the current paint, `afterThisPaint`) or `applyBeatLength` | Row repaint (`renderRow`) of that beat, not a full render (`lengthSeconds` is in `ONE_ROW`) | `src/features/rows/read-time.ts` `onEditorBlur`, `closeReadTimeEditor` | T02 |
| `resumeLastProject` | Browser | Whole document, after first paint | **Yes** | `src/application/transitions/local-files.ts` | STORE |
| `splitpage:open-file` | Desktop | Whole document, from the OS or another window | **Yes** | `src/features/desktop/desktop.ts` `initDesktop` | T24 |
| Prompter launch fetch | Browser opened from a desktop share link | After startup, fetches `prompter-script/<token>`, parses it and opens it as the document (`ports.opening.open`, silent, no snapshot) | **Yes** (whole document) | `src/features/prompter/prompter.ts` `launchPrompterFromScript`, `startPrompterLaunch` | T24, S2 |
| Prompter voice relay | Browser opened from a desktop share link | Loopback `EventSource` pushes recognition results and errors into prompter state | No (prompter view only, no document text) | `src/adapters/desktop/voice-relay.ts` `createRelayRecognition` | S2 |
| Delayed media paste | Both | `insert` reads files asynchronously (`readMedia`), then calls `insertNow` into the cell it captured (re-found by row id and field if the element is gone; restores the caret with `restorePlace`) | **Yes** (inserts into a script cell, possibly the focused one) | `src/features/clipboard/routes.ts` `insert` | T02, T16 |
| Delayed picture add | Both | `addPicture` compresses the file, interns the picture, then `editGallery` adds or replaces a slot; refused when the script changed (`stillOwns`) | Yes (gallery edit is a non-`ONE_ROW` cell change, so `paintsWhole` gives a full render) | `src/features/rows/beat-media.ts` `addPicture` | T16 |
| Video thumbnail callbacks | Both | `thumbnailsAfterPaste` folds a fetched thumbnail into the paste's undo entry (`undo.fold`); `thumbnailsOnBeatClick` calls `editGallery` then `viewer.refresh()` | Paste variant: `undo.fold` (`foldIntoEdit`) emits an `amend` change, which `paintsWhole` excludes, so touched rows get `renderRow`. Click variant: full render through `editGallery` | `src/features/gallery/video.ts` | T16, T21 |
| Annotator save | Both | `done` flattens the marks asynchronously, then `save` runs `editGallery` to replace the slot's picture | Yes (same gallery path) | `src/features/gallery/annotate.ts` `done`, `save` | T16 |
| Video bundle copy and relink | Desktop | After a copy or move finishes, `copied` calls `relink` (`undo.fold` or `editGallery` on one beat) or `relinkPath` (`editGallery` on every beat) and refreshes the viewer | `relink` with a folded undo entry: `amend`, so `renderRow` of that beat; `relink` without one and `relinkPath` (every beat): full render through `editGallery` | `src/features/gallery/video-bundles.ts` `copied`, `relink`, `relinkPath`, `onCarry` | T16, S2 |
| Save completion | Both | `confirmWrite` after a write lands: stamps rev and last editor on the document, amends the file home, adopts a copy's docId, amends rows with relinked video paths (`history.amendRows`), and applies a title edit (`fileTitleCommand`) when the save renamed the file | Yes when the title or a row changes (`title` is in `SHOWN_DOC_FIELDS`, so a full render) | `src/application/save/save-completion.ts` `confirmWrite` | T13, T22, T02 |
| App-data import | Both | `importAppData` awaits `history.importBundle` (snapshots and images into the history and blob stores), then `appDataMergePrefs` writes absent preferences. Only `commentsSort` and `panelGrouping` notify; other imported keys write without a change event | No document change. `commentsSort` re-renders the comments panel if it is open (`startComments`); `panelGrouping` re-renders the b-roll panel (`startBrollPanel` → `renderBrollViews`) and the tag panels (`startTagPanels` → `syncGrouping`, `renderProduction`) | `src/features/settings/app-data.ts` `importAppData`; `src/application/preferences/preferences.ts` `appDataImport`; `src/features/comments/comments.ts`; `src/features/broll/panel.ts`; `src/features/tags/panels.ts` | STORE |
| IndexedDB `versionchange`, `close`, `onblocked` | Browser | History and blob databases close themselves on `versionchange` and on `close`, and forget the handle; the next access reopens. An upgrade blocked by another tab fails the open (`idb-blocked`; history: "the upgrade is blocked by another tab") | No | `src/adapters/storage/03c-history-idb.ts` `adopt`, `openDb`; `src/adapters/storage/blob-store.ts` `openDb` | STORE, T17 |
| Deferred blob writes | Both | `queuePersist` batches new shas and writes them to the blob backend on the next turn (`host.later`); `adopt` registers decoded images | No | `src/adapters/storage/blob-store.ts` `queuePersist`, `adopt` | STORE, T16 |
| `applyTakenDraft`; `applyStashedWork` | Desktop; both | Whole document from a draft or the conflict stash | **Yes** | `src/bootstrap/wiring/drafts.ts` `applyTakenDraft`; `src/bootstrap/wiring/recovery-owners.ts` `applyStashedWork` | STORE |
| User open, import, merge, history restore | Both | Whole document | **Yes** | `src/application/transitions/` | S2 |
| Undo and redo `replay` | Both | Document through `whileApplying(render)` | **Yes** | `src/application/editing/undo/undo.ts` | T12, T21 |
| `menu-command` | Desktop | Runs the user action path | As the action does | `desktop/` menu to the actions registry | S2 |
| `restore-notice`, `update-status` | Desktop | Toast; banner | No | `src/features/desktop/desktop.ts` | S2 |
| `voice-event` | Desktop | Prompter recognition only | No | `src/adapters/desktop/desktop-voice.ts` | S2 |
| `bundle-progress`, `bundle-carry` | Desktop | Video bundle progress and payload | No | `src/features/gallery/video-bundles.ts` `onCarry` | S2 |

Existing paint-deferral hook (feeds T02): `src/features/rows/render.ts` `paintSessionChange` skips rows touched only in `ON_SCREEN_ALREADY = {visualText, audioText, updatedAt, updatedBy, paragraphStart}` only while `ports.editing.paint().shown()` is true. That flag is set by `src/application/editing/paint-guard.ts` `whileShown`, a synchronous guard that local edit paths wrap around an edit whose result is already on screen (editor `shown`, writer, clipboard cut and paste, broll records). Rows touched in other fields are repainted after the guard ends (`afterShown`). Any change that arrives outside such a guard takes the normal branches: `paintsWhole` gives a full `render()` for any non-`ONE_ROW` cell change that is not an `amend` (and for `replay`, inserted, removed or moved rows, and `SHOWN_DOC_FIELDS = {title, titleVersion, wordsPerMinute, comments, sections}`), otherwise `renderRow` per touched row. The `stamped` listener also does a full render for comment or text-field changes. So today nothing skips a remote text change to a focused beat; whether the repaint keeps caret and composition is open question 2. Serves: T02, T04, SLICE.

Everything above that can repaint an editable element, in one list (for T01, T02, T04, T19): preference events for clock, comment author and person color; the shot-hiding timer; every whole-document replacement; undo and redo replay; cell blur re-sanitizing; writer heading removal; scene-name save; beat-length commit (row only); delayed media paste; delayed gallery edits (picture add, thumbnail on click, annotator save, bundle `relinkPath`: full render; paste thumbnails and a folded `relink`: row repaint); save completion when it changes the title or rows; a remote text change once one exists.

## 5. App-data export and import

An allow-list, not "everything". Format `splitpage-app-data` v1, 512 MB text cap. Location: `src/features/settings/app-data.ts`; `src/application/preferences/preferences.ts` `appDataExport`, `appDataImport`.

| Included | How | Serves |
| --- | --- | --- |
| `snapshots` | localStorage `splitpage-snapshots` via `LEGACY_SNAPSHOTS_KEY` | STORE |
| `history` | `{docs[{docId, title, lastOpenedAt, snapshots}], older, truncated, omittedSnapshots}` | STORE |
| `blobs` | Only images referenced by exported snapshots (`historyExportAttachBlobs`, capped), plus `missingBlobs`. Import: 16 MB each | STORE |
| `prefs` | `ownAppData`: tourDone, commentAuthor, writerSize, taggingHelpDismissed, autosave, commentsSort, panelGrouping, onboarding. `settingsAppData`: theme, clock, personColor, defaultWpm, hideShot, prompterMirror, prompterFlip, prompterSceneMode, rundownMin, videoThumbs, tagIcons, scriptScale. Import is put-if-absent with a `valid()` check per key | STORE |

| Excluded (by omission) | Serves |
| --- | --- |
| `splitpage-files`, recent commands, last export, import scans, broll view, panel widths, microphone, desktop-notice dismissal, export directions | S2 |
| sessionStorage, Cache Storage, the desktop drafts, `desktop-state.json` (including recents), `theme.json` and `updates/`, images no snapshot references | STORE |

On desktop the history and the referenced images do go into the bundle, read through the history backend (`src/adapters/storage/history-backends.ts` `desktopHistoryBackend`, `rawDocIds`, `get`) and the desktop blob backend (`src/adapters/desktop/desktop-blobs.ts` `makeDesktopBlobBackend`); only the stores not listed above are left out.

Nothing enumerates "all databases or all keys", so a new replica store is excluded unless someone adds it to the list. A credential store is already barred by invariant INV-48 (`docs/architecture/invariants.md`) and plan section 14. The name guard (section 2) is the only code check, and it looks at key names only. Shared documents would acquire history snapshots through the normal capture path (open question 6). Serves: STORE.

## 6. Restart assumptions

| Assumption | Browser | Desktop | Location | Serves |
| --- | --- | --- | --- | --- |
| Unsaved edits survive | No draft store: `draftTaker` returns null off desktop. Only the `beforeunload` guard and optional autosave to a file handle | Drafts per tab, with a base file and `baseLastModified` and `baseSize` checks; `session.json` detects a crash | `src/bootstrap/startup/desktop-draft.ts`; `desktop/drafts.ts` | STORE |
| Tab restoration | None. One tab is one page load | Windows and tabs come from `desktop-state.json`. A file tab reopens only if the file exists at its path (else a "missing" restore notice). Tabs with a draft get `restore-draft` and `draftStore.hold`. Orphan drafts are placed by `placement.windowKey` | `desktop/session-restore.ts` `createSessionRestore` | STORE, T24 |
| Recents | Not offered; only the single `last` handle. Resume needs permission `granted`, else a banner on `prompt` | `desktop-state.json` list, max 20 | `src/adapters/files/last-file.ts`; `desktop/desktop-state.ts` | S2 |
| History and picture bytes survive | IndexedDB. `navigator.storage.persist()` is requested once after the history database opens, only on Chromium (`userAgentData` present); `estimate()` sets the cap. No eviction guard elsewhere | Files under `userData` | `history-backends.ts` `historyOpenIdb` | STORE |
| Files stay where they were | Handle permission may lapse | Absolute paths | | STORE |
| Tab source kinds | n/a | Only `file` and `blank` (see section 7 desktop) | `desktop/desktop-state.ts` `normalizeTabSource` | T24, STORE |

## 7. Environment

### 7.1 Content-Security-Policy as built

Exact string (`build.mjs` `CSP_DIRECTIVES`, `buildCsp`; the hash is of the one inline `app-logic` script):

```
default-src 'self'; script-src 'self' 'sha256-<hash>'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https: http:; object-src 'none'; frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com; worker-src 'self'; base-uri 'self'; form-action 'none'
```

| Fact | Where | Serves |
| --- | --- | --- |
| Set as `<meta http-equiv="Content-Security-Policy" content="{{CSP}}">`, filled by `build()` | `src/page.html`; `build.mjs` | STORE, T19 |
| Desktop reads the meta with a regex (`readAppCsp`) and serves it as an HTTP header, plus `; frame-ancestors 'none'`, on each successful static app response under `splitpage://app/`. `registerProtocol` returns `/update-status.json` and every 404 or read error without the header. The same string goes to the prompter-share server | `desktop/main.ts` `readAppCsp`, `registerProtocol` | STORE |
| `server/server.ts` adds only `Content-Security-Policy: frame-ancestors 'self'` on `.html` | `server/server.ts` | S2 |
| `connect-src` lists no `ws:` or `wss:`; `blob:` is not in `connect-src` (it is in `img-src` and `media-src`). On desktop `'self'` means the `splitpage://app` scheme | `build.mjs` | T19, T16 |
| Whether `https:` and `http:` match `wss:` and `ws:` is browser behaviour; the plan states Chromium blocks a `wss://` to another host. I verified only that no WebSocket scheme is listed. See open question 1 | | T19 |
| No `'unsafe-eval'`, no `'wasm-unsafe-eval'`, no blob workers (`worker-src 'self'`); remote https images are blocked while blob: works | `build.mjs` | SLICE |
| Separate policies: `TABSTRIP_CSP` (`connect-src 'none'`) and `PRINT_CSP` | `desktop/` | S2 |

What adding `wss:` touches:

| Touched | Why | Serves |
| --- | --- | --- |
| `build.mjs` `CSP_DIRECTIVES` (one string) | The only definition; the desktop header derives from the built `index.html` | T19 |
| Script hash rule | Unaffected: the hash covers the script, not the policy | SLICE |
| Standalone HTML export | Copies the exporting page's CSP meta and hash into every exported file, so every export carries the change | T13 |
| Tests that pin the policy | `.claude/skills/run-splitpage-app/tests/52-csp.txt` (directive checks; meta is the second `<meta>`; `'unsafe-inline'` exactly twice when split; no `unsafe-eval`; `img-src` and `frame-src` regexes); `160-gallery-video.txt` (frame-src, img-src); `src/test/video-embed.test.mjs` (regexes over `build.mjs` text for `frame-src` and `img-src`); `tools/test-strict-bundle.mjs` (hash present, exactly two scripts); `tools/test-server.mjs` (frame-ancestors header). None pins `connect-src` | STORE |

### 7.2 Service worker

| Fact | Location | Serves |
| --- | --- | --- |
| Cache name `splitpage-<VERSION>`, stamped by `buildSw`. Precache (`cache.addAll` on install): `./`, `./index.html`, `./manifest.webmanifest`, `./icon.svg`, `./icon-maskable.svg`. `skipWaiting` on install; `clients.claim` and deletion of other caches on activate | `sw.js`; `build.mjs` `buildSw` | STORE |
| Only same-origin GET is handled. Paths matching `(^\|/)api/` and `update-status.json` are left to the network | `sw.js` fetch handler | T18, S2 |
| Navigations, `index.html` and `./`: network first. The response is cached only when `url.search === ""`. On failure: `caches.match(origin + pathname)`, then `caches.match(INDEX_URL)` | `sw.js` | STORE |
| Other same-origin GETs without a query: cache first, refreshed in the background. Any non-navigation URL with a query is left to the browser | `sw.js` | STORE |
| Offline cold start: works for the shell (precached, and a `?join=` navigation falls back to the cached `/` because the lookup drops the query). The page itself needs no network to boot: the document is embedded and the stores it reads at startup are local (section 3) | `sw.js` | STORE |
| A new worker takes over a running page immediately (`skipWaiting`, `claim`); the page does not listen for the change | `sw.js`; `page-lifetime.ts` | T19 |
| Registered with the relative `"sw.js"` on window load; skipped on desktop and on `file:`. Manifest `start_url "./index.html"`, `scope "./"` | `src/bootstrap/startup/page-lifetime.ts` `registerServiceWorker`; `manifest.webmanifest` | S2 |

### 7.3 Join-link delivery (`https://<host>/?join=<instance-id>#<token>`)

| Fact | Location | Serves |
| --- | --- | --- |
| Plan reason 1 holds: `sw.js` registration, the manifest, `update-status.json` and `prompter-script/` fetches are relative. A path route `/join/<id>` would resolve them under `/join/`, and `server/server.ts` has no SPA fallback (unknown path gives 404) | `registerServiceWorker`; `manifest.webmanifest`; `server/server.ts` | S2 |
| Plan reason 2 holds: the worker leaves `/api/` alone | `sw.js` | S2 |
| Plan reason 3 holds: `desktop/prompter-share.ts` already puts a token in a fragment (`#script=<token>&voice=...`) | `desktop/prompter-share.ts` | T18 |
| Hosting in this repo: `server/server.ts` is a static server (GET and HEAD, `/` to `/index.html`, dotfiles, a leading `data` segment and `:` give 404, no `/api/` routes). `Cache-Control: no-cache` for html and `/sw.js`, else `public, max-age=3600`. It reads `url.pathname`, so a query is ignored. `start.mjs` runs it on `127.0.0.1`, port 8791 and up. No Dockerfile or hosting config is in the repo; releases are a portable zip (`tools/package.mjs`, explicit file list) and desktop installers (`desktop/stage.mjs`, explicit list) | `server/server.ts`; `start.mjs` | S2 |
| So `/?join=x#tok` is answered with `index.html`, today by any static host | `server/server.ts` | S2 |
| Boot with that URL: nothing reads `join`. Query readers today: `document-guard` (via `documentGuardAsked` in `wiring.ts`), `freeze-caches` (`bootstrap/cache-freeze.ts`, at module load) and `teleprompter`; each looks for its own parameter | `src/bootstrap/wiring.ts`; `src/bootstrap/cache-freeze.ts`; `src/features/prompter/prompter.ts` | T18 |
| Fragment: only the prompter reads it (`script=<64 hex>`, `voice=<port>-<64 hex>`), in `readPrompterLaunch` at prompter mount, which strips with `history.replaceState`. An unrelated `#<token>` is ignored and stays in `location.href`, the history entry and the address bar until code removes it | `src/features/prompter/prompter.ts` | T18 |
| Other `location` reads: `location.protocol` (service worker, video), `location.href` (prompter `new URL`), `location.reload` (failure screen). No router, no `popstate` | `src/bootstrap/startup/page-lifetime.ts`; `src/features/gallery/video.ts`; `src/bootstrap/startup/failure-screen.ts` | T18 |
| Logging: no `console` call prints the URL; the failure screen's "Copy details" copies name, message and stack only; no analytics, beacon or socket exists; `server/server.ts` logs `url.pathname` on 500s only. Referrer: no policy set on the page; a fragment is never sent in `Referer` | `src/bootstrap/startup/failure-screen.ts`; `server/server.ts` | T18 |
| Service worker with the join URL: the fragment never reaches it. The query makes the navigation uncacheable, so the join page is always fetched from the network when online | `sw.js` | T18 |
| Desktop: tabs load `splitpage://app/index.html?tab=<tabId>`. The static allow-list (`/index.html`, `/manifest.webmanifest`, `/icon.svg`, `/icon-maskable.svg`, `/sw.js`, `/help.md`, `/VERSION`) matches on `url.pathname`, other paths give 404. Desktop entry is Paste Invite Link (plan section 9), which no code implements yet | `desktop/main.ts` `registerProtocol`, `STATIC_ALLOWLIST`, `createTab` | T24 |

### 7.4 Desktop tab source and ownership (one-tab rule)

| Fact | Location | Serves |
| --- | --- | --- |
| Tab source has two kinds, `file` and `blank`. `normalizeTabSource` turns every other value into `{kind: "blank"}`. Draft header origin kinds are `untitled`, `file`, `import` (`DRAFT_ORIGIN_KINDS`), so an unknown "shared" source would be dropped by both | `desktop/desktop-state.ts` `normalizeTabSource`; `desktop/drafts.ts` | T24 |
| Ownership map: `pathToTabId` keyed by `pathKey(absPath)`. `claimRoutingKey` is first-claim-wins while the owner tab is alive; `indexTabSource` runs from `createTab` and `routeOpenPath`; `unindexTabSource` on close | `desktop/tab-registry.ts` `createTabRegistry` | T24 |
| Uses: `routeOpenPath` activates the existing tab ("other-tab"); the save-dialog collision warning; draft restore (`indexDraftPath`) | `desktop/main.ts`; `desktop/ipc-files.ts` | T24 |
| Duplicate docIds are renamed, not refused: `createDocClaims` keys claims by webContents id with `homeKeyOf = homeKeyForClaim` (`"file:" + pathKey(absPath)`, or null for no file); the loser receives `splitpage:reassign-doc-id` | `desktop/doc-claims.ts`; `desktop/main.ts` `homeKeyForClaim` | T24 |
| Untitled tabs have no key, so nothing stops two tabs holding the same untitled document | `desktop/tab-registry.ts` | T24 |
| Web Locks: none. No `navigator.locks`, `SharedWorker` or `Worker` anywhere. The only cross-tab primitive in the browser is the `splitpage-doc-ids` `BroadcastChannel` | whole tree | T24 |

### 7.5 Desktop main-process stores and IPC a replica would sit beside

Channel table: `desktop/ipc-channels.ts` (direction: invoke, send, sendSync, receive; allowed origins app, strip or both). Registered in groups by `desktop/ipc-setup.ts` `registerIpc`: file, shell, document, historyBlob, tabStrip, testMode, print. `ipc-contract.test.mjs` and `ipc-table.test.mjs` pin the table. A new channel needs: a table entry with its schema, `shared/desktop-contract.d.ts`, `desktop/preload.ts`, `DesktopPort` in `src/adapters/desktop/desktop-port.ts` and `fake-desktop.ts`.

| Group | Channels | Store behind it | Limits | Serves |
| --- | --- | --- | --- | --- |
| Drafts | `draft-write`, `draft-discard`, `draft-take`, `draft-restore-done`, `draft-flushed`; receive `draft-flush` | `desktop/drafts.ts` | `MAX_BODY_BYTES` 256 MB | STORE |
| History | `history-put`, `history-list`, `history-get`, `history-copy`, `history-touch`, `history-list-docs` | `desktop/history-fs-backend.ts` | caps in `createHistoryStore` | STORE |
| Blobs | `blob-put`, `blob-get`, `blob-missing` | `desktop/blob-store.ts` | 2000 shas per `blob-missing`; image 16 MB; `MAX_BLOB_BYTES` 256 MB | STORE, T16 |
| State, recents, tabs | `recents-list`, `recents-remove`, `recents-clear`, `get-session-info`, `tab-boot-sync`, `set-document-state`, `renderer-ready`, `route-open` | `desktop/desktop-state.ts` | recents 20 | STORE, T24 |
| Receive only | `open-file`, `menu-command`, `restore-notice`, `update-status`, `reassign-doc-id`, `draft-flush`, `voice-event`, `bundle-progress`, `bundle-carry` | n/a | n/a | S2 |

Drafts and `desktop-state.json` write through `writeFileDurableSync` (tmp, fsync, rename), and the history and blob backends use their own tmp, fsync and rename paths. `theme.json` is the exception: a plain `fs.writeFileSync` (`desktop/window-appearance.ts` `createThemeChoice.write`). Renderer context: `contextIsolation`, `sandbox`, no `nodeIntegration`. Tabs are `WebContentsView`s sharing one session.

## 8. Bundle size (plan item 8 and section 3)

Measured in a scratch directory with the repo's esbuild (iife, minify, browser platform). Gzip is level 9. Packages: `yjs` 13.6.33 and `@hocuspocus/provider` 4.8.0 (dependencies `@hocuspocus/common`, `@lifeomic/attempt`, `lib0`; peers `yjs`, `y-protocols`). Client usage probed: `Doc`, `UndoManager`, encode and apply update, relative positions, text, map and array types, `new HocuspocusProvider`.

| Measure | Bytes | gzip | brotli |
| --- | --- | --- | --- |
| Today's `index.html` | 1,851,547 | 537,215 | 433,000 |
| Today's app script (inline) | 1,366,624 | 445,219 | 361,632 |
| Standalone export, empty document (JSDOM `outerHTML` approximation) | 1,852,207 | 536,828 | 433,018 |
| Standalone export, seed document | 1,853,282 | 537,325 | 433,169 |
| `yjs` alone | 84,799 | 25,939 | 23,319 |
| `yjs` plus provider alone | 113,873 | 33,087 | 29,656 |
| App bundled with both (delta over the app script) | +115,589 | +33,176 | +29,296 |

The delta is about +8.5% of the app script and about +6.2% of `index.html` (1,851,547 to about 1,967,000). With `import *` instead of the named imports, the packages alone are 122,452 bytes (gzip 35,952).

| Option | What it touches | Serves |
| --- | --- | --- |
| A. Ship in every build and every export | `build.mjs` esbuild entry and dependencies; first runtime dependencies in `package.json`; the dependency gate (`docs/architecture/dependencies.md`, `tools/dep-report.mjs`); every Standalone export grows by about 115 KB; the service-worker cache grows by the same. The single-script hash rule is unchanged. The CSP string gains `wss:` | PERF, STORE |
| B. Second script, for shared sessions only | `build.mjs` (it fails when esbuild produces other than one file; iife cannot split, so a second entry or format); the CSP script rule (a second hash, or an external file allowed by `'self'`); `tools/test-strict-bundle.mjs` (asserts exactly two scripts); the `sw.js` `SHELL` list; `STATIC_ALLOWLIST` in `desktop/main.ts` and the staging list in `desktop/stage.mjs`; `tools/package.mjs` file list; `desktop/verify-dist-payload.mjs`; the static table in `desktop/prompter-share.ts`; `52-csp.txt`. A single-file export and `file://` cannot load it unless it is inlined. A shared session needs the file served from the collaboration host | PERF, STORE |

No decision is made here; see "Decisions for Adam".

## Open questions

| # | Question | Experiment that settles it | Serves |
| --- | --- | --- | --- |
| 1 | The plan reports a Chromium test that `wss://` to another host is blocked by `https:`. Does the same hold in Firefox and Safari, and in the desktop app at `splitpage://app` (where `'self'` is the custom scheme)? | Open a `WebSocket` to a test host from the built page in each browser and in the desktop app; read the console violation | T19 |
| 2 | Does a full `render()` or row repaint keep caret and IME state in a focused beat when it comes from a cross-tab `storage` event (clock, commentAuthor, personColor), a delayed gallery edit or a save-completion title edit? | Dispatch the synthetic event, or complete the delayed task, during a synthetic composition in the real editor | T02, T04 |
| 3 | Is persistent storage granted outside Chromium, and what is evicted under pressure? `persist()` is requested only on Chromium | Run the STORE quota experiment per browser with `persist()` called and not called | STORE |
| 4 | Does an offline cold start work per browser, including a `skipWaiting` takeover mid-session? | Install, go offline, reload, then publish a new version while a tab is open | STORE, T19 |
| 5 | Does `safeStorage.isEncryptionAvailable()` return true on the target Windows, macOS and Linux installs? | Call it in a throwaway main-process script on each | STORE |
| 6 | Would shared docIds acquire history snapshots that app-data export then includes? | Open a shared-docId document in the slice and list `historyListDocs` | STORE |
| 7 | In what order do `resumeLastProject`, `applyTakenDraft` and `open-file` run against an async hydrate? | Slice with a delayed `load`; log the open reasons | SLICE, STORE |
| 8 | Does the standalone-export size match the real export path? Numbers above use a DOM serialisation, not the running page | Export from a built page and measure the file | PERF |

## Decisions for Adam

| Decision | Numbers | Assumed meanwhile |
| --- | --- | --- |
| Bundle: ship Yjs and the provider in every build and export (A), or load a second script only for shared sessions (B) | A: +115,589 bytes minified (+33,176 gzip, +29,296 brotli), about +6.2% on `index.html`, every export. B: no cost to ordinary exports; changes the one-output build, the script hash rule and eight packaging and test files (section 8) | Decided 2026-11-09: A, ship in every build and export. Before that: Stage 1 measures with the libraries inside a scratch bundle and decides nothing about shipping. Neither option is built |
| Is the local replica part of app-data export? | Export is an allow-list; nothing new is included unless added | Excluded; users export a Standalone copy instead |

## Doc mismatches

| Doc | Says | Code |
| --- | --- | --- |
| `docs/COLLABORATION-PLAN.md` section 2 | The desktop main process already decides which tab owns a document and enforces the rule | True only for file-backed tabs keyed by absolute path (`pathToTabId`). Untitled tabs have no key; a shared tab would need a new source kind (`normalizeTabSource` drops unknown kinds) and a key. Duplicate docIds are renamed (`reassign-doc-id`), not refused |