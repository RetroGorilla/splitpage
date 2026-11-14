# Stage 2 composition plan (package 14)

Package 14 of #1414 is "Shared composition behind the flag and the real-editor
tests on Writer and Split": the point where the running app can put a shared
session in place of the standalone one, from the parts Stage 2 has built. This
document is the plan for it. It builds nothing. An author who has read it and
[AGENTS.md](../../AGENTS.md) should be able to build package 14 in the cuts of
section 5.

Base: `main` at `833c7ea9` (after #1532). Line numbers are for that commit.
"Unverified" marks a statement this document could not check in the code or a
record. "Found here" marks a duty no record assigned; it follows from the code.

## 1 What exists and is not composed

Nothing below is constructed by `src/bootstrap/main.ts` or `wireApp` in
`src/bootstrap/wiring.ts`. The running app creates one standalone session in the
wiring step `session` (`wiring.ts:418`, `startSessionBridge(legacySessionPorts(deps))`),
with standalone capabilities (`wiring.ts:351`). Every part is reached today only
from tests.

| Part | Where | Reached from today | What it needs from the composition |
| --- | --- | --- | --- |
| Shared document handle | `createSharedDocument`, `applySharedUpdate`, `observeSharedUpdates`, `encodeSharedState`, `encodeSharedStateVector`, `encodeSharedUpdate`, `destroySharedDocument` in `src/adapters/collab/document.ts` | Adapter and session tests | One owner of its lifetime (create, hydrate, destroy), and a source of received updates. Stage 2 has no transport (Stage 3), so in package 14 the only source is an in-page second replica driven by the test hook (section 4) |
| Hydration | `hydrateSharedDocument(handle, source: ValidatedDocument)` in `src/adapters/collab/hydrate.ts:56`; origin `hydration`, published as `adopt` (`ORIGIN_KINDS`, `shared-session.ts:82`) | Adapter tests | A source document taken after standalone typing settled, and its `docId` (Q4) |
| Ingress gate | `holdSharedBuffer`, `observeSharedDeclined`, `sharedBufferDeliveryBusy` in `src/adapters/collab/ingress.ts`; [stage-2-ingress-gate.md](stage-2-ingress-gate.md) | Buffer tests | Received updates enter only through the handle, so the gate holds them while a buffer is open; and someone answers a decline (D38) |
| Operation handlers | `registerSharedTextOperationHandlers`, `registerSharedRecordHandlers`, `registerSharedSplitHandlers(handle, { cells })`, `registerSharedRemovalHandlers` (also `discard` and `discard-retire`, `removal-executor.ts:198`), `registerSharedJoinHandlers`, `registerSharedHeadingHandlers`, `registerSharedMoveRefusal`, `registerSharedUndoOperationHandlers`, all under `src/adapters/collab/` | Each family's tests register what they use; `tests/application/session/shared-session-support.ts:45` registers only split | Every family registered on the composed handle before the first `execute`. Nothing in `src` does this (#1414 tracker, packages 5c and 8) |
| Replica port | `createSharedReplica(handle, count?)` in `src/adapters/collab/replica.ts:13`, over the incremental projector | Session tests | Its `execute` calls `executeSharedOperations` (`replica.ts:25`), which returns no undo record. See "Shared undo owner" |
| Shared session owner | `createSharedSession(ports)` in `src/application/session/shared-session.ts:96`; ports `replica`, `entry`, `undo.record`, `effects`, `capability`, `report`, `timers`, `timing`, `after`; adds `revision`, `readAt`, `beforeCommand`, `subscribeRows`, `recovery` | `tests/application/session/shared-session-support.ts` | A safe `entry` ([stage-2-shared-session.md, The entry port](stage-2-shared-session.md#the-entry-port)), a place in the session bridge, the counters of the owner it replaces (`after`), and shared-mode effects |
| Session bridge | `src/bootstrap/wiring/session-owner.ts`: `startSessionBridge` (`:184`), `adoptReplacement(doc, capability?)` (`:223`), the `session` object (`:156`), `standaloneSession()` (`:336`) | The whole app | Today `Started.current` is a `DocumentSession` and `createSession` (`:79`) builds only the standalone owner, subscribes `numbering.changed` and `records.resync(made.held(), ...)` on it (`:102` to `:105`), and the undo route (`:200` to `:206`) passes `replay` and `amend` straight to `mine.current`. It must hold either owner (D6, D36, D37) |
| Projection and row report | Incremental projector in `src/adapters/collab/incremental-project.ts`; `subscribeRows` on the shared session | Session and projection tests | No feature paints from `subscribeRows`; `render.ts` paints from `SessionChange`. Using it is optional for package 14 and belongs to the timings (section 6) |
| Capability table and the disabled lists | `SHARED_SESSION_DISABLED` (`src/application/session/ports.ts:43`, ten entries including `moves` and `reload`), `createSessionCapabilities(mode, common)` (`capabilities.ts:4`), `captureSessionCapabilities` (`capabilities.ts:29`). The owners that ask it are listed in [file saving](stage-2-disabled-file-saving.md), [merge and stash](stage-2-disabled-merge-stash.md), [drafts and history](stage-2-disabled-drafts-history.md) and [folders and bundles](stage-2-disabled-folders-bundles.md) | All those owners are mounted and ask the current session's capability; every answer is "allowed" today | A shared session built with `createSessionCapabilities("shared", common)` and installed through the replacement boundary together with its owner. `moves` is asked by no command yet |
| Writer binding | `createBufferedField` (`src/application/editing/buffered-field.ts`), `createWriterBuffer` (`src/features/writer/flow-buffer.ts`), chosen at surface creation when `SurfacePorts.bufferedText` is present (`flow-surface.ts:117`, `:1262`); `WriterPorts.bufferedText` and `paintedText` are optional (`src/features/writer/ports.ts:58`) | Writer buffer tests through `tests/features/writer/buffer-support.ts` | Ports from `sharedBufferPorts(handle, session, effects)` (`src/bootstrap/wiring/ports/shared-buffer.ts:10`): an author, production readers, stamps, `missingBase`, `recovered`, `report`. `src/bootstrap/wiring/writer.ts:222` passes neither port, and the surface picks its handlers once, so the Writer has to be started again on each switch. The Writer writes paragraph starts on open through `standaloneSession().amend(initializeFlowParagraphs(...))` (`writer.ts:98`) |
| Split binding | `mountSharedSplitBuffer(shared)` in `src/bootstrap/wiring/split-buffer.ts:16`, over `mountCellBuffer` (`src/features/editing/cell-buffer.ts`) | `tests/features/editing/cell-buffer-cost.test.ts` only | The same two ports, a mount on entering and a dispose on leaving, and the old standalone handlers turned off (D16, D17) |
| Shared undo owner | `createSharedUndo({ reverse, supports, now })` in `src/application/editing/undo/shared-undo.ts:49`, with `perform`, `undo`, `redo`, `breakGroup`, `hold`, `reset`; adapter `executeSharedCommand(handle, operations, description, options)` (`undo-executor.ts:347`, returns `{ result, record }`; `SharedCommandDescription` at `:43` is a label, a selection as anchors and a typing key), `reverseSharedUndoRecord(handle, record, writer)` (`:311`), `supportsSharedUndoPart` (`:49`) | `tests/collab/undo/adapter-world.ts:67` | A seam that does not exist (D32): the session's undo port is the standalone `UndoPort.record(changes, selection)` (`ports.ts:25`), the replica runs `executeSharedOperations`, and `Plan` carries no description. The test world calls `executeSharedCommand` inside `perform` and bypasses the session. The undo and redo actions route to the standalone owner built at `wiring.ts:413` (`src/bootstrap/wiring/undo.ts`) |
| Recovery read port | `SharedDocumentSession.recovery()` (rule 51: the list at the same revision as the document); entry naming `sharedRecoveryEntryName`, discard `sharedRecoveryDiscardOperation(entry, author)` and person restore `sharedRecoveryPersonRestore` in `src/core/collab/recovery.ts` | Recovery tests | A panel (D35) and an author for its restore and discard operations |
| Commit-time writers | `sharedTagsIntroducedByText` (called by `createSharedBufferedText`), `sharedBeatStamp` (`src/adapters/collab/stamp.ts`, appended by the buffer), `sharedBrollIntroducedByText` and `sharedPeopleIntroducedByText` (`src/core/collab/text-records.ts`, no caller) | Their tests; inventory `tests/application/commit-time-writers.test.ts` | Callers (D27) |
| Commands | Section 3 | Buffered typing and its rule 29 recovery write (`src/adapters/collab/buffer.ts:110`) are the only producers of `Plan.shared` that run in practice. Four of the seven comment commands (`src/application/commands/comments.ts:66` to `:154`) send a shared list only when given an author, and no caller gives one (`src/features/comments/comments.ts:327`, `:552`, `:600`, `:655`) | The shared session refuses a plan without `shared` as `not shared` (`shared-session.ts:237`). See section 3 |

## 2 Duties handed to package 14

Each row says what must be true once package 14 is complete. "Source" is where
the duty was handed over.

### Session, entry and switch

| # | Duty | Source | Must be true |
| --- | --- | --- | --- |
| D1 | Safe entry | [stage-2-shared-session.md, The entry port](stage-2-shared-session.md#the-entry-port); shared-session table row for `withRecords` | The shared session's `entry` creates no record from text and rewrites no id. `migrateRows` stays the standalone entry. The declared limit in `shared-session-replicas.test.ts` (minted `bs-load-...` shot) flips to "no shot minted" |
| D2 | One row naming | [stage-2-shared-session.md, The changed-rows port](stage-2-shared-session.md#the-changed-rows-port) | With D1, the change set and the row report name rows the same way; the tests' copy of every projection can go |
| D3 | Replace through the lifetime boundary | [stage-2-disabled-file-saving.md, Package 14 obligations](stage-2-disabled-file-saving.md#package-14-obligations) | Entering and leaving go through the `adoptReplacement` boundary, selecting owner and captured capabilities together; no live session's answers change; no forwarding capability port |
| D4 | Detach local saving on entry | same | Entry detaches the previous local destination and cancels pending autosave scheduling; an already captured file write finishes; new shared save attempts refuse before capture, destination selection, timers, standalone undo or file access |
| D5 | Captured-save effects | same; [drafts and history, Limits](stage-2-disabled-drafts-history.md#limits) | An old save's completion adopts no target, remembers no handle and changes no home on the new shared session; a history copy for a standalone save that lands after entry is not made |
| D6 | Standalone-only calls refuse | Plan section 3; `tests/application/standalone-typed-callers.test.ts`; bridge `replay` at `session-owner.ts:168` (`replay` is standalone-only, `document-session.ts:115`) | While the current owner is shared, `held`, `stamp`, `amend`, `noteEdit`, `replay`, `adopt`, `absorbDisk`, `absorbRecovery`, `absorbMerged`, `absorbReload` and `settle` on the bridge refuse by name. The undo route (`session-owner.ts:200` to `:206`) checks the current owner's kind before calling `replay` or `amend`; today it would throw a `TypeError` on a shared owner instead of refusing. No silent no-op |
| D7 | Writable reads left | #1532 (merged), `LEFT` in `tests/application/writable-read-callers.test.ts` | Three writable reads remain: the bridge function `currentDocument` (mentioned in 12 wiring modules, table `BRIDGE_FUNCTION`), the b-roll reconciler's `viewed` (package 8) and the local-work stash's `current` (package 13). While shared, none of them writes into the projection: each either reads the view or is not reached (the reconciler by D36, the stash by its `stash` refusal) |
| D8 | The unsaved mark and the close question | Shared-session table row for `pass`; package 13 settled the rest: `save` refuses through the capability (`src/application/save/session-effects.ts:55`), `draft` through `draftsRefused` (`src/application/recovery/drafts.ts:126`) | What `dirty` (`session-effects.ts:47`, `saveChangeNotes.noteChange()`) does for a local shared edit, and whether closing asks the unsaved question, as Q6 decides |
| D9 | Title repaint on a remote change | Shared-session table row for `render.ts` (packages 9 and 14). The `comments.ts` row (package 12) is done: `commentsChanged` recounts on `docFields` naming `comments` (`src/features/comments/comments.ts:490`). The `local-files.ts` row is package 13's | `render.ts` refreshes the title inputs only when `docFields` names `title` together with `titleVersion` or the change is `replay` (`render.ts:929`); a `remote` title change names only `title`, so it does not refresh them. Remote cell changes already take the incremental path (`:919`); `replay` paints inside the standalone undo owner's `whileApplying` (`:945`), which a shared replay must not use |
| D10 | Whole-document entries while shared | #1532 (adoption kept as its own family: `LiveDocumentPort.assign` is still the standalone `adopt`); `createTransitions` in `src/application/transitions/transitions.ts` (`open`, `startNew`, `restore`, `recover` all end in `ports.live.assign` at `:56`); assumed rule 37 | Restore and recover are already refused (#1519: `session-merge.ts:51`, `:64`, `:78`, `history.ts:194`; `drafts.ts:387`, `:464`, `:475`). Open, new, last-file resume, inbound open, prompter launch and plain Open each either leave the shared session first or are refused with a reason (Q2). None calls the standalone `createSession` over a shared owner without the leave sequence of section 4 |
| D11 | Startup identity compare | `src/bootstrap/startup/initial-document.ts:40` compares `ports.liveDocument()` (`heldDocument`, `src/bootstrap/wiring/startup.ts:47`) with the stash result by object identity; [Stage 0 audit 3](stage-0/3-session-callers.md), row for `startupPorts` | Either a shared session cannot exist while `openInitialDocument` runs (Q3), or the compare and `ports.open` are replaced by a shared-aware decision. With a shared owner, `held()` is the projection, `createStashedWork` answers the loaded document with a reason, and the compare would open the loaded file over the shared session |
| D12 | `openProjectFile` and `loadFileIntoEditor` | [merge and stash, Limits](stage-2-disabled-merge-stash.md#limits) | They take a `permitted` check that only reload passes today; the entries of Q2 that are refused pass one |
| D13 | Undo of a merge from history | Assumed rule 37 | Closed by #1519 (`restoreSnapshot` refuses with `history`); package 14 adds one composed test that it refuses through the real wiring |
| D14 | Shared tab source | [drafts and history, Limits](stage-2-disabled-drafts-history.md#limits); plan section 3 ("Desktop tabs know only `file` and `blank`") | Package 14 does not build the desktop tab source (Stage 4 with the one-tab rule). It declares the limit: in Stage 2 a shared session exists only in a test build, and the keep flush answers as a store that cannot write |
| D36 | Per-owner subscriptions | Found here: `createSession` subscribes `numbering.changed(change.changes)` and `records.resync(made.held(), change.changes)` (`session-owner.ts:102` to `:105`) | A shared owner gets the numbering subscription; the b-roll reconciler is not resynced from a shared projection (records are operations there, package 8) and is resynced with the whole standalone document on leaving |
| D37 | Epoch and generation | Found here: `adoptReplacement` carries `{ epoch, generation }` from the old owner (`session-owner.ts:228`); `SharedSessionPorts.after` | Entering and leaving each pass the old owner's counters, so the epoch opens anew and captured operations (`stillOwns`) see the replacement |
| D38 | Rule 26: fetch what was declined | Assumed rule 26; [ingress gate, bounded buffered arrivals](stage-2-ingress-gate.md#bounded-buffered-arrivals) | The in-page peer delivers only through `applySharedUpdate` on the handle, so the gate holds arrivals while a buffer is open and declines at the bound; on `observeSharedDeclined` it re-sends from the receiver's state vector (`encodeSharedStateVector`, `encodeSharedUpdate`) |

### Drafts and history (assumed rule 53, open items from the review of #1519)

| # | Duty | Source | Must be true |
| --- | --- | --- | --- |
| D15a | Item 1 | `src/application/recovery/drafts.ts:386` (superseded check) and `:428` (refused merge) | A file-draft restore that becomes shared during one of its two waits shows no "kept" message, or the switch refuses while a draft restore is pending (Q5) |
| D15b | Item 2 | `drafts.ts:475` | A draft refused at startup leaves no restore marked pending for the page's life. Under Q3 this cannot happen; a test pins that the switch is refused until startup has settled |
| D15c | Item 3 | rule 53 | Entering a shared session with unsaved standalone work deals with that work, so that leaving with a clean document and deleting the old draft at the first flush is correct (Q5) |
| D15d | Item 4 | rule 53 | Closing a tab whose file is gone, in a shared session with an older standalone draft, asks the unsaved question or is declared. With D14 this is a declared limit of test builds |
| D15e | Item 5 | rule 53 | `importHistoryBundle` and `startHistoryMigration` stay unguarded; recorded as such |
| D15f | Item 6 | rule 53; plan section 3 | Whether a shared session takes snapshots (Q7) |

### Native bindings

| # | Duty | Source | Must be true |
| --- | --- | --- | --- |
| D16 | `typeAtMarks` off for shared narration | #1530, rule 55 R4; `onBeforeInput` in `src/features/editing/focus.ts:45`, port at `src/bootstrap/wiring/editor.ts:642` (`typePendingMarks`, then `typeAtDirectionEdge`) | While a buffer binding is mounted, `onBeforeInput` neither prevents the event nor calls `typed` for a shared cell; the text is typed through the binding (rule 55: the chosen format is not applied, text at a direction's edge continues the direction) |
| D17 | Old paste, cut and drop routes | #1530 notes for package 14, rule 55 R5 | While the Split binding is mounted, no standalone handler acts on a native event the binding prevented. Candidates, each to be checked: the cell routes of `mountClipboardRoutes` (`src/features/clipboard/routes.ts:59` copy and cut, `:90` paste, installed at `:112`, no `defaultPrevented` check), `onDrop` (`src/features/rows/editor.ts:128`) and, found here, the rows `input` and `keydown` ports (`rows/editor.ts:89`, `:93`). `mountFlowClipboardRoutes` (`routes.ts:35`) already checks `defaultPrevented` |
| D18 | Literals the binding lacks | #1530 notes | Hand-written literals for the caret after someone else's change while nobody types (R7: same offset, not same character) and for typing at a stage direction's edge, in both views |
| D19 | `recovered` and `missingBase` | [stage-2-buffer.md, The rule 29 recovery write](stage-2-buffer.md#the-rule-29-recovery-write) ("Wiring must route `recovered` to a notice and count it"); rule 27 | `recovered(rowId)` shows a notice and increments a counter; `missingBase` increments a counter the test hook can read |
| D20 | Shared-only scan cost | Rule 55 last bullet; #1414 tracker 9c | The ownership scan at every native event is measured in package 15 (section 6); package 14 provides a counter |
| D21 | Visual column, headings, title | Rule 55 R2; [painted base, Buffer cases](stage-2-painted-base.md#buffer-cases) item 4 | Until 9d and 9e land, a shared session refuses native edits there with `buffer-visual-column` (Split) and the Writer's existing refusals. Package 14 does not bind them |

Not a package 14 duty: the cross-beat composition limit of rule 31 ([stage-2-buffer.md](stage-2-buffer.md), "This limit is not assigned to package 14").

### Commands and records

| # | Duty | Source | Must be true |
| --- | --- | --- | --- |
| D22 | Handlers registered | #1414 tracker 8 (#1503: "nothing in `src` registers record handlers on a replica yet"); [commit-time writers](stage-2-commit-time-writers.md) ("It must register the record handlers, or a commit that introduces a tag is refused as a whole") | Every family in section 1 is registered on the composed handle before the first command |
| D23 | Moves refused by name | #1414 tracker 5c (#1506: "the disable list has a `moves` entry that no command consults yet, and nothing in `src` registers the refusal on a replica yet: both for package 14"); rule 40 | Every move command asks `moves` and shows its reason in a shared session; `registerSharedMoveRefusal` is registered |
| D24 | Author port | [stage-2-buffer.md](stage-2-buffer.md#the-rule-29-recovery-write) (operation ids accept letters, digits, `_` and `-`) | One port gives `{ id, by }` for every shared list: a per-writer prefix plus a serial, `by` from the editor name. Found here: nothing chooses the writer prefix |
| D25 | Every command serves or refuses visibly | Found here: `shared-session.ts:237`; plan section 2 (normal writing is mandatory). Section 3 | Each builder in section 3 either sends a shared list (with the beat stamp step of [Stamps](stage-2-commit-time-writers.md#stamps) where it changes a beat's text) or is refused with a reason the person sees. Serving Enter, formatting, paste and cut overturns assumed rules 31 and 55 (Q11) |
| D26 | Comment commands' author | [commit-time writers, Comment stamps](stage-2-commit-time-writers.md#comment-stamps) | `src/features/comments` passes the shared author in a shared session. Built: the feature passes `CommentStatePorts.shared()` to every comment command but restore conflict, and `sharedCommentPorts` (`src/bootstrap/wiring/ports/shared-comments.ts`) builds it. The wiring answers `null` until the composition replaces `shared: () => null` in `src/bootstrap/wiring/comments.ts` with `sharedCommentPorts({ handle, author: () => author.next(), cells })` |
| D27 | Record builders' callers | [commit-time writers](stage-2-commit-time-writers.md) (B-roll and people sections); rule 49 comment ("records arriving with pasted or bulk-tagged text, the export stamp, the file entry (package 14 first)") | `sharedBrollIntroducedByText` and `sharedPeopleIntroducedByText` are called on a visual-cell commit (needs 9e); pasted and bulk-tagged records, the export stamp and the file entry are each an operation or declared. A typed `B-roll:` line reaches the document through the Split buffer's visual-cell commit, so C7 wires `sharedBrollIntroducedByText` there. Declared limit until C7: the shared entry mints nothing (D1), so a `B-roll:` line typed in a shared session is plain text with no shot on the copy that typed it and on every copy that receives it |
| D28 | Four open product questions | Rule 35 and rule 49 comments on #1414 | Nothing is built for person colour, cue rename, owner from `@Name` or paragraph starts until they are answered. Each blocks one cut: the first three block D27 cuts after C10; paragraph starts blocks C6, because the Writer writes them on open through `amend` (`writer.ts:98`), which D6 refuses while shared (Q8) |
| D29 | Rule 10 permissions | Assumed rule 10 | The shared common `comment` answers as `edit`, and both refuse once access is removed (the latter is Stage 3) |
| D30 | Rule 11 refusal | Assumed rule 11 | A paste refused for an old-style embedded image or a gallery link with a location shows its reason |
| D31 | Heading name over 200 characters | Assumed rule 46 item 4 (Stage 0 decided "shown in full with a notice"; "nothing in Stage 2 does that yet, and the loader cuts the name at 200"); rule 42 item 4 | The shared entry (D1) does not cut the name and the notice is shown. How this meets rule 42 item 4 is Q9 |

### Undo and recovery

| # | Duty | Source | Must be true |
| --- | --- | --- | --- |
| D32 | Undo record seam | Found here: section 1, shared undo row | (a) A local shared command runs through `executeSharedCommand` inside `SharedUndo.perform`, once, with a `SharedCommandDescription`: `SharedPlan` gains a label, a selection as anchors and a typing key, since `Plan` carries none of them today. (b) A plan with `undo: false` records nothing. (c) `breakGroup` is called where the standalone owner's `breakCoalescing` is (`src/application/editing/cell-editing.ts:127`, `:136`, `:149`, `:162`; `src/bootstrap/wiring/editor.ts:311`; `src/bootstrap/wiring/ports/editing.ts:30`); `hold` has one standalone trigger, a file save (`src/application/save/file-saving.ts:124`), which is refused while shared, so the shared hold has no trigger and that is recorded. (d) Undo and redo write through `reverseSharedUndoRecord` outside `session.run`, so they first pass the session's `beforeCommand` admission: open typing commits before the undo reads the document. (e) The undo and redo actions reach the shared owner while shared |
| D33 | A refused undo entry | Correction to rule 39; [stage-2-shared-undo.md](stage-2-shared-undo.md) ("owner rule 71 ... pending in the undo owner's own pull request") | Decided and pinned (Q10) |
| D34 | Undo on the switch | Plan section 4 ("Undo may reset on restart in v1") | Entering resets the standalone owner and starts an empty shared owner; leaving drops the shared owner. Declared |
| D35 | Recovery panel | #1414 tracker 11 ("the recovery panel itself (package 14)"); plan section 6 | A feature lists `session.recovery()` by kind, restores (`restore`, person restore) and discards (`sharedRecoveryDiscardOperation`) as local actions with their undo policy (rule 52), and shows nothing in a standalone session or a release build |

## 3 Commands in a shared session

Found here. The shared session refuses every plan without `shared`
(`shared-session.ts:237`). Of the 46 builders below, only the four comment
commands have a shared form, and it is used only when the caller passes an author,
which none does. Native typing reaches the document through the buffers instead of
`cellTextCommand`. Every other builder is refused as `not shared` once a shared
session is composed. What the person sees for that refusal is unverified; D25
requires a visible reason.

"Exists" names shared operation kinds in `src/core/collab/operations.ts` that the
command's change maps onto; "none" means no kind or no planner. Line numbers are in
`src/application/commands/`.

| Family | Builders | Shared operation | Proposed |
| --- | --- | --- | --- |
| Whole-cell text | `cellTextCommand` (`cell-text.ts:117`) | None for a whole cell; native typing goes through the buffers | Serve typing through the buffers. Refuse its other callers (Split input shortcuts, toolbar formatting and link confirm through `ce.edit`) until each has a range form |
| Writer flow | `flowCommand` (`flow.ts:30`) | Exists: `FlowEdit.ops` (`src/core/flow/flow.ts:65`) when `FlowPorts.operations` is given (text, mark, split, join, remove, heading kinds) | Serve (Q11) |
| Paragraph starts | `initializeFlowParagraphs` (`flow.ts:11`), run through `amend` | None | Blocked by Q8 item 4 |
| Split and join | `splitBeatCommand` (`split-join.ts:69`), `joinBeatsCommand` (`:114`) | Exists: `split`, `join` | Serve |
| Beats | `addBeatCommand` (`rows.ts:26`), `deleteBeatCommand` (`:47`) | Exists: `segment-create`, `remove` | Serve |
| Moves | `moveBeatCommand` (`rows.ts:94`), `swapBeatsCommand` (`:123`), `moveSceneCommand` (`scenes.ts:63`) | `segment-move` is registered as a refusal (rule 40) | Refuse with `moves` |
| Scenes | `addSceneCommand` (`scenes.ts:22`), `renameSceneCommand` (`:32`), `removeSceneCommand` (`:40`) | `heading-create` (built for paste and finalize), `heading-remove`; no heading text binding until 9d | Remove: serve. Rename: refuse until 9d. Add: could not classify (whether `heading-create` fits the header button's form is unverified) |
| Beat selection | `removeBeatsCommand` (`beats.ts:77`), `pasteBeatsCommand` (`:29`) | `remove` over several beats exists (its undo is refused); paste of beats would need `segment-create`, text and record operations together | Remove: serve, undo refused and declared. Paste: could not classify |
| Cell clipboard | `pasteCommand` (`clipboard.ts:227`), `cutCommand` (`:315`) | Exists: `text-insert`, `text-delete`; attachments are records | Q11; attachments refused (rule 11) |
| Status | `beatStatusCommand` (`beat-status.ts:37`), `setBeatFilmedCommand` (`:59`) | Exists: `status` | Serve |
| Numbers and settings | `beatLengthCommand` (`beat-length.ts:41`), `targetLengthCommand` (`document-settings.ts:18`), `wordsPerMinuteCommand` (`:36`) | Exists: `scalar` on beat and document | Serve |
| Title | `titleCommand` (`title.ts:31`), `fileTitleCommand` (`:11`) | `scalar` on the document exists; whether the title is stored as a scalar or as text is unverified; its binding is 9e | Could not classify; refuse until 9e |
| Gallery | `galleryCommand` (`gallery.ts:58`) | Exists: `record-create`, `record-set`, `record-delete` on gallery records, built by `sharedGalleryOperations` (`src/core/collab/gallery-operations.ts`); undo of every part is supported (#1553, #1555) | Serve (C5c): pictures by content reference, web video links, thumbnails, captions, annotations, order and removal. An edit names the record shown in the slot it changed: the edit runs a second time on a copy whose links carry their slot, and pictures are told apart by content reference. Refused by name: `gallery-local-file` (a link with a file location), `gallery-embedded-image` (an old-style embedded image or a picture without a content reference), `gallery-joined-beat` (a joined row whose other beats, through any live join, hold a gallery record with a picture or link, even one folded into a picture this row shows), `gallery-overflow` (a gallery past the first 61 entries before or after the edit) and `gallery-slot-unknown` (the copy's edit did not match the edit). Stated limit: `gallery-order-unavailable` refuses a move to the front when no rank sorts before the first picture's, as when the last of three hydrated pictures is made the cover; nothing is written |
| B-roll records | `addShotCommand`, `setShotsCommand`, `deleteShotCommand`, `addShotPropCommand`, `removeShotPropCommand` (`broll-records.ts:31` to `:102`) | Built (C5c): each builder diffs people, tags and shots before and after its edit into `record-create`, `record-set` (value, clear, or `extra` for fields the table does not store) and `record-delete`, and a shot status into a `status` event whose parents are the current heads (`sharedRegistryOperations`, `src/core/collab/record-operations.ts`). New records rank after the highest stored rank. A reorder, such as Quick Add re-adding a renamed tag's old name, moves the fewest records to the end with `rank` writes. An owner set to nobody is a clear, so it removes only the assignment this copy saw. A record without a unique id is refused (`records-without-id`). The projection reads a tag or shot with no stored owner as owner `""`, as a migrated document has | Serve |
| Production records | `registerTagCommand` (`production-records.ts:72`), `addPersonCommand` (`:82`), `deleteTagsCommand` (`:110`), `gearQuickAddCommand` (`:135`), `updateTagsCommand` (`:158`), `deletePersonCommand` (`:185`) | Built (C5c) the same way, tag status as a `status` event. Person deletion follows rule 54: the delete clears the owner assignments this copy saw, and an assignment it never saw (made by another copy at the same time, even one moving the owner away and back) stays and is listed in the `deleted-person` recovery entry, whichever copy deletes. No person colour is written (Q8 item 1). `deleteTagsCommand` with labels to unwrap rewrites whole cells and is refused as `tag-text-rewrite`, for C5d; without them it serves | Serve, except `deleteTagsCommand` with text rewrites |
| Tagging text | `tagCellsCommand` (`production-records.ts:54`), `retagCommand` (`:91`), `createBulkTagRows` (`bulk-tags.ts:14`), `rewriteCellsCommand` (`document-edit.ts:80`) | A `tag` mark exists; these rewrite whole cells, and `retagCommand` also rewrites mentions through `tag-rewrites.ts` | Could not classify; refuse until each has a range form |
| Import | `importRowsCommand` (`import-rows.ts:30`) | None | Refuse |
| Comments with a shared form | `addCommentCommand` (`comments.ts:73`), `addReplyCommand` (`:96`), `setCommentAssigneeCommand` (`:120`), `toggleResolveCommand` (`:141`) | Exists, when given an author | Serve (D26) |
| Comment delete and unwrap | `deleteCommentCommand` (`:180`), `unwrapCommentAnchorCommand` (`:209`) | Exists, when given an author and a cell reader: comment-mark removal built by `sharedCommentMarkRemovals` (`src/core/collab/comment-mark-operations.ts`), then `record-delete` | Serve (C5c): the anchor's comment marks are removed over the characters the copy saw; a delete then removes the replies the copy saw and the comment. Undo puts back the marks, the replies and the comment. Refused by name: `comment-unwrap-rewrite` (the rewrite changes anything but comment anchors, or is not in a beat's audio or visual cell). Declared: a reply posted on another copy while the comment is deleted stays, listed as `reply-without-comment`; a letter typed inside the anchor at the same time carries no comment mark; unwrapping a posted comment's anchor leaves it listed as `comment-without-words` |
| Restore conflict | `restoreConflictCommand` (`:230`) | None: replaces a whole field from merge output | Refuse (no merge runs in a shared session) |
| Save stamps | `editStamp` (`save-stamps.ts:23`), `documentIdStamp` (`:39`) | A beat stamp exists (`sharedBeatStamp`); the `docId` belongs to the instance | Could not classify `editStamp` (its callers are on the refused save path, unverified); refuse `documentIdStamp` |

Not commands, not counted: the helpers in `production-actions.ts`, `paragraphs.ts`,
`tag-rewrites.ts` and the rest of `document-edit.ts`, and `beatAt`, `beatStatus`,
`shotGrace`, `attachToGallery`, `takenBrollIds`, `freshBrollIds`, `cellRuns`,
`textCut`, `cellHtml`, `isBlankBeat`, `chosenOwner`.

Could not classify: `addSceneCommand`, `pasteBeatsCommand`, the two title commands,
the four tagging-text builders and `editStamp`. Each is refused until it is
classified.

## 4 The switch

### Who decides

In Stage 2 nobody in the product decides: the share handoff is Stage 4 and the
server Stage 3. Plan section 11: no collaboration UI in a release build, and a
hidden flag alone is not an acceptance result. Package 14 therefore adds one
test hook, `__sharedTest`, exposed through `exposeTestHook` like `__undoTest`
(`wiring.ts:415`), so it exists only in `node build.mjs --test` builds. Its
controls: `enter()`, `leave()`, a second in-page replica (`peer`) with
`type`, `deliver`, `hold` and `release` for driving remote changes, and the
counters of D19 and D20 (Q1).

### Order of entering

`enterSharedSession()` in a new module `src/bootstrap/wiring/shared-session.ts`.
The bridge adopts a shared owner only before it is hydrated (assumed rule of
#1551: `adoptShared` refuses an owner that already holds a document, so the
app's listeners hear the adopt change of hydration), so hydration comes after the
replacement, in the same task:

1. Refuse, with a named reason and no change, while: startup has not settled
   (Q3); a composition is in progress on the Writer or Split surface; a draft
   restore is pending (Q5); a transition is between capture and landing.
2. Settle the standalone side: commit focused typing through the existing
   standalone path and flush the standalone undo group, including the undo
   owner's pending note. A `noteEdit()` without a selection queues a microtask
   flush (`src/application/editing/undo/undo.ts:162`) that throws as an
   unhandled rejection if `adoptShared` runs in the same task, so entering
   continues only after that flush has run. Captured file writes are not awaited
   or cancelled (D4).
3. Read the current document once (`currentDocument()`) and keep a mutable copy:
   after `adoptShared` it answers `null` until hydration, and the copy is what
   a failed hydration goes back to.
4. Create the handle and register every handler family (D22), with nothing
   hydrated. Build the replica (at revision 0) and the shared undo owner (D32).
5. Replace the current owner with `adoptShared(build, capability)` (D3), the
   capability being `createSessionCapabilities("shared", common)`. `build`
   creates the shared session from the ports the bridge hands it, passing
   `ports.entry` (D1), `ports.capability` and `ports.after`, the old owner's
   counters (D37). The bridge disposes the standalone owner, moves numbering and
   the app's listeners to the new owner (D36) and runs `announceReplaced`.
6. Detach the destination and cancel pending autosave (D4), reset the standalone
   undo owner (`adopt(null)` clears its history,
   `src/application/editing/undo/undo.ts:133`; it hears nothing while shared,
   since the shared session's undo port has only `record`), and clear the merge
   base (`holdMergeBase(null)`).
7. Stop the Writer and start it again with `bufferedText` and `paintedText`;
   turn off the old Split handlers (D16, D17) and mount `mountSharedSplitBuffer`.
8. Hydrate (`hydrateSharedDocument`) with the `docId` of Q4, synchronously, in
   the same task as step 5. Its adopt change paints the whole document and opens
   the new epoch (D37). Nothing is painted empty in between, since no frame runs
   inside the task, and nothing is saved: the shared owner's effects hold no
   standalone save.

### Duties of C4 found in the review of #1551

- **Hydration fails.** If step 8 throws, leave back to the copy kept in step 3
  through the leaving order. Today the stale DOM would stay and every command
  would be rejected with `no document`.
- **Leaving passes a clone.** Leaving step 3 hands `adoptReplacement` a copy of
  the projection, never the frozen projection itself: `adoptReplacement` runs it
  through `migrateRows` after the shared owner is already disposed, and
  `migrateRows` throws `TypeError` on a frozen object.
- **Undo goes to the shared owner.** The app's undo owner
  (`src/application/editing/undo/undo.ts:219`: `flush`, `held`,
  `heldDocument`) throws while shared before the bridge's rejected outcome is
  reachable, so Ctrl+Z would fail with nothing shown. While shared the undo and
  redo actions are routed to the shared undo owner (D32 (e)); the bridge's
  `held` keeps refusing (assumed rule of #1551: no silent no-op).
- **A draft restore across the switch.** A literal for a draft restore whose
  `awaitUndoPoint` was captured before entering and lands after it:
  `src/application/session/apply-merge.ts:133` calls `current()`, which throws
  while shared, so `keptForNextLaunch()` never runs.

Found in the same review, for other cuts:

- **C8.** `src/application/identity/document-identity.ts:92` ignores the
  rejected outcome of its stamp after a `BroadcastChannel` message from another
  tab with the same `docId`, then marks the document not written out and shows
  "It now has its own version history", which is false while shared.
- **C5c.** `src/features/tags/production-tags.ts:142` skips registry healing
  when its stamp is refused and then runs `plan.commit()` anyway. Fixed in C5c:
  it commits only after an applied stamp, or when there was nothing to apply.

Found in the review of #1559 (C2):

- **C4.** The same shared undo owner goes to the replica (`createSharedReplica(handle,
  count, undo)`) and to the undo actions (`sharedUndoActions(session, undo)`); the
  grouping breaks C2 left at the standalone `breakCoalescing` call sites are routed
  to it; the owner is reset on entering and on leaving.
- **C6.** The Writer consumes the selection anchors an undo or redo returns
  (`SharedUndoOutcome.selection`) to put the caret back.

### Order of leaving

`leaveSharedSession()`:

1. Settle the bindings (`settle`); refuse while a composition is in progress
   (`buffer-composition`) or a recovery write was refused and its hold kept.
2. Unmount the Split cell buffer and restore the old handlers; stop the Writer
   and start it again without the shared ports.
3. Take a copy of the projection, never the frozen projection itself, run it
   through `migrateRows` (the standalone entry), and replace the owner with a standalone one with standalone capabilities and
   the shared owner's counters (D37). The shared undo owner is dropped (D34);
   the b-roll reconciler is resynced with the whole document (D36).
4. Dispose the replica and destroy the handle.

The document after leaving is an untitled standalone document with no
destination (the destination was detached on entry), with the `docId` of Q4.

### What the composition-root test pins

`tests/bootstrap/composition-root.test.ts:11` (`MOUNT_ORDER`) gains
`mountSharedSessionFeature`, directly before `startAppWhenReady`, after
`mountSettingsFeature`, in C4; C9 adds the recovery panel's mount before it. The
shared-session mount registers the hook only: no listener, no handle, no session.
It must come after every owner the switch touches (session bridge, rows render,
Writer runtime, file saving, local files, drafts). `wireApp` gains no step, so
`tests/bootstrap/wiring.test.ts` (`OWNERS`) does not change and standalone startup
is identical. A new test in `tests/bootstrap/` pins the order of steps 1 to 7 and
of leaving 1 to 4 with fakes, in the style of `wiring.test.ts:282`.

## 5 Cuts

Each cut is at most about 600 changed lines and leaves the running app as it
is: nothing reaches the switch until C10 exposes the hook. "Needs" names what
must be merged or answered first.

| Cut | Contents | Needs | Evidence |
| --- | --- | --- | --- |
| C1 Handlers and author | One adapter function that registers every handler family on a handle (D22, the registration half of D23); the author port (D24) in `src/bootstrap/wiring/ports/`, answering null in a standalone session | Package 10's remaining structure undo handlers if they add a family | A literal table of registered operation kinds against the `SharedOperation` kind union; a seeded list of each kind runs on a handle built by this function; mutant: one family left out |
| C2 Undo seam | D32: `SharedPlan` gains the description; the replica's `execute` runs `executeSharedCommand` and hands the record to `SharedUndo.perform`; `undo: false` honoured; `breakGroup` triggers; undo and redo admitted through `beforeCommand`, then `reverseSharedUndoRecord`; a shared undo port for the undo actions; the decision of Q10 | C1; package 10 (the owner and executor; the last structure cuts only widen `supports`); Q10 | Session tests with the real owner: type, remote change, undo, redo (decided rows of [stage-2-shared-undo.md](stage-2-shared-undo.md)); undo with typing open commits it first; recovery write records nothing; mutants: record dropped, record taken twice, undo skipping admission. No typing-path change in standalone |
| C3 Entry and bridge | D1, D2, D31: the shared entry. D3, D6, D36, D37: `session-owner.ts` holding either owner, the replacement boundary generalised, standalone-only members and the undo route refusing by name, per-owner subscriptions and counters. D7 checked. A `sharedSession()` reader that answers whether the current owner is shared | Package 12 (#1532 merged); the `dirty` part of Q6 | `shared-session-replicas.test.ts` minted-shot limit changes visibly; one bridge test per refusing member including the undo route; `standalone-typed-callers`, `standalone-held-callers` and `writable-read-callers` counts unchanged or reduced; `export-ab` identical |
| C4 Switch module | `src/bootstrap/wiring/shared-session.ts` with enter and leave in the order of section 4 and the C4 duties listed there, without the bindings (step 7 and leaving step 2 are ports filled by C6 and C7); the in-page peer with D38; D8 as Q6 decides; `mountSharedSessionFeature` in `main.ts` registering nothing yet; `MOUNT_ORDER` updated | C1, C2, C3; package 13 (merged); Q3, Q4, Q5, the `dirty` part of Q6 | The order test; refusals of step 1 each as a literal; D4 and D5 against `save/session-replacement.test.ts`; D15a to D15c; rule 26 literal: a decline at the bound, then release, and the declined update arrives; mutant: detach after replacement |
| C5a Flow commands | `flowCommand` copies `FlowEdit.ops` into `Plan.shared` when its ports carry an operations request; the Writer command ports pass the request only when the author port answers (C1, so never in standalone). The beat stamp step comes through a port built in the wiring from `sharedBeatStamp`, because `src/application` may not import `src/adapters` | C1, C3; Q11 | The flow differential suites unchanged; one literal per flow command on a shared session; the rule 31 tests whose expected refusal changes, changed visibly; standalone `perf-ab` typing, new scene, delete and undo rows, because `flowCommand` is on the typing path |
| C5b Structure and values | Shared lists for the "serve" rows: split, join, add and delete beat, remove beats, remove scene, status, beat length, target length, words per minute | C1, C3; package 10 for their undo (refused where not built) | One literal per builder on a shared session and through the undo owner; standalone tests of each builder unchanged |
| C5c Records and comments | Shared lists for the gallery command, the b-roll and production record builders, and for comment delete and unwrap; comment features pass the author (D26). The record builders take `sharedRecordPorts({ handle, author })` (`src/bootstrap/wiring/ports/shared-records.ts`) as their last argument; the integration lane passes it from the record features' wiring, with `author` taken from the shared author port | C1, C3; package 8 | One literal per builder; rule 54 cases through the real command; stamp rule 49 through the real command |
| C5d Visible refusals | Every "refuse" and "could not classify" builder shows a reason in a shared session; move commands ask `moves` (D23) | C3; Q12 | A test per builder that its refusal writes nothing and shows the reason; an inventory test listing every builder under `src/application/commands/` with its class from section 3, failing on a new builder |
| C6 Writer composed | Start the Writer with the shared ports; `recovered` notice and counters (D19, D20); the paragraph-start write on open as Q8 item 4 decides | C4, C5a; package 9c (merged); Q8 item 4 | `tests/features/writer` buffer tests run against the composed wiring as well as the support world; standalone `buffer-cost.test.ts` counts unchanged |
| C7 Split composed | Mount and unmount `mountSharedSplitBuffer`; D16 and D17 handlers off or routed; D18 literals; the visual-cell commit calls `sharedBrollIntroducedByText` for a typed `B-roll:` line (D27) | C4, C5a, C5b; package 9c (merged); Q11 | `cell-buffer-cost.test.ts` standalone counts unchanged; new literals for R7 and the direction edge; a test per old handler that it does not act on a prevented event; the rule 55 R5 tests whose expected refusal changes, changed visibly; mutant: `typeAtMarks` left on |
| C8 Entries while shared | D10 to D13: open, new, resume, inbound open, prompter launch and plain Open each leaving first or refused as Q2 decides | C4; Q2 | Composed tests in shared mode through `documentTransitions()`; `standalone-merge-stash-callers` and `standalone-draft-history-callers` inventories unchanged |
| C9 Recovery panel | A feature under `src/features/` listing `session.recovery()`, with restore and discard (D35); its mount added to `main.ts` and `MOUNT_ORDER` | C4; package 11 (merged) | Feature tests with literal entries for each kind; restore and discard undo per rule 52; a test that the panel renders nothing in a standalone session, and that a release build has no way to show it |
| C10 Hook and real-editor suites | `__sharedTest` exposed; browser suites with two in-page replicas on Writer and Split | C5d, C6, C7, C8 (C9 for the recovery suite); Q1 | See below |

Commit-time writer callers beyond D26 (D27) wait for 9e and for the first three
questions of Q8; each is its own cut after C10 and is not needed for the exit
gate. Package 9d (headings) and 9e (visual cells and title) are named in the
#1414 tracker as "headings, visuals and title"; which of the two holds headings
is unverified ([painted base](stage-2-painted-base.md#buffer-cases) puts all three
in 9e). Package 14 composes what exists: until they land, those fields refuse in a
shared session (D21), and their bindings are added to C6 and C7's mount when they
merge.

### Browser evidence for C10

New suites, driven through `__sharedTest`, each with hand-written expected
characters, identities and carets:

- Writer: the T01 to T04 traces of [9-stage-1-experiments.md](stage-0/9-stage-1-experiments.md)
  with a remote change from `peer`, including a synthetic composition (rule 29
  recovery entry on all replicas).
- Split: T03 (`bufferOracles.T03.expected`), R7 caret, direction edge, the
  visual column refusal.
- Switch: enter with unsaved standalone work, type, leave; the standalone
  document after leaving equals the projection.
- Refusals: one refused command from each refused family shows its reason.
- Recovery panel: a removed beat edited by `peer`, restored and discarded.

Existing suites to run for the composed code paths, plain and with
`SPLITPAGE_FREEZE_CACHES=1` where [testing.md](../architecture/testing.md#what-to-run-for-which-change)
asks: the Writer flow set `321` to `358` and `596`, `289-script-cell-ime`,
`459-cancelled-composition-redo`, `155-stage-directions`, `331-writer-flow-pending-marks`,
`598-writer-to-split-clipboard`, `78-split-join-model`, `267-writer-undo`,
`28-autosave`, `185` to `187`, `19-save-conflict`, `24-history`, `26-desktop-drafts`,
`35-open-new-document`, `52-csp`. These must pass unchanged: they prove the
standalone app is untouched by C1 to C10.

## 6 What the exit gate (package 15) needs from the composition

- **Standalone A/B.** Repeat [stage-2-standalone-baseline.md](stage-2-standalone-baseline.md#repeating-this-for-package-15)
  on package 15's head: `export-ab` (all 200 cells identical), the full
  `run-suites` regression, and `perf-ab` with the tolerance rule of
  [Stage 0 audit 7, section 6](stage-0/7-performance-baseline.md). C5a is the cut
  most likely to move a typing row.
- **Shared-session timings** against the provisional limits of Stage 0 audit 7,
  section 7, with two clients in one page through `__sharedTest` (the limits
  assume two driver processes; a single page measures the same projection and
  paint cost but not network). From the composition: input latency with one
  remote edit per second in another beat; message applied to painted frame for
  one remote character and one remote structural change; heap after load on long
  and large; retained-state growth after the heavily edited run. Join, reconnect
  and receipt rows wait for Stage 3.
- **Shared-only counters** the composition exposes: ownership scans per native
  event (D20, rule 55), rule 27 occurrences, rule 26 declines, recovery writes,
  the b-roll unit comparisons per publication and rows compared per structural
  change (open in #1414 tracker 6c).
- **Stage 1 timing rerun.** The 1a decision owes one rerun of the stale rows
  (lifetime structure, component and `withIdentity`; editing, status, comment,
  burst, split and join; reader, export, load and heap) on the merged code. The
  Node rows rerun from `prototypes/collab/` on the base; the browser rows need
  C10.
- **Mutants.** The four deliberate defects of the Stage 2 exit (lost mark,
  duplicated identity, omitted field, stale base) run once through the composed
  session as well; the three entries known not to be caught on `main` (#1414
  comments on #1498 and #1511) are package 15's.

## Open questions

All twelve were decided by the product owner on 2026-11-13 (comment "Decided by the product owner, 2026-11-13" on #1414); each took the recommended answer. The text below is kept as the record of what was asked.

Each has a recommended answer. None is decided here.

- **Q1. The flag.** **Decided: rule 79** (the test hook only). Recommended: the `__sharedTest` hook in test builds only,
  no URL parameter and no setting, until Stage 4 adds the handoff.
- **Q2. Whole-document entries while shared.** **Decided: rule 77** (leave first). Restore and recover are already
  refused (#1519). Open (rule 37): open, new, last-file resume, inbound open,
  prompter launch and plain Open. Recommended: open, new, inbound open and plain
  Open leave the shared session first (section 4, leaving), then run as today;
  last-file resume never runs while shared (it runs only at startup, Q3); the
  prompter launch reads the projection and is allowed.
- **Q3. Startup while shared.** **Decided: rule 74.** Recommended: a shared session cannot exist
  until `openInitialDocument` has settled, so D11 and rule 53 item 2 cannot
  occur in Stage 2. Hydrating a retained replica at startup is Stage 3.
- **Q4. The `docId`.** **Decided: rule 75** (new ids at both ends). Plan section 3 decides that an instance's `docId` is
  minted when the instance is created, that the source file keeps its own, and
  that each standalone export gets a new one. Stage 2 has no instance, so two
  things are open: whether the test hook's hydration counts as creating one
  (recommended: yes, mint at entry), and what the document left behind on leaving
  is. Recommended: it is a standalone copy, so it gets a new `docId`, as an
  export would.
- **Q5. Unsaved standalone work at entry, and a pending draft restore.** **Decided: rule 76.**
  Recommended: refuse entry while a draft restore is pending; on entry, the
  existing standalone draft stays on disk (drafts are refused while shared) and
  is not deleted on leaving until the standalone document is saved or
  explicitly discarded. This changes rule 53 item 3's behaviour and needs a
  ruling.
- **Q6. The unsaved mark and the close question for a shared edit.** **Decided: rule 60** (assumed, now decided). Saving and
  drafts are settled by package 13. Open: whether `dirty` marks the shared
  document unsaved, and whether closing asks. Recommended: no unsaved mark and no
  close question in Stage 2 (there is no local replica storage to be unsaved
  against); the save status shows nothing new until Stage 3's wording.
- **Q7. Snapshots in a shared session** **Decided: rule 80** (none while shared). (rule 53 item 6). Recommended: keep
  the conservative reading of #1519 (none) until the plan review.
- **Q8. The four commit-time writer questions** **Decided: rules 81, 82 and 83** (items 1 to 3) **and rule 78** (item 4: paragraphs derived until the first paragraph edit). (person colour, cue rename,
  owner from `@Name`, paragraph starts). For the product owner. The first three
  block only commit-time writer cuts after C10. Paragraph starts blocks C6
  (D28); recommended for that cut only: the Writer writes no paragraph starts on
  open in a shared session and shows them as derived, which is option (b) up to
  the first paragraph edit, and needs the ruling before C6.
- **Q9. A heading name over 200 characters.** **Decided: rule 61** (assumed, now decided). Stage 0 decided "shown in full
  with a notice" (rule 46 item 4). Open: how that meets rule 42 item 4, where a
  pasted name is cut as the standalone app cuts it, when another person's typing
  lengthens a pasted name. Recommended: the paste command keeps cutting what it
  writes; a name that becomes longer later shows in full with the notice.
- **Q10. A refused undo entry** **Decided: rule 71** (skipped with a message). (gallery, visuals, unsupported structure). The
  documented and tested design is the opposite of the recommendation:
  [stage-2-shared-undo.md](stage-2-shared-undo.md), "A refused undo keeps its
  entry, so it can be asked again", pinned by "a refusal from the executor leaves
  both stacks as they were". Recommended all the same: refuse with the reason,
  then drop the entry and count it, as the standalone owner drops an entry it
  cannot apply, so older entries stay reachable. This changes the owner and that
  pinned test.
- **Q11. Enter, formatting, paste and cut in a shared session.** **Decided: rule 72** (served). Assumed rule 31
  refuses ordinary cross-beat input until removal and join handlers land, and
  rule 55 R5 refuses Enter, formatting, paste and cut in a Split cell, "as in the
  Writer". D25 makes them work through C5a and C5b. This overturns those
  refusals and changes the tests that pin them ("rule 31 dependency: whole-start
  cross-beat ..." in `tests/features/writer/buffer-binding.test.ts`; the R5 cases
  in `tests/features/editing/cell-buffer.test.ts`). Recommended: serve them, since
  plan section 2 makes normal writing mandatory and rule 31 names the dependency
  as temporary; change each pinned test visibly in the cut that serves it.
- **Q12. What a refused command says.** **Decided: rule 73** (one sentence in the warning toast). Recommended: one sentence through the
  existing warning toast, "This is not available in a shared session yet.", for
  every builder refused for lack of a shared form; moves keep their own `moves`
  reason. Whether it becomes an entry in `SHARED_SESSION_DISABLED` is for the
  author of C5d.
