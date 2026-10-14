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
| 6.8.1 | Tags and production panels | `07`, `08` |
| 6.8.2 | B-roll | `08c`, `08d` |
| 6.8.3 | Comments (no review-mode work) | `10` |
| 6.8.4 | Find | `09`, `19-find.js` |
| 6.8.5 | Panels, settings, gallery, prompter | the remaining view modules |
| 6.8.6 | Overlay and focus ownership (INV-19), then #308 and #350 as focused repairs after core writing work | overlay modules, `12-dirty-toast.js` |

Each PR: the feature owns its bindings, local state, styles and mount and dispose; no global state access, concrete platform service or direct live-document mutation; the dispose cases below; the CSS evidence below if styles move; the save, recovery and export invariants below if a save, restore or export route moves; a bridge or duplicate goes in the PR that migrates its last consumer.

### 6.9 Startup extraction and deleting `21-events.js`

- **Prerequisites.** Every ledger row accounted for with its removal PR merged, and no old registration left.
- **Startup first.** The startup duties are extracted before deletion into their owners (not into another catch-all): initial document loading, stash and draft recovery ordering, identity and history setup, desktop initialization (draft acquisition), service-worker registration and unload handling. Comprehensive dependency wiring is M7.
- **Evidence.** Remount evidence shows exactly one handler per ledger row; the existing startup sequences (stash adoption, first render, draft resume) run in the same order; the full gate.

## The `21-events.js` ledger

One row per listener, delegated action branch, initialization responsibility and owned resource. The columns are filled by the step that moves the row and checked by the 6.9 PR. Rows below are grouped from the measured file on `dcfb92d`; the PR that first touches a group makes the group's rows individual, and no row may be dropped without a removal entry.

Columns: **Row** · **Target and phase** · **Precedence** · **Receiving owner** · **Lifetime and disposer** · **Regression evidence** · **Removal step**.

| Group | What it holds | Receiving owner (step) |
| --- | --- | --- |
| Keyboard: undo and redo, native controls, draft boxes | `keydown` for Ctrl+Z family; distinguishes native controls, document undo and draft undo | undo adapter and comments (6.2, 6.8.3) |
| `beforeinput` undo and redo | the two input-type routes | undo adapter (6.2) |
| Composition | `compositionstart`/`compositionend` marks, `onScriptComposition`, post-cancel check | selection and composition (6.1) |
| Paint guard and blur | suppression around repaint, nested paint completion | selection and render (6.1) |
| Clipboard | paste and copy with ownership captured before preparation | clipboard (6.4) |
| Image and composer | composer element resolved after image compression; import debounce | comments, import (6.8.3, 6.4) |
| Click delegation | tag controls, modifier clicks, selection completion, drag types (priority order is the contract) | tags, rows (6.8.1, 6.4) |
| Present `keydown` | Present's letter shortcuts, modifier handling (#309 fixed) | prompter (6.8.5) |
| Toast Undo | direct document undo from the toast | undo adapter (6.2) |
| Save bindings | retry, conflict and copy buttons | existing save coordinator, bindings only (6.8.5) |
| Different phases | capture-phase and bubble-phase registrations that establish ordering | each group's owner; order test in 6.9 |
| App-lifetime services | service-worker registration, `unload` handling | startup extraction (6.9) |
| `init()` | desktop draft acquisition, initial document loading, stash adoption, first render, draft resume, identity and history setup | startup extraction (6.9) |

Deletion needs all rows accounted for, the old registrations removed, and remount evidence of exactly one handler per row.

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

Nothing yet.
