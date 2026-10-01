# Invariant ledger

This ledger audits the 62 invariants in `HANDOFF.md` §5, one row each, under the same numbers. `HANDOFF.md` §5 stays in step with it. When a milestone absorbs a rule into code, the PR that does so replaces that rule's `HANDOFF.md` entry with a one-line pointer to its row here (plan §5, milestone 0 item 7), so the two never disagree. The behaviour tests of an absorbed rule stay; only the prose rule goes. Update a row in the same PR that changes its tests, owner or class.

## Legend

- **keep**: the rule stays explicit, held by its tests. No planned structure makes breaking it impossible.
- **absorb**: a structure in `docs/IMPLEMENTATION-PLAN.md` enforces the rule once it lands (one field policy, one transaction boundary, one overlay owner, one export projection). The row names that structure and the test that proves it.
- **practice**: a working habit or debugging advice, not product behaviour. It moves to contributor or skill notes.
- **Milestone**: for absorb, the milestone that lands the replacement; for keep, the milestone that migrates the rule's owner; `4.x` for server and desktop internals (plan §8); `—` for practice.
- **Tests**: unit tests are cited by path. Browser suites are cited by full filename and live in `.claude/skills/run-splitpage-app/tests/` (numeric prefixes are not unique). "none found" means a search of `src/test/`, the browser suites, `desktop/test/`, `tools/test-server.mjs` and `tools/test-update.mjs` found nothing that asserts the rule.
- **Owner**: the target folder from plan §3. Feature folder names (`src/features/editor`, `src/features/overlays` and so on) are provisional; the plan fixes only `src/features/<feature>`.

## Summary

Classes: keep 42, absorb 18, practice 2. Milestones: 2 → 9, 3 → 3, 4 → 9, 5 → 9, 6 → 18, 7 → 1, 4.x → 11, — → 2 (none at 0 or 1).

No test coverage found: INV-05, INV-08, INV-50. Partial coverage: INV-11, INV-12, INV-13, INV-19, INV-24, INV-28, INV-29, INV-39, INV-44.

## Ledger

### INV-01 — Edit source one site at a time

- **Behaviour:** Source changes are made as targeted edits at one site, never by in-place regex substitution (`sed -i`, `perl -pi`) across a file.
- **Tests:** not applicable.
- **Owner:** practice · **Milestone:** — · **Class:** practice
- **Replacement:** `CONTRIBUTING.md` working notes. The original risk has gone: `index.html` is gitignored build output and the source in `src/` is under version control.
- **Acceptance:** —

### INV-02 — Script cells change only through the document model

- **Behaviour:** Every change to a script cell is a document-model edit (`editCell()` at the selection, or the edits in `src/core/text/edits.ts`, which `04c-doc-model.js` re-exports), written back with `toHtml()`. No path edits cell HTML with a regex, and nothing uses `execCommand`, in script cells or in comment and reply boxes.
- **Tests:** `src/test/doc-model.test.mjs`, `src/test/cell-edit.test.mjs`; browser `75-format-model.txt`, `76-tags-model.txt`, `77-clipboard-model.txt`, `78-split-join-model.txt`, `81-draft-edit.txt`. No test asserts that `execCommand` is absent from the source.
- **Owner:** `src/core/text` (edits), `src/application` (commands), `src/features/editor` (bindings) · **Milestone:** 6 · **Class:** absorb
- **Replacement:** DocumentSession commands become the only write path (M3). Migrated editor features receive named operations and no writable document (M6; plan §6: "a view or selector never changes document content").
- **Acceptance:** the five suites pass on the migrated editor. A new architecture check finds no `document.execCommand` call and no `innerHTML` assignment to a `.cell-editable` under `src/features/`.

### INV-03 — Text inside a tag is never touched

- **Behaviour:** A tag is one atom. An edit applies a comment or link to all of a tag or to none of it, the caret cannot enter a tag, and find/replace never matches inside or across one.
- **Tests:** `src/test/doc-model.test.mjs` ("a comment or link covers all of a tag or none of it", "positions: an atom is one character"); `src/test/find-replace.test.mjs` ("find: never inside a tag, never across one or across a b-roll key", "replace never touches a tag…"); browser `04-prompter-find.txt`.
- **Owner:** `src/core/text` · **Milestone:** 2 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the named unit tests pass unchanged against `src/core/text`.

### INV-04 — Every top-level field survives migration and merge

- **Behaviour:** `migrateRows()` and `mergeStates()` both keep every top-level state field. A field that one of them misses is silently dropped on load or merge.
- **Tests:** `src/test/state-fields.test.mjs` (all tests), `src/test/migrate-rows.test.mjs`, `src/test/merge-states.test.mjs`.
- **Owner:** `src/core/document` · **Milestone:** 2 · **Class:** absorb
- **Replacement:** a single `STATE_FIELDS` policy, with no callbacks into UI modules, that `migrateRows` and `mergeStates` both consume (M2 gate: "a new field policy does not require duplicating merge/schema field lists"). Both functions already iterate the registry in `02-state.js`, so the `HANDOFF.md` wording is partly out of date.
- **Acceptance:** new unit test: a field added to `STATE_FIELDS` round-trips through `migrateRows`, `mergeStates` and a `.splitpage` save without edits to either function. `state-fields.test.mjs` stays.

### INV-05 — Script-only behaviour stays out of comment boxes

- **Behaviour:** Handlers shared by script cells and comment or reply boxes apply script-only behaviour (tag completion, row splitting, script shortcuts) only to script cells, which include the Writer's paragraphs. A comment box never triggers them.
- **Tests:** none found. `81-draft-edit.txt` and `10-comments-panel.txt` exercise comment boxes under the shared handlers but assert nothing about the gate.
- **Owner:** `src/features/editor`, `src/features/comments` · **Milestone:** 6 · **Class:** absorb
- **Replacement:** per-feature bindings with mount and dispose (M6). The script editor binds its handlers to its own cells and the comment composer binds its own, so no shared delegation has to check which kind of box it is in.
- **Acceptance:** browser: script-only shortcuts in a comment box (Alt+Enter, Tab on a completion) leave rows, script and registry unchanged. `81-draft-edit.txt` passes.

### INV-06 — No document-wide work per keystroke

