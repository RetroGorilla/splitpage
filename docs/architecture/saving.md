# Saving

The as-built description of the operation context, the document transitions, the save coordinator, the writers behind it and the restore policy, on `4.0-development` at `511dce0` (the merge of PR #569, the last code step of milestone 4). It covers milestone 4's PRs 4.6 (capture contract, #557), 4.8 (operation context and transition API, #555), 4.9 (save coordinator, #562), 4.11 (file writer, #568), 4.12 (import writeback and file-open adoption, #567), 4.13 (desktop handle, #570), 4.14 (hosted writer and transport, #564), 4.15 (server open, resume, pull and publish, #565), 4.16 (collaboration and authority, #566) and 4.18 (restore and adoption policy, #569), and says where 4.17 (draft stores), 4.19 (blob store) and 4.20 (continuations) touch saving. [Milestone 4](https://github.com/RetroGorilla/splitpage/blob/d84f28bd/docs/architecture/milestone-4.md) is the plan; this file says what the code does today. Where the two differ, a sentence says so, and "Known gaps and exceptions" collects what is left. Step 4.22 revised this file for the later lanes; the sections below that changed most are 3 (who calls the transitions), 5 (the writers), 7 (restore) and 8 (gaps). On `4.1-development` the server and collaboration features were removed: the hosted writer, the transport, server open, resume, pull and publish, the authority model and the restore policy are gone, and saving has two destinations, a file and an import.

The code lives in `src/application/session/operation.ts`, `src/application/transitions/` (`transitions.ts`, `ports.ts`), `src/application/save/` (`coordinator.ts`, `status.ts`, `autosave.ts`, `capture.ts`, `session-effects.ts`, the session's dirty, draft and save effects, and `file-saving.ts`, the file writer and the save ports, with its ports in `file-saving-ports.ts`), `src/application/recovery/` (`pristine.ts`, `capture-schedule.ts`, `drafts.ts`, which holds the draft restores, and `draft-restore.ts`, which decides where a taken draft goes and words its notices, and `draft-origin.ts`, which records where a captured draft came from and builds what a draft write sends), `src/adapters/files/file-target.ts`, `src/adapters/files/save-dialogs.ts`, `src/bootstrap/wiring/transition-owners.ts`, `src/bootstrap/wiring/save-owners.ts` and `src/bootstrap/wiring/recovery-owners.ts`. The file-saving owner is wired by `src/bootstrap/wiring/file-saving.ts`, which fills its ports from the owner modules beside it (`location-owner.ts`, `save-owners.ts`, `session-owner.ts`, `preferences-owner.ts`) and the adapters; `copyDocHistorySafe` and `syncDocIdentity` come from the identity owner, and `setBaseState` (the session merge owner, `application/session/session-merge.js`, through `src/bootstrap/wiring/session-merge.ts`) arrives as `setBaseline` from `wireLegacyApp` in `src/bootstrap/wiring.ts`. File open is `application/transitions/local-files.js`, import writeback is `application/save/import-saving.ts`, and the destination port and `setBaseState` are the session merge owner's. The status line and the Save buttons are `src/features/title/save-status.js`, wired by `src/bootstrap/wiring/save-status.ts`. It names functions and types, not lines.

## 1. Purpose

Three small owners, each created once and started once by the wiring step (`wireApp` in `src/bootstrap/wiring.ts`, called by the composition root `src/bootstrap/main.ts`):

| Owner | Question it answers | Created by |
| --- | --- | --- |
| Operation context | Is this async work still about the document and destination it started with? | `createOperations(ports)` |
| Transitions | How does a different document, or a different place for the same one, become the live one? | `createTransitions(ports)` |
| Save coordinator | In what order do saves to one destination run, and which completions count? | `createSaveCoordinator(ports)` |

`wireApp` calls `startSaves(savePorts(...))` (the file-saving owner's save ports, which `wireLegacyApp` builds), then `startTransitions(...)`, then `startRecovery(draftRecoveryPorts())`, all before any feature mounts (milestone 7.1). The three live in `src/bootstrap/wiring/save-owners.ts`, `transition-owners.ts` and `recovery-owners.ts`. Before its start function has run, every accessor in the matching module throws ("not started yet"). `startRecovery` (4.17) follows the same pattern and builds its draft writer on the same operation context. The wiring's `dispose()` calls the three stop functions in reverse order.

Each start function returns a stop function that clears the module's state; tests use it. Starting twice throws.

## 2. The operation context

`captureOperation()` returns a frozen `OperationContext`:

| Field | Meaning | Source in the app |
| --- | --- | --- |
| `epoch` | The session's epoch: a new one opens when a document is adopted or recovered, even with the same document id | `liveSession().epoch()` |
| `docId` | The live document's id, or `null` | `currentDocument().docId` |
| `destination` | The destination's identity | The current `home` record (`_home.js`) |
| `destinationGeneration` | The generation the current destination has confirmed | `confirmedGeneration()` in `save-owners.ts` |
| `generation` | The session's count of accepted edits | `liveSession().generation()` |

`stillOwns(ctx)` is true while the epoch, the document id and the destination identity all equal what the context captured. It does not compare the two generations: those are for the code that holds the context to read. The connection and revision fields went with the server features.

The comparison is strict on purpose: a destination is the `home` record itself. `setHome` builds a new record every time, so any retarget, even to the same file, changes the identity.

Callers outside saving use it for work that waits: the pasted-picture and dropped-picture continuations in `features/rows/scene-media.js` and `src/bootstrap/wiring/editor.ts`, the gallery in `features/gallery/overlay.js`, the video record in `features/gallery/video.js` and the annotator's save in `features/gallery/annotate.js` (4.20). The import modal (`features/imports/imports.js`, M5 5.3) captures when it opens for an append or replace; a file decoded for it and its confirm are dropped once `stillOwns` fails, the confirm with its own toast. Each captures before its first `await` and refuses on `!stillOwns(ctx)` with the toast the plan's D11 names. The ownership check is the broad one (Adam kept it in 4.20): a Save As while a picture loads also drops it, with the toast. The draft writer (4.17) captures at the start of each draft write and calls the result obsolete when ownership moved. The draft restores (4.18) use `captureRestore` and `stillRestoring` from `recovery-owners.ts`, which are `captureOperation` and `stillOwns` (section 7).

## 3. The transitions

`documentTransitions()` returns `createTransitions(ports)` bound to the legacy ports. A transition moves the live document and, where it applies, its destination and identity, in one synchronous call.

| Method | What it does | Fork rule |
| --- | --- | --- |
| `open(opening)` | Makes the document live, adopts it in the session, sets the destination if one is given, confirms the document as the destination's baseline, and sets `docIdWrittenOut` if the opening says | None |
| `startNew(arrival)` | As `open`, with the baseline the new document and `docIdWrittenOut` false | None: the caller supplies a fresh id |
| `restore(restoration)` | Makes a document live that keeps the live document's id, and adopts it. No destination or baseline change | Keeps the live id |
| `recover(recovery)` | As `open` with a given baseline. A `detached` recovery mints a new id (the old one is returned as `forkedFrom`) and sets `docIdWrittenOut` false | Forks when detached |
| `copyId()` | The id a copy should carry: the live id until it has been written out, then a fresh one | INV-36 |

An arrival (`open`, `startNew`, `recover`) may carry `keep`, a label: the history snapshot taken before a replacement (L3h PR 3). If the live document has rows, the transition hands the label to the history port before the new document is assigned, and `Arrived.kept` says whether a snapshot was stored. `restore` never keeps one.

The input is `{ document }` (already a `ValidatedDocument`) or `{ raw }` (migrated through the entry port, `migrateRows`). Every method that makes a document live does the same three things in order: hand it to `liveDocumentPort.assign`, which is `adoptReplacement` in `session-owner.ts` (it disposes the old session and starts one at the same epoch and generation), and then settle the destination. A transition returns `Arrived` (`document`, `forkedFrom`).

The ports, all supplied by the legacy modules:

| Port | In the app | Does |
| --- | --- | --- |
| `entry` | `migrateRows` (`bootstrap/document-ports.ts`) | Brands raw input as a `ValidatedDocument` |
| `live` | `liveDocumentPort` (`src/bootstrap/wiring/session-owner.ts`) | Reads the session's document and replaces it |
| `session` | `adoptReplacement` (`bootstrap/wiring/session-owner.ts`) | Adopts a document in the session now |
| `destination` | `documentDestinationPort` (`application/session/session-merge.js`) | `set` calls `setHome`; `confirm` calls `setBaseState` with a clone of the baseline |
| `identity` | `documentIdentityPort` (`application/identity/document-identity.js`) | Mints ids and reads and writes whether the id was written out, through the document location owner (`documentLocation()`) |
| `history` | `documentHistoryPort` (`application/session/session-merge.js`) | `keep(label, doc?)` takes a history snapshot of `doc`, or of the live document when none is given |

Destinations are `LegacyDestination` values (`kind` and `fields`), and `NO_DESTINATION` is `{ kind: "none" }`.

When `adoptReplacement` has started the new session it calls the listeners registered with `onDocumentReplaced` (`bootstrap/wiring/session-owner.ts`), and so does the undo adapter's adoption hook. A listener made with `liveSession().subscribe` would die with the session it was made on; `onDocumentReplaced` is the app-lifetime way to react to a replacement. Its one listener today is `releaseSessionVideoUrls` in `features/gallery/video-files.ts` (4.22, L1c), which revokes the cached object URLs of session videos and keeps the file and token grants.

`keepSnapshot(label, doc?)` (`src/bootstrap/wiring/transition-owners.ts`, the `history` port) takes the same snapshot outside a transition, for changes that are not replacements: taking your version of a title or field (`features/comments/comments.js`), replacing rows on import (`features/imports/imports.js`), reloading an import from disk (`application/transitions/local-files.js`), and the two snapshots a new blank script or demo keeps, one under the old id and one under the new (`features/file-menu/file-menu.js`).

### Document sources (L3h PR 3)

A document source is `{ id, takes(opening), open(opening) }` (`src/application/transitions/sources.ts`). `createDocumentSources()` holds the registered ones and asks the newest first, like the save destinations. `transition-owners.ts` creates the registry when the transitions start, and `openDocument(opening)` opens through the source that takes the opening, answering what it answered (a promise), or `false` when none does. An opening is `{ kind, ...fields }`. The wiring's `document sources` step, right after `transitions`, registers the list the `sources` dependency returns and drops them at dispose; a duplicate id fails the step.

| Source | Opening | Does |
| --- | --- | --- |
| `project-file` (`projectFileSource` in `bootstrap/wiring/local-files.ts`) | `{ kind: "file", file, handle, options?, parsed? }` | Without `parsed`, reads the file (`openProjectFile`, which falls back to an import for other formats); with `parsed` (an answer of `parseProjectFileState` in `src/adapters/formats/project-file.ts`), adopts it as read (`adoptProjectState`) |
| `import` (`importDocumentSource` in `bootstrap/wiring/imports.ts`) | `{ kind: "import", file }` | `handleImportFile`: the import dialog's file |

The source runs inside the `openDocument` call, so an opening that adopts at once (a `parsed` file) has replaced the document when the call returns, as before.

### Who calls them today

| Caller | Method |
| --- | --- |
| `replaceWithNewDocument` (`features/file-menu/file-menu.js`): the demo, a starter, a blank script from the file menu | `startNew` with `NO_DESTINATION` |
| `adoptNewDocument` (`features/newtab/newtab.js`): a new document in this tab, including a script pasted or imported as a new document (the import scans run on the document before it is handed over, M5 5.3) | `startNew`, with `NO_DESTINATION` only if the tab was on a file or an import |
| The boot load (`openInitialDocument`, `src/bootstrap/startup/initial-document.ts`), when stashed work changed the loaded document | `open` |
| `adoptProjectState` (`application/transitions/local-files.js`): a file opened from disk, with the file destination and `diskBase` cloned from the incoming document (4.12) | `open`, written out |
| `loadFileIntoEditor`'s import branch (`application/transitions/local-files.js`): an import, entered with `{ raw }` and the import destination (4.12) | `open`, not written out |
| `adoptUntitledDraft` and `recoverDraftAsUnsavedCopy` (`application/recovery/drafts.ts`): an unsaved copy of a draft (4.18), including a leftover desktop draft whose origin was a server document, which restores as untitled | `recover`, detached |
| `restoreFileDraft`'s applied branch (`application/recovery/drafts.ts`), after `adoptProjectState` has opened the file (4.18) | `restore` |
| `adoptRestoredState` (`bootstrap/startup/document-entry.js`): a history version (4.18) | `restore`, with `{ raw }` |

Every caller now hands the transition a document it owns (`draftMigrate` output, or `{ raw: cloneState(...) }`), so `restore` and `recover` setting `docId` on the incoming document touches nothing a caller keeps (the note on PR #555, closed in 4.18).

What does not go through the transitions, on purpose: the reload branch of `loadFileIntoEditor` (an in-place absorb through `noteReload`, same epoch and document), the merge paths (`applyMerge` hands a merged `ValidatedDocument` to `session.absorbMerged`; section 8).

## 4. The save coordinator

`createSaveCoordinator(ports)` owns a queue per destination, a confirmed generation and baseline per destination, and the rules for which completions count. It holds no document and calls no legacy code except through its ports.

### Requests, queues and joining

`request(r)` returns a promise of a `SaveOutcome`. It puts the request on the queue of the destination current *now*, keyed by `DestinationKey` (`owner` and `name`, from the destination port's `keyOf`). A queue runs one writer call at a time, in order. A request that arrives while an earlier one is *waiting* (not running) may be joined into it: the `join` port decides, and a joined request returns the same promise as the waiting one. Nothing joins into the running call.

`joinSaves` in `save-owners.ts` is the legacy rule. The plain kinds are `save`, `auto` and `autosave`. Two of the same kind join as that kind. Two automatic kinds (`auto`, `autosave`) join as `auto`. Any other pair of different plain kinds joins as `save`. `saveAs`, `force` and the two import-writeback kinds (`writeback`, `writebackForce`; 4.12) never join: two clicks of Save back to the import queue two writes.

### One run

When a queue starts a request it fixes three things before calling the writer:

1. The change count now (`job.generation`), which is the generation this save will confirm.
2. An `OperationContext`, from the ownership port's `capture`.
3. A `SaveJob`: `request`, `generation`, `operation()` (the captured context), `owns()` (4.14: `ownership.stillOwns` on that context, for a writer that must stop mid-run), `alive()` (false once the coordinator that ran the job is stopped, whatever the ownership says) and `moved()`.

`moved()` recaptures the context. A writer calls it when it deliberately changes the destination mid-run, which Save As does when it retargets the document to the file just picked. Without it the run would see its own retarget as a loss of ownership. It also re-keys the running queue to the destination current now (unless another queue already has that key), so a Save asked for while a Save As is still writing waits behind it instead of opening a second writer on the new file (F5-saveas, PR #572). Save As calls it after a fork gives the copy a new document id, so that change is not reported as a reopen (F9-warn).

Each queue entry records the session epoch it was asked in. A request joins only a waiting entry of the same epoch, and when a queue reaches an entry from an earlier epoch it settles `obsolete` (`here: false`) without calling the writer, so a save queued before a document was replaced never runs against the replacement (F5-replaced, PR #572, b47fe86).

The writer port returns a `WriterResult`, which the coordinator judges:

| Writer result | Outcome | Rule |
| --- | --- | --- |
| `failed` (or a throw, a rejection, or an answer that is not a result) | `failed` | Never judged by ownership: a failure proves a failure |
| `cancelled` | `cancelled` | Its own outcome. A cancelled dialog is not a failure and changes nothing |
| `refused` with a reason | `refused` | The writer declined to write (a file that changed on disk; autosave that may not run) |
| `saved` and `!stillOwns(operation)` | `obsolete`, with `here` | The bytes landed but the document or destination moved on. `here` is true when the write landed on the destination that is current now |
| `saved` | `saved` with `acknowledged: true` | The destination's confirmed generation advances to `job.generation` |

An `obsolete` outcome calls the report port's `obsolete(request, here)`. A run that settles starts the next queued request before it resolves its own promise.

### Dirty, baseline and counts

- `noteChange()` bumps a global change count. The session's dirty effect calls it for every accepted edit; `saveChanges()` in `save-owners.ts` reads the count.
- A destination is dirty while `changes()` is past its confirmed generation: `dirty(identity)`. The first time a destination is asked about, it has confirmed nothing (`NEVER_CONFIRMED`, 0).
- `confirmClean()` marks the current destination confirmed at the current count and confirms the document clean. `confirmSavedNow` in `src/bootstrap/wiring/save-owners.ts` calls it (from the save completion owner, the file menu's new document and the New Tab page).
- `unsaved()` is true while a change was noted since the last `confirmClean()`, wherever the document saves to. It is the app's "unsaved changes" flag (`unsavedChanges()` in `src/bootstrap/wiring/save-owners.ts`, `saves.unsaved()` in `bootstrap/wiring/ports/saving.ts`). It is not `dirty()` of the current destination: the two differ when the home changes without `confirmSavedNow`.
- `confirmBaseline(b)` stores the current destination's baseline. `setBaseState` in `application/session/session-merge.js` calls it. `confirmed(identity)` reads a destination's generation and baseline.
- `running()` is true while any queue has a call in flight, and `waiting()` counts waiting requests. The report port's `running(boolean)` fires when that flips, and the app refreshes the Save controls from it. Everything that asks whether a save is in progress reads `saveBusy()` in `save-owners.ts`, which is `running()` of the live coordinator (false when none is started).

The Save buttons are a projection. The coordinator is the owner; the projection is written by `confirmSavedNow`, `setBaseState` and the dirty effect. The unsaved flag, the change count and the busy state have no copy (L3b PR 1).

### The save ports (`savePorts` in `application/save/file-saving.ts`)

| Port | In the app |
| --- | --- |
| `writer.write` | Not a legacy port since L3h PR 1: `save-owners.ts` builds it from the destination registry (section 5, "Destinations") |
| `destination.current` | `home` |
| `destination.keyOf` | `destinationKeyOf`: no destination is one shared key; a desktop file is keyed by its desktop id; a browser file by its handle object |
| `report.obsolete` | `reportObsoleteSave`: a toast, only when `here` is true and a document is open: "An earlier save of “{title}” finished after you reopened it. Your open copy is unchanged." (D10) |
| `ownership` | The operation context's `capture` and `stillOwns` (`ownership` in `bootstrap/wiring/ports/saving.ts`) |
| `join` | `joinSaves` |

## 5. The front door and the writers

`saveDoc(opts)` in `src/bootstrap/wiring/save-owners.ts` is the entry for the Save action, the desktop menu's Save, Save As, force overwrite and every direct caller. It resumes autosave (unless the call is automatic) and returns `requestSave({ kind })`, with the kind from `saveKind(opts)`: `saveAs`, `force`, `auto` or `save`. `queueAutoSave` requests `autosave`, or puts the autosave back on its timer when another save is already running. The save-error retry, the conflict overwrite and copy and `openPrompterElsewhere`'s save reach the same queue through `saveDoc`. Import writeback (`saveBackToFile`) requests `writeback`, or `writebackForce` from the conflict overwrite (4.12).

The coordinator orders the writers and judges their results; each writer decides what it writes.

### Destinations (L3h PR 1 and 2)

A destination is `{ id, takes(request, place), autoSaveTarget(place), write(job) }` (`src/application/save/destinations.ts`). `createSaveDestinations()` holds the registered ones; `taking(request, place)` asks the newest first and answers the first that takes the request at the document's current place (`home`), or null. `save-owners.ts` creates the registry with the coordinator, and its writer port sends each job to the destination that takes it, at the place the document has when the job starts. A request no destination takes is refused ("No save destination takes this save") without a write. The wiring's `save destinations` step, right after `saves`, registers the list the `destinations` dependency returns (`wireLegacyApp` puts the file-saving owner's `destination()` first, then `importSaveDestination()` from `bootstrap/wiring/local-files.ts`) and drops them at dispose; a duplicate id fails the step and releases what was built.

| Destination | Takes | Autosave target |
| --- | --- | --- |
| `file` (`destination()` of the file-saving owner, `application/save/file-saving.ts`) | `saveAs`, `save`, `auto`, `autosave` and `force` | `autoSaveWhere` with the file home |
| `import` (`importSaveDestination` in `bootstrap/wiring/local-files.ts`) | `writeback` and `writebackForce` | none: an import never autosaves |

The built-ins never take the same request, so their order does not matter. A destination registered later (in a test, or a future cloud drive) is asked before them. `src/test/save-destinations-app.test.mjs` registers a throwaway destination in the booted app and saves through Save As, then Save and autosave to the place it chose, with no other change.

### File conflicts (L3h PR 2)

A writer that finds its file changed on disk does not open a dialog. It answers `{ kind: "refused", reason, conflict }`, where `conflict` is a `FileConflict` (`src/application/save/file-conflict.ts`): `{ fileName, current, kind }`, `kind` being `project` (the file writer) or `import` (import writeback), and `current` the file's state now. The coordinator passes the conflict through to the outcome. `requestSave` in `src/bootstrap/wiring/save-owners.ts` hands it to `fileConflicts()`, the conflict owner it creates at start, only if the save owners it started on are still the running ones. The owner holds the one conflict being shown: `show`, `close` (which always announces, so a stale view closes), `current` and `onChange`. The conflicts view in `src/bootstrap/wiring/views.ts` follows `onChange` and draws `showFileConflictView` (`features/file-menu/local-files.js`); its buttons and the reloads in `application/transitions/local-files.js` and `features/merge/local-merge.js` close it through `fileConflicts().close()`. An automatic save that finds a conflict still halts autosave and opens no dialog.

The file check is `checkFileConflict(handle, lastModified)` in `src/adapters/files/file-target.ts`. A file it cannot read is a conflict with nothing to compare (`current: null`), except when the read is refused with `NotAllowedError` or `SecurityError`: that answers `denied` (browser handles only; a desktop handle always answers granted). The file writer then fails the save with "Could not save — permission to change {name} was withdrawn, so use Save a copy or open the file again." (an automatic save halts autosave) instead of opening the conflict view. The check runs only on a save that is not forced and whose home has a recorded `lastModified`; any other save reaches the writer and fails with the browser's own message. An import writeback treats `denied` like a refused `createWritable`: it stops writing in place and saves a copy through the delivery port. Delivering bytes outside a save (exports, downloads, an import writeback's fallback) is `deliverBytes` in `src/adapters/files/deliver.ts` (desktop dialog, else a browser download), wrapped by `fileDelivery.deliver` in `src/bootstrap/wiring/ports/files.ts`, which shows the saved or failed toast through the effects port and answers whether the bytes went out.

### The file writer (4.11, 4.13)

`writeDoc` (`application/save/file-saving.ts`) writes files, Save As and downloads, over `src/adapters/files/file-target.ts` and the save dialogs in `src/adapters/files/save-dialogs.ts`, reached through the owner's `files` port.

- **The port.** A `FileHandle` is `{ name, createWritable() → { write, close }, getFile() → { lastModified } }`. `pickTarget(dialogs)` asks the desktop dialog, else the browser picker, else answers a download; an abort or an empty dialog is `cancelled`. `existingTarget(handle)` is Save's own file. `writeToHandle(handle, body)` writes, closes and returns the file's `lastModified`. If `close()` resolves `{ lastModified }` the writer uses that and does not call `getFile()`; otherwise it reads `getFile()` once.
- **The desktop shim.** `makeDesktopHandle` (`src/adapters/desktop/desktop-handle.ts`, through the desktop port) resolves `close()` with the `lastModified` that `splitpage:write-file` answered (main stats the file right after `atomicWrite`, which writes a temp file, fsyncs and closes it, then renames it over the document), so on the desktop the baseline timestamp is the write's own and the second read is gone (F8). A missing or non-finite stamp falls back to `getFile()`. Main still has a short window between the atomic write and its stat.
- **Stamps on the capture.** `writeDoc` sets the Save controls busy (since 6.5 it repairs no records first; save preparation is read-only), and captures with `captureExportDocument({ docId: fork, stamp: { rev + 1, lastEditedBy, lastEditedAt } })`. The new `rev` and the last-edited stamps go on the captured copy, so the bytes carry them without any change to the live document. Then it picks or reuses a target, checks the file's conflict marker against the home captured at the start (unless forced), builds the bytes, and writes.
- **Confirming.** `confirmWrite` runs only if the write landed and `job.owns()` still holds. The steps are the save completion owner's (`createSaveCompletion` in `application/save/save-completion.ts`, built by `mountFileSaving` from the same ports), which also holds `adoptSavedCopyDocId`. It gives the live document its `rev` and stamps, sets the baseline, the home's `diskBase` and `lastModified`, the forked id and `docIdWrittenOut`, and clears the dirty flag. No failure, cancel, conflict or build-error path writes to the live document, so a save whose document was replaced mid-write changes nothing in the replacement (F1, F1-abort, F1-dialog, F2). Save As retargets the document only while the job owns it, followed by `job.moved()`; one `finally` undoes a retarget and clears the busy state.
- **A write that landed but is no longer owned.** The bytes are on disk, so the toast "Saved to …" still shows, the coordinator reports the save obsolete, and only the history copy runs: a forked copy's history is copied after any landed write (suite 22 pins this); the id change and `docIdWrittenOut` happen only when owned.
- **Results.** `SAVED`, `CANCELLED`, `FAILED`, `CONFLICTED` (a refusal) or a `failed` result with the error.
- **Pictures left out.** When some pictures were not available, the writer shows `warnImagesLeftOut` through the notices port (`src/bootstrap/wiring/effects-owner.ts`, wording in `src/application/export/diagnostics.ts`); exports show the same notice from their diagnostics.

### Import writeback (4.12)

An imported file (`.md`, `.txt` and the like) saves back to its source through the coordinator, on the import destination's own queue.

- `saveBackToFile(opts)` requests `writeback` (or `writebackForce`). The request carries the import home it was made for (`target`, an optional field of `LegacySaveRequest`). The kinds never join.
- `writeBackToFile(job)` is the writer: it builds the bytes with `buildFileData` (captured at its start), checks the conflict marker, writes in place or falls back to a download through `deliverFile`, and answers saved, failed, cancelled or refused; a file changed on disk is a refusal carrying an `import` conflict ("File conflicts" above). It refuses (`IMPORT_REPLACED`) unless the import named by `target` is still the open one and `job.owns()` still holds, checked before the build, after it and after the conflict check. Without that, a writeback queued behind another would write the new document into a different file once another import had replaced the first while it waited.
- After an acknowledged outcome the import home reads saved from `unsavedFor(imported)`, not from a blanket clear. That step, and recording the file's new `lastModified` and `size` once the write lands (or, when the file can't be read back, the stamp `close()` answered, else no stamp, so the next writeback isn't refused for the app's own write), are the import completion's (`createImportCompletion` in `application/save/save-completion.ts`); opening a project file (confirm clean) and opening an import (clear its dirty flag) are the adoption completion's (`createAdoptionCompletion`, same file), called from `application/transitions/local-files.js` at the same points as before. The download fallback still counts as the import's save. The Save button shows its busy state while a writeback runs, because the coordinator reports it running.
- The bytes are the document as it stood when the writeback began, for every import format, including while the pictures are being loaded (5.1's capture; I3, M5 5.3, reads the stored `.txt`, `.md`, `.csv` and `.docx`).
- It still reads the file a second time after writing (`close()` then `getFile()`); on the desktop the shim now answers the stamp from `close()`, so using it here is a one-line change left for later (4.13's note).

### Merges

- **`applyMerge`.** The merge step is TypeScript: theirs, mine and base enter through `mergeIncoming` (`merge-incoming.ts`) and the merged `ValidatedDocument` goes to `session.absorbMerged`, which does not run entry a second time (#415; the skipped second migration measured 18.3 ms median on the long demo against 23.6 ms in #384). Since L3h PR 5 the merge is one owner, `createDocumentMerge` (`src/application/session/document-merge.ts`): `states` (core's `mergeStates` with the legacy ports), `apply` (`applyIncomingMerge`) and `report` (the banner, the absorbed-dirty mark and the autosave nudge or pause, which `reportMerge` in `bootstrap/wiring/document-merge.ts` did). `src/bootstrap/wiring/document-merge.ts` holds it, built by the wiring's `merge` step from `sessionMergePorts()` (`src/bootstrap/wiring/session-merge.ts`, over the session merge owner `application/session/session-merge.js`: snapshots, adoption, undo arming and `setBaseState`), and callers use `applyMerge`, `mergeStates` and `reportMerge` from that module. The banner installs itself there (`installMergeBanner`).

### Autosave

The autosave entry points are in `save-owners.ts`: `autoSaveTarget()` asks the destination that would take an `autosave` request at the current place, `scheduleAutoSave`, `queueAutoSave`, `flushAutoSave`, `haltAutoSave`, `resumeAutoSave`, `setAutoSaveEnabled` and `toggleAutoSave` work the policy with that target. An `autosave` request is refused unless the policy allows that destination's target and there are unsaved changes; otherwise the destination writes it as an automatic save.

## 6. Capture (4.6)

`captureExportDocument(opts)` (`application/save/export-kit.ts`, over `application/save/capture.ts`) reads the session once, synchronously, and returns a frozen `ExportDocument`: the document, the capture time, and core's production index, comment numbers and b-roll entries. It carries no handle or path, and no picture bytes: pictures are content hashes. `opts.docId` stamps a different id on the capture, which is how Save As writes a forked id without changing the live document yet. It throws when there is no document. The wiring supplies its typed ports (`src/bootstrap/wiring/export-capture.ts`), and callers reach the owner through it.

The exporters take it: `buildSplitpageFile` and `buildMarkdownProject` (`src/adapters/formats/project-file.ts`, over the project file services the wiring installs; L3h PR 4), `standaloneHtmlFor`, the CSV, DOCX, PDF and XLSX builders and the export dialog, and `exportFacts`. `exportDocumentOf(state)` builds the same shape from a given state; the project file services (`application/save/project-files.ts`) use it when asked to build a file from a state they are given.

`writeDoc` captures before its first `await`, so the file's bytes are the document as it stood when the save started. `opts.stamp` (4.11) lays the next `rev` and the last-edited stamps on the capture, like `opts.docId`, so the bytes carry them while the live document keeps its own until `confirmWrite`. `buildFileData` (used by import writeback and the export dialog) builds one export request before its first `await` (5.1, `exportRequest` in `features/file-menu/local-files.js`): the capture, the resolved options (stage directions, the b-roll view, the image-bundle choice) and the asset request; the capture itself carries the clock setting (`clockMode`). Providers come from the format registry (registered by `src/bootstrap/wiring/exporters.ts`, milestone-5.md step 4) and are called with the document, the options, the held assets and the ports they need. The writers decode cells through the export services (`src/application/export/services.ts`): the cached cell reader, the inert-body parser, the decoder, the Markdown and plain-text projections, the production readers and the cache seal, which the wiring's `export services` step builds from the legacy rich-text objects and starts before the registry. The writers read nothing else: no stored preference, panel state or live row.

**Assets (5.1).** The asset request (`src/application/export/assets.ts`) is the capture's picture hashes. `loadExportAssets` resolves the request once (`ensureBytes`) into a frozen asset map, `picture(sha)` and `missing`; every writer takes its pictures from the map, and a picture missing from it is left out as before (the HTML export's warning counts `missing`). The PDF's JPEG preparation (`pdfImagesFor`, `pdfCommentImagesFor`) decodes from the map.

**Dates (5.1).** An export's date is the local calendar day of the capture time, at midnight (`exportDay`). The PDF's `/CreationDate`, the `.docx` and `.xlsx` `docProps` dates, the printed dates of the packing and shot lists, and every ZIP entry (DOS time 0, the captured day's date) come from it, so an export captured before midnight and written after keeps its day (INV-60). `zipWrite` with no day writes 1980-01-01, never the clock.

## 7. Restore and adoption (4.17, 4.18)

Restoring recovered work never saves it (INV-40, INV-41, INV-51), and a restore that finishes late changes nothing.

- **Entry points.** A file draft's applied branch goes through `transitions.restore` after `adoptProjectState` has opened the file, so the baseline stays the file's and is written once, by the open. An unsaved copy of a file, import or untitled draft is a detached `transitions.recover`: it mints the new id and the history copy uses `forkedFrom`. A leftover desktop draft whose origin was a server document is restored the same way, as an untitled unsaved copy with all its content. A history version is `transitions.restore({ raw })`. A restored draft schedules no save: the session's save effect (`application/save/session-effects.ts`) arms no autosave for a `recovery` settle, and the merges decide their own (they queue an autosave or halt it). So a restored draft reaches the file with the user's next edit or Save (T5, T6).
- **One exception to "restoring never saves".** It is deliberate. Restoring a history version is a version the user chose, not recovered work: `restoreSnapshot` (`application/session/session-merge.js`) calls `queueAutoSave()` after a restore unless the caller passed `opts.local`. INV-41 is about drafts. A restore itself leaves the destination's confirmed generation as it was.
- **Ownership.** `captureRestore` and `stillRestoring`, exported by `recovery-owners.ts`, are the operation context's `captureOperation` and `stillOwns`. `restoreFileDraft` captures before its first `await` and checks after the read and the parse; `restoreSnapshot` (history) checks after each `await`, in place of the old id comparison (K1, H1).
- **A late restore.** When a file-draft restore no longer owns the document, it changes nothing, shows "Another script was opened while the changes from the last session were being restored — they have been kept for the next launch." and returns the outcome `kept`. A late history restore answers "changed". On the desktop, main's `splitpage:draft-restore-done` handler maps the outcome through `restoreDoneAction` (`desktop/drafts.js`): `failed` keeps the draft and opens the tab's file (the draft is unreadable); `kept` keeps the draft and drops the tab's pending file open (it would otherwise be opened over the script the user just opened); anything else releases the draft. There is no preload or IPC change.
- **The kept draft's lifetime.** It stays held for the rest of the session, so the new script's own draft writes are refused (`HELD`) and crash recovery shows as paused. It survives a normal close. If the user closes the tab or quits and answers "Don't save" for the new script, `discardForUserDecision` deletes the tab's folder, the kept draft included (the same as the unreadable-draft path), so "kept for the next launch" holds unless the user then discards the new script.
- **The pristine check (#483, T3).** `neverWrittenOut(doc)` (`pristine.ts`) is true when there is no revision and the editor name is empty once trimmed. `loadInitialState` applies it to the raw state data and then to the migrated document, and the resume check in `openInitialDocument` (`src/bootstrap/startup/initial-document.ts`) applies it to the loaded document, so a whitespace-only name no longer makes the two disagree.
- **Capture scheduling (B4b).** `capture-schedule.ts` owns the quiet timers (1.5 s idle, 5 s maximum, 15 s for large documents), the pending flag and the retry backoff (5 s doubling to 60 s). A refused write cancels the quiet timers a change armed while it was in flight, and a quiet timer never captures while a retry is armed. The drafts owner (`application/recovery/drafts.ts`) keeps the capture and the write and calls the schedule.
- **Draft writes.** The drafts owner numbers each write and each discard from one sequence. Main (`desktop/drafts.js`) refuses a write or discard older than the last one it took (`STALE_SEQ`), so a late write never replaces a newer draft and a discard removes only what came before it.
- **No browser drafts.** Drafts are desktop-only. The browser keeps none: its draft store, writer and Web Lock were removed with the server-document leftovers.
- **Left as is.** The merge branch of `restoreFileDraft` (`applyStashedWork` in `src/bootstrap/wiring/recovery-owners.ts`, built by `createStashedWork` in `src/application/recovery/stashed-work.ts` over the conflict stash and the merge port that `src/bootstrap/main.ts` passes with the recovery ports) awaits only its undo-point snapshot after the open and is not re-checked.

## 8. Known gaps and exceptions

Things the code does today that the plan says will change, or that a reader would not guess. Each is either a deliberate scope limit of milestone 4 or a note carried to milestone 6.

- **Save completion has one owner; when it runs is still split.** The completion steps for file saves, import writeback and adoption are in `application/save/save-completion.ts` (#899, #901), and the recovery extraction is done (`application/recovery/`). What plan section 8 still lists is the timing: the writer decides when its completion runs, and the coordinator confirms the same save in its own step (next bullet). Milestone 5 preserves the boundary: format providers build bytes and report diagnostics and never acknowledge a save, adopt a document or retarget a destination.
- **Writers still end their own saves.** `writeDoc` calls the save completion owner's `confirmWrite`, which sets the baseline through `setBaseState` and clears dirty itself, guarded by `job.owns()`; the completion steps live in that one owner, but the writer still decides when they run. The coordinator also advances the confirmed generation when a `saved` result passes `stillOwns`. The two agree in the cases tested but are separate steps; the Save buttons stay a projection.
- **`applyMerge`'s screen side is not TypeScript.** Only the merge step moved (4.15). Snapshots, render, chips, toasts and undo arming are in the session merge owner, `application/session/session-merge.js`, which is still JavaScript. Moved UI routes keep the save, restore and export invariants above: no feature owner writes or acknowledges an export itself, restore keeps its transaction kind and autosave suppression with only the exception of section 7, and an export request keeps one capture before asynchronous preparation.
- **Web file destinations are keyed by handle identity.** The same file picked a second time gives a different handle object, hence a different queue and a separate confirmed generation. Desktop files are keyed by their desktop id.
- **The autosave policy owns its state; the file destination's autosave decisions are in the file-saving owner.** `autoSaveWhere` and `autoSaveMay` (`autosave.ts`) are pure: where autosave writes (only a picked file; never a downloaded copy or an `.html` project) and whether it may run. `createAutoSavePolicy` (`autosave.ts`) holds the on/off switch, the halt reason, the idle and maximum timers (through a timer port) and the timing; `save-owners.ts` builds it with the coordinator in the `saves` wiring step and stops it with it, and `autoSavePolicy()` reads it. It announces `enabled` and `halt` changes through its `changed` port. `autoSaveTarget`, `scheduleAutoSave`, `flushAutoSave`, `haltAutoSave` and `toggleAutoSave` are in `src/bootstrap/wiring/save-owners.ts` and ask the policy. The file destination's autosave target and the File menu's autosave item (`updateAutoSaveMenu`, which reads the policy and the menu item through the owner's ports) are in `file-saving.ts`; the flush on a window blur or a hidden page is installed by `mountFileSavingFeature`.
- **One status selector.** `saveStatus(input)` (`status.ts`) returns the status line and the Save button view, `saveStatusView` in `features/title/save-status.js` renders the line from it, and `setSaveButtons` renders the buttons from `saveButtonView`. `dirty`, `busy`, `halted` and `autoSaveOn` come from the coordinator and the autosave policy; `target` is read through the feature's ports (`autoSave.target()`) when the view is built.
- **Obsolete saves are reported, not re-queued.** A save that lands after its document moved on is not retried, and a landed file save still shows "Saved to …". Legacy writers apply their own completion for it only while they own the document.
- **Blobs.** `adapters/storage/02c-blobs.js` delegates to `adapters/storage/blob-store.ts` (4.19). The writers call `ensureBytes` before they write; it does not run under the operation context.
- **App-lifetime subscriptions.** No app module subscribes to the live session; the replacement listener of section 3 is the one app-lifetime hook, and the listeners and observers that live for the whole session are named in `src/test/m4-lifecycle.test.mjs`.

## Local file owner lifetimes

Opening, resume and reload continuations belong to the owner that began them. Stopping that owner retires pending reads and decoding, ends its busy indicators and prevents later adoption, confirmation or handle persistence. Import write-back checks both its owner lifetime and save job ownership after asynchronous work. A retired write aborts an acquired writable when supported; a buffered desktop writable is left unclosed so it cannot commit. A close already in progress cannot be undone, but its retired continuation does not update metadata or report completion. File menu controls, conflict timers and pending exports belong to their originating mount and cannot use a replacement mount's ports. Disposing an old mount again cannot stop its replacement.
