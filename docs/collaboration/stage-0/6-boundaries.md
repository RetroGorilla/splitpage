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
| localStorage `splitpage-*` preference keys | Theme, clock, personColor, commentAuthor, defaultWpm, autosave, panel and prompter settings, recent commands, last export, panel widths, onboarding flags | Origin; shared by all desktop tabs | `src/application/preferences/preferences.ts` `KEYS` | T02, S2 |
| sessionStorage: conflict stash; `splitpage-prompter-launch`; `splitpage-prompter-voice` | Unsaved work held across a conflict reload; prompter share token; voice relay token | Per tab | `src/application/recovery/conflict-stash.ts`; `src/features/prompter/prompter.ts` `readPrompterLaunch`; `src/adapters/desktop/voice-relay.ts` | S2 |
| In-memory `PAGE_NONCE` home | Identity of a document with no file | Per page load | `src/application/identity/document-identity.ts` | S2 |
| Cache Storage `splitpage-<VERSION>` | The five shell files (section 7) | Origin; browser only (the worker is not registered on desktop or `file:`) | `sw.js` | STORE |
| Desktop `userData/drafts/` | `session.json` (running, clean-exit, session-end); per-tab folder `<tabId>/` with two generations of state, `base-<sha12>.json`, `corrupt/`. Durable tmp, fsync, rename | Per install; per tab id | `desktop/drafts.ts` `createDraftStore` | STORE |
| Desktop `userData/history/` | `index.json`, `index.prev.json`, `FORMAT`, `bodies/`, `v1-backup/`, with caps | Per install | `desktop/history-fs-backend.ts` `createHistoryFsBackend`, wrapped by `createHistoryStore` | STORE |
| Desktop `userData/blobs/sha256/` plus `FORMAT` | Picture and video bytes by sha | Per install, global | `desktop/blob-store.ts` `createBlobStore` | STORE |
| Desktop `userData/desktop-state.json` v2 | Windows, bounds, tabs `{tabId, source, lastKnownTitle}`, recents (max 20), `lastSavedFolder` | Per install | `desktop/desktop-state.ts` `createDesktopStateStore` | STORE, T24 |
| Desktop `theme.json`, `updates/`, partitions `splitpage-update-download` and a print session | Theme at startup; update downloads; print rendering | Per install | `desktop/main.ts` | S2 |

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
| Any auth token, cookie or `Authorization` header stored or sent? | No | whole tree searched; none found | STORE |
| Any WebSocket, EventSource or beacon to a remote host? | No. Remote `fetch` uses `credentials: "omit"` (video oEmbed) or `"same-origin"` (prompter script) | `shared/video-embed.ts`; `src/features/prompter/prompter.ts` | S2 |
| Leftovers of the removed server and collab code (2026-10-28) | One: a test input `{ focus: "settings-collab-server" }`. Other "collaborator" hits are test wording only | `src/features/settings/actions.test.ts` | S2 |
| Secret-like value that exists today | Teleprompter share: a 32-byte hex token and a voice token, in memory, with a time limit, in the URL `http://host:port/?teleprompter=1#script=<token>&voice=<port>-<token>` over plain HTTP; `hostAllowed` checks the Host header | `desktop/prompter-share.ts` `createPrompterShare`, `SHARE_TTL_MS` | S2 |
| How the renderer treats that fragment | `readPrompterLaunch` strips query and fragment with `history.replaceState` and keeps the tokens in sessionStorage | `src/features/prompter/prompter.ts` | T18 |
| Other in-memory grants | Video file grants; bundle export plan tokens | `desktop/ipc-shell.ts` `videoFileGrants`; `desktop/bundle-jobs.ts` | S2 |
| Share server response headers | `referrer-policy: no-referrer`, `cache-control: no-store`. `server/server.ts` and `src/page.html` set no referrer policy | `desktop/prompter-share.ts`; `server/server.ts` | T18 |
| Where desktop keeps anything secret-like | Nowhere on disk. Tokens live in memory only | `desktop/` | STORE |
| A stored capability that is not a secret | The file handle in `splitpage-files` | `src/adapters/files/last-file.ts` | S2 |
| Guard against secrets in app data | `assertNoSecrets` rejects bundle key names matching token, api key, client id, secret, password or pin, on export and import. It checks key names, not values | `src/features/settings/app-data.ts` | STORE |

## 3. Hydration entry

Read from the code; not traced at runtime. Today no store is read at boot: the document is the page's embedded `#state-data` (or the seed when `seedCheckPasses`).

