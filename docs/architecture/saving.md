# Saving

The as-built description of the operation context, the document transitions and the save coordinator, on `4.0-development` at `f0ae41a` (the merge of PR #562). It covers milestone 4's PRs 4.6 (capture contract, #557), 4.8 (operation context and transition API, #555) and 4.9 (save coordinator, #562), and says where 4.17 (draft stores), 4.19 (blob store) and 4.20 (continuations) touch saving. [Milestone 4](milestone-4.md) is the plan; this file says what the code does today. Where the two differ, a sentence says so, and "Known gaps and exceptions" collects them. Step 4.22 revises this file once the later save lanes have landed, so a gap listed here may be closed by then.

The code lives in `src/application/session/operation.ts`, `src/application/transitions/` (`transitions.ts`, `ports.ts`), `src/application/save/` (`coordinator.ts`, `status.ts`, `autosave.ts`, `capture.ts`), `src/legacy/transition-bridge.ts` and `src/legacy/save-bridge.ts`. The legacy side is in `src/js/14-export.js` (the file writer and the adapter ports), `13-hosted.js` (the server writer), `03-sync.js` (the destination port and `setBaseState`) and `12-dirty-toast.js` (the dirty flag and the save controls). It names functions and types, not lines.

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

`stillOwns(ctx)` is true while the epoch, the document id, the destination identity and the connection instance all equal what the context captured. It does not compare the two generations or the revision: those are for the code that holds the context to read. There is no authority field yet (4.16 adds it).

Two things make the comparison strict on purpose:

- A connection is an instance. `updateConnection` in `_home.js` returns a new frozen connection, so a changed token, role or scope is a different connection. Code that asks "the same server?" uses `stillOnServer(c)` or `serverOf(c)`, not `===`.
- A destination is the `home` record itself. `setHome` builds a new record every time, so any retarget, even to the same file, changes the identity.

Callers outside saving use it for work that waits: the pasted-picture and dropped-picture continuations in `06-rows.js` and `21-events.js`, the gallery in `05e-gallery-overlay.js`, the video record in `05v-video.js` and the annotator's save in `05w-annotate.js` (4.20). Each captures before its first `await` and refuses on `!stillOwns(ctx)` with the toast the plan's D11 names. The draft writer (4.17) captures at the start of each draft write and calls the result obsolete when ownership moved.

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

### Who calls them today

| Caller | Method |
| --- | --- |
| `replaceWithNewDocument` (`18b-file-menu.js`): the demo, a starter, a blank script from the file menu | `startNew` with `NO_DESTINATION` |
| `adoptNewDocument` (`20j-newtab.js`): a new document in this tab | `startNew`, with `NO_DESTINATION` only if the tab was on a file or an import |
| The boot load in `21-events.js`, when stashed work changed the loaded document | `open` |

`restore`, `recover` and `publish` exist and have application tests (`tests/application/transitions.test.ts`), but no app code calls them yet. See section 7.

## 4. The save coordinator

`createSaveCoordinator(ports)` owns a queue per destination, a confirmed generation and baseline per destination, and the rules for which completions count. It holds no document and calls no legacy code except through its ports.

### Requests, queues and joining

`request(r)` returns a promise of a `SaveOutcome`. It puts the request on the queue of the destination current *now*, keyed by `DestinationKey` (`owner` and `name`, from the destination port's `keyOf`). A queue runs one writer call at a time, in order. A request that arrives while an earlier one is *waiting* (not running) may be joined into it: the `join` port decides, and a joined request returns the same promise as the waiting one. Nothing joins into the running call.

`joinSaves` in the save bridge is the legacy rule. The plain kinds are `save`, `auto`, `autosave` and `server`. Two of the same kind join as that kind. Two automatic kinds (`auto`, `autosave`) join as `auto`. Any other pair of different plain kinds joins as `save`, so `server` with `save`, `auto` or `autosave` also becomes `save`. `saveAs` and `force` never join.

### One run

When a queue starts a request it fixes three things before calling the writer:

1. The change count now (`job.generation`), which is the generation this save will confirm.
2. An `OperationContext`, from the ownership port's `capture`.
3. A `SaveJob`: `request`, `generation`, `operation()` (the captured context) and `moved()`.

`moved()` recaptures the context. A writer calls it when it deliberately changes the destination mid-run, which Save As does when it retargets the document to the file just picked. Without it the run would see its own retarget as a loss of ownership.

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
| `writer.write` | `writeQueued`: kind `autosave` goes to `writeAutoSave`, kind `server` to `saveToServer`, every other kind to `writeDoc` |
| `destination.current` | `home` |
| `destination.keyOf` | `destinationKeyOf`: no destination is one shared key; a server document is keyed by the server and `doc:<id>`; a desktop file by its desktop id; a browser file by its handle object |
| `report.obsolete` | `reportObsoleteSave`: a toast, only when `here` is true, the destination is not a server and a document is open: "An earlier save of “{title}” finished after you reopened it. Your open copy is unchanged." (D10) |
| `report.running` | `showSaveRunning` |
| `ownership` | `saveOwnership` wrapping the operation context (below) |
| `join` | `joinSaves` |

`saveOwnership` relaxes `stillOwns` for any destination that is not a server (a file, an import, a download, or no destination): if the epoch, document id and destination are unchanged, a changed connection does not make the save obsolete, because a file save never used the connection. A server destination keeps the strict rule, so a token or server change during a hosted save is obsolete.

## 5. The front door and the writers

`saveDoc(opts)` in `14-export.js` is the entry for the Save action, the desktop menu's Save, Save As, force overwrite and every direct caller. It resumes autosave (unless the call is automatic) and returns `requestSave({ kind })`, with the kind from `saveKind(opts)`: `saveAs`, `force`, `auto` or `save`. `queueAutoSave` requests `autosave`, or puts the autosave back on its timer when another save is already running. `publishAndCopyShareLink` requests `server`. The save-error retry, the conflict overwrite and copy, `flagLinkOff`'s copy and `openPrompterElsewhere`'s save reach the same queue through `saveDoc`.

The writers are still the legacy code; the coordinator only orders them and judges their results.

- **`writeDoc`** (`14-export.js`): the file, Save As, download and hosted-Save-As writer. It runs `settleDerivedRecords`, sets the Save controls busy, bumps `rev` and the last-edited stamps on the live document, captures with `captureExportDocument`, and puts the file's bytes together from the capture (`buildSplitpageFile` or `buildMarkdownProject`). It picks the target (a handle, the desktop dialog, or a download), checks the file's conflict marker unless forced, writes, then sets the baseline, the file's `diskBase` and `lastModified` and the dirty flag itself when the document is still the same one. It touches the file chip only when a save retargets an import. It returns `SAVED`, `COPIED`, `CANCELLED`, `FAILED`, `CONFLICTED` (a refusal) or a `failed` result with the error. For a server document, a non-Save-As call delegates to `saveToServer`.
- **`saveToServer`** (`13-hosted.js`): the hosted writer, used for kind `server` and inside `writeDoc`. In review mode it sends the review writes instead of a full `PUT`. Otherwise it clones `S.state` (not a capture), sends blobs and the document `PUT` with the base revision, and on a 409 merges and retries up to three times. On success it moves `home.rev`, sets the baseline with `setBaseState` and clears dirty if no edit came in since. If the document or destination moved during the send, it returns success without touching them, and the coordinator then judges the save obsolete.
- **`writeAutoSave`**: refuses unless `autoSaveAllowed()` and the document is dirty, else runs `writeDoc({ auto: true })`.

## 6. Capture (4.6)

`captureExportDocument(opts)` (`14b-export-kit.js`, over `application/save/capture.ts`) reads the session once, synchronously, and returns a frozen `ExportDocument`: the document, the capture time, and core's production index, comment numbers and b-roll entries. It carries no connection, token, link key, handle or path, and no picture bytes: pictures are content hashes. `opts.docId` stamps a different id on the capture, which is how Save As writes a forked id without changing the live document yet. It throws when there is no document.

The exporters take it: `buildSplitpageFile`, `buildMarkdownProject`, `standaloneHtmlFor`, the CSV, DOCX, PDF and XLSX builders and the export dialog, and `exportFacts`. `exportDocumentOf(state)` builds the same shape from a given state; only the formats test hooks in `20d-formats.js` use it.

`writeDoc` captures after `settleDerivedRecords` and the `rev` bump and before its first `await`, so the file's bytes are the document as it stood when the save started. `buildFileData` (used by `saveBackToFile` and the export dialog) captures at its start. `saveToServer` and `publishToServer` do not use a capture; see section 7.

## 7. Known gaps and exceptions

Things the code does today that the plan says will change, or that a reader would not guess.

- **Writers still end their own saves.** `writeDoc`, `saveToServer`, `publishToServer` and the server open and resume paths set `S.baseState` through `setBaseState` and call `clearDirty` themselves, guarded by `S.editSeq` and, for files, a document-id check. The coordinator also advances the confirmed generation when a `saved` result passes `stillOwns`. The two agree in the cases tested but are separate steps. The file writer moves in 4.11, the hosted writer in 4.14.
- **The live document is touched on failure paths.** `writeDoc` bumps `rev` before it writes and puts it back in each failure branch. The plan's rule that `rev` moves only on a confirmed write is 4.11's (F1, F2 open).
- **The hosted writer is not captured and not owned per operation.** `saveToServer` clones `S.state` and reads `home` and `conn` as it goes, and a PUT's blobs and the PUT itself are not tied to one connection. The same-id reopen after a send and the 409 retry in the wrong session are open (S3, S4-token, S6-reopen). 4.14 adds a transport per operation.
- **`applyMerge` writes `S.baseState` directly** (`03-sync.js`), not through `setBaseState`, when it is given a new base. 4.15 moves it.
- **`publishToServer` does not use `transitions.publish`.** It calls `setHome` and `setBaseState` itself, and a publish whose connection changed reports the old server's document (P1). `saveBackToFile` builds its bytes through `buildFileData` but completes without the coordinator, and it sets neither the baseline nor the dirty count: it clears the import's own `dirty` flag and updates the file chip (4.12, I2).
- **Most opens do not use the transitions.** Opening a file (`adoptProjectState`, `loadFileIntoEditor`), a server document (`openServerDoc`, `resumeServerDoc`), restoring a draft or history, and recovery all assign `S.state`, set `home` and set the baseline in their own code. Only the three callers in section 3 use the API. The session sees the other documents through its adoption callback from 12a. 4.12, 4.15 and 4.18 move them.
- **Web file destinations are keyed by handle identity.** The same file picked a second time gives a different handle object, hence a different queue and a separate confirmed generation (4.11, 4.13). Desktop files are keyed by their desktop id.
- **Autosave timers and the halt state stay in `14-export.js`.** `autoSaveWhere` and `autoSaveMay` (`autosave.ts`) are pure: where autosave writes (only a picked file or the server; never a downloaded copy, an `.html` project, a signed-out session or a turned-off link) and whether it may run (on, not halted, has a target). The idle and maximum timers, `autoSaveHalt` and `haltAutoSave` are legacy state passed in.
- **One status selector.** `saveStatus(input)` (`status.ts`) returns the status line and the Save button view, `saveStatusView` in `12-dirty-toast.js` renders the line from it, and `setSaveButtons` renders the buttons from `saveButtonView`. The inputs (`dirty`, `halted`, `target`, `signedOut`, `linkOff`) are still read from legacy globals when the view is built.
- **Obsolete saves are reported, not re-queued.** A save that lands after its document moved on is not retried. Legacy writers also apply their own completion for it (for example a late file write still sets its own baseline only when the document id matches).
- **Ownership has no authority yet.** Who may edit or save (the collaboration authority model) is not part of the context. 4.16 adds it.
- **Blobs.** `02c-blobs.js` now delegates to `adapters/storage/blob-store.ts` (4.19). The writers call `ensureBytes` before they write and `sendWithBlobs` and `uploadBlobs` for the server. Neither runs under the operation context.
