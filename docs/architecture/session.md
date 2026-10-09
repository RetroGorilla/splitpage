# Session

The as-built description of the `DocumentSession`, its effect scheduler and the command shape, on `4.0-development` after PRs 3.6 (#384), 3.7 (#402), 3.8 (#405), 3.9 (#414), 3.12 (#427), 3.13 (#447) and 3.14 (#455), with #448 (the composition undo fix) merged after them. [Milestone 3](milestone-3.md) is the plan; this file says what the code does today. Where the two differ, a sentence says so, and the section "Known gaps and exceptions" collects them. It names functions and types, not lines.

The code lives in `src/application/session/` (`document-session.ts`, `change-set.ts`, `effects.ts`, `ports.ts`), `src/application/commands/` (`scene-length.ts`, `scene-status.ts`, `cell-text.ts`, `split-join.ts`, `clipboard.ts`), `src/legacy/session-bridge.ts` and `src/legacy/undo-adapter.ts`.

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
| Selectors | `read(select)` hands a function the live document typed as a deep-readonly `DocumentView`, or `null`; the type is compile-time only. The selector functions themselves (`sceneAt`, `sceneStatus`, `cellHtml`, `bothScenesHaveVisual`) live in the command modules, not in `document-session.ts` as the milestone's layout says |

It does not own these yet:

- **Legacy writers that bypass it.** Seven edits are commands: scene length, scene status, typing, split, join, cut and paste. Every other writer still writes `S.state` itself and then calls `markDirty`, which is `noteSessionEdit()`: an edit of unknown extent, published as a whole-document change set with no reconciliation. Among them are `editCell` in `05b-cell-edit.js` (formatting, shortcuts, tags, b-roll keys, Enter: #452), the scene paste and drop in `05g-scene-clip.js` (D10, out of M3: it still uses `recordPastedBroll`), adding, deleting and moving scenes, the panels, and find and replace.
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
| `absorbReload(content)` | `loadFileIntoEditor` with `reload`, through `noteReload({ title, rows })` | kept | `absorbReload` | `reload` |

All four publish `WHOLE_DOCUMENT`. None advances the generation, records undo or runs the effect pass. Adoption, `absorbServer` and recovery each store their document, and adoption and recovery bump the epoch, only after the undo port returns. 12a can start an adoption of its own inside `adopt` or `absorbServer` (a document swapped in before a render), so the outer call stores last and the session ends holding the outer document. `absorbReload(content)` stores no document. It migrates the file's title and scenes over a JSON copy of the held document through the session's entry port, then writes the result back into the held document in place, so `S.state` keeps its identity. Only after that write does it tell the undo port, and it returns `null` without doing anything when the session holds no document.

How a document reaches `adopt`: 12a's `restart()` calls the `adopted` hook (registered with `configureUndo` by `watchUndoAdoption`) whenever it re-bases undo on a document it was not tracking. That covers `render()`'s `trackDocument()`, a document swapped in before a render, and `absorbRemoteChange` over an untracked document. `resetUndo` re-bases through the same `restart()`, but only tests call it. The undo adapter's own `adopt` calls `trackDocument()` and ignores its argument, which is idempotent because 12a has tracked the document by then.

`runCommand`, `readSession` and `noteReload` in the bridge call `followLiveDocument()` (12a's `trackDocument()`) before they run. A document assigned to `S.state` and not yet rendered is therefore adopted before a command writes, a view reads or a reload writes, and when the session already holds `S.state` the call is one identity comparison. This is how a command avoids writing into the previous document.

Recovery that enters by assignment is published as `adopt`, not `recovery`. That covers the three draft restores in `20g-drafts.js`, history restore (`restoreSnapshot` in `03-sync.js`, which goes through `adoptRestoredState`) and importing a file. Labelling them `recovery` would route them through `noteRemoteChange`, which keeps the undo stack, and 12a clears it today. They open an epoch and add no generation or undo entry. Their effects run through `settle`.

`settle(kind)` runs `undo.record` with a whole-document change set and one effect pass tagged with the given kind at the current generation. It does not advance the generation and does not publish. `markAbsorbedDirty(kind)` in `12-dirty-toast.js` is `settle`. Callers: `reportMerge` and the unmerged adopt in `03-sync.js` (the merge's kind), history restore and the three draft restores (`recovery`), and `loadFileIntoEditor` (`reload` or `adopt`).

"No document" is the session holding `null`: before the first adoption, or after an adoption of `null`, which is what 12a's `restart()` reports when `S.state` is empty. `run` then returns `{ kind: "rejected", reason: NO_DOCUMENT }` (`"no document"`) for any command, and selectors receive `null`. Commands are not asked for capability in that state.

Boot recovery of unsaved work (`21-events.js` passes `recovery: true` to `applyStashedWork` in `14-export.js`, which forwards it to `applyMerge` only when there is a stash) goes through the same `noteRecovery`, and is one `recovery` change at epoch 1, generation 0, with no undo entry.

## 3. The command shape

A `Command` has a `name`, `needs` (`"edit"` or `"nothing"`) and `plan(doc, capability)`, which gets a `DocumentView` and the session's `CapabilityPort` and returns a `Plan`, a `Refusal`, or `null`. A `"nothing"` command can ask the port itself to refuse part of what it does (the typing command does, below). A `Plan` is a `ChangeSet` and an `apply(doc)` function that gets the live `ValidatedDocument`. `session.run(command)` returns a `CommandOutcome`.

The five steps of an accepted command, in order:

1. **Capability.** If `needs` is `"edit"`, `CapabilityPort.edit()` is asked. A refusal ends the command before it plans. Either way the port is handed to `plan`, and a refusal the plan returns from it is an ordinary `{ refused }`.
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

`needsReconciliation` is true when rows are inserted, removed or moved, or `runsMoved` is set. A one-cell edit does not always skip it. The plan said a one-cell edit cannot move a comment anchor. The seeded property in `tests/application/session-anchors.test.ts` showed that holds only while the cell's comment ids are unchanged: a paste that adds an anchor id, or an edit that drops one that also appears in a later cell, moves a comment. Every other one-cell edit skips the document-wide `syncCommentAnchors`, which INV-06 needs. Who sets `runsMoved`:

- **Typing.** `cellTextCommand` compares the ordered comment ids of the stored cell and the new one, and sets it when they differ. It decodes a side only when its HTML holds a `cmt-anchor` (`idsInHtml`), so a plain keystroke decodes nothing extra. `cellTextEdit` in `change-set.ts` is the same comparison as a helper over two cells; the app never calls it, and `session-anchors.test.ts` checks it against `syncCommentAnchors`.
- **Paste.** `pasteCommand` sets it when the paste is a cut's own (`fromCut`) and carries comment ids. A paste that is not from a cut declares no moved runs, even over a commented range.
- **Cut.** `cutCommand` never sets it. A cut leaves a comment where it is until its words land again.
- **Split and join.** Neither sets it. They insert or remove a row, so `rowsInserted` or `rowsRemoved` triggers the reconciliation, in the same transaction and undo entry.

The milestone's 3.6 paragraph carries the old claim with a correction note.

### Outcomes

| Outcome | When | Effects |
| --- | --- | --- |
| `{ kind: "applied", generation, changes }` | The command committed | The five steps ran |
| `{ kind: "noop" }` | `plan` returned `null`, or the change set `isEmpty` | None |
| `{ kind: "rejected", reason }` | No document (`NO_DOCUMENT`), capability refused (the port's reason), or `plan` returned `{ refused }` | None |
| `{ kind: "failed", error }` | `plan` threw, `apply` threw, or reconciliation threw | None, and the document is restored |

A rejected, no-op or failed command leaves the generation, dirty state, undo stack and publications unchanged. The caller decides what to show. Views rethrow `failed`: `cycleRowStatus`, `setSceneLength`, `syncFieldFromDom`, `splitRowFieldCore`, `mergeWriterRows`, `cutSelection` and `pasteIntoCell` throw `outcome.error`.

### Rollback on a throwing command

`plan` gets the live document typed as `DocumentView`. The compiler, not the runtime, stops it writing, and `runConfined` catches a plan that writes outside the declared change set; a plan that writes a declared field is not caught today (#480). The rollback point is taken after `plan` returns, so a write made inside `plan` is not undone. If `apply` throws, `rollbackPoint` restores what the change set names, taken before `apply` ran:

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
- the visible status lamp in a review copy has no `data-action`, so `onRootClick` in `21-events.js` routes a click on it to `cycleRowStatus`, and the command's refusal shows the toast. A forced or stale `cycle-status` button is still refused by the click guard with "Viewing only", and `REVIEW_SAFE_ACTIONS` is unchanged (Adam's decision (a) on #414);
- the Writer refuses every edit in review mode with the shared "Viewing only" toast, one per two-second burst: typing, paste, cut, Enter, Backspace and Delete, the format buttons and chords, undo and redo, and the title. A capture listener on `#writer` in `19-writer.js` cancels the event before `21-events.js` sees it, asking `editAllowed()` (the bridge's `given.edit()`, live). Split and join are `needs: "edit"` as well, so a refusal that gets past the listener is `rejected` with `REVIEW_ONLY`. The listener only stops the DOM change early and shows the toast; what keeps the model unchanged is the typing command, which refuses any change to a cell's text or formatting without edit capability (see the typing bullet below). A composition `input` cannot be cancelled, so a refused `input` redraws the Writer and gives the title back from the model, to put the screen back. The redraw removes the focused paragraph, and Chromium fires `focusout` on it while it is still connected; since #477 that `focusout` syncs nothing, because it comes during a paint (see the typing bullet below). Both title inputs (`#doc-title` and `#writer-title`, `takeTitle` in `21-events.js`) write `S.state.title` only when `editAllowed()`, and otherwise put the model's title back.

For a `needs: "edit"` command the capability check runs before planning, so in review mode a no-op or a scene that is gone also shows the toast. The typing command asks only after its own no-op and missing-scene checks, so those stay `noop` in review mode.

### The text commands

Typing, split, join, paste and cut came in with 3.12 to 3.14. Each view decides what the user asked (selection, the DOM cut of a media cell, a refusal toast), then runs one command and repaints. No view stamps a row, reconciles anchors or calls `markDirty` for them. All five commands take their stamp and cell-decoding ports from `sessionTextPorts` (`CellTextPorts`: the clock, the editor and `cells`, the legacy `cellOf`). Join adds `plainText` (`JoinPorts`), and paste adds `ids` and `brollSeed` (`ClipboardPorts`).

| Command (`name`) | `needs` | Plan returns `null`, or refuses, when | Declares |
| --- | --- | --- | --- |
| `cellTextCommand` (`set-cell-text`) | `nothing` | The scene is gone, or the stored string already equals the new one. Without edit capability it refuses (the port's reason) any change that is not anchor-only | The field, `updatedAt`, `updatedBy`; `derive` `production` and `broll`; `runsMoved` when the cell's comment ids change |
| `splitSceneCommand` (`split-scene`) | `edit` | The field is not `visualText` or `audioText`, or the scene is gone | The field and the two stamps; `rowsInserted` with the new scene's id |
| `joinScenesCommand` (`join-scenes`) | `edit` | Either scene is missing. Two scenes that both have a visual are refused (`both scenes have a visual`) | On the earlier scene: `audioText` and the two stamps, plus the seven visual cells when the later scene's visual is taken, plus `status` when the later status ranks higher; `rowsRemoved` with the later scene |
| `pasteCommand` (`paste-into-cell`) | `edit` | The scene is gone, or the paste changes no text, attaches nothing and records no shot | The field when its text changes, the gallery fields when something attaches, the two stamps; `docFields` `brollShots` when a pasted key gets a record; `derive` `production` and `broll`; `runsMoved` for a cut's own comments |
| `cutCommand` (`cut-from-cell`) | `edit` | The range is empty, the scene is gone, or the deletion changes nothing | The field and the two stamps; `derive` `production` and `broll`; never `runsMoved` |

None of the five sets `saveNow`: they save through the ordinary debounce. Only split and join carry no `derive`.

- **Typing.** `cellTextCommand` takes a `CellText`: `CellRuns` (`cellRuns(runs)`, stored as `toHtml(runs)`) or `SanitisedMediaHtml` (`sanitisedMediaHtml(html)`, stored as given). The second is the named exception for a cell holding a picture or a video card, which cannot be expressed as runs (INV-10, until milestone 6). Nothing in the type checks that the HTML was sanitised; its one caller sanitises first. `needs` is `"nothing"` on purpose: a reviewer anchoring a comment wraps the words in the DOM and `syncFieldFromDom` stores the anchor through this command, so an `edit` capability would break reviewer comments. Instead the plan asks the capability port itself, after the no-op check: without edit capability it refuses every change except an anchor-only one (#450). Anchor-only means the new value is `CellRuns`, the stored value is a string with no picture or video card, the stored cell decodes to runs whose `toHtml` differs from the new one, and both sides give the same `toHtml` once every `cmt` mark is dropped and the runs normalised: the same text, formatting, tags, links, directions, cues and b-roll keys, with only comment anchors added, moved or removed. A media cell, a field the scene does not have yet, and a stored form that changes with no anchor change are refused. Every `syncFieldFromDom` call, from the grid or the Writer and from any event (input, focusout, close, a split or tag that syncs first), goes through this command, so the refusal does not depend on which event reached it. `syncFieldFromDom` (`05-render.js`) returns for a detached cell or while `S.undoApplying`, strips U+200B, passes the HTML through `storedHtmlFromDom`, picks the variant, runs the command, rethrows `failed`, and then calls `noteFieldPainted`. A paint never syncs (#477): `render`, `renderRow` and `renderWriter` run inside `whilePainting` (`05-render.js`), and `onRootFocusOut` (`21-events.js`) returns while `paintingScreen()` is true, so the `focusout` a paint causes, by replacing a focused cell or moving the focus, cannot write the cell's old DOM over the document the paint is drawing. That `focusout` also skips the sanitise and the b-roll anchoring. The scene-length editor and the b-roll panel's note, reference and location boxes save typing only when they lose focus, so a paint's own blur must neither lose that typing nor write a stale box over an update (#485). The panel compares a box with the value it was drawn with, which is its value when it took focus: before it redraws, it saves typing made since then (over an incoming change to the same field: the typing is newer), ignores the blur its own draw causes, and puts back only typing it saved; a box nobody typed in shows the incoming value. The scene-length editor queues a typed length with `afterThisPaint` (`05-render.js`), which runs it once the outermost paint finishes, or after the next paint that finishes when that one threw (#495 pins the nesting). A render puts the focus back only on a grid cell that had it; a focused Writer paragraph keeps its caret through `renderWriter`. The view's `afterScriptCellChange` still requests `production`, `broll`, `writerStats` and `untagged` on every input; the scheduler merges them with the command's `derive`.
- **Split.** `at` is a `TextCut` (`textCut(from, to)`: the selection is deleted first, the range is clamped to the cell, and a cut never lands inside a surrogate pair) or `MediaHalves` (`mediaHalves(first, second)`: two sanitised HTML strings that `splitMediaCellInDom` cut from the live DOM of a cell holding media). The new scene follows the split one and is `todo`, with the other field empty. Both are stamped through the ports, each with its own clock read, so the two `updatedAt` values can differ by a millisecond. `splitRowFieldCore` (`06-rows.js`) calls `syncFieldFromDom`, reads the selection, calls `breakUndoCoalescing`, mints the new id with `makeId`, runs the command and returns the new scene's id and field when it applied. The grid and the Writer each repaint afterwards: `splitCellField` calls `render()`, and `splitWriterRow` calls `renderWriter()`.
- **Join.** `JoinPorts` adds `plainText` (`htmlToPlainText`, handed in by `19-writer.js`, so the bridge does not import `14-export.js`). A scene has a visual when its visual text has any plain text or its gallery holds anything (`gallerySize`). The audio text is joined as models with a space unless either side is empty or the earlier one ends in a space; when either audio holds media, the stored HTML is concatenated instead. The later scene's visual text and gallery slot are taken only when it has a visual; the command refuses when the earlier scene has one too. Status is the higher of the two by rank `todo` < `ready` < `shot`, and an unknown status ranks lowest. `mergeWriterRows` asks `bothScenesHaveVisual` first and shows the "Both scenes have a visual" toast (`warn`) without breaking the typing group; the command's own refusal is the backstop. Join exists only in the Writer.
- **Paste and cut.** Both return a `ReportedCommand`: the command and a `report()` of what the view needs afterwards (`attached` and `caret`). `attached` is set only after the stamp succeeds, so a rolled-back paste reports `null`. A paste inserts text or runs at the range (no range pastes at the end), freshens a pasted piece's b-roll key ids only when it holds a key (`takenBrollIds`, `freshBrollIds`; a cut's own keys keep their ids), flattens directions and cues in a visual cell, and records a shot for each pasted key that has no record yet (`pastedShots`, built by `newBrollShot` in `core/document/broll.ts`, seeded by the `brollSeed` port, which is `brollSeedOf` in `08c-broll.js`). Attached pictures and videos go into the scene's gallery through `attachToGallery` in the same transaction; an attachment the gallery refuses, such as a video file with no name, adds no stamp and does not dirty the document; a picture or video already in the gallery still stamps the scene and marks it unsaved. The stamp is written once. A paste is one accepted edit, so `S.editSeq` and the generation rise by one; before 3.14 `editCell` marked the document dirty twice.
- **The DOM half.** `openCellEdit` and `closeCellEdit` in `05b-cell-edit.js` hold what stays in the view: sync the field from the DOM, refuse a media cell, break the typing group, repaint the cell, restore the caret, flush and break the group again. `editCell` composes them and still writes `row[field]`, stamps and calls `markDirty` itself (#452). `copyFromCell` in `05c-clipboard.js` writes the clipboard, runs `cutSelection` (`openCellEdit`, `cutCommand`, `closeCellEdit`), and arms `cutNonce` once `cutSelection` returns without throwing, which includes a cut that changed nothing. `pasteIntoCell` runs `pasteCommand` with no text when the paste brings only attachments, outside the cell edit and between its own undo-grouping breaks; otherwise it runs between `openCellEdit` and `closeCellEdit`. A paste with text, or a cut, refused in review mode (`REVIEW_ONLY`) changes nothing: `pasteIntoCell` answers `done: false` and `cutSelection` returns.
- **Rollback and atomicity.** A stamp that throws fails each of the five whole: `runConfined`'s tests check that text, gallery, shot list, row list and undo are byte-identical afterwards. Before 3.14 a paste or cut wrote the text, the shot records and the gallery before the stamp threw.
- **Undo.** Each command is one `UndoPort.record`, and 12a's diff makes the entry. Typing coalesces as before (section 6). Split and join call `breakUndoCoalescing` before the command, and paste and cut break before (`openCellEdit`) and after (`closeCellEdit`), so none of them joins a typing group.

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

`S.editSeq` rises once per pass, so one command, one `markDirty`, and one `settle` each raise it once (`src/test/session-bridge-app.test.mjs` counts it for `markDirty` and `settle`, `src/test/scene-effects-app.test.mjs` for the two scene commands, and `cell-text-app`, `split-join-app` and `cut-paste-app` for the text commands; browser suites 185 and 187 check that each such edit autosaves).

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
| `CellTextPorts` | `StampPorts` plus `cells`, a `CellDecoder` from stored HTML to runs | `sessionTextPorts` in the bridge: `sessionStamps` and the legacy `cellOf`; the text commands' tests use the real adapter over jsdom or a map of known HTML |
| `JoinPorts`, `ClipboardPorts` | `CellTextPorts` plus `plainText` (join); plus `ids` and `brollSeed` (paste). Both are defined beside their commands in `split-join.ts` and `clipboard.ts`, not in `ports.ts` | `19-writer.js` (`htmlToPlainText`); `05c-clipboard.js`'s `clipboardPorts()` (`randomIds`, `brollSeedOf`) |

The bridge imports nothing in the runtime cycle. The cycle's modules hand their functions in at module evaluation (`provideSessionEffects`, `provideRefreshRunner`), not in `__init` as the milestone said, because unit tests import `12-dirty-toast.js` and `07-production-tags.js` alone and `markDirty` must still mark the document dirty. Until they do, the bridge's defaults do nothing and allow edits.

The bridge's other exports: `runCommand`, `readSession`, `REVIEW_ONLY`, `sessionStamps`, `sessionTextPorts`, `noteSessionEdit`, `noteServerUpdate`, `noteRecovery`, `noteReload`, `noteAbsorbedDirty`, `requestRefresh`, `liveSession`.

## 6. The undo adapter

`createUndoAdapter()` is a four-method `UndoPort` over `12a-undo.js`:

| Port call | 12a call |
| --- | --- |
| `adopt` | `trackDocument()` |
| `record` | `noteEdit()` (the change set is ignored; 12a diffs) |
| `absorbServer` | `noteRemoteChange(doc)` |
| `absorbReload` | `absorbRemoteChange()` |

Two more adapter exports: `watchUndoAdoption`, which registers the `adopted` hook through `configureUndo`, and `followLiveDocument`, which is `trackDocument()`.

12a keeps everything else, as it was (apart from the typing additions further down):

- **Diffing.** `noteEdit` queues a microtask `flushEdits`, which runs `diffStates` against a base clone and records the steps that are not cosmetic. Two clicks inside one microtask fold into one entry.
- **Coalescing.** One-cell typing in the same cell within `COALESCE_MS` (1,000 ms) merges into the last entry.
- **The limit.** `MAX_ENTRIES` is 200; the oldest entry is dropped first.
- **`forget`.** A server update or reload forgets the entries that touch what `changedBetween` reports as changed, which `noteRemoteChange` and `absorbRemoteChange` compute.
- **`foldIntoEdit`.** It is not reachable through the adapter. No `UndoPort` operation folds, and its one caller (`05v-video.js`) still calls 12a directly.
- **Inversion and replay.** `undo()` and `redo()` run `history.undo` or `history.redo` on `S.state`, applying steps with `applyStepsLive`.

Replay and owner re-pointing (#402, 3.7): when a live `people`, `productionTags` or `brollShots` list no longer matches a step's `before`, `applyStepsLive` merges that list. It now resolves the document-field steps after the loop, people first. If the people list was merged, it re-points owners in `productionTags` and `brollShots` from each folded id to the person kept, with `personIdRemap` and `repointOwners` from `core/merge/lists.ts`, after the whole plan has been applied. A list is replaced by a re-pointed copy only when something changed. The tag and shot merges also get `personSurvives(sides, peopleAfterReplay)`, judged against the people the replay leaves, so an owner that did not survive gives way to the other side's live owner. Refusals, row steps and non-list fields are unchanged. The adapter file itself did not change for this: the replay is in 12a. Since #494 and the #476/#353 PR, a replay leaves no owner outside the crew: an owner id in neither the people the replay leaves nor the same-name remap is cleared, and the undo or redo still succeeds with `cleared: n`. When the replay changes the people list, this covers every production tag and b-roll shot, not only the lists the entry carries, and an owner whose same-named person was kept moves to that person. Those changes to lists the entry did not carry are recorded into the entry as `docField` steps, so the opposite step gives them back and the user's later steps on those lists still find the list they recorded; the entry also remembers the items it unassigned, so a later replay that clears them again is counted.

Typing that ends where it began (#427, 3.12; Adam's decisions on #380) and cancelled compositions (#427, #448). `src/legacy/undo-adapter.ts` is unchanged by it; the work is in 12a and is reached from the views, not through the `UndoPort`:

- **A group that coalesces back to its start is dropped.** `record()` keeps each entry's `from` projection. When typing in the same cell coalesces into the last entry and the cell's stored value reads the same as the entry's start (`cosmetic`: the same runs, so a change of marks does not count), the entry is dropped. Typing a letter and deleting it within a second leaves no step. An entry that pushed the oldest of the 200 out keeps it (`evicted`), and the drop puts it back.
- **Redo given back.** Typing clears redo at its first keystroke. `record()` first parks the redo it clears, with the top entry it was cleared under. If that typing then leaves no step, the parked redo returns, and only onto an empty redo stack. A parked list is exactly the redo stack of one moment. An undo or redo of the typing keeps it; a merge that removes any undo or redo entry, `clear()` and a refused step forget it. Known limit: if only part of the typing was undone before the drop, redo stays cleared.
- **Composition marks.** `compositionUndoMark(rowId, key)` (a flush, then the history serial, the cell's stored value and the top entry as it is) is taken at `compositionstart` by `onScriptComposition` in `21-events.js`, for the grid and the Writer. The history keeps one live mark. At `compositionend`, `dropEmptyStepsSince(mark, cancelled)` acts on the live mark only; `cancelled` is true when `data` is empty, which is how a cancel arrives.
  - When every entry since the mark is that cell's typing and the cell reads as it did at the mark, it drops them, puts a joined entry back as it was (end, time and word state), puts back an entry that `record()`'s coalesce-back drop had removed, and gives the redo back.
  - When the cell does not read as it did and the composition was cancelled (a slow composition over a selection, in a browser that does not put the selection back, such as Chromium: #436), it collapses the entries since the mark into one step from the cell at the mark to the cell after the cancel.
  - Otherwise it keeps them.
  - An end with empty `data` that left something to do arms one more check after the next script-cell input, for browsers that send `compositionend` before the reverting input. Only a composition input type (`insertCompositionText` and its kin) counts as a cancel there, and any keydown that is not part of the IME disarms it.
  - An undo or redo during the composition that moves an entry from before the mark takes a fresh mark from the cell as it leaves it, and any successful step ends the mark, because the render drops the composition (#446, PR #448).
  - Known limits, recorded in DOCUMENT-MODEL.md §7: an undo or redo of the composition's own updates and then a cancel can give back a redo that shows the cancelled text, only in a browser whose composition survives Ctrl+Z (#459); and a co-editor's change reaching the cell during the composition keeps the cancel's entries as made.
- **`undoSerial()`** is a flush and the history serial, with no break in coalescing. The Writer's Ctrl+Y reopen compares it, so typing that left no step still blocks the reopen. In a Writer you have just opened, the first Ctrl+Z after a cancelled composition or a type-and-delete closes it (Adam's decision, kept).

Outside the adapter: the replay path above (it reaches the session only afterwards, as `afterUndoApplied`'s `markDirty`); the composition marks and drops above; `foldIntoEdit`; comment and reply draft undo (INV-55), which is untouched; the `undo()`/`redo()` calls from `21-events.js`; and 12a's own `restart()`, which is how the session learns of adoption.

## 7. Testing a command

`tests/application/session-fakes.ts` holds the harness.

- **`fakeClock()`** is a `TimerPort` with a clock that starts at 1,000. `advance(ms)` runs due timers in time order, setting `now` to each timer's time. `stall(ms)` moves `now` without running timers, which tests the maximum window. `armed()` counts pending timers.
- **`harness(timing?, hooks?)`** builds a real `DocumentSession` over fake ports and returns `session`, `log`, `published`, `refreshes`, `clock` and `deny(reason | null)`. The log is an ordered list of strings (`entry`, `undo.adopt:<title>`, `undo.server:<title>`, `undo.reload`, `undo.record`, `reconcile`, `dirty:<generation>`, `draft:<generation>`, `save:<generation>`, `refresh`, `publish:<kind>`), which is what pins the commit order. Hooks: `beforeUndo` (to start an adoption inside an undo call), `reconcile` and `entry`.
- **`rawScript(title)`** gives a small raw document with a comment anchor.
- **`runConfined(session, command)`** snapshots the document as JSON, runs the command, snapshots again and calls `writesOutside` with the applied outcome's change set, or with `NO_CHANGES` for any other outcome. It throws, naming the command, the outcome kind and each place, if the command wrote outside what it declared. It also wraps `plan` and throws if `plan` changed the document at all, declared or not, because the rollback point is taken after `plan` returns and cannot undo a write made there. A `noop`, `rejected` or `failed` command therefore must change nothing at all, which also catches an incomplete rollback. `writesOutside` checks undeclared document fields, undeclared row fields, inserted and removed rows, row order, and comments (their `rowId` and `field` are ignored when the set reconciles). Every command's tests from 3.8 on run through it, including a command with a stamp port that throws.

What fails a test: an undeclared write (applied or thrown), a generation, effect, publication or refresh that appears for a no-op, refusal or failure, and a document that is not byte-identical after a rollback. The fake clock itself fails on nothing.

The application tests (`document-session.test.ts`, `session-effects.test.ts`, `scene-length.test.ts`, `scene-status.test.ts`, `cell-text.test.ts`, `split-join.test.ts`, `clipboard.test.ts`, `entry-fuzz.test.ts`) use these fakes. A command test whose reconciliation or ports must decode what the command just wrote needs the real adapter (`createRichText` with `jsdomParser()`); a map of known HTML decodes nothing the command produced. `session-anchors.test.ts` checks `cellTextEdit` and `needsReconciliation` against `syncCommentAnchors` directly, without the harness. `src/test/undo-adapter-differential.test.mjs` runs the real adapter against 12a over seeded sequences.

The text commands also have booted-app tests, because their views and 12a's grouping decide what the user gets. `cell-text-app.test.mjs`, `split-join-app.test.mjs` and `cut-paste-app.test.mjs` drive the real handlers (an `input` event, Alt+Enter, the Writer's Enter, Backspace and Delete, `copyFromCell` and `pasteIntoCell`) and count the generation, `S.editSeq`, publications and undo steps; `text-editing-app.test.mjs` (3.11) pins the typing, split, join, cut and paste recordings that 3.12 to 3.14 had to keep; `paste-html-fuzz.test.mjs` is a seeded fuzz over pasted HTML, through the cleaner and through the booted app. `undo.test.mjs` holds the history-level tests, among them `redoInvariantRun`, a seeded check that every redo starts from the exact state its entry was undone from. Browser suite `289-script-cell-ime.txt` composes in a script cell through CDP (`Input.imeSetComposition`, the driver's `ime` verb) in the grid and the Writer.

View-level refusals need the booted app, because the toast and the click routing live in the views. `src/test/_app-boot.mjs` (`bootApp`, `closeApp`) loads the page and `_entry.js` under jsdom, records every `S.state` assignment in `seen`, and `closeApp` clears the timers and channels it tracked. `scene-effects-app.test.mjs` boots once, switches the session with `window.__hostedTest.setSession({ role: "review", docId })`, calls `cycleRowStatus` or `setSceneLength` or sends real click events on the lamp or the length button, and asserts exactly one `warn` toast with the right text and that the document, `S.editSeq`, dirty state, generation (read through `liveSession()`) and undo stack are unchanged. Browser suite `43-review-mode.txt` covers the same in a real browser, including the forced-button case that the click guard refuses.

## 8. Known gaps and exceptions

| Gap or exception | Where it stands |
| --- | --- |
| `editCell`'s model edits (formatting, shortcuts, tags, b-roll keys, Enter), the scene paste and drop (`05g-scene-clip.js`, which still uses `recordPastedBroll`), and every other legacy writer still call `markDirty` (a whole-document change set, no reconciliation) | `editCell`: #452. The scene paste is out of M3 (D10). The rest: milestones 4 to 6 |
| The 14 `S.state` assignment sites and the legacy writers that bypass the session | Milestone 4's transition API (milestone-3.md, Risks) |
| Ctrl+Z and Ctrl+Y replay in 12a, outside the session. The replay writes `S.state` itself, and the session hears of it only afterwards, through `afterUndoApplied`'s `markDirty` | Not fixed in M3. Milestone 6 takes "undo/redo through the mutation boundary" ([milestones-4-7-rescope.md](milestones-4-7-rescope.md), #426) |
| Recovery by assignment (draft restores, history restore, file import) is published as `adopt`, not `recovery`, so it opens an epoch with no generation or undo entry (INV-53, E4) | Accepted by the coordinator; INV-53's row says so |
| Rollback covers only the declared change set | By design (INV-06); `runConfined` is the guard |
| A one-cell edit can move an anchor when its comment ids change, so the typing command sets `runsMoved` then | Correction of the plan's claim, from #384 |
| `S.editSeq` and the generation diverge after a merge, reload or recovery | By design (INV-53) |
| `applyMerge` migrates `theirs` before `mergeStates` (#417), and refuses a `theirs` or `mine` that is no document. The session still migrates the merged result as it enters, which is redundant when `mergeStates` already migrated it (measured at a median 23.6 ms on the long demo, in #384) | #415 (#304). The runtime guard is recorded in [pinned-defects.md](pinned-defects.md) and [milestone-3.md](milestone-3.md) |
| A document the server already holds with a `state` that is an array stays there: since #428 the server refuses to store one (`400 bad-state`) and answers a comment on one with `409 no-state`. Every client entry refuses such a state as no document | Fixed for new writes by #428 (Adam's decision of 2026-10-07 on #417) |
| A render that throws after a merge, an adoption, the boot load (`renderFirstDraw()`) or the Writer's close (by its button, Escape, an undo past its opening or a jump to a scene) is absorbed by `renderAbsorbed()`: the update finishes, Redraw is offered, and the rows, titles, Writer and find bar's replace and tag refuse edits until a render draws cleanly. `syncFieldFromDom` and `openCellEdit` (so `editCell` and every paste) refuse while `screenIsStale()`, the keyboard undo and redo (and the `historyUndo`/`historyRedo` beforeinput) are refused in `undoOrRedo`, and a paste or drop whose files finish reading on a stale screen is dropped with a toast. Not blocked (Adam's decision 3): side panels, rundown drag, selected-scene delete, cut and paste, an open tag or comment box (with its own undo), gallery Undo and the picture annotator's own undo; they edit the document by id, never from a stale cell. The toast Undo buttons (picture attached, scene delete, gallery) call `undo()` directly and still run, because each undoes by scene id and none reads a stale cell | #418, #442, #443, #458 |
| A render that throws after a review answer leaves the link marked unsaved | #441 |
| Undo or redo of an owner assignment after a merge folds the owner keeps the dropped id | #391 |
| The replay counts a live id as alive when `step.after` holds a person with the same name, though nothing re-points it | Accepted in #402 |
| The `broll` refresh still repairs on read | #325, milestone 6 |
| Two review refusals are not one path: the status lamp refuses through the command's `REVIEW_ONLY`, the length editor through the view's `reviewMode()` check, since opening it is not a command. A forced `cycle-status` button gets the click guard's "Viewing only" toast | Adam's decisions of 2026-10-07 on #414 |
| `cycleRowStatus` with no document does nothing; it used to throw | Unreachable from the page |
| The hide-shot grace is view state driven by the applied outcome, not an effect | By design (#414). The runtime cycle has 411 edges. At 3.9 it had 413, not the planned 412, because 01 still imports `12-dirty-toast.js` for the toast |
| Effects and refresh functions are handed in at module evaluation, not `__init`; adoption hooks into 12a's `restart()`, not only `render()`'s `trackDocument()` | Differences from milestone-3.md's 3.6 wording, kept for the reasons in sections 2 and 5 |
| Media cells cannot be expressed as runs, so the typing command takes `SanitisedMediaHtml` for them. `sanitisedMediaHtml()` does not sanitise; its only caller, `syncFieldFromDom`, does | Milestone 6 retires the variant (INV-10) |
| A Writer split or join declares no `derive`, so it requests no production or b-roll refresh (the grid gets them from `render()`) | #451 |
| Cut, then Ctrl+Z, then paste of that cut leaves the anchor in two scenes, because `cutNonce` outlives an undo of the cut. Same on the base | #460 |
| An undo or redo of a composition's own updates and then a cancel can give back a redo that shows the cancelled text, in a browser whose composition survives Ctrl+Z (Firefox, Safari; Chromium ends it first). A co-editor's change reaching the cell during a composition makes the cancel keep its entries as made | #459; DOCUMENT-MODEL.md §7 records both. #436 and #446 are fixed by #448 |
| Typing that leaves no step gives the redo it cleared back only when none of that typing was undone. After a partial undo, redo stays cleared; nothing is applied wrongly | Accepted in #427, pinned by a test |
| A single composition with more than 200 slow updates, cancelled, can leave an intermediate update as the top entry. `foldIntoEdit` checks the undo and redo stacks but not a parked redo, so a parked entry that touches the same gallery can come back and its redo is then refused with a toast | Accepted in #427 |
| A render's own focus changes commit stale cell text: `restoreRenderFocus` focuses the grid cell under a focused Writer paragraph, and `paintRow` and `renderWriter` remove focused cells; the `focusout` reaches the typing command, which knows nothing of a render in progress | #477 (milestone 3 external review, F2) |
| A delayed media paste or drop resolves its target by row id when the files finish reading, in whatever document is live by then | #478 (F1); milestone 4 |
| The dirty effect writes `personColors`, which no change set declares, after the transaction | #479 (F3); milestone 4 |
| A throw after the commit (undo recording, an effect, a listener) leaves the document mutated with no typed outcome | Milestone 4 (plan §5) |