| # | Step | Location | Serves |
| --- | --- | --- | --- |
| 1 | `wireLegacyApp`, then `wireApp` builds, in order: location, page effects, action registry, export services, project file services, export registry, built-in exporters, undo, session, saves, save destinations, transitions, document sources, merge, recovery, editor, production editing, preferences, shot hiding, export capture | `src/bootstrap/main.ts`; `src/bootstrap/app.ts` | SLICE |
| 2 | `mountAndStart` mounts owners and features in the fixed order pinned by `tests/bootstrap/composition-root.test.ts` | `src/bootstrap/main.ts` | SLICE |
| 3 | `startAppWhenReady`: `mountAppearanceFeature` early, `whenDocumentReady`, then `startApp` | `src/bootstrap/startup.ts` | SLICE |
| 4 | `startApp`: `startActions`; `beginStartup` (starts `takeDesktopDraft`); mounts of editing and view features | `src/bootstrap/startup.ts`; `src/bootstrap/startup/desktop-draft.ts` | SLICE |
| 5 | `openInitialDocument` calls `loadInitialState` (synchronous). The `adopt` step runs as a microtask after `startApp` returns | `src/bootstrap/startup/initial-document.ts` | STORE, SLICE |
| 6 | `adopt`: `applyStash` (sessionStorage conflict stash); `documentTransitions().open` with `BOOT_OPEN_REASON`; `firstDraw` (`renderFirstDraw`: first editable paint); refresh chrome; report recovery or `toastLastEditor` | `src/bootstrap/startup/initial-document.ts` | STORE, T02 |
| 7 | Browser only: `resumeLastProject` (async). It can replace the document after the first paint | `src/application/transitions/local-files.ts` `tryResumeLastProject`, `adoptProjectState` | STORE |
| 8 | `startup.finish()`: storage listener for history migration, `beforeunload` guard, service-worker registration on window load (browser only), `startDesktopShell` then `initDesktop` (swaps blobs to the desktop backend, installs IPC handlers) | `src/bootstrap/startup/page-lifetime.ts`; `src/features/desktop/desktop.ts` | STORE, T19 |
| 9 | `setUpIdentityAndHistory`: `syncIdentity`; desktop `notifyDesktop` or browser `initDocIdentityChannel`; `startHistoryMigration` | `src/bootstrap/startup/` | STORE, T24 |
| 10 | Desktop only, after open resolves: `draft.resume` then `applyTakenDraft` can replace the document | `src/bootstrap/startup/desktop-draft.ts` | STORE |

Where a replica must finish: before step 6's `documentTransitions().open` adopts the loaded state, and so before `firstDraw`. The contract already allows it: `InitialDocumentPorts.load(pristine)` returns `PromiseLike<Loaded>`. Steps 7 and 10, and the desktop `splitpage:open-file` handler (`initDesktop` then `documents.open`), can each replace the document after step 6, so a replica must also order against them (a shared tab should not be replaced by any of them). Serves: STORE, SLICE.

## 4. Inbound update sources

Everything that can change the live document or its stores without the user typing in the focused editor. "Repaints editable" means it can rewrite an element the user may be typing in. Whole-document replacements all go through a full render (`ABSORBED = adopt, disk, recovery, reload`; `replay` runs `whileApplying(render)`).

