# Closing the 4.0 legacy shortfalls

A plan for the places where 4.0 fell short of [the implementation plan](../IMPLEMENTATION-PLAN.md). It is written for 4.1 and lives on `4.1-development`.

Status: draft, rewritten on 2026-10-16. Adam asked that every step improve the program's structure for the long term rather than move a number. So the import loop is now cut by giving each shared job an owner. The earlier versions cut it by handing each file its old imports at startup (the "inversion"), and that approach is gone ([why](#why-not-hand-files-their-imports-at-startup)). The plan now also ends with the global `S` object deleted, which Adam is deciding on. Earlier versions were reviewed by Astra (Codex CLI) on `ef704e0` and `edd76d1`; the findings and responses are on the PR. This version needs a fresh external review. No step has started apart from L1, which another thread owns.

## The rule every step follows

Each step moves a responsibility to the place that should own it, so that a dependency disappears from the program, not only from the import graph. Each PR in this plan says, in a "Structure" section of its description (added to the PR template by L0):

1. which responsibility moves, and to which owner;
2. which dependency it removes, and that it adds none pointing up a layer (a feature never depends on legacy code, core never depends on anything);
3. what can now be tested on its own;
4. the loop and `S` figures before and after, from `node tools/dep-report.mjs --legacy-metrics`.

The reviewer rejects a PR that only rearranges imports without moving a responsibility.

The layers the steps move code into, with dependencies pointing down only:

| Layer | Holds |
| --- | --- |
| `src/core/`, `shared/` | Document rules and plain helpers. No browser, no state |
| `src/application/` | The session, commands, the save coordinator, the action registry, and the state owners |
| `src/features/` | Views and panels. They read through the application layer and listen for changes |
| `src/adapters/` | Storage, file formats, transport and the platform |
| `src/bootstrap/` | The one place that builds and connects everything at startup |

## The shortfalls

