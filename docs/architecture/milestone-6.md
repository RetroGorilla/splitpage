# Milestone 6: finish feature ownership and the editing migration

The working notes for milestone 6 of [the implementation plan](../IMPLEMENTATION-PLAN.md#6--finish-feature-ownership-and-editing-migration), as amended by the [external review of the plan](milestones-4-7-rescope.md#external-review-of-milestone-6s-plan-2026-10-14). The plan holds the scope, the CSS bound and the gate. This file holds the step list, the acceptance tables and the `21-events.js` ledger, and records what each step built once it merges.

Status: planned. Derived from `dcfb92d`. Nothing is built yet.

## Models

Editing hot-path code and the undo adapter are Opus steps (Adam's standing rule), as is anything that reaches the save path. Well-specified feature moves are Sonnet. Every PR gets an independent Opus review. Any preload or IPC change is its own Opus PR with the full desktop smoke.

## Deferred out of M6

- Review-mode work, including the reviewer comment-anchor command (#466), follows Adam's standing rule: nothing out of scope before core writing work. Existing capability checks and working comment and draft behaviour are preserved while the code moves, and permissions are not broadened.
- #308 (toast host under Present) and #350 (Find bar behind the prompter) are already approved. They land after core writing work, each as a focused owner-local repair with fail-first evidence.
- Comprehensive startup wiring stays in milestone 7. Save-completion consolidation, the remaining recovery extraction, the build-entry switch and unused-`S` cleanup stay in 4.x.

## The steps, in order

Each step is a small PR or a short series. A step starts only when its prerequisites have merged.

| Step | Scope | Prerequisites | Model |
| --- | --- | --- | --- |
| 6.1 | Selection and composition | none | Opus |
| 6.2 | Undo replay as a transaction | 6.1 | Opus |
| 6.3 | `foldIntoEdit` | 6.2 | Opus |
| 6.4 | Editor commands and media | 6.1, 6.2 | Opus |
| 6.5 | The #325 replacement, then repair-on-read removal | 6.2, 6.4 | Opus |
| 6.6 | The rest of `applyMerge` | 6.2 | Opus |
| 6.7 | CSS colour tokens | none (lands before 6.8.1's aggregation) | Sonnet |
| 6.8 | Per-feature moves (6.8.1 to 6.8.6) | 6.1 to 6.6 | Sonnet unless noted |
| 6.9 | Startup extraction and the deletion of `21-events.js` | all rows of the ledger accounted for | Opus |

### 6.1 Selection and composition (#464)

- **Scope.** The selection model: epoch, scene and field, direction and affinity, atoms, mapping through edits, split and join, undo and incoming changes, and the vanished scene. Focus is separate from selection. A composition lifetime is tied to its cell and session.
- **Invariants kept.** Caret and selection survive repaint; typed values still pending keep their characterized behaviour; composition marks and cancelled-composition drops from [session.md](session.md) section 6 are unchanged; the paint guard and blur restrictions from M4 move with the code.
- **Tests.** The acceptance points on #464, each fail-first; the existing typing, IME and split-join suites (`split-join-app`, the composition suites); a dispose and remount case for the composition lifetime.

### 6.2 Undo replay as a transaction

- **Scope.** `undo()` and `redo()` in `12a-undo.js` stop writing `S.state` directly through `applyStepsLive` and pass through the document-mutation boundary as a transaction kind of its own. The undo algorithm, diffing and inversion stay.
- **Commit contract.**
  - Replay, row stamps and dependent reconciliation execute inside the mutation boundary.
  - An accepted replay advances the generation once, publishes once and records no new ordinary undo entry.
  - An empty or refused replay has no document edit effects.
  - A failure before the commit leaves the document and the history consistent. A failure after it is reported as committed and does not roll the document back.
  - The change set covers owner re-pointing and cleanup (#402, #494), including lists the original entry did not carry and the `docField` steps recorded into the entry.
- **Today.** `commit` in `document-session.ts` advances the generation, records an undo entry through `ports.undo.record` and publishes `"edit"`, unconditionally. Using it for a replay would record the replay again. Wrapping only `applyStepsLive` would leave the stamps (`21-events.js`, after replay) outside the boundary and could omit indirect owner writes from rollback and change reporting. Today the replay reaches the session only afterwards, as `afterUndoApplied`'s `markDirty`, then renders and settles from `21-events.js`.
- **Preserved.** Refusal and history behaviour, grouping, coalescing, `forget`, the limit of 200, and the typing additions (coalesce-back drops, redo given back, composition marks).
- **Acceptance table: every undo route.**

| Route | Today | Must reach | Evidence |
| --- | --- | --- | --- |
| Keyboard shortcuts (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y) | `21-events.js` keydown, native controls and draft boxes distinguished | the replay transaction | a keyboard case per shortcut; one gesture processed once |
| `historyUndo`, `historyRedo` actions | action handlers calling `undo()`/`redo()` | the replay transaction | action-route case |
| `beforeinput` undo and redo | the two `beforeinput` routes | the replay transaction | both input types, one gesture one replay |
| Toast Undo | direct `undo()` call | the replay transaction | toast case, including after a refused replay |
| Writer close and reopen (Ctrl+Y reopen, `undoSerial`) | `19-writer.js` | the replay transaction; reopen rule unchanged | existing Writer undo cases |
| Comment and reply draft undo (INV-55) | the box's own history | stays local; never the document's | `draft-edit.test.mjs`, `81-draft-edit.txt` |

- **Tests.** Fail-first cases for: generation advances once; one publication; no new entry in the undo or redo stack beyond the move; an empty replay and a refused replay change nothing observable; a pre-commit throw leaves document and history as before; a post-commit throw is reported and the document stays committed; re-pointed owners appear in the change set; the existing undo-owner, lifetime, draft and differential suites pass unchanged.

### 6.3 `foldIntoEdit`

- **Scope.** A focused follow-up to the replay PR. `foldIntoEdit` in `12a-undo.js` (caller: `05v-video.js`, thumbnail amendments) becomes a mutation-boundary task: it keeps its history association and ownership guard and creates no extra user-visible undo step.
- **Tests.** An amended thumbnail undoes together with the edit it belongs to; a stale or replaced owner is refused by the guard; the history count is unchanged by the amendment.

### 6.4 Editor commands and media

- **Scope.** The remaining direct writes become commands, one small PR per module, in this order: `05b-cell-edit.js` (still writes and stamps directly), `06-rows.js` (row mutation), the media-cell typed HTML variant (`05-render.js` and `06-rows.js`, which INV-10 retires), then the dependent paths: the scene clipboard in `05c-clipboard.js`, the video amendments in `05v-video.js`, and `19-writer.js`. `05c-clipboard.js` and `19-writer.js` already use commands; the PR changes only what still writes around them.
- **Invariants kept.** INV-10 (content enters a script cell only in canonical, sanitised form); the ownership capture before clipboard preparation and before image loading, so a result after replacement is dropped with its existing toast; rendering creates no edit (#463).
- **Tests.** Per module: a fail-first case showing the write goes through the session; the existing typing, paste, split-join, row and Writer suites; for the media variant, a case showing no typed HTML cell value can be produced.

### 6.5 Repair-on-read replacement (#325)

- **Order matters.** The replacement lands first; the repair calls go second, in separate PRs.
- **Replacement coverage.** Entry and adoption, the affected editor and production commands, import scans (M5 step 3 already places them inside the import transaction and before new-document adoption; that boundary is preserved), incoming merges, and undo and redo each maintain the b-roll and tag records their edit needs, inside the same transaction as the originating edit.
- **Removal.** The calls in the b-roll badge (`brollEntries()` in `08c-broll.js`) and in save preparation (`settleDerivedRecords` in `14-export.js`) go only when the coverage above is in. Save preparation is then read-only.
- **Tests.** Repeated render, selector and export reads leave content, generation and history unchanged; each originating edit includes its dependent repair; `production-shims.test.mjs` and `broll-id-sequence.test.mjs` change as explained corrections (they fail today if `brollEntries()` stops repairing), never by weakening; the "H" fuzz findings on #325 (an `audioRef` kept with angle brackets, a nameless shot) are fixed in the repairing command.

### 6.6 The rest of `applyMerge`

- **Scope.** First characterize the options and callers. Then move orchestration behind typed application ports and the presentation into its owning feature. Synchronous callers keep their contract unless their conversion is explicitly part of the PR. This is not a merge-algorithm rewrite, and it does not turn M5's append and replace imports into whole-document adoption. `mergeIncoming` and `session.absorbMerged` already are the typed merge boundary.
- **Callers.** `13-hosted.js` consumes `.result` immediately and calls `job.moved()` before retrying; `20g-drafts.js` uses the awaited snapshot branch; `18a-local-merge.js` is the local merge path.
- **Options table** (each row needs a characterization case before the move and the same case after):

| Option | What it controls | Evidence |
| --- | --- | --- |
| `mergeOnly` | merge without the screen side | caller case per use |
| `unchanged` | outcome when nothing differs | no render, no dirty, no snapshot |
| `report: false` | suppresses chips and toasts | silent merge keeps dirty and baseline behaviour |
| `alreadySaved` | the merged result is already on its destination | baseline set, no extra save |
| `noAutoSave` | suppresses the automatic save | no autosave scheduled, dirty kept |
| `newBase` | sets the new merge base through `setBaseState` | base advances only on the documented paths |
| undo snapshots | snapshots taken before the merge | entries as today, `forget` as today |
| `awaitUndoPoint` | waits for the undo point before continuing | ordering case, the awaited snapshot branch of `20g-drafts.js` |

- **Kept.** Capture and check behaviour across snapshot persistence; the new base set through `setBaseState`; save, recovery and export invariants (below).

### 6.7 CSS colour tokens

- **Scope.** The 239 hex and 37 rgba/hsl colour literals become existing or new tokens, in one Sonnet PR. Spacing stays as px. No aggregation and no feature move in the same PR.
- **Evidence.** The CSS evidence below, with the palette and export-colour tests passing.

### 6.8 Per-feature moves

One feature per PR, taking the rows of the ledger it owns and the styles of its feature. The first of them adds the aggregation to `build.mjs`.

| Step | Feature | Modules |
| --- | --- | --- |
| 6.8.1 | Tags and production panels | `07-production-tags.js`, `08-production-panels.js` |
| 6.8.2 | B-roll | `08c-broll.js`, `08d-broll-panel.js` |
| 6.8.3 | Comments (no review-mode work) | `10-comments.js` |
| 6.8.4 | Find | `09-find-replace.js` |
| 6.8.5 | Panels, settings, gallery, prompter | the remaining view modules |
| 6.8.6 | Overlay and focus ownership (INV-19), then #308 and #350 as focused repairs after core writing work | overlay modules, `12-dirty-toast.js` |

Each PR: the feature owns its bindings, local state, styles and mount and dispose; no global state access, concrete platform service or direct live-document mutation; the dispose cases below; the CSS evidence below if styles move; the save, recovery and export invariants below if a save, restore or export route moves; a bridge or duplicate goes in the PR that migrates its last consumer.

### 6.9 Startup extraction and deleting `21-events.js`

- **Prerequisites.** Every ledger row accounted for with its removal PR merged, and no old registration left.
- **Startup first.** The startup duties are extracted before deletion into their owners (not into another catch-all): initial document loading, stash and draft recovery ordering, identity and history setup, desktop initialization (draft acquisition), service-worker registration and unload handling. Comprehensive dependency wiring is M7.
- **Evidence.** Remount evidence shows exactly one handler per ledger row; the existing startup sequences (stash adoption, first render, draft resume) run in the same order; the full gate.

## The `21-events.js` ledger

Baseline: `2ab6dcf`. The inventory has **294 rows: 204 listener-registration sites, 57 delegated click branches and 33 startup/resource responsibilities**. The table groups those rows by owning step and target; every registration line and B/S inventory ID appears once. These are inventory counts, not runtime listener counts or completed migration evidence.

B means non-capture, C means capture; B does not imply that the event bubbles. D means both `#comment-modal` and `#comments-panel` (the loop at `21-events.js:1537`): each of its 13 rows binds twice. The Drive credential row binds two inputs; the import-split row binds four radios. Optional targets and startup conditions remain conditional. A registration that coordinates several features counts under one owner; its adapters retain their own responsibilities and order.

Each removal PR records the receiving owner, target and phase, precedence, lifetime and disposer, regression evidence and removal step for the rows it takes. Shared registrations are removed only when their last route has moved; the coordinating owner preserves the remaining routes until then.

| Owning step | Rows | Target, phase and inventory references | Responsibility |
| --- | ---: | --- | --- |
| 6.1 | 1 | `#rows`: focusout/B `21-events.js:1240` | Rows paint/undo-safe blur, tag cleanup, sanitised synchronization and b-roll anchoring through the owning adapters. |
| 6.1 | 4 | `#rows`: beforeinput/B `21-events.js:1254`, compositionstart/B `21-events.js:1255`, compositionend/B `21-events.js:1256`, keydown/C `21-events.js:1257` | Rows pending-mark/direction-edge beforeinput, script composition marks, cancellation and post-cancel check. |
| 6.1 | 2 | document: focusin/B `21-events.js:1321`, selectionchange/B `21-events.js:1598` | Remember focused editable row; forget stale marks; update cell/Writer formatting and tag UI through their owners. |
| 6.1 | 1 | `#writer-doc`: focusout/B `21-events.js:1777` | Writer paint/undo-safe blur and synchronization. |
| 6.1 | 1 | `#writer-doc`: beforeinput/B `21-events.js:1783` | Writer pending-mark/direction-edge beforeinput. |
| 6.1 | 1 | `#writer-doc`: compositionstart/B `21-events.js:1784` | Writer script composition start and undo mark. |
| 6.1 | 1 | `#writer-doc`: compositionend/B `21-events.js:1785` | Writer script composition end, settlement and cancellation. |
| 6.1 | 1 | `#writer-doc`: keydown/C `21-events.js:1786` | Writer composition keydown capture, before Writer keydown capture at 1787. |
| 6.1 | 1 | `#writer-doc`: focusin/B `21-events.js:1788` | Remember focused Writer paragraph and update formatting UI. |
| 6.1 | 1 | S05 `21-events.js:822–824` Composition lifetime state: Tracks undo mark and post-cancel input classification across root/Writer events | Shared script composition lifetime for rows and Writer. |
| 6.2 | 2 | window: keydown/B `21-events.js:1249`; `#rows`: beforeinput/B `21-events.js:1253` | Document keyboard undo outside rows/Writer respects native and draft ownership; script beforeinput reaches replay. |
| 6.2 | 1 | `#writer-doc`: beforeinput/B `21-events.js:1782` | Writer script historyUndo/historyRedo beforeinput reaches replay. |
| 6.2 | 2 | S07 `21-events.js:930` Toast action callback: Undo only while captured undo entry is still latest; otherwise warn; S08 `21-events.js:1248` Undo hook installation: Install sent-comment predicate, replay/refusal callbacks. After apply: stamp affected rows, dirty, guarded render, production render, settle, restore focus/caret | Guarded Toast Undo and undo-hook installation, including the selection/focus adapter. |
| 6.4 | 7 | `#rows`: click/B `21-events.js:1237`, mousedown/B `21-events.js:1238`, input/B `21-events.js:1239`, paste/B `21-events.js:1241`, copy/B `21-events.js:1242`, cut/B `21-events.js:1243`, keydown/B `21-events.js:1244` | Rows shared click/mousedown/input/keydown coordination and script paste/copy/cut; call feature adapters in the order below. |
| 6.4 | 8 | `#rows`: dragstart/B `21-events.js:1258`, dragend/B `21-events.js:1259`, dragover/B `21-events.js:1260`, dragleave/B `21-events.js:1261`, drop/B `21-events.js:1262`; document: mouseup/B `21-events.js:1263`; window: dragover/B `21-events.js:1266`; `.add-row-bar`: click/B `21-events.js:1271` | Row drag state, markers, auto-scroll (stop over expanded rundown), media/content drop and add-row delegation. |
| 6.4 | 3 | `#file-input`: change/B `21-events.js:1609`; `#doc-title`: input/B `21-events.js:1617`; `#writer-title`: input/B `21-events.js:1807` | Image picker reset/completion and pending slot; guarded main/Writer title writes, mirroring, page-title update and dirty effects. |
| 6.4 | 1 | `#writer-doc`: input/B `21-events.js:1776` | Writer script input synchronization, composition settlement and dependent refresh. |
| 6.4 | 1 | `#writer-doc`: paste/B `21-events.js:1778` | Writer owned script/scene paste. |
| 6.4 | 1 | `#writer-doc`: copy/B `21-events.js:1779` | Writer canonical script copy. |
| 6.4 | 1 | `#writer-doc`: cut/B `21-events.js:1780` | Writer script cut and dependent refresh. |
| 6.4 | 1 | `#writer-doc`: keydown/B `21-events.js:1781` | Writer shared bubble keydown, including undo and tag adapters in the order below. |
| 6.4 | 1 | `#writer-doc`: keydown/C `21-events.js:1787` | Writer keydown capture, after composition capture at 1786 and before bubble routing. |
| 6.4 | 1 | `.writer-bar`: click/B `21-events.js:1816` | Writer bar: formatting first; gutter preference and narration DOCX export use view/export owners. |
| 6.4 | 6 | B02 `21-events.js:339` `[data-action="add-row"]`; B03 `21-events.js:342` `.mini-toolbar button[data-cmd]`; B04 `21-events.js:345` `link-confirm`; B05 `21-events.js:348` `link-cancel`; B06 `21-events.js:351` `video-confirm`; B07 `21-events.js:354` `video-cancel` | Add row; editor toolbar and link/video popover confirm/cancel (342-355). |
| 6.4 | 13 | B44 `21-events.js:508` `cycle-status`; B45 `21-events.js:511` Static status lamp inside row; B46 `21-events.js:514` `expand-hidden-shot`; B47 `21-events.js:517` `jump-row`; B48 `21-events.js:532` `row-menu`; B49 `21-events.js:535` `move-up`; B50 `21-events.js:538` `move-down`; B51 `21-events.js:541` `insert-below`; B52 `21-events.js:544` `delete-row`; B53 `21-events.js:547` `image-add`, `image-add-more`, `image-replace`; B54 `21-events.js:556` `image-remove`; B56 `21-events.js:566` `gallery-link-remove`; B57 `21-events.js:572` `gallery-link` | Scene status, visibility/navigation, row menus/moves/insertion/deletion and media picker/remove/link bindings. |
| 6.4 | 2 | S02 `21-events.js:580` Pending image replacement slot: Written by image picker launch, consumed/reset by file-input change; S04 `21-events.js:763` Formatting shortcut map: Maps B/I/U to bold/italic/underline | Pending image replacement slot and formatting shortcut map. |
| 6.6 | 3 | `#merge-dismiss`: click/B `21-events.js:1491`; `#merge-undo`: click/B `21-events.js:1494`; `#merge-review`: click/B `21-events.js:1495` | Merge banner dismissal, undoMerge and review; open the existing comments panel through its owner, without review-mode work. |
| 6.8.1 | 10 | `#tag-ghost`, if present: pointerdown/B `21-events.js:1176`; `#tag-open-hint`, if present: pointerdown/B `21-events.js:1181`; window: scroll/C `21-events.js:1272`, resize/B `21-events.js:1273`, scroll/C `21-events.js:1274`, resize/B `21-events.js:1275`, scroll/C `21-events.js:1276`, resize/B `21-events.js:1277`; `#tag-suggest`: mousedown/B `21-events.js:1280`, click/B `21-events.js:1281` | Tag ghost/open hint/suggestions and plain-tag UI; pointer focus prevention and captured-scroll behavior. |
| 6.8.1 | 8 | `#btn-production`: click/B `21-events.js:1338`; `#production-close`: click/B `21-events.js:1339`; `#production-panel`: keydown/B `21-events.js:1341`, change/B `21-events.js:1356`; `#btn-gear`: click/B `21-events.js:1370`; `#gear-close`: click/B `21-events.js:1371`; `#gear-modes`: click/B `21-events.js:1373`; `#gear-quickadd-save`: click/B `21-events.js:1379` | Production/gear actions, close, bulk-person keys, selection clearing, owner/status changes, grouping and quick-add; review refusals and input exclusions stay. |
| 6.8.1 | 7 | `#tag-modal`: click/B `21-events.js:1452`, click/B `21-events.js:1456`; `#tag-close`: click/B `21-events.js:1453`; `#tag-cancel`: click/B `21-events.js:1454`; `#tag-apply`: click/B `21-events.js:1455`; `#tag-name`: keydown/B `21-events.js:1459`; window: keydown/B `21-events.js:1462` | Tag composer delegation, close/cancel/apply, backdrop and Enter/Escape; delegated click before backdrop handling. |
| 6.8.1 | 25 | B17 `21-events.js:382` `jump-tag`; B19 `21-events.js:395` Modifier click on production tag entity; B20 `21-events.js:399` Touch mode with selection; tag-entity row; B21 `21-events.js:407` `bulk-clear`; B22 `21-events.js:410` `bulk-delete`; B23 `21-events.js:417` `bulk-person-new`; B24 `21-events.js:426` `bulk-person-save`; B25 `21-events.js:429` `bulk-person-cancel`; B26 `21-events.js:432` `tag-status-cycle`; B27 `21-events.js:435` `tag-status-set`; B28 `21-events.js:441` `tag-expand`; B29 `21-events.js:451` `tag-person-new`; B30 `21-events.js:461` `tag-person-save`; B31 `21-events.js:464` `tag-person-cancel`; B32 `21-events.js:467` `person-delete`; B33 `21-events.js:470` `#production-modes [data-group]`; B34 `21-events.js:478` `export-breakdown`; B35 `21-events.js:481` `export-packing-gear`; B36 `21-events.js:484` `tag-rename`; B37 `21-events.js:487` `tag-rename-save`; B38 `21-events.js:490` `tag-rename-cancel`; B39 `21-events.js:493` `tag-all-mentions`; B40 `21-events.js:496` `tag-remove`; B41 `21-events.js:499` `tag-delete`; B42 `21-events.js:502` `#tag-cats .tag-cat-btn` | Tag jumps, modifier/touch selection, bulk/person controls, status, expansion, grouping, exports, rename, mentions, removal/deletion and categories. |
| 6.8.1 | 4 | S06 `21-events.js:609` 30 ms timer; production tag card: Resolve card after panel render, then scroll and flash; no timer handle/disposer retained; S13 `21-events.js:1173` Touch-selection installation: Install production-list touch selection resources; S26 `21-events.js:1340` Production panel delegate installation: Install shared tag-entity click/key/change/input/focusout delegates; S27 `21-events.js:1372` Gear panel delegate installation: Install same delegates on gear panel | Card reveal timer, touch selection and production/gear delegate resources. |
| 6.8.2 | 1 | S28 `21-events.js:1381` B-roll installation: Install b-roll panel listeners and resources | B-roll panel listeners and resources. |
| 6.8.3 | 2 | document: input/B `21-events.js:1228`, compositionend/B `21-events.js:1232` | Author-name limiting outside composition and after compositionend. |
| 6.8.3 | 13 | D: click/B `21-events.js:1538`, mousedown/B `21-events.js:1539`, input/B `21-events.js:1540`, focusout/B `21-events.js:1541`, paste/B `21-events.js:1542`, keydown/B `21-events.js:1543`, focusin/B `21-events.js:1544`, beforeinput/B `21-events.js:1545`, compositionstart/B `21-events.js:1546`, compositionend/B `21-events.js:1547`, dragstart/B `21-events.js:1548`, dragend/B `21-events.js:1549`, drop/B `21-events.js:1550` | Both comment roots: shared routing/selection/blur adapters, local draft input/focus/history/marks/composition, paste and drag/drop; no document replay. |
| 6.8.3 | 9 | `#btn-comments`: click/B `21-events.js:1553`; `#comments-panel-close`: click/B `21-events.js:1554`; `#comments-panel`: change/B `21-events.js:1556`; `#comments-sort`: change/B `21-events.js:1564`; `#comment-close`: click/B `21-events.js:1569`; `#comment-cancel`: click/B `21-events.js:1570`; `#comment-post`: click/B `21-events.js:1571`; `#comment-modal`: click/B `21-events.js:1572`; `#comment-image-input`: change/B `21-events.js:1575` | Panel open/close, assignee filter/assignment, sort with reply-draft capture, composer close/cancel/post/backdrop and async image completion; resolve the live composer after await. |
| 6.8.3 | 10 | B08 `21-events.js:357` `toggle-resolve`; B09 `21-events.js:360` `#comments-filter-seg [data-filter]`; B10 `21-events.js:363` `toggle-reply`; B11 `21-events.js:366` `reply-cancel`; B12 `21-events.js:369` `reply-post`; B13 `21-events.js:372` `delete-comment`; B14 `21-events.js:375` `restore-conflict`; B15 `21-events.js:378` `comment-menu`; B16 `21-events.js:380` Inside `.comment-menu`; B18 `21-events.js:388` Jumpable comment card, outside reply/anchor, collapsed selection | Comment/reply controls, filtering, conflict restoration, menu shielding and anchor jumps (357-390); current capability checks stay. |
| 6.8.3 | 2 | S03 `21-events.js:712` Draft drag source: Tracks source box across dragstart/end/drop; S30 `21-events.js:1563` Comments sort-control initialization: Initialize sort select from `S.commentSortMode` before its change binding | Draft drag source and sort initialization before its change binding. |
| 6.8.4 | 12 | `#find-close`: click/B `21-events.js:1285`; `#find-next`: click/B `21-events.js:1286`; `#find-prev`: click/B `21-events.js:1287`; `#find-replace`: click/B `21-events.js:1288`; `#find-replace-all`: click/B `21-events.js:1289`; `#find-tag`: click/B `21-events.js:1290`; `#find-tag-go`: click/B `21-events.js:1291`; `#find-tag-cancel`: click/B `21-events.js:1292`; `#find-tag-cats`: click/B `21-events.js:1296`; `#find-case`: click/B `21-events.js:1300`; `#find-input`: input/B `21-events.js:1306`; `#findbar`: keydown/B `21-events.js:1307` | Find navigation/replacement, bulk tags/categories, case/ARIA/query updates, input and Enter/Escape/focus return; button exclusions stay. |
| 6.8.5 | 2 | `#update-bar-dismiss`, if present: click/B `21-events.js:1168`; `#desktop-app-bar-dismiss`, if present: click/B `21-events.js:1172` | Update and desktop-app notice dismissal. |
| 6.8.5 | 5 | `#identity-chip`: click/B `21-events.js:1283`; `#runtime-chip`: click/B `21-events.js:1327`; `#length-status`, if present: click/B `21-events.js:1329`; `#history-close`: click/B `21-events.js:1331`; `#history-panel`: click/B `21-events.js:1332` | Identity, WPM and history controls; snapshot restoration through history-panel delegation. |
| 6.8.5 | 4 | `#server-modal`: click/B `21-events.js:1383`; `#server-close`: click/B `21-events.js:1401`; `#server-cancel`: click/B `21-events.js:1402`; window: keydown/B `21-events.js:1403` | Server picker backdrop/close/cancel/Escape, open/delete and Electron routeOpen. |
| 6.8.5 | 8 | `#drive-modal`: click/B `21-events.js:1407`; `#drive-close`: click/B `21-events.js:1430`; `#drive-done`: click/B `21-events.js:1431`; `#drive-folder-input`: keydown/B `21-events.js:1432`; `#drive-newfolder-input`: keydown/B `21-events.js:1435`; `#drive-api-key`, `#drive-client-id`: keydown/B `21-events.js:1440`; `#drive-upload-input`: change/B `21-events.js:1444`; window: keydown/B `21-events.js:1448` | Drive backdrop/close/done/Escape; credentials/connect, breadcrumb/open/refresh, folder toggle/create/cancel, upload/reset, sign-in/out, rename/start/save/cancel, delete and input Enter/Escape routes. |
| 6.8.5 | 5 | `#resume-continue`: click/B `21-events.js:1466`; `#resume-dismiss`: click/B `21-events.js:1478`; `#save-error-dismiss`: click/B `21-events.js:1480`; `#save-error-retry`: click/B `21-events.js:1483`; `#save-error-export`: click/B `21-events.js:1487` | Resume permission request, completion/failure/dismissal; save-error dismissal/retry and Markdown fallback export through existing owners. |
| 6.8.5 | 10 | `#file-conflict-close`: click/B `21-events.js:1500`; `#file-conflict-cancel`: click/B `21-events.js:1501`; `#file-conflict-reload`: click/B `21-events.js:1502`; `#file-conflict-overwrite`: click/B `21-events.js:1506`; `#file-conflict-merge`: click/B `21-events.js:1512`; `#merge-review-close`: click/B `21-events.js:1513`; `#merge-review-cancel`: click/B `21-events.js:1514`; `#merge-review-confirm`: click/B `21-events.js:1515`; window: keydown/B `21-events.js:1516`; `#file-conflict-copy`: click/B `21-events.js:1523` | File conflict/review close/cancel/reload/overwrite/merge/confirm/Escape/copy; project/imported-file branches and captured context stay. |
| 6.8.5 | 5 | `#btn-save`: click/B `21-events.js:1623`, mouseenter/B `21-events.js:1624`, focus/B `21-events.js:1625`; `#wr-save-status`: mouseenter/B `21-events.js:1626`; `#wr-save`: click/B `21-events.js:1801` | Main/Writer save buttons and hover/focus save-status refresh through the existing coordinator. |
| 6.8.5 | 7 | `#btn-file`: click/B `21-events.js:1629`; `#file-menu`: click/B `21-events.js:1633`; `#file-menu-close`: click/B `21-events.js:1639`; `#file-menu-backdrop`: click/B `21-events.js:1643`; document: click/B `21-events.js:1646`; window: keydown/B `21-events.js:1649`; `#open-file-input`: change/B `21-events.js:1652` | File menu toggle/keyboard focus, submenu-before-action dispatch, close/backdrop/outside/Escape focus return; project-file picker reset/open. |
| 6.8.5 | 12 | `#md-rows-keep`: click/B `21-events.js:1658`; `#md-rows-table`: click/B `21-events.js:1661`; window: keydown/B `21-events.js:1664`, keydown/B `21-events.js:1700`; `#import-close`: click/B `21-events.js:1670`; `#import-cancel`: click/B `21-events.js:1671`; `#import-confirm`: click/B `21-events.js:1672`; `#import-textarea`: input/B `21-events.js:1674`; Each `input[name="import-split"]`: change/B `21-events.js:1684`; `#import-choose-file`: click/B `21-events.js:1689`; `#import-file-input`: change/B `21-events.js:1692`; `#import-modal`: click/B `21-events.js:1697` | Markdown keep/table/Escape choice; import close/cancel/confirm/text debounce/split/file picker/reset/backdrop/Escape; existing mutation boundary stays. |
| 6.8.5 | 6 | `#gdoc-close`: click/B `21-events.js:1704`; `#gdoc-cancel`: click/B `21-events.js:1705`; `#gdoc-confirm`: click/B `21-events.js:1706`; `#gdoc-url-input`: keydown/B `21-events.js:1707`; `#gdoc-modal`: click/B `21-events.js:1710`; window: keydown/B `21-events.js:1713` | Google Docs import close/cancel/confirm/Enter/backdrop/Escape. |
| 6.8.5 | 21 | document: visibilitychange/B `21-events.js:1186`; `#btn-present`: click/B `21-events.js:1627`; `#pp-close`: click/B `21-events.js:1717`; `#pp-voice`: click/B `21-events.js:1718`; `#pp-play`: click/B `21-events.js:1721`; `#pp-speed`: input/B `21-events.js:1722`; `#pp-size`: input/B `21-events.js:1723`; `#pp-speed-down`: click/B `21-events.js:1724`; `#pp-speed-up`: click/B `21-events.js:1725`; `#pp-size-down`: click/B `21-events.js:1726`; `#pp-size-up`: click/B `21-events.js:1727`; `#prompter-scroll`: scroll/B, passive `21-events.js:1728`; window: resize/B `21-events.js:1729`, keydown/B `21-events.js:1758`; `#pp-skip-shot`: click/B `21-events.js:1730`; `#pp-mirror`: click/B `21-events.js:1741`; `#pp-flip`: click/B `21-events.js:1744`; `#pp-scene-mode`: click/B `21-events.js:1747`; `#pp-scene-prev`: click/B `21-events.js:1750`; `#pp-scene-next`: click/B `21-events.js:1751`; `#pp-fullscreen`: click/B `21-events.js:1752` | Prompter open/close, visibility wake-lock reacquisition, voice/playback/speed/size/status, shot-skip rebuild/resize/scroll reset and scene/voice UI, mirror/flip/scenes/fullscreen; key restrictions and swallowed fullscreen rejection stay. |
| 6.8.5 | 1 | `#btn-write`: click/B `21-events.js:1773` | Writer open action. |
| 6.8.5 | 1 | `#writer-doc`: click/B `21-events.js:1794` | Writer jump before expand-hidden-shot. |
| 6.8.5 | 2 | `#wr-size`: input/B `21-events.js:1803`; `#wr-close`: click/B `21-events.js:1822` | Writer size preference and close. |
| 6.8.5 | 2 | B43 `21-events.js:505` `restore-snapshot`; B55 `21-events.js:559` `gallery-open`, `gallery-open-videos` | History restoration (505-506) and gallery opening by row, slot and media kind (559-563). |
| 6.8.5 | 4 | S11 `21-events.js:1166` Update-status startup: Start update-status loading; S12 `21-events.js:1170` Desktop-app notice startup: Render notice before its dismiss binding; S29 `21-events.js:1555` Side-panel resize installation: Install resize handles and supporting document/window routes; S31 `21-events.js:1673, 1677–1681` Import preview debounce: Cancel prior timer; after 150 ms auto-detect split mode and update preview. No teardown cancellation exists here | Update startup, desktop notice before dismissal binding, panel resize resources and import preview debounce (150 ms). |
| 6.8.6 | 6 | document: mousedown/C `21-events.js:1245`, focusin/B `21-events.js:1824`; `.toolbar`: mousedown/B `21-events.js:1334`; window: keydown/B `21-events.js:1586`, keydown/B `21-events.js:1834`; `.writer-bar`: mousedown/B `21-events.js:1813` | Outside row-menu close; toolbar/Writer-bar selection retention; Escape production-selection/composer/panel precedence; Writer focus trap with paint/modal/toast exceptions; Writer Escape dismisses ghost before closing. |
| 6.9 | 4 | window: storage/B `21-events.js:1840`, beforeunload/B `21-events.js:1844`, load/B `21-events.js:1849`; document, only while loading: DOMContentLoaded/B `21-events.js:1865` | Stays in startup extraction: cross-tab history migration; beforeunload dirty/suppressUnloadWarning conditions; web-only future-load service worker; DOM-ready startup. |
| 6.9 | 1 | B01 `21-events.js:329` click/B; review-mode toolbar/action gate | Stays in startup extraction: hosted review gate at 329-337, effective at the routing boundary throughout moves; outside 6.8.3 review-mode scope. |
| 6.9 | 17 | S01 `21-events.js:313` Shared review-action policy: Allowlist consumed by click guard; includes reply, link/video, navigation, gallery, selection and export actions; S09 `21-events.js:1158–1162` Electron draft acquisition: Take desktop draft before normal server detection; acquisition failure becomes `null`; S10 `21-events.js:1164` Initial server detection: Detect server immediately unless draft acquisition path is active; S14 `21-events.js:1190` Global application-state reset: Set `S.state = null` before loading; S15 `21-events.js:1191` Initial-state readiness promise: Assign `S.initialStateReady`; load initial document and sequence later work; S16 `21-events.js:1192` Stash adoption: Apply stashed recovery with cloned loaded state as new base and reporting suppressed; S17 `21-events.js:1197–1199` Session adoption and first render: If not already adopted, open document transition and perform first draw; S18 `21-events.js:1201–1204` Initial UI synchronization: Update identity chip, autosave menu, hidden-shot menu and save status, in that order; S19 `21-events.js:1206–1209` Recovery/editor notification: Report recovery merge, otherwise toast prior editor; S20 `21-events.js:1212–1213` Browser local-project resume: Without recovery report, resume last project only for never-written document and non-desktop; S21 `21-events.js:1215` Document identity synchronization: Synchronize identity if function available; S22 `21-events.js:1216` Browser identity channel: Initialize identity channel only outside Electron; S23 `21-events.js:1217` Electron document-state notification: Notify desktop of adopted document state if available; S24 `21-events.js:1218` Initial history migration: Start history migration after identity setup; S25 `21-events.js:1219–1225` Deferred Electron draft resume: After initial-state chain, await taken draft; arm server resume, detect server, then apply draft; S32 `21-events.js:1854` Electron integration initialization: Initialize desktop integration after this file’s bindings; S33 `21-events.js:1863–1868` DOM-ready startup dispatch: Run immediately if DOM ready, otherwise defer; no local once/remount guard | Stays in startup extraction: shared review policy and ordered startup orchestration into their respective owners. |

**Row counts.** 6.1: 14; 6.2: 5; 6.3: 0; 6.4: 46; 6.5: 0; 6.6: 3; 6.7: 0; 6.8.1: 54; 6.8.2: 1; 6.8.3: 36; 6.8.4: 12; 6.8.5: 95; 6.8.6: 6; 6.9: 22. Total: **294** (6.8 subtotal: 204). Steps 6.3, 6.5 and 6.7 change other modules or styles and own no inventory rows.

**Precedence and route boundaries.** All 57 B rows execute in `onRootClick` (`21-events.js:328`) through the B registrations at `21-events.js:1237`, `21-events.js:1271`, `21-events.js:1332`, `21-events.js:1452` and `21-events.js:1538`, plus `20-teleprompter.js:1000` for `#production-panel` and `#gear-panel` via `wireTagEntityContainer` calls at `21-events.js:1340` and `21-events.js:1372` respectively, as applicable to each root. The two panel installations are already counted as S26/S27 under 6.8.1. Preserve their source order and early returns across owners. The review gate at `21-events.js:329-337` and allowlist at `21-events.js:313` remain effective throughout extraction; 6.8.3 takes no review-mode work. Tag and comment modal backdrop handlers stay after their delegated click handlers.

Rows and Writer keep separate script registrations. On `#writer-doc`, `onCompositionKeydown` at `21-events.js:1786` captures before `onWriterKeydown` at `21-events.js:1787`, then bubble routing runs. The containing Writer capture guards in `19-writer.js:429` precede these descendant handlers; render and other shared-target guards keep their existing order.

The shared handlers retain these ordered routes (all references below are to `21-events.js`):

| Handler | Order kept |
| --- | --- |
| `onRootMouseDown` (`21-events.js:592`) | Ghost dismissal 593; drag grip 594; toolbar default prevention 599; comment anchor 600; tag anchor 603; delayed card reveal 609. |
| `onRootInput` (`21-events.js:797`) | Draft early return 800; auto-tag 801; direction 802; cue 803; b-roll capture 804; plain-tag opening 805; DOM sync 806; composition settlement 807; dependent refresh 808. |
| `onRootKeydown` (`21-events.js:966`) | Row-menu keys 967; link input 968; video input 973; editable/review checks 978-980; local draft undo 981; document undo 982; plain-tag keys 983; ghost acceptance 988; untagged acceptance 991; navigation dismissal 994; Escape mute 998; split 1003; swap 1010; add row 1027; line break 1034; B/I/U 1039. |
| `onRootDragOver` / `onRootDrop` (`21-events.js:1075`, `21-events.js:1105`) | Dragover: media target 1076, row move 1086, editable drop 1094. Drop: reject nonmedia visual drop 1110, media attachment 1115, row move 1122, editable content 1134. |
| `onDraftBeforeInput` (`21-events.js:687`) | Local undo/redo 690; pending marks 695; ordinary draft recording 699. |

Script formatting/composition at `21-events.js:1254-1257` and `21-events.js:1783-1786` belongs to 6.1. Draft beforeinput at `21-events.js:1545` calls the local handler at `21-events.js:687`; draft composition at `21-events.js:1546-1547` and draft paste at `21-events.js:1542` belong to 6.8.3. Draft undo never goes through document replay. Script copy/cut/paste belongs to 6.4, including capture of ownership before asynchronous clipboard/media preparation at `21-events.js:880-888`. Import bindings and the preview debounce belong to 6.8.5, preserving the existing import transaction boundary.

**Startup order.** Desktop draft acquisition starts before normal server detection; acquisition failure becomes null. Initial loading, stash adoption with the cloned new base and suppressed reporting, session adoption and first draw precede identity/history setup and deferred server draft resume/application. Keep identity-chip, autosave-menu, hidden-shot-menu and save-status synchronization in that order; report recovery or the prior editor; browser local-project resume remains conditional on no recovery report and a never-written document. Identity-channel setup and local-project resume remain browser-only; document-state notification and desktop integration remain Electron-only. Await the taken desktop draft after the initial-state chain, arm server resume, detect the server, then apply the draft. Service-worker registration remains web-only, supported and non-file, on a future window load; there is no already-loaded fallback in this baseline.

**Cleanup.** The file has no listener removal, no timer teardown and no duplicate-init guard. Step 6.9 must add disposal where owners take over, including installed delegates, touch selection, b-roll and resize resources, shared state, undo hooks and callbacks. The two setTimeout sites are the 30 ms card reveal at `21-events.js:609` and the 150 ms import preview at `21-events.js:1677-1681`; neither retains teardown cancellation here. There are no setInterval or requestAnimationFrame sites or event-property assignments in this file.

Deletion needs all 294 rows accounted for, the old registrations removed, and remount evidence of exactly one handler per intended registration, including the loop multiplicities above. Shared-target listeners in other files remain part of precedence and duplicate-work checks; their existence alone does not establish duplicate behavior.

## Invariants attached to moved routes

- **Save, overwrite, retry and writeback bindings continue through the existing coordinator and destination queues.** Feature owners do not write directly or acknowledge exports.
- **Restore keeps its transaction kind and autosave suppression** (`"recovery"`); only the two exceptions in [saving.md](saving.md) section 7 remain: explicit history restore, and completion of a previously in-flight hosted save.
- **Export requests keep one capture before asynchronous preparation.** A moved export handler never recaptures.
- **Evidence through the moved UI routes:** overlapping manual and automatic saves, import writeback, ordinary exports and recovery merges. A second listener must not submit duplicate work, a generic dirty effect must not schedule a restore save, and a moved export must not mix documents or options.

## Dispose tests

For every migrated feature with asynchronous work, under milestone 4's production-cleanup rule (call the feature's own dispose, advance the fake clock, settle pending work, assert nothing reached the replacement, never rely on the app-test helper's housekeeping, name the app-lifetime subscriptions that survive):

1. Dispose and reopen while the work is held.
2. Same-ID document replacement while the work is held.
3. Stale completion after remount.
4. A normal completion as the control.

The session, the target and any composer or modal lifetime are captured before the asynchronous work begins. The paint and blur suppression and the failed-render restrictions move into the receiving editor owners; a repaint cannot commit stale DOM, and a legitimately pending typed value keeps its characterized behaviour. The existing matrix continuation cases already cover replacement and same-ID reopening and are reused.

## CSS evidence

Executable criteria for every CSS PR (6.7 and each 6.8 step that moves styles):

- A declared, case-correct ordered file list in `build.mjs`; explicit separators; a check for missing and for duplicate inputs; cascade order and media-query placement preserved.
- Tests read the same aggregate as the build, including `palette.test.mjs`, `plain-tags.test.mjs` and `render-guard-app.test.mjs` (which read `app.css` directly today), the palette and export-colour checks, and the plain-tag and stale-screen rules.
- Before and after captures of the affected views in light and dark themes, the relevant narrow and wide layouts, focus states and reduced motion, with font loading or fallback, browser or Electron version, viewport and scale recorded.
- The generated inline CSS, the CSP, the worker stamp and the standalone HTML output verified on Linux CI as well as the existing Windows checks. The CSP hashes the script, so there is no CSS hash to preserve; `PAGE_SHELL` capture is unchanged.
- Token conversion (6.7) is separate from the first aggregation or feature move.
- Out of scope: a build-entry switch, an external runtime stylesheet, cascade layers.

The bound is the one in [The CSS bound in milestone 6](milestones-4-7-rescope.md#the-css-bound-in-milestone-6): colour tokens finished, fixed-order aggregation, styles moving with migrated features. Base, layout and component sorting and spacing tokens are 4.x.

## The gate

On the closing tree:

- The existing race matrix with `SPLITPAGE_M4_GATE=1`, no previously passing case demoted or weakened. Cases are added only for newly introduced seams.
- M5 evidence retained: capture, asset, writeback and registry coverage, and INV-60 (`X22`).
- The replay evidence (6.2, 6.3), the moved-handler evidence (the ledger) and the production-dispose evidence above.
- The Windows full runs (both browser runs), the Electron dev smoke and the external review.
- New checks use a portable Node entry point and environment setup; the Linux hosted discovery, type and build gates stay. The packaged check returns only if packaging or runtime inputs change.

## As built

### 6.2 Undo replay as a transaction

- **Boundary.** `DocumentSession.replay` runs a `Replay` (plan, apply, settle) as transaction kind `"replay"`. Plan reads; apply writes the replayed steps and the row stamps; attribution signs it as for an edit; anchor reconciliation runs when the change set needs it; settle moves the history entry and resynchronizes the undo base. Any throw up to and including settle rolls the document back through the same rollback point as a command, and the history has not moved. Commit then advances the generation once, runs one effect pass and publishes once, and records no undo entry. A throw after commit comes back as `committed` and is reported.
- **Undo module.** `undo()` and `redo()` in `12a-undo.js` build the replay from `history.prepare`, which plans without writing (`planStepsLive`) and declares the change set: each replayed cell with its stamps, inserted, removed and moved rows, every document field the plan writes (including owner lists cleaned up or re-pointed that the entry did not carry), and `runsMoved` when comment anchors in a replayed cell change. The session bridge routes replays to the live session with its stamp ports. A refusal still drops the entry, as before. A failure before commit is rethrown to the caller.
- **Ledger rows taken (5).** Receiving owner: `mountUndoRoutes` in `src/features/undo/routes.ts`, mounted once from `21-events.js` with `#rows` and `#writer-doc` as roots. Window keydown (bubble) for document undo outside the roots, respecting native controls, draft boxes and review mode; `beforeinput` (bubble) on both roots for script `historyUndo`/`historyRedo`; the guarded Toast Undo (`undoIfLatest`); and the undo-hook installation (sent-comment predicate, refusal warning, the after-replay render and caret adapter). Precedence: the window route ignores targets inside the roots, so a gesture in a cell is handled once by `onRootKeydown`, which calls the owner's `key`. Disposer: `dispose()` removes the three registrations and releases the installed hooks. The after-replay adapter in `21-events.js` keeps render, production render, base settle and caret restore; stamping and the dirty mark moved into the transaction.
- **Evidence.** `tests/application/session-replay.test.ts` (the commit contract at the session), `src/test/undo-replay-app.test.mjs` (every document undo route in the booted app, stamps, refusal, pre- and post-commit failure, owner cleanup in the change set) and `tests/features/undo/routes.test.ts` (route precedence, one gesture one replay, Toast Undo guard, dispose and remount).

### 6.6 The rest of `applyMerge`

- **Orchestration.** `applyIncomingMerge` in `src/application/session/apply-merge.ts` runs every option of the options table behind typed ports (`ApplyMergePorts`): undo-point and kept snapshots, the merge through `mergeIncoming`, adoption, the history id, the undo-merge record, the baseline through `setBaseState`, the restore capture for `awaitUndoPoint`, and a `MergeView` for the redraw, chips, report, unsaved mark and toast. `applyMerge` in `03-sync.js` is now the adapter that supplies those ports; its synchronous callers (`13-hosted.js`, `14-export.js`'s `applyStashedWork`, `18a-local-merge.js`) and the awaited branch (`20g-drafts.js`) keep their contract and were not changed. The merge algorithm, M5's imports and `session.absorbMerged` are unchanged.
- **Presentation.** `mountMergeBanner` in `src/features/merge/banner.ts` owns the banner's words, the Review conflicts and Undo merge buttons, the conflicted-row mark and the Undo merge arming (3 s) and its restore answers. `reportMerge` in `03-sync.js` shows the banner through the installed owner and keeps the unsaved mark and the autosave rule (`alreadySaved`, `noAutoSave`). The restore itself stays `restoreSnapshot`, reached as `restoreMergeSnapshot`.
- **Ledger rows taken (3).** `#merge-dismiss`, `#merge-undo` and `#merge-review` click, now registered by `mountMergeBanner`, which is mounted once from `21-events.js`. Review conflicts opens the existing comments panel through `openCommentsPanel`; no review-mode work. Disposer: `dispose()` removes the three listeners, disarms Undo merge, drops a pending restore's answer and releases the install.
- **Characterization.** Today's behaviour, recorded before the move and passing unchanged after it: an `unchanged` apply that adopts redraws once (theirs replaces the document on screen); it takes no undo point and, unless `report: false`, marks the document unsaved. The plan's "no render" for `unchanged` holds only for `mergeOnly`, the stash path's synchronous form. A merge that differs only outside the rows shows no banner but still marks unsaved.
- **Evidence.** `src/test/apply-merge-options-app.test.mjs` (every option row and the banner in the booted app; 14 cases, all passing on the base before the move), `src/test/apply-merge.test.mjs` (unchanged), `tests/application/apply-merge.test.ts` (the port order, each option, `awaitUndoPoint`'s hold, replacement and failed write) and `tests/features/merge/banner.test.ts` (the words, the three routes, arming and restore answers, dispose and remount: dispose while armed, a held restore after dispose, a fresh mount, a normal completion). Caller cases stay in the browser suites 42 (local merge), 54 (server conflict), 55 (pull), 26 and 265 (drafts).
