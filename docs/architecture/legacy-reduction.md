# Closing the 4.0 legacy shortfalls

A plan for the places where 4.0 fell short of [the implementation plan](../IMPLEMENTATION-PLAN.md). It is written for 4.1 and lives on `4.1-development`.

Status: draft, revised on 2026-10-16 after two independent reviews of `c728fbb`; the findings and responses are on the PR. The import loop is cut by giving each shared job an owner, not by handing files their imports at startup ([why](#why-not-hand-files-their-imports-at-startup)). Adam chose to delete the global `S` object within this plan (2026-10-16), and the plan counts the whole of that work, tests included. L1 has merged (#650). No other step has started.

## The rule every step follows

Each step moves a responsibility to the place that should own it, so that a dependency disappears from the program, not only from the import graph. Each PR in this plan says, in a "Structure" section of its description (added to the PR template by L0):

1. which responsibility moves, and to which owner;
2. which dependency it removes, and that it adds none pointing up a layer;
3. what can now be tested on its own;
4. the loop and `S` figures before and after, from `node tools/dep-report.mjs --legacy-metrics`.

The reviewer rejects a PR that only rearranges imports without moving a responsibility.

The layers the steps move code into, with dependencies pointing down only (`layerAllows` in `tools/dep-report.mjs`):

| Layer | Holds | May import |
| --- | --- | --- |
| `src/core/`, `shared/` | Document rules and plain helpers. No state, no platform globals | Core and shared |
| `src/application/` | The session, commands, the save coordinator, the action registry, the state owners, and ports for effects other areas trigger (notices, menu items, the clipboard, cell editing). No platform globals: timers, storage and the clock come in as ports | Core, contracts, shared |
| `src/features/` | Views and panels. They get owners and ports from the wiring and listen for changes | Core, application, contracts, shared |
| `src/adapters/` | Storage, file formats, transport, and the desktop bridge | Core, application, contracts, shared |
| `src/bootstrap/` | The one place that builds and connects everything at startup | Anything except `src/js/_state.js` |

**How numbered files reach an owner.** An owner that more than one area uses lives in `src/application/` and is constructed by the wiring at startup; nothing creates one at module evaluation. Numbered files reach it through one named bridge in `src/legacy/`, which throws before startup and after teardown, as `session-bridge.ts` does with `running()`. Each new bridge joins plan §8's list of bridges to retire, and goes when its last numbered importer becomes a feature. Features receive owners as ports from the wiring, as `features/file-menu/mount.ts` receives `showToast` today. Nothing goes into a feature or adapter folder that another area will import, because no feature may import another feature or an adapter.

## The shortfalls

From the goals review of 2026-10-16 (`refactor-review/goals-scorecard.md` in the project's shared files), measured on `324171e` (4.0.0-beta.1):

| # | Shortfall | Measured on `324171e` | Plan rule it misses |
| --- | --- | --- | --- |
| F1 | The legacy layer is barely smaller | 79 numbered files in `src/js`, 38,853 lines (3.1: 72 files, 42,504 lines); one import loop of 46 modules and 310 links; 53 `S` importers; 1,172 `S.` references in `src/js` | §1: "describe remaining legacy debt honestly"; §3: completed areas acyclic |
| F2 | `21-events.js` became six wiring files | `22a`–`22f`, 1,452 lines of numbered JS; five of them read `S` (44 references to 23 fields) | M6: delete it "not by relocating it into another catch-all module" |
| F3 | Three `S.state` assigners, target two | `00-prelude.js:7`, `02b-doc-id.js:35` and `:68`, `03-sync.js:795`. Fixed by L1 (#650): 2 since `f1f22e7` | M4 E4 |
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
| `rule`: a function that uses no state and no platform global, and imports only from `src/core/` and `shared/` | 26 | `cloneState`, `slugify`, `fileKindFromName` | It sits in a big file, so using it means importing that file |
| `page-helper`: as `rule`, but it uses a platform global | 11 | `showToast` (imported by 31 loop files), `joinServer` | The same |
| `value`: a constant, or a name a file passes through from elsewhere | 60 (61 on `f1f22e7`) | storage keys, `ROW_STATUSES`, `normalizeDocId` | The same; a pass-through name ties two loop files together although neither owns it |
| `changing`: an exported variable its own file reassigns | 15 | `autoSaveEnabled`, `linkTurnedOff`, `findOpen` | Other files read another file's live variable |
| `stateful`: a function over `S`, its file's own variables, or anything imported from outside core and shared (preferences, the blob store, the session bridge, the connection), calling no loop file | 125 | `findRowIndex`, the tag registry, `formatTimestamp` (reads the clock preference) | State lives in whichever file first needed it |
| `calls-loop`: a function that calls into another loop file | 165 | `render` (17 importers), `markDirty` (9), `queueAutoSave` (9), `updateFileChip` (9), `closeAllSidePanels`, `openSettings`, `editCell`, `saveDoc` | See below |

106 of the 165 `calls-loop` names are what holds the loop together, and each kind has its own step: calls that a change must make to every display and recorder that depends on it (38 names, L3e), the document lifecycle (open, save, autosave, merge, drafts; 31, L3h), edits and cell-editing wrappers (9, L3d), opening dialogs and views (9, L3g), panels closing each other (7, L3f), and 12 that move with the state or rule they wrap (L3a to L3c). The other 59 stay as ordinary one-way calls once the loop is gone, and move with their files in L5. The original plan names the first as what a successful refactor removes: changes should be "discoverable without ... manually recalling dirty/render/save side effects" (plan §1).

### What `S` is made of

`S` (`src/js/_state.js`) is one object that any legacy file can read or change. On `f1f22e7` it has 53 fields and 1,175 references in `src/` (1,171 in `src/js`, 4 in `src/legacy/screen-state.ts`), and 53 modules import it. Tests use it too: 119 files under `src/test/` import `_state.js`, 113 tests and six harness files (`_app-boot.mjs`, `_export-now.mjs`, `_fanout-hooks.mjs`, `_fanout-stubs.mjs`, `_heal-rounds.mjs`, `_initial-load-probe.mjs`), with 1,852 `S.` references (1,431 of them `S.state`, 179 of those assignments in 78 files).

| Field | References in `src/` | Files | What it is | Where it goes |
| --- | --- | --- | --- | --- |
| `S.state` | 438 | 46 | A second handle on the live document. The session stores the document (`document-session.ts`), and the transitions assign the same object to both (`transitions.ts:60-61`). The live-document port reads and assigns `S.state` (`02b-doc-id.js:68`), undo notices a new document by comparing it and records edits by diffing it (`12a-undo.js:740-768`), and 35 lines in 11 files change the document through it directly | L3d makes the session the only holder and blocks writes through `S.state`; L3i converts the reads; L3j converts the tests |
| `S.DESKTOP` | 179 | 24 | The desktop IPC bridge from the preload script, not a flag. The preload script exposes 54 members (`desktop/preload.js:100-336`). The renderer reaches them three ways: 83 references call one of 40 methods by name on `S.DESKTOP` (`readFile`, `writeFile`, `saveFileDialog`, `historyPut`, `openExternal`, `onMenuCommand`, `onDraftFlush` and others); local aliases call the voice, update and blob methods (`20f-desktop.js:222`, `20a-update.js:19`); and `driveDesktopCall` calls the six Google Drive methods by string (`13-hosted.js:1809-1811`). The other 96 references test whether it exists. Tests swap it for a fake at run time (`20f-desktop.js:1008-1018`) and six test files assign it | A typed desktop port in `src/adapters/`, and a "running on desktop" fact in `src/application/` (L3c) |
| `S.serverMode` | 58 | 7 | "Connected to a server" | The connection and document-location owner (L3c) |
| 50 others | 500 | | 19 read by the wiring (L2a); 15 private to the prompter and voice; 6 copies of save, merge, identity and startup state; 10 of per-area UI state | Field by field in L2a, L3b, L3c and L3d |

The original plan did not promise to delete `S`. It said new code never touches it (met), only the document's owner assigns `S.state` (L1), and unused fields go in 4.x (§8). Adam chose to delete it in this plan. Every field is either a second handle on something that already has an owner, or state that belongs to one area, and the steps below move each one there.

## Exit criteria for the plan

All are measured on the closing tree and certified there by `node tools/dep-report.mjs --legacy-metrics --assert tools/legacy-exit.json` (L0), which exits non-zero if any value misses its threshold. Per-PR CI runs the ratchets, not the assertion. Loops are counted on `dep-report`'s graph of every frontend module. "Now" is `324171e`.

| Metric | Now | At close |
| --- | --- | --- |
| Modules in any frontend import loop | 46 | 0 |
| Links between loop modules | 310 | 0 |
| `S` | 53 fields; 1,176 references in `src/`, 1,852 in `src/test/`; 53 importers | `_state.js` deleted: 0 references and 0 importers in `src/` and `src/test/` |
| `S.state` assigners | 3 | 0; the session is the only holder of the document |
| Writes into the document outside a command | 36 direct-write lines, plus any through an alias | 0 lines, and the full browser run passes with the document guard on (`SPLITPAGE_DOCUMENT_GUARD=1`, L3d) |
| Numbered files in `src/js` | 79 | 57 or fewer |
| Lines in numbered files | 38,853 | 32,000 or fewer (−25% against 3.1's 42,504) |
| A new numbered file, a rise in any file's `S.` count, a new direct write into `S.state`, or a new name imported between loop modules | not checked | each fails `npm run check:deps` |
| Displays | refreshed by direct calls | each display in L3e has a test showing that a change made through the session or its owner refreshes it, with the same timing and no direct call |
| Save destinations | wired into the save code by hand | a throwaway destination registered in a test saves through Save, autosave and Save As with no other edit (L3h) |
| The desktop bridge | a global any file can call | one typed port with contract tests; the full desktop smoke passes |
| Typing p50 against `324171e` | | no worse by more than 0.5 ms on either fixture |
| Gate runs | | [Gate](#gate) |

## Steps

Each step lists its PRs. Every code PR gets CI and one independent review, as [review.md](review.md) says, and carries the "Structure" section above. A PR that removes an `S` field converts the tests that use that field in the same PR. "Cloud" is a Claude thread in the project's cloud container. "Codex" is a Codex CLI job run through a Remote Control session on the x64 PC. "PC" is a run on the x64 PC (Windows, Edge, Electron). Each step's exit is local to that step, so it holds whatever else has merged.

Predicted loop size after each step comes from the [loop model](#loop-model), which gives the same figures on `324171e` and `f1f22e7`. Each PR regenerates the prediction on its own base. A PR that misses its prediction does not merge as it stands: either it moves the responsibility that kept the number up, or it amends this table in the same PR, naming the link and the reason. The reviewer checks that.

| After | Modules in the loop | Links inside it |
| --- | --- | --- |
| `324171e` | 46 | 310 |
| L3a rules, helpers and effect ports | 46 | 264 |
| L3b state owners | 35 | 173 |
| L3c connection, document location and desktop | 35 | 167 |
| L3d the document and its edits | 33 | 155 |
| L3e displays and recorders listen | 18 | 57 |
| L3f panels | 14 | 44 |
| L3g navigation | 9 | 28 |
| L3h the document lifecycle | 0 | 0 |

The L3h row is 0 because that step names every one of the 32 names left after L3g, and gives each a destination. L2, L3i, L3j and L4 do not change the loop. They remove `S` and numbered files.

### L0. Stop regrowth and publish the measurements (first; 1 PR; cloud, Sonnet)

`tools/dep-report.mjs` gains four baseline rules, recorded in `tools/dep-baseline.json` like the existing ones:

- `legacy-file`: a numbered file not in the baseline fails; a removed one is pruned.
- `legacy-state-refs`: each file's count of `S.` references, in `src/` and `src/test/`; a rise fails, a fall is pruned to the new value.
- `state-write`: each file's count of direct writes into `S.state` (the appendix pattern); a rise fails.
- `loop-import`: each name one numbered file imports from another; a new one fails. The module-level `cycle-edge` rule misses a new name on an existing link, which is how a new "tell everyone" call would come back.

`--legacy-metrics` prints the exit table's figures as JSON. `--assert <file>` compares them with `tools/legacy-exit.json`, which L0 commits with the "At close" column; it is run on the closing tree only. `--loop-model <steps.json>` runs the appendix model on the current tree. All of these are plain Node, so they run the same in PowerShell, cmd and POSIX shells.

`.github/pull_request_template.md` gains the "Structure" section with the four questions, answered "none" by a PR that moves nothing.

Exit: `tools/test-dep-report.mjs` has fail-first cases for a new numbered file, an added `S.` reference, an added direct write, a new import between numbered files and a missed threshold; `--legacy-metrics` on `324171e` prints the "Now" column; `npm run check:deps` passes with 0 new and 0 resolved.

### L1. One fewer document writer (done: #650, merged 2026-10-16)

`03-sync.js`'s merge adoption goes through the live-document port in `02b-doc-id.js`. `stateAssigners` is 2.

### L2. Move the wiring into `src/bootstrap/` (fixes F2)

**Structure:** startup and mounting live in one typed place instead of six numbered files that read `S`, and the wiring gets its facts from owners, not from the global.

**L2a. The wiring's 19 fields get owners** (3 PRs, by area). Each field moves out of `S` into the module that owns the behaviour, and every reader, tests included, uses that owner's functions:

| PR | Fields | Other readers | Who |
| --- | --- | --- | --- |
| Editor | `dragRowId`, `pendingImageRowId`, `undoApplying`, `untaggedMutedFor`, `lastFocusedRowId`, `writerLastCell`, `lastMergeUndo` | `05f`, `06`, `05h`, `05e`, `00-prelude`, `05-render`, `07`, `20-teleprompter`, `19-writer`, `03-sync`; 29 test references | cloud, Opus (editing hot path, undo) |
| Production and comments | `tagExpanded`, `tagAddingPersonFor`, `productionGroupBy`, `findMatchCase`, `tagRenaming`, `gearGroupBy`, `commentSortMode` | `07`, `08`, `09`, `10`; 7 test references | cloud, Sonnet |
| Views | `prompterSkipShot`, `prompterOpen`, `prompterPlaying`, `voiceFollowActive`, `importModeTouched` | `20-teleprompter`, `00-prelude`, `05s-script-zoom`, `11-import`, `src/legacy/screen-state.ts` | cloud, Sonnet |

The wiring reads `S.state`, `S.dirty`, `S.initialStateReady` and `S.DESKTOP` through ports that already exist: the live-document port, the session's dirty state, the startup's ready signal and the desktop bridge.

Exit per PR: its fields have no `S.` reference in `src/` or `src/test/`, and `legacy-state-refs` falls for every file that read them.

**L2b. Port the files** (2 PRs). `22a-editor-wiring.js` becomes `src/bootstrap/wiring/editor.ts` (cloud, Opus). `22b`–`22f` become `production.ts`, `comments.ts`, `views.ts`, `overlay.ts` and `startup.ts` in the same folder (Codex, Sol xhigh). Strict TypeScript, no behaviour change, slot order unchanged; the evidence is the 294-row remount test and the 14 root-route registrations (13 click slots and the tags-anchor mousedown).

Exit: no `src/js/22*.js`; 0 `S.` references in `src/bootstrap/`; a layer rule forbids `src/bootstrap/` to import `_state.js`, with a fail-first case; 6 numbered files and 1,452 numbered lines removed; the remount test passes 4/4.

The five remaining wiring files now live in `src/bootstrap/wiring/production.ts`, `comments.ts`, `views.ts`, `overlay.ts` and `startup.ts`, alongside `editor.ts`. Bootstrap owns their mount lifetimes and typed feature ports. Startup reads the live document through `liveDocumentPort`, unsaved work through `unsavedFor`, and the desktop bridge through `desktopBridge`; the initial-ready assignment stays with the prelude through `setInitialStateReady`. Server-picker routing goes through `routeServerOpen` in the desktop owner. Bootstrap has no direct dependency on `_state.js`, enforced by the layer rule and its fail-first cases. All 13 click slots and the tags-anchor mousedown keep their order, and the load-order probe retains all 79 targets, including all six typed wiring modules. This port deletes 762 numbered lines and adds 13 lines at the existing prelude and desktop boundaries, a net reduction of 749 numbered lines; the remaining numbered-file count is 70.

### L3. Give every shared job an owner (fixes the core of F1)

**L3a. Rules, helpers and effect ports** (4 PRs; after L0, beside L2a). The appendix's [L3a destinations](#l3a-destinations) list every `rule` and `page-helper` name with where it goes; PR 3 lists the values.

| PR | What moves | Who |
| --- | --- | --- |
| 1 | The `rule` functions: document and people rules to `src/core/`; text, time, file-name and link helpers to `shared/`; the project-file codec to `src/adapters/formats/`. Also `brollCountInRow`, whose only loop call is a name this step moves. `rowSeconds` and `estimatedSeconds` move to L3d instead (see below) | Codex, Sol high |
| 2 | Effects other areas trigger become ports in `src/application/`, implemented by a feature and wired at startup: notices (`showToast`, `showActionToast`), menu items (`setMenuItemLabel`, `setMenuItemReason`) and the clipboard (`copyShareText`). Numbered files reach each through its bridge | cloud, Sonnet |
| 3 | Values. 44 of the 61 are pass-through names, which files import instead from where they are defined, mostly `src/core/`. Of the 17 defined in a loop file: `normalizeServerBase` is an alias of `normalizeServerUrl`, and `MD_IMAGE_PREFIX_RE` goes to `src/adapters/formats/`. The other 15 are state and move with their owners: the 12 storage keys, server defaults and writer size limits (L3b PRs 2 and 6, L3c PR 1), `autoSaveTiming` (L3b PR 1), `liveDocumentPort` (L3d PR 3) and `whilePainting` (L3e PR 1) | Codex, Sol high |
| 4 | `findRowIndex(id)`, which reads `S.state`, becomes `rowIndexOf(doc, id)` in `src/core/document/`, and its 14 callers pass the document they hold | cloud, Sonnet |

View helpers (functions that build markup or adjust an element they are given) stay with the area that draws that view, and are listed with their owning area in the appendix.

`rowSeconds` and `estimatedSeconds` moved from L3a PR 1 to L3d, because they need the live-document port, which L3a does not yet have.

**Structure:** rules depend on nothing; effects are requested through a port, so the code asking for a notice does not import the code that draws it.

**Long term:** a change to a rule (how scene length is counted, how a file name maps to a kind) is one small file and its tests in Node. A new way to show notices replaces one implementation, not 31 imports.

Exit: no numbered file imports a `rule`, `page-helper` or `value` name from another numbered file, apart from those the destination table assigns to a later step; the loop is at or below the table.

**L3b. Each piece of area state gets one owner** (6 PRs; after L2a). The `stateful` functions and `changing` variables that hold area state, and 28 `S` fields, move to owners. The table names the fields; each PR lists its functions and variables by owner, from the loop model on its base. Document data is not area state and goes to L3d; the connection, document location and desktop go to L3c.

| PR | Owner | Fields and names | Who |
| --- | --- | --- | --- |
| 1 | Save status and startup. The copies go: `S.dirty`, `S.editSeq` and `S.saveButtonBusy` duplicate the save bridge's state (`12-dirty-toast.js:49`, `:95`), and readers ask the save coordinator's status instead. `S.initialStateReady` becomes the startup's ready signal. The autosave variables (`autoSaveEnabled`, `autoSaveHalt`, its two timers and `autoSaveTiming`) go to the coordinator's autosave policy in `src/application/save/`, with a timer port | `dirty`, `editSeq`, `saveButtonBusy`, `initialStateReady`; 253 test references | cloud, Opus (saving) |
| 2 | Recovery, in `src/application/recovery/`: the stash, the draft resume and restore flags, and their storage keys | Field `draftServerResume` (8 test references); the variable `draftRestorePending` (`20g-drafts.js`); `readStash`, `clearStash`, `acceptStash`, `RELOAD_GUARD_KEY`, `SNAPSHOT_KEY`, `HISTORY_OLDER_KEY` | cloud, Opus (recovery) |
| 3 | Delete confirmation and production selection: one owner in `src/application/editing/` for "press delete twice to confirm" across rows, tags and comments, with a timer port, and the production selection | Fields `deleteArmId`, `deleteArmTimer`, `tagDeleteArmId`, `tagDeleteArmTimer`, `deleteCommentArmId`, `selectionAnchorKey`; the variables `deleteCommentArmTimer` (`10-comments.js`), `bulkDeleteArmed` and `productionSelection` (`07-production-tags.js`) | Codex, Sol high |
| 4 | Editing selection and focus, in `src/application/editing/selection.ts` | `savedRange`, `savedRangeCell`, and the row and cell selection functions | cloud, Opus (editing hot path) |
| 5 | The prompter and voice: 15 fields that only `20-teleprompter` uses become its own variables, and their start-up values move out of `00-prelude` | `recognition`, `promptWords`, `voiceStarting`, `speakCursor`, `wordCursor`, `voiceSession`, `speakNorms`, `finalTranscript`, `interimTranscript`, `voiceStream`, `voiceRestarts`, `prompterSpeed`, `prompterRAF`, `prompterLastTs`, `speakable` | Codex, Sol high |
| 6 | Preferences, in `src/application/preferences/`: read, write and announce changes, over the storage adapter. Storage keys become private to `src/adapters/storage/`; settings, the comment author's name, the clock setting and the writer's size limits are read through the owner. Also the panel, find, hide-shot, word-count and writer variables | `AUTOSAVE_KEY`, `COMMENT_NAME_KEY`, `TAGGING_HELP_KEY`, `ONBOARD_KEY`, `TOUR_DONE_KEY`, `WRITER_SIZE_MIN`, `WRITER_SIZE_MAX`, `SIDE_PANEL_IDS`, `findOpen`, `hideShotScenes`, `wordCount`, `writerOpen`, `seedCheckPasses` | cloud, Sonnet |

Each function that only calls into one of these owners moves out with it (`personColor`, `personColorsWithMine`, `presenceShown`, `stampRow`, `getEditorName`, `personSwatchesHtml`, `tagFieldOccurrences`).

**Structure:** each piece of area state has one owner and one way to change it, and announces its changes. No file reads another file's variables, and the copies of save state disappear rather than gaining a second owner.

**Long term:** "what can change this?" has one answer. Tests set state up through its owner, and the save status has one source, so the Save button and the dirty marker cannot disagree.

Exit per PR: its fields have no `S.` reference in `src/` or `src/test/`; its `changing` names are not exported from a numbered file; the owner's Node tests cover every change function and its announcement; the loop is at or below the table.

**L3c. The connection, the document's location, and the desktop bridge** (2 PRs; cloud, Opus; after L3a).

1. *Connection and document location.* `_home.js` holds `home`: where the document lives (none, file, import or server) and, for a server document, its connection. Four other files write its fields directly: 9 lines in `12-dirty-toast`, `13-hosted`, `14-export` and `18a-local-merge`, the last two through a reference held across a save. They move to one owner in `src/application/`, reached through a bridge, with every write going through its functions. With it go `S.serverMode`, `S.serverBookmarks`, `S.docIdWrittenOut` (behind `documentIdentityPort` today), `linkTurnedOff`, `serverSessionExpired`, `reviewMode` and `reviewBlocked` (the policy stays pure in `authority.ts`; the notice goes through the L3a port), `joinServer`, `shortHost`, `detectServer`, and the server keys and default (`COLLAB_SERVER_KEY`, `DEFAULT_COLLAB_SERVER`, `SERVER_RESUME_KEY`). 24 test references to `S.serverMode`. Opus, because it is state ingress and touches the save path.
2. *The desktop bridge.* The preload script's surface goes behind one typed desktop port in `src/adapters/desktop/`, and "running on desktop" becomes a fact in `src/application/` that features may read. The port's methods are taken from `desktop/preload.js`, not from a search of the renderer, because the renderer also reaches the bridge through aliases and by string: `driveDesktopCall`'s string dispatch becomes six typed methods (`driveStatus`, `driveSignIn`, `driveSignOut`, `driveList`, `driveDownload`, `driveUpload`). A contract test checks that every member the preload script exposes is either on the port or listed as unused. The run-time swap in `20f-desktop.js:1008-1018` (`__desktopTest.setBackend` and `restoreBackend`) becomes the port's test seam, and the six test files that assign `S.DESKTOP` use it. Preload and IPC work under the project's rules: Opus, with a full desktop smoke on the PC. The smoke calls all six Drive methods on the preload bridge against a fake Google service (`desktop/test/smoke.mjs`, `driveCall`), which covers the IPC side; the renderer's side of Drive is covered by the port's contract tests and `m4-matrix-hosted.test.mjs`.

**Structure:** where the document lives, whether a server is connected and what the desktop shell can do each have one owner and a typed interface, instead of two globals anyone can write and a bridge object anyone can call.

**Long term:** a new kind of document location or a new desktop capability is a change to one owner and its tests. Tests swap the desktop through one seam.

Exit: no file other than the owner writes `home` (appendix grep); 0 references to `S.DESKTOP`, `S.serverMode`, `S.serverBookmarks` and `S.docIdWrittenOut` in `src/` and `src/test/`; the desktop port has a contract test per method and one that covers every member `desktop/preload.js` exposes; the full desktop smoke passes.

**L3d. The document has one holder, and every edit goes through the session** (4 PRs; after L3b).

1. *Test documents go through the session* (Codex, Sol high). A test helper loads a document through the live-document transition, and the 179 test assignments to `S.state` in 78 files use it. No production change.
2. *Document data becomes core queries and session commands* (cloud, Opus). The tag registry, people, b-roll records and comment counters are document fields, not area state: `registryEntry`, `personById`, `productionEntries`, `tagsByCategory`, `brollRecord` and the other readers become core queries that take the document, as `rowIndexOf` does, and `registerProductionTag`, `addRegistryTags`, `findOrAddPerson`, `deletePerson`, `newBrollRecord`, `deleteBrollRecord`, `renameTag`, `bulkTagRows`, `anchorBrollInRows` and the user edits among the direct-write lines (comments, tags, b-roll, find and replace, the target length, the words-per-minute setting, scene clipping) become session commands under milestone 6's commit contract (stamps and reconciliation inside the boundary, one generation step, one undo entry). The save stamps (`rev`, `lastEditedBy`, `lastEditedAt`: `14-export.js:105-107`, `13-hosted.js:1276-1277`) and identity changes (`docId`: `02b-doc-id.js:132`, `14-export.js:262`) are not user edits. They go through a session transaction that records no undo entry, as `amend` does today, called by the save coordinator and the transition API.
3. *The session is the only holder* (cloud, Opus; perf run; after PR 2, so that no direct write is left for the guard to stop). The live-document port reads and replaces the session's document. Undo learns of a new document from the session's adopt and replace announcements instead of comparing `S.state`, and diffs the session's document instead of `S.state` (`12a-undo.js:740-768`), so `readSession` stops calling `followLiveDocument` on every read (`session-bridge.ts:165-204`). `liveDocumentPort` moves from `02b-doc-id.js` to the session bridge, and the bridge gains `currentDocument()`, a plain read of the session's document with no tracking work, which L3i uses. The merge base (`S.baseState`, 25 references and 57 in tests) moves into the session beside the document. `S.state` becomes a read-only getter onto the session's document, so assigning it throws. The getter makes `_state.js` import the session bridge, which stays acyclic only because this PR also removes the bridge's `followLiveDocument` import (`session-bridge.ts` → `undo-adapter.ts` → `12a-undo.js` → `_state.js`); L0's cycle rule fails the PR otherwise. A test-only switch, `SPLITPAGE_DOCUMENT_GUARD=1` (passed like `SPLITPAGE_FREEZE_CACHES`), makes that getter return a read-only view of the document that throws on any write. Views are cached one per raw object, at every depth, so the same object always gives the same view and identity comparisons behave as they do without the guard. Anything handed to the session (command arguments, adopted and merged documents) is unwrapped to its raw object first, and a test checks that no view reaches the session. Commands change the session's own object, not the view. Any write the guard finds that the appendix grep missed, such as one through an alias, becomes a command in this PR. The full browser run passes with the guard on.
4. *Cell editing goes behind a port* (cloud, Opus). `editCell`, `syncFieldFromDom`, `galleryEdit` and `moveRowTo` already run session commands (`05b-cell-edit.js:127`, `05-render.js:824`, `05e-gallery-overlay.js:337-347`, `06-rows.js:157-160`). What moves for them is opening, closing and reading a cell on the page: an editing port in `src/application/editing/`, implemented by `features/editing` and wired at startup. `removeTag` and `normalizeImportedRows` are checked in the same PR: each either already runs a command or becomes one.

**Structure:** the document has one holder, and every change to it takes one route: command, session, then undo, dirty, save and displays. Code that wants to edit a cell asks the editing port instead of importing the render file.

**Long term:** undo, autosave, drafts and collaboration see every edit the same way, so none can skip them, and the guard keeps it that way even in plain JavaScript.

Exit: the `state-write` count is 0 outside the session; `stateAssigners` is 0; the full browser run passes with `SPLITPAGE_DOCUMENT_GUARD=1`; each new command has undo, redo and refused-edit tests; no numbered file imports the PR's names from another numbered file.

**L3e. Displays and recorders listen for changes** (5 PRs; after L3b, L3c and L3d).

38 functions are called after a change to refresh something that depends on it. The session announces every document change (change sets, listeners and refresh jobs since milestone 3), and the L3b and L3c owners announce theirs. Each display subscribes to what it shows, in its own area, and the calls go. Each PR lists every source its displays listen to:

| PR | Displays and recorders | Sources | Who |
| --- | --- | --- | --- |
| 1 | The row render and absorbed render (`render`, `renderAbsorbed`, `renderRow`, `paintRowTimes`), and the paint guard `whilePainting` | Session changes; preferences (author name, clock: `20s-settings.js:330`, `:421`); hide-shot and editing selection | cloud, Opus (editing hot path; perf run) |
| 2 | `markDirty`, `markAbsorbedDirty`, `clearDirty`, `queueAutoSave`, `updateSaveStatus`, `noteSaveStatus`, `setSaveButtons`. The first four are not displays: they record an edit, so the save coordinator and the draft writer listen to the session instead | Session changes; save coordinator status | cloud, Opus (saving) |
| 3 | The file chip, the identity chip, the desktop document state and `mirrorFileChipToWriter` | Connection and document location; save status; session changes | cloud, Sonnet |
| 4 | Panel renders and badges: production, comments, b-roll, history, rundown, presence, writer, gallery overlay, annotator, `updateProductionBadge`, `updateScriptStats`, `syncPanelClass`, `setMyColor` | Session changes; their L3b owners; preferences | Codex, Sol high |
| 5 | Menus: file, collaborate, connect, server | Connection; save status; preferences | Codex, Sol high |

**Structure:** code that changes something no longer knows who shows it or records it. The arrows go from each display to the session or the owner. This is the largest single cut in the loop.

**Long term:** a new display subscribes from its own area and no editing code changes. Today a new display means finding every place that edits and adding a call there, and a missed call shows up as a stale panel.

Exit per PR: no numbered file imports the PR's names from another numbered file; each display has a test that a change made through the session or its owner refreshes it with no direct call; each keeps its timing (synchronous or scheduled, as today) and its number of renders per keystroke, checked by a counted test on the typing path.

**L3f. Panels coordinate through the panels feature** (1 PR; cloud, Sonnet; after L3e). `src/features/panels` provides "open panel X" and "close the side panels" through a port, and each panel registers with it. Panels stop closing each other by name (`closeAllSidePanels`, `openSidePanel`, the five `close…Panel` functions, `closeNewTabPage`), and `applySidePanelWidth` moves into the feature.

**Structure:** panels depend on the panels port, not on each other. **Long term:** a new panel is one registration and no existing panel changes.

Exit: no panel file imports another panel's file; no numbered file imports the 9 names from another numbered file.

**L3g. Opening things goes through the action registry** (2 PRs; Codex, Sol high; after L3f). "Open settings", "go to scene", "open the comment composer", "open the annotator", "open the Google Docs import" and the rest of the 10 become actions run by name through milestone 1's registry, which menus and shortcuts already use.

**Structure:** code that opens a dialog does not import the dialog's file, and the registry is the one list of what the app can do. **Long term:** one way to trigger anything, from code, a menu, a key or the command menu; moving a dialog touches one registration.

Exit: no numbered file imports the 10 names from another numbered file; each is an action with a test that running it opens its view.

**L3h. The document lifecycle gets designed interfaces** (5 PRs; after L3g). What remains is 9 files and 32 names: `03-sync`, `11-import`, `13-hosted`, `14-export`, `18-local-files`, `18a-local-merge`, `20d-formats`, `20f-desktop` and `20g-drafts`. They call each other both ways because each save destination is wired into the save code by hand, and the save code calls back into each one. Milestone 4's save coordinator gains a destination registry, and milestone 4's transition API a source registry:

| PR | What moves | Who |
| --- | --- | --- |
| 1 | The destination interface and registry, with the server destination: `saveDoc`, `saveToServer`, `autoSaveTarget`, `scheduleAutoSave`, `flushAutoSave`, `toggleAutoSave`, `haltAutoSave`, `warnImagesLeftOut` (an outcome the notices port shows) | cloud, Opus |
| 2 | The local-file and desktop destinations: `writeBackToFile`, `deliverFile`, `makeDesktopHandle` (through the L3c desktop port), `checkFileConflict`; `showFileConflict` and `closeFileConflict` become a view of a destination's conflict outcome | cloud, Opus; desktop smoke |
| 3 | Document sources: `openProjectFile`, `adoptProjectState`, `openServerDoc`, `handleImportFile`, `applyMarkdownProject`, `applyStashedWork`, and `pushSnapshot` (the history snapshot taken before a replacement, as a transition hook) | cloud, Opus |
| 4 | Codecs to `src/adapters/formats/`, next to L4c's writers: `buildMarkdownProject`, `buildSplitpageFile`, `parseMarkdownProject`, `parseProjectFileState` | Codex, Sol high |
| 5 | Merge and drafts: `mergeStates` into the session's merge (`apply-merge.ts`), `reportMerge` and `offerFileMerge` as views of a merge outcome, `stashLocalWork`, `flushDraftNow`, `armBrowserServerDraft` and `offerBrowserDraftAfterLinkOff` into the recovery owner | cloud, Opus |

**Structure:** destinations and sources depend on the coordinator and the transition API, and those depend on none of them. It is the pattern milestone 5 used for exporters, which made adding an exporter one provider and one registration.

**Long term:** this finishes a goal the original plan only partly met: "change a storage implementation: its adapter and its tests" (§1). A new destination, such as a cloud drive, is one registration.

Exit: 0 modules in any frontend loop, and `tools/test-dep-report.mjs` fails if one returns; a throwaway test destination saves through Save, autosave and Save As with no other edit; the race matrix with `SPLITPAGE_M4_GATE=1` passes with no case demoted; the desktop smoke passes on PR 2.

**L3i. Reads of the document go through the session** (5 PRs, by area; after L3d).

The remaining `S.state` references in `src/` (about 400 after L3d, all reads) become `currentDocument()`, which L3d PR 3 adds to the session bridge. The guard from L3d stays on in the full browser run, so a read that writes still fails.

| PR | Area | Who |
| --- | --- | --- |
| 1 | Render, rows and editing | cloud, Opus (hot path; perf run) |
| 2 | Rundown, scene status, find and the writer | cloud, Opus (hot path; perf run) |
| 3 | Production, b-roll and comments | Codex, Sol high |
| 4 | Hosted, drafts, history, sync and desktop | Codex, Sol high |
| 5 | The rest of `src/` | Codex, Sol high |

**Structure:** the document has one way to be read, from its one holder. **Long term:** a file that later becomes TypeScript reads a typed, read-only document without a second change.

Exit: 0 `S.state` references in `src/`; the guard run passes.

**L3j. The tests leave `S`, and `S` is deleted** (4 PRs; after L2a, L2b, L3b, L3c and L3i).

1–3. *Tests* (Codex, Sol high). The remaining `S.state` references in `src/test/` (about 1,250 after L3d PR 1) become `currentDocument()` and the L3d test helper, by folder. The harness files (`_app-boot.mjs`, `_fanout-stubs.mjs`, `_heal-rounds.mjs`, `_initial-load-probe.mjs`) set state up through the owners and the session.
4. *Delete `_state.js`* (cloud, Sonnet). `src/js/_state.js` and its import go, and L0's rules gain a fail-first case for any new import of it.

Exit: 0 `S.` references and 0 importers of `_state.js` in `src/` and `src/test/`; the full suite passes; `stateImporters` is 0.

### Why not hand files their imports at startup

An earlier version of L3 replaced each loop file's imports with a list of the same functions handed to it at startup. That cuts every link in the import graph but changes no dependency: `13-hosted` would still call `saveDoc`, still break if `saveDoc` changed, and still need `14-export` to be understood. It also makes code harder to read ("go to definition" on a handed-in function lands on the list, not the function) and adds startup and teardown code, with tests, to 21 files. Handing a module what it needs at startup is good design when what is handed over is a small interface written for the receiver. That is what the bridges in this plan do: each hands out one designed owner, with its own interface and tests, and goes when its last numbered importer does. A copy of a file's old import list is not that.

### L4. Move the leaves and the writers out of `src/js` (F1, lines)

**Structure:** code moves into layer folders whose import rules `check:deps` enforces, and the export writers receive what they need instead of reaching into legacy singletons.

**L4a. The movable leaves** (3 PRs; Codex, Sol high; after L0). No adapter imports a feature or legacy code, and no feature imports another feature:

| PR | Files | Destination |
| --- | --- | --- |
| 1 | `02c-blobs`, `02d-gallery`, `03c-history-idb` | `src/adapters/storage/` |
| 2 | `00p-prefs` (after L3b PR 6) | Split: keys, read and write to `src/adapters/storage/prefs.ts`, under L3b's preferences owner; the formatters to `shared/`; `applyTheme`, `applyTagIcons` and its mount to `src/features/settings/` |
| 3 | `04a-row-motion` with `20i-topbar`, `04b-busy`, `05q-cell-reach`, `20k-phone-bar` | Feature folders; the three mounts become feature mounts called from `src/bootstrap/` |

Exit: the 9 files are gone (−1,422 numbered lines) and `npm run check:deps` reports 0 new.

**L4b. The writers stop importing legacy** (2 PRs; cloud, Opus; after L2b and L4a PR 1). Plan §5 step 2 said the writers' remaining legacy dependencies "become explicit inputs or permitted adapters":

1. An `ExportServices` type in `src/application/export/` holds the decoding the writers need (`cellOf`, `inertBody`, `fromHtml`, `htmlToMarkdown`, `htmlToPlainText`), `productionReaders` and `cacheSeal`. `src/bootstrap/` builds it and passes it to each provider at registration. The built-in registration (`14e-export-formats.js`) moves into the wiring as `src/bootstrap/wiring/exporters.ts`. The cached reader and the frozen-cache behaviour are the same objects as today, so byte output is unchanged.
2. `14b-export-kit.js` splits: its projection helpers take `ExportServices` and move with the writers in L4c; its capture binding stays in `14b` until the session bridge retires (plan §8).

Exit: none of `14c`, `14d`, `15`, `16`, `16b` and `17` imports `src/legacy/` or `02-state.js`; `14e` is gone; the byte goldens, `export-capture-app.test.mjs` and the INV-60 cases pass unchanged, and a changed golden stops the PR; the frozen-cache browser run passes on the PC.

**L4c. Move the writers** (2 PRs; Codex, Sol high): `14c`, `14d`, `16` and `16b`, then `15` and `17`, into `src/adapters/formats/` in strict TypeScript, with the same tests unchanged.

Exit: the 6 files are gone (−4,165 numbered lines). With L4b, L4 removes 16 files and 5,804 lines; with L2, the plan removes 22 files and 7,256 lines.

### L5. Moving the remaining numbered files into feature folders

After L3, the remaining numbered files are in no loop and use no `S`, so each is feature code in the wrong folder. Each moves into `src/features/` when a 4.1 feature next changes it, with L0's ratchets keeping the counts falling, and its bridges retire as it does. Scheduling them as their own work instead is Adam's call.

## Order and parallelism

```
L0 ─┬─► L2a ─┬─► L2b ──► L4b ──► L4c
    │        └─► L3b ─┬─► L3d ─┬─► L3e ──► L3f ──► L3g ──► L3h ─┐
    ├─► L3a ──► L3c ──┘        └─► L3i ─────────────────────────┴─► L3j ──► gate
    └─► L4a (PR 1 before L4b; PR 2 after L3b PR 6)
L1 is done.
```

- L3b follows L2a because both move fields out of `S` in the same files.
- L3c follows L3a because the review notice it uses is L3a's notices port.
- L3d follows L3b and L3c, because some edits change state those steps give an owner.
- L3e follows L3b, L3c and L3d: a display can only listen once every change it shows goes through an owner or the session.
- L3h comes last in the loop work because the save path is where the remaining files meet.
- L3i needs only L3d PR 3. L3j needs every step that removes an `S` field, and L2b, because the wiring files import `_state.js` until they are ported.

**One open PR per shared file.** A PR that would change a `src/js`, `src/bootstrap/` or `src/test/` file another open PR in this plan changes waits for it to merge, then merges the base. The coordinator holds that queue. Only one Codex job runs at a time on the PC.

Size: 51 PRs. 29 are cloud threads (20 of them Opus) and 22 are Codex jobs. The perf runs, the desktop smokes and the gate runs are on the PC.

## Performance

Fixtures: the short (seed, 2 scenes) and long (30 scenes) fixtures of `tools/perf-record.mjs`; typing is 55 keys at 60 ms, key-down to the next frame. Procedure, on the x64 PC with nothing else heavy running:

```
node tools/perf-ab.mjs <base> HEAD --only short,long --rounds 5
```

`perf-ab` alternates the two builds round by round. The figure compared is the median over the rounds of each round's typing p50, per fixture.

- Each hot-path PR (L2a's editor PR, L2b's editor PR, L3b PR 4, L3d PR 3, L3e PR 1, L3i PRs 1 and 2) runs it against its own base before merge. A head p50 more than 0.5 ms above the base on either fixture stops the PR for investigation.
- At the gate, it runs against `324171e`, and the same 0.5 ms bound applies. The 3.1 comparison (`v3.1.0`) is run and recorded for information.

## Platforms

- **Linux:** hosted CI on every PR runs lint, types, `check:deps`, `check:comments`, the build and every discovered Node test, including L0's dependency tests and each owner's tests.
- **Windows:** the x64 PC runs `npm run verify`, the hot-path performance runs, the desktop smokes for L3c and L3h, and the gate's browser and Electron runs.
- **macOS:** the project has no macOS machine, and the plan does not claim macOS coverage. The new tests are Node tests with no platform API; they are recorded as not run on macOS.

## Gate

On the closing tree:
- `npm run verify`;
- the Windows full browser run: plain, with `SPLITPAGE_FREEZE_CACHES=1`, and with `SPLITPAGE_DOCUMENT_GUARD=1`;
- the Electron dev smoke;
- the race matrix with `SPLITPAGE_M4_GATE=1`, with no case demoted;
- the remount test;
- the performance run above;
- `--legacy-metrics --assert tools/legacy-exit.json`;
- an external review.

The x64 packaged check is not required, because the build entry and the packaging inputs do not change. L3c changes what the renderer calls on the preload bridge, not the preload script; if a step changes the preload script or what `build.mjs` bundles from outside `src/`, the check returns.

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

**`S` fields, in the app and in the tests.**

```
grep -ohE '\bS\.[A-Za-z_]+' src/js/*.js src/legacy/*.ts | sort | uniq -c | sort -rn
grep -ohE '\bS\.DESKTOP\.[A-Za-z_]+' src/js/*.js src/legacy/*.ts | wc -l
T=$(grep -rlE '_state\.js' src/test); echo "$T" | wc -l
grep -ohE '\bS\.[A-Za-z_]+' $T | sort | uniq -c | sort -rn
grep -hE '\bS\.state\s*=[^=]' $T | wc -l
```

**Direct writes into `S.state`.** It finds assignments, `delete` and array mutation on a path that starts at `S.state`. It cannot see a write through an alias; L3d's guard run catches those:

```
grep -nE '\bS\.state(\.[A-Za-z_]+|\[[^]]+\])*\s*(=[^=]|\+=|-=)|\bS\.state\.[a-zA-Z_]+\.(push|splice|pop|shift|unshift|sort)\(' src/js/*.js
```

**Writes to `home` outside `_home.js`.**

```
grep -nE '\bhome\.[A-Za-z_]+\s*=[^=]' src/js/*.js | grep -v '^src/js/_home.js'
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

### L3a destinations

| Name | From | To |
| --- | --- | --- |
| `cloneState` | `03-sync` | `src/core/document/` |
| `cleanAuthorName` | `10-comments` | `src/core/` (people) |
| `driveFormatSize`, `formatVideoLength`, `slugify`, `truncateForPreview`, `checksumText` | `13-hosted`, `05-render`, `14-export`, `11-import`, `20b-onboarding` | `shared/` (text) |
| `fileKindFromName`, `mimeForFilename` | `18-local-files` | `shared/` (file names) |
| `embeddableVideo` | `05v-video` | `shared/video-embed.js` |
| `parseLinkFragment`, `tunnelCommand`, `joinErrorText` | `13b-collaborate`, `20e-connect` | `shared/` (links and server text) |
| `parseSplitpageFile` | `20d-formats` | `src/adapters/formats/` |
| `historyNoop` | `03a-history-store` | inlined at its one use |
| `showToast`, `showActionToast` | `12-dirty-toast` | notices port in `src/application/`, implemented by `features/notices` |
| `setMenuItemLabel`, `setMenuItemReason` | `18b-file-menu` | menu-item port in `src/application/`, implemented by `features/file-menu` |
| `copyShareText` | `13-hosted` | clipboard port in `src/application/` |
| `hiddenShotStripHtml` | `01b-hide-shot` | stays in the hide-shot area; `05-render` gets it through a hide-shot view port (L3b PR 6) |
| `galleryBadgeHtml`, `slotPoster` | `05-render` | the gallery area (`features/gallery` with `05e`), reached by `05w` through a gallery view port |
| `tagStatusLampHtml`, `isInsideTagOrLink` | `07-production-tags` | stay in the production area; readers reach them through a production view port |
| `isDraftBox`, `armDeleteButton`, `disarmDeleteButton`, `placeCaretAtTextOffset` | `05d-draft-edit`, `05-render`, `19-writer` | the editing port (L3d PR 4) and the delete-confirmation owner (L3b PR 3) |
| `rowSeconds`, `estimatedSeconds`, `brollCountInRow` | `01-scene-status`, `08c-broll` | `src/core/production/`, with `productionReaders` passed in |
| `findRowIndex` | `03-sync` | `rowIndexOf(doc, id)` in `src/core/document/` |
| `applySidePanelWidth` | `03b-side-panels` | L3f (panels) |
| `updateProductionBadge`, `mirrorFileChipToWriter` | `07-production-tags`, `18-local-files` | L3e (displays) |
| `seedCheckPasses` | `20b-onboarding` | L3b PR 6 (startup and preferences) |
| `joinServer`, `shortHost`, `reviewMode` | `20e-connect`, `13-hosted` | L3c (connection owner) |
| `openGdocModal` | `11-import` | L3g (an action) |
| `checkFileConflict` | `18-local-files` | L3h (the local-file destination) |

### Loop model

It parses every `src/js` file with the TypeScript compiler in `node_modules`. For each name one loop module imports from another, it finds the exported function and follows calls to other functions in the same file, then sorts the name into the six kinds above. A name is `calls-loop` if anything reached calls a loop file; else `stateful` if it uses `S`, a file-level variable, or anything imported from outside `src/core/` and `shared/`; else `page-helper` if it uses a platform global from `dep-report`'s list; else `rule`. A non-function export is `changing` if its file reassigns it and `value` otherwise, and a re-exported name is `value`. It then takes a list of steps, each naming kinds (with exceptions) and function names, marks those names as moved, and prints the loop after each step: a link stays while any name it imports has not moved.

It is a model. A function that adjusts an element it is given, or calls a method on an object it is given, looks like a `rule` to it; the destination table above places those by hand. It assumes a moved name takes nothing back into the loop with it, which each PR checks on its own base. Save it in the repository root as `loop-kinds.mjs` and the step list as `loop-steps.json` (neither is committed; it imports `typescript` from the root `node_modules`, so it fails from any other folder), then run `node loop-kinds.mjs loop-steps.json`. On `324171e` it prints the kind counts above and the table in [Steps](#steps).

```js
import fs from "fs";
import ts from "typescript";
const dir = "src/js/";
const baseline = JSON.parse(fs.readFileSync("tools/dep-baseline.json", "utf8"));
const loop = new Set();
for (const e of [baseline].flat().flatMap((b) => (Array.isArray(b) ? b : Object.values(b).flat()))) {
  if (e.rule === "cycle-edge") { loop.add(e.source.replace(dir, "")); loop.add(e.target.replace(dir, "")); }
}
const pageGlobals = new Set(["window", "document", "navigator", "location", "history", "localStorage", "sessionStorage", "indexedDB", "caches", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "BroadcastChannel", "Worker", "AbortController", "URL", "TextDecoder", "TextEncoder", "Blob", "File", "FileReader", "Image", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "queueMicrotask", "performance", "crypto", "getComputedStyle", "HTMLElement", "Node", "Element"]);
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
      if (imp && id !== "S") {
        if (imp.from.startsWith("./") && loop.has(imp.from.slice(2))) p.loop = true;
        else if (!/(^|\/)(core|shared)\//.test(imp.from)) p.state = true;
      }
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
  for (const [key, kind] of Object.entries(kinds)) {
    const name = key.split("#")[1];
    if ((step.kinds?.includes(kind) && !step.exceptNames?.includes(name)) || step.names?.includes(name)) done.add(key);
  }
  report(step.label);
}
```

`loop-steps.json`, the steps in plan order:

```json
[
  {"label":"L3a rules","kinds":["rule","page-helper","value"],"exceptNames":["reviewMode","AUTOSAVE_KEY","COMMENT_NAME_KEY","TAGGING_HELP_KEY","ONBOARD_KEY","RELOAD_GUARD_KEY","SNAPSHOT_KEY","TOUR_DONE_KEY","HISTORY_OLDER_KEY","WRITER_SIZE_MIN","WRITER_SIZE_MAX","COLLAB_SERVER_KEY","DEFAULT_COLLAB_SERVER","SERVER_RESUME_KEY","joinServer","shortHost","seedCheckPasses","openGdocModal","checkFileConflict","applySidePanelWidth","updateProductionBadge","mirrorFileChipToWriter","liveDocumentPort","whilePainting","autoSaveTiming"],"names":["rowSeconds","estimatedSeconds","brollCountInRow","findRowIndex"]},
  {"label":"L3b state","kinds":["stateful","changing"],"exceptNames":["openTagComposer","syncAnchorResolvedClasses","updateCommentsCount","brollPropsRenamed","registryEntry","addRegistryTags","currentProductionIndex","deletePerson","deleteProductionTagEntry","findOrAddPerson","personById","productionEntries","registerProductionTag","tagsByCategory","tagRecordsPlan","brollRecord","deleteBrollRecord","newBrollRecord","removeBrollProp","linkTurnedOff","serverSessionExpired"],"names":["personColor","personColorsWithMine","presenceShown","stampRow","getEditorName","personSwatchesHtml","tagFieldOccurrences","AUTOSAVE_KEY","COMMENT_NAME_KEY","TAGGING_HELP_KEY","ONBOARD_KEY","RELOAD_GUARD_KEY","SNAPSHOT_KEY","TOUR_DONE_KEY","HISTORY_OLDER_KEY","WRITER_SIZE_MIN","WRITER_SIZE_MAX","seedCheckPasses","autoSaveTiming"]},
  {"label":"L3c connection","names":["reviewMode","reviewBlocked","detectServer","linkTurnedOff","serverSessionExpired","COLLAB_SERVER_KEY","DEFAULT_COLLAB_SERVER","SERVER_RESUME_KEY","joinServer","shortHost"]},
  {"label":"L3d document","names":["editCell","syncFieldFromDom","galleryEdit","moveRowTo","bulkTagRows","removeTag","renameTag","anchorBrollInRows","normalizeImportedRows","openTagComposer","syncAnchorResolvedClasses","updateCommentsCount","brollPropsRenamed","registryEntry","addRegistryTags","currentProductionIndex","deletePerson","deleteProductionTagEntry","findOrAddPerson","personById","productionEntries","registerProductionTag","tagsByCategory","tagRecordsPlan","brollRecord","deleteBrollRecord","newBrollRecord","removeBrollProp","liveDocumentPort"]},
  {"label":"L3e listeners","names":["render","renderAbsorbed","renderRow","paintRowTimes","markDirty","markAbsorbedDirty","clearDirty","updateSaveStatus","noteSaveStatus","setSaveButtons","queueAutoSave","updateFileChip","updateIdentityChip","notifyDesktopDocumentState","updateScriptStats","syncPanelClass","renderProduction","renderComments","renderHistory","renderRundown","renderBrollViews","updateBrollBadge","scheduleBrollRefresh","runBrollRefresh","updateTagBadges","updateGearCount","updateWriterStats","drawWriter","paintWriterDraw","paintPresence","paintRundownPresence","refreshGalleryOverlay","refreshAnnotator","refreshFileMenu","updateCollaborateMenu","updateConnectMenu","updateServerMenu","setMyColor","updateProductionBadge","mirrorFileChipToWriter","whilePainting"]},
  {"label":"L3f panels","names":["closeAllSidePanels","openSidePanel","closeHistoryPanel","closeGearPanel","closeProductionPanel","closeBrollPanel","closeCommentsPanel","closeNewTabPage","applySidePanelWidth"]},
  {"label":"L3g navigation","names":["openServersDialog","openCommentComposer","openAnnotator","openGalleryLink","goToScene","openSettings","toggleFileMenu","maybeAskGuestName","canOpenPrompterInBrowser","openGdocModal"]},
  {"label":"L3h lifecycle","names":["haltAutoSave","pushSnapshot","mergeStates","reportMerge","stashLocalWork","saveDoc","scheduleAutoSave","deliverFile","armBrowserServerDraft","offerBrowserDraftAfterLinkOff","saveToServer","showFileConflict","writeBackToFile","buildMarkdownProject","buildSplitpageFile","makeDesktopHandle","warnImagesLeftOut","offerFileMerge","applyMarkdownProject","parseMarkdownProject","applyStashedWork","closeFileConflict","parseProjectFileState","handleImportFile","autoSaveTarget","flushAutoSave","toggleAutoSave","openProjectFile","openServerDoc","flushDraftNow","adoptProjectState","checkFileConflict"]}
]
```