- **Behaviour:** Typing triggers no document-wide scan. Expensive refreshes run through one debounced idle refresh (180 ms), memoised derivations are keyed on their own inputs, and the production index is derived at most once per change.
- **Tests:** browser `67-render-perf.txt` (counts renders, repaints, idle refreshes and index derivations on a 300-scene document); `src/test/production-index.test.mjs` ("the index is kept through prose edits and re-derived by any change to what it reads").
- **Owner:** `src/application` (effect scheduler) · **Milestone:** 3 · **Class:** absorb
- **Replacement:** an application effect scheduler coalesces autosave, draft capture, history and expensive derivations (M3). Cached derivations use precise changed inputs (M6).
- **Acceptance:** `67-render-perf.txt` passes. Application test with a fake clock: a burst of typing change sets inside the debounce window runs each derivation once.

### INV-07 — A single-row change repaints one row

- **Behaviour:** A change confined to one row repaints only that row's changed parts and never a field whose text is unchanged. The rest of the document keeps its DOM nodes, focus and caret.
- **Tests:** browser `67-render-perf.txt` (typing repaints no row; a structural edit elsewhere keeps the focused cell and untouched fields as the same nodes). No test targets `cycleRowStatus()`.
- **Owner:** `src/features/rows` · **Milestone:** 6 · **Class:** absorb
- **Replacement:** views consume precise change sets (M3), and the rows view repaints only the rows and fields a change set names (M6).
- **Acceptance:** `67-render-perf.txt` passes. Browser: a status click repaints only its own row, measured by the `__renderTest` counters or their successor.

### INV-08 — CSS attribute selector values are escaped

- **Behaviour:** Every value placed in a CSS attribute selector is escaped with `cssAttr()`, so quotes, backslashes or control characters in an id or name cannot break or redirect the selector.
- **Tests:** none found for `cssAttr`. `src/test/migrate-rows.test.mjs` ("rows: an id that could escape a selector is replaced") covers row ids at ingestion only.
- **Owner:** presentation utility used across `src/features/` (now in `04-richtext.js`) · **Milestone:** 6 · **Class:** keep
- **Replacement:** —
- **Acceptance:** new unit test: for values containing `"`, `'`, `\`, a newline and `]`, `cssAttr` produces a selector that matches exactly the element holding that value.

### INV-09 — Markdown table cells are escaped

- **Behaviour:** Text written into a Markdown table cell goes through `mdCell()`, so a `|` or a line break in the text cannot split the row.
- **Tests:** `src/test/formats.test.mjs` (".md round-trips the whole document…", whose fixture has a `|` in a cell; "a saved .md project is byte for byte what it was before the exports changed", with pipes and line breaks); `src/test/markdown-table.test.mjs` ("an escaped pipe stays inside its cell", reader side).
- **Owner:** `src/adapters/formats` · **Milestone:** 5 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the named tests pass against the Markdown codec in the format registry.

### INV-10 — Content enters a script cell only in canonical, sanitised form

- **Behaviour:** Content reaches a script cell only through `fromHtml()` or a model edit, both of which produce canonical, sanitised cells. `syncFieldFromDom()` stores each keystroke that way. Anything else rebuilt from HTML, such as a comment body, passes `sanitizeHtml()` before it re-enters state.
- **Tests:** `src/test/doc-model.test.mjs` ("toHtml writes the sanitiser's own markup: a fixed point of sanitizeHtml", "round trip: fromHtml(toHtml(c)) is normalizeCell(c)"); `src/test/clipboard.test.mjs` ("a paste is sanitised, keeps formatting and tags, and drops pictures and video cards"); `src/test/migrate-rows.test.mjs` ("comments: bodies and replies are sanitised, authors are plain text"); `tests/adapters/richtext/golden.test.ts` ("INV-10: the sanitiser's output is its own fixed point over the corpus", "toHtml(decode(x)) is already in stored form over the corpus", through the adapter on jsdom's parser with no DOM globals); browser `52-csp.txt`.
- **Owner:** `src/adapters/richtext` · **Milestone:** 2 · **Class:** absorb
- **Replacement:** the HTML adapter in `src/adapters/richtext/` becomes the only decoder from HTML to cells (M2), and DocumentSession commands accept normalised runs, not HTML (M3).
- **Acceptance:** HTML adapter tests on a real parser (M2 gate) show every decoded cell is a fixed point of the sanitiser. A dependency check finds no module outside `src/adapters/richtext/` that builds cells from HTML.

### INV-11 — Controls in a tag card head take precedence over expand

- **Behaviour:** Clicking a control inside a breakdown card's head (status cycle, rename and others) runs that control's action and does not toggle the card's expansion.
- **Tests:** partial. `12-gear.txt` clicks the status-cycle control and checks that the status changed, but does not assert that the card stayed collapsed. Nothing asserts the order of checks.
- **Owner:** `src/features/production` · **Milestone:** 6 · **Class:** keep
- **Replacement:** — (M6 preserves "priority among tag controls, modifier clicks, selection completion and drag types").
- **Acceptance:** browser: in both the production and gear panels, clicking each control in a collapsed card's head runs its action and leaves `.is-expanded` unchanged.

### INV-12 — A modifier-click on a breakdown card outranks its controls

- **Behaviour:** A Ctrl, Cmd or Shift click anywhere on a breakdown card, including on a control inside it, selects the card for bulk actions instead of running the control. In review mode it opens the card instead.
- **Tests:** browser `02-production.txt` (Ctrl-click selects cards), `89-production-review-mode.txt` (review mode: a modifier-click opens the card and selects nothing). No test covers a modifier-click on a control inside a card.
- **Owner:** `src/features/production` · **Milestone:** 6 · **Class:** keep
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
- **Tests:** `src/test/palette.test.mjs` (all tests), `src/test/export-colours.test.mjs`; browser `217-tag-icons.txt`, `217b-tag-icons-boot.txt`, `145-export-colours.txt`.
- **Owner:** `src/core/production` (category definitions, now in `07-production-tags.js`), with tokens in feature styles · **Milestone:** 2 · **Class:** keep
- **Replacement:** — (`TAG_PRINT_COLORS` stays a deliberate second copy, held to `:root` by `palette.test.mjs`).
- **Acceptance:** `palette.test.mjs` passes, reading the token files produced when CSS is split (M6).

### INV-15 — The Writer never re-parses the document into rows

- **Behaviour:** The Writer edits rows in place: one paragraph is one row's `audioText`. The row list changes only by a split (`splitWriterRow()`) or a join (`mergeWriterRows()`), and the Writer's DOM is rebuilt only through `renderWriter()`.
- **Tests:** browser `06-writer.txt`, `78-split-join-model.txt`, `267-writer-undo.txt`.
- **Owner:** `src/features/writer` · **Milestone:** 6 · **Class:** absorb
- **Replacement:** the Writer reads row selectors and issues split and join commands (the M3 command set, migrated in M6). It holds no writable document it could rebuild.
- **Acceptance:** the three suites pass. The dependency gate rejects any import of a project or HTML row parser from `src/features/writer`.

### INV-16 — Full-screen views close the side panels

- **Behaviour:** Present, the Writer, Help, the tour, the setup wizard and the full-page shot list close every open side panel through one path, which clears `body.panel-open` and `#root`'s padding. Leaving these views reopens no panel, except that the shot list reopens B-roll if it was opened from there. The z-index order is: side panels 140, Writer and Present 145, modals 150, toasts 200.
- **Tests:** browser `128-side-panels-modes.txt` (every panel against both modes), `150-mode-transitions.txt` (z-index 145), `96-broll-page.txt`, `61-transitions.txt`.
- **Owner:** `src/features/overlays` · **Milestone:** 6 · **Class:** absorb
- **Replacement:** an overlay and focus owner (M6) that preserves panel closure and restoration and the stacking order. A new full-screen view or side panel registers with it.
- **Acceptance:** `128-side-panels-modes.txt` passes. Every full-screen view closes a newly registered panel without edits to those views.

