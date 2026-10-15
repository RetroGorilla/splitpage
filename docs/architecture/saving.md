# Saving

The as-built description of the operation context, the document transitions, the save coordinator, the writers behind it and the restore policy, on `4.0-development` at `511dce0` (the merge of PR #569, the last code step of milestone 4). It covers milestone 4's PRs 4.6 (capture contract, #557), 4.8 (operation context and transition API, #555), 4.9 (save coordinator, #562), 4.11 (file writer, #568), 4.12 (import writeback and file-open adoption, #567), 4.13 (desktop handle, #570), 4.14 (hosted writer and transport, #564), 4.15 (server open, resume, pull and publish, #565), 4.16 (collaboration and authority, #566) and 4.18 (restore and adoption policy, #569), and says where 4.17 (draft stores), 4.19 (blob store) and 4.20 (continuations) touch saving. [Milestone 4](milestone-4.md) is the plan; this file says what the code does today. Where the two differ, a sentence says so, and "Known gaps and exceptions" collects what is left. Step 4.22 revised this file for the later lanes; the sections below that changed most are 3 (who calls the transitions), 5 (the writers), 7 (restore) and 8 (gaps).

The code lives in `src/application/session/operation.ts`, `src/application/transitions/` (`transitions.ts`, `ports.ts`), `src/application/save/` (`coordinator.ts`, `status.ts`, `autosave.ts`, `capture.ts`), `src/application/recovery/` (`restore-policy.ts`, `pristine.ts`, `capture-schedule.ts`, `draft-writer.ts`), `src/application/collaboration/` (`authority.ts`, `workflow.ts`), `src/adapters/files/file-target.ts`, `src/adapters/transport/server-transport.ts`, `src/legacy/transition-bridge.ts`, `src/legacy/save-bridge.ts` and `src/legacy/recovery-bridge.ts`. The legacy side is in `src/js/14-export.js` (the file writer and the adapter ports), `13-hosted.js` (the server writer and the server open, resume, pull and publish paths), `18-local-files.js` (file open and import writeback), `20g-drafts.js` (the draft restores), `03-sync.js` (the destination port and `setBaseState`) and `12-dirty-toast.js` (the dirty flag and the save controls). It names functions and types, not lines.

## 1. Purpose

Three small owners, each created once and started once by `_entry.js`:

| Owner | Question it answers | Created by |
| --- | --- | --- |
| Operation context | Is this async work still about the document, destination and connection it started with? | `createOperations(ports)` |
| Transitions | How does a different document, or a different place for the same one, become the live one? | `createTransitions(ports)` |
| Save coordinator | In what order do saves to one destination run, and which completions count? | `createSaveCoordinator(ports)` |

`_entry.js` calls `startSaves(legacySavePorts(...))` before the numbered `__init`s and `startTransitions(...)` after them. Before its start function has run, every accessor in the matching bridge throws ("not started yet"). `startRecovery` (4.17) follows the same pattern and builds its draft writer on the same operation context. Milestone 7 moves those calls into `src/bootstrap/`.

Each start function returns a stop function that clears the bridge's state; tests use it. Starting twice throws.

## 2. The operation context

`captureOperation()` returns a frozen `OperationContext`:

| Field | Meaning | Source in the app |
| --- | --- | --- |
| `epoch` | The session's epoch: a new one opens when a document is adopted or recovered, even with the same document id | `liveSession().epoch()` |
| `docId` | The live document's id, or `null` | `S.state.docId` |
| `destination` | The destination's identity | The current `home` record (`_home.js`) |
| `destinationGeneration` | The generation the current destination has confirmed | `confirmedGeneration()` in the save bridge |
| `generation` | The session's count of accepted edits | `liveSession().generation()` |
| `connection` | The connection instance | `conn` (`_home.js`) |
| `revision` | The server revision of a server destination, else `null` | `serverHomeRev()` |

`stillOwns(ctx)` is true while the epoch, the document id, the destination identity and the connection instance all equal what the context captured. It does not compare the two generations or the revision: those are for the code that holds the context to read. The context carries no authority field. 4.16 built the authority model (`authority.ts`: none, owner, scoped editor, reviewer) over the same connection facts, and a change of role or scope is a different connection instance, so it already makes `stillOwns` false; the model answers "may this connection edit" and the context answers "is this still the same one".

Two things make the comparison strict on purpose:

- A connection is an instance. `updateConnection` in `_home.js` returns a new frozen connection, so a changed token, role or scope is a different connection. Code that asks "the same server?" uses `stillOnServer(c)` or `serverOf(c)`, not `===`.
- A destination is the `home` record itself. `setHome` builds a new record every time, so any retarget, even to the same file, changes the identity.

Callers outside saving use it for work that waits: the pasted-picture and dropped-picture continuations in `06-rows.js` and `21-events.js`, the gallery in `05e-gallery-overlay.js`, the video record in `05v-video.js` and the annotator's save in `05w-annotate.js` (4.20). The import modal (`11-import.js`, M5 5.3) captures when it opens for an append or replace; a file decoded for it and its confirm are dropped once `stillOwns` fails, the confirm with its own toast. Each captures before its first `await` and refuses on `!stillOwns(ctx)` with the toast the plan's D11 names. The ownership check is the broad one (Adam kept it in 4.20): Save As, a first server save, or a token change while a picture loads also drops it, with the toast. The draft writer (4.17) captures at the start of each draft write and calls the result obsolete when ownership moved. The hosted writer, the presence poll and `pullServerDoc` (4.14, 4.15) capture and build a transport from the captured connection (section 5). The draft restores (4.18) use `restoreOwnership`, a relaxed form of `stillOwns` (section 7).

## 3. The transitions

`documentTransitions()` returns `createTransitions(ports)` bound to the legacy ports. A transition moves the live document and, where it applies, its destination and identity, in one synchronous call.

| Method | What it does | Fork rule |
| --- | --- | --- |
| `open(opening)` | Makes the document live, adopts it in the session, sets the destination if one is given, confirms the document as the destination's baseline, and sets `docIdWrittenOut` if the opening says | None |
| `startNew(arrival)` | As `open`, with the baseline the new document and `docIdWrittenOut` false | None: the caller supplies a fresh id |
| `restore(restoration)` | Makes a document live that keeps the live document's id, and adopts it. No destination or baseline change | Keeps the live id |
| `recover(recovery)` | As `open` with a given baseline. A `detached` recovery mints a new id (the old one is returned as `forkedFrom`) and sets `docIdWrittenOut` false | Forks when detached |
| `publish(ctx, publication)` | If `stillOwns(ctx)`, sets the destination and baseline, changes the live id and marks it written out; the result says which id it replaced. Otherwise `{ kind: "obsolete" }` and nothing changes | Changes id and destination only |
| `copyId()` | The id a copy should carry: the live id until it has been written out, then a fresh one | INV-36 |

The input is `{ document }` (already a `ValidatedDocument`) or `{ raw }` (migrated through the entry port, `migrateRows`). Every method that makes a document live does the same three things in order: assign it to `S.state`, adopt it in the session at once (`adoptReplacement` in the session bridge, which disposes the old session and starts one at the same epoch and generation), and then settle the destination. A transition returns `Arrived` (`document`, `forkedFrom`).

The ports, all supplied by the legacy modules:

| Port | In the app | Does |
| --- | --- | --- |
| `entry` | `migrateRows` (`02-state.js`) | Brands raw input as a `ValidatedDocument` |
| `live` | `liveDocumentPort` (`02b-doc-id.js`) | Reads and assigns `S.state` |
| `session` | `adoptReplacement` (`session-bridge.ts`) | Adopts a document in the session now |
| `destination` | `documentDestinationPort` (`03-sync.js`) | `set` calls `setHome`; `confirm` calls `setBaseState` with a clone of the baseline |
| `identity` | `documentIdentityPort` (`02b-doc-id.js`) | Mints ids and reads and writes `S.docIdWrittenOut` |
| `ownership` | The operation context | `stillOwns` |

Destinations are `LegacyDestination` values (`kind` and `fields`), and `NO_DESTINATION` is `{ kind: "none" }`.

When `adoptReplacement` has started the new session it calls the listeners registered with `onDocumentReplaced` (`session-bridge.ts`), and so does the undo adapter's adoption hook. A listener made with `liveSession().subscribe` would die with the session it was made on; `onDocumentReplaced` is the app-lifetime way to react to a replacement. Its one listener today is `releaseSessionVideoUrls` in `06-rows.js` (4.22, L1c), which revokes the cached object URLs of session videos and keeps the file and token grants.

### Who calls them today

| Caller | Method |
| --- | --- |
| `replaceWithNewDocument` (`18b-file-menu.js`): the demo, a starter, a blank script from the file menu | `startNew` with `NO_DESTINATION` |
| `adoptNewDocument` (`20j-newtab.js`): a new document in this tab, including a script pasted or imported as a new document (the import scans run on the document before it is handed over, M5 5.3) | `startNew`, with `NO_DESTINATION` only if the tab was on a file or an import |
| The boot load in `21-events.js`, when stashed work changed the loaded document | `open` |
| `adoptProjectState` (`18-local-files.js`): a file opened from disk, with the file destination and `diskBase` cloned from the incoming document (4.12) | `open`, written out |
| `loadFileIntoEditor`'s import branch (`18-local-files.js`): an import, entered with `{ raw }` and the import destination (4.12) | `open`, not written out |
| `openServerDoc` and `resumeServerDoc`'s no-merge reopen (`13-hosted.js`): a server document from the picker or reopened after a sign-in (4.15) | `open` with the server destination, written out |
| `publishToServer` (`13-hosted.js`), after the upload (4.15) | `publish`, with a captured operation |
| `adoptUntitledDraft` and `recoverDraftAsUnsavedCopy` (`20g-drafts.js`): an unsaved copy of a draft (4.18) | `recover`, detached |
| `restoreFileDraft`'s applied branch (`20g-drafts.js`), after `adoptProjectState` has opened the file (4.18) | `restore` |
| `adoptRestoredState` (`02b-doc-id.js`): a history version (4.18) | `restore`, with `{ raw }` |

Every caller now hands the transition a document it owns (`draftMigrate` output, or `{ raw: cloneState(...) }`), so `restore` and `recover` setting `docId` on the incoming document touches nothing a caller keeps (the note on PR #555, closed in 4.18).

What does not go through the transitions, on purpose: the reload branch of `loadFileIntoEditor` (an in-place absorb through `noteReload`, same epoch and document), the merge paths (`applyMerge` hands a merged `ValidatedDocument` to `session.absorbMerged`; section 8) and the server draft resume's fallbacks to an unsaved copy.

## 4. The save coordinator

`createSaveCoordinator(ports)` owns a queue per destination, a confirmed generation and baseline per destination, and the rules for which completions count. It holds no document and calls no legacy code except through its ports.

### Requests, queues and joining

`request(r)` returns a promise of a `SaveOutcome`. It puts the request on the queue of the destination current *now*, keyed by `DestinationKey` (`owner` and `name`, from the destination port's `keyOf`). A queue runs one writer call at a time, in order. A request that arrives while an earlier one is *waiting* (not running) may be joined into it: the `join` port decides, and a joined request returns the same promise as the waiting one. Nothing joins into the running call.

`joinSaves` in the save bridge is the legacy rule. The plain kinds are `save`, `auto`, `autosave` and `server`. Two of the same kind join as that kind. Two automatic kinds (`auto`, `autosave`) join as `auto`. Any other pair of different plain kinds joins as `save`, so `server` with `save`, `auto` or `autosave` also becomes `save`. `saveAs`, `force` and the two import-writeback kinds (`writeback`, `writebackForce`; 4.12) never join: two clicks of Save back to the import queue two writes.

### One run

When a queue starts a request it fixes three things before calling the writer:

1. The change count now (`job.generation`), which is the generation this save will confirm.
2. An `OperationContext`, from the ownership port's `capture`.
3. A `SaveJob`: `request`, `generation`, `operation()` (the captured context), `owns()` (4.14: `ownership.stillOwns` on that context, for a writer that must stop mid-run) and `moved()`.

`moved()` recaptures the context. A writer calls it when it deliberately changes the destination mid-run, which Save As does when it retargets the document to the file just picked. Without it the run would see its own retarget as a loss of ownership. It also re-keys the running queue to the destination current now (unless another queue already has that key), so a Save asked for while a Save As is still writing waits behind it instead of opening a second writer on the new file (F5-saveas, PR #572). Save As calls it after a fork gives the copy a new document id, so that change is not reported as a reopen (F9-warn).

Each queue entry records the session epoch it was asked in. A request joins only a waiting entry of the same epoch, and when a queue reaches an entry from an earlier epoch it settles `obsolete` (`here: false`) without calling the writer, so a save queued before a document was replaced never runs against the replacement (F5-replaced, PR #572, b47fe86).

The writer port returns a `WriterResult`, which the coordinator judges:

| Writer result | Outcome | Rule |
| --- | --- | --- |
| `failed` (or a throw, a rejection, or an answer that is not a result) | `failed` | Never judged by ownership: a failure proves a failure |
| `cancelled` | `cancelled` | Its own outcome. A cancelled dialog is not a failure and changes nothing |
| `refused` with a reason | `refused` | The writer declined to write (a file that changed on disk; autosave that may not run) |
| `saved` or `copied`, and `!stillOwns(operation)` | `obsolete`, with `here` | The bytes landed but the document, destination or connection moved on. `here` is true when a `saved` write landed on the destination that is current now |
| `copied` | `saved` with `acknowledged: false` | A copy (Save As of a hosted document): the destination's generation does not move |
| `saved` | `saved` with `acknowledged: true` | The destination's confirmed generation advances to `job.generation` |

An `obsolete` outcome calls the report port's `obsolete(request, here)`. A run that settles starts the next queued request before it resolves its own promise.

### Dirty, baseline and counts

- `noteChange()` bumps a global change count. The session's dirty effect calls it for every accepted edit and stores the result in `S.editSeq`.
- A destination is dirty while `changes()` is past its confirmed generation: `dirty(identity)`. The first time a destination is asked about, it has confirmed nothing (`NEVER_CONFIRMED`, 0).
- `confirmClean()` marks the current destination confirmed at the current count. `clearDirty` in `12-dirty-toast.js` calls it, then sets `S.dirty = unsavedFor()`.
- `confirmBaseline(b)` stores the current destination's baseline. `setBaseState` in `03-sync.js` calls it and keeps `S.baseState` as its projection. `confirmed(identity)` reads a destination's generation and baseline.
- `running()` is true while any queue has a call in flight, and `waiting()` counts waiting requests. The report port's `running(boolean)` fires when that flips; the app sets `S.saveButtonBusy` from it. The Save controls and the status line treat the document as busy when `S.saveButtonBusy` is set or `saveRunning()` is true.

`S.dirty`, `S.baseState` and the Save buttons are projections that legacy readers still read. The coordinator is the owner; the projection is written by `clearDirty`, `setBaseState` and the dirty effect.

### The legacy ports (`legacySavePorts` in `14-export.js`)

| Port | In the app |
| --- | --- |
| `writer.write` | `writeQueued`: kind `autosave` goes to `writeAutoSave`, kind `server` to `saveToServer`, kinds `writeback` and `writebackForce` to `writeBackToFile` (4.12), every other kind to `writeDoc` |
| `destination.current` | `home` |
| `destination.keyOf` | `destinationKeyOf`: no destination is one shared key; a server document is keyed by the server and `doc:<id>`; a desktop file by its desktop id; a browser file by its handle object |
| `report.obsolete` | `reportObsoleteSave`: a toast, only when `here` is true, the destination is not a server and a document is open: "An earlier save of “{title}” finished after you reopened it. Your open copy is unchanged." (D10) |
| `report.running` | `showSaveRunning` |
| `ownership` | `saveOwnership` wrapping the operation context (below) |
| `join` | `joinSaves` |

`saveOwnership` relaxes `stillOwns` for any destination that is not a server (a file, an import, a download, or no destination): if the epoch, document id and destination are unchanged, a changed connection does not make the save obsolete, because a file save never used the connection. A server destination keeps the strict rule, so a token or server change during a hosted save is obsolete.

## 5. The front door and the writers

`saveDoc(opts)` in `14-export.js` is the entry for the Save action, the desktop menu's Save, Save As, force overwrite and every direct caller. It resumes autosave (unless the call is automatic) and returns `requestSave({ kind })`, with the kind from `saveKind(opts)`: `saveAs`, `force`, `auto` or `save`. `queueAutoSave` requests `autosave`, or puts the autosave back on its timer when another save is already running. `publishAndCopyShareLink` requests `server`. The save-error retry, the conflict overwrite and copy, `flagLinkOff`'s copy and `openPrompterElsewhere`'s save reach the same queue through `saveDoc`. Import writeback (`saveBackToFile`) requests `writeback`, or `writebackForce` from the conflict overwrite (4.12).

The coordinator orders the writers and judges their results; each writer decides what it writes.

### The file writer (4.11, 4.13)

`writeDoc` (`14-export.js`) writes files, Save As, downloads and a hosted Save As, over `src/adapters/files/file-target.ts`.

- **The port.** A `FileHandle` is `{ name, createWritable() → { write, close }, getFile() → { lastModified } }`. `pickTarget(dialogs)` asks the desktop dialog, else the browser picker, else answers a download; an abort or an empty dialog is `cancelled`. `existingTarget(handle)` is Save's own file. `writeToHandle(handle, body)` writes, closes and returns the file's `lastModified`. If `close()` resolves `{ lastModified }` the writer uses that and does not call `getFile()`; otherwise it reads `getFile()` once.
- **The desktop shim.** `makeDesktopHandle` (`20f-desktop.js`) resolves `close()` with the `lastModified` that `splitpage:write-file` answered (main stats the file right after `atomicWrite`), so on the desktop the baseline timestamp is the write's own and the second read is gone (F8). A missing or non-finite stamp falls back to `getFile()`. Main still has a short window between the atomic write and its stat.
- **Stamps on the capture.** `writeDoc` sets the Save controls busy (since 6.5 it repairs no records first; save preparation is read-only), and captures with `captureExportDocument({ docId: fork, stamp: { rev + 1, lastEditedBy, lastEditedAt } })`. The new `rev` and the last-edited stamps go on the captured copy, so the bytes carry them without any change to the live document. Then it picks or reuses a target, checks the file's conflict marker against the home captured at the start (unless forced), builds the bytes, and writes.
- **Confirming.** `confirmWrite` runs only if the write landed and `job.owns()` still holds. It gives the live document its `rev` and stamps, sets the baseline, the home's `diskBase` and `lastModified`, the forked id and `docIdWrittenOut`, and clears the dirty flag. No failure, cancel, conflict or build-error path writes to the live document, so a save whose document was replaced mid-write changes nothing in the replacement (F1, F1-abort, F1-dialog, F2). Save As retargets the document only while the job owns it, followed by `job.moved()`; one `finally` undoes a retarget and clears the busy state.
- **A write that landed but is no longer owned.** The bytes are on disk, so the toast "Saved to …" still shows, the coordinator reports the save obsolete, and only the history copy runs: a forked copy's history is copied after any landed write (suite 22 pins this); the id change and `docIdWrittenOut` happen only when owned.
- **Results.** `SAVED`, `COPIED`, `CANCELLED`, `FAILED`, `CONFLICTED` (a refusal) or a `failed` result with the error. A non-Save-As call for a server document delegates to `saveToServer(job)`.

### Import writeback (4.12)

An imported file (`.md`, `.txt` and the like) saves back to its source through the coordinator, on the import destination's own queue.

- `saveBackToFile(opts)` requests `writeback` (or `writebackForce`). The request carries the import home it was made for (`target`, an optional field of `LegacySaveRequest`). The kinds never join.
- `writeBackToFile(job)` is the writer: it builds the bytes with `buildFileData` (captured at its start), checks the conflict marker, writes in place or falls back to a download through `deliverFile`, and answers saved, failed, cancelled or refused. It refuses (`IMPORT_REPLACED`) unless the import named by `target` is still the open one and `job.owns()` still holds, checked before the build, after it and after the conflict check. Without that, a writeback queued behind another would write the new document into a different file once another import had replaced the first while it waited.
- After an acknowledged outcome the import home reads saved from `unsavedFor(imported)`, not from a blanket clear. The download fallback still counts as the import's save. The Save button shows its busy state while a writeback runs, because the coordinator reports it running.
- The bytes are the document as it stood when the writeback began, for every import format, including while the pictures are being loaded (5.1's capture; I3, M5 5.3, reads the stored `.txt`, `.md`, `.csv` and `.docx`).
- It still reads the file a second time after writing (`close()` then `getFile()`); on the desktop the shim now answers the stamp from `close()`, so using it here is a one-line change left for later (4.13's note).

### The hosted writer and the transport (4.14, 4.15)

- **`saveToServer(job)`** (`13-hosted.js`) is the server destination's writer, used for kind `server` and inside `writeDoc`. It builds one transport from `job.operation().connection` and uses it for the missing-blobs check, the blob uploads, the document `PUT` with the base revision and the missing-blobs retry. In review mode it sends the review writes instead of a full `PUT`. On a 409 it merges and retries up to three times, but only while `job.owns()`; after its own merge it calls `job.moved()` so the retry is the same operation (S6, S6-reopen). A call with no job (tests, a direct caller) goes through `requestSave({ kind: "server" })`.
- **The transport** (`server-transport.ts`) holds a frozen copy of the server and token. `request` keeps `apiFetch`'s error mapping unchanged; `get` is the blob GET; `takesBlobs` reads the server's capabilities. `apiFetch`, `apiUrl` and `fetchBlob` are thin wrappers for callers that want the live connection. A tab pointed at another server, or a token changed, mid-save changes nothing about where the rest of the save goes (S3, S4-token).
- **Completion follows the destination record for facts about the place, and the operation for facts about the session.** On a late success the revision and baseline move when the same destination record is still open (`home === op.destination`). Dirty, the merge report and the 409 retry need `job.owns()`. A history restore during an in-flight server save opens a new epoch but leaves the destination record as it was, so that save still updates the tracked server revision and baseline; the next save then sends the restore with the new base revision and does not merge the regretted text back (4.14's choice, kept by 4.18). A same-id reopen makes a new home record, so neither applies (S2). A token change mid-save keeps the home record, so the revision lands; the coordinator judges the save obsolete and `reportObsoleteSave` shows nothing for a server destination, so the document stays dirty and the next save just re-sends.
- **Lifecycle.** The presence poll captures the operation and sends through that connection's transport. A reply that arrives after the document changed hands is dropped and the next beat comes soon (it is the one self-rearming timer the app keeps for the whole session; see `m4-lifecycle.test.mjs`).
- **Open, resume, pull, publish (4.15).** `openServerDoc` and `resumeServerDoc`'s no-merge reopen go through `transitions.open`. `publishToServer` captures an operation context before the upload, sends on that connection's transport, and completes through `transitions.publish`. A publish whose tab left the server shows a sticky warning naming the script and the server that holds it (P1). A publish that lands after the document was replaced, or after the connection changed, is `obsolete` and says so (see "Publish after a token change" in section 8). `pullServerDoc` fetches through `serverTransport(op.connection)` and merges only while `stillOwns(op)` holds; a pull whose connection changed merges nothing and the next presence beat pulls again.
- **The sign-in resume key.** `stashForReload` keeps `splitpage-server-resume` and the stash in sessionStorage so the next page load can reopen the server document and merge the stash back. A resume that is dropped (`"replaced"`) or whose fetch fails leaves both for that next load. Within one page the key belongs to the document that was open when the page first read it or when `stashForReload` wrote it: `resumeServerDoc` honours it only while `sameDocumentAs` that owner holds, so a later `finishServerDetect` in the same page (a PIN join, a collaborate sign-in, a server switch) cannot reopen the server document over a file opened since. The app's own removals of the key forget the owner. Matrix case `T2c-reopen-stale`.
- **`applyMerge`.** The merge step is TypeScript: theirs, mine and base enter through `mergeIncoming` (`merge-incoming.ts`) and the merged `ValidatedDocument` goes to `session.absorbMerged`, which does not run entry a second time (#415; the skipped second migration measured 18.3 ms median on the long demo against 23.6 ms in #384). The screen side of `applyMerge` (snapshots, render, chips, toasts, undo arming) stays in `03-sync.js` for milestone 6's editing migration. It sets its new base through `setBaseState`.
- **Authority (4.16).** `authorityOf` (`authority.ts`) turns the connection's token, role and scope into none, owner, scoped editor or reviewer. `reviewMode()`, `isLinkGuest()`, the Collaborate owner check, the server-menu role checks and the session's edit capability derive from it with the outcomes they had before; server refusals stay authoritative (A1). The Collaborate modal's stale-step check lives in `workflow.ts` (`runIsStale`), and the Drive modal has an epoch that drops a late listing (C3). Credentials stay per server in this browser (INV-62).

### Autosave

`writeAutoSave` refuses unless `autoSaveAllowed()` and the document is dirty, else runs `writeDoc({ auto: true })`.

## 6. Capture (4.6)

`captureExportDocument(opts)` (`14b-export-kit.js`, over `application/save/capture.ts`) reads the session once, synchronously, and returns a frozen `ExportDocument`: the document, the capture time, and core's production index, comment numbers and b-roll entries. It carries no connection, token, link key, handle or path, and no picture bytes: pictures are content hashes. `opts.docId` stamps a different id on the capture, which is how Save As writes a forked id without changing the live document yet. It throws when there is no document.

The exporters take it: `buildSplitpageFile`, `buildMarkdownProject`, `standaloneHtmlFor`, the CSV, DOCX, PDF and XLSX builders and the export dialog, and `exportFacts`. `exportDocumentOf(state)` builds the same shape from a given state; only the formats test hooks in `20d-formats.js` use it.

`writeDoc` captures before its first `await`, so the file's bytes are the document as it stood when the save started. `opts.stamp` (4.11) lays the next `rev` and the last-edited stamps on the capture, like `opts.docId`, so the bytes carry them while the live document keeps its own until `confirmWrite`. `buildFileData` (used by import writeback and the export dialog) builds one export request before its first `await` (5.1, `exportRequest` in `18-local-files.js`): the capture, the resolved options (stage directions, the b-roll view, the image-bundle choice) and the asset request; the capture itself carries the clock setting (`clockMode`). Providers come from the format registry (`14e-export-formats.js`, milestone-5.md step 4) and are called with the document, the options, the held assets and the ports they need. The writers read nothing else: no stored preference, panel state or live row.

**Assets (5.1).** The asset request (`src/application/export/assets.ts`) is the capture's picture hashes and the asset source fixed at that moment: `blobSourceNow()` (`13-hosted.js`) binds a server document's pictures to the transport of the connection the export started on, so a tab that moves to another server mid-export still fetches from the first. The source is a function, not a credential, and it stays outside the `ExportDocument`. `loadExportAssets` resolves the request once (`ensureBytes` with that source) into a frozen asset map, `picture(sha)` and `missing`; every writer takes its pictures from the map, and a picture missing from it is left out as before (the HTML export's warning counts `missing`). The PDF's JPEG preparation (`pdfImagesFor`, `pdfCommentImagesFor`) decodes from the map.

**Dates (5.1).** An export's date is the local calendar day of the capture time, at midnight (`exportDay`). The PDF's `/CreationDate`, the `.docx` and `.xlsx` `docProps` dates, the printed dates of the packing and shot lists, and every ZIP entry (DOS time 0, the captured day's date) come from it, so an export captured before midnight and written after keeps its day (INV-60). `zipWrite` with no day writes 1980-01-01, never the clock. `saveToServer` and `publishToServer` do not use a capture: they clone the state and send through a transport built from the operation's connection.

## 7. Restore and adoption (4.17, 4.18)

Restoring recovered work never saves it (INV-40, INV-41, INV-51), and a restore that finishes late changes nothing.

- **Entry points.** A file draft's applied branch goes through `transitions.restore` after `adoptProjectState` has opened the file, so the baseline stays the file's and is written once, by the open. An unsaved copy of a file, import or server draft is a detached `transitions.recover`: it mints the new id and the history copy uses `forkedFrom`. A history version is `transitions.restore({ raw })`. A restored draft schedules no save: the session's save effect (`12-dirty-toast.js`) arms no autosave for a `recovery` settle, and the merges decide their own (they queue an autosave or halt it). So a restored draft reaches the file with the user's next edit or Save (T5, T6). One side effect: "Undo merge" after a server conflict no longer autosaves a couple of seconds later, which matches its text ("Your version is back, unsaved…").
- **Two exceptions to "restoring never saves".** Both are deliberate. (1) Restoring a history version is a version the user chose, not recovered work: `restoreSnapshot` (`03-sync.js`) calls `queueAutoSave()` after a restore unless the caller passed `opts.local`. INV-41 is about drafts. (2) A hosted save that was in flight when the restore happened still finishes and advances the restored destination's revision and baseline (4.14's choice, kept by 4.18: `transitions.restore` leaves the destination record as it was, so the late save's revision lands on it; `hosted-save-reopen-app.test.mjs` pins it). The next save then sends the restore on top of that revision instead of merging the regretted text back. A restore itself leaves the destination's confirmed generation as it was.
- **Ownership.** `restoreOwnership` (`restore-policy.ts`) is `stillOwns` relaxed like the save coordinator's `saveOwnership`: a changed connection counts only on a server document, so a server detect finishing during a desktop boot restore does not refuse it. `captureRestore` and `stillRestoring` are exported by the recovery bridge. `restoreFileDraft` captures before its first `await` and checks after the read and the parse; `restoreSnapshot` (history) checks after each `await`, in place of the old id comparison (K1, H1).
- **A late restore.** When a file-draft restore no longer owns the document, it changes nothing, shows "Another script was opened while the changes from the last session were being restored — they have been kept for the next launch." and returns the outcome `kept`. A late history restore answers "changed". On the desktop, main's `splitpage:draft-restore-done` handler maps the outcome through `restoreDoneAction` (`desktop/drafts.js`): `failed` keeps the draft and opens the tab's file (the draft is unreadable); `kept` keeps the draft and drops the tab's pending file open (it would otherwise be opened over the script the user just opened); anything else releases the draft. There is no preload or IPC change.
- **The kept draft's lifetime.** It stays held for the rest of the session, so the new script's own draft writes are refused (`HELD`) and crash recovery shows as paused. It survives a normal close. If the user closes the tab or quits and answers "Don't save" for the new script, `discardForUserDecision` deletes the tab's folder, the kept draft included (the same as the unreadable-draft path), so "kept for the next launch" holds unless the user then discards the new script.
- **The pristine check (#483, T3).** `neverWrittenOut(doc)` (`pristine.ts`) is true when there is no revision and the editor name is empty once trimmed. `loadInitialState` applies it to the raw state data and then to the migrated document, and the resume check in `21-events.js` applies it to the loaded document, so a whitespace-only name no longer makes the two disagree.
- **Capture scheduling (B4b).** `capture-schedule.ts` owns the quiet timers (1.5 s idle, 5 s maximum, 15 s for large documents), the pending flag and the retry backoff (5 s doubling to 60 s). A refused write cancels the quiet timers a change armed while it was in flight, and a quiet timer never captures while a retry is armed. `20g-drafts.js` keeps the capture and the write and calls the schedule.
- **Draft writer (4.17).** `draft-writer.ts` records the operation context and the key at capture time; a late write neither removes nor claims another document's key (B1), and a writer discards only the generation acknowledged to it (B7). The stores are adapters (`src/adapters/storage/`); takeover with and without Web Locks is as before (D12, B3).
- **Left as is.** The server draft resume adopts through `resumeServerDoc` → `transitions.open`; its fallbacks to an unsaved copy wait on the server and the hosted code can change the destination before it answers, so an ownership check there would turn a revoked link (B9) into a lost copy. The merge branch of `restoreFileDraft` (`applyStashedWork`) awaits only its undo-point snapshot after the open and is not re-checked.

## 8. Known gaps and exceptions

Things the code does today that the plan says will change, or that a reader would not guess. Each is either a deliberate scope limit of milestone 4 or a note carried to milestone 6.

- **Planned for 4.x: one owner for save completion, and the rest of the recovery extraction.** Consolidating completion decisions and projection updates behind one application owner, and moving the remaining orchestration and restore decisions out of `20g-drafts.js`, are 4.x follow-ups, not part of milestone 5 or 6 (plan section 8, from the external review of milestone 5's plan, 2026-10-14). Milestone 5 preserves the boundary: format providers build bytes and report diagnostics and never acknowledge a save, adopt a document or retarget a destination.
- **Writers still end their own saves.** `writeDoc`'s `confirmWrite`, `saveToServer`, `publishToServer` and the server open and resume paths set `S.baseState` through `setBaseState` and clear dirty themselves, guarded by `S.editSeq`, `job.owns()` or the transition's ownership check. The coordinator also advances the confirmed generation when a `saved` result passes `stillOwns`. The two agree in the cases tested but are separate steps; `S.dirty`, `S.baseState` and the Save buttons stay projections.
- **`sendReviewWrites` uses the live connection.** In review mode `saveToServer` builds a transport from the live connection for each comment, not from the job's captured one, so a token change between two comments of one review save would put the new token on the later ones (note on PR #564). No matrix row covers it and the path is unlikely; a fix passes `job.operation().connection` through. Recorded, not fixed in milestone 4: it is in the save path and the step was not an Opus step.
- **`publishToServer`'s own role check stays inline** (`conn.role === "review"`, 4.15's function); 4.16 left it as it was.
- **Publish after a token change on the same server.** `stillOwns` compares the connection instance, which `updateConnection` replaces on a token or role change, so a publish that lands after such a change is treated as obsolete. 4.22 gave that case its own toast (see the matrix case P1-token): "Published “{title}” to the server, but your sign-in changed while it was uploading, so this script was left as it was. …". The behaviour is the broad ownership rule Adam kept in 4.20.
- **`applyMerge`'s screen side is not TypeScript.** Only the merge step moved (4.15). Snapshots, render, chips, toasts and undo arming stay in `03-sync.js` for milestone 6, where the rest of `applyMerge` is a named step with an options table ([milestone-6.md](milestone-6.md), step 6.6). Moved UI routes keep the save, restore and export invariants above: no feature owner writes or acknowledges an export itself, restore keeps its transaction kind and autosave suppression with only the two exceptions of section 7, and an export request keeps one capture before asynchronous preparation.
- **Web file destinations are keyed by handle identity.** The same file picked a second time gives a different handle object, hence a different queue and a separate confirmed generation. Desktop files are keyed by their desktop id.
- **Autosave timers and the halt state stay in `14-export.js`.** `autoSaveWhere` and `autoSaveMay` (`autosave.ts`) are pure: where autosave writes (only a picked file or the server; never a downloaded copy, an `.html` project, a signed-out session or a turned-off link) and whether it may run. The idle and maximum timers, `autoSaveHalt` and `haltAutoSave` are legacy state passed in.
- **One status selector.** `saveStatus(input)` (`status.ts`) returns the status line and the Save button view, `saveStatusView` in `12-dirty-toast.js` renders the line from it, and `setSaveButtons` renders the buttons from `saveButtonView`. The inputs (`dirty`, `halted`, `target`, `signedOut`, `linkOff`) are still read from legacy globals when the view is built.
- **Obsolete saves are reported, not re-queued.** A save that lands after its document moved on is not retried, and a landed file save still shows "Saved to …". Legacy writers apply their own completion for it only while they own the document.
- **The Drive modal's folder navigation.** C3 covers closing the modal; moving between folders inside an open Drive modal does not bump the epoch, so two quick folder clicks can still race (note on PR #566).
- **Duplicated constant.** `REVIEW_REFUSAL_REASON` (`authority.ts`) and `REVIEW_ONLY` (`session-bridge.ts`) hold the same value; one constant would be safer.
- **Blobs.** `02c-blobs.js` delegates to `adapters/storage/blob-store.ts` (4.19). The writers call `ensureBytes` before they write and `sendWithBlobs` and `uploadBlobs` for the server; neither runs under the operation context.
- **App-lifetime subscriptions.** No app module subscribes to the live session; the replacement listener of section 3 is the one app-lifetime hook, and the listeners, observers and the presence timer that live for the whole session are named in `src/test/m4-lifecycle.test.mjs`.