From the goals review of 2026-10-16 (`refactor-review/goals-scorecard.md` in the project's shared files), measured on `324171e` (4.0.0-beta.1):

| # | Shortfall | Measured on `324171e` | Plan rule it misses |
| --- | --- | --- | --- |
| F1 | The legacy layer is barely smaller | 79 numbered files in `src/js`, 38,853 lines (3.1: 72 files, 42,504 lines); one import loop of 46 modules and 310 links; 53 `S` importers; 1,172 `S.` references in `src/js` | §1: "describe remaining legacy debt honestly"; §3: completed areas acyclic |
| F2 | `21-events.js` became six wiring files | `22a`–`22f`, 1,452 lines of numbered JS; five of them read `S` (44 references to 23 fields) | M6: delete it "not by relocating it into another catch-all module" |
| F3 | Three `S.state` assigners, target two | `00-prelude.js:7`, `02b-doc-id.js:35` and `:68`, `03-sync.js:795` | M4 E4 |
| F4 | Typing speed not re-measured after M6 | Re-measured 2026-10-16 on the x64 PC: `main` matches the M4 tree, and against 3.1 typing p50 is 3.4 → 4.0 ms (short fixture) and 5.3 → 5.9 ms (long): +0.6 ms. Logs: `D:\vibecoding\.scratch\perf-4x\` on the PC | §2: bounded per-keystroke work |

Adam accepted the +0.6 ms as the new baseline on 2026-10-16. This plan's performance rule is that nothing in it makes typing slower than `324171e` ([Performance](#performance)).

## What the legacy layer is made of

| Group | Files | Lines | What they are |
| --- | --- | --- | --- |
| Movable leaves | 9: `00p`, `02c`, `02d`, `03c`, `04a`, `04b`, `05q`, `20i`, `20k` | 1,422 | Preferences, the blob registry, gallery helpers, the history database, and five small UI helpers. They read no `S`, sit outside the loop, and import nothing an adapter or a feature is forbidden to import, apart from each other |
| Export writers | 8: `14b`–`14e`, `15`, `16`, `16b`, `17` | 4,682 | Read no `S` and sit outside the loop, but import legacy singletons: the cached rich-text reader (`cellOf`, `inertBody`, `fromHtml`, `htmlToMarkdown` from `src/legacy/richtext.ts`), `productionReaders`, `htmlToPlainText`, `cacheSeal`, `readSession`, and `migrateRows` from `02-state.js`. `tools/dep-report.mjs` forbids an adapter to import any of those, so they cannot move until those become inputs (L4b) |
| Bridge faces | 3: `02-state`, `04-richtext`, `04c-doc-model` | 150 | The numbered-module face of `src/legacy/richtext.ts` and `document-ports.ts`. They retire with those bridges (plan §8 item 2), not in this plan |
| The wiring files | `22a`–`22f` | 1,452 | Mount the features and pass them ports; read 23 `S` fields |
| The loop and the `S` users | 46 modules in the loop, plus the rest | about 31,000 | The app's live behaviour: hosted and collaboration, rendering, rows, panels, comments, the prompter, drafts, desktop glue |

`05r-read-time.js` and `18d-command-menu.js` are outside the loop and read no `S`, but they are feature code that imports loop members. They move folder in L5. A search for exported functions with no caller found six (`pictureBytes`, `galleryOverlayOpen`, `liveCutNonce`, `readTimeEditing`, `dataUrlToBytes`, `menuItemReason`). Each one goes in the PR that next touches its file.

### What the import loop is made of

The 46 loop files import 402 different names from each other across 310 links. The appendix's [loop model](#loop-model) reads each one's code and sorts it:

| Kind | Names | Examples | Why it ties files together today |
| --- | --- | --- | --- |
| `rule`: a function that uses no state, no page and no loop file | 46 | `formatTimestamp`, `fileKindFromName`, `slugify` | It sits in a big file, so using it means importing that file |
| `page-helper`: as `rule`, but it touches the page | 14 | `showToast` (imported by 31 loop files), `cellSelection` | The same |
| `value`: a constant, or a name a file passes through from elsewhere | 60 | storage keys, `ROW_STATUSES`, `normalizeDocId` | The same; a pass-through name ties two loop files together although neither owns it |
| `changing`: an exported variable its own file reassigns | 15 | `autoSaveEnabled`, `linkTurnedOff`, `findOpen` | Other files read another file's live variable |
| `stateful`: a function over `S` or its file's own variables, calling no loop file | 102 | `findRowIndex`, the tag registry, the comment author name, the stash | State lives in whichever file first needed it |
| `calls-loop`: a function that calls into another loop file | 165 | `render` (17 importers), `markDirty` (9), `queueAutoSave` (9), `updateFileChip` (9), `closeAllSidePanels`, `openSettings`, `editCell`, `saveDoc` | See below |

The `calls-loop` names are of five kinds, and each has its own step: "tell everyone" calls that a change must make to every display that depends on it (37 names, L3e), panels closing each other (8, L3f), opening dialogs and views (9, L3g), edits that skip the session (9, L3d), and the document lifecycle (open, save, autosave, merge, drafts; L3h). The original plan names the first as what a successful refactor removes: changes should be "discoverable without ... manually recalling dirty/render/save side effects" (plan §1).

### What `S` is made of

`S` (`src/js/_state.js`) is one object that any legacy file can read or change: 53 fields, 1,176 references (1,172 in `src/js`, 4 in `src/legacy/screen-state.ts`), imported by 53 modules.

| Field | References | Files | What it is | Where it goes |
| --- | --- | --- | --- | --- |
| `S.state` | 439 | 46 | The live document. The session has owned it since milestone 3; `S.state` is the copy legacy code still reads and writes | Writes become session commands (L3d), reads go through the session's read view (L3i) |
| `S.DESKTOP` | 179 | 24 | "Running in the desktop app" | A platform module (L3c) |
| `S.serverMode` | 58 | 7 | "Connected to a server" | The connection owner (L3c) |
| 50 others | 500 | | Per-area UI state: drag row, prompter open, find options, voice | The owner of each area: 19 in L2a, 31 in L3b |

The original plan did not promise to delete `S`. It said new code never touches it (met), only the document's owner assigns `S.state` (L1), and unused fields go in 4.x (§8). Deleting it is this plan's end state because every field is either a copy of something that already has an owner or state that belongs to one area, and the steps below move it there anyway.

## Exit criteria for the plan

All are measured on the closing tree and certified by `node tools/dep-report.mjs --legacy-metrics --assert tools/legacy-exit.json` (L0), which exits non-zero if any value misses its threshold. Loops are counted on `dep-report`'s graph of every frontend module, not only `src/js`. "Now" is `324171e`.

| Metric | Now | At close |
| --- | --- | --- |
| Modules in any frontend import loop | 46 | 0 |
| Links between loop modules | 310 | 0 |
| `S` | 53 fields, 1,176 references, 53 importers | `_state.js` deleted: 0 references, 0 importers |
| `S.state` assigners | 3 | 0; the session holds the document |
| Numbered files in `src/js` | 79 | 57 or fewer |
| Lines in numbered files | 38,853 | 32,000 or fewer (−25% against 3.1's 42,504) |
| A new numbered file, a rise in any file's `S.` count, or a new name imported between loop modules | not checked | each fails `npm run check:deps` |
| Displays | refreshed by direct calls | each display in L3e has a test showing that a change made through the session or its owner refreshes it with no direct call |
| Save destinations | wired into the save code by hand | a throwaway destination registered in a test saves through Save, autosave and Save As with no other edit (L3h) |
| Typing p50 against `324171e` | | no worse by more than 0.5 ms on either fixture |
| Gate runs | | [Gate](#gate) |

## Steps

Each step lists its PRs. Every code PR gets CI and one independent review, as [review.md](review.md) says, and carries the "Structure" section above. "Cloud" is a Claude thread in the project's cloud container. "Codex" is a Codex CLI job run through a Remote Control session on the x64 PC. "PC" is a run on the x64 PC (Windows, Edge, Electron). Each step's exit is local to that step, so it holds whatever else has merged.

Predicted loop size after each step comes from the [loop model](#loop-model). Each PR regenerates the prediction on its own base. A PR that misses its prediction does not merge as it stands: either it moves the responsibility that kept the number up, or it amends this table in the same PR, naming the link and the reason. The reviewer checks that.

| After | Modules in the loop | Links inside it |
| --- | --- | --- |
| `324171e` | 46 | 310 |
| L3a rules, helpers and constants | 43 | 233 |
| L3b state owners | 35 | 163 |
| L3d edits through the session | 33 | 152 |
| L3e displays listen | 18 | 56 |
| L3f panels | 14 | 44 |
| L3g navigation | 9 | 28 |
| L3h the document lifecycle | 0 | 0 |

L2, L3c, L3i and L4 do not change the loop. They remove `S` and numbered files.

### L0. Stop regrowth and publish the measurements (first; 1 PR; cloud, Sonnet)

`tools/dep-report.mjs` gains three baseline rules, recorded in `tools/dep-baseline.json` like the existing ones:

- `legacy-file`: a numbered file not in the baseline fails; a removed one is pruned.
- `legacy-state-refs`: each file's count of `S.` references; a rise fails, a fall is pruned to the new value.
- `loop-import`: each name one loop module imports from another; a new one fails. The module-level `cycle-edge` rule misses a new name on an existing link, which is how a new "tell everyone" call would come back.

`--legacy-metrics` prints the exit table's figures as JSON. `--assert <file>` compares them with `tools/legacy-exit.json`, which L0 commits with the "At close" column, and the gate runs it. `--loop-model <steps.json>` runs the appendix model on the current tree. All of these are plain Node, so they run the same in PowerShell, cmd and POSIX shells.

`.github/pull_request_template.md` gains the "Structure" section with the four questions, answered "none" by a PR that moves nothing.

Exit: `tools/test-dep-report.mjs` has fail-first cases for a new numbered file, an added `S.` reference, a new loop import and a missed threshold; `--legacy-metrics` on `324171e` prints the "Now" column; `npm run check:deps` passes with 0 new and 0 resolved.

### L1. One fewer document writer (in progress in the thread "One fewer global document writer")

`03-sync.js`'s merge adoption goes through the live-document port in `02b-doc-id.js`. Exit: `stateAssigners` is 2.

### L2. Move the wiring into `src/bootstrap/` (fixes F2)

**Structure:** startup and mounting live in one typed place instead of six numbered files that read `S`, and the wiring gets its facts from owners, not from the global.

**L2a. The wiring's 19 fields get owners** (3 PRs, by area). Each field moves out of `S` into the module that owns the behaviour, and every reader uses that owner's functions:

| PR | Fields | Other readers | Who |
| --- | --- | --- | --- |
| Editor | `dragRowId`, `pendingImageRowId`, `undoApplying`, `untaggedMutedFor`, `lastFocusedRowId`, `writerLastCell`, `lastMergeUndo` | `05f`, `06`, `05h`, `05e`, `00-prelude`, `05-render`, `07`, `20-teleprompter`, `19-writer`, `03-sync` | cloud, Opus (editing hot path, undo) |
| Production and comments | `tagExpanded`, `tagAddingPersonFor`, `productionGroupBy`, `findMatchCase`, `tagRenaming`, `gearGroupBy`, `commentSortMode` | `07`, `08`, `09`, `10` | cloud, Sonnet |
| Views | `prompterSkipShot`, `prompterOpen`, `prompterPlaying`, `voiceFollowActive`, `importModeTouched` | `20-teleprompter`, `00-prelude`, `11-import` | cloud, Sonnet |

The wiring reads `S.state`, `S.dirty`, `S.initialStateReady` and `S.DESKTOP` through ports that already exist: the live-document port, the session's dirty state, the startup's ready signal and the platform flag.

Exit per PR: its fields have no `S.` reference anywhere, and `legacy-state-refs` falls for every file that read them.

**L2b. Port the files** (2 PRs). `22a-editor-wiring.js` becomes `src/bootstrap/wiring/editor.ts` (cloud, Opus). `22b`–`22f` become `production.ts`, `comments.ts`, `views.ts`, `overlay.ts` and `startup.ts` in the same folder (Codex, Sol xhigh). Strict TypeScript, no behaviour change, slot order unchanged; the evidence is the 294-row remount test and the 14 root-route registrations (13 click slots and the tags-anchor mousedown).

Exit: no `src/js/22*.js`; 0 `S.` references in `src/bootstrap/`; a layer rule forbids `src/bootstrap/` to import `_state.js`, with a fail-first case; 6 numbered files and 1,452 numbered lines removed; the remount test passes 4/4.

### L3. Give every shared job an owner (fixes the core of F1)

**L3a. Rules, helpers and constants move to where they belong** (4 PRs; after L0, beside L2a).

| PR | What moves | To | Who |
| --- | --- | --- | --- |
| 1 | The 46 `rule` functions, and `rowSeconds`, `estimatedSeconds` and `brollCountInRow`, whose only loop call is a name this step moves | `src/core/` for document rules (scene length, tags, rows, doc ids), `shared/` for text and time helpers | Codex, Sol high |
| 2 | The 14 page helpers: `showToast` and `showActionToast` to `src/features/notices/toast.ts`; selection helpers to `src/features/editing/` | Feature folders | cloud, Sonnet |
| 3 | Constants: storage keys to `src/adapters/storage/keys.ts`, `DEFAULT_COLLAB_SERVER` to `src/adapters/transport/`, `MD_IMAGE_PREFIX_RE` to `src/adapters/formats/`, writer limits to `src/features/writer/`, tag and b-roll constants to `src/core/production/`. Pass-through names are imported from their origin | Their owners | Codex, Sol high |
| 4 | `findRowIndex(id)`, which reads `S.state`, becomes `rowIndexOf(doc, id)` in `src/core/document/`, and its 14 callers pass the document they hold. `reviewMode` and `reviewBlocked` move to `_home.js`, which owns the connection they read | Core; the connection owner | cloud, Sonnet |

**Structure:** dependencies point down to core and shared, which depend on nothing. Each rule has one home and one test file that runs in Node without the app.

**Long term:** a change to a rule (how scene length is counted, how tag names are normalised) is one small file and its tests. Today it is an edit inside a large file that also draws panels.

Exit: `--loop-model` reports no `rule`, `page-helper` or `value` name imported between loop modules, and the loop is at or below the table.

**L3b. Each piece of shared state gets one owner** (6 PRs, by area; after L2a).

The 102 `stateful` functions, the 15 `changing` variables and the 31 `S` fields not in L2a, L3c or L3i move into owner modules. Seven functions whose only loop calls are into this state (`personColor`, `personColorsWithMine`, `presenceShown`, `stampRow`, `getEditorName`, `personSwatchesHtml`, `tagFieldOccurrences`) move out with it. An owner holds one area's state, the functions that read and change it, and a `subscribe(listener)` that announces changes. The owner sits in the area's folder under `src/application/` or `src/features/`, is strict TypeScript, and is constructed by the wiring like the other application owners (plan §5, milestone 4: no module-evaluation singletons).

| PR | Area | Who |
| --- | --- | --- |
| 1 | Rows and editing: selection, focus, drag, paint epoch | cloud, Opus (editing hot path) |
| 2 | Hosted: server token, link state, session expiry, server bookmarks | cloud, Opus (state ingress) |
| 3 | Stash, drafts and history: stash, `draftRestorePending`, `draftServerResume`, autosave flags and timers | cloud, Opus (saving) |
| 4 | Production tags and b-roll: the tag registry, selection, delete arming | Codex, Sol high |
| 5 | Comments and people: author name, arming, reply drafts | Codex, Sol high |
| 6 | Panels, find, prompter and voice: side panel ids, `findOpen`, voice and transcript fields | cloud, Sonnet |

**Structure:** each piece of state has one owner and one way to change it. No file reads another file's variables, and no area's state sits in a global.

**Long term:** "what can change this?" has one answer, so a bug in that state is in one file. Tests set state up through its owner instead of through `S`. An owner is not a global under another name: it belongs to one area, it is changed only through its own functions, and it announces changes, which is what L3e needs.

Exit per PR: the area's `changing` names and `S` fields have no reference outside the owner; the owner's Node tests cover every change function and its announcement; the loop is at or below the table.

**L3c. Platform and connection facts** (2 PRs; Codex, Sol high; after L0). `S.DESKTOP` (179 references) becomes `isDesktop()` from a platform module in `src/adapters/`, set once by the wiring. `S.serverMode` (58) moves to the connection owner. Mechanical.

**Structure:** "where are we running" and "are we connected" each have one owner instead of a field anyone can write.

Exit: 0 references to `S.DESKTOP` and `S.serverMode`.

**L3d. Every document edit goes through the session** (3 PRs; cloud, Opus; after L3b).

About 30 lines still write into `S.state` directly (in `02b-doc-id`, `03-sync`, `05g`, `05t`, `07`, `08c`, `09`, `10`, `13-hosted` and `14-export`; the appendix's grep lists them), and 9 edit functions are called across files instead of as commands (`editCell`, `moveRowTo`, `renameTag`, `bulkTagRows`, `anchorBrollInRows` and others). Each becomes a session command under milestone 6's commit contract: stamps and dependent reconciliation inside the mutation boundary, one generation step, one undo entry.

**Structure:** every document edit takes one route: command, session, then undo, dirty, save and displays.

**Long term:** undo, autosave, drafts and collaboration see every edit the same way, so none can skip them.

Exit: the appendix grep prints only the whole-document assignments in `00-prelude.js` and `02b-doc-id.js`, which L3i removes with `S`; the 9 names are not imported between loop modules; each new command has undo and redo tests and a refused-edit test.

**L3e. Displays listen for changes instead of being called** (5 PRs; after L3b and L3d).

37 functions are called after a change to refresh something that depends on it: `render` and `renderAbsorbed`, `markDirty`, `clearDirty`, `updateSaveStatus`, `queueAutoSave`, `updateFileChip`, `updateIdentityChip`, `notifyDesktopDocumentState`, `updateScriptStats`, the panel renders and badges, and the menu refreshes. `setMyColor`, whose only remaining loop call is `render`, leaves the loop with them. The session already announces every document change (change sets, listeners and refresh jobs since milestone 3), and L3b's owners announce theirs. Each display subscribes to what it shows, in its own folder, and the calls go.

| PR | Displays | Who |
| --- | --- | --- |
| 1 | The row render and absorbed render | cloud, Opus (editing hot path; perf run) |
| 2 | Dirty state, save status and the autosave queue | cloud, Opus (saving) |
| 3 | The file chip, the identity chip and the desktop document state | cloud, Sonnet |
| 4 | Panel renders and badges: production, comments, b-roll, history, rundown, presence, writer, gallery overlay, annotator | Codex, Sol high |
| 5 | Menus: file, collaborate, connect, server | Codex, Sol high |

**Structure:** code that changes something no longer knows who shows it. The arrows go from each display to the session or the owner, not from every editor to every display. This is the largest single cut in the loop.

**Long term:** a new display subscribes from its own folder and no editing code changes. Today a new display means finding every place that edits and adding a call there, and a missed call shows up as a stale panel.

Exit per PR: its names are not imported between loop modules; each display has a test that a change made through the session or its owner refreshes it with no direct call; the number of renders per keystroke is unchanged (a counted test on the typing path), so nothing renders twice.

**L3f. Panels coordinate through the panels feature** (1 PR; cloud, Sonnet; after L3e). `src/features/panels` provides "open panel X" and "close the side panels", and each panel registers with it. Panels stop closing each other by name (`closeAllSidePanels`, `openSidePanel`, the five `close…Panel` functions, `closeNewTabPage`).

**Structure:** panels depend on the panels feature, not on each other. **Long term:** a new panel is one registration and no existing panel changes.

Exit: no panel file imports another panel's file; the 8 names are not imported between loop modules.

**L3g. Opening things goes through the action registry** (2 PRs; Codex, Sol high; after L3f). "Open settings", "go to scene", "open the comment composer", "open the annotator" and the rest of the 9 become actions run by name through milestone 1's registry, which menus and shortcuts already use.

**Structure:** code that opens a dialog does not import the dialog's file, and the registry is the one list of what the app can do. **Long term:** one way to trigger anything, from code, a menu, a key or the command menu; moving a dialog touches one registration.

Exit: the 9 names are not imported between loop modules; each is an action with a test that running it opens its view.

**L3h. The document lifecycle gets designed interfaces** (4 PRs; cloud, Opus; PC Electron smoke on each head; after L3g).

What remains is 9 files: `03-sync`, `11-import`, `13-hosted`, `14-export`, `18-local-files`, `18a-local-merge`, `20d-formats`, `20f-desktop` and `20g-drafts`. They call each other both ways because each save destination (server, local file, desktop file) is wired into the save code by hand, and the save code calls back into each one. Milestone 4's save coordinator gains a destination registry, and milestone 4's transition API a source registry:

1. The destination interface and registry, with the server destination registered (`13-hosted`, `14-export`).
2. The local file and desktop destinations (`18-local-files`, `18a-local-merge`, `20f-desktop`).
3. Document sources: file open, server document, draft restore, import and stash (`03-sync`, `11-import`, `20d-formats`, `20g-drafts`).
4. Callers say "save" or "open" through the coordinator and the transition API, and the last cross-calls go.

**Structure:** destinations and sources depend on the coordinator, and the coordinator depends on none of them. It is the pattern milestone 5 used for exporters, which made adding an exporter one provider and one registration.

**Long term:** this finishes a goal the original plan only partly met: "change a storage implementation: its adapter and its tests" (§1). A new destination, such as a cloud drive, is one registration.

Exit: 0 modules in any frontend loop, and `tools/test-dep-report.mjs` fails if one returns; a throwaway test destination saves through Save, autosave and Save As with no other edit; the race matrix with `SPLITPAGE_M4_GATE=1` passes with no case demoted.

**L3i. Reads of the document go through the session, and `S` is deleted** (5 PRs, by area; after L3d).

The remaining `S.state` references (438 in `src/js` today, most of them reads) become reads through the session's read-only view (`readSession` in `src/legacy/session-bridge.ts` today, an application port once the bridge retires). The last PR deletes `_state.js`.

| PR | Area | Who |
| --- | --- | --- |
| 1 | Render, rows and editing | cloud, Opus (hot path; perf run) |
| 2 | Rundown, scene status, find and the writer | cloud, Opus (hot path; perf run) |
| 3 | Production, b-roll and comments | Codex, Sol high |
| 4 | Hosted, drafts, history, sync and desktop | Codex, Sol high |
| 5 | The rest, and `_state.js` deleted | Codex, Sol high |

**Structure:** the document has one owner and one way to read it, and the global is gone. **Long term:** nothing can change the document behind the session's back, so undo, autosave and collaboration are always right about what changed.

Exit: 0 `S.` references and no `_state.js`; the full browser run passes with the read view deep-frozen (`SPLITPAGE_FREEZE_CACHES=1`), which catches a write through an alias that the grep cannot see (plan §3 calls direct-writer counts "a limited metric").

### Why not hand files their imports at startup

The previous version of L3 replaced each loop file's imports with a list of the same functions handed to it at startup. That cuts every link in the import graph but changes no dependency: `13-hosted` would still call `saveDoc`, still break if `saveDoc` changed, and still need `14-export` to be understood. It also makes code harder to read ("go to definition" on a handed-in function lands on the list, not the function) and adds startup and teardown code, with tests, to 21 files. Handing a module what it needs at startup is good design when what is handed over is a small interface written for the receiver, as features get from the wiring today and as L3h does for saving. A copy of a file's old import list is not that.

### L4. Move the leaves and the writers out of `src/js` (F1, lines)

**Structure:** code moves into layer folders whose import rules `check:deps` enforces, and the export writers receive what they need instead of reaching into legacy singletons.

**L4a. The movable leaves** (3 PRs; Codex, Sol high; after L0). No adapter imports a feature or legacy code, and no feature imports another feature:

| PR | Files | Destination |
| --- | --- | --- |
| 1 | `02c-blobs`, `02d-gallery`, `03c-history-idb` | `src/adapters/storage/` |
| 2 | `00p-prefs` | Split: keys, read and write, and the formatters to `src/adapters/storage/prefs.ts`; `applyTheme`, `applyTagIcons` and its mount to `src/features/settings/` |
| 3 | `04a-row-motion` with `20i-topbar`, `04b-busy`, `05q-cell-reach`, `20k-phone-bar` | Feature folders; the three mounts become feature mounts called from `src/bootstrap/` |

Exit: the 9 files are gone (−1,422 numbered lines) and `npm run check:deps` reports 0 new.

**L4b. The writers stop importing legacy** (2 PRs; cloud, Opus; after L2b and L4a PR 1). Plan §5 step 2 said the writers' remaining legacy dependencies "become explicit inputs or permitted adapters":

1. An `ExportServices` type in `src/application/export/` holds the decoding the writers need (`cellOf`, `inertBody`, `fromHtml`, `htmlToMarkdown`, `htmlToPlainText`), `productionReaders` and `cacheSeal`. `src/bootstrap/` builds it and passes it to each provider at registration. The built-in registration (`14e-export-formats.js`) moves into the wiring as `src/bootstrap/wiring/exporters.ts`. The cached reader and the frozen-cache behaviour are the same objects as today, so byte output is unchanged.
2. `14b-export-kit.js` splits: its projection helpers take `ExportServices` and move with the writers in L4c; its capture binding stays in `14b` until the session bridge retires (plan §8).

Exit: none of `14c`, `14d`, `15`, `16`, `16b` and `17` imports `src/legacy/` or `02-state.js`; `14e` is gone; the byte goldens, `export-capture-app.test.mjs` and the INV-60 cases pass unchanged, and a changed golden stops the PR; the frozen-cache browser run passes on the PC.

**L4c. Move the writers** (2 PRs; Codex, Sol high): `14c`, `14d`, `16` and `16b`, then `15` and `17`, into `src/adapters/formats/` in strict TypeScript, with the same tests unchanged.

Exit: the 6 files are gone (−4,165 numbered lines). With L4b, L4 removes 16 files and 5,804 lines; with L2, the plan removes 22 files and 7,256 lines.

### L5. Moving the remaining numbered files into feature folders

After L3, the remaining numbered files are in no loop and use no `S`, so each is feature code in the wrong folder. Each moves into `src/features/` when a 4.1 feature next changes it, with L0's ratchets keeping the counts falling. Scheduling them as their own work instead is Adam's call.

## Order and parallelism

```
L0 ─┬─► L2a ──► L2b ──► L4b ──► L4c
    │     └──► L3b ──► L3d ──► L3e ──► L3f ──► L3g ──► L3h ──► gate
    │                    └──► L3i ───────────────────────────────▲
    ├─► L3a ──────────► (before L3b)
    ├─► L3c
    └─► L4a ──► (PR 1 before L4b)
L1 runs now, in its own thread.
```

- L3b follows L2a because both move fields out of `S` in the same files.
- L3d follows L3b because some edits change state that L3b gives an owner.
- L3e follows L3b and L3d: a display can only listen once every change it shows goes through an owner or the session.
- L3h comes last in the loop work because the save path is where the remaining files meet, and it is easiest to see once the rest has gone.

**One open PR per shared file.** A PR that would change a `src/js` or `src/bootstrap/` file another open PR in this plan changes waits for it to merge, then merges the base. The coordinator holds that queue. Only one Codex job runs at a time on the PC.

Size: 45 PRs. 25 are cloud threads (18 of them Opus) and 20 are Codex jobs. Without deleting `S` (L3c and L3i), it is 38. The perf runs and the gate runs are on the PC.

## Performance

Fixtures: the short (seed, 2 scenes) and long (30 scenes) fixtures of `tools/perf-record.mjs`; typing is 55 keys at 60 ms, key-down to the next frame. Procedure, on the x64 PC with nothing else heavy running:

```
node tools/perf-ab.mjs <base> HEAD --only short,long --rounds 5
```

`perf-ab` alternates the two builds round by round. The figure compared is the median over the rounds of each round's typing p50, per fixture.

- Each hot-path PR (L2a's editor PR, L2b's editor PR, L3b PR 1, L3e PR 1, L3i PRs 1 and 2) runs it against its own base before merge. A head p50 more than 0.5 ms above the base on either fixture stops the PR for investigation.
- At the gate, it runs against `324171e`, and the same 0.5 ms bound applies. The 3.1 comparison (`v3.1.0`) is run and recorded for information.

## Platforms

- **Linux:** hosted CI on every PR runs lint, types, `check:deps`, `check:comments`, the build and every discovered Node test, including L0's dependency tests and each owner's tests.
- **Windows:** the x64 PC runs `npm run verify`, the hot-path performance runs, the Electron smoke for L3h and the gate's browser and Electron runs.
- **macOS:** the project has no macOS machine, and the plan does not claim macOS coverage. The new tests are Node tests with no platform API; they are recorded as not run on macOS.

## Gate

On the closing tree:
- `npm run verify`;
- the Windows full browser run, plain and with `SPLITPAGE_FREEZE_CACHES=1`;
- the Electron dev smoke;
- the race matrix with `SPLITPAGE_M4_GATE=1`, with no case demoted;
- the remount test;
- the performance run above;
- `--legacy-metrics --assert tools/legacy-exit.json`;
- an external review (Astra).

The x64 packaged check is not required, because the build entry and the packaging inputs do not change. If a step changes what `build.mjs` bundles from outside `src/`, the check returns.

## Appendix: measurement procedures

These run from the repository root on `324171e` or later, in a POSIX shell (bash on Linux, macOS, WSL, or Git Bash on Windows). They are planning aids; L0's `dep-report` options replace them and certify the exits.

**Totals.**

```
ls src/js/[0-9]*.js | wc -l
cat src/js/[0-9]*.js | wc -l
grep -oE '\bS\.[A-Za-z_]+' src/js/*.js | wc -l
grep -roE '\bS\.[A-Za-z_]+' src/legacy src/bootstrap | wc -l
node tools/dep-report.mjs --metrics
```

**3.1.**

```
git ls-tree -r --name-only v3.1.0 src/js | grep -E '^src/js/[0-9][^/]*\.js$' | wc -l
git ls-tree -r --name-only v3.1.0 src/js | grep -E '^src/js/[0-9][^/]*\.js$' | xargs -I{} git show v3.1.0:{} | wc -l
```

**Group totals.** Run `wc -l` over each group's file list. The `S.` count per file is `grep -oE '\bS\.[A-Za-z_]+' <file> | wc -l`, and loop membership is the `cycle-edge` entries of `tools/dep-baseline.json`.

**`S` fields.**

```
grep -ohE '\bS\.[A-Za-z_]+' src/js/*.js src/legacy/*.ts | sort | uniq -c | sort -rn
grep -lE '\bS\.DESKTOP\b' src/js/*.js src/legacy/*.ts | wc -l
```

**Direct writes into `S.state`.** It finds assignments, `delete` and array mutation on a path that starts at `S.state`, but not writes through an alias, which L3i's frozen run catches:

```
grep -nE '\bS\.state(\.[A-Za-z_]+|\[[^]]+\])*\s*(=[^=]|\+=|-=)|\bS\.state\.[a-zA-Z_]+\.(push|splice|pop|shift|unshift|sort)\(' src/js/*.js
```

**Unused exports.** An exported function counts as unused when its name appears in no other file under `src`, `desktop`, `shared`, `tests` or `tools`, and only once in its own file:

```
for f in src/js/[0-9]*.js; do
  grep -oE "^export (async )?function [A-Za-z0-9_]+" "$f" | awk '{print $NF}' | while read n; do
    others=$(grep -rlw "$n" src desktop shared tests tools | grep -v "^$f$" | wc -l)
    own=$(grep -ow "$n" "$f" | wc -l)
    [ "$others" = 0 ] && [ "$own" -le 1 ] && echo "$f $n"
  done
done
```

### Loop model

It parses every `src/js` file with the TypeScript compiler in `node_modules`. For each name one loop module imports from another, it finds the exported function and follows calls to other functions in the same file, then sorts the name into the six kinds above: `calls-loop` if anything reached calls a loop file, else `stateful` if it uses `S` or a file-level variable, else `page-helper` if it uses `document`, `window` or another page global, else `rule`. A non-function export is `changing` if its file reassigns it and `value` otherwise, and a re-exported name is `value`. It then takes a list of steps, each naming kinds and function names, marks those names as moved, and prints the loop after each step: a link stays while any name it imports has not moved.

It is a model. It assumes a moved name takes nothing back into the loop with it, which each PR checks on its own base. Save it in the repository root as `loop-kinds.mjs` and the step list as `loop-steps.json` (neither is committed), then run `node loop-kinds.mjs loop-steps.json`. On `324171e` it prints the kind counts above and the table in [Steps](#steps).

```js
import fs from "fs";
import ts from "typescript";
const dir = "src/js/";
const baseline = JSON.parse(fs.readFileSync("tools/dep-baseline.json", "utf8"));
const loop = new Set();
for (const e of [baseline].flat().flatMap((b) => (Array.isArray(b) ? b : Object.values(b).flat()))) {
  if (e.rule === "cycle-edge") { loop.add(e.source.replace(dir, "")); loop.add(e.target.replace(dir, "")); }
}
const pageGlobals = new Set(["document", "window", "navigator", "localStorage", "sessionStorage", "location", "requestAnimationFrame", "getComputedStyle", "HTMLElement", "Node", "Element"]);
const files = {};
function parse(file) {
  if (files[file]) return files[file];
  const sf = ts.createSourceFile(file, fs.readFileSync(dir + file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imported = new Map(), fns = new Map(), vars = new Set(), assigned = new Set(), exported = new Map();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const from = st.moduleSpecifier.text, b = st.importClause?.namedBindings;
      if (b && ts.isNamedImports(b)) for (const el of b.elements) imported.set(el.name.text, { from, name: (el.propertyName || el.name).text });
      if (b && ts.isNamespaceImport(b)) imported.set(b.name.text, { from, name: "*" });
      if (st.importClause?.name) imported.set(st.importClause.name.text, { from, name: "default" });
    }
    const isExport = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) { fns.set(st.name.text, st); if (isExport) exported.set(st.name.text, st.name.text); }
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue;
      const init = d.initializer;
      if (init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init))) fns.set(d.name.text, init); else vars.add(d.name.text);
      if (isExport) exported.set(d.name.text, d.name.text);
    }
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) {
      exported.set(el.name.text, st.moduleSpecifier ? null : (el.propertyName || el.name).text);
    }
  }
  (function walk(n) {
    const op = n.operatorToken?.kind;
    if (ts.isBinaryExpression(n) && op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(n.left)) assigned.add(n.left.text);
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator) && ts.isIdentifier(n.operand)) assigned.add(n.operand.text);
    ts.forEachChild(n, walk);
  })(sf);
  return (files[file] = { imported, fns, vars, assigned, exported });
}
function profile(file, name, seen) {
  const f = parse(file), node = f.fns.get(name), p = { state: false, page: false, loop: false };
  if (!node || seen.has(file + "#" + name)) return p;
  seen.add(file + "#" + name);
  (function walk(n) {
    if (ts.isIdentifier(n)) {
      const id = n.text, imp = f.imported.get(id);
      if (f.vars.has(id) || (id === "S" && imp)) p.state = true;
      if (pageGlobals.has(id)) p.page = true;
      if (imp && imp.from.startsWith("./") && loop.has(imp.from.slice(2)) && id !== "S") p.loop = true;
      if (id !== name && f.fns.has(id)) { const q = profile(file, id, seen); p.state ||= q.state; p.page ||= q.page; p.loop ||= q.loop; }
    }
    ts.forEachChild(n, walk);
  })(node);
  return p;
}
function kindOf(file, name) {
  const f = parse(file);
  if (!f.exported.has(name)) return "value";
  const local = f.exported.get(name);
  if (local === null || f.imported.has(local)) return "value";
  if (!f.fns.has(local)) return f.assigned.has(local) ? "changing" : "value";
  const p = profile(file, local, new Set());
  return p.loop ? "calls-loop" : p.state ? "stateful" : p.page ? "page-helper" : "rule";
}
const links = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
  for (const [, imp] of parse(file).imported) {
    if (!imp.from.startsWith("./")) continue;
    const target = imp.from.slice(2);
    let link = links.find((l) => l.s === file && l.t === target);
    if (!link) links.push((link = { s: file, t: target, names: [] }));
    link.names.push(imp.name);
  }
}
function cycles(kept) {
  const adj = {};
  for (const l of kept) (adj[l.s] ??= []).push(l.t);
  let i = 0; const stack = [], on = new Set(), index = {}, low = {}, out = [];
  function visit(v) {
    index[v] = low[v] = i++; stack.push(v); on.add(v);
    for (const w of adj[v] || []) {
      if (index[w] === undefined) { visit(w); low[v] = Math.min(low[v], low[w]); } else if (on.has(w)) low[v] = Math.min(low[v], index[w]);
    }
    if (low[v] === index[v]) { const c = []; let w; do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) out.push(c); }
  }
  for (const v of Object.keys(adj)) if (index[v] === undefined) visit(v);
  return out.sort((a, b) => b.length - a.length);
}
const kinds = {};
for (const l of links) if (loop.has(l.s) && loop.has(l.t)) for (const n of l.names) kinds[l.t + "#" + n] ??= kindOf(l.t, n);
const counts = {};
for (const k of Object.values(kinds)) counts[k] = (counts[k] || 0) + 1;
console.log("names by kind", JSON.stringify(counts));
const done = new Set();
function report(label) {
  const kept = links.filter((l) => !l.names.every((n) => done.has(l.t + "#" + n)));
  const c = cycles(kept), inLoop = new Set(c.flat());
  console.log(label, "| largest", c[0]?.length || 0, "| in any loop", inLoop.size, "| loops", c.length, "| links inside", kept.filter((l) => inLoop.has(l.s) && inLoop.has(l.t)).length);
}
report("now");
for (const step of JSON.parse(fs.readFileSync(process.argv[2], "utf8"))) {
  for (const [key, kind] of Object.entries(kinds)) if (step.kinds?.includes(kind) || step.names?.includes(key.split("#")[1])) done.add(key);
  report(step.label);
}
```

`loop-steps.json`, the steps in plan order:

```json
[
  {"label": "L3a rules", "kinds": ["rule", "page-helper", "value"], "names": ["rowSeconds", "estimatedSeconds", "brollCountInRow", "findRowIndex", "reviewBlocked"]},
  {"label": "L3b state", "kinds": ["stateful", "changing"], "names": ["personColor", "personColorsWithMine", "presenceShown", "stampRow", "getEditorName", "personSwatchesHtml", "tagFieldOccurrences"]},
  {"label": "L3d edits", "names": ["editCell", "syncFieldFromDom", "galleryEdit", "moveRowTo", "bulkTagRows", "removeTag", "renameTag", "anchorBrollInRows", "normalizeImportedRows"]},
  {"label": "L3e subscriptions", "names": ["render", "renderAbsorbed", "renderRow", "paintRowTimes", "markDirty", "markAbsorbedDirty", "clearDirty", "updateSaveStatus", "noteSaveStatus", "setSaveButtons", "queueAutoSave", "updateFileChip", "updateIdentityChip", "notifyDesktopDocumentState", "updateScriptStats", "syncPanelClass", "renderProduction", "renderComments", "renderHistory", "renderRundown", "renderBrollViews", "updateBrollBadge", "scheduleBrollRefresh", "runBrollRefresh", "updateTagBadges", "updateGearCount", "updateWriterStats", "drawWriter", "paintWriterDraw", "paintPresence", "paintRundownPresence", "refreshGalleryOverlay", "refreshAnnotator", "refreshFileMenu", "updateCollaborateMenu", "updateConnectMenu", "updateServerMenu", "setMyColor"]},
  {"label": "L3f panels", "names": ["closeAllSidePanels", "openSidePanel", "closeHistoryPanel", "closeGearPanel", "closeProductionPanel", "closeBrollPanel", "closeCommentsPanel", "closeNewTabPage"]},
  {"label": "L3g navigation", "names": ["openServersDialog", "openCommentComposer", "openAnnotator", "openGalleryLink", "goToScene", "openSettings", "toggleFileMenu", "maybeAskGuestName", "canOpenPrompterInBrowser"]}
]
```
