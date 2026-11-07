# Invariant ledger

This ledger holds the 62 invariants, `INV-01` to `INV-62`, under the numbers they had in `docs/HANDOFF.md` §5, which now points here. The behaviour tests of a rule absorbed into code stay. Update a row in the same PR that changes its tests, owner or class.

## Legend

- **keep**: the rule stays explicit, held by its tests. No planned structure makes breaking it impossible.
- **absorb**: a structure in `docs/IMPLEMENTATION-PLAN.md` enforces the rule once it lands (one field policy, one transaction boundary, one overlay owner, one export projection). The row names that structure and the test that proves it.
- **practice**: a working habit or debugging advice, not product behaviour. It moves to contributor or skill notes.
- **Milestone**: for absorb, the milestone that lands the replacement; for keep, the milestone that migrates the rule's owner; `4.x` for server and desktop internals (plan §8); `—` for practice.
- **Tests**: unit tests are cited by path. Browser suites are cited by full filename and live in `.claude/skills/run-splitpage-app/tests/` (numeric prefixes are not unique). "none found" means a search of `src/test/`, the browser suites, `desktop/test/`, `tools/test-server.mjs` and `tools/test-update.mjs` found nothing that asserts the rule.
- **Owner**: the target folder from plan §3. The feature folders were provisional names until milestone 6 built them; rows now name the folders that exist under `src/features/` (`editing`, `tags`, `overlay` and the others).

## Summary

Classes: keep 42, absorb 18, practice 2. Milestones: 2 → 9, 3 → 3, 4 → 9, 5 → 9, 6 → 18, 7 → 1, 4.x → 11, — → 2 (none at 0 or 1).

No test coverage found: INV-08, INV-50. Partial coverage: INV-05, INV-11, INV-12, INV-13, INV-19, INV-24, INV-28, INV-29, INV-39, INV-44.

## Ledger

### INV-01 — Edit source one site at a time

- **Behaviour:** Source changes are made as targeted edits at one site, never by in-place regex substitution (`sed -i`, `perl -pi`) across a file.
- **Tests:** not applicable.
- **Owner:** practice · **Milestone:** — · **Class:** practice
- **Replacement:** `CONTRIBUTING.md` working notes. The original risk has gone: `index.html` is gitignored build output and the source in `src/` is under version control.
- **Acceptance:** —

### INV-02 — Script cells change only through the document model

