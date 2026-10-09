# Milestone 4: save completion, session transitions and recovery

The working plan for milestone 4 of [the implementation plan](../IMPLEMENTATION-PLAN.md#4--centralize-save-completion-session-transitions-and-recovery), as amended by the approved [re-scope](milestones-4-7-rescope.md) and the [milestone 3 gate record](milestone-3-gate.md#external-review). It was derived from `4.0-development` at `f66789a`. It names functions, not lines.

Status: approved by Adam on 2026-10-08. Derived from `f66789a`; the base is now `1aa1eed`. His answers to the draft's seven questions and the gate's list of repaired defects are D9 to D16 under [Decisions](#decisions). [Questions for Adam](#questions-for-adam) lists what is still open.

## Goal

Make every save, every document replacement and every recovery an operation with an owner, so that a completion can only acknowledge what it captured and only in the session that started it.

- **Capture.** Before the first `await`, a save captures the document and its operation context: session epoch and document id, destination identity and generation, edit generation, connection instance, authority, and server revision. The serializers the save paths call take the captured document (the frozen `ExportDocument`), never the live one.
- **Complete.** A save coordinator serializes writes per destination. Each destination has its own confirmed generation and baseline. A completion updates live state only when ownership still matches; a write that landed for an obsolete operation is reported, never adopted.
- **Transition.** One transition API adopts open, new, restore and publish, keeps the identity and fork rules, and is the only writer of the live document's identity.
- **Recover.** Recovery is split into capture scheduling, store adapters, writer ownership and restore policy.
- **Prove it.** A controlled race matrix, built first, fails where today's code is wrong. Each PR turns its cases green. At the gate every case passes.

Alongside: collaboration behind application interfaces with an explicit authority model; the blob registry in a store adapter with owned bytes (#320 measured first); operation identity for every document-scoped continuation (#478); observational effects (#479); a distinct outcome for a command that committed and then threw; the render invariant tests and the atomic render (#463).

## Decisions

| # | Decision | Source | Where it lands |
| --- | --- | --- | --- |
| D1 | Milestone 4 keeps the full gate: the full Windows browser run (freeze off and on), the Electron dev smoke, the x64 packaged check and the external review | Adam, 2026-10-07 (plan §0, §4) | [The gate](#the-gate) |
| D2 | Sonnet by default. Opus for state ingress or serialization, durable storage (drafts, history, recovery), preload/IPC, close/quit, merge, and the editing hot path or undo adapter. Every review is Opus. Each PR below is marked | Adam, 2026-10-07 (plan §2) | [PRs in order](#prs-in-order) |
| D3 | The new owners (save coordinator, transition API, store adapters) are built by explicit functions that take their ports. None is a module-evaluation singleton with permissive or no-op defaults | Adam, 2026-10-08 (milestone 3 gate) | Every owner PR; E12 |
| D4 | In save completion, the open/new/restore/publish transitions, browser drafts and recovery, and the collaboration save paths, there are no standalone bug lanes: each bug there becomes a failing race-matrix case inside milestone 4. Exception: cheap data loss reachable today. Bugs outside that code (desktop main, merge, undo, render) are fixed alongside as usual | Adam, 2026-10-08 | [Issue classification](#issue-classification) |
| D5 | Characterisation-only PRs only for hot paths and multi-file moves. A small move carries its own characterisation tests in its first commit, and the PR body states the base sha they passed on | Adam, 2026-10-07 (plan §2) | Every PR |
| D6 | The race matrix comes first. It is built early, with its cases failing where today's code is wrong and passing where it is right, and each later PR turns cases green | Adam | 4.0 to 4.3 |
| D7 | #463: the "rendering creates no edit" invariant (plan §6) is defined as tests first | Adam | 4.4, then 4.21 |
| D8 | #320 is measured with `tools/perf-record.mjs` on `d18adde` and `c4d5944` before the blob registry moves | Adam (plan §5, milestone 4) | 4.5, then 4.19 |
| D9 | Opening a `.html` file over the parse bound (#465's question, #501): keep the bound for the page body and read the embedded script data from the raw text before the bounded parse. No file that opens today is refused | Adam, 2026-10-08 | 4.12; T4 |
| D10 | A save that lands after its document was replaced or reopened shows a warning toast only when it landed in the place the open document now saves to (a same-id reopen); nothing when it went to another document's place. The toast's wording comes back to Adam with 4.9 | Adam, 2026-10-08 | 4.9, 4.14, 4.15 |
| D11 | A pasted or dropped picture that finishes loading after the document was replaced or reopened is dropped with a toast; the wording comes back to Adam with 4.20. When the same document was edited while it loaded, it goes in at the place captured when the paste began if that cell is unchanged since, otherwise at the end of the cell | Adam, 2026-10-08 | 4.20; M1 to M3 |
| D12 | Without Web Locks a browser draft is taken over as today (every other writer counts as dead), pinned by a test | Adam, 2026-10-08 | 4.17; B3 |
| D13 | A command that committed and then threw shows nothing new: the error goes to the existing error reporting, and the document stays marked unsaved | Adam, 2026-10-08 | 4.7; E2 |
| D14 | #508: when the desktop close check throws, the window stays open, the flag is reset so the next close asks again, and the error is reported | Adam, 2026-10-08 | alongside |
| D15 | #500: "Review" on a clean tab whose file was moved shows the moved-file notice the tab gets on close, with its Save As choice | Adam, 2026-10-08 | alongside |
| D16 | The gate's "existing five repaired defects" are #247 and #248 (`publish-in-flight.test.mjs`), hosted Save As (#249, suite 249), import writeback with a late edit (#251, `261-import-save-back-late-edit.txt`), and a failed Save As not retargeting Save (`22-doc-id.txt`) | Adam, 2026-10-08 | [The gate](#the-gate) |

## Exit criteria

| # | Criterion | Shown by |
| --- | --- | --- |
| E1 | Each destination has its own confirmed generation and baseline. The save status every Save control renders comes from one selector (INV-20) | Coordinator application tests with fake ports; suites 06, 283, 285; matrix groups F, S |
| E2 | A save captures its operation context before its first `await`: epoch, document id, destination identity and generation, edit generation, connection instance, authority, server revision | Application tests of `captureOperation`; matrix rows "document switch", "same-id reopen", "destination or connection changed" in every group |
| E3 | Writes are serialized per destination. One transport instance owns an operation's blob transfer and its write. A completion acknowledges only the accepted snapshot, and only while ownership matches; an obsolete write that landed is reported, not adopted. Cancellation is not proof that a write failed | Matrix rows "out of order", "connection changed", "409", "write failure"; INV-52's case (a failed or cancelled upload writes no record) |
| E4 | One transition API adopts open, new, restore and publish, with today's identity and fork rules (INV-36). `S.state` assigners fall from 9 to 2: the prelude's initial `null` and the live-document port the transition bridge is handed | INV-36's application tests; matrix group T; `node tools/dep-report.mjs --metrics` |
| E5 | Hosted Save As is a copy that acknowledges no server edit and keeps its merge ancestor. Import writeback acknowledges only its own destination and bytes. A failed or cancelled save never retargets Save | Matrix cases C1, I1, I2, F3; suites 22, 249, 261 |
| E6 | Collaboration runs behind application interfaces with an explicit authority model (owner, scoped editor, reviewer). Modal stale-completion checks stay. The server stays authoritative, and a client capability never broadens a link's permission | Authority application tests; suites 18, 43, 59, 260 to 264, 361; `tools/test-server.mjs` unchanged |
| E7 | Recovery is split into capture scheduling, store adapters, writer ownership and restore policy. A writer discards only the draft generation acknowledged to it. Restoring never saves (INV-40, INV-41, INV-51) | Matrix groups B, K, H; `browser-drafts.test.mjs`, `desktop/test/drafts.test.mjs`; suites 26, 63, 265; desktop smoke `draft:` and `history:`; recovery cases for multi-tab ownership, quota, unavailable and corrupt storage, offline images, restart and revoked links |
| E8 | The capture contract: `buildSplitpageFile`, `buildMarkdownProject`, `standaloneHtmlFor`, `toMarkdownDoc` and `exportFacts` take the captured `ExportDocument`, which carries core's production, comment and b-roll read models. Run with the live document mutated after capture, each produces the captured bytes | Matrix group X; the format goldens and INV-60 unchanged |
| E9 | A document or tab replacement leaves no document-owned handler, timer, observer, subscription or object URL behind. The test calls the owners' own dispose, advances a fake clock, settles pending work, never relies on `src/test/_app-boot.mjs`'s housekeeping, and names each app-lifetime subscription that survives | The lifecycle test, matrix group L |
| E10 | Every document-scoped continuation (delayed paste or drop, gallery picture, thumbnails, annotator, recovery capture) captures the epoch and document id before its `await` and refuses to complete in another epoch (#478) | Matrix group M |
| E11 | Effects are observational: no effect writes document content (#479). A command that committed and then threw in undo recording, an effect or a listener has its own reported outcome and is never rolled back | Matrix group E; `runConfined` with the real effects |
| E12 | D3: each new owner is built by an explicit constructor that takes its ports. Calling an owner before it is started throws; it never runs on defaults | Per-owner tests; an architecture test, added in 4.8 and extended by 4.9 and 4.17, that importing `src/application/save`, `transitions` and `recovery` constructs nothing |
| E13 | Rendering creates no edit (plan §6, #463), and the atomic render keeps it while drawing off-screen | 4.4's tests; `67-render-perf.txt` and `perf-record` typing and render medians within noise |
| E14 | The blob store hands out bytes the caller owns. #320 is measured, and trimmed if the image-heavy median is more than 10% slower than `d18adde` | The byte-ownership test; [performance-record.md](performance-record.md) rows for `d18adde`, `c4d5944` and the closing tree |
| E15 | Credentials, invitation fragments and native handles never enter a captured document, an export, a draft record or recovery metadata (INV-29, INV-62) | Application test: capturing and serializing a session with a live connection yields no token, PIN or key |
| E16 | Gate | [The gate](#the-gate) |

## Where M4 starts (measured)

`node tools/dep-report.mjs --metrics` on `f66789a`: 154 frontend modules, 77 migrated; one runtime cycle of 53 modules and 411 edges; `S` with 54 importers, 31 writers, 26 field writers and 9 `S.state` assigners; 630 baseline entries, 0 new. 192 browser suites. The sixteen legacy modules in scope hold 11,078 lines, `13-hosted.js` alone 2,485.

**Who completes a save today.** Each path writes its own completion. There is no per-destination queue.
- `saveDoc` (`14-export.js`) is the file, Save As, download and hosted Save As path, in the browser and on the desktop. Before any `await` it runs `settleDerivedRecords` (a registry heal and b-roll repair on the live document, #325), raises `S.state.rev` and the last-edited stamps on the live document, then clones it. Its awaits: the save dialog (`saveFileDialog` or `showSaveFilePicker`), `checkFileConflict`, `ensureBytes`, `createWritable`/`write`/`close`, and `getFile` for the timestamp. Its completion writes `S.baseState` (`setBaseState`), the home's `diskBase` and `lastModified`, the document id fork (`adoptSavedCopyDocId`) and `clearDirty`. After the awaits it re-reads `S.state.docId`, `S.editSeq`, `home` by identity and `S.dirty`. Every failure and cancel path lowers `S.state.rev` on whatever document is live by then.
- `saveToServer` (`13-hosted.js`) clones the document and captures `docId`, `seqAtSave` and the base revision. Its awaits: the blob checks and uploads (`sendWithBlobs`, `uploadBlobs`), the document `PUT`, and on `missing-blobs` a second upload and `PUT`. Afterwards it checks only `serverHomeId() !== docId`, then writes `home.rev`, `setBaseState` and `clearDirty`. A 409 merges the live document through `applyMerge` and retries.
- `publishToServer` creates the server document through the same chain, checks `via !== conn` and the document id, and on a changed connection returns `false` with no report, leaving the created document orphaned.
- `saveBackToFile` (`18-local-files.js`) builds the bytes through `buildFileData`, which awaits `ensureBytes` and reads the live document, and only then records `docIdAtBuild` and `seqAtBuild`. It clears only the import home's own `dirty`, which `261-import-save-back-late-edit.txt` pins: import writeback already acknowledges only its destination.
- Only autosave is single-flight (`saveInFlight`, `saveQueued` in `queueAutoSave`). The Save action is disabled by `S.saveButtonBusy`; the desktop menu's Save clicks that same action (`runDesktopMenuCommand`). Four callers bypass it and call `saveDoc` directly: the save-error retry, the file-conflict overwrite and copy (`21-events.js`), `flagLinkOff`'s copy (`13-hosted.js`), and `openPrompterElsewhere` (`20f-desktop.js`), which saves a dirty document before opening the prompter in the browser. `publishAndCopyShareLink` (`13-hosted.js`) calls `saveToServer` directly, bypassing `saveDoc`, `S.saveButtonBusy` and `settleDerivedRecords`.

**Transport.** `apiFetch`, `apiUrl`, `fetchBlob`, `serverTakesBlobs` and the blob uploads read the mutable `conn` export at every request. If the tab is pointed at another server mid-save, the rest of the uploads and the final `PUT` go there. `updateConnection` (`_home.js`) changes the token, role and scope of the same `conn` object, so no `via === conn` check sees them change.

**Adoption.** There are 14 `S.state =` sites in nine modules: two assign `null` (the prelude's initial value and the boot reset), and twelve adopt a document: `adoptRestoredState` (`02b-doc-id.js`, history restore), `applyMerge`'s inner `adopt` (`03-sync.js`: server conflict, pull, resume, stash and file merges), `adoptProjectState` and `loadFileIntoEditor` (`18-local-files.js`), `replaceWithNewDocument` (`18b-file-menu.js`), `adoptNewDocument` (`20j-newtab.js`), `resumeServerDoc` and `openServerDoc` (`13-hosted.js`), `recoverDraftAsUnsavedCopy`, `restoreFileDraft` and `adoptUntitledDraft` (`20g-drafts.js`), and the boot load (`21-events.js`). Publish never replaces the document; it changes the document id and the home. None of these calls the session. The session adopts lazily: 12a's `trackDocument` notices a new `S.state` identity at the next render, read or command and calls the adoption hook, so the epoch lags the assignment. `loadFileIntoEditor` and `restoreSnapshot` even run `markAbsorbedDirty` before that render, under the old epoch.

**What a continuation checks after an `await`.** Every legacy check compares `S.state.docId`, `S.editSeq` or an object's identity. Nothing outside tests reads the session's `epoch()` or `generation()`; the only accessor is `liveSession()`. So a same-id reopen passes every check: `saveToServer`'s, `saveDoc`'s `stillOurs`, `restoreSnapshot`'s `moved()`, and `thumbnailsAfterPaste`'s. `insertIntoScriptCell` and `handleImageFile` (#478) and `retryThumbnail` check no document at all.

**Serializers.** `buildSplitpageFile` and `standaloneHtmlFor` take a document, fall back to `S.state` when given none, and read the blob registry for pictures. `buildMarkdownProject` takes one, but its tail (`appendMarkdownTail`: `breakdownRows`, `commentEntries`) reads the live document. `toMarkdownDoc` and `exportFacts` take none; `toMarkdownDoc` reads `S.state.rows`, `exportFacts`, `sceneFacts`, `commentNumbers`, the picture helpers and `appendExportTail`. `buildFileData` awaits `ensureBytes` on the live document and dispatches to builders that take no document.

**Drafts and recovery.** `noteDraftChange` (from the session's `draft` effect and from `setSaveButtons`) schedules `captureAndSendDraft`: 1.5 s idle, 5 s maximum, 15 s for large documents. It captures `JSON.stringify(S.state)`, the edit sequence and the base synchronously, then awaits `persist` and the store. Browser drafts exist only for hosted documents. `createIdbDraftStore` is a lazy module singleton, injected only through a test hook. Writer ownership is a Web Lock per page (`holdBrowserWriterLock`, `browserWriterIsLive`); without `navigator.locks` every other writer counts as dead. `browserWriteDraft` reads the key recorded when the write starts, after `persist`, and removes it once the write succeeds, so it can remove a key recorded since the capture. Restores (`restoreFileDraft`, `adoptUntitledDraft`, `recoverDraftAsUnsavedCopy`, the server draft through `resumeServerDoc`) re-check nothing about the live document across their awaits apart from `draftRestorePending`. On the desktop, main's draft store (`desktop/drafts.js`) refuses stale writes by epoch and sequence (`STALE_SEQ`) and discards both generations once a tab is clean.

**Blobs.** `recordFor` and `intern` return fresh records; `bytesForSync` returns the registry's own bytes. #320's double hash and copy is in the ingestion port: `decodeImageDataUrl` hashes, `pending()` copies, and `keepPending` → `intern` hashes and copies again (`src/legacy/document-ports.ts`). Every load from IndexedDB (`ensureBytes` → `loadBlob` → `intern`) hashes and copies once more.

**Native.** The desktop save is `saveDoc` over a file-handle shim in `20f-desktop.js` that calls `window.splitpageDesktop`. Its `close()` drops the `lastModified` that `writeFile` returns, so `saveDoc` reads the whole file again (`getFile`) to learn it. The preload and IPC shapes need no change for this milestone.

**Drive** is a file browser in `13-hosted.js` (49 functions): opening an item downloads it through `deliverFile`, and uploads send files. It never saves or adopts a document. Its modal has no stale-completion check.

**Stale checks that exist.** Collaborate's `collab.seq`/`stale(c)`; connection identity (`via === conn`) in `detectServer`, `joinWithLinkKey`, `finishServerDetect`, `resumeServerDoc`, `openServerDoc` and `publishToServer`; `historyRenderToken`; the annotator's `ed === mine`.

**Tests that cover these paths today.**
- Unit and booted-app: `publish-in-flight` (the only held-request harness: #247, #248), `api-fetch`, `home`, `connection`, `collaborate`, `autosave-timing`, `browser-drafts` (fake IndexedDB), `draft-keep-app`, `session-bridge-app`, `session-recovery-boot`, `history-store`, `history-idb`, `blob-store`, `doc-id`, `doc-id-policy`, `apply-merge`, `open-html-bound`, `formats`, `state-fields`; `tests/application/document-session.test.ts` and `session-effects.test.ts`; `tests/legacy/document-ports.test.ts` and `while-loading.test.ts`; `desktop/test/drafts`, `close-keep`, `google-drive`, `blob-store`, `history-fs-backend`; `tools/test-server.mjs`.
- Browser suites: local and autosave 19, 28, 42, 60, 185 to 187, 269, 270, 283, 285; import 46, 261; hosted 37, 54, 55, 56, 62, 66, 249; collaboration and review 18, 43, 44, 57, 59, 260 to 264, 266, 361; Drive 64; desktop 21, 26, 34, 36, 63; browser drafts 265; history 24, 25, 27, 247; blobs 65, 68, 69; identity and open 22, 23, 30, 35.
- Desktop smoke groups: `open/save`, `save-in-place`, `duplicate document id`, `session restore`, the close and quit groups, the nine `history:` groups, the 28 `draft:` groups, `per-tab connections`, `--host`, `google drive`.
- Gap: no Node test can hold a file write, a draft write or a desktop dialog open, and no test reopens the same id mid-operation. That is what 4.0 builds.

## Target layout

- `src/core/document/export-document.ts`: the frozen `ExportDocument` type and its pure builder from a `ValidatedDocument`, a capture time and core's production, comment and b-roll read models. No blob bytes: pictures are content-addressed shas.
- `src/application/session/operation.ts`: `OperationContext` (epoch, document id, destination identity and generation, edit generation, connection instance, authority, server revision), `captureOperation` and `stillOwns`.
- `src/application/transitions/`: `createTransitions(ports)` with `open`, `startNew`, `restore`, `recover` and `publish`; the identity and fork rules over core's id policy; its ports (live document, destination, identity, session).
- `src/application/save/`: `createSaveCoordinator(ports)`: per-destination queue, confirmed generation and baseline, completion rules, typed outcomes (`saved`, `failed`, `cancelled`, `obsolete`, `refused`), the save-status selector, the autosave policy (INV-51); `capture.ts` (`captureExportDocument`).
- `src/application/recovery/`: capture scheduling, writer ownership and takeover, restore and adoption policy, and the draft-store port.
- `src/application/collaboration/`: the authority model and the collaboration workflow behind an interface.
- `src/adapters/storage/`: the IndexedDB draft store (from `03d-drafts-idb.js`), the desktop draft store over IPC, and the blob store (from `02c-blobs.js`).
- `src/adapters/transport/`: a server transport bound to one connection instance; every request of an operation goes through it.
- `src/adapters/files/`: file targets (a File System Access handle, the desktop handle, a download) behind one port.
- `src/legacy/transition-bridge.ts`, `save-bridge.ts`, `recovery-bridge.ts`: each exports a `start…(ports)` that `_entry.js` calls once after the numbered `__init`s, as it calls `startActions`. Before it runs, every accessor throws. Milestone 7 moves those calls into `src/bootstrap/`.
- Test harness: `src/test/_m4-matrix.mjs` and the case files `src/test/m4-matrix-*.test.mjs`, booted-app tests that drive the legacy code; owners' application tests under `tests/application/`.
- `docs/architecture/saving.md`: the as-built description of the transition API and the save coordinator, written in 4.10.

## The race matrix

The plan's gate names five things to assert: the bytes actually stored, the live document, the dirty state, the baseline, and the destination. A case asserts those that its subject touches (the T5, T6 and L1b cases read the stored bytes; the T2 cases assert the order of writes), and each owner PR that flips a case adds the rest. A `wrongToday` case also names the assertion it fails on; any other failure fails the run. Every `wrongToday` names a labelled assertion: the harness refuses an expected pattern that node's default assertion messages also match, and a pattern with the `g` or `y` flag. The harness (4.0) supplies held ports: a fetch whose requests wait until released and that records the connection each one used; a file handle whose `createWritable`, `write`, `close` and `getFile` wait; the desktop bridge through `__desktopTest.setBackend`; a draft store over fake IndexedDB whose writes wait; a fake `navigator.locks`; and mocked timers.

A case is declared `rightToday` or `wrongToday`. A `wrongToday` case passes only when its assertion fails, and fails the run with "now right" when it starts to pass, so the PR that fixes it must flip it in the same commit. node's `todo` is not enough, because it stays quiet when a case starts passing. The harness has its own self-test for both directions. At the gate no case is `wrongToday`.

"Today" below is predicted from the code at `f66789a`. 4.0 to 4.3 record what each case actually does on the base and correct this column in the same PR. PR 4.0 measured groups X, E, T and L on `f338fea`, so those rows state what the cases do; where a row was split into cases, the case ids follow. The cases are in `src/test/m4-matrix-session.test.mjs` (T3 in `src/test/m4-matrix-boot.test.mjs`), built on `src/test/_m4-matrix.mjs`; every `wrongToday` case has a row in [pinned-defects.md](pinned-defects.md#found-during-milestone-4).

| ID | Case | Today | Green in |
| --- | --- | --- | --- |
| X1–X5 | Serialize the captured document, then mutate the live one before the serializer runs: `buildSplitpageFile` (X1), `buildMarkdownProject` (X2), `standaloneHtmlFor` with its head (X3), `toMarkdownDoc` (X4), `exportFacts` (X5) give the captured bytes. The cases hand the serializer a clone of the document as the capture; 4.6 swaps in `captureExportDocument()` | X1 right; X2–X5 wrong (measured) | 4.6 |
| E1 | A command's effect pass writes no document content; `personColors` is written inside the transaction and declared (#479). The case runs the cycle-status command through the real session and effects, with a named editor and a colour, and lists what the document changed beyond the change set | wrong (measured: `personColors`) | 4.7 |
| E2a–E2c | A throw after a commit gives a distinct reported outcome, keeps the change, and leaves the document marked unsaved (D13): in undo recording (E2a), in an effect (E2b), in a listener (E2c) | wrong (measured: the throw escapes `runCommand`; after E2a's the document is not even marked unsaved) | 4.7 |
| T1 | Save As, publish and detached recovery fork the id; open, restore and a same-id reopen keep it (INV-36) | right (measured) | stays |
| T2a, T2a-tab, T2a-boot | A new document (File menu), a blank document from the new-tab page and the boot document open their epoch at the transition, not at the next render. The oracle: no write of the baseline, `S.docIdWrittenOut`, the unsaved flag or the edit sequence after the document is assigned and before the session holds it | wrong (measured) | 4.8 |
| T2b | An opened file opens its epoch at the transition | wrong (measured) | 4.12 |
| T2c-open, T2c-reopen, T2c-resume | A server document opened from the picker (T2c-open), reopened after a sign-in with no stash (T2c-reopen) or resumed from a draft or stash (T2c-resume) opens its epoch at the transition | open and reopen wrong (measured). Resume right (measured): the merge path absorbs into the session before it assigns | 4.15 |
| T2d | A restored draft opens its epoch at the transition (`adoptUntitledDraft`; `recoverDraftAsUnsavedCopy` is built the same way) | wrong (measured) | 4.18 |
| T2e | A restored history version opens its epoch at the transition | wrong (measured) | 4.18 |
| T3 | The pristine check and the resume check agree on a document (#483). The case boots a page whose state data has a whitespace-only editor name and no revision | wrong (measured: pristine says written out, the resume check tries the last project) | 4.18 |
| T4 | Opening an `.html` file over the parse bound keeps its script data byte for byte (#501) | wrong (measured: bold and italic lost) | 4.12 (D9) |
| T5 | Restoring a draft schedules no save and leaves the destination's confirmed generation and baseline unchanged (INV-41). T5: the draft is restored onto a file unchanged since its base. T5-merge: onto a changed file, so the draft is merged | T5 wrong (measured: autosave writes the recovered edits to the file about two seconds later). T5-merge right (measured: the merge halts autosave). Ruling (coordinator, review of #527): T5 stays `wrongToday`, owned by 4.18, because plan §6 and INV-41 say a restore schedules no save. It is not data loss, so D4's exception does not apply: the "applied" branch runs only when the file equals the draft's base, so the autosave writes that base plus the user's own recovered edits, and what is lost is the chance to decline the recovery before it reaches disk | T5 4.18; T5-merge stays |
| T6 | With autosave off, nothing is ever scheduled, after a restore or an edit (INV-51). The `noAutoSave` merge half is T5-merge | right (measured) | stays |
| L1a | A refresh the old document asked for does not run after the document was replaced | wrong (measured: the session has no `dispose`) | 4.7, 4.8 |
| L1b | An autosave or a draft the old document armed writes nothing for itself after the document was replaced | right (measured) | stays; extended by 4.11, 4.14, 4.17 |
| L1c | An object URL made for the old document's session video is revoked when it is replaced. The file grants (`sessionVideoFiles`) and token grants (`videoFileTokens`, `06-rows.js`) are keyed by name and size, not by document, and are app-lifetime: they must survive a switch (a version restore, a same-file reopen, a paste into another document). The URL map is a lazy cache over the grants, so only the URLs are document-owned. The case also asserts that the grant survives | wrong (measured: the URL is never revoked; ruled document-owned for the URLs only) | 4.22 |
| L1d | No document-owned subscription survives a replacement; app-lifetime subscriptions are named | not measured: the session lists no subscriptions until 4.7's `dispose` | 4.7, 4.8, 4.22 |
| F1 | A file save whose document is replaced mid-write changes nothing in the replacement: not its `rev`, baseline, dirty state or home | wrong (`rev` lowered on failure or cancel) | 4.11 |
| F2 | A file save that completes after a same-id reopen does not set the reopened session's baseline or clear its dirty state | wrong | 4.11 |
| F3 | A Save As that is cancelled or fails leaves Save's target and the document id unchanged | right | stays |
| F4 | An edit during the write leaves the document dirty, and the file holds the bytes without the edit | right | stays |
| F5 | A save started by the save-error retry, the conflict overwrite or copy, `flagLinkOff`'s copy or the prompter's save (`openPrompterElsewhere`) while another save runs waits its turn; completions apply in order | wrong | 4.9 |
| F6 | A write that fails at `write` or `close` keeps the document dirty, the home and the `rev` unchanged | right | stays |
| F7 | A handle whose permission is refused fails without retargeting and without a write | right | stays |
| F8 | After a write, the baseline timestamp is the one that write produced, not a later read's | wrong (desktop: second `getFile`) | 4.13 |
| F9 | No history copy happens before the write is confirmed, and a save never waits on a history write that does not resolve (INV-36, INV-39) | right | stays |
| I1 | An edit while import writeback awaits its bytes leaves the import home dirty | wrong (captured after the build) | 4.12 |
| I2 | Import writeback acknowledges only the import home | right | stays |
| D1 | An export or download acknowledges nothing | right | stays |
| S1 | A hosted save whose document is switched for another acknowledges nothing in the new one | right | stays |
| S2 | A hosted save that completes after a same-id reopen does not move the reopened session's revision or baseline | wrong | 4.14 |
| S3 | A tab pointed at another server mid-save sends none of the remaining uploads or the `PUT` there | wrong | 4.14 |
| S4 | A token, role or scope change mid-save is seen as a different connection | wrong | 4.8 (instances), 4.14 |
| S5 | An edit during a hosted save leaves the document dirty | right | stays |
| S6 | A 409 merges into the session that sent the save, and the retry carries that merge; a 409 after a switch or reopen merges nothing | record | 4.14 |
| S7 | Overlapping manual and automatic saves send one `PUT` at a time per document | wrong | 4.9 |
| S10 | Copying a share link on a dirty document (`publishAndCopyShareLink`) while a save runs sends one `PUT` at a time and completes through the same queue | wrong | 4.9 |
| S8 | A failed upload or `PUT` (500, `missing-blobs`, offline) writes no record and keeps the document dirty (INV-52) | right | stays |
| S9 | A link turned off or a role lowered mid-save authorizes no write; the work stays as an unsaved local copy | right | stays |
| P1 | A publish whose connection changed reports the document it created on the old server | wrong (silent) | 4.15 |
| P2, P3 | Publish while another document is opened (#247); typing during publish stays dirty (#248) | right | stays |
| C1 | Hosted Save As acknowledges no server edit and keeps the merge ancestor | right | stays |
| C2 | A collaboration modal step that completes after the modal closed changes nothing | right | stays |
| C3 | A Drive listing or download that completes after the modal closed changes nothing | wrong | 4.16 |
| A1 | Owner, scoped editor and reviewer each get exactly today's client capability; none broadens what the server allows | right | stays |
| B1 | A late draft write for the previous document neither removes the current document's draft record nor claims its key | wrong | 4.17 |
| B2 | Two tabs on one document: with Web Locks, a live writer's draft is not taken over | right | stays |
| B3 | Without Web Locks, every other writer counts as dead and its draft is taken over (D12) | record | 4.17 |
| B4–B6 | Quota pauses and backs off; unavailable storage turns drafts off; a corrupt record reads as none | right | stays |
| B7 | A writer discards only the draft generation acknowledged to it | record | 4.17 |
| B8 | A restore never writes the user's file or the server | right | stays |
| B9 | A revoked link keeps the draft as an unsaved local copy and never writes to the server | right | stays |
| B10 | A draft whose pictures could not be persisted restores with them | right | stays |
| K1 | A desktop file-draft restore whose document is replaced across its awaits does not overwrite the replacement | wrong | 4.18 |
| K2 | A desktop draft write after the tab navigated is refused (`STALE_SEQ`) | right | stays |
| H1 | A history restore that completes after a same-id reopen does not overwrite the reopened session | wrong | 4.18 |
| H2 | A snapshot holds the document as it was when `pushSnapshot` was called (INV-39) | right | stays |
| M1–M3 | A delayed paste or drop completes after a document switch (M1) or a same-id reopen (M2): refused, nothing written; the selection changes while media loads (M3): D11 (#478) | wrong | 4.20 |
| M4 | A gallery picture (`handleImageFile`) that finishes after a switch or reopen is refused | wrong | 4.20 |
| M5, M6 | `retryThumbnail` after a switch; `thumbnailsAfterPaste` after a same-id reopen: refused | wrong | 4.20 |
| M7 | The annotator's save after a switch is refused | record | 4.20 |

"record" means the outcome could not be predicted from reading alone; the matrix PR records it as `rightToday` or `wrongToday`, and a `wrongToday` case is turned green by the PR named.

## PRs in order

```
4.4 render tests ─────────────────────────────────────────── 4.21 atomic render ──────────┐
4.5 #320 perf ───────────────── 4.19 blob store ─────────────────────────────────────────┤
4.0 matrix ─┬─ 4.1 files cases ───────────────────────────┬─ 4.11 file writer ─ 4.13 native ┤
            │                                             └─ 4.12 import and open ─────────┤
            ├─ 4.2 hosted cases ───────────────────────────── 4.14 hosted ─┬─ 4.15 server ─┼─ 4.22 close ─ gate
            │                                                              └─ 4.16 collab ─┤
            ├─ 4.3 recovery cases (feeds 4.17, 4.20)                                       │
            ├─ 4.6 capture ──────────────────────┐                                         │
            └─ 4.7 session ─ 4.8 transitions ────┴─ 4.9 coordinator ─ 4.10 saving.md       │
                              ├─ 4.17 draft stores ─ 4.18 restore policy ──────────────────┤
                              └─ 4.20 continuations (#478) ────────────────────────────────┘
```

4.11, 4.12, 4.14 and 4.18 also wait for 4.9; the table has every dependency.

| PR | Ownership boundary | Owned files | Depends on | Parallel group | Model | Size |
| --- | --- | --- | --- | --- | --- | --- |
| 4.0 | Matrix harness, strict expected-failure wrapper, groups X, E, T, L | `src/test/_m4-matrix.mjs`, `src/test/m4-matrix-harness.test.mjs`, `src/test/m4-matrix-session.test.mjs`, this doc's matrix column | — | A | sonnet | L |
| 4.1 | Matrix groups F, I, D | `src/test/m4-matrix-files.test.mjs` | 4.0 | B | sonnet | M |
| 4.2 | Matrix groups S, P, C, A | `src/test/m4-matrix-hosted.test.mjs` | 4.0 | B | sonnet | M |
| 4.3 | Matrix groups B, K, H, M | `src/test/m4-matrix-recovery.test.mjs`, `m4-matrix-continuations.test.mjs` | 4.0 | B | sonnet | M |
| 4.4 | Render invariant tests (#463), no source change | `src/test/render-no-edit-app.test.mjs`, one browser suite | — | A | sonnet | M |
| 4.5 | #320 image-heavy perf case, run on `d18adde` and `c4d5944` | `tools/perf-record.mjs`, `performance-record.md` | — | A | sonnet | S |
| 4.6 | Capture contract: `ExportDocument`, the five serializers and their live-reading helpers | `export-document.ts`, `src/application/save/capture.ts`, `14b-export-kit.js`, `20d-formats.js`, `02b-doc-id.js` (`standaloneHtmlFor`), `14-export.js` (`toMarkdownDoc` and its helpers), `18-local-files.js` (`buildFileData`'s md and html branches), `08-production-panels.js` (`breakdownRows`), `10-comments.js` (`commentEntries`) | 4.0 | B | opus (serialization) | L |
| 4.7 | Session: observational effects, the committed-then-threw outcome, `dispose` | `src/application/session/*`, `session-bridge.ts`, `12-dirty-toast.js` (dirty effect), `13a-presence.js` (`recordMyColor`) | 4.0 | B | opus (state ingress) | M |
| 4.8 | Operation context and transition API; first adopters: new document, new tab, boot | `src/application/session/operation.ts`, `src/application/transitions/*`, `transition-bridge.ts`, `session-bridge.ts` (adoption), `_home.js`, `undo-adapter.ts` (adoption), `18b-file-menu.js`, `20j-newtab.js`, `21-events.js` (boot load only) | 4.7 | C | opus (state ingress) | L |
| 4.9 | Save coordinator and save status; first adopter: the save front door | `src/application/save/*`, `save-bridge.ts`, `14-export.js` (`queueAutoSave`, `scheduleAutoSave`, `saveDoc`'s entry), `12-dirty-toast.js` (save effect, `clearDirty`, `setSaveButtons`), `03-sync.js` (`setBaseState`), `13-hosted.js` (`publishAndCopyShareLink`'s save), `20f-desktop.js` (`openPrompterElsewhere`'s save), `21-events.js` (the save-error retry and the conflict overwrite and copy) | 4.6, 4.8 | D | opus (durable state) | L |
| 4.10 | As-built `saving.md` | `docs/architecture/saving.md` | 4.9 | E | sonnet | S |
| 4.11 | File writer: file, Save As, download, hosted copy | `src/adapters/files/*`, `14-export.js` (`saveDoc` body); it calls `checkFileConflict`, `showFileConflict`, `deliverFile` and `updateFileChip` in `18-local-files.js` as they are and edits none of that file | 4.9, 4.1 | E | opus (serialization) | L |
| 4.12 | Import writeback and file-open adoption (#501) | `18-local-files.js` (`saveBackToFile`, `adoptProjectState`, `loadFileIntoEditor`, `parseProjectFileState` and the `.html` open parse), `18a-local-merge.js` | 4.9, 4.1 | E | opus (state ingress) | M |
| 4.13 | Native file target | `20f-desktop.js` (handle shim) | 4.11 | F | opus (preload/IPC) | S |
| 4.14 | Hosted writer and transport: save, 409 | `src/adapters/transport/*`, `13-hosted.js` (`saveToServer`, `sendWithBlobs`, `uploadBlobs`, `apiFetch`, `apiUrl`, `fetchBlob`, `serverTakesBlobs`) | 4.9, 4.2 | E | opus (serialization, merge) | L |
| 4.15 | Server open, resume, pull and publish through the transition API (#415) | `13-hosted.js` (`openServerDoc`, `resumeServerDoc`, `pullServerDoc`, `publishToServer`), `03-sync.js` (`applyMerge` only; it calls `setBaseState` as 4.9 leaves it) | 4.14 | F | opus (state ingress, merge) | L |
| 4.16 | Collaboration and authority; Drive modal stale checks | `src/application/collaboration/*`, `13b-collaborate.js`, `20e-connect.js`, `13-hosted.js` (`detectServer`, `finishServerDetect`, `joinWithLinkKey`, the role predicates, the Drive modal) | 4.14 | F | sonnet | M |
| 4.17 | Draft store adapters and writer ownership | `src/adapters/storage/draft-store-*.ts`, `src/application/recovery/` (writer), `03d-drafts-idb.js`, `20g-drafts.js` (capture and writer) | 4.8, 4.3 | D | opus (durable storage) | M |
| 4.18 | Restore and adoption policy, capture scheduling, history restore (#483) | `src/application/recovery/` (restore), `20g-drafts.js` (restores), `02b-doc-id.js` (`adoptRestoredState`, the pristine check), `03-sync.js` (`restoreSnapshot` only), `21-events.js` (the resume check) | 4.9, 4.17, 4.6 | E | opus (durable storage) | L |
| 4.19 | Blob store adapter with owned bytes; #320 trimmed if over 10% | `src/adapters/storage/blob-store.ts`, `02c-blobs.js`, `document-ports.ts`, `core/document/media.ts` | 4.5 | C | opus (durable storage) | M |
| 4.20 | Operation identity for continuations (#478) | `21-events.js` (`insertIntoScriptCell`), `06-rows.js` (`handleImageFile`), `05e-gallery-overlay.js` (`retryThumbnail`), `05v-video.js` (`thumbnailsAfterPaste`), `05w-annotate.js` | 4.8, 4.3 | D | opus (state ingress: paste and drop) | M |
| 4.21 | Atomic render (#463) | `05-render.js`, `21-events.js` (focus handlers), `19-writer.js` (`renderWriter`) | 4.4 | C | opus (hot path) | L |
| 4.22 | Close: lifecycle test complete, metrics, ledger, perf rerun | docs, `src/test/m4-lifecycle*.test.mjs` | all | G | sonnet | M |

**Parallel groups.** A starts at once (three lanes). B starts when 4.0 merges (five lanes, with 4.4 or 4.5 if still running: start 4.5 first, since a timing run wants a quiet machine). C (4.8, 4.19, 4.21) and D (4.9, 4.17, 4.20) each run three or four lanes. E is the widest: 4.10, 4.11, 4.12, 4.14 and 4.18, plus 4.19 or 4.21 if still open, which is the six-lane budget; check RAM first. F (4.13, 4.15, 4.16) is three. Lanes run `--prune` after merging the base.

**Why the foundations are serial.** The operation context, the transition API and the coordinator's ports are one interface family that every adopter codes against (plan §2), so 4.7, 4.8 and 4.9 run one after the other, each Opus. 4.7 and 4.8 both change `session-bridge.ts` and the adoption path; 4.9 needs `OperationContext` from 4.8 and the captured document from 4.6, and shares `14-export.js` with 4.6 and `12-dirty-toast.js` with 4.7. The capture contract (4.6) has no file in common with 4.7 or 4.8, so it runs beside them.

**Shared files with function-level ownership.** Each PR edits only the functions the table gives it, and the second PR to merge merges the base in, as review.md §7 requires. Four legacy files are edited by PRs that can run at the same time, on disjoint functions:
- `13-hosted.js`: 4.9 (`publishAndCopyShareLink`'s save), then 4.14 (the save chain and transport), then 4.15 (open, resume, pull, publish) and 4.16 (connect, roles, Drive) in parallel. If Adam prefers strictly disjoint files, 4.16 waits for 4.15, which adds one PR to the critical path.
- `21-events.js`: 4.8 (the boot load), then 4.9 (the save-error retry, the conflict overwrite and copy), then 4.18 (the resume check), 4.20 (`insertIntoScriptCell`) and 4.21 (the focus handlers) in parallel.
- `03-sync.js`: 4.9 (`setBaseState`), then 4.15 (`applyMerge`) and 4.18 (`restoreSnapshot`) in parallel.
- `18-local-files.js`: 4.6 (`buildFileData`'s md and html branches), then 4.12 (`saveBackToFile`, the open and import adoption, the `.html` open parse); 4.11 runs beside 4.12 and calls the file's conflict, delivery and chip functions without editing them. If 4.11 finds it must change one of them, it waits for 4.12.

Others are shared only by PRs that dependency already orders: `14-export.js` (4.6, then 4.9 on `queueAutoSave`, `scheduleAutoSave` and `saveDoc`'s entry, then 4.11 on `saveDoc`'s body), `02b-doc-id.js` (4.6, then 4.18), `12-dirty-toast.js` (4.7, then 4.9), `20g-drafts.js` (4.17, then 4.18), `20f-desktop.js` (4.9, then 4.13) and `session-bridge.ts` (4.7, then 4.8).

**Critical path.** 4.0 → 4.7 → 4.8 → 4.9 → 4.14 → 4.15 → 4.22 → the gate: seven PRs, five of them Opus. The file lane ties it in count (4.0 → 4.7 → 4.8 → 4.9 → 4.11 → 4.13 → 4.22), but 4.13 is small, so the hosted lane, whose 4.14 and 4.15 are both large, is the longer in time: `13-hosted.js` holds the save chain, the adoptions and the connection code. Everything else has slack: 4.6 has the length of 4.7 and 4.8 to land, and the recovery lane (4.17, 4.18) ends one PR after 4.9.

**As-built docs.** `saving.md` (4.10) is written as its own docs PR when 4.9 merges, since 4.8 and 4.9 land the two owners and their first adopters back to back. The lanes of group E may start before it merges; their PR bodies cite it. 4.22 revises it.

## Per PR

Every PR runs `npm run verify` and the suites of [testing.md's change table](testing.md#what-to-run-for-which-change) for what it touches, which for saving, recovery, permissions and transitions means the matrix and that path's persistence and permission suites. A PR touching saving, document ids, drafts or history also runs the desktop smoke groups `open/save`, `save-in-place`, `duplicate document id`, `draft:` and `history:`; one touching connect, hosted or collaboration code runs `per-tab connections` and `draft: server document` (review.md §3). Each owner PR turns its matrix cases from `wrongToday` to `rightToday` in the commit that fixes them, and its body lists them.

**4.0 Matrix harness.** The held ports and the `rightToday`/`wrongToday` wrapper above, with a self-test that a `wrongToday` case that passes fails the run and a `rightToday` case that fails fails it. Groups X, E, T and L. Records the actual "Today" column for its groups and adds a row per wrong case to [pinned-defects.md](pinned-defects.md) (the case id is the tracker; no separate issues). No source change. Evidence: `npm run verify`; no browser suite changes.

**4.1, 4.2, 4.3 Matrix groups.** One case file each, the same rules. 4.2 builds its server from the held fetch, as `publish-in-flight` and `entry-fuzz-app` do, with each request recording which connection sent it. 4.3 includes the recovery cases the gate names (multi-tab ownership, quota, unavailable and corrupt storage, offline images, restart, revoked links) at the booted-app level; the browser and desktop halves stay suites 265 and 26 and the `draft:` groups.

**4.4 Render invariant tests (#463, D7).** Before any mechanism: whatever focus or blur a render causes, it commits no cell's DOM to the document, rolls back no accepted update, and lets no stale DOM overwrite the current document. Cases: a render with a grid cell focused, with a Writer paragraph focused, an incoming merge while a cell holds focus, a render that throws part-way, `restoreRenderFocus` with the Writer open. Booted-app tests with the real handlers, and one browser suite with CDP focus emulation (#471). Since #477 most should pass; any that fail are `wrongToday` cases for 4.21. Also records the render and typing medians from `perf-record` as 4.21's base.

**4.5 #320 measurement (D8).** `tools/perf-record.mjs` gains the image-heavy case: open a document with ten fresh 1 MiB pictures in comment bodies, and merge two sides that each add such pictures, timed in the browser. Run it on builds of `d18adde` and `c4d5944` under one machine, browser and font setup, alternately, three times each. Results and conditions go into `performance-record.md`. No app source change.

**4.6 Capture contract.**
- `ExportDocument`: frozen; title, scenes, people, tags, shots and comments from the `ValidatedDocument`; the capture time; core's production index, comment numbering and b-roll entries, so that a writer calls no legacy helper; picture shas, not bytes. No connection, token, link key, native handle or file path (E15).
- `captureExportDocument()` reads the session once, synchronously.
- `buildSplitpageFile`, `buildMarkdownProject`, `standaloneHtmlFor`, `toMarkdownDoc` and `exportFacts` take it, and so do the helpers they read the live document through (`appendMarkdownTail`, `breakdownRows`, `commentEntries`, `sceneFacts`, `commentNumbers`, `appendExportTail`, the picture helpers). Their fallback to `S.state` goes. Milestone 5's writers that call the same helpers pass a fresh capture, so there is one path.
- The save paths capture before their first `await`. In `saveDoc` (file, Save As, download, and the hosted save that goes through it), `settleDerivedRecords` still writes the live document before capture (#325, milestone 6); it is the one named exception, run before capture so the capture holds its result. `publishToServer`, `publishAndCopyShareLink` and `saveBackToFile` do not run it, as today.
- First commit: characterisation of the five functions' bytes on the fixtures the goldens do not already cover, passing on the base; the PR body gives the sha. Goldens and INV-60 unchanged. X1 to X5 green.
- Suites 03, 17, 41, 98, 284 and the format unit tests; desktop group `open/save`.

**4.7 Session.**
- #479: the dirty effect stops writing `personColors`. The colour is written inside the transaction through a port the session calls before `undo.record`, declared as a `docFields` change. Whether the first edit's undo still removes the colour follows from that and is pinned by a test.
- A command whose transaction committed but whose undo recording, effect pass or publication threw returns its own outcome (for example `{ kind: "committed", error }`), reaches the existing error reporting with nothing new on screen, and is never rolled back (D13).
- `dispose()` on the session: stops the scheduler's timers and drops listeners. The first half of the lifecycle test.
- Tests: `runConfined` with the real effects, a named editor and a set colour; the throw at each post-commit stage. E1 and E2 green. Suites 73, 185, 186, 187, 44.

**4.8 Operation context and transition API.**
- `captureOperation()` and `stillOwns(ctx)`. A connection is an instance: `updateConnection` returns a new one and the server home moves to it, so a token, role or scope change is a different connection (S4's first half).
- `createTransitions(ports)`: `open`, `startNew`, `restore`, `recover`, `publish`. Each migrates raw input or takes a `ValidatedDocument`, assigns the live document through the one port, adopts it in the session at once (no more lazy adoption through 12a's `trackDocument` for these paths), opens the epoch, sets the destination and its confirmed baseline, and applies the fork rules (INV-36). Publish changes the id and the destination only.
- Adopters here: `replaceWithNewDocument`, `adoptNewDocument` and the boot load. The other sites move in their lanes (4.12, 4.15, 4.18).
- Lifecycle test, session level: a replacement through the API disposes the old session-scoped resources.
- Tests: INV-36's application race tests (fork and keep; a failed or cancelled Save As changes neither id nor destination); T2a, L1 (session part). The tests of lazy adoption in `session-bridge-app.test.mjs` change on purpose for these three paths, and the body says so.
- Full browser run before merge: every open path passes through it, so the affected suites cannot be chosen with confidence (review.md §3). Desktop groups `open/save`, `duplicate document id`, `session restore`.

**4.9 Save coordinator.**
- `createSaveCoordinator(ports)`: one queue per destination; a save captures context and document, then hands the destination's writer the captured snapshot; the completion is accepted only while `stillOwns(ctx)` holds and only for the generation captured; an obsolete write that landed is reported as D10 says, its toast's wording brought to Adam in this PR; cancellation is its own outcome and never proves a failure.
- Per destination: confirmed generation and baseline. The document is dirty for a destination while the session's generation is past the destination's confirmed one. `S.dirty`, `S.baseState` and the save buttons become projections the bridge keeps in step, so legacy readers are unchanged.
- One save-status selector that `setSaveButtons` and every Save control render (INV-20). The autosave policy: where (only a picked handle or the server), when (only while on), halting after unreviewed work (INV-51).
- Adopter: the front door. `queueAutoSave`, the Save action (which the desktop menu clicks) and every direct caller go through the coordinator's queue: the save-error retry, the conflict overwrite and copy, `flagLinkOff`'s copy, `openPrompterElsewhere`'s save, and `publishAndCopyShareLink`'s `saveToServer`. Each destination's writer is still today's code inside.
- `setBaseState` (`03-sync.js`) writes the destination's confirmed baseline in the coordinator and keeps `S.baseState` as its projection; 4.14, 4.15 and 4.18 call it as 4.9 leaves it.
- Tests: application tests with fake writers and a fake clock for every matrix row at the coordinator level; F5, S7 and S10 green. Full browser run before merge (every save path). Desktop groups as above.

**4.10 `saving.md`.** The as-built description of the transition API, the operation context and the coordinator: ports, outcomes, the start functions, what still bypasses them.

**4.11 File writer.**
- `saveDoc`'s body becomes the file destination's writer over a file-target port: a picked handle, the desktop handle, a download. `rev` and the last-edited stamps go on the captured copy; the live document's `rev` moves only on a confirmed write, so no failure path touches the live document. The history copy (`copyDocHistorySafe`) runs when the coordinator confirms (INV-36, INV-39). Hosted Save As stays a copy that writes no server baseline (C1).
- F1, F2 green. Suites 19, 22, 24, 28, 42, 60, 185 to 187, 249, 269, 270, 283, 285. Desktop groups `open/save`, `save-in-place`, `duplicate document id`, `history:`.

**4.12 Import writeback and file open.**
- `saveBackToFile` captures before it builds (I1) and completes through the coordinator for the import destination only (I2). `deliverFile` stays the download path both writers call.
- `adoptProjectState` and `loadFileIntoEditor` (both its import branch and its reload branch through `noteReload`) go through the transition API (T2b).
- #501 (D9): read the `state-data` script from the raw text before the bounded parse, so T4 passes and no file that opens today is refused.
- Suites 17, 35, 42, 46, 261; `open-html-bound.test.mjs`. Desktop group `open/save`.

**4.13 Native file target.** The desktop handle shim in `20f-desktop.js` returns the `lastModified` that `writeFile` already answers, so the baseline is the write's own (F8) and the second full read goes. A cancelled native dialog is the coordinator's `cancelled`. No preload or IPC change; if one turns out to be needed, it is a separate Opus PR with the full desktop smoke. Suites 21, 26; desktop groups `open/save`, `save-in-place`.

**4.14 Hosted writer and transport.**
- A server transport is created per operation from the captured connection instance. `sendWithBlobs`, `uploadBlobs`, the document `PUT` and the `missing-blobs` retry all go through it, so no request of the operation reaches another server or token (S3, S4).
- `saveToServer` completes through the coordinator: a same-id reopen is a different epoch (S2). The 409 merge runs only in the session that sent the save, and the retry is the same operation (S6).
- Lifecycle: the server destination's timers and polls are document-owned.
- Suites 37, 54, 55, 56, 62, 66, 249; `api-fetch`, `connection`, `publish-in-flight`; `tools/test-server.mjs`. Desktop groups `per-tab connections`, `draft: server document`.

**4.15 Server open, resume, pull and publish.**
- `openServerDoc`, `resumeServerDoc` and `applyMerge`'s adoption go through the transition API (T2c); `pullServerDoc` checks the connection, not only the id.
- `publishToServer` through `transitions.publish`; a document created on a server the tab has left is reported (P1, D10).
- #415: `applyMerge` moves to TypeScript, migrates `theirs` before `mergeStates`, and hands the session a `ValidatedDocument`, so the merged result is not migrated a second time (the 23.6 ms median measured in #384 is re-measured). No wrong behaviour today (#417's runtime guard), so this is an acceptance criterion, not a matrix case.
- Suites 54, 55, 56, 59, 62, 63, 260, 265; `apply-merge`, `entry-fuzz`. Desktop groups as 4.14.

**4.16 Collaboration and authority.**
- An authority model in `src/application/collaboration/`: none, owner, scoped editor (document id), reviewer. `reviewMode()`, `isLinkGuest()` and the session's `CapabilityPort` derive from it. Server refusals stay authoritative (A1).
- The Collaborate workflow (`connectStep`, `signInStep`, `publishStep`, the link actions) behind an interface; its `collab.seq` check is kept. The Drive modal gets the same stale check (C3). Credentials stay per server in this browser (INV-62).
- Sonnet by D2; it becomes Opus if it has to change the publish or save path. Suites 18, 43, 44, 57, 59, 64, 260 to 264, 266, 361. Desktop groups `per-tab connections`, `draft: server document`, `google drive`.

**4.17 Draft store adapters and writer ownership.**
- The IndexedDB store moves to `src/adapters/storage/` behind the draft-store port, built by an explicit constructor that takes the IndexedDB factory, limits and clock; the desktop draft store becomes an adapter over the existing IPC. The lazy singleton goes.
- A capture records its operation context and its key at capture time; a late write neither removes nor claims another document's key (B1). Takeover with and without Web Locks as today, pinned by a test (D12, B3). A writer discards only the generation acknowledged to it (B7).
- Tests: `browser-drafts.test.mjs` against the adapter (store contract), the B cases. Suites 26, 63, 265. Desktop group `draft:`.

**4.18 Restore and adoption policy.**
- The three draft restores, the server draft resume and the history restore go through `transitions.restore` and `transitions.recover` (T2d, T2e), each re-checking ownership across its awaits (K1, H1). Restore leaves the destination's confirmed generation unchanged and schedules no save (T5, T6). Permission loss keeps the work as an unsaved local copy.
- #483: one normalised predicate for "pristine" used by `02b-doc-id.js` and the resume check (T3).
- Capture scheduling moves out of `20g-drafts.js` into the recovery owner; the 1.5 s / 5 s / 15 s timing is kept.
- Suites 24, 25, 26, 63, 247, 265. Desktop groups `draft:`, `history:`, `session restore`.

**4.19 Blob store.**
- `02c-blobs.js` becomes `src/adapters/storage/blob-store.ts` behind a port, built explicitly with its backend. `bytesForSync` and every byte read hand out bytes the caller owns: a copy or an immutable `Blob`. Test: write into the returned bytes, read the same sha again, get the original bytes and a matching hash (E14).
- #320: if 4.5's median is more than 10% slower than `d18adde`, hand the decoded record to the store without the second hash and copy, keeping byte ownership, hash validation, first-seen order and persistence when a pass throws; otherwise record and explain. The load path's extra hash (`loadBlob` → `intern`) is measured in the same run.
- A move of one module plus its consumers' imports: characterisation in the first commit (`blob-store.test.mjs`, `document-ports.test.ts` and the byte-level cases, passing on the base). Suites 24, 26, 27, 65, 66, 68, 69. Desktop groups `draft:`, `history:`.

**4.20 Continuation identity (#478).** `insertIntoScriptCell`, `handleImageFile`, `retryThumbnail`, `thumbnailsAfterPaste` and the annotator's save capture `captureOperation()` before their `await` and refuse on `!stillOwns(ctx)` with D11's toast, whose wording is brought to Adam in this PR. The paste's target range is captured with it, and a paste into a cell edited since lands at the end of the cell (D11). M1 to M7 green. Suites 65, 68, 69, 80, 86, 92, 160, 186 and `render-guard-app.test.mjs`.

**4.21 Atomic render (#463).** Build rows and title off-screen with the incremental row reuse, then commit in a guarded phase in which render-generated focus and blur commit nothing; restore focus within its own surface (a Writer paragraph in the Writer); a draw that throws leaves the old screen intact and is a recoverable presentation failure, with #456's editing block kept. Acceptance: 4.4's cases, the issue's own (a throw at any row leaves the DOM byte-identical), and the typing and render medians within noise of 4.4's base on the long demo. Hot path: full browser run before merge, plain and frozen.

**4.22 Close.** The lifecycle test complete across the owners, with the app-lifetime subscriptions named (E9). Every matrix case `rightToday`. Revise `saving.md` and `session.md`; this doc's as-built section with `--metrics` before and after and `--prune`; ledger rows INV-20, 29, 36, 39, 40, 41, 51, 52, 62 with their `HANDOFF.md` pointers; pinned-defects rows; the #320 case rerun on the closing tree under 4.5's conditions. The gate record is a separate docs PR after the runs.

## Issue classification

Under D4: an issue in save completion, the transitions, drafts and recovery, or the collaboration save paths becomes a matrix case; an issue elsewhere is fixed alongside, in its own PR.

| Issue | In M4? | As | Green in |
| --- | --- | --- | --- |
| #463 atomic render | In M4 by Adam's filing; render code, so not a matrix case | Invariant tests first (D7), then the mechanism | 4.4, 4.21 |
| #478 delayed paste or drop | In M4: the plan puts it under operation identity | M1 to M3 (plus M4 to M7 for the same shape) | 4.20 |
| #479 `personColors` in the dirty effect | In M4 | E1 | 4.7 |
| #415 raw `theirs` in `applyMerge` | In M4 | Acceptance criterion; no wrong behaviour since #417 | 4.15 |
| #320 double hash and copy | In M4 | Measure, then trim if over 10% | 4.5, 4.19 |
| #501 over-bound `.html` open | In M4 (file open is a transition) | T4, by D9 | 4.12 |
| #465 crafted `.html` open | Closed by #486; its open question is answered by D9 | — | — |
| #483 pristine and resume checks | In M4 (resume is recovery) | T3 | 4.18 |
| #514 scene length lost when every redraw fails | Outside: the length editor's render-failure path. A regression from #506 against the base | Fix alongside: apply the typed length as the base did. Sonnet | alongside |
| #498 no test pins the HELD guard | Outside: desktop main | Test-only, alongside. Haiku (test-only) | alongside |
| #500 Review on a clean gone-file tab explains nothing | Outside: desktop | Alongside, Sonnet, behaviour by D15 | alongside |
| #499 update quit timer during the gone-file dialog | Outside: desktop main, close and quit | Alongside, Opus | alongside |
| #507, #508, #509 close and quit after #505 | Outside: desktop main, close and quit | One PR alongside, Opus; #508's behaviour by D14 | alongside |

None of the measured defects is cheap data loss reachable today: each needs an operation still in flight when the user replaces or reopens the document, so none gets a standalone lane. The most severe is S2 (a hosted save landing after a same-id reopen moves the reopened session's revision and baseline, so its next save could go through without a conflict); 4.14 takes it first.

## Pinned defects in M4

| Defect | Issue or case | Fixed in | Pinned test that flips |
| --- | --- | --- | --- |
| Serializers read the live document | X2–X5 | 4.6 | the X cases |
| Effects write document content; no outcome for a throw after commit | #479; E1, E2 | 4.7 | the E cases |
| Adoption lags the assignment | T2 | 4.8, 4.12, 4.15, 4.18 | the T2 cases; `session-bridge-app.test.mjs`'s lazy-adoption tests, on purpose |
| `saveDoc` lowers `rev` on whatever document is live; a same-id reopen passes its checks | F1, F2 | 4.11 | the F cases |
| Direct `saveDoc` and `saveToServer` callers are not serialized | F5, S7, S10 | 4.9 | — |
| Desktop baseline taken from a second read | F8 | 4.13 | — |
| Import writeback captures after building | I1 | 4.12 | — |
| Requests of one save follow the live connection; token changes are invisible | S3, S4 | 4.8, 4.14 | — |
| Hosted completion after a same-id reopen | S2 | 4.14 | — |
| Publish orphan unreported | P1 | 4.15 | — |
| Drive modal has no stale check | C3 | 4.16 | — |
| A late draft write touches another document's key | B1 | 4.17 | — |
| Restores re-check nothing across awaits | K1, H1 | 4.18 | — |
| A draft restored onto an unchanged file leaves autosave armed, so the recovered edits are written to the file | T5 | 4.18 | — |
| A replaced document leaves its refresh job and its session video object URLs behind | L1a, L1c | 4.7, 4.8, 4.22 | — |
| Pristine and resume checks disagree | #483; T3 | 4.18 | — |
| Over-bound `.html` loses formatting | #501; T4 | 4.12 | `open-html-bound.test.mjs`, where it pins the rewritten script data |
| Continuations land in another document | #478; M1–M7 | 4.20 | `render-guard-app.test.mjs`'s late-paste case stays |
| #325 reads that repair, including `settleDerivedRecords` before capture | — | stays at milestone 6 | — |

## Risks

- **Harness fidelity.** The matrix drives the booted app in jsdom: no real File System Access, no real Web Locks, fake IndexedDB. It proves ordering and ownership; the browser suites (19, 28, 54, 249, 261, 265) and the desktop smoke stay the proof of real I/O. A case that cannot be expressed in jsdom is written as a suite and named in the matrix table.
- **Dirty state from generations.** `S.editSeq` and the generation already diverge after merges and recoveries (session.md §8). The coordinator keeps `S.dirty` and the save buttons as projections, and 4.9's full run checks every surface that reads them (INV-20; suites 185 to 187, 283, 285).
- **Autosave timing.** INV-51 and the 2 s, 5 s and 15 s windows are behaviour; the coordinator keeps them, and `autosave-timing.test.mjs` plus suites 28 and 185 pin them.
- **Eager adoption.** Making a transition adopt at once changes when the epoch opens; tests that relied on the lazy path change on purpose, and a missed site still adopts lazily until its lane moves it. 4.8's full run is the check.
- **Capture cost.** A capture clones and freezes the document and derives the read models on every save. Measure a save on the long demo with `perf-record` in 4.6 and 4.9; a material cost is investigated before merge (plan §2).
- **Shared legacy files.** `14-export.js`, `13-hosted.js` and `21-events.js` are edited by more than one PR, on disjoint functions; the table names which. A lane that needs a function another lane owns stops and asks the coordinator.
- **The rule in D4.** A matrix case found wrong outside its lane's cases is added to the matrix, not fixed in passing; the coordinator assigns it.
- **Desktop main.** Nothing here changes `desktop/main.js` or the preload. If 4.13 needs an IPC change, it is a separate Opus PR with the full smoke. The alongside desktop fixes touch `main.js` and run the full dev smoke.
- **Lane budget.** Group E is six lanes; check RAM before starting it, and start 4.5's timing runs when the machine is quiet.

## The gate

On the exact merged tree, recorded in `milestone-4-gate.md`, as for milestone 3 (D1):
- **Full Windows browser run, twice**, plain and with `SPLITPAGE_FREEZE_CACHES=1`, over every suite.
- **Electron smoke**, dev target, every group.
- **Windows x64 packaged check**: stage, build, `verify-dist.mjs --arch x64`, the packaged-x64 smoke.
- **External review** of the integrated milestone under review.md §8, stating its kind (milestone 3 used Codex), covering the save, transition and recovery owners and the race matrix.
- **Milestone checks:** every matrix case `rightToday`; the lifecycle test (E9) and the capture-contract tests (E8) pass; the recovery tests of E7 pass in the browser and on the desktop; the #320 case rerun on the closing tree is in `performance-record.md`; the plan's "existing five repaired defects" stay fixed (below).
- Linux full run and native ARM64 wait for the 4.0 release gate.

The plan's gate names no list for "existing five repaired defects stay fixed". Adam confirmed the list on 2026-10-08 (D16): the publish regressions #247 and #248 (`publish-in-flight.test.mjs`), hosted Save As (#249, suite 249), import writeback with a late edit (#251, `261-import-save-back-late-edit.txt`), and a Save As whose write fails not retargeting Save (INV-36, `22-doc-id.txt`).

## Questions for Adam

The draft's seven questions are answered (D9 to D15). What stays open is wording, which comes back to Adam with the PR that adds it:

- **The obsolete-save toast (D10)**, with 4.9. The draft wording to start from: "An earlier save of “{title}” finished after you reopened it. Your open copy is unchanged."
- **The dropped-picture toast (D11)**, with 4.20. The draft wording to start from: "The picture finished loading after you opened another script, so it was not added."
- **The moved-file notice on "Review" (D15)**, with #500's PR, only if the close notice's text does not fit there.

## Spec notes

Where the spec does not match the measured code, and what this plan does instead:

- **Drive has no save path.** The spec lists "Drive save paths". Drive is a file browser: opening downloads a file, uploading sends files. Its milestone 4 work is the modal's stale check (C3), in 4.16.
- **Native saving is not a separate path.** The desktop save is `saveDoc` over a handle shim in `20f-desktop.js`; no preload or IPC change is planned (4.13).
- **Fourteen sites, twelve adoptions.** Two of the 14 `S.state` assignments set `null` (the prelude's initial value and the boot reset). The target is 9 assigners → 2, not 0.
- **Publish adopts nothing.** It changes the document id and the destination; the transition API's `publish` covers identity, not adoption.
- **The capture contract reaches further than five functions.** `buildMarkdownProject` and `toMarkdownDoc` read the live document through `appendMarkdownTail`, `breakdownRows`, `commentEntries`, `sceneFacts`, `commentNumbers`, `appendExportTail` and the picture helpers; those take the captured document too (4.6). `settleDerivedRecords` writes the live document before every save that goes through `saveDoc` (#325) and stays the named exception until milestone 6.
- **Import writeback in other formats still reads the live document.** For `.docx`, `.csv` and `.txt`, `saveBackToFile` builds through `buildDocx`, `buildCsv` and `htmlToPlainScript`, which read the live document after `ensureBytes` until milestone 5 gives them the captured document. 4.12 captures the edit generation before the build, so I1 proves only that the file stays unsaved after a later edit; the bytes written can still include that edit, and 4.12 claims no byte capture for those formats.
- **#320 has a third hash.** Besides the ingestion port's double hash and copy, every IndexedDB load re-hashes and copies through `loadBlob` → `intern`. 4.5 measures it with the rest.
- **The "existing injected IndexedDB draft store"** is a lazy module singleton injected only through a test hook; D3 replaces it with an explicit constructor (4.17).
- **Strict expected failures.** "Cases failing where today's code is wrong" needs a wrapper that fails when such a case starts passing; node's `todo` does not (4.0).
- **"Existing five repaired defects"** was undefined in the repository; Adam confirmed the list on 2026-10-08 (D16, [The gate](#the-gate)).