| Source | Env | What it changes | Repaints editable? | Location | Serves |
| --- | --- | --- | --- | --- | --- |
| `storage` event, key `splitpage-snapshots` | Browser, desktop | Starts history migration only | No | `src/bootstrap/startup/page-lifetime.ts` `watchHistoryMigration` | S2 |
| `storage` event, preference keys | Browser, desktop (all tabs share localStorage) | Preference cache; `SHOWN_PREFERENCES = {clock, commentAuthor, personColor}` trigger a full `render()` of rows | **Yes**: full row render rewrites the focused beat | `src/bootstrap/wiring/preference-watch.ts` then `notePreferenceChange`; `src/features/rows/render.ts` `screenListeners().preference`, `SHOWN_PREFERENCES` | T02, T04 |
| Same preference event, other consumers | Same | Panels and dialogs: comments, broll, prompter, overlay, tags, rundown, settings; script zoom keeps the caret in view (layout only) | No | `src/bootstrap/wiring/ports/preferences.ts` `changes.onChange` | S2 |
| `BroadcastChannel` `splitpage-doc-ids` | Browser only (desktop returns null) | `reassignDocId` stamp. `docId` is not in `SHOWN_DOC_FIELDS`, so no row repaint is expected. Claims exist only for `file:` homes | No | `src/application/identity/document-identity.ts` `onDocIdentityMessage`; `src/bootstrap/wiring/ports/document-identity.ts` | S2 |
| Desktop `splitpage:reassign-doc-id` | Desktop | Same stamp, when `doc-claims` finds a duplicate docId | No | `desktop/doc-claims.ts` `askToReassign`; `src/features/desktop/desktop.ts` | S2 |
| Shared IndexedDB, file watching, service-worker messages | | None. No cross-tab IDB notification, no `fs.watch` or `FileSystemObserver` (disk conflicts are found only at save by `checkFileConflict`, or by explicit reload and merge). The worker has no message listener and the page no `controllerchange` handler | n/a | `src/application/save/`; `sw.js` | T19 |
| Session effect scheduler (idle 180 ms, max 1000 ms) | Both | `paintRowTimes` and production refresh | No (no narration repaint) | `src/application/session/effects.ts` | T02 |
| Shot-hiding grace timer | Both | Calls `onHiding`, which does a full `render()` | **Yes** | `src/application/shot-hiding.ts` `armGrace`, `SHOT_HIDE_GRACE_MS` | T02, T04 |
| Autosave idle and max timers | Both | Writes the file; no paint | No | `src/application/save/autosave.ts` | STORE |
| History capture schedule | Both | Writes a snapshot to the history store | No | `src/application/recovery/history.ts` | STORE |
| Draft debounce, `splitpage:draft-flush` | Desktop | Reads and writes the draft | No | `src/bootstrap/wiring/drafts.ts`; `desktop/drafts.ts` | STORE |
| Update-status poll (1.5 s, 20 times) | Browser, desktop | Banner | No | `src/features/update/update.ts` | S2 |
| UI confirm timers (scene boundary 2 s, production selection, draft edit) | Both | Affordance state | S2 | `src/features/` (rows, production) | S2 |
| `blur`, `visibilitychange` (hidden), `pagehide`; `beforeunload` guard | Both | Flush save and draft; no paint | No | `src/bootstrap/wiring/drafts.ts`; `file-saving.ts` | T19, STORE |
| `resumeLastProject` | Browser | Whole document, after first paint | **Yes** | `src/application/transitions/local-files.ts` | STORE |
| `splitpage:open-file` | Desktop | Whole document, from the OS or another window | **Yes** | `src/features/desktop/desktop.ts` `initDesktop` | T24 |
| `applyTakenDraft`; `applyStashedWork` | Desktop; both | Whole document from a draft or the conflict stash | **Yes** | `src/bootstrap/startup/desktop-draft.ts`; `src/application/recovery/conflict-stash.ts` | STORE |
| User open, import, merge, history restore | Both | Whole document | **Yes** | `src/application/transitions/` | S2 |
| Undo and redo `replay` | Both | Document through `whileApplying(render)` | **Yes** | `src/application/editing/undo/undo.ts` | T12, T21 |
| `menu-command` | Desktop | Runs the user action path | As the action does | `desktop/` menu to the actions registry | S2 |
| `restore-notice`, `update-status` | Desktop | Toast; banner | No | `src/features/desktop/desktop.ts` | S2 |
| `voice-event` | Desktop | Prompter recognition only | No | `src/adapters/desktop/desktop-voice.ts` | S2 |
| `bundle-progress`, `bundle-carry` | Desktop | Video bundle progress and payload | No | `src/features/gallery/video-bundles.ts` `onCarry` | S2 |

Existing paint-deferral hook (feeds T02): `src/features/rows/render.ts` `paintSessionChange` skips rows touched only in `ON_SCREEN_ALREADY = {visualText, audioText, updatedAt, updatedBy, paragraphStart}`, because the DOM already shows local typing. A remote change to those fields in a focused beat would be skipped as well. It defers through `ports.editing.paint().shown()` and `afterShown`. `SHOWN_DOC_FIELDS = {title, titleVersion, wordsPerMinute, comments, sections}`; the `stamped` listener repaints for comment or text fields. Serves: T02, T04, SLICE.

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
| sessionStorage, Cache Storage, all desktop `userData` stores (drafts, state, recents, theme, updates), images no snapshot references | STORE |