### INV-17 — A hint about the document never edits it

- **Behaviour:** The untagged-mention highlight, the tour and the tutorial only paint the page (for example with `CSS.highlights`). Until the user accepts an offer they wrap no span, leave the document clean and add no undo entry.
- **Tests:** browser `07-untagged.txt` ("no wrapped span, no dirty flag"); `13-onboarding.txt` and `15-tutorial.txt` (both cite "invariant #17" and compare `#rows` byte for byte).
- **Owner:** `src/features/untagged` and the tour and onboarding features · **Milestone:** 6 · **Class:** absorb
- **Replacement:** views and selectors receive read-only snapshots and named operations (M3; plan §6: "a view or selector never changes document content"). Accepting a hint is a command.
- **Acceptance:** application test: running the untagged scan and the tour against a session leaves the edit generation, dirty state and undo stack unchanged. The three suites pass.

### INV-18 — A comment is anchored by its mark

- **Behaviour:** A comment is anchored by its `cmt` mark in the script. Every path that moves words between rows (split, join, cut then paste) moves them as runs, then calls `syncCommentAnchors(state)` in the same undo entry, which points each comment at the first cell holding its mark. A comment whose words are gone keeps its last position. `migrateRows()` runs the same pass on every load and merge.
- **Tests:** `src/test/comment-anchors.test.mjs`; browser `78-split-join-model.txt`, `77-clipboard-model.txt`, `20-comment-drift.txt`, `246-scene-delete-comments.txt`.
- **Owner:** `src/application` (transaction), with `syncCommentAnchors` in `src/core/text` · **Milestone:** 3 · **Class:** absorb
- **Replacement:** every accepted DocumentSession transaction reconciles dependent anchors (M3; plan §6: "every accepted user transaction includes its dependent anchor/record reconciliation").
- **Acceptance:** application test: split, join and cut-then-paste commands that do not call `syncCommentAnchors` themselves still leave every anchored comment's `rowId` and `field` equal to what reconciliation computes, in one undo entry. `comment-anchors.test.mjs` stays.

### INV-19 — A full-screen overlay owns focus and stacking

- **Behaviour:** While the Writer or Present is open, focus cannot leave it except to modals and toasts. Anything meant to show above it, such as `.tag-ghost-hint` at z-index 146, does.
- **Tests:** partial. Browser `150-mode-transitions.txt` (z-index 145; a Writer that is fading out holds no focus). No test covers the `focusin` trap or the stacking of `.tag-ghost-hint`.
- **Owner:** `src/features/overlays` · **Milestone:** 6 · **Class:** absorb
- **Replacement:** the overlay and focus owner (M6). Escape and Tab handling, focus containment and stacking are set when an overlay registers, not by per-view CSS and listeners.
- **Acceptance:** browser: with the Writer open, Tab and focus moved programmatically to `#rows` both stay inside the Writer, while a modal and a toast stay reachable. The completion ghost draws above the Writer.

### INV-20 — Two Save buttons, one save state

- **Behaviour:** The header Save and the Writer's Save always show the same label, dirty mark and disabled state, taken from one save state (`setSaveButtons()`, `mirrorFileChipToWriter()`).
- **Tests:** browser `06-writer.txt` ("you can save from in here": `#wr-save` label and dirty mark); `285-save-buttons-one-state.txt` (the acceptance below: after an edit, during a save, after a failed save and after one that went through, both buttons show the same text, dirty mark and disabled state, and neither button, the native menu nor Ctrl+S starts a second save while one runs; passes against 4.0-development 47c0309 too); `283-save-status-by-destination.txt` (what the header says for each destination).
- **Owner:** `src/application` (save status), `src/features/writer` · **Milestone:** 4 · **Class:** absorb
- **Replacement:** one Save action in the action registry (M1, done: both buttons, Ctrl+S, the command menu and the native menu invoke `save`; `docs/architecture/actions.md`), plus one destination-specific save-status selector from the save coordinator (M4) that every Save control renders.
- **Acceptance:** browser: during a save, after a failed save and after an edit, both Save buttons show the same text, dirty mark and disabled state. `06-writer.txt` passes.

### INV-21 — One place splits a field

- **Behaviour:** Enter in the Writer and Alt+Enter in the split view split a field through the same core (`splitRowFieldCore()`) with identical results. The selection is deleted first, both halves are written with `toHtml`, comments are re-pointed, and the whole split is one undo entry.
- **Tests:** browser `09-alt-enter-and-scroll.txt`, `06-writer.txt`, `78-split-join-model.txt`; `src/test/doc-model.test.mjs` ("split and join are inverses…"); `src/test/comment-anchors.test.mjs` ("a split through a commented phrase marks both halves…").
- **Owner:** `src/application` (split command) over `splitCell` in `src/core/text` · **Milestone:** 6 · **Class:** absorb
- **Replacement:** one split-field command in DocumentSession, invoked by both the Writer and split-view bindings (M6 editing migration).
- **Acceptance:** application test: for a given cell and caret, the split command gives the same state and undo entry whether invoked from the Writer or from the split view. The three suites pass.

