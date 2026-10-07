# Session

The as-built description of the `DocumentSession`, its effect scheduler and the command shape, on `4.0-development` after PRs 3.6 (#384), 3.7 (#402), 3.8 (#405) and 3.9 (#414). [Milestone 3](milestone-3.md) is the plan; this file says what the code does today. Where the two differ, a sentence says so, and the section "Known gaps and exceptions" collects them. It names functions and types, not lines.

The code lives in `src/application/session/` (`document-session.ts`, `change-set.ts`, `effects.ts`, `ports.ts`), `src/application/commands/` (`scene-length.ts`, `scene-status.ts`), `src/legacy/session-bridge.ts` and `src/legacy/undo-adapter.ts`.

## 1. Purpose

`createDocumentSession(ports)` returns the one object that owns the live document while the page runs. The app has exactly one, created at module evaluation in `session-bridge.ts`. It owns:

| Owns | As built |
| --- | --- |
| The document | One `ValidatedDocument` or none. It arrives only through the `DocumentEntry` port, which brands it |
| The epoch | A counter that opens a new epoch when a document is adopted or recovered, even for the same document id |
| The generation | A counter of accepted user edits. It never resets, and a new epoch does not clear it |
| Transaction kinds | `TransactionKind`: `edit`, `server`, `reload`, `recovery`, `adopt` |
| Capability | Whether an edit is allowed, asked of the `CapabilityPort` before a command plans |
| Change sets | `ChangeSet`: what a transaction touched, published as a `SessionChange` |
| Selectors | `read(select)` hands a function the live document typed as a deep-readonly `DocumentView`, or `null`; the type is compile-time only. The selector functions themselves (`sceneAt`, `sceneStatus`) live in the command modules, not in `document-session.ts` as the milestone's layout says |

It does not own these yet:

- **Legacy writers that bypass it.** Typing, split, join and cut-paste still write `S.state.rows` themselves and then call `markDirty`, which is `noteSessionEdit()`: an edit of unknown extent, published as a whole-document change set with no reconciliation. Only scene length and scene status are commands.
- **The 14 `S.state` assignment sites** (nine modules). The session learns of a document assigned to `S.state` when 12a's `restart()` reports it, or through a `noteServerUpdate`, `noteRecovery` or `noteReload` call, not at the assignment.
- **Adoption at `trackDocument`.** `render()` in `05-render.js` still calls 12a's `trackDocument()` directly. The session's adoption is a callback from 12a (section 2).
- **Undo and redo replay.** Ctrl+Z and Ctrl+Y call 12a's `undo()` and `redo()` from `21-events.js`. The replay writes `S.state` itself, outside the session. After a step applies, `afterUndoApplied` in `21-events.js` calls `markDirty`, so the session sees it as a legacy whole-document edit (one generation, one effect pass, an `edit` publication), not as an undo.
- **The `S.editSeq` counter.** It increments in the dirty effect on every effect pass, including passes with no generation. The generation and `S.editSeq` therefore diverge after a merge, reload or recovery.

No app module (outside `src/test`) subscribes to the session today (`subscribe` is used by tests), and `liveSession()` in the bridge exists for tests.

## 2. Lifecycle

A document enters through one of four methods. Each calls the `DocumentEntry` port first. In the app that port is `migrateRows` from `02-state.js`, which migrates the object it is given in place and returns it as a `ValidatedDocument`, so the session holds the very object `S.state` holds. `null` and `undefined` skip the port and mean no document. Any other value that is not a plain object (an array, a number, a string or a boolean) is refused before the port, as `isDocumentObject` in `core/migrate.ts` decides: `adopt`, `absorbServer` and `absorbRecovery` then call no port, open no epoch, publish nothing and return the document the session already holds (Adam's decision of 2026-10-07 on #407). The app's entries refuse such a value before they reach the session, each through its own existing "no document" path. If the port throws, nothing in the session has changed.

| Method | Called from | Epoch | Undo port call | Published kind |
| --- | --- | --- | --- | --- |
| `adopt(raw)` | 12a's `restart()` through `watchUndoAdoption` | opens | `adopt` | `adopt` |
| `absorbServer(raw)` | `applyMerge` in `03-sync.js`, through `noteServerUpdate` | kept | `absorbServer` | `server` |
| `absorbRecovery(raw)` | `applyMerge` through `noteRecovery`, when `opts.recovery` is set or the source is `server-resume` | opens | `absorbServer` | `recovery` |
| `absorbReload()` | `loadFileIntoEditor` with `reload`, through `noteReload` | kept | `absorbReload` | `reload` |

All four publish `WHOLE_DOCUMENT`. None advances the generation, records undo or runs the effect pass. Each stores its document, and for adoption and recovery bumps the epoch, only after the undo port returns. 12a can start an adoption of its own inside `adopt` or `absorbServer` (a document swapped in before a render), so the outer call stores last and the session ends holding the outer document. `absorbReload` touches no document: the reload edits `S.state` in place and the session keeps what it held.

How a document reaches `adopt`: 12a's `restart()` calls the `adopted` hook (registered with `configureUndo` by `watchUndoAdoption`) whenever it re-bases undo on a document it was not tracking. That covers `render()`'s `trackDocument()`, a document swapped in before a render, and `absorbRemoteChange` over an untracked document. `resetUndo` re-bases through the same `restart()`, but only tests call it. The undo adapter's own `adopt` calls `trackDocument()` and ignores its argument, which is idempotent because 12a has tracked the document by then.

`runCommand` and `readSession` in the bridge call `followLiveDocument()` (12a's `trackDocument()`) before they run. A document assigned to `S.state` and not yet rendered is therefore adopted before a command writes or a view reads, and when the session already holds `S.state` the call is one identity comparison. This is how a command avoids writing into the previous document.

Recovery that enters by assignment is published as `adopt`, not `recovery`. That covers the three draft restores in `20g-drafts.js`, history restore (`restoreSnapshot` in `03-sync.js`, which goes through `adoptRestoredState`) and importing a file. Labelling them `recovery` would route them through `noteRemoteChange`, which keeps the undo stack, and 12a clears it today. They open an epoch and add no generation or undo entry. Their effects run through `settle`.

`settle(kind)` runs `undo.record` with a whole-document change set and one effect pass tagged with the given kind at the current generation. It does not advance the generation and does not publish. `markAbsorbedDirty(kind)` in `12-dirty-toast.js` is `settle`. Callers: `reportMerge` and the unmerged adopt in `03-sync.js` (the merge's kind), history restore and the three draft restores (`recovery`), and `loadFileIntoEditor` (`reload` or `adopt`).

"No document" is the session holding `null`: before the first adoption, or after an adoption of `null`, which is what 12a's `restart()` reports when `S.state` is empty. `run` then returns `{ kind: "rejected", reason: NO_DOCUMENT }` (`"no document"`) for any command, and selectors receive `null`. Commands are not asked for capability in that state.

Boot recovery of unsaved work (`21-events.js` passes `recovery: true` to `applyStashedWork` in `14-export.js`, which forwards it to `applyMerge` only when there is a stash) goes through the same `noteRecovery`, and is one `recovery` change at epoch 1, generation 0, with no undo entry.

## 3. The command shape

A `Command` has a `name`, `needs` (`"edit"` or `"nothing"`) and `plan(doc)`, which gets a `DocumentView` and returns a `Plan`, a `Refusal`, or `null`. A `Plan` is a `ChangeSet` and an `apply(doc)` function that gets the live `ValidatedDocument`. `session.run(command)` returns a `CommandOutcome`.

The five steps of an accepted command, in order:

1. **Capability.** If `needs` is `"edit"`, `CapabilityPort.edit()` is asked. A refusal ends the command before it plans.
2. **One transaction.** `plan` runs against the live document typed as a read-only `DocumentView`, then `apply` against the live document. If the change set calls for it (`needsReconciliation`), `ReconcilePort.anchors` runs inside the same transaction, after `apply`.
3. **One generation advance.** `generation++`, once per accepted command.
4. **Undo recording.** `UndoPort.record(changes)`, once.
5. **Change set publish.** One effect pass (section 4), then one frozen `SessionChange` (`kind`, `epoch`, `generation`, `changes`) to every listener.

The commit order, as the tests log it, is reconcile, undo record, dirty, draft, save, publish.

### What a change set declares

| Field | Meaning |
| --- | --- |
| `whole` | The command may touch anything. Rollback snapshots the whole document |
| `cells` | `{ rowId, field }` pairs written, stamps included |
| `rowsInserted`, `rowsRemoved` | Row ids |
| `rowsMoved` | Row order changed |
| `runsMoved` | Runs moved between cells, which can change a comment anchor |
| `docFields` | Document-level fields written |
| `derive` | Names of derivations to refresh through the scheduler (`production`, `broll`) |
| `saveNow` | Ask the save effect for an immediate autosave. Default `false` |

`changeSet(parts)` builds a frozen set with defaults; `cellEdit` and `cellTextEdit` build the one-cell cases. `isEmpty` is true when nothing but `derive` and `saveNow` is set, so an empty set is a no-op whatever it derives. Both scene commands declare three cells (the field plus `updatedAt` and `updatedBy`), their derivations and `saveNow`.

### When reconciliation runs

`needsReconciliation` is true when rows are inserted, removed or moved, or `runsMoved` is set. A one-cell edit does not always skip it. `cellTextEdit` compares `commentIds` of the cell before and after: if the ordered ids differ, `runsMoved` is set. The plan said a one-cell edit cannot move a comment anchor. The seeded property in `tests/application/session-anchors.test.ts` showed that holds only while the cell's comment ids are unchanged: a paste that adds an anchor id, or an edit that drops one that also appears in a later cell, moves a comment. Every other one-cell edit skips the document-wide `syncCommentAnchors`, which INV-06 needs. The milestone's 3.6 paragraph still states the old claim.

### Outcomes

| Outcome | When | Effects |
| --- | --- | --- |
| `{ kind: "applied", generation, changes }` | The command committed | The five steps ran |
| `{ kind: "noop" }` | `plan` returned `null`, or the change set `isEmpty` | None |
| `{ kind: "rejected", reason }` | No document (`NO_DOCUMENT`), capability refused (the port's reason), or `plan` returned `{ refused }` | None |
| `{ kind: "failed", error }` | `plan` threw, `apply` threw, or reconciliation threw | None, and the document is restored |

A rejected, no-op or failed command leaves the generation, dirty state, undo stack and publications unchanged. The caller decides what to show. Views rethrow `failed` (`cycleRowStatus` and `setSceneLength` throw `outcome.error`).

### Rollback on a throwing command

`plan` gets the live document typed as `DocumentView`. The compiler, not the runtime, stops it writing, and `runConfined` catches a plan that writes. The rollback point is taken after `plan` returns, so a write made inside `plan` is not undone. If `apply` throws, `rollbackPoint` restores what the change set names, taken before `apply` ran:

- each declared cell, through `keepField(row, field)`;
- each declared document field, through `keepField(doc, key)`;
- the row list (order and membership) when rows are inserted, removed or moved;
- the whole document, serialised and restored in place, for a `whole` change set.

`keepField` stores a JSON copy of the value, whether the key existed and the keys after it. Restoring a deleted key puts it back in place, not at the end: any later key that still exists is deleted and re-added behind it, so a failed command leaves the document byte-identical. Restores run in reverse order. If reconciliation throws, `anchorPoint` puts every comment back (the list and each comment's `rowId` and `field`) and then the apply rollback runs. The rollback covers only what the change set declares: a command that writes elsewhere and then throws leaves that write behind. `runConfined` (section 7) is how tests keep a command honest, because widening the rollback to the whole document would be document-wide work per keystroke (INV-06).

### Review-mode refusal

The bridge supplies `CapabilityPort.edit` from `12-dirty-toast.js`: `reviewMode()` gives `{ allowed: false, reason: REVIEW_ONLY }`, where `REVIEW_ONLY` is `"review"`. The session returns `rejected` with that reason. There is no toast port: the session does not know about toasts. The view maps the reason to wording and calls `showToast` with `"warn"`:

- `cycleRowStatus` (`01-scene-status.js`) shows "This is a review copy ..." for status (D8) when the outcome is `rejected` with `REVIEW_ONLY`;
- `setSceneLength` (`05r-read-time.js`) does the same for length (D9);
- opening the length editor is not a command, so `openReadTimeEditor` shows D9's toast from its own `reviewMode()` check. The two refusals share the predicate and the wording;
- the visible status lamp in a review copy has no `data-action`, so `onRootClick` in `21-events.js` routes a click on it to `cycleRowStatus`, and the command's refusal shows the toast. A forced or stale `cycle-status` button is still refused by the click guard with "Viewing only", and `REVIEW_SAFE_ACTIONS` is unchanged (Adam's decision (a) on #414).

The capability check runs before planning, so in review mode a no-op or a scene that is gone also shows the toast.

### Legacy edits

`noteEdit(changes?)` is the entry for a legacy edit. It runs steps 3 to 5 with `WHOLE_DOCUMENT` (or the given set), with no plan, no apply and no reconciliation. `markDirty` is `noteSessionEdit()`, which calls it.

## 4. The effect scheduler

`createEffectScheduler(effects, timers, timing)` is the only thing that turns a change set into side effects. `EffectPort` has four members: `dirty`, `draft`, `save`, `refresh`. A pass (`scheduler.pass(change)`) calls `dirty`, `draft` and `save` in that order with the `SessionChange`, then requests a refresh for each name in `changes.derive`. The milestone also lists a history effect. There is none in the `EffectPort`: undo is recorded earlier, through the `UndoPort`, in step 4.

What each effect does in the app (all handed in by `12-dirty-toast.js` through `provideSessionEffects` at module evaluation):

| Effect | Does |
| --- | --- |
| `dirty` | `S.dirty = true`, `S.editSeq++`, and records the editor's colour unless in review mode |
| `draft` | `noteDraftChange()` (20g) |
| `save` | Sets the save buttons to "Save •" unless a save is running, calls `scheduleAutoSave()`, marks the imported file's home dirty and updates the file chip (or the chip alone on a server document), and calls `queueAutoSave()` last when the change set has `saveNow` |
| `refresh` | `runIdleRefresh` in `07-production-tags.js`, handed in through `provideRefreshRunner` |

`S.editSeq` rises once per pass, so one command, one `markDirty`, and one `settle` each raise it once (`src/test/session-bridge-app.test.mjs` counts it for `markDirty` and `settle`, `src/test/scene-effects-app.test.mjs` for the two commands; browser suites 185 and 187 check that each such edit autosaves).

### Coalescing

- **Refresh jobs.** `refresh(job)` adds the name to a set and restarts a single timer. The wait is `max(0, min(idleMs, since + maxMs - now))`, where `since` is the time of the first request of the window. `REFRESH_TIMING` is 180 ms idle and 1,000 ms maximum. When the timer fires the set is swapped for an empty one and handed to `effects.refresh` once. Typing a burst of change sets therefore runs each derivation once, 180 ms after the last, and steady typing at most once a second. `requestRefresh(job)` in the bridge is the same call for legacy code: 07's `scheduleIdleRefresh` (names `production`, `untagged`), 08c's `scheduleBrollRefresh` (`broll`) and 19's Writer stats (`writerStats`) all arrive here.
- **The refresh runner.** `runIdleRefresh` returns if there is no document, counts `idleFlushes`, and runs the jobs in a fixed order: `production` (`refreshProductionNow`), `writerStats`, `untagged`, `broll` (`runBrollRefresh`: anchor, badge, views). The `broll` job still repairs on read (#325).
- **Autosave.** `scheduleAutoSave` in `14-export.js` restarts an idle timer on every call (2,000 ms for a file, 5,000 ms for the server) and starts a maximum timer of 15,000 ms once. Either timer calls `queueAutoSave` if the document is still dirty. `queueAutoSave` clears both timers, saves, and if a save is in flight records that another is wanted. `saveNow` skips the debounce.
- **The hide-shot grace.** The 1,400 ms grace that keeps a just-shot scene visible when shot scenes are hidden lives in `01b-hide-shot.js` as view state, not in the `EffectPort`. `cycleRowStatus` reads the status through the `sceneStatus` selector before and after the command, and the pure `shotGrace(before, after)` says arm, clear or nothing. It runs after the effects and before the repaint. The milestone said the grace becomes an effect; it is driven by the applied outcome instead, because a session subscriber would also fire for undo, merges and later commands that never armed it.

### The rule

A command never fans out by hand. It declares `derive` and `saveNow` and the scheduler does the rest. The view that called it repaints only (`renderRow`, falling back to `render`, then `updateScriptStats`); the length editor's close, not the command, puts focus back on the button. It does not call `markDirty`, the refresh scheduler or `queueAutoSave`.

## 5. Ports

All port types are in `ports.ts`. `SessionPorts` in `document-session.ts` bundles them for `createDocumentSession`.

| Type | Meaning | Implemented by |
| --- | --- | --- |
| `DocumentEntry` | `(raw) => ValidatedDocument` | `session-bridge.ts` (`migrateRows` of `02-state.js`); fakes (`migrateRows` from `src/core/migrate.ts` with `fakeMigration` ports, or a `hooks.entry`) |
| `UndoPort` | `adopt`, `record`, `absorbServer`, `absorbReload` | `undo-adapter.ts` (`createUndoAdapter`); fakes log the call |
| `EffectPort` | `dirty`, `draft`, `save`, `refresh` | `session-bridge.ts`, which forwards to the functions that `12-dirty-toast.js` (dirty, draft, save) and `07-production-tags.js` (refresh) hand in; fakes log dirty, draft and save with the generation and refresh without it |
| `Capability`, `CapabilityPort` | `edit()` gives `{ allowed: true }` or `{ allowed: false, reason }` | `session-bridge.ts`, with the check handed in by `12-dirty-toast.js` (`reviewMode()`); the fake's `deny(reason)` |
| `ReconcilePort` | `anchors(doc)` returns the count moved | `session-bridge.ts` (`syncCommentAnchors` from `core/text/anchors.ts` with the legacy `cellOf`); fakes log `reconcile` and call an optional hook |
| `TimerPort` | `now`, `start`, `stop` | `session-bridge.ts` (`Date.now`, `setTimeout`, `clearTimeout`); `fakeClock` |
| `Clock`, `IdSource` | Re-exported from `core/document/ports.ts` | `systemClock` from `adapters/identity/ids.ts` in the bridge; fake clocks in tests |
| `EditorPort`, `StampPorts` | The editor's name; the clock and editor together, for row stamps | `sessionStamps` in the bridge: `systemClock` and the editor name that `03-sync.js` hands in (`getEditorName`, default "Anonymous"); fakes in the command tests |

The bridge imports nothing in the runtime cycle. The cycle's modules hand their functions in at module evaluation (`provideSessionEffects`, `provideRefreshRunner`), not in `__init` as the milestone said, because unit tests import `12-dirty-toast.js` and `07-production-tags.js` alone and `markDirty` must still mark the document dirty. Until they do, the bridge's defaults do nothing and allow edits.

The bridge's other exports: `runCommand`, `readSession`, `REVIEW_ONLY`, `sessionStamps`, `noteSessionEdit`, `noteServerUpdate`, `noteRecovery`, `noteReload`, `noteAbsorbedDirty`, `requestRefresh`, `liveSession`.

## 6. The undo adapter

`createUndoAdapter()` is a four-method `UndoPort` over `12a-undo.js`:

| Port call | 12a call |
| --- | --- |
| `adopt` | `trackDocument()` |
| `record` | `noteEdit()` (the change set is ignored; 12a diffs) |
| `absorbServer` | `noteRemoteChange(doc)` |
| `absorbReload` | `absorbRemoteChange()` |

Two more adapter exports: `watchUndoAdoption`, which registers the `adopted` hook through `configureUndo`, and `followLiveDocument`, which is `trackDocument()`.

12a keeps everything else, as it was:

- **Diffing.** `noteEdit` queues a microtask `flushEdits`, which runs `diffStates` against a base clone and records the steps that are not cosmetic. Two clicks inside one microtask fold into one entry.
- **Coalescing.** One-cell typing in the same cell within `COALESCE_MS` (1,000 ms) merges into the last entry.
- **The limit.** `MAX_ENTRIES` is 200; the oldest entry is dropped first.
- **`forget`.** A server update or reload forgets the entries that touch what `changedBetween` reports as changed, which `noteRemoteChange` and `absorbRemoteChange` compute.
- **`foldIntoEdit`.** It is not reachable through the adapter. No `UndoPort` operation folds, and its one caller (`05v-video.js`) still calls 12a directly.
- **Inversion and replay.** `undo()` and `redo()` run `history.undo` or `history.redo` on `S.state`, applying steps with `applyStepsLive`.

Replay and owner re-pointing (#402, 3.7): when a live `people`, `productionTags` or `brollShots` list no longer matches a step's `before`, `applyStepsLive` merges that list. It now resolves the document-field steps after the loop, people first. If the people list was merged, it re-points owners in `productionTags` and `brollShots` from each folded id to the person kept, with `personIdRemap` and `repointOwners` from `core/merge/lists.ts`, after the whole plan has been applied. A list is replaced by a re-pointed copy only when something changed. The tag and shot merges also get `personSurvives(sides, peopleAfterReplay)`, judged against the people the replay leaves, so an owner that did not survive gives way to the other side's live owner. Refusals, row steps and non-list fields are unchanged. The adapter file itself did not change for this: the replay is in 12a.

Outside the adapter: the replay path above (it reaches the session only afterwards, as `afterUndoApplied`'s `markDirty`); `foldIntoEdit`; comment and reply draft undo (INV-55), which is untouched; the `undo()`/`redo()` calls from `21-events.js`; and 12a's own `restart()`, which is how the session learns of adoption.

## 7. Testing a command

`tests/application/session-fakes.ts` holds the harness.

- **`fakeClock()`** is a `TimerPort` with a clock that starts at 1,000. `advance(ms)` runs due timers in time order, setting `now` to each timer's time. `stall(ms)` moves `now` without running timers, which tests the maximum window. `armed()` counts pending timers.
- **`harness(timing?, hooks?)`** builds a real `DocumentSession` over fake ports and returns `session`, `log`, `published`, `refreshes`, `clock` and `deny(reason | null)`. The log is an ordered list of strings (`entry`, `undo.adopt:<title>`, `undo.server:<title>`, `undo.reload`, `undo.record`, `reconcile`, `dirty:<generation>`, `draft:<generation>`, `save:<generation>`, `refresh`, `publish:<kind>`), which is what pins the commit order. Hooks: `beforeUndo` (to start an adoption inside an undo call), `reconcile` and `entry`.
- **`rawScript(title)`** gives a small raw document with a comment anchor.
- **`runConfined(session, command)`** snapshots the document as JSON, runs the command, snapshots again and calls `writesOutside` with the applied outcome's change set, or with `NO_CHANGES` for any other outcome. It throws, naming the command, the outcome kind and each place, if the command wrote outside what it declared. A `noop`, `rejected` or `failed` command therefore must change nothing at all, which also catches an incomplete rollback. `writesOutside` checks undeclared document fields, undeclared row fields, inserted and removed rows, row order, and comments (their `rowId` and `field` are ignored when the set reconciles). Every command's tests from 3.8 on run through it, including a command with a stamp port that throws.

What fails a test: an undeclared write (applied or thrown), a generation, effect, publication or refresh that appears for a no-op, refusal or failure, and a document that is not byte-identical after a rollback. The fake clock itself fails on nothing.

The application tests (`document-session.test.ts`, `session-effects.test.ts`, `scene-length.test.ts`, `scene-status.test.ts`, `entry-fuzz.test.ts`) use these fakes. `session-anchors.test.ts` checks `cellTextEdit` and `needsReconciliation` against `syncCommentAnchors` directly, without the harness. `src/test/undo-adapter-differential.test.mjs` runs the real adapter against 12a over seeded sequences.

View-level refusals need the booted app, because the toast and the click routing live in the views. `src/test/_app-boot.mjs` (`bootApp`, `closeApp`) loads the page and `_entry.js` under jsdom, records every `S.state` assignment in `seen`, and `closeApp` clears the timers and channels it tracked. `scene-effects-app.test.mjs` boots once, switches the session with `window.__hostedTest.setSession({ role: "review", docId })`, calls `cycleRowStatus` or `setSceneLength` or sends real click events on the lamp or the length button, and asserts exactly one `warn` toast with the right text and that the document, `S.editSeq`, dirty state, generation (read through `liveSession()`) and undo stack are unchanged. Browser suite `43-review-mode.txt` covers the same in a real browser, including the forced-button case that the click guard refuses.

## 8. Known gaps and exceptions

| Gap or exception | Where it stands |
| --- | --- |
| Typing, split, join and cut-paste still call `markDirty` (a whole-document change set, no reconciliation) | 3.12 to 3.14 |
| The 14 `S.state` assignment sites and the legacy writers that bypass the session | Milestone 4's transition API (milestone-3.md, Risks) |
| Ctrl+Z and Ctrl+Y replay in 12a, outside the session | No M3 PR moves it |
| Recovery by assignment (draft restores, history restore, file import) is published as `adopt`, not `recovery`, so it opens an epoch with no generation or undo entry (INV-53, E4) | Accepted by the coordinator; recorded in 3.15 |
| Rollback covers only the declared change set | By design (INV-06); `runConfined` is the guard |
| A one-cell edit can move an anchor when its comment ids change, so `cellTextEdit` sets `runsMoved` then | Correction of the plan's claim, from #384 |
| `S.editSeq` and the generation diverge after a merge, reload or recovery | By design (INV-53) |
| `applyMerge` migrates `theirs` before `mergeStates` (#417), and refuses a `theirs` or `mine` that is no document. The session still migrates the merged result as it enters, which is redundant when `mergeStates` already migrated it (measured at a median 23.6 ms on the long demo, in #384) | #415 (#304); the doc-row corrections stay with 3.15 |
| The server still stores a `state` that is an array; every client entry refuses it as no document | Server-side refusal is its own PR (Adam's decision of 2026-10-07 on #417) |
| A render that throws after a merge or adoption half-applies it | #418 |
| Undo or redo of an owner assignment after a merge folds the owner keeps the dropped id | #391 |
| The replay counts a live id as alive when `step.after` holds a person with the same name, though nothing re-points it | Accepted in #402 |
| The `broll` refresh still repairs on read | #325, milestone 6 |
| Two review refusals are not one path: the status lamp refuses through the command's `REVIEW_ONLY`, the length editor through the view's `reviewMode()` check, since opening it is not a command. A forced `cycle-status` button gets the click guard's "Viewing only" toast | Adam's decisions of 2026-10-07 on #414 |
| `cycleRowStatus` with no document does nothing; it used to throw | Unreachable from the page |
| The hide-shot grace is view state driven by the applied outcome, not an effect | By design (#414). The runtime cycle has 413 edges, not the planned 412, because 01 still imports `12-dirty-toast.js` for the toast |
| Effects and refresh functions are handed in at module evaluation, not `__init`; adoption hooks into 12a's `restart()`, not only `render()`'s `trackDocument()` | Differences from milestone-3.md's 3.6 wording, kept for the reasons in sections 2 and 5 |
| Media cells cannot be expressed as runs for the later typing command | Milestone 6 |