Nothing enumerates "all databases or all keys", so a new replica store and a credential store are excluded unless someone adds them to the list. The name guard (section 2) is the only secret check. Shared documents would acquire history snapshots through the normal capture path (open question 7). Serves: STORE.

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
| Desktop reads the meta with a regex and serves it as an HTTP header, plus `; frame-ancestors 'none'`, on every `splitpage://app/*` response. The same string goes to the prompter-share server | `desktop/main.ts` `readAppCsp`, `registerProtocol` | STORE |
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
| Offline cold start: works for the shell (precached, and a `?join=` navigation falls back to the cached `/` because the lookup drops the query). The page then needs no network to boot, since no store is read at boot | `sw.js` | STORE |
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
| Desktop: tabs load `splitpage://app/index.html?tab=<tabId>`. The static allow-list (`/index.html`, `/manifest.webmanifest`, `/icon.svg`, `/icon-maskable.svg`, `/sw.js`, `/help.md`, `/VERSION`) matches on `url.pathname`, other paths give 404. How a desktop user would enter an invitation is not in today's code (open question 5) | `desktop/main.ts` `registerProtocol`, `STATIC_ALLOWLIST`, `createTab` | T24 |

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

Writes everywhere use durable tmp, fsync, rename (`writeFileDurableSync`, `durableWriteSync`). Renderer context: `contextIsolation`, `sandbox`, no `nodeIntegration`. Tabs are `WebContentsView`s sharing one session.

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
| 1 | Do `https:` and `http:` in `connect-src` allow `wss:` and `ws:` in Chromium, Firefox and Safari, and on desktop `splitpage://app` where `'self'` is the custom scheme? | Open a `WebSocket` to a test host from the built page in each browser and in the desktop app; read the console violation | T19 |
| 2 | Does a full `render()` from a cross-tab `storage` event (clock, commentAuthor, personColor) keep caret and IME state in a focused beat? | Dispatch a synthetic `storage` event during a synthetic composition in the real editor | T02, T04 |
| 3 | Is persistent storage granted outside Chromium, and what is evicted under pressure? `persist()` is requested only on Chromium | Run the STORE quota experiment per browser with `persist()` called and not called | STORE |
| 4 | Does an offline cold start work per browser, including a `skipWaiting` takeover mid-session? | Install, go offline, reload, then publish a new version while a tab is open | STORE, T19 |
| 5 | How does a desktop user enter an invitation (no URL handler exists today)? | Not a code question; Stage 2 design, noted so the one-tab rule and `normalizeTabSource` are scoped | T24 |
| 6 | Does `safeStorage.isEncryptionAvailable()` return true on the target Windows, macOS and Linux installs? | Call it in a throwaway main-process script on each | STORE |
| 7 | Would shared docIds acquire history snapshots that app-data export then includes? | Open a shared-docId document in the slice and list `historyListDocs` | STORE |
| 8 | In what order do `resumeLastProject`, `applyTakenDraft` and `open-file` run against an async hydrate? | Slice with a delayed `load`; log the open reasons | SLICE, STORE |
| 9 | Does the standalone-export size match the real export path? Numbers above use a DOM serialisation, not the running page | Export from a built page and measure the file | PERF |

## Decisions for Adam

| Decision | Numbers | Assumed meanwhile |
| --- | --- | --- |
| Bundle: ship Yjs and the provider in every build and export (A), or load a second script only for shared sessions (B) | A: +115,589 bytes minified (+33,176 gzip, +29,296 brotli), about +6.2% on `index.html`, every export. B: no cost to ordinary exports; changes the one-output build, the script hash rule and eight packaging and test files (section 8) | Stage 1 measures with the libraries inside a scratch bundle and decides nothing about shipping. Neither option is built |
| Are replica and credential stores part of app-data export? | Export is an allow-list; nothing new is included unless added | Excluded; users export a Standalone copy instead |

## Doc mismatches

| Doc | Says | Code |
| --- | --- | --- |
| `docs/COLLABORATION-PLAN.md` section 2 | The desktop main process already decides which tab owns a document and enforces the rule | True only for file-backed tabs keyed by absolute path (`pathToTabId`). Untitled tabs have no key; a shared tab would need a new source kind (`normalizeTabSource` drops unknown kinds) and a key. Duplicate docIds are renamed (`reassign-doc-id`), not refused |
| `docs/COLLABORATION-PLAN.md` section 3 | `connect-src 'self' https: http:` blocks `wss://` to another host | Not checkable from code: the string lists no WebSocket scheme, and the browser's matching rule decides (open question 1) |