- **Behaviour:** Every change to a script cell is a document-model edit (`editCell()` at the selection, or the edits in `src/core/text/edits.ts`), written back with `toHtml()`. No path edits cell HTML with a regex, and nothing uses `execCommand`, in script cells or in comment and reply boxes.
- **Tests:** `src/test/doc-model.test.mjs`, `src/test/cell-edit.test.mjs`; browser `75-format-model.txt`, `76-tags-model.txt`, `77-clipboard-model.txt`, `78-split-join-model.txt`, `81-draft-edit.txt`; for the commands, `tests/application/cell-text.test.ts`, `split-join.test.ts` and `clipboard.test.ts` (every command test through `runConfined`, which fails on a write outside the declared change set). No test asserts that `execCommand` is absent from the source.
- **Owner:** `src/core/text` (edits), `src/application` (commands), `src/features/editing` (bindings) · **Milestone:** 6 · **Class:** absorb
- **Replacement:** DocumentSession commands become the only write path (M3). Migrated editor features receive named operations and no writable document (M6; plan §6: "a view or selector never changes document content").
- **As built (M3, part):** typing, split, join, paste and cut write the cell only through `cellTextCommand`, `splitSceneCommand`, `joinScenesCommand`, `pasteCommand` and `cutCommand` ([session.md](session.md#the-text-commands)). `editCell()` (formatting, shortcuts, tags, b-roll keys, Enter) still writes `row[field]`, stamps and calls `markDirty` itself (#452), and the scene paste and drop in `src/features/clipboard/beat-clip.ts` is out of M3 (D10). The row stays open until M6.
- **Acceptance:** the five suites pass on the migrated editor. A new architecture check finds no `document.execCommand` call and no `innerHTML` assignment to a `.cell-editable` under `src/features/`.

### INV-03 — Text inside a tag is never touched

- **Behaviour:** A tag is one atom. An edit applies a comment or link to all of a tag or to none of it, the caret cannot enter a tag, and editor find/replace never matches inside or across one. Present's read-only Find searches the text on screen, including displayed tag words.
- **Tests:** `src/test/doc-model.test.mjs` ("a comment or link covers all of a tag or none of it", "positions: an atom is one character"); `src/test/find-replace.test.mjs` ("find: never inside a tag, never across one or across a b-roll key", "replace never touches a tag…"); browser `04-prompter-find.txt`.
- **Owner:** `src/core/text` · **Milestone:** 2 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the named unit tests pass unchanged against `src/core/text`.

### INV-04 — Every top-level field survives migration and merge

- **Behaviour:** `migrateRows()` and `mergeStates()` both keep every top-level state field. A field that one of them misses is silently dropped on load or merge.
- **Tests:** `src/test/state-fields.test.mjs` (all tests, among them "INV-04: a field added to STATE_FIELDS survives migrateRows, mergeStates and a .splitpage save, with no other edit", through the `STATE_FIELDS` table and the real `.splitpage` codec), `src/test/migrate-rows.test.mjs`, `src/test/merge-states.test.mjs`; `tests/core/merge-states.test.ts` ("INV-04: a field added to the table survives migrateRows, mergeStates and a .splitpage round trip, with no other edit"); `tests/core/merge/states.test.ts` (the merge alone); `tests/core/migrate.test.ts` ("normalize comes from the table…").
- **Owner:** `src/core/document` · **Milestone:** 2 · **Class:** absorb
- **Replacement:** a single `STATE_FIELDS` policy in `src/core/document/fields.ts`, with no callbacks into UI modules: each entry's default, `normalize` and merge strategy are data that `migrateRows` (`src/core/migrate.ts`) and `mergeStates` (`src/core/merge-states.ts`) both read (M2 gate: "a new field policy does not require duplicating merge/schema field lists"). Done in milestone 2.5; `src/core/merge/state-fields.ts` keeps the table with `mergeList` attached, and the session and document ports import it.
- **Acceptance:** met in 2.5 by the two INV-04 tests above: a field added to `STATE_FIELDS` round-trips through `migrateRows`, `mergeStates` and a `.splitpage` save without edits to either function. `state-fields.test.mjs` stays.

### INV-05 — Script-only behaviour stays out of comment boxes

- **Behaviour:** Handlers shared by script cells and comment or reply boxes apply script-only behaviour (tag completion, row splitting, script shortcuts) only to script cells, which include the Writer's paragraphs. A comment box never triggers them.
- **Tests:** partial. `tests/features/editing/cell-page.test.ts` asserts the gate: `isScriptCell` is false for a comment box and true for a script cell and a Writer paragraph. `81-draft-edit.txt` and `10-comments-panel.txt` exercise comment boxes under the shared handlers but assert nothing about the gate.
- **Owner:** `src/features/editing`, `src/features/comments` · **Milestone:** 6 · **Class:** absorb
- **Replacement:** per-feature bindings with mount and dispose (M6). The script editor binds its handlers to its own cells and the comment composer binds its own, so no shared delegation has to check which kind of box it is in.
- **Acceptance:** browser: script-only shortcuts in a comment box (Alt+Enter, Tab on a completion) leave rows, script and registry unchanged. `81-draft-edit.txt` passes.

### INV-06 — No document-wide work per keystroke

- **Behaviour:** Typing triggers no document-wide derivation. Expensive refreshes run through one debounced idle refresh (180 ms), memoised derivations are keyed on their own inputs, and the production index is derived at most once per change. One document-wide scan is retained on purpose: the undo owner's `flush` (`src/application/editing/undo/`) diffs the whole document against its base after each edit to record undo (`diffStates`, then `applySteps` on the base), measured at 0.58 ms median and 1.32 ms p95 per edit on the 30-scene demo in jsdom on `2b3aa86`, and included in the performance record's browser typing times. It goes with milestone 6's undo transaction (milestone 3 external review, E8).
- **Tests:** browser `67-render-perf.txt` (counts renders, repaints, idle refreshes and index derivations on a 300-scene document); `src/test/production-index.test.mjs` ("the index is kept through prose edits and re-derived by any change to what it reads"); `tests/application/cell-text.test.ts` ("INV-06: a burst of keystrokes through the typing command runs each derivation once per idle window"); `tests/application/session-effects.test.ts` (the scheduler's windows); `tests/application/session-anchors.test.ts` (a one-cell edit skips the document-wide reconciliation unless its comment ids change).
- **Owner:** `src/application` (effect scheduler) · **Milestone:** 3 · **Class:** absorb
- **Replacement:** an application effect scheduler coalesces autosave, draft capture, history and expensive derivations (M3). Cached derivations use precise changed inputs (M6).
- **Acceptance:** `67-render-perf.txt` passes. Application test with a fake clock: a burst of typing change sets inside the debounce window runs each derivation once. Met in 3.12 (#427).
- **As built (M3):** the scheduler is `createEffectScheduler` in `src/application/session/effects.ts`. A command declares `derive` and `saveNow` and never fans out by hand; the refresh jobs coalesce in one 180 ms idle window capped at 1,000 ms ([session.md](session.md#4-the-effect-scheduler)). Legacy refresh callers reach the same window through `requestRefresh`. A legacy writer that calls `markDirty` still passes a whole-document change set and no reconciliation.

### INV-07 — A single-row change repaints one row

- **Behaviour:** A change confined to one row repaints only that row's changed parts and never a field whose text is unchanged. The rest of the document keeps its DOM nodes, focus and caret.
- **Tests:** browser `67-render-perf.txt` (typing repaints no row; a structural edit elsewhere keeps the focused cell and untouched fields as the same nodes); `288-scene-status-effects.txt` (a status click repaints one row and no cell).
- **Owner:** `src/features/rows` · **Milestone:** 6 · **Class:** absorb
- **Replacement:** views consume precise change sets (M3), and the rows view repaints only the rows and fields a change set names (M6).
- **As built (M3, part):** every command publishes a frozen change set that names the cells, rows and document fields it wrote ([session.md](session.md#what-a-change-set-declares)). Nothing in the app subscribes yet (`subscribe` is used by tests), so the views still repaint by their own calls (`renderRow`, `render`, `renderWriter`) after a command. The consuming view is milestone 6's.
- **Acceptance:** `67-render-perf.txt` passes. Browser: a status click repaints only its own row, measured by the `__renderTest` counters or their successor.

### INV-08 — CSS attribute selector values are escaped

- **Behaviour:** Every value placed in a CSS attribute selector is escaped with `cssAttr()`, so quotes, backslashes or control characters in an id or name cannot break or redirect the selector.
- **Tests:** none found for `cssAttr`. `src/test/migrate-rows.test.mjs` ("rows: an id that could escape a selector is replaced") covers row ids at ingestion only.
- **Owner:** presentation utility used across `src/features/` (now in `src/features/common/dom.ts`) · **Milestone:** 6 · **Class:** keep
- **Replacement:** —
- **Acceptance:** new unit test: for values containing `"`, `'`, `\`, a newline and `]`, `cssAttr` produces a selector that matches exactly the element holding that value.

### INV-09 — Markdown table cells are escaped

- **Behaviour:** Text written into a Markdown table cell goes through `mdCell()`, so a `|` or a line break in the text cannot split the row.
- **Tests:** `src/test/formats.test.mjs` (".md round-trips the whole document…", whose fixture has a `|` in a cell; "a saved .md project is byte for byte what it was before the exports changed", with pipes and line breaks); `tests/adapters/formats/markdown-table.test.mjs` ("an escaped pipe stays inside its cell", reader side).
- **Owner:** `src/adapters/formats` · **Milestone:** 5 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the named tests pass against the Markdown codec in the format registry.

### INV-10 — Content enters a script cell only in canonical, sanitised form

- **Behaviour:** Content reaches a script cell only through `fromHtml()` or a model edit, both of which produce canonical, sanitised cells. `syncFieldFromDom()` stores each keystroke that way: it decodes the cell through the adapter and hands the runs to the typing command (`src/application/commands/cell-text.ts`, M3 3.12), which stores `toHtml(runs)`. Anything else rebuilt from HTML, such as a comment body, passes `sanitizeHtml()` before it re-enters state.
- **Media (milestone 6, 6.4):** runs carry pictures and video cards as `image` and `video` atoms (`src/core/text/runs.ts`), so a cell holding media is stored as `toHtml(runs)` like any other cell. The script-cell decoder (`decode(html, { media: true })`, `scriptCellOf` in `src/bootstrap/richtext.ts`, the session's `CellTextPorts.cells`) keeps them; the plain decoder (`fromHtml`, `cellOf`) still drops them for its readers. Undo (the cosmetic test, the three-way cell merge and the typing projection in `src/application/editing/undo/`) and the editor's selection keys (`editorKeys`, which names a media atom `#media` as the DOM does) read with media kept, so a media-only change is an undo step and an undo or redo over a media cell keeps its media. `toHtml` writes a picture as the stored image markup and a card as the sanitiser's card, so the stored form is still the sanitiser's fixed point. A media cell's split is a text cut (an atom is one place) and its join joins the runs. The former named exception (`SanitisedMediaHtml`, `mediaHalves`) is gone: no typed HTML cell value can be produced.
- **Paste and cut (M3 3.14):** a paste is cleaned by `cellFromClipboard` (05c), inserted as runs or text by `pasteCommand`, and stored as `toHtml(runs)`; a cut stores `toHtml(deleteRange(...))`. `src/test/paste-html-fuzz.test.mjs` (seeded) checks the paste path for clean, canonical cells within the output bound.
- **Tests:** `src/test/doc-model.test.mjs` ("toHtml writes the sanitiser's own markup: a fixed point of sanitizeHtml", "round trip: fromHtml(toHtml(c)) is normalizeCell(c)"); `src/test/clipboard.test.mjs` ("a paste is sanitised, keeps formatting and tags, and drops pictures and video cards"); `src/test/migrate-rows.test.mjs` ("comments: bodies and replies are sanitised, authors are plain text"); `tests/adapters/richtext/golden.test.ts` ("INV-10: the sanitiser's output is its own fixed point over the corpus", "toHtml(decode(x)) is already in stored form over the corpus", through the adapter on jsdom's parser with no DOM globals); `tools/test-dep-report.mjs` ("INV-10, HTML into cells"); `tests/application/cell-text.test.ts` ("the stored form is exactly toHtml of the runs…", "a cell holding media is runs like any other…"); `tests/adapters/richtext/media-runs.test.ts` (the media runs over the corpus: the sanitiser's fixed point, round trip, media kept in order); `tests/core/text/media-runs.test.ts`; `src/test/media-cell-app.test.mjs` ("no typed HTML cell value can be produced…"); `src/test/cell-text-app.test.mjs` (the seeded differential against the base's `syncFieldFromDom`); browser `52-csp.txt`.
- **Owner:** `src/adapters/richtext` · **Milestone:** 2 · **Class:** absorb
- **Replacement:** the HTML adapter in `src/adapters/richtext/` becomes the only decoder from HTML to cells (M2), and DocumentSession commands accept normalised runs, not HTML (M3). Done in 2.4: `fromHtml`, `cellOf`, `sanitizeHtml` and `storedHtmlFromDom` are the adapter's functions, handed out through `src/bootstrap/richtext.ts`.
- **Acceptance:** HTML adapter tests on a real parser (M2 gate) show every decoded cell is a fixed point of the sanitiser; met in 2.4. A dependency check finds no module outside `src/adapters/richtext/` that builds cells from HTML; met by the `html-cells` rule of `tools/dep-report.mjs` (#327, defined in [dependencies.md](dependencies.md#html-into-cells-inv-10)), which allows only the adapter and its shared reader `src/bootstrap/richtext.ts` (formerly the bridge `src/legacy/richtext.ts`) to import the adapter or parse HTML, with two recorded legacy exceptions.

### INV-11 — Controls in a tag card head take precedence over expand

- **Behaviour:** Clicking a control inside a breakdown card's head (status cycle, rename and others) runs that control's action and does not toggle the card's expansion.
- **Tests:** partial. `12-gear.txt` clicks the status-cycle control and checks that the status changed, but does not assert that the card stayed collapsed. Nothing asserts the order of checks.
- **Owner:** `src/features/tags` · **Milestone:** 6 · **Class:** keep
- **Replacement:** — (M6 preserves "priority among tag controls, modifier clicks, selection completion and drag types").
- **Acceptance:** browser: in both the production and gear panels, clicking each control in a collapsed card's head runs its action and leaves `.is-expanded` unchanged.

### INV-12 — A modifier-click on a breakdown card outranks its controls

- **Behaviour:** A Ctrl, Cmd or Shift click anywhere on a breakdown card, including on a control inside it, selects the card for bulk actions instead of running the control.
- **Tests:** browser `02-production.txt` (Ctrl-click selects cards). No test covers a modifier-click on a control inside a card.
- **Owner:** `src/features/tags` · **Milestone:** 6 · **Class:** keep
- **Replacement:** —
- **Acceptance:** both suites pass. New browser check: a Ctrl-click on a card's status control selects the card and leaves its status unchanged.

### INV-13 — Scene drags and file drags stay apart

- **Behaviour:** Scene reordering and image-file drops share the root drag handlers. The image branch runs only for a file drag with no scene picked up (`isFileDrag(e) && !dragRowId`), so neither gesture triggers the other.
- **Tests:** partial. Browser `103-rundown-drop.txt` (scene drop), `33-drag-autoscroll.txt` (a dragover with no scene picked up never scrolls the page), `68-images.txt` (file drop). No test checks that the two branches stay apart.
- **Owner:** `src/features/rows` · **Milestone:** 6 · **Class:** keep
- **Replacement:** —
- **Acceptance:** browser: a scene drag whose DataTransfer carries a file type reorders scenes and adds no image. A file drag with no scene picked up adds the image and reorders nothing.

### INV-14 — A tag category is complete everywhere it is drawn

- **Behaviour:** Every `TAG_CATEGORIES` entry has:
  - `--tag-<id>` and `--tag-<id>-tint` tokens in `:root` and in both dark blocks;
  - a `.tag-anchor[data-tag-cat]` rule;
  - a light hex in `TAG_PRINT_COLORS` equal to its `:root` value;
  - a CSS-only icon in `TAG_ICON_PATHS`.

  Its hues keep clear of the Visual blue and the Audio amber and meet contrast.
- **Tests:** `src/test/palette.test.mjs` (all tests), `src/test/export-colours.test.mjs` (Word and projection cases); browser `217-tag-icons.txt`, `217b-tag-icons-boot.txt`, `145-export-colours.txt`. The print pages' category colours are in `tests/adapters/formats/script-print.test.mjs` and `tests/adapters/formats/list-print.test.mjs`; Adam approved deletion of the replaced old-generator colour cases in AQ-44 on 2026-10-31.
- **Owner:** `src/core/document` (category ids, in `tags.ts`), `src/core/production/looks.ts` (`TAG_CATEGORIES`: labels, colours and icons, keyed by id), with tokens in feature styles · **Milestone:** 2 · **Class:** keep
- **Replacement:** — (`TAG_PRINT_COLORS` stays a deliberate second copy, held to `:root` by `palette.test.mjs`).
- **Acceptance:** `palette.test.mjs` passes, reading the token files produced when CSS is split (M6).

### INV-15 — The writer edits the document through one host

- **Behaviour:** A paragraph contains one or more beats. The writer derives headings and paragraphs with `flowOf`, keeps a model position for each beat and heading, and issues commands through the session. It never reparses a document into rows. Ordinary narration and Visual edits patch only the affected beat. Structural edits preserve the directed selection in their undo entry. Old scripts receive the sentence rule once, recorded by `paragraphsDecided`.
- **Tests:** `tests/core/flow/`, `tests/features/writer/`, browser `06-writer.txt` and the writer-flow suites.
- **Owner:** `src/core/flow`, `src/application/commands/flow.ts`, `src/features/writer`.
- **Acceptance:** Editing across beats is one undo step; text and metadata survive save and reload; a synthetic gap is never stored.

### INV-16 — Full-screen views close the side panels

- **Behaviour:** Present, Help, the tour, the setup wizard and the full-page shot list close every open side panel through one path, which clears `body.panel-open` and `#root`'s padding. Leaving these views reopens no panel, except that the shot list reopens B-roll if it was opened from there. The writer opens the comments panel beside its narration and closes other side panels. The shared header remains reachable at 146; writer, comments and Present use 145, modals 150 and toasts 200.
- **Tests:** browser `128-side-panels-modes.txt` (every panel against both modes), `150-mode-transitions.txt` (z-index 145), `96-broll-page.txt`, `61-transitions.txt`.
- **Owner:** `src/features/overlay` · **Milestone:** 6 · **Class:** absorb
- **Replacement:** an overlay and focus owner (M6) that preserves panel closure and restoration and the stacking order. A new full-screen view or side panel registers with it.
- **Acceptance:** `128-side-panels-modes.txt` passes. Every full-screen view closes a newly registered panel without edits to those views.

### INV-17 — A hint about the document never edits it

- **Behaviour:** The untagged-mention highlight, the tour and the tutorial only paint the page (for example with `CSS.highlights`). Until the user accepts an offer they wrap no span, leave the document clean and add no undo entry.
- **Tests:** browser `07-untagged.txt` ("no wrapped span, no dirty flag"); `13-onboarding.txt` and `15-tutorial.txt` (both cite "invariant #17" and compare `#rows` byte for byte).
- **Owner:** `src/features/tags` (the untagged prompt) and the tour (`startTour()` in `src/features/help/help.ts`) and onboarding (`src/features/onboarding/`, which invokes the tour) · **Milestone:** 6 · **Class:** absorb
- **Replacement:** views and selectors receive read-only snapshots and named operations (M3; plan §6: "a view or selector never changes document content"). Accepting a hint is a command.
- **Acceptance:** application test: running the untagged scan and the tour against a session leaves the edit generation, dirty state and undo stack unchanged. The three suites pass.
- **As built (M3, part):** the session hands a view the live document only through `read(select)`, typed as a deep-readonly `DocumentView` ([session.md](session.md#1-purpose)); the compiler, not the runtime, stops a write. The untagged scan and the tour still run in legacy modules and do not go through a session, and the acceptance test above is not written. The row stays open until M6.

### INV-18 — A comment is anchored by its mark

- **Behaviour:** A comment is anchored by its `cmt` mark in the script. Every path that moves words between rows (split, join, cut then paste) moves them as runs, and the session reconciles in the same transaction and undo entry: `syncCommentAnchors(doc)` points each comment at the first cell holding its mark. Inside a surviving beat, a comment whose words are gone keeps its last position. A fully removed writer beat takes its comments unless their marks survive elsewhere. `migrateRows()` (`src/core/migrate.ts`, reading cells through its `readers` port) runs the same pass on every load and merge.
- **Malformed row ids (#1041):** On load, the first scene keeps a repeated normalized id; later scenes receive deterministic suffixes (`id-1`, `id-2`, skipping reserved ids), retaining their content. Reloading the same damaged file preserves scene identity for draft recovery. Ambiguous row-id references and section boundaries stay on the first scene. Comment marks are retained on every scene, and the normal first-mark reconciliation above still determines an anchored comment's position. A section's `firstSceneId` is cleaned only when it names a duplicated normalized id; a nonduplicated reference keeps the existing normalization behavior. `tests/core/migrate.test.ts` covers collisions and unchanged bytes; `src/test/migrate-rows.test.mjs` covers stable reloads, comments, anchors, sections, b-roll and media; `src/test/merge-states.test.mjs` covers malformed-file merges and independently loaded draft recovery.
- **Missing ids (#1049):** Load repairs use a namespace derived from canonical source data, retaining array order and sorting object keys recursively. Markdown without an embedded document ID also canonicalizes its fenced data before deriving the synthetic document ID. Changed source data cannot recycle a repaired identity, including twins and displaced reservations. Editing keeps its separate random namespace. External insertions, reordering and edits can retain duplicate records during recovery; unsaved text and comments are kept. Only identity-replacement draft recovery retains a scene for a changed comment and separates retained copies' anchor identities; ordinary row merging is unchanged. A replace-all draft of 30 scenes and a revision-only disk change retain 60 scenes without conflict cards. The reservation scan and hashing run only when repair is needed. `src/test/stable-row-ids-app.test.mjs` covers recovery, twin and empty records, nested IDs, embedded keys, comment ownership and unchanged project bytes.
- **Tests:** `src/test/comment-anchors.test.mjs`; `tests/application/split-join.test.ts` ("E9: a split before a commented phrase…", "E9: a join brings the later scene's comments…", "E9 (seeded): split and join leave every comment where reconciliation would put it…"), `tests/application/clipboard.test.ts` ("a paste carrying a cut's comments reconciles in the transaction…", "E9: a cut and the paste of it are one generation and one undo record each"), `tests/application/cell-text.test.ts` ("a cell edit that adds or drops a comment anchor reconciles in the transaction…"), `tests/application/session-anchors.test.ts` (the seeded property that a one-cell edit moves an anchor only when its comment ids change); `src/test/split-join-app.test.mjs`, `src/test/cut-paste-app.test.mjs`; browser `78-split-join-model.txt`, `77-clipboard-model.txt`, `20-comment-drift.txt`, `246-scene-delete-comments.txt`.
- **Owner:** `src/application` (transaction), with `syncCommentAnchors` in `src/core/text` · **Milestone:** 3 · **Class:** absorb
- **Replacement:** every accepted DocumentSession transaction reconciles dependent anchors (M3; plan §6: "every accepted user transaction includes its dependent anchor/record reconciliation").
- **Acceptance:** application test: split, join and cut-then-paste commands that do not call `syncCommentAnchors` themselves still leave every anchored comment's `rowId` and `field` equal to what reconciliation computes, in one undo entry. `comment-anchors.test.mjs` stays. Met in 3.13 (#447) and 3.14 (#455).
- **As built (M3):** `ReconcilePort.anchors` runs after `apply` when a change set inserts, removes or moves rows or sets `runsMoved` ([session.md](session.md#when-reconciliation-runs)). Split declares the inserted scene and join the removed one. The typing command sets `runsMoved` when a cell's ordered comment ids change, and a paste sets it when it is a cut's own and carries comments. A cut never reconciles: its comment keeps its place until its words land again. No command calls `syncCommentAnchors` itself. The scene-level paths reach reconciliation through commands: `deleteRow` (`features/rows/beats.ts`, `deleteSceneCommand`) and the selected-scene delete and paste (`src/features/clipboard/beat-select.ts`, `removeScenesCommand` and `pasteScenesCommand`), reconciled by `src/application/session/document-session.ts`. The scene paste in `src/features/clipboard/beat-clip.ts` (D10; M3 took cell-level cut-paste only) still calls `syncCommentAnchors` directly. Known gap: cut, Ctrl+Z, then paste leaves the anchor in two scenes, because `cutNonce` outlives an undo of the cut (#460, the same on the base). `editCell`'s model edits, which move no words between rows, do not reconcile.

### INV-19 — A full-screen overlay owns focus and stacking

- **Behaviour:** While the Writer or Present is open, focus stays within the active view and its permitted controls. The writer permits the shared header, comments panel, Find, Visual box, modals and toasts; Present permits Find, modals and toasts. Anything meant to show above it, such as `.tag-ghost-hint` at z-index 146, does.
- **Tests:** partial. Browser `150-mode-transitions.txt` (z-index 145; a Writer that is fading out holds no focus), `457-toast-accessibility.txt` (Present focus, dialogs and toasts in fullscreen), `458-find-in-present.txt` (Find stacking, focus and Escape), `459-find-keyboard-lock-fallback.txt` (unsupported/refused capture); `tests/features/prompter/mount.test.ts` (focus containment and shortcut ownership), `src/features/find/keyboard-lock.test.ts` (Find-scoped capture lifetime). No test covers the stacking of `.tag-ghost-hint`.
- **Owner:** `src/features/overlay` · **Milestone:** 6 · **Class:** absorb
- **Replacement:** the overlay and focus owner (M6). Escape and Tab handling, focus containment and stacking are set when an overlay registers, not by per-view CSS and listeners.
- **Acceptance:** browser: with the Writer open, Tab and focus moved programmatically to `#rows` both stay inside the Writer, while a modal and a toast stay reachable. The completion ghost draws above the Writer.

### INV-20 — One shared save status, one save state

- **Behaviour:** Both modes use the same header save control and File menu. `flowSaveStatus` renders quiet status, actionable for a new script, Autosave off or a save problem. A failed retry keeps its problem until a successful save or clean document clears it. Ctrl+S and menus retain the existing coordinator and destination queues.
- **Tests:** `tests/features/title/save-status.test.ts`, `flow-save-retry.test.ts`, `src/test/save-label-late-app.test.mjs`, browser `283-save-status-by-destination.txt`, `285-save-buttons-one-state.txt`, `363-writer-flow-save-status.txt` and `588-writer-flow-save-retry.txt`.
- **Owner:** `src/application/save`, `src/features/title/save-status.ts`.
- **Acceptance:** Running saves cannot be submitted again through the shared control. A late completion paints the current document's state, and a failed retry remains actionable.

### INV-21 — Field splits and writer structure share text primitives

- **Behaviour:** Split view Alt+Enter runs `splitBeatCommand`. Writer Enter starts a beat, a second Enter starts a paragraph, and Shift+Enter inserts a line break through the flow engine. Writer Alt+Enter has no action. Both paths use the same text-run primitives and session reconciliation, so formatting and comment marks follow surviving text. Alt+Backspace or Join combines visuals and keeps the higher status; scene headers and the picture limit refuse joins.
- **Tests:** `tests/application/split-join.test.ts`, `tests/core/flow/`, `src/test/split-join-app.test.mjs`, `src/test/text-editing-app.test.mjs`, browser `06-writer.txt`, `09-alt-enter-and-scroll.txt` and `78-split-join-model.txt`.
- **Owner:** `src/application/commands`, `src/core/text`, `src/core/flow`.
- **Acceptance:** Each structural gesture is one undo step. Joining retains both visual descriptions, ordered pictures and comment anchors.

### INV-22 — Scroll to the caret, not the cell

- **Behaviour:** To keep the caret in view, the app scrolls to the caret's own rectangle within the nearest scrolling ancestor, so the caret never ends up off-screen in a cell taller than the viewport.
- **Tests:** browser `09-alt-enter-and-scroll.txt` (in a tall cell, the caret's rectangle is inside the viewport).
- **Owner:** `src/bootstrap/wiring/editor.ts` (`nearestScrollAncestor` and the scroll that uses it; no feature folder owns it) · **Milestone:** 6 · **Class:** keep
- **Replacement:** —
- **Acceptance:** `09-alt-enter-and-scroll.txt` passes on the migrated editor.

### INV-23 — Ending a selection never fires a click action

- **Behaviour:** A click that finishes a text selection inside a comment card does not also jump to the anchored text. The card acts only when the selection is collapsed.
- **Tests:** browser `10-comments-panel.txt` ("finishing a text selection inside the card must NOT also fire a jump").
- **Owner:** `src/features/comments` · **Milestone:** 6 · **Class:** keep
- **Replacement:** — (M6 preserves the priority of selection completion).
- **Acceptance:** `10-comments-panel.txt` passes once comment-card bindings move to the comments feature.

### INV-24 — Export comment order ignores the panel's sort

- **Behaviour:** Exports always order comments by `commentPositionCompare()` in `src/features/comments/comments.ts`, which passes a row-index lookup (`rowIndexOf`) to `compareCommentPositions` in `src/core/document/comments.ts`: row, then Visual before Audio, then post time. The panel's sort mode is a reader preference kept in `localStorage`, not document data, and never changes an export.
- **Tests:** partial. Browser `11-comments-sort-persist.txt` (the sort is a reader preference). No test checks export order under a non-default panel sort.
- **Owner:** `src/core/document` (comment read model), consumed by `src/adapters/formats` · **Milestone:** 5 · **Class:** absorb
- **Replacement:** one frozen `ExportDocument` projection built from the session and the export options. Writers cannot read live UI state such as the panel's sort (M5).
- **Acceptance:** unit test: the `ExportDocument`'s comment order is the same with the panel sort set to `position` and to `recent`, and it matches `compareCommentPositions`.

### INV-25 — Tag cards have one event path

- **Behaviour:** Every panel showing `tagEntityHtml()` cards gets their behaviour from one wiring (`wireTagEntityContainer()`). No panel adds its own handlers for these cards.
- **Tests:** browser `12-gear.txt` (the Gear panel's cards work through the shared wiring).
- **Owner:** `src/features/tags` · **Milestone:** 6 · **Class:** absorb
- **Replacement:** the tag-card view owns its bindings through mount and dispose (M6). A new panel mounts the card list instead of wiring events.
- **Acceptance:** remount/dispose test: mounting the card list in a third container gives one handler set per container, and none remain after dispose.

### INV-26 — Quick-add forgets only what it added

- **Behaviour:** A quick-add box that tracks items whether or not the script mentions them adds a registry entry for each new line. When a line is removed, it deletes that entry only if the item is orphaned; an item still tagged in the script stays.
- **Tests:** `tests/core/production/tags.test.ts` ("INV-26: the quick-add plan deletes an orphaned entry whose line went and keeps one still tagged in the script"); `tests/core/production/golden.test.ts` (the Gear quick add against `production-gear-quick-add`); browser `12-gear.txt` ("removing a line un-tracks it, UNLESS it's still tagged live").
- **Owner:** `src/core/production` (reconciliation plan, `planQuickAdd`), `src/features/tags/panels.ts` (the caller) · **Milestone:** 2 · **Class:** keep
- **Replacement:** —
- **Acceptance:** new unit test: for a removed line, the quick-add reconciliation plan deletes an orphaned entry and keeps a live-tagged one. `12-gear.txt` passes.

### INV-27 — A `jsclick` "corrupted registry" symptom is not proof

- **Behaviour:** When a `jsclick`-driven browser test seems to show a corrupted registry, check `document.activeElement` first. `jsclick` does not blur the focused cell, and that cell's late blur can sync stale content back.
- **Tests:** not applicable.
- **Owner:** practice · **Milestone:** — · **Class:** practice
- **Replacement:** `.claude/skills/run-splitpage-app/SKILL.md` ("`jsclick` doesn't blur what `caret`/`press` focused") and `docs/HANDOFF.md` §2, "The test harness lies to you".
- **Acceptance:** —

### INV-28 — Native entry points take the least they need

- **Behaviour:** No HTTP endpoint spawns a process or installs files, and `server/server.ts` does not load `node:child_process`. Under `/api/launcher/` there is only `info`, behind the launch-token gate; a request without the token gets 404. Desktop channels take no argument or only typed ids and shas. These cover updates, opening the prompter in a browser, Google Drive, blobs, history, voice and video thumbnails. Main builds every URL, path and command itself, and no answer carries a path or a token. The video file channels are the exception: a grant takes the path the preload read from a dropped file, and `splitpage:video-path-open` takes a script's stored path, which main checks as INV-34 says before it opens it. The bundle channels (#259) take a grant token, single file names, file ids, the words `copy` or `link` and a job id; main reads the script's path from the tab when it accepts a copy, answers a Save As plan (`splitpage:bundle-save-plan`) with folder names, counts and sizes only, answers a Don't copy choice with the old files' paths for the planned names only (the one answer that names a path, see INV-34), runs the Save As carry itself, carrying only the bundled names in the bytes it writes, and its progress and carry notes carry only the job id, folder names and counts.
- **Tests:** partial.
  - `tools/test-server.mjs`: "launcher/info without the launch header is 404"; the staging and register routes answer 404.
  - `desktop/test/ipc-table.test.mjs`: "checkArgs refuses the shapes…", plus one argument test per channel.
  - `desktop/test/prompter-share.test.mjs`.
  - `desktop/test/blob-store.test.mjs`: "a sha that is not 64 lowercase hex is refused everywhere…".
  - `desktop/test/smoke.mjs`: "no answer names a path (invariant #28)".

  No test checks that `server/server.ts` never loads `child_process`.
- **Owner:** `server/`, `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** — (plan §8 keeps a single IPC contract source).
- **Acceptance:** the existing checks pass after server and desktop extraction. A new check in `tools/test-server.mjs` confirms the server's module graph never loads `node:child_process`.

### INV-29 — Connection secrets never persist in shared places

- **Behaviour:** The join PIN, session token and launch token never enter `update-status.json`, the document or any file the static handler serves. Connection details are browser state, never `state`. On desktop, a server tab persists only `{kind, serverDocId, serverUrl, tunnel}`, and a token is held only in main's memory until the new tab boots.
- **Tests:** partial.
  - `desktop/test/smoke.mjs`: "no token and no PIN in desktop-state.json after the quit (invariant #29)"; "draft: no PIN, token or launch URL ever reaches disk".
  - `src/test/connection.test.mjs`: "a tunnel is host and ports, and nothing that could carry a secret".

  No test covers `update-status.json` or statically served files.
- **Owner:** `src/application` (the session keeps credentials out of serialised content), `server/`, `desktop/` · **Milestone:** 4 · **Class:** keep
- **Replacement:** — (plan §6: credentials never enter project exports or recovery metadata).
- **Acceptance:** application test: serialising a session with a live server connection yields no token, PIN or key. New server test: after a join, no file under the static root contains the PIN or token.
- **App-side part (connection details as browser state, the server transport, the authority model):** Retired 2026-10-28: feature removed. The app has no server connection any more. The desktop and server part (no PIN, session or launch token in `update-status.json`, `desktop-state.json`, a draft or a served file) still holds until the desktop and server removal.
- **Milestone 4 (4.22):** held. `captureExportDocument` carries no connection, token, link key, handle or path (E15: `src/test/export-capture-app.test.mjs`, "a capture taken with a live connection and a file home holds no token, file name or handle"). A server transport holds a frozen copy of server and token for one operation and is never serialised (`src/test/server-transport.test.mjs`). The authority model reads connection facts and stores none (`src/test/collaboration-authority.test.mjs`). Still no test for `update-status.json` or statically served files. `docs/HANDOFF.md` §5.29 points here.

### INV-30 — The setup wizard appears only over a pristine copy

- **Behaviour:** The first-run wizard appears only when the build's seed-check meta passes, `splitpage-onboarding` is unset and no document is loading. File ▸ "Set up Splitpage…" opens it on purpose.
- **Tests:** browser `13-onboarding.txt` (cites "invariant #30"); `tests/bootstrap/wiring.test.ts` ("INV-30: through the shim's real wiring, initializers and startup…"), which boots the real shim in a fresh process for each arrival (a remembered file, a `?doc=` link, a desktop draft to restore) and over a pristine browser and desktop copy, the positive controls.
- **Owner:** `src/bootstrap` · **Milestone:** 7 · **Class:** keep
- **Replacement:** —
- **Acceptance:** `13-onboarding.txt` passes with milestone 7's explicit wiring step. Bootstrap test: when a document arrives by file, link or restore, the wizard does not open. (The modal is wired whether or not it may show, so milestone 7.2 tests that it does not open, not that it is never constructed.)

### INV-31 — A `.splitpage` file is the migrated state, pictures inline

- **Behaviour:** A `.splitpage` file is exactly `inlineBlobs(migrateRows(state))`: every picture's bytes are inline, with no envelope and no renamed or added fields. A reader gets image refs back through `migrateRows()`.
- **Tests:** `src/test/formats.test.mjs` (".splitpage has no envelope…", ".splitpage round-trips the whole document, byte for byte", "buildSplitpage never writes an unmigrated document", ".splitpage carries its pictures inline…"); `src/test/state-fields.test.mjs` ("a .splitpage save carries every registry field", "INV-04: a field added to STATE_FIELDS survives…"); `tests/bootstrap/document-ports.test.ts` ("a save straight after a load finds every picture the load decoded").
- **Owner:** `src/adapters/formats` · **Milestone:** 5 · **Class:** keep
- **Replacement:** — (plan §6: format compatibility is held by fixtures).
- **Acceptance:** the named tests pass against the registered `.splitpage` codec, and 3.1 project fixtures open unchanged.

### INV-32 — In a Markdown project, the data block is authoritative

- **Behaviour:** In a `.md` project, the fenced data block is authoritative for everything the table cannot show. The table overrides only scene text, and only where it differs from the block. The table never decides `Status`, and a difference in row count never silently picks a side. Both halves carry images inline.
- **Tests:** `src/test/formats.test.mjs` ("a cell edited outside Splitpage: the table wins for that cell only", "a scene added by hand is never adopted silently", ".md round-trips the whole document…", "a Visual cell's inline image travels in the table and comes back"); browser `17-formats.txt`.
- **Owner:** `src/adapters/formats` · **Milestone:** 5 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the named tests pass against the registered Markdown project codec.

### INV-33 — Automated desktop launches are invisible

- **Behaviour:** Every automated desktop launch sets `SPLITPAGE_TEST=1`, and nothing a test does appears on screen, apart from renderer `alert` and `confirm`. Only `MainWindowHandle === 0` proves invisibility; `document.visibilityState` does not.
- **Tests:** `desktop/test/smoke.mjs` sets `SPLITPAGE_TEST=1` and checks "no visible top-level window appeared during the whole case (MainWindowHandle=0)" (Windows only; skipped elsewhere, with the reason). Browser `21-desktop-shim.txt`.
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** —
- **Acceptance:** the smoke check passes on the Windows x64 and ARM64 devices at release gates.

### INV-34 — The renderer never sends a file path

- **Behaviour:** Desktop file operations address files by opaque ids from main's registry. Any bridge method that works on a file takes an id, never a path. One exception, decided by Adam for #259: `openVideoPath` (`splitpage:video-path-open`) takes the video path stored in a script. It only opens, never reads, writes or registers, and main refuses it unless `videoPathProblem` (`shared/video-path.ts`) and `openableVideoPath` (`shared/video-embed.ts`) pass: a local absolute path with no UNC, device, `.` or `..` part, a video extension before and after links are resolved, and a regular file. Tests: `desktop/test/video-path-open.test.mjs`, `tests/shared/video-path.test.ts`. The copies beside a script (#259) take no path: `splitpage:bundle-file` copies only the real file behind a drop's grant token, after its extension is checked again on the resolved path, into the bundle folder of the script the tab had when the copy was accepted, and drops the job if the tab has since opened an unrelated script; main itself carries the bundled names that the written bytes link, resolved in the old folder, into the folder of the file a script save dialog chose for that tab, as one queued job that checks them before that file is written, fails the write when one of them is missing from the old folder or is in the new folder with different bytes, and copies them after the write (`desktop/bundle-jobs.ts`); the renderer cannot ask for a carry, and `splitpage:bundle-save-plan` and `splitpage:bundle-save-choice` take only that file id, names and `copy` or `link`. A second exception, decided for #259's Don't copy: the `link` answer carries `{ name, path }` for the names that save's plan listed, and nothing else, each path passing `openableVideoPath` (so no UNC path); the renderer writes those path links and its document adopts them with the save, and main keeps no table of them. Neither bundle channel takes a path; `splitpage:video-file-open` opens the resolved real path that passed `openableVideoPath`; and `splitpage:bundled-file-open` takes one file name that `resolveBundledFile` (`shared/video-embed.ts`) must find, after links are resolved, directly inside that bundle folder as a regular video file, in a folder that is not itself a link or junction, or, while that tab's carry job runs and has not copied a name it lists, in the old folder; that fallback is part of the job and ends with it, with the tab, or when the tab opens another script. Tests: `desktop/test/bundle-ipc.test.mjs`, `desktop/test/bundle-copy.test.mjs`, `tests/shared/bundled-video.test.ts`, and the smoke case "a dropped video is copied beside the script…". Since #256 these channels and main's carry take any file that `ATTACHABLE_FILE` (`shared/video-path.ts`) allows instead of only videos: never a program, script, shortcut, installer or file without an extension, checked by main on the path it is given and on the real path. Tests: `desktop/test/attach-ipc.test.mjs`, `tests/core/document/attached-files.test.ts`, and the smoke case "an attached PDF is copied beside the script…".
- **Tests:** `desktop/test/smoke.mjs` ("main writes filePath:null for the unregistered fileId (invariant #34)", "draft: forged fileId with no registered path opens as an untitled copy"); `desktop/test/ipc-table.test.mjs`; browser `21-desktop-shim.txt`.
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** — (plan §8 keeps opaque file ids).
- **Acceptance:** the checks pass after the desktop file service is extracted, and `ipc-table.test.mjs` refuses a path-shaped argument on every file channel.

### INV-35 — Every document has a valid id, and the seed has none

- **Behaviour:** Every loaded document carries a `state.docId` matching `/^d[0-9a-f]{32}$/`. The seed, `#state-data` and the Standalone HTML export carry none. `SCHEMA_VERSION` was not bumped for it. A missing or invalid id is treated as unique, never as shared.
- **Tests:** `src/test/doc-id.test.mjs` ("normalizeDocId treats anything but the canonical shape as absent", "a hostile or missing id is re-minted…"); `src/test/doc-id-policy.test.mjs`; `src/test/starters.test.mjs` ("…has no missing STATE_FIELDS and no docId"); browser `22-doc-id.txt` (`#state-data` carries no `docId`).
- **Owner:** `src/core/document` (`shared/doc-id-policy.ts` stays shared) · **Milestone:** 2 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the named tests pass against `src/core/document`.

### INV-36 — The id follows the Save target

- **Behaviour:** A document forks to a new id only on Save As or on detached draft recovery. History copies only after the write succeeds. Restoring a snapshot keeps the id. Whether a document is already open is decided by path or server document id, never by `docId`.
- **Tests:** browser `22-doc-id.txt` ("a Save As whose write fails does not retarget Save (invariant #36)"), `24-history.txt` ("restore records its backup first and keeps the docId"); `src/test/doc-id-policy.test.mjs` (`chooseDuplicateLoser`); `desktop/test/smoke.mjs` ("routing: pristine reuse, dirty->new tab, path dedupe…").
- **Owner:** `src/application` (session transitions) · **Milestone:** 4 · **Class:** absorb
- **Replacement:** one transition API for adopting open, new, restore and publish (M4), which is the only writer of `docId`. History copies run when the save coordinator confirms completion. This matches plan §6: identity, epoch and generations have different meanings.
- **Acceptance:** application race tests:
  - Save As, publish and detached recovery fork the id; open, restore and a same-id reopen do not.
  - A failed or cancelled Save As leaves both the id and the destination unchanged.
  - No history copy happens before the write is confirmed.
- **Milestone 4 (4.22):** done. `createTransitions` (`src/application/transitions/`, 4.8) is the one writer of `docId` for open, new, restore, recover and publish, and every app caller uses it (saving.md §3). The file writer forks the id only when the write landed and the save still owns its document (4.11), and the history copy runs after a landed write. Tests: `tests/application/transitions.test.ts` ("INV-36: …"), matrix T1, T2*, F1 to F3, F9 and C1 in `src/test/m4-matrix-*.test.mjs`. `docs/HANDOFF.md` §5.36 now points here.

### INV-37 — `sha256Hex` and `deriveDocId` are frozen

- **Behaviour:** `sha256Hex`, `deriveDocId` and the duplicate-replacement id derived from them always give the same output. Any change would re-identify legacy files and split their history.
- **Tests:** `src/test/doc-id.test.mjs` ("SHA-256 vectors (FROZEN, HANDOFF invariant #37)", "deriveDocId is the frozen, domain-separated wrapper"); `src/test/doc-id-policy.test.mjs` ("the derived replacement id is FROZEN (invariant #37)"); `tests/core/document/ids.test.ts` ("the frozen SHA-256 vectors hold for strings and bytes", "deriveDocId is the frozen, domain-separated id").
- **Owner:** `src/core/document`, `shared/` · **Milestone:** 2 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the golden vectors pass unchanged after the move and are never regenerated.

### INV-38 — History is addressed only by `(docId, snapshot id)`

- **Behaviour:** Renderer and main address version history only by a validated `(docId, snapshot id)`, and every resolved path stays inside the history folder. At the renderer/IPC boundary, Older is addressed through `{older: true}`; an Older put requires a null document id. Internally the shared store accepts `"_older"` for reads, holds and repair, and for a put carrying the older flag; a normal put still refuses it. Missing-body repair uses the stored SHA to remove references across buckets only after rechecking that the body is absent. Damaged metadata or an invalid SHA never triggers repair: reads report damage, retain intact versions and leave the stored records unchanged.
- **Tests:** `src/test/history-store.test.mjs` ("put refuses what can never succeed with 'invalid', and the Older bucket by name", "get validates both halves of the address…"); `src/test/history-policy.test.mjs` ("HISTORY_SNAP_ID_RE: what may become a file name on disk"); `desktop/test/ipc-table.test.mjs` ("version history is exactly six app-only invoke channels"); `desktop/test/smoke.mjs` ("history: id validation — nothing outside history/…"); browser `27-app-data.txt` (case 10, bad docIds).
- **Owner:** `shared/` (`history-store.ts`), `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Damage coverage:** `src/test/history-damage.test.mjs` checks shared validation, readable versions, unchanged stored bytes and restore backups on memory, IndexedDB and filesystem storage; browser `391-history-damaged.txt` checks the notice and restore; desktop smoke checks damaged-entry reads through IPC.
- **Opaque writes:** Only validated entries take part in ordering, retention, sizes, copying and missing-body repair. Opaque entries and their body references remain intact. A first write to a non-array `snapshots` value quarantines that value in `damagedSnapshots` and starts an ordinary array for new backups. Existing quarantine values are never overwritten, and their presence continues to count as damage. A successful backup write leaves that backup in place.
- **Replacement:** —
- **Acceptance:** the checks pass after desktop IPC composition is extracted.

### INV-39 — Snapshots are captured synchronously; saves never wait on history

- **Behaviour:** `pushSnapshot()` captures the document at the moment it is called, and no save waits for history. A restore overwrites the document only after its "Before restoring" backup is stored, or after a second, explicit confirmation.
- **Tests:** partial. Browser `24-history.txt` (the "Before restoring" backup comes before the restore). No test covers synchronous capture or saves not waiting on history.
- **Owner:** `src/application` (effect scheduler, save coordinator) · **Milestone:** 4 · **Class:** keep
- **Replacement:** —
- **Acceptance:** application test with a history port that never resolves: a save still completes, and a later edit does not change the captured snapshot. If the backup is refused, the restore does not overwrite without the second confirmation.
- **Milestone 4 (4.22):** held, and now covered. Matrix case F9 (`src/test/m4-matrix-files.test.mjs`): no history copy happens before the write is confirmed, and a save never waits on a history copy that does not resolve. The "Before restoring" backup rule is unchanged (`restoreSnapshot` checks ownership after each await, 4.18; case H1). Still no direct test of `pushSnapshot()`'s synchronous capture. `docs/HANDOFF.md` §5.39 points here.

### INV-40 — A crash draft is removed only when clean or by the user

- **Behaviour:**
  - **Desktop:** a crash draft is deleted only when its tab becomes clean, or on an explicit user decision. It is never deleted on a crash, kill, renderer loss, session end, quit or restore. A discard writes a tombstone before anything is unlinked. A file tab whose file is no longer at its path is asked about on close, window close and quit as if it had unsaved changes; on "without saving" its tab writes a draft even when clean, and that draft is kept, so the next launch restores it, as an unsaved copy while the file is still missing (#258). The close goes ahead only once main finds that copy in the draft folder; if the tab doesn't answer in time or the write fails, the same unsaved-changes question is asked again for those tabs, and the tab, window or app stays open unless the user confirms (#496). A Windows session end writes and keeps the same copy without asking (#492). The file check waits at most one second, and a check that doesn't finish counts as the file being gone (#497). Once the check ends with "close", every tab it covers is checked again in the same step that closes: a tab that has unsaved changes it didn't have when its question was answered (it was edited while the check waited for a copy) is asked about before anything closes (#532).
  - **Browser:** keeps no drafts.
  - **Both:** a restore never saves.
- **Tests:**
  - `desktop/test/drafts.test.mjs`: "discardForUserDecision during a delayed write…", "session states, take never deletes…".
  - `desktop/test/smoke.mjs`: the draft crash-recovery cases, the "draft: moved file …" cases (#258, #496) and "draft: session end keeps a copy of a clean tab whose file is gone (#492)".
  - `desktop/test/close-keep.test.mjs`: the time-limited file check and the kept-copy rule (#496, #497), and the close check's rounds and last re-check (`runCloseCheck`, #508, #509, #532).
  - `desktop/test/lifecycle-order.test.mjs`: the order of question, kept-copy wait, recheck, draft settlement, session-write freeze and close or quit, for a gone file whose copy is late or kept in time and a tab edited while the close waits.
  - `desktop/test/smoke.mjs`: the "close check:" groups, including "a tab edited during a window close's/quit's copy wait is asked about again (#532)".
  - `src/test/draft-keep-app.test.mjs`: a keep flush writes a clean file tab's draft, and only then (#258).
  - Browser suite `26-desktop-drafts.txt`.
- **Owner:** `src/application` (recovery writer ownership), `desktop/` · **Milestone:** 4 · **Class:** keep
- **Replacement:** — (plan §6: recovery preserves source work through failed adoption, writer conflict or revoked access).
- **Acceptance:** the M4 gate's recovery tests pass (multi-tab ownership, revoked links, restart), and a writer discards only the draft generation acknowledged to it.
- **Milestone 4 (4.22):** held, with the recovery split of 4.17 and 4.18: the draft writer discarded only the generation acknowledged to it (B1, B7; the browser writer was removed later, and on the desktop main's `STALE_SEQ` check holds B7), `capture-schedule.ts` owns the timers and backoff (B4, B4b), `restore-policy.ts` the ownership check (K1, H1). A superseded desktop file-draft restore keeps its draft (outcome `kept`, `restoreDoneAction` in `desktop/drafts.ts`); the one way to lose it is the user answering "Don't save" for the script that replaced it (the same as the unreadable-draft path; saving.md §7). Tests: `src/test/m4-matrix-recovery.test.mjs`, `tests/application/capture-schedule.test.ts`, `desktop/test/drafts.test.mjs`. The desktop recovery groups run at the gate. `docs/HANDOFF.md` §5.40 points here.

### INV-41 — Restoring a draft never writes the user's file

- **Behaviour:** Restoring a draft never writes the user's file by itself. Whether a file is unchanged on disk is decided by content, never by mtime. Only main builds the draft header, from allowlisted scalar fields. Draft bodies are written with fsync and kept in two generations.
- **Tests:** `desktop/test/smoke.mjs` ("the file on disk is untouched by the restore (invariant #41)", "the merge does NOT autosave (invariant #41…)", "draft: power-cut mid-write keeps the FIRST generation…"); `desktop/test/drafts.test.mjs` ("a torn write keeps the previous generation…", "a checksum mismatch falls back to previous…"); browser `26-desktop-drafts.txt`.
- **Owner:** `src/application` (restore and adoption policy), `desktop/` · **Milestone:** 4 · **Class:** keep
- **Replacement:** — (plan §6: restoration does not silently save a user file).
- **Acceptance:** application test: adopting a restored draft leaves the destination's confirmed generation and baseline unchanged and schedules no save.
- **Milestone 4 (4.22):** held, and now an application rule. A recovery settle arms no autosave (`createSessionEffects().save` in `src/application/save/session-effects.ts`, which skips `recovery` changes; the draft merge path also sets `noAutoSave` in `src/application/recovery/drafts.ts`), and the restores go through `transitions.restore` and `transitions.recover`, which leave the destination's confirmed generation and baseline as they were. Tests: matrix T5, T5-merge, T6, B8, B11 and K1 (`src/test/m4-matrix-*.test.mjs`), `tests/application/restore-policy.test.ts`. One behaviour change to know: "Undo merge" after a server conflict no longer autosaves a couple of seconds later. `docs/HANDOFF.md` §5.41 points here.

### INV-42 — Main is the authority on tabs

- **Behaviour:** Each desktop tab is its own page. Only the main process decides tab identity, unsaved state and what is already open. Moving a tab moves its `WebContentsView`; it never copies it.
- **Tests:** `desktop/test/smoke.mjs` ("tear-off preserves live tab state (no reload)", "routing: pristine reuse, dirty->new tab, path dedupe…", "main never loses a restored tab's path while its page boots (invariant #42)").
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** —
- **Acceptance:** the smoke cases pass after the tab/session registry is extracted (the first desktop step in plan §8).

### INV-43 — The tab strip is a separate origin

- **Behaviour:** The tab strip runs on `splitpage://tabstrip`, with no `splitpageDesktop` bridge and its own sender check (`isTrustedTabStripSender`). A compromise of either page cannot reach the other page's powers.
- **Tests:** `desktop/test/smoke.mjs` ("tabstrip origin: no file/draft/history bridge, no /api proxy"); `desktop/test/ipc-table.test.mjs` ("neither preload can reach the other's channels", "the two origins share only the table read").
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** —
- **Acceptance:** both checks pass after protocol policies are extracted.

### INV-44 — One quit, one question; session end asks nothing

- **Behaviour:** A quit asks at most one unsaved-changes dialog and one stop-sharing prompt. A Windows session end asks neither and discards nothing. `desktop-state.json` is written durably through one queue.
- **Tests:** partial. `desktop/test/smoke.mjs` ("window close: 2 dirty tabs + another window open (one dialog)", "quit: dirty tabs in two windows (one answer per attempt)", "--host: stop-sharing prompt fires once at quit…"). `desktop/test/drafts.test.mjs` only records the `session-end` state. `desktop/test/lifecycle-order.test.mjs` runs `main.js` against a fake Electron and pins the order of each close and quit step; its "session end: …" cases show a session end with dirty tabs asks nothing and discards nothing. "draft: session end keeps a copy of a clean tab whose file is gone (#492)" emits `session-end` through a test-only shell op and checks that nothing is asked and an untitled tab's draft stays; it can't show how long Windows lets the writes run. No test checks that writes go through a single queue.
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** —
- **Acceptance:** the smoke cases pass. New desktop test: a simulated session end with dirty tabs shows no dialog and leaves every draft in place.

### INV-45 — The voice listener starts and stops only for its own tab

- **Behaviour:** The page can ask the voice listener only to start, stop or report status, and only for itself; these channels take no argument. Main alone builds the command line (Windows `powershell.exe` running `voice/listen.ps1`, which reads only stdin). Under `SPLITPAGE_TEST=1` only the named fake helper runs.
- **Tests:** `desktop/test/ipc-table.test.mjs` ("Follow My Voice takes no argument, from the app page only"); `desktop/test/voice-helper.test.mjs` ("only the owning tab can stop a session", "no command means unavailable, and start refuses"); `desktop/test/voice-composition.test.mjs` ("in test mode without a fake helper, voice is unavailable and start refuses", "outside test mode: the PowerShell listener in development, resources/splitpage/voice when packaged"); `desktop/test/smoke.mjs` (runs with `SPLITPAGE_TEST_VOICE_HELPER`); browser `72-desktop-voice.txt`.
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** —
- **Acceptance:** the checks pass after voice is extracted as a desktop service.

### INV-46 — Listener output is rebuilt before the page sees it

- **Behaviour:** `parseHelperLine` keeps only known message types. It keeps a capped `text`, a short `code`, a culture name, or a capped microphone `name` without control characters, and drops everything else. Main sends the result only to the owning tab. The page uses `text` as words to match and `name` as status text, never as markup.
- **Tests:** `desktop/test/voice-helper.test.mjs` ("parseHelperLine keeps the known shapes…", "parseHelperLine drops anything else", "…a microphone's name as plain, capped text (#118)", "junk from the helper never reaches the page"); `desktop/test/voice-composition.test.mjs` ("an ordinary tab's events reach only that tab…", "a relay session's events reach only the share…"); browser `83-voice-mic-name.txt`.
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** —
- **Acceptance:** the named tests pass unchanged.

### INV-47 — One listener, which never outlives its tab or the app

- **Behaviour:** Only one voice session runs at a time. When a second tab starts, it takes the microphone over and the first tab is told (`end`, reason `taken`). Closing the tab or quitting ends the session. The helper exits when its stdin closes, so even a main-process crash stops it listening.
- **Tests:** `desktop/test/voice-helper.test.mjs` ("a second tab takes the microphone over; the first is told", "a tab closing ends its session without an event", "a helper that ignores its stdin closing is killed"); `desktop/test/voice-composition.test.mjs` ("closing a tab revokes its share, then forgets the tab and its relay, silently", "quitting, through close-quit's will-quit, closes the share and then stops the helper").
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** — (plan §6: closing an owner releases its resources).
- **Acceptance:** the named tests pass, and a real-Electron smoke run shows no listener process after the tab closes.

### INV-48 — The app-data bundle carries no credentials

- **History completeness:** Damaged metadata is skipped while intact versions and their available images export.
  `omittedSnapshots` counts damaged metadata and confirmed missing bodies, and delivery warns about omissions.
  Persistent history falling back to memory, a history/image read failure, or damage with no readable version to
  export cancels file delivery. An unclassified body/image read failure with readable history offers an explicit
  opt-in rerun that permits counted omissions; no gathered bundle is retained. Known temporary failures ask for a
  retry without offering partial delivery. An unavailable store or an empty remainder offers no choice. Exports
  run one at a time; newer attempts invalidate older prompts. Expired intact Older entries are not omissions.
- **Behaviour:** Before any byte of an app-data export is written, the bundle is checked for keys matching `/token|api[-_]?key|client[-_]?id|secret|password|\bpin\b/i`, and it must contain none. An import carrying such a key is refused. Image bytes count toward the 200 MB export cap. Images whose bytes could not be read are listed in `missingBlobs`, and the export warns about them.
- **Tests:** browser `27-app-data.txt` (case 2, the "invariant #48" key walk; case 7, a bundle carrying `apiKey`; cases 14, 15 and 19); `34-desktop-app-data-export.txt`.
- **Owner:** app-data bundle codec under `src/features/settings/app-data.ts` · **Milestone:** 6 · **Class:** keep
- **Replacement:** —
- **Acceptance:** both suites pass. New unit test: the codec refuses to write, and refuses to import, a bundle with a credential-shaped key at any depth.

### INV-49 — App-data import only adds

- **Behaviour:** Import writes through the history store's public write path and never deletes. Existing preferences are never overwritten. Each image is verified and stored durably before the first snapshot that names it. A bad image is dropped and reported, and its snapshots still import. A bundle without `blobs` imports exactly as before.
- **Tests:** browser `27-app-data.txt` (cases 4 and 5: idempotence, preferences; cases 16–18: images first, a tampered image, an old bundle).
- **Owner:** app-data bundle codec under `src/features/settings/app-data.ts` · **Milestone:** 6 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the suite passes. New unit test: importing into a store that already holds newer snapshots and preferences leaves all of them unchanged.

### INV-50 — The installer waits for a 1.0.x folder to go

- **Behaviour:** When installing over a 1.0.x install, the installer waits for the old uninstaller's detached `rmdir` to finish before writing to the folder. `desktop/build/installer.nsh` keeps this wait even though `uninstall.ps1` is no longer in the repository.
- **Tests:** none found. `docs/WINDOWS-CHECKS.md` lists an upgrade over 1.0.x as not run.
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** —
- **Acceptance:** a Windows packaged check, recorded at a release gate: installing over a 1.0.x install leaves a working install on x64 and ARM64.

### INV-51 — Autosave writes only where the user sent the document, only reviewed work, only when on

- **Behaviour:**
  - **Where:** autosave writes only to a file handle the user picked. It never opens a picker and never downloads.
  - **When:** only while the preference is on. Typing and discrete actions both check the preference first.
  - **Halting:** when unreviewed work comes on screen (a crash-draft restore's merge, a `noAutoSave` merge), autosave stops until an explicit Save. A failed or conflicted automatic save stops it too.
- **Tests:**
  - Browser `28-autosave.txt`: "off means off", "a file that changed on disk stops autosave…", "a manual Save…".
  - Browser `42-local-merge.txt` (halt after a merge; cites invariant #51) and `185-autosave-every-edit.txt`.
  - `src/test/home.test.mjs`: "autoSaveTarget answers file or null off the home".
  - `desktop/test/smoke.mjs`: "the merge does NOT autosave…".
- **Owner:** `src/application` (save coordinator) · **Milestone:** 4 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the suites pass. Application test with a fake clock: after a recovery adoption or a `noAutoSave` merge, no automatic write is scheduled until an explicit Save; with autosave off, none is scheduled at all.
- **Milestone 4 (4.22):** held. `autoSaveWhere` and `autoSaveMay` (`src/application/save/autosave.ts`) are pure and tested (`tests/application/save-status.test.ts`, "INV-51 where…"), and a restore schedules no automatic write (T5). The halt state and the idle and max timers are in `createAutoSavePolicy()` (`src/application/save/autosave.ts`, `schedule()` at line 114); `src/bootstrap/wiring/save-owners.ts` builds it with its timer port (saving.md §8). `docs/HANDOFF.md` §5.51 points here.

### INV-52 — No durable record names a blob its store lacks

- **Behaviour:** An image is uploaded and made durable before any record naming its sha is written, and `refsIn()` is always the list of what a record names.
  - **Server:** it refuses a document or comment that names missing blobs (422 `missing-blobs`). `acceptMissing` lets a document name a sha known to be lost for good; comments cannot use it. A pre-#82 client cannot save over a document that names blobs (426).
  - **Client:** history, drafts and app-data import await `persist()` before they write.
- **Tests:** `tools/test-server.mjs` (`missing-blobs`, `acceptMissing`, `client-too-old`); `src/test/blob-store.test.mjs` ("persist resolves only once the backend has stored the bytes"); `src/test/blob-policy.test.mjs` (`refsIn`); browser `65-blobs.txt`, `26-desktop-drafts.txt`, `27-app-data.txt` (case 16).
- **Owner:** `src/application` (save coordinator: blob transfer before the write), `server/` · **Milestone:** 4 · **Class:** keep
- **Replacement:** — (M4: one transport instance owns both the blob transfer and the write that follows).
- **Acceptance:** M4 race matrix: when a blob upload fails or is cancelled, no record is written. The server checks are unchanged.
- **Milestone 4 (4.22):** held. A hosted save builds one transport from the connection it captured and sends the blobs and the write through it (4.14); a failed or cancelled upload writes no record and keeps the document dirty (matrix S8), and a save that no longer owns its document sends nothing more (S3, S4-token, S6-reopen). `sendReviewWrites` still builds a transport from the live connection per comment (saving.md §8). `docs/HANDOFF.md` §5.52 points here.

### INV-53 — Every edit is recorded once; nothing else is recorded

- **First-save naming (I-32):** accepting a filename for an untouched title
  applies one undoable command after a successful current save. Title, tag
  and provenance undo together; the file destination remains. Failed or
  cancelled saves add no entry. `src/test/file-title-app.test.mjs` pins this
  and the protection for title edits made while a save waits.
- **Behaviour:** Every edit to the document ends in `markDirty()` or is a session command, and undo learns of the edit by diffing. An edit is recorded once, unless it ends where it began: typing that coalesces back to its start, such as a letter typed and deleted within a second, leaves no step. Changes that are not the user's edits are registered as such and never become undo steps: a new document, someone else's merge, a reload in place, or the repair made by an undo's own repaint.
- **Tests:** `src/test/undo.test.mjs` ("diffStates: the lists and comments are one step each; bookkeeping is never a step", "forget (design D4)…", the coalesced-back and redo tests, and `redoInvariantRun`); `src/test/apply-merge.test.mjs` ("nothing differed: no merge, no snapshot, no rev bump"); `tests/application/document-session.test.ts` (the "E2", "E3" and "E4" tests); `src/test/cell-text-app.test.mjs`, `split-join-app.test.mjs` and `cut-paste-app.test.mjs` (one generation, one change count step and one undo step per command); browser `73-undo.txt`, `76-tags-model.txt` (`settleAfterApply`), `185-autosave-every-edit.txt`, `186-autosave-panel-edits.txt`, `289-script-cell-ime.txt`.
- **Owner:** `src/application` (DocumentSession) · **Milestone:** 3 · **Class:** absorb
- **Open tags:** Opening and cancelling a silent tag without an edit preserves the surrounding typing group. The first name edit and Tab conversion keep their own undo boundaries. `src/test/tag-button-open-app.test.mjs`, `tests/application/editing/cell-editing.test.ts` and browser `1207-open-tags.txt` hold these steps, including formatted names and multiline paste cancellation.
- **Replacement:** DocumentSession transactions (M3; plan §6):
  - an accepted change advances the edit generation once and is recorded under the existing undo grouping;
  - a no-op or rejected command has no effects;
  - user edits, disk updates and recovery adoption are distinct transaction kinds.
- **Acceptance:** application tests:
  - A user command advances the generation once and adds one undo entry.
  - A merge, a reload or a recovery adoption adds none.
  - A no-op command does not dirty the document, schedule a save or add an entry.
- **As built (M3):** met by `document-session.test.ts` and each command's "E2" and "E3" tests. Seven edits are commands (scene length, scene status, typing, split, join, cut, paste); every other writer still ends in `markDirty()`, which the session takes as an edit of unknown extent (one generation, one undo record, a whole-document change set). Recovery that enters by assignment (the draft restores, history restore, a file import) is published as `adopt`, not `recovery`, so it opens an epoch and adds no generation or undo entry; naming it `recovery` would route it through `noteRemoteChange`, which keeps the undo stack, and 12a clears it today (E4, accepted by the coordinator). Undo and redo replay still write `S.state` outside the session; milestone 6 takes that ([session.md](session.md#8-known-gaps-and-exceptions)).
- **As built (M4, 4.7):** once the generation has advanced, a command is never rolled back. A throw in undo recording, an effect or a listener is reported, the change stays, and the command returns `committed` (D13, matrix cases E2a to E2c). The editor's colour (`personColors`) is written inside the command's transaction and declared; it is not an undo field, so it never becomes a step (`session-commit-app.test.mjs`).

### INV-54 — A b-roll key's id belongs to one line

- **Behaviour:** No two b-roll keys in a document share an id.
  - **Brought in from outside:** a pasted or dropped key gets a new id whenever the document already knows its id. The exception is a cut then paste in the same tab, which moves the key.
  - **Moved:** a split, join or cut keeps the key's id and never copies it.
  - **Backstop:** the anchoring pass re-keys any duplicate that still gets through.
- **Tests:** `src/test/clipboard.test.mjs` ("freshBrollIds: a key keeps its id only when nothing has it, and never twice in one paste", "brollIdsTaken…"); `src/test/broll-model.test.mjs` ("anchoring: a key repeating an id an earlier line holds gets an id of its own…", "a pasted key's record is a new shot seeded from its scene…"); `tests/core/production/broll.test.ts` ("INV-54: anchoring gives a key repeating an earlier line's id an id of its own…", "a line never takes a shot a keyed line further down holds…"); browser `80-broll-paste-ids.txt`, `47-move-scene-keys.txt`, `45-broll-anchoring.txt`.
- **Owner:** `src/core/production` · **Milestone:** 2 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the named tests pass against `src/core/production` and the migrated clipboard path.
- **As built (M3 3.14):** the cell-level paste is `pasteCommand` in `src/application/commands/clipboard.ts`, which owns `takenBrollIds`, `freshBrollIds` and `pastedShots` (`src/features/clipboard/cell-clipboard.ts` keeps thin wrappers). `tests/application/clipboard.test.ts` pins it: "a copied b-roll key whose id is taken gets a fresh id and a shot record seeded from the scene…", "a cut b-roll key pasted back keeps its id and makes no second record…", and "seeded: a pasted copy never leaves two keys with one id in the script". The scene paste in `src/features/clipboard/beat-clip.ts` still uses `freshBrollIds` and `recordPastedBroll` (D10).

### INV-55 — A comment or reply draft owns its undo

- **Behaviour:** Edits in a comment or reply box go through the model (`editDraft`). In that box, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, `historyUndo` and `historyRedo` are always answered from the box's own history, never the browser's or the document's. Pictures and video cards in a draft survive every edit.
- **Tests:** `src/test/draft-edit.test.mjs`; browser `81-draft-edit.txt`.
- **Owner:** `src/features/comments` · **Milestone:** 6 · **Class:** keep
- **Replacement:** — (M3 keeps comment and reply drafts on their own undo).
- **As built (M3):** held. No command takes a draft box: `syncFieldFromDom` and the five text commands act on script cells, and `81-draft-edit.txt` ran green in the 3.12, 3.13 and 3.14 suite sets.
- **Acceptance:** both pass after the composer moves to the comments feature.

### INV-56 — A b-roll shot stores only hand-added props, by registry id

- **Behaviour:**
  - **Stored:** a shot's `props` hold only props added by hand, as `[{id, name}]` keyed by registry id. Props tagged on the shot's own lines are read from the script each time.
  - **Renames and merges:** a rename carries through by id, and folding onto another entry's name re-points the shot in the same edit. Merging is a base-aware set per shot.
  - **Pasting:** a pasted copy of a shot's line gets no props.
  - **New fields:** a new shot field must be kept by `migrateRows` and `mergeBrollShots`, and added to both shot builders, `newBrollShot` in `src/core/document/broll.ts` (the one that `newBrollRecord` in `application/commands/production-actions.ts` and the paste command in `clipboard.ts` use) and the plan's own builder `newBrollShot` in `src/core/production/broll.ts`, at the same place in each.
- **Tests:** `src/test/broll-model.test.mjs`; `tests/core/production/broll.test.ts` ("INV-56: …", two tests); `src/test/production-shims.test.mjs` ("a shot the core plan creates and one newBrollRecord stores serialise alike, keys in the same order"); `src/test/merge-states.test.mjs` ("b-roll props: …"); `src/test/migrate-rows.test.mjs` ("brollShots props: …"); `src/test/state-fields.test.mjs` ("a b-roll shot keeps every field it has — props too — through a merge and a save"); `src/test/formats.test.mjs` (props round trips); browser `95-broll-props.txt`.
- **Owner:** `src/core/production` · **Milestone:** 2 · **Class:** keep
- **Replacement:** — (the field-list clause can join the M2 field policy; the props rules stay explicit).
- **Acceptance:** the named tests pass. New unit test: a field added to the shot record's policy survives migration, merge and save without edits to `mergeBrollShots`.

### INV-57 — Exports state non-script facts through one kit

- **Behaviour:** Every document export takes everything it states besides the words from `application/save/export-kit.ts`:
  - the facts line;
  - each beat's number, start timecode, status and read time;
  - open-thread numbers;
  - each cell's tags, b-roll keys and markers;
  - the breakdown by category and the b-roll by beat.

  No format works these out for itself. The print colours are a second copy of `:root`, held to it by `palette.test.mjs`.
- **Tests:** `src/test/export-kit.test.mjs`; `src/test/m4-matrix-exports.test.mjs` (X6–X12, X14, X15 and X18: non-PDF writers and file-building kinds retain captured bytes after live edits); `src/test/palette.test.mjs`; `src/test/export-colours.test.mjs`; `src/test/xlsx-export.test.mjs`; `tests/adapters/formats/markdown-table.test.mjs`; browser `41-export-polish.txt`. PDF capture: `tests/adapters/formats/script-print.test.mjs` ("rendering a capture after edits keeps captured words, facts, comments and assets"), `tests/adapters/formats/list-print.test.mjs` ("held captures survive later source, production, shot and person edits; the captured day is deterministic"), `src/test/browser-pdf-app.test.mjs`, `src/test/print-capture-app.test.mjs`, and `tests/features/file-menu/browser-pdf.test.mjs` and `desktop-pdf.test.mjs` (capture before asset loading, including document switches). Adam approved deletion of the replaced old-generator cases in AQ-44 on 2026-10-31.
- **Owner:** `src/application` (`ExportDocument`), consumed by `src/adapters/formats` · **Milestone:** 5 · **Class:** absorb
- **Replacement:** one frozen `ExportDocument` projection, captured from the session and the options, plus a format registry whose writers read only that projection (M5).
- **Acceptance:**
  - M5 gate: a small test exporter needs only one provider and one registration.
  - Unit test: for a fixture, every registered writer's beat facts equal the `ExportDocument`'s.
  - Dependency gate: format modules import no timing, tag or thread-numbering helpers directly.

### INV-58 — Export decoration is skipped on re-import

- **Behaviour:** Anything an export prints besides the script is skipped when the file is read back, whether it was exported before or after the export changes:
  - **.docx:** the named Splitpage styles.
  - **Markdown:** the meta, facts and marker patterns and the tail headings.
  - **CSV:** its own header, a cut at its own Comments line, and empty Total and Target rows.

  The `.docx` fixtures are the old writer's output and are never regenerated.
- **Tests:** `src/test/docx-reimport.test.mjs`, with `src/test/fixtures/splitpage-3.0.0-beta.8.docx` and `src/test/fixtures/splitpage-3.0.0-beta.8-narration.docx`; `tests/adapters/formats/markdown-table.test.mjs` ("the new stacked export reads back as exactly its scenes, and nothing round them", "a stacked export written before #169's look still reads back as its scenes"); `src/test/text-exports.test.mjs` ("the new sheet reopens as exactly its scenes: no totals, no comments", "a sheet exported before #169's columns reopens as its scenes…"); browser `41-export-polish.txt`.
- **Owner:** `src/adapters/formats` (import readers) · **Milestone:** 5 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the named tests and fixtures pass unchanged against the registry's import readers.

### INV-59 — The `.md` project's human half is frozen

- **Behaviour:** The table and tail of a saved `.md` project stay byte for byte what they were before the export changes. Everything that only exports need sits behind `opts.export`.
- **Tests:** `src/test/formats.test.mjs` ("a saved .md project is byte for byte what it was before the exports changed", which keeps the pre-change writer verbatim).
- **Owner:** `src/adapters/formats` · **Milestone:** 5 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the test passes against the registered Markdown project codec, with the verbatim old writer kept.

### INV-60 — An export is the same bytes all day

- **Browser PDF scope — awaiting Adam's decision:** Captured print HTML is deterministic for the captured day. The browser owns the PDF bytes and metadata; desktop PDF and non-PDF exports keep the byte rule below.
- **Desktop PDF scope (P3):** Desktop PDFs are Electron's `printToPDF` of the same captured print HTML. Chromium writes the time of printing into `/CreationDate` and `/ModDate`, so `pinPdfDay` (`src/adapters/print/desktop-print.ts`) rewrites both, at the same length, to midnight of the captured day with its UTC offset. Everything else Chromium writes was the same on every run measured on Electron 44. Tests: `tests/adapters/print/desktop-print.test.mjs` and the desktop smoke group "desktop PDF export" (the script exported twice gives the same bytes).
- **Behaviour:** The same document exported twice on the same day gives identical bytes in every format. A PDF's `/CreationDate` and a .docx's `docProps` dates carry the day, not the time. Nothing prints the time of export; comments' own timestamps are data and are allowed.
- **Tests:** browser `98-export-dialog.txt` (captured print HTML for the four PDF actions; file bytes for non-PDF actions); `src/test/m4-matrix-exports.test.mjs` (X22: non-PDF file-building kinds captured twice in a day and serialized after midnight); `src/test/xlsx-export.test.mjs` ("exports captured either side of a two-second boundary are the same bytes; the zip carries the captured day"). Desktop PDF dates and byte equality: `tests/adapters/print/desktop-print.test.mjs`; captured print-page dates: `tests/adapters/formats/list-print.test.mjs`. Adam approved deletion of the replaced old-generator cases in AQ-44 on 2026-10-31.
- **Owner:** `src/adapters/formats` · **Milestone:** 5 · **Class:** keep
- **Replacement:** — (the `ExportDocument` captures the date; since 5.1 every date and ZIP timestamp is `exportDay` of it, [saving.md](saving.md#6-capture-46)).
- **Acceptance:** suite 98 and the unit checks pass. New unit test: two `ExportDocument`s captured at different times on the same day give identical bytes for every registered format.

### INV-61 — The PDF footer is a pagination artifact

- **Browser PDF scope — awaiting Adam's decision:** The browser owns its PDF footer encoding. Deterministic captured print HTML does not guarantee browser PDF bytes or artifact encoding. See [print-layout.md](print-layout.md#browser-print-workflow-p4).
- **Desktop PDF scope — accepted (Adam, 2026-10-31):** Desktop `printToPDF` (P3) draws the footer from the print page's CSS page-margin boxes. Electron 44's tagged PDF writes no `/Artifact` operator at all, so text extraction includes the footer's title and page number. Adam accepted this: desktop PDFs do not keep the rule, and the footer stays in the shared print CSS (not moved into Electron's own footer template). See [print-layout.md](print-layout.md#desktop-printtopdf-p3). The old generator met the rule until AQ-44 deleted it; since then no PDF path implements it (desktop: accepted above; browser: awaiting Adam's decision).
- **Behaviour:** The PDF footer is marked `/Artifact << /Type /Pagination /Subtype /Footer >> BDC … EMC` (it was `pdfFooterOps` in the old generator, deleted in AQ-44), so text extraction skips it. Tests that read content streams skip it too, because its hairline uses the same operator as a scene rule.
- **Tests:** The old-generator footer-artifact cases were deleted under Adam's approved AQ-44 inventory on 2026-10-31. No current print-path test asserts this artifact syntax; the desktop exception and outstanding browser scope are recorded above. Footer presence and numbering are checked separately by `tests/adapters/formats/printed-layout.test.mjs`.
- **Owner:** `src/adapters/formats` · **Milestone:** 5 · **Class:** keep
- **Replacement:** —
- **Acceptance:** both pass. New unit test: text extracted from a PDF export contains no footer text.

### INV-62 — Collaborate credentials stay in this browser, per server

Retired 2026-10-28: feature removed.

- **Behaviour:**
  - **Owner key:** typed, posted to `/api/join` and never stored.
  - **Owner token:** kept in the tab (`splitpage-server-token`) and, when remembered, in the per-server map `splitpage-server-tokens`.
  - **Link key:** kept in the link and the tab (`splitpage-review-key`). It is stored on the device (`splitpage-invites`) only when the server reports `linksPersist: true`, and it leaves the address bar as soon as it is read.
  - **Link token:** the tab's alone. It never enters the owner's map.
  - **Excluded:** none of them ever enters `state`, a file, an export, the app-data bundle, `desktop-state.json`, a draft header, the browser draft store, or any URL other than the link itself.
- **Tests:** browser `260-collaborate-local.txt`, `261-collaborate-links.txt`, `263-collaborate-guest.txt`, `43-review-mode.txt` (a LAN review key never reaches `localStorage`), `265-browser-drafts.txt` (no token or key in drafts), `18-connect.txt` (no credential-named storage keys); `src/test/collaborate.test.mjs` ("the link a guest arrives on: #invite= or #review=, taken out, the rest kept"); `tools/test-server.mjs`.
- **Owner:** `src/application` (connection and authority) over browser storage adapters in `src/adapters/` · **Milestone:** 4 · **Class:** keep
- **Replacement:** — (plan §6: credentials and invitation fragments never enter exports or recovery metadata).
- **Acceptance:** the suites pass after collaboration moves behind application interfaces. Application test: serialising any session to a project, export or recovery record yields no token or key.
- **Milestone 4 (4.22):** held. The authority model (`src/application/collaboration/authority.ts`, 4.16) derives who may edit from the connection's token, role and scope and stores no credential; credentials stay per server in this browser. Tests: `src/test/collaboration-authority.test.mjs` and the Collaborate suites above, re-run at the gate. `docs/HANDOFF.md` §5.62 points here.
