# Why the desktop packaging configuration looks the way it does

`desktop/electron-builder.yml` carries no comments
([plan](../IMPLEMENTATION-PLAN.md) section 2; `npm run check:comments` enforces
it). This page explains each of its settings whose reason is not visible in the
file, under the key that holds it. [docs/RELEASING.md §2](../RELEASING.md#2-desktop-installers-windows)
covers building the installers, and [ci.md](ci.md#githubworkflowsreleaseyml)
covers the release workflow that runs `npm run dist:win`.

The nine `ipc-*.ts` modules run directly through Electron's main-process
type stripping. They use erasable syntax and keep CommonJS `require` and
`module.exports`; `main.js` names their `.ts` extensions explicitly. Electron
44.4.5 loads these files from the checkout and from the packaged asar.
`tsconfig.desktop.json` checks them with strict TypeScript, including the
channel-specific arguments and results in `shared/desktop-contract.d.ts`.
The channel table constrains contract coverage and supplies the names and
directions accepted by the registration wrappers. The contract and
`desktop/ipc-boundaries.d.ts` contain types only and need no packaged copy.
Install both tooling packages (`npm ci` and `npm ci --prefix desktop`) before
running lint, typecheck or the full gate: the desktop check uses Electron's
own declarations. `desktop-state.ts` also runs through main-process type
stripping, checked by the existing `desktop/*.ts` include in that config.
JavaScript services injected by `main.js` remain unchecked
boundaries described by narrow interfaces in `ipc-boundaries.d.ts`.

`drafts.ts` also runs through main-process type stripping. Its real store type
replaces the handwritten draft boundary, while the shared contract keeps
complete writer metadata separate from the reader's partly validated header.
The existing `desktop/*.ts` include in `tsconfig.desktop.json` checks it.

`quit-watchdog.ts`, `tab-registry.ts`, `restore-notice.ts`, `unsaved-dialog.ts`
and `window-appearance.ts` use the same main-process type stripping and
strict desktop check. Their callers name `.ts` explicitly; the restore
notice and theme-choice IPC dependencies derive from their implementations.

Both `dist` and `dist:win:test` use `electron-builder.yml`; the latter relies
on electron-builder's default config discovery and changes the output folder
and staged app to a test build. Both therefore ship the same IPC modules.

The sandboxed renderer cannot strip TypeScript: Electron 44.4.5 reports a
syntax error when a sandbox:true preload contains a type annotation.
`desktop/preload.ts` is therefore the checked source, whose bridge object
must implement `DesktopPort`. `node tools/build-preload.mjs` strips it with
Node's stripTypeScriptTypes and writes the committed `desktop/preload.js` that the sandbox runs.
The generated script still requires only Electron. Both `npm run verify`
and CI regenerate it and require `git diff --exit-code -- desktop/preload.js`
to pass. Run the generator after editing the source, and commit both files.
The TypeScript source and its type-only imports are not packaged;
`preload.js` remains the preload path in `main.js` and the builder file list.
`tabstrip-preload.js` continues to read the same channel table over IPC.

## `files`

Everything listed here goes inside the asar.

| Entry | Why |
| --- | --- |
| `main.js`, `preload.js`, `tabstrip-preload.js`, `drafts.ts` | `main.js` requires `./drafts.ts` at load and loads both preloads by path. If one is missing from the asar, the packaged app crashes on startup. |
| `ipc-channels.ts` | The IPC channel table. `ipc-setup.ts` requires it at startup, and both preloads read it over `splitpage:ipc-table-sync`, so a packaged build without it has no bridge at all. |
| `ipc-setup.ts` | How a channel is registered (`createIpcSetup`): the `ipcHandle`, `ipcOn` and `ipcOnSync` wrappers, the sender origin and trust checks, the argument check, the refusal results and log lines, and `registerIpc`, which registers the table read, the app version and the test-mode flag itself and calls `main.js`'s handler groups in a fixed order. The handlers live in seven named group functions that each take the wrappers: `registerFileIpc` (in `ipc-files.ts`), `registerShellIpc` (in `ipc-shell.ts`), `registerDocumentIpc` (in `ipc-document.ts`), `registerHistoryBlobIpc` (in `ipc-history-blob.ts`), `registerTabStripIpc` (in `ipc-tabstrip.ts`), `registerTestModeIpc` (in `ipc-test-mode.ts`) and, last, `registerPrintIpc` (in `ipc-print.ts`). `main.js` passes in `ipcMain`, `app`, the test-mode flag and the window map. |
| `ipc-files.ts` | The file and recent-documents channels (`createFileIpc`, which returns `registerFileIpc`): the open and save dialogs, reading, writing and statting a file by its id, the recents list, and the session info the test harness reads. `main.js` builds its dependency object: `dialog`, the file id registry, the path and tab maps, `recents`, `tabOf`, `dialogParentFor`, the test dialog answers and their count, and the test-mode flag. |
| `ipc-shell.ts` | The tab boot, theme, video file, update, teleprompter browser and Follow My Voice channels (`createShellIpc`, which returns `registerShellIpc`). The work behind them stays in `main.js` or `voice-composition.js`: launch intents, the draft store, the update check, download and installer, opening the teleprompter in a browser and the voice helper (`voiceHelperInstance` from `voice-composition.js`) are passed in, and the draft store, `hadPriorSession` (from `session-restore.js`) and the update status are read through getters because they change after startup. |
| `ipc-document.ts` | The document state, renderer-ready, route-open and crash-draft channels (`createDocumentIpc`, which returns `registerDocumentIpc`): writing, discarding, taking and settling a tab's draft and answering a draft flush. It requires `./drafts.ts` (`restoreDoneAction`), `./file-service` and `./desktop-state` itself. The tab and window maps, the session write, routing, the draft header and size rules and the pending flushes stay in `main.js` and are passed in; the draft store and the previous session's state are read through getters. |
| `ipc-history-blob.ts` | The six version history channels and the three image blob channels (`createHistoryBlobIpc`, which returns `registerHistoryBlobIpc`). It requires `./file-service` (`toBuffer`) and `./blob-store` (the image rule, the MIME sniff and the sha check) itself. `main.js` passes in the history holds and their helpers, `shared/history-policy.js` and the document id rule (both found through `APP_ROOT`), and getters for the history and blob stores, which it opens after startup. |
| `ipc-tabstrip.ts` | The tab strip's channels (`createTabStripIpc`, which returns `registerTabStripIpc`): its window id and state, and new tab, activate, close, reorder, move here and tear off. Creating, activating, closing, reordering and moving tabs stay in `main.js` and are passed in, with the tab map and `tabStripWindowOf`. |
| `ipc-test-mode.ts` | The `__test` channels (`createTestModeIpc`, which returns `registerTestModeIpc`): close, close tab, quit, draft status, renderer crash, duplicate-loser choice and the test shell. It registers them only when the test-mode flag is on, as before. The tab and window functions, the test logs and getters for the draft store and the previous session's state come from `main.js`; the prompter share getter and the voice helper come from `voice-composition.js`. |
| `ipc-print.ts` | The PDF channel (`createPrintIpc`, which returns `registerPrintIpc`): `splitpage:print-to-pdf` takes one captured print page as an HTML string and answers the PDF bytes. It hands the asking tab's web contents to the printer, so the print ends if that tab closes. The renderer saves the bytes through the usual save dialog and `splitpage:write-file`; the channel takes no path. |
| `print-pdf.js` | Desktop PDF export (`createPdfPrinter`, [print-layout.md](print-layout.md#desktop-printtopdf-p3)). For each request it opens a sandboxed `WebContentsView` that no window shows, with no preload, in the in-memory `splitpage-print` partition. The page is served from memory at a one-time `splitpage://print/<random>.html` address with the print CSP as a header, and every other request is refused. Once fonts and pictures are ready it calls `printToPDF` with CSS page sizes, backgrounds, a tagged PDF and headings as bookmarks. The view is closed and the page forgotten on success, failure, a 60-second deadline, the asking tab closing and `will-quit`. |
| `prompter-share.js` | The teleprompter's loopback listener (#86). `voice-composition.js` creates it. |
| `voice-composition.js` | The one owner of Follow My Voice's lifetime in the main process (`createVoiceComposition`): it creates the voice helper and the prompter share lazily, on first use, and holds both. It chooses the listener command (the fake helper named by `SPLITPAGE_TEST_VOICE_HELPER` in test mode; otherwise, on Windows only, PowerShell running `desktop/voice/listen.ps1` in development or `resources/splitpage/voice/listen.ps1` when packaged), sends a tab's events to that tab on `splitpage:voice-event` and a `relay:<tab>` session's events to the browser copy through the share, and forgets a closed tab (`forgetTab`: the share first, then the tab and its relay). It requires `./voice-helper` and `./prompter-share` itself. `main.js` passes in whether the app is packaged, `APP_ROOT`, the test-mode flag, the tab map, the static allowlist and the CSP reader. The IPC channels stay in `ipc-shell.ts` and `ipc-test-mode.ts`, and `close-quit.js` still closes the share and stops the helper at `will-quit`, through the composition's getters. |
| `close-quit.js` | Closing a tab or a window, quitting and a Windows session end (`createCloseQuit`). It owns the flags they share: quit confirmed, quit waiting on the question, session ending, session writes frozen, the windows already cleared to close, and the update installer waiting for the quit. It asks the unsaved-changes question, waits for kept copies of gone files, settles drafts, registers each window's `close` and `session-end` handlers (`attachWindowClose`) and the app's `before-quit`, `window-all-closed` and `will-quit` handlers (`registerQuitHandlers`), and quits to run a downloaded update (`quitToInstall`). It requires `./close-keep`, `./quit-watchdog` and `./unsaved-dialog` itself. `main.js` passes in the tab and window maps, the draft store helpers and a getter for the store, the draft flush, the test dialog answers, tab activation, focus and destruction, starting the installer, and getters for the prompter share and the voice helper (from `voice-composition.js`); it reads the flags back through `isQuitConfirmed`, `isSessionEnding` and `sessionWritesAreFrozen`. |
| `session-restore.js` | Restoring the last session at launch (`createSessionRestore`): windows and tabs from `desktop-state.json`, crash drafts held and placed, launch files routed, the restore notice, and whether there was a prior session. It also registers macOS `activate`, which opens a window when none is left. `main.js` passes in the state store, window and tab creation, the routing helpers and the draft store getter, and reads back `hadPriorSession` and `isRestoringSession`, which pauses session writes while the restore runs. |
| `close-keep.js` | The close-time checks for a tab whose file is gone: a file check with a one-second limit, so an unreachable drive can't freeze a close (#497), and whether a kept copy really reached the draft folder (#496). It also runs the close check's question rounds (`runCloseCheck`, with `close-quit.js`'s tabs and helpers passed in) and decides what closing a window that is the last one at "close" settles (`lastWindowClose`, #531). |
| `quit-watchdog.ts` | The update restart's 3 s quit timer, which waits while the quit is still asking the user and starts again once they answer. |
| `blob-store.js` | The content-addressed folder where images live (#82). |
| `voice-helper.js` | Follow My Voice's listener process (#8). `voice-composition.js` creates it and gives it its command. The PowerShell script it runs (`desktop/voice/listen.ps1`) cannot be read from inside the asar, so `stage.mjs` stages it into `resources/splitpage/voice` instead. |
| `chromium-browsers.js` | Finds an installed Chromium browser for "Use Chromium Speech Recognition" (#123). |
| `history-fs-backend.js` | Version history on disk (#83): the file-system backend the shared history store runs over in the main process. It requires `./blob-store.js` itself. |
| `desktop-state.ts` | `desktop-state.json` in the user-data folder: the windows, tabs and recent documents the next launch restores. It reads, migrates (v1 to v2) and normalizes the file, and writes it through one queue with `writeFileDurableSync` from `./drafts.ts`. |
| `update-release.js` | Which release the update check offers: version order, the installer for this platform and architecture, the hosts a download may come from, and the release's published SHA-256. `main.js` does the fetching and the download. |
| `file-service.js` | The documents the renderer opens and saves: the opaque file ids that stand for paths (`createFileRegistry`), the case rule for comparing paths (`pathKey`), which launch arguments are files to open, reading a file entry, the atomic write and writing a file entry (the atomic write plus its stamp). |
| `doc-claims.js` | Which tab holds which document id from which file, so that two tabs holding the same document from different files are noticed and the later one is asked to take a new id. The id rules come from `shared/doc-id-policy.js`, which `main.js` passes in, and `main.js` still sends `splitpage:reassign-doc-id` itself, so the IPC table test sees it. |
| `recents.js` | The recent documents list (`createRecents`): noting an opened file, removing one by its file id, clearing, persisting into `desktop-state.json` and describing the list for the renderer without paths. When a note is written straight away or with the next session write stays in `main.js`. |
| `window-appearance.ts` | The stored theme choice in `<userData>/theme.json` (`createThemeChoice`), the window and title bar colours for dark and light, and whether saved window bounds still overlap a display. `main.js` passes in `nativeTheme` and `screen` values. |
| `tab-registry.ts` | The maps of open tabs and windows and the two routing indexes (web contents to tab, file path to tab), how a tab or window id is minted unique, and which tab a routed path or file belongs to (`createTabRegistry`). Creating, moving and closing tabs stay in `main.js`. |
| `restore-notice.ts` | The one notice, after a session restore, that some files could not be reopened (`createRestoreNotice`): which tab it waits for, delivering it once that tab is ready, and moving it to another tab if that one closes first. `main.js` still sends `splitpage:restore-notice` itself. |
| `unsaved-dialog.ts` | The wording and buttons of the unsaved-changes question asked before closing a tab, a window or the app, the titles it lists, and which answer each button means. Whether to ask, the test-mode answers and showing the dialog are in `close-quit.js`. |

From `ipc-channels.ts` down, `main.js` requires each of these modules at
startup, directly or through another module in this list, so each must ship
for the same reason `drafts.ts` does. A new `./module` that any of them
requires has to be added to this list: `desktop/test/ipc-table.test.mjs`
follows the requires from `main.js` and fails if one is missing.

Two things `main.js` needs at startup are deliberately left out of `files`:

- **The tab strip's three files** (`desktop/tabstrip/index.html`,
  `tabstrip.js`, `tabstrip.css`). `protocol.handle` reads them off disk, so they
  are served from `resources/splitpage/tabstrip`. `stage.mjs` stages them and
  `extraResources` ships them.
- **`shared/`** (#76). It lives at the repository root, one level above
  `desktop/`. `main.js` finds it through `APP_ROOT`, which is the repository root
  in development and `resources/splitpage` when packaged. `stage.mjs` copies it
  there with the rest, so one path expression works in both layouts. Requiring a
  plain file from outside the asar works like any other `require`. Taking
  `shared/` out of `stage.mjs` would stop the app launching, not just break one
  feature.

## `extraResources`

`.stage/splitpage` → `resources/splitpage` is the folder `stage.mjs` fills: the
built app, `server/`, `shared/`, `tabstrip/` and `voice/`. Everything that
`main.js` reaches through `APP_ROOT` comes from here, not from the asar.

## `win.target`

Both architectures, x64 and arm64, are pinned here. Without the pin,
electron-builder builds only for the architecture of the machine running it.
On the maintainer's Snapdragon machine that means ARM64 only. The old IExpress
setups fell into the same trap: 1.0.1's "x64" setup came out as an ARM64 binary
that no x64 PC could start. `npm run dist:win` also passes `--x64 --arm64`, then
runs `verify-dist.mjs`. That script reads the PE machine field of each binary
the build produced and fails the build on a mismatch (docs/RELEASING.md §2).

## `nsis`

| Setting | Why |
| --- | --- |
| `useZip: true` with `differentialPackage: false` | The app payload ships as a ZIP rather than a 7z archive. Differential packaging has to be off for that, because it forces 7z back on whatever `useZip` says: app-builder-lib's `NsisTarget.js` picks the format from `!isBuildDifferentialAware && options.useZip` (line 78 in electron-builder 26.15.3). See the 7z note below. |
| `menuCategory: Splitpage` | Puts the main Start Menu shortcut in the same `Splitpage` subfolder where `installer.nsh`'s `customInstall` macro creates the "Splitpage (shared session)" shortcut. Otherwise the main shortcut lands loose at the Start Menu root, next to a `Splitpage` folder holding only the second shortcut, which is easy to miss or take for a duplicate. |
| `include: build/installer.nsh` | The installer's own macros: removing a Splitpage 1.0 install first (`customInit`), the shared-session shortcut (`customInstall`, `customUnInstall`), and the check for a running app that never force-closes one showing an unsaved-changes question (`customCheckAppRunning`, #198). |

Why 7z is a problem: 7-Zip applies an architecture-specific BCJ filter to
executables. The differential path builds the archive non-solid (`dictSize` 1,
`solid` false), so the filter lands on each PE file separately. Whatever
unpacks the payload inside NSIS cannot decode the ARM64 variant. The 2.0.1
ARM64 setup unpacked every `.pak`, `.dat`, `.bin` and `.html` file correctly
but silently dropped all seven top-level binaries, `Splitpage.exe` among them.
It then wrote the shortcuts and the uninstaller and exited 0, so the user saw
Windows looking for a `Splitpage.exe` that was never written. The x64 setup
built on the same machine in the same minute was fine, because the x64 BCJ
filter is old and every unpacker understands it. `verify-dist.mjs` now unpacks
each installer's payload to catch this ([ci.md](ci.md#githubworkflowsreleaseyml),
step `Desktop installers`).

Turning differential packaging off costs nothing here. Blockmaps are not
published (docs/RELEASING.md §3 publishes the zip, the two per-architecture setups and
`SHA256SUMS.txt`), and the updater downloads whole installers.

## `mac` and `linux`

Configured but never built or published. Only the Windows installers ship
(docs/RELEASING.md §2, "What's NOT verified").