### INV-22 — Scroll to the caret, not the cell

- **Behaviour:** To keep the caret in view, the app scrolls to the caret's own rectangle within the nearest scrolling ancestor, so the caret never ends up off-screen in a cell taller than the viewport.
- **Tests:** browser `09-alt-enter-and-scroll.txt` (in a tall cell, the caret's rectangle is inside the viewport).
- **Owner:** `src/features/editor` · **Milestone:** 6 · **Class:** keep
- **Replacement:** —
- **Acceptance:** `09-alt-enter-and-scroll.txt` passes on the migrated editor.

### INV-23 — Ending a selection never fires a click action

- **Behaviour:** A click that finishes a text selection inside a comment card does not also jump to the anchored text. The card acts only when the selection is collapsed.
- **Tests:** browser `10-comments-panel.txt` ("finishing a text selection inside the card must NOT also fire a jump").
- **Owner:** `src/features/comments` · **Milestone:** 6 · **Class:** keep
- **Replacement:** — (M6 preserves the priority of selection completion).
- **Acceptance:** `10-comments-panel.txt` passes once comment-card bindings move to the comments feature.

### INV-24 — Export comment order ignores the panel's sort

- **Behaviour:** Exports always order comments by `commentPositionCompare()`: row, then Visual before Audio, then post time. The panel's sort mode is a reader preference kept in `localStorage`, not document data, and never changes an export.
- **Tests:** partial. Browser `11-comments-sort-persist.txt` (the sort is a reader preference). No test checks export order under a non-default panel sort.
- **Owner:** `src/core/document` (comment read model), consumed by `src/adapters/formats` · **Milestone:** 5 · **Class:** absorb
- **Replacement:** one frozen `ExportDocument` projection built from the session and the export options. Writers cannot read live UI state such as the panel's sort (M5).
- **Acceptance:** unit test: the `ExportDocument`'s comment order is the same with the panel sort set to `position` and to `recent`, and it matches `commentPositionCompare`.

### INV-25 — Tag cards have one event path

- **Behaviour:** Every panel showing `tagEntityHtml()` cards gets their behaviour from one wiring (`wireTagEntityContainer()`). No panel adds its own handlers for these cards.
- **Tests:** browser `12-gear.txt` (the Gear panel's cards work through the shared wiring), `89-production-review-mode.txt`.
- **Owner:** `src/features/production` · **Milestone:** 6 · **Class:** absorb
- **Replacement:** the tag-card view owns its bindings through mount and dispose (M6). A new panel mounts the card list instead of wiring events.
- **Acceptance:** remount/dispose test: mounting the card list in a third container gives one handler set per container, and none remain after dispose.

### INV-26 — Quick-add forgets only what it added

- **Behaviour:** A quick-add box that tracks items whether or not the script mentions them adds a registry entry for each new line. When a line is removed, it deletes that entry only if the item is orphaned; an item still tagged in the script stays.
- **Tests:** `tests/core/production/tags.test.ts` ("INV-26: the quick-add plan deletes an orphaned entry whose line went and keeps one still tagged in the script"); `tests/core/production/golden.test.ts` (the Gear quick add against `production-gear-quick-add`); browser `12-gear.txt` ("removing a line un-tracks it, UNLESS it's still tagged live").
- **Owner:** `src/core/production` (reconciliation plan, `planQuickAdd`), `src/features/production` · **Milestone:** 2 · **Class:** keep
- **Replacement:** —
- **Acceptance:** new unit test: for a removed line, the quick-add reconciliation plan deletes an orphaned entry and keeps a live-tagged one. `12-gear.txt` passes.

### INV-27 — A `jsclick` "corrupted registry" symptom is not proof

- **Behaviour:** When a `jsclick`-driven browser test seems to show a corrupted registry, check `document.activeElement` first. `jsclick` does not blur the focused cell, and that cell's late blur can sync stale content back.
- **Tests:** not applicable.
- **Owner:** practice · **Milestone:** — · **Class:** practice
- **Replacement:** `.claude/skills/run-splitpage-app/SKILL.md` ("`jsclick` doesn't blur what `caret`/`press` focused") and `HANDOFF.md` §2, "The test harness lies to you".
- **Acceptance:** —

### INV-28 — Native entry points take the least they need

- **Behaviour:** No HTTP endpoint spawns a process or installs files, and `server/server.js` does not load `node:child_process`. Under `/api/launcher/` there is only `info`, behind the launch-token gate; a request without the token gets 404. Desktop channels take no argument or only typed ids and shas. These cover updates, opening the prompter in a browser, Google Drive, blobs, history, voice and video thumbnails. Main builds every URL, path and command itself, and no answer carries a path or a token.
- **Tests:** partial.
  - `tools/test-server.mjs`: "launcher/info without the launch header is 404"; the staging and register routes answer 404.
  - `desktop/test/ipc-table.test.mjs`: "checkArgs refuses the shapes…", plus one argument test per channel.
  - `desktop/test/prompter-share.test.mjs` and `desktop/test/google-drive.test.mjs`.
  - `desktop/test/blob-store.test.mjs`: "a sha that is not 64 lowercase hex is refused everywhere…".
  - `desktop/test/smoke.mjs`: "no answer names a path (invariant #28)".

  No test checks that `server/server.js` never loads `child_process`.
- **Owner:** `server/`, `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** — (plan §8 keeps a single IPC contract source).
- **Acceptance:** the existing checks pass after server and desktop extraction. A new check in `tools/test-server.mjs` confirms the server's module graph never loads `node:child_process`.

### INV-29 — Connection secrets never persist in shared places

- **Behaviour:** The join PIN, session token and launch token never enter `update-status.json`, the document or any file the static handler serves. Connection details are browser state, never `state`. On desktop, a server tab persists only `{kind, serverDocId, serverUrl, tunnel}`, and a token is held only in main's memory until the new tab boots.
- **Tests:** partial.
  - `desktop/test/smoke.mjs`: "no token and no PIN in desktop-state.json after the quit (invariant #29)"; "draft: no PIN, token or launch URL ever reaches disk".
  - `src/test/connection.test.mjs`: "a tunnel is host and ports, and nothing that could carry a secret".
  - `src/test/browser-drafts.test.mjs`: "nothing credential-shaped is added on the way in".

  No test covers `update-status.json` or statically served files.
- **Owner:** `src/application` (the session keeps credentials out of serialised content), `server/`, `desktop/` · **Milestone:** 4 · **Class:** keep
- **Replacement:** — (plan §6: credentials never enter project exports or recovery metadata).
- **Acceptance:** application test: serialising a session with a live server connection yields no token, PIN or key. New server test: after a join, no file under the static root contains the PIN or token.

### INV-30 — The setup wizard appears only over a pristine copy

- **Behaviour:** The first-run wizard appears only when the build's seed-check meta passes, `splitpage-onboarding` is unset and no document is loading. File ▸ "Set up Splitpage…" opens it on purpose.
- **Tests:** browser `13-onboarding.txt` (cites "invariant #30").
- **Owner:** `src/bootstrap` · **Milestone:** 7 · **Class:** keep
- **Replacement:** —
- **Acceptance:** `13-onboarding.txt` passes with the new composition root. Bootstrap test: when a document arrives by file, link or restore, the wizard is never constructed.

### INV-31 — A `.splitpage` file is the migrated state, pictures inline

- **Behaviour:** A `.splitpage` file is exactly `inlineBlobs(migrateRows(state))`: every picture's bytes are inline, with no envelope and no renamed or added fields. A reader gets image refs back through `migrateRows()`.
- **Tests:** `src/test/formats.test.mjs` (".splitpage has no envelope…", ".splitpage round-trips the whole document, byte for byte", "buildSplitpage never writes an unmigrated document", ".splitpage carries its pictures inline…"); `src/test/state-fields.test.mjs` ("a .splitpage save carries every registry field").
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

- **Behaviour:** Desktop file operations address files by opaque ids from main's registry. Any bridge method that works on a file takes an id, never a path.
- **Tests:** `desktop/test/smoke.mjs` ("main writes filePath:null for the unregistered fileId (invariant #34)", "draft: forged fileId with no registered path opens as an untitled copy"); `desktop/test/ipc-table.test.mjs`; browser `21-desktop-shim.txt`.
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** — (plan §8 keeps opaque file ids).
- **Acceptance:** the checks pass after the desktop file service is extracted, and `ipc-table.test.mjs` refuses a path-shaped argument on every file channel.

### INV-35 — Every document has a valid id, and the seed has none

- **Behaviour:** Every loaded document carries a `state.docId` matching `/^d[0-9a-f]{32}$/`. The seed, `#state-data` and the Standalone HTML export carry none. `SCHEMA_VERSION` was not bumped for it. A missing or invalid id is treated as unique, never as shared.
- **Tests:** `src/test/doc-id.test.mjs` ("normalizeDocId treats anything but the canonical shape as absent", "a hostile or missing id is re-minted…"); `src/test/doc-id-policy.test.mjs`; `src/test/starters.test.mjs` ("…has no missing STATE_FIELDS and no docId"); browser `22-doc-id.txt` (`#state-data` carries no `docId`).
- **Owner:** `src/core/document` (`shared/doc-id-policy.js` stays shared) · **Milestone:** 2 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the named tests pass against `src/core/document`.

### INV-36 — The id follows the Save target

- **Behaviour:** A document forks to a new id only on Save As, on publishing an id that has already been written out, or on detached draft recovery. History copies only after the write succeeds. Restoring a snapshot keeps the id. Whether a document is already open is decided by path or server document id, never by `docId`.
- **Tests:** browser `22-doc-id.txt` ("a Save As whose write fails does not retarget Save (invariant #36)"), `24-history.txt` ("restore records its backup first and keeps the docId"); `src/test/publish-in-flight.test.mjs` ("#247: the fork's new id is not put on the document that replaced this one"); `src/test/doc-id-policy.test.mjs` (`chooseDuplicateLoser`); `desktop/test/smoke.mjs` ("routing: pristine reuse, dirty->new tab, path dedupe…").
- **Owner:** `src/application` (session transitions) · **Milestone:** 4 · **Class:** absorb
- **Replacement:** one transition API for adopting open, new, restore and publish (M4), which is the only writer of `docId`. History copies run when the save coordinator confirms completion. This matches plan §6: identity, epoch and generations have different meanings.
- **Acceptance:** application race tests:
  - Save As, publish and detached recovery fork the id; open, restore and a same-id reopen do not.
  - A failed or cancelled Save As leaves both the id and the destination unchanged.
  - No history copy happens before the write is confirmed.

### INV-37 — `sha256Hex` and `deriveDocId` are frozen

- **Behaviour:** `sha256Hex`, `deriveDocId` and the duplicate-replacement id derived from them always give the same output. Any change would re-identify legacy files and split their history.
- **Tests:** `src/test/doc-id.test.mjs` ("SHA-256 vectors (FROZEN, HANDOFF invariant #37)", "deriveDocId is the frozen, domain-separated wrapper"); `src/test/doc-id-policy.test.mjs` ("the derived replacement id is FROZEN (invariant #37)"); `tests/core/document/ids.test.ts` ("the frozen SHA-256 vectors hold for strings and bytes", "deriveDocId is the frozen, domain-separated id").
- **Owner:** `src/core/document`, `shared/` · **Milestone:** 2 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the golden vectors pass unchanged after the move and are never regenerated.

### INV-38 — History is addressed only by `(docId, snapshot id)`

- **Behaviour:** Renderer and main address version history only by a validated `(docId, snapshot id)`, and every resolved path stays inside the history folder. The Older bucket is reachable only through `{older: true}`. The shared store itself refuses a `docId` alongside that flag, and refuses `"_older"` as a `docId`.
- **Tests:** `src/test/history-store.test.mjs` ("put refuses what can never succeed with 'invalid', and the Older bucket by name", "get validates both halves of the address…"); `src/test/history-policy.test.mjs` ("HISTORY_SNAP_ID_RE: what may become a file name on disk"); `desktop/test/ipc-table.test.mjs` ("version history is exactly six app-only invoke channels"); `desktop/test/smoke.mjs` ("history: id validation — nothing outside history/…"); browser `27-app-data.txt` (case 10, bad docIds).
- **Owner:** `shared/` (`history-store.js`), `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** —
- **Acceptance:** the checks pass after desktop IPC composition is extracted.

### INV-39 — Snapshots are captured synchronously; saves never wait on history

- **Behaviour:** `pushSnapshot()` captures the document at the moment it is called, and no save waits for history. A restore overwrites the document only after its "Before restoring" backup is stored, or after a second, explicit confirmation.
- **Tests:** partial. Browser `24-history.txt` (the "Before restoring" backup comes before the restore). No test covers synchronous capture or saves not waiting on history.
- **Owner:** `src/application` (effect scheduler, save coordinator) · **Milestone:** 4 · **Class:** keep
- **Replacement:** —
- **Acceptance:** application test with a history port that never resolves: a save still completes, and a later edit does not change the captured snapshot. If the backup is refused, the restore does not overwrite without the second confirmation.

### INV-40 — A crash draft is removed only when clean or by the user

- **Behaviour:**
  - **Desktop:** a crash draft is deleted only when its tab becomes clean, or on an explicit user decision. It is never deleted on a crash, kill, renderer loss, session end, quit or restore. A discard writes a tombstone before anything is unlinked.
  - **Browser:** a draft is removed only by the page that wrote it, or took it over, once that page is clean or has moved to another server document. The store's bounds still apply (30 days, 20 drafts, 64 MiB).
  - **Both:** a lost link or lapsed sign-in stops saves, not the draft writer, and a restore never saves.
- **Tests:**
  - `desktop/test/drafts.test.mjs`: "discardForUserDecision during a delayed write…", "session states, take never deletes…".
  - `src/test/browser-drafts.test.mjs`: "remove takes only the writer's own draft; claim hands it over", plus the eviction tests.
  - `desktop/test/smoke.mjs`: the draft crash-recovery cases.
  - Browser suites `26-desktop-drafts.txt` and `265-browser-drafts.txt`.
- **Owner:** `src/application` (recovery writer ownership), `desktop/` · **Milestone:** 4 · **Class:** keep
- **Replacement:** — (plan §6: recovery preserves source work through failed adoption, writer conflict or revoked access).
- **Acceptance:** the M4 gate's recovery tests pass (multi-tab ownership, revoked links, restart), and a writer discards only the draft generation acknowledged to it.

### INV-41 — Restoring a draft never writes the user's file

- **Behaviour:** Restoring a draft never writes the user's file by itself. Whether a file is unchanged on disk is decided by content, never by mtime. Only main builds the draft header, from allowlisted scalar fields. Draft bodies are written with fsync and kept in two generations.
- **Tests:** `desktop/test/smoke.mjs` ("the file on disk is untouched by the restore (invariant #41)", "the merge does NOT autosave (invariant #41…)", "draft: power-cut mid-write keeps the FIRST generation…"); `desktop/test/drafts.test.mjs` ("a torn write keeps the previous generation…", "a checksum mismatch falls back to previous…"); browser `26-desktop-drafts.txt`.
- **Owner:** `src/application` (restore and adoption policy), `desktop/` · **Milestone:** 4 · **Class:** keep
- **Replacement:** — (plan §6: restoration does not silently save a user file).
- **Acceptance:** application test: adopting a restored draft leaves the destination's confirmed generation and baseline unchanged and schedules no save.

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
- **Tests:** partial. `desktop/test/smoke.mjs` ("window close: 2 dirty tabs + another window open (one dialog)", "quit: dirty tabs in two windows (one answer per attempt)", "--host: stop-sharing prompt fires once at quit…"). `desktop/test/drafts.test.mjs` only records the `session-end` state. No test checks that a session end asks nothing, or that writes go through a single queue.
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** —
- **Acceptance:** the smoke cases pass. New desktop test: a simulated session end with dirty tabs shows no dialog and leaves every draft in place.

### INV-45 — The voice listener starts and stops only for its own tab

- **Behaviour:** The page can ask the voice listener only to start, stop or report status, and only for itself; these channels take no argument. Main alone builds the command line (Windows `powershell.exe` running `voice/listen.ps1`, which reads only stdin). Under `SPLITPAGE_TEST=1` only the named fake helper runs.
- **Tests:** `desktop/test/ipc-table.test.mjs` ("Follow My Voice takes no argument, from the app page only"); `desktop/test/voice-helper.test.mjs` ("only the owning tab can stop a session", "no command means unavailable, and start refuses"); `desktop/test/smoke.mjs` (runs with `SPLITPAGE_TEST_VOICE_HELPER`); browser `72-desktop-voice.txt`.
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** —
- **Acceptance:** the checks pass after voice is extracted as a desktop service.

### INV-46 — Listener output is rebuilt before the page sees it

- **Behaviour:** `parseHelperLine` keeps only known message types. It keeps a capped `text`, a short `code`, a culture name, or a capped microphone `name` without control characters, and drops everything else. Main sends the result only to the owning tab. The page uses `text` as words to match and `name` as status text, never as markup.
- **Tests:** `desktop/test/voice-helper.test.mjs` ("parseHelperLine keeps the known shapes…", "parseHelperLine drops anything else", "…a microphone's name as plain, capped text (#118)", "junk from the helper never reaches the page"); browser `83-voice-mic-name.txt`.
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** —
- **Acceptance:** the named tests pass unchanged.

### INV-47 — One listener, which never outlives its tab or the app

- **Behaviour:** Only one voice session runs at a time. When a second tab starts, it takes the microphone over and the first tab is told (`end`, reason `taken`). Closing the tab or quitting ends the session. The helper exits when its stdin closes, so even a main-process crash stops it listening.
- **Tests:** `desktop/test/voice-helper.test.mjs` ("a second tab takes the microphone over; the first is told", "a tab closing ends its session without an event", "a helper that ignores its stdin closing is killed").
- **Owner:** `desktop/` · **Milestone:** 4.x · **Class:** keep
- **Replacement:** — (plan §6: closing an owner releases its resources).
- **Acceptance:** the named tests pass, and a real-Electron smoke run shows no listener process after the tab closes.

### INV-48 — The app-data bundle carries no credentials

- **Behaviour:** Before any byte of an app-data export is written, the bundle is checked for keys matching `/token|api[-_]?key|client[-_]?id|secret|password|\bpin\b/i`, and it must contain none. An import carrying such a key is refused. Image bytes count toward the 200 MB export cap. Images whose bytes could not be read are listed in `missingBlobs`, and the export warns about them.
- **Tests:** browser `27-app-data.txt` (case 2, the "invariant #48" key walk; case 7, a bundle carrying `apiKey`; cases 14, 15 and 19); `34-desktop-app-data-export.txt`.
- **Owner:** app-data bundle codec under `src/adapters/` (now `20h-appdata.js`) · **Milestone:** 6 · **Class:** keep
- **Replacement:** —
- **Acceptance:** both suites pass. New unit test: the codec refuses to write, and refuses to import, a bundle with a credential-shaped key at any depth.

### INV-49 — App-data import only adds

- **Behaviour:** Import writes through the history store's public write path and never deletes. Existing preferences are never overwritten, and bookmarks are merged by URL with the local entry winning. Each image is verified and stored durably before the first snapshot that names it. A bad image is dropped and reported, and its snapshots still import. A bundle without `blobs` imports exactly as before.
- **Tests:** browser `27-app-data.txt` (cases 4–6: idempotence, preferences, bookmarks; cases 16–18: images first, a tampered image, an old bundle).
- **Owner:** app-data bundle codec under `src/adapters/` · **Milestone:** 6 · **Class:** keep
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
  - **Where:** autosave writes only to a file handle the user picked, or to the server. It never opens a picker and never downloads.
  - **When:** only while the preference is on. Typing and discrete actions both check the preference first.
  - **Halting:** when unreviewed work comes on screen (a crash-draft restore's merge, a `noAutoSave` merge), autosave stops until an explicit Save. A failed or conflicted automatic save stops it too.
- **Tests:**
  - Browser `28-autosave.txt`: "off means off", "a file that changed on disk stops autosave…", "a manual Save…".
  - Browser `42-local-merge.txt` (halt after a merge; cites invariant #51) and `185-autosave-every-edit.txt`.
  - `src/test/home.test.mjs`: "autoSaveTarget answers server, file or null off the home".
  - `desktop/test/smoke.mjs`: "the merge does NOT autosave…".
- **Owner:** `src/application` (save coordinator) · **Milestone:** 4 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the suites pass. Application test with a fake clock: after a recovery adoption or a `noAutoSave` merge, no automatic write is scheduled until an explicit Save; with autosave off, none is scheduled at all.

### INV-52 — No durable record names a blob its store lacks

- **Behaviour:** An image is uploaded and made durable before any record naming its sha is written, and `refsIn()` is always the list of what a record names.
  - **Server:** it refuses a document or comment that names missing blobs (422 `missing-blobs`). `acceptMissing` lets a document name a sha known to be lost for good; comments cannot use it. A pre-#82 client cannot save over a document that names blobs (426).
  - **Client:** it uploads first. History, drafts and app-data import await `persist()` before they write.
- **Tests:** `tools/test-server.mjs` (`missing-blobs`, `acceptMissing`, `client-too-old`); `src/test/blob-store.test.mjs` ("persist resolves only once the backend has stored the bytes"); `src/test/blob-policy.test.mjs` (`refsIn`); browser `65-blobs.txt`, `66-hosted-blobs.txt`, `26-desktop-drafts.txt`, `27-app-data.txt` (case 16).
- **Owner:** `src/application` (save coordinator: blob transfer before the write), `server/` · **Milestone:** 4 · **Class:** keep
- **Replacement:** — (M4: one transport instance owns both the blob transfer and the write that follows).
- **Acceptance:** M4 race matrix: when a blob upload fails or is cancelled, no record is written. The server checks are unchanged.

### INV-53 — Every edit is recorded once; nothing else is recorded

- **Behaviour:** Every edit to the document ends in `markDirty()`, and undo learns of the edit by diffing. Changes that are not the user's edits are registered as such and never become undo steps: a new document, someone else's merge, a reload in place, or the repair made by an undo's own repaint. On a server document, changes to comments are never recorded.
- **Tests:** `src/test/undo.test.mjs` ("diffStates: the lists and comments are one step each; bookkeeping is never a step", "forget (design D4)…"); `src/test/apply-merge.test.mjs` ("nothing differed: no merge, no snapshot, no rev bump"); browser `73-undo.txt`, `76-tags-model.txt` (`settleAfterApply`), `185-autosave-every-edit.txt`, `186-autosave-panel-edits.txt`.
- **Owner:** `src/application` (DocumentSession) · **Milestone:** 3 · **Class:** absorb
- **Replacement:** DocumentSession transactions (M3; plan §6):
  - an accepted change advances the edit generation once and is recorded under the existing undo grouping;
  - a no-op or rejected command has no effects;
  - user edits, server updates and recovery adoption are distinct transaction kinds.
- **Acceptance:** application tests:
  - A user command advances the generation once and adds one undo entry.
  - A merge, a reload or a recovery adoption adds none.
  - A no-op command does not dirty the document, schedule a save or add an entry.

### INV-54 — A b-roll key's id belongs to one line

- **Behaviour:** No two b-roll keys in a document share an id.
  - **Brought in from outside:** a pasted or dropped key gets a new id whenever the document already knows its id. The exception is a cut then paste in the same tab, which moves the key.
  - **Moved:** a split, join or cut keeps the key's id and never copies it.
  - **Backstop:** the anchoring pass re-keys any duplicate that still gets through.
- **Tests:** `src/test/clipboard.test.mjs` ("freshBrollIds: a key keeps its id only when nothing has it, and never twice in one paste", "brollIdsTaken…"); `src/test/broll-model.test.mjs` ("anchoring: a key repeating an id an earlier line holds gets an id of its own…", "a pasted key's record is a new shot seeded from its scene…"); `tests/core/production/broll.test.ts` ("INV-54: anchoring gives a key repeating an earlier line's id an id of its own…", "a line never takes a shot a keyed line further down holds…"); browser `80-broll-paste-ids.txt`, `47-move-scene-keys.txt`, `45-broll-anchoring.txt`.
- **Owner:** `src/core/production` · **Milestone:** 2 · **Class:** keep
- **Replacement:** —
- **Acceptance:** the named tests pass against `src/core/production` and the migrated clipboard path.

### INV-55 — A comment or reply draft owns its undo

- **Behaviour:** Edits in a comment or reply box go through the model (`editDraft`). In that box, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, `historyUndo` and `historyRedo` are always answered from the box's own history, never the browser's or the document's. Pictures and video cards in a draft survive every edit.
- **Tests:** `src/test/draft-edit.test.mjs`; browser `81-draft-edit.txt`.
- **Owner:** `src/features/comments` · **Milestone:** 6 · **Class:** keep
- **Replacement:** — (M3 keeps comment and reply drafts on their own undo).
- **Acceptance:** both pass after the composer moves to the comments feature.

### INV-56 — A b-roll shot stores only hand-added props, by registry id

- **Behaviour:**
  - **Stored:** a shot's `props` hold only props added by hand, as `[{id, name}]` keyed by registry id. Props tagged on the shot's own lines are read from the script each time.
  - **Renames and merges:** a rename carries through by id, and folding onto another entry's name re-points the shot in the same edit. Merging is a base-aware set per shot.
  - **Pasting:** a pasted copy of a shot's line gets no props.
  - **New fields:** a new shot field must be kept by `migrateRows` and `mergeBrollShots`, and added to both shot builders, `newBrollRecord` in `08c-broll.js` and `newBrollShot` in `src/core/production/broll.ts`, at the same place in each.
- **Tests:** `src/test/broll-model.test.mjs`; `tests/core/production/broll.test.ts` ("INV-56: …", two tests); `src/test/production-shims.test.mjs` ("a shot the core plan creates and one newBrollRecord stores serialise alike, keys in the same order"); `src/test/merge-states.test.mjs` ("b-roll props: …"); `src/test/migrate-rows.test.mjs` ("brollShots props: …"); `src/test/state-fields.test.mjs` ("a b-roll shot keeps every field it has — props too — through a merge and a save"); `src/test/formats.test.mjs` (props round trips); browser `95-broll-props.txt`.
- **Owner:** `src/core/production` · **Milestone:** 2 · **Class:** keep
- **Replacement:** — (the field-list clause can join the M2 field policy; the props rules stay explicit).
- **Acceptance:** the named tests pass. New unit test: a field added to the shot record's policy survives migration, merge and save without edits to `mergeBrollShots`.

### INV-57 — Exports state non-script facts through one kit

- **Behaviour:** Every document export takes everything it states besides the words from `14b-export-kit.js`:
  - the facts line;
  - each scene's number, start timecode, status and read time;
  - open-thread numbers;
  - each cell's tags, b-roll keys and markers;
  - the breakdown by category and the b-roll by scene.

  No format works these out for itself. The print colours are a second copy of `:root`, held to it by `palette.test.mjs`.
- **Tests:** `src/test/export-kit.test.mjs`; `src/test/palette.test.mjs` ("the exports' print palette is the light theme's :root values"); `src/test/pdf-script.test.mjs`; `src/test/export-colours.test.mjs`; `src/test/xlsx-export.test.mjs`; `src/test/markdown-table.test.mjs` (the stacked-export cases); browser `41-export-polish.txt`.
- **Owner:** `src/application` (`ExportDocument`), consumed by `src/adapters/formats` · **Milestone:** 5 · **Class:** absorb
- **Replacement:** one frozen `ExportDocument` projection, captured from the session and the options, plus a format registry whose writers read only that projection (M5).
- **Acceptance:**
  - M5 gate: a small test exporter needs only one provider and one registration.
  - Unit test: for a fixture, every registered writer's scene facts equal the `ExportDocument`'s.
  - Dependency gate: format modules import no timing, tag or thread-numbering helpers directly.

### INV-58 — Export decoration is skipped on re-import

- **Behaviour:** Anything an export prints besides the script is skipped when the file is read back, whether it was exported before or after the export changes:
  - **.docx:** the named Splitpage styles.
  - **Markdown:** the meta, facts and marker patterns and the tail headings.
  - **CSV:** its own header, a cut at its own Comments line, and empty Total and Target rows.

  The `.docx` fixtures are the old writer's output and are never regenerated.
- **Tests:** `src/test/docx-reimport.test.mjs`, with `src/test/fixtures/splitpage-3.0.0-beta.8.docx` and `src/test/fixtures/splitpage-3.0.0-beta.8-narration.docx`; `src/test/markdown-table.test.mjs` ("the new stacked export reads back as exactly its scenes, and nothing round them", "a stacked export written before #169's look still reads back as its scenes"); `src/test/text-exports.test.mjs` ("the new sheet reopens as exactly its scenes: no totals, no comments", "a sheet exported before #169's columns reopens as its scenes…"); browser `41-export-polish.txt`.
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

- **Behaviour:** The same document exported twice on the same day gives identical bytes in every format. A PDF's `/CreationDate` and a .docx's `docProps` dates carry the day, not the time. Nothing prints the time of export; comments' own timestamps are data and are allowed.
- **Tests:** browser `98-export-dialog.txt` (every format exported twice by two routes and the bytes compared); `src/test/xlsx-export.test.mjs` ("two exports of one script are the same bytes"); `src/test/list-pdfs.test.mjs` ("the packing list's file: its title for a viewer, and the same bytes built twice"); `src/test/export-kit.test.mjs` (`/CreationDate` is a date only).
- **Owner:** `src/adapters/formats` · **Milestone:** 5 · **Class:** keep
- **Replacement:** — (the `ExportDocument` captures the date from an injected clock).
- **Acceptance:** suite 98 and the unit checks pass. New unit test: two `ExportDocument`s captured at different times on the same day give identical bytes for every registered format.

### INV-61 — The PDF footer is a pagination artifact

- **Behaviour:** The PDF footer is marked `/Artifact << /Type /Pagination /Subtype /Footer >> BDC … EMC` (`pdfFooterOps`), so text extraction skips it. Tests that read content streams skip it too, because its hairline uses the same operator as a scene rule.
- **Tests:** `src/test/pdf-script.test.mjs` and `src/test/pdf-layout.test.mjs` (both skip `/Artifact … BDC` spans; "a running footer on every page, bookmarks to each part, and the title the viewer shows").
- **Owner:** `src/adapters/formats` · **Milestone:** 5 · **Class:** keep
- **Replacement:** —
- **Acceptance:** both pass. New unit test: text extracted from a PDF export contains no footer text.

### INV-62 — Collaborate credentials stay in this browser, per server

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
