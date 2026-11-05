# Writer flow: plan

Status: revised after outside review (section 8). Phases 0a to 7 are done (sections 9 to 14). Phase 8 is implemented for review against `feat/writer-flow` (section 15): the flow writer is the only writer and the switch is gone. Adam has picked every setting. The saved flag and the pure engine are on `main` with no shipping caller. The writer's merge to `main` waits for Adam to use a real script and say okay. Issues: #264, #1167, and the writer side of #1166 and #1168.

Words: a **beat** is a row. A **scene** is a group of beats under a header (saved as `sections`, anchored by `firstSceneId`). `audioText` is a beat's narration.

## 1. What we are building

The writer becomes one continuous document that types like a Google Doc. It replaces the old writer outright, with no setting and no period of keeping both.

Desktop Chromium is the target: the Electron app and Chrome. Phones get the same code with no tuning or phone-specific testing, on Adam's decision. Other browsers must not lose data, but they are not tuned either (assumption, not yet confirmed by Adam).

## 2. Decided behaviour

### Structure

- A paragraph holds one or more beats, running together as flowing text. A beat never crosses a paragraph break.
- **Enter** starts a new beat in the same paragraph, and a second **Enter** starts a paragraph there, Adam's pick on the test page. Between two beats, that second Enter leaves no empty beat behind: the text after it starts the paragraph. **Shift+Enter** is a line break inside a beat. Alt+Enter isn't needed any more, so it goes away unless Adam wants it kept.
- Existing scripts open with the sentence rule, Adam's pick on the test page: a beat starts a paragraph when the beat before it ended a sentence. Old files have no saved breaks, so the rule runs once, when such a script first opens in the new writer, and writes ordinary flags. A document-level marker records that it ran, because a new script deliberately written as one paragraph also has no flags and must not be broken up. It shares one sentence-end definition with the teleprompter. Text imports keep their source paragraph breaks.
- The teleprompter keeps its sentence rule and also starts a paragraph at every saved break. Table exports stay per beat.
- Narration export stays one paragraph per beat for now, and we circle back to it later (7.1).

### Editing

- Selecting, typing over, deleting, Ctrl+A and arrow keys all work across beats. Each edit is one Ctrl+Z.
- Deleting a selection removes beats fully inside it, with their visuals, comments and status. Partly selected beats keep their remaining text and their visuals. A notice says what went, such as "Removed 3 beats: 2 with visuals, 1 filmed".
- Bold, italic, underline, strikethrough and highlight work across beats. Comments, tags and links stay within one beat. With a selection across beats, those three buttons are disabled and say why.
- Backspace at a paragraph's start removes only the paragraph break. Backspace just after a tick deletes the previous character and leaves the boundary. The caret has a stop on each side of the gap, and text goes where the caret is, Adam's pick on the test page: just before the gap it goes in the beat before, and just after the gap it goes in the next beat.
- Beats join only through Alt+Backspace or Join on the tick. If both have visuals, the joined beat keeps both: the words with a line break between them, and the pictures in order, with a notice saying so. It takes the higher status, as a join does today. Only a scene header or the picture limit refuses a join. This replaces the refusal in `joinBeatsCommand`, so the two tests that assert the refusal change with it (`split-join-app`, `text-editing-app`).
- A selection inside one beat, even of all its text, is ordinary text editing: the beat stays, empty or with just its visual.
- A beat fully inside a deleted selection takes its comments with it, unless part of a comment's marked text survives in another beat, which can happen after a split. Deleting words inside a surviving beat treats comments as the split view does today: the comment stays at its last position.
- The writer always has somewhere to type: Ctrl+A then Delete leaves one empty beat.
- Beats display with a gap the width of a space between them, unless the text already has whitespace there. The gap's width is painted, and a run-on beat's span starts with a zero-width space so the browser sees a word break there. Neither can be typed into or deleted, and the caret stops once on each side, as it would at a real space. A selection crossing the gap copies it as one space. It isn't stored, so it costs no read time and doesn't reach exports.
- Typing a space on either side of the gap is an ordinary character in that beat, and the painted gap then steps aside.

### Cut and paste

- Whole beats keep everything: visual, comments, status, b-roll, breakdown details, pictures.
- Pasting whole beats mid-beat splits the target at the caret. The first half keeps its visual and status, and the second half is a new beat with no visual.
- Pasting between beats splits nothing. At a paragraph's start or end the block stays its own paragraph. Mid-paragraph it flows in.
- Partly selected ends become new beats with no visual, and their originals keep their visuals. With no whole beat or scene header selected, it is a plain text paste with no split.
- A selection holding a whole scene header always moves structurally, even with no whole beat in it. The header moves with it and the partly selected ends become new beats as above. At the destination, whatever follows the pasted header becomes that scene's first beat, splitting the target beat if needed. If nothing follows it, a blank beat is created, because a scene can't exist without one.
- Copy and paste duplicates, as beat copy does today.
- Pasting from outside: each paragraph becomes a new paragraph and beat.
- Dragging selected text stays off. Pasted Markdown does not convert.

### What you see

- A clean centred column of narration. Filmed beats and folded scenes always show in full, whatever their split-view setting.
- A small number marks every beat, including a paragraph's first and a visual chip, Adam's pick on the test page, and a filmed beat's number is coloured. The beat holding the caret gets a very light tint. Its visual shows as a quiet note beside the line, and clicking the note opens the floating box. The Visuals, Numbers and Compact margin button goes away.
- A beat with a visual and no narration shows as a chip in the text, Adam's pick on the test page, like `▣ Drone over the harbour · 0:04`, with the time only if one is set. It shows the writer there's a small break for a visual without being a paragraph break. Typing on it adds narration and makes it a normal beat.
- A beat with neither narration nor a visual shows a small placeholder. Once such a beat starts a paragraph, Enter on it does nothing, so repeated Enter cannot fill the script with blank beats.
- `((direction))` stays inline. `SFX:` and `Music:` cues stay on their own line and do not start a paragraph or beat.
- Switching modes keeps your place: the writer opens on the beat you were in, and closing returns you to the beat you were writing in.
- Comments stay visible and can be added, with the comments panel open beside the writer.
- Beats cannot be selected as whole beats in the writer. That stays a split-view action.

### Floating Visual box

- Caret in a beat: it edits that beat's visual.
- Part of a beat selected: typing a visual makes that text its own beat, as one undo step.
- Selection across beats: it stays closed and says why.
- Contents: text, tags and B-roll as in the split view. Existing pictures show as thumbnails, and new ones are added in the split view.
- A toolbar button opens it. A shortcut is agreed after testing.

### Headings and Markdown (writer only)

- `# ` at a paragraph's start, `**bold**`, `*italic*` when the `*` touches a word, `~~strike~~`. No link syntax, because `[` is the Prop tag shortcut. Ctrl+Z straight after gives the characters back.
- Inline marks convert when the closing mark is typed. A heading looks like one at once but only becomes final when the caret leaves its line:
  - Enter: text before the caret becomes the header, and everything after it stays as beats below.
  - Clicking or arrowing away, or closing the writer: the whole line is decided. Switching to another window decides nothing.
  - A line still holding several beats on leaving: the `# ` is removed, the line goes back to normal, and a notice says "A scene header can't hold several beats. Press Enter after the header's words." The caret stays where it was clicked.
  - Only `# ` on the line: the marker is removed.
- A converted beat with no visual goes away. One with a visual stays, empty, under the new header.
- The heading takes the beat's first line, up to any Shift+Enter. Later lines stay as narration in that beat.
- A line over the scene name limit of 200 characters is refused the same way, with its own notice and all its narration kept.
- Enter in a heading: the text after the caret becomes the scene's first beat. Enter at a heading's very start: a blank beat goes above the heading and the caret moves into it (section 7.7).
- Deleting all of a heading's text: the line stays empty while the caret is on it, so the name can be retyped. Leaving it empty removes the header (section 7.8).
- Backspace at a heading's start: the header goes away and its text becomes a new beat that flows into the paragraph above. Backspace at the start of the first beat under a header: the caret moves to the end of the header and nothing changes. Delete at the end of the last beat above a header: the caret moves to the start of the header and nothing changes.

### Find

- Ctrl+F searches narration and scene headers. A **Visuals** toggle adds visuals, starts off and lasts until the writer closes. A match in a visual opens the floating box with it highlighted.
- A phrase crossing a tick is one match, with the painted gap counting as one space. Searching for a lone space finds only real spaces, so the gap can never be replaced by itself. Replace puts the new text in the first beat and removes the rest of the match from the later one, leaving the boundary. Replace All is one Ctrl+Z.
- Esc closes Find, then the writer on a second press.

### Top bar (#1167)

- Both modes: File menu, a mode button in a fixed position, save status, script length.
- Writer only: word count, counting the selection when there is one, and the Size slider. The formatting row uses the split view's icons and gains the missing buttons. Export narration leaves the bar and sits with the other exports.
- Save becomes quiet status text. It stands out and is clickable for an unsaved new script, Autosave off, or a save problem. Ctrl+S keeps working.

### Left for later

Narration export following the writer's paragraphs, bullets and the Outline view (scenes as bullets, beats as sub-bullets), dragging selected text, pasted Markdown converting, a Visual box shortcut. Split-view restyling of headers (#1166, #1168) and scene descriptions (#1171) stay separate.

### To judge on the test page

All picked: the sentence rule for existing scripts, the chip for a visual with no narration, a number on every beat, typing going where the caret is, Enter for a new beat with a second Enter for a paragraph, and Backspace at a tick deleting a character while Alt+Backspace joins.

## 3. How it fits the code today

- `src/features/writer/writer.ts` renders one `contenteditable` `.wr-para` per beat, each a real `.cell-editable` with `data-id` and `data-field`. Browsers cannot make one text edit span two editing hosts, so continuous selection needs one host.
- The cell-editing owner (`src/application/editing/cell-editing.ts`) reads and writes one cell element through `CellPage`. Typing is native, then synced by decoding the cell's HTML into a `cellTextCommand`. Formatting, Enter and pending marks are already model edits.
- Everything assumes a cell is its own focused element. On `feat/writer-flow` at `87957b3f`, in the editing, rows, tags, undo, clipboard, comments, find, writer and common features plus `wiring/editor.ts`, non-test code has 34 `activeElement` lines, 21 `isScriptCell`/`closest` lines, 57 `cell-editable` lines and 29 `wr-para`/`writer-doc` lines. Not all of them need changing, and this is the largest known risk.
- A command is one transaction with rollback, and multi-row commands exist (`joinBeatsCommand`, `pasteBeatsCommand`, `removeBeatsCommand`). Adjacent one-cell commands can coalesce into one undo entry. Undo finds the caret by guessing from the first text step, for one cell. The held selection (`src/application/editing/selection.ts`) is one row, one field, anchor and head.
- Whole-beat clipboard (`src/features/clipboard/beat-clip.ts`) carries comments, status, b-roll and pictures up to a size cap, and treats a cut as a move. It pastes after the current beat, not at the caret, and it doesn't carry scene headers.
- `removeBeatsCommand` leaves comments in place at their last position. A split deliberately keeps one comment's mark in both halves, so removing comments by their `rowId` could delete a thread that still has surviving text.
- The app has no runtime dependencies today.
- Scenes must be non-empty: no synthetic beats, and a scene with no beats loses its header (`docs/architecture/sections.md`). `name` is plain text capped at 200.
- `mergeRow` starts from a copy of "theirs" and only reconciles named fields, so a new row field needs its own rule or a local change to it is lost. `rowContentEqual` also ignores unnamed fields, so a delete-versus-edit merge wouldn't see a paragraph-only change.
- Invariants that change: INV-15 (one paragraph is one row), the split-field invariant (Enter), the panel-closing and z-order invariant (side panels 140, writer 145), writer focus containment, the Save button mirror, and INV-18 for comments removed with whole beats. INV-03 stays: Find still stops at tags and b-roll. `docs/HANDOFF.md` 3.9 and `docs/DOCUMENT-MODEL.md`'s non-goals also need updating.

## 4. Proposed design

### 4.1 Saved data

- New optional row field `paragraphStart: true`. Absent means the beat runs on from the one before. The first beat of the script and of each scene always starts a paragraph, whatever the field says.
- Old files keep their exact bytes, because the key is only written when true. No schema bump. Paragraphs are never stored as a separate structure.
- Any combination of values renders correctly, so a merge cannot produce an invalid layout.
- Merge: changed side wins against the base, with incoming winning a real conflict, the same shape as `lengthSeconds`. The field also joins `rowContentEqual`, so a paragraph-only change counts as an edit against a concurrent delete. Tests cover both orientations and merges with no base.
- Commands work from **effective** paragraph membership, which includes the implicit starts at the first beat of the script and of each scene, and write whatever flags keep that membership. Survivors' flag changes are part of the same command and undo entry.

  | Operation | Result |
  | --- | --- |
  | First beat of a paragraph deleted, cut or moved alone | The next beat in that paragraph starts it, so it doesn't join the one above |
  | Whole paragraph moved between paragraphs, including a first paragraph with no stored flag | It stays its own paragraph, with the flag written on its first beat |
  | Beats moved or pasted mid-paragraph | They run on at the destination |
  | Join | The joined beat keeps the first beat's state, and the beat after it is untouched |
  | Enter, or Add beat in the split view | The new beat runs on |
  | Scene header removed | The scene's first beat gets the flag, so its text doesn't join the paragraph above |
  | Scene header added, or a scene moved | Implicit starts cover it, and no flags change |

- This applies to the shared commands the split view also uses, not only new ones: `deleteBeatCommand`, `removeBeatsCommand`, `moveBeatCommand`, `swapBeatsCommand`, `joinBeatsCommand`, `pasteBeatsCommand`, `removeSceneCommand` and `moveSceneCommand`. Otherwise deleting a beat in the split view silently joins paragraphs in the writer.
- Beat clipboard payloads carry the field. Exports ignore it, except the teleprompter.
- Known limit: project Markdown's table reuses rows by position, so inserting or deleting rows in an external editor can attach a flag to different text. It only moves a paragraph break, and a test records it.

### 4.2 Pure logic

A new `src/core/flow/` folder with no DOM. It can't live in `core/document`, which the dependency gate stops from importing `core/text`:

- `flowOf(doc)`: the derived list of headers and paragraphs, used by the writer and teleprompter.
- A flow position that can address everything the caret can reach: `{ kind: "beat", rowId, offset }`, `{ kind: "heading", sceneId, offset }`, and an affinity for which side of a boundary it sits on. Empty beats and visual-only beats are real positions at offset 0. A flow range has an anchor and a head, so direction is kept, and belongs to one document lifetime.
- One definition of the logical text of a paragraph, including the painted gap, used by copy and Find. It is for reading only: positions are always held by beat and offset, never as an offset into a paragraph, because an empty beat and its neighbours can share one.
- Pure functions returning a result of next rows, next sections, comment changes and next selection: replace a range, set a mark across a range (one decision over the whole selection, not a toggle per beat), start a paragraph, start a beat, remove a break, move or insert beats at a position, make a heading, cut a selection into its own beat, and find and replace across a paragraph. Search logic shared with `find.ts` moves down into core first.

Each is wrapped as one command in `src/application/commands/flow.ts`, with comments in the declared change set. Each records its selection before and after, including direction, so undo and redo restore it rather than guessing: `UndoEntry` gains an optional selection pair, and an entry without one uses today's caret guess, so native typing and the split view don't change. Conversions such as Markdown break coalescing, so Ctrl+Z straight after gives back the typed characters.

Under the review policy, parsing and transformation get seeded fuzzing, with properties such as: text outside the range is unchanged, no beat is duplicated, undo restores the document's content and structure (timestamps are bookkeeping and are excluded), scenes are never empty. Merge changes also get the mandatory differential and failure-path tests.

### 4.3 The editing surface (the key decision)

Recommended: **one editing host, with native text entry inside a beat, behind a writer-specific input adapter.** The outside review agreed with one host, but not with "reuse the cell path, then repair the spans" on its own.

```html
<div id="writer-doc" contenteditable="true">
  <h2 class="wr-heading" data-scene="...">Opening</h2>
  <div class="wr-par">
    <span class="wr-beat" data-id="..." data-field="audioText">First beat. </span>
    <span class="wr-beat" data-id="..." data-field="audioText">Second beat.</span>
  </div>
  <div class="wr-par">
    <span class="wr-beat" data-id="..." data-field="audioText" data-empty></span>
    <span class="wr-visual-note" contenteditable="false">Drone over the harbour · 0:04</span>
  </div>
</div>
```

- Ticks, placeholders and visual labels are decorations, never serialized and never in copied text. Every beat has a real narration position, including a visual-only beat, whose chip is a styled beat span with its label inside it. Clicks and keys on the label map to that position.
- **Input decisions use the operation's target range, not the caret.** A collapsed caret can still delete across beats with Ctrl+Backspace, or replace text through spellcheck. Before each input the adapter reads the input type and `getTargetRanges()`.
- **Inside one beat:** when the target range sits within one beat and touches no decoration, the input goes native, then syncs that beat through `cellTextCommand`. This keeps typing fast and keeps tag shortcuts, direction shortcuts, the completion ghost and spellcheck.
- **The gap is a painted margin plus a zero-width space:** the space is the first character of a run-on beat's span, and only when a gap shows. CSS alone isn't enough (section 9). The cell reader already strips `​`, and repair and the save path assert that no synthetic whitespace reaches storage.
- **Crossing beats or changing structure:** `beforeinput` and `keydown` are cancelled, one flow command runs, and the DOM is patched with the selection restored from model positions.
- **Repair:** after native input, any text outside a `.wr-beat`, or a merged or split span, is folded back into the right beat before anything is saved, and never during composition.
- **Patches, not paragraph repaints.** A script with little punctuation can still open as one huge paragraph, so repainting "the paragraph" could mean nearly the whole document. Ordinary edits patch the affected beat. This has to cover the app's own paint path: full renders on structural edits and replay reach `wiring/panels.ts`, which calls `paintWriterDraw`, and that replaces all of `#writer-doc`. Left alone, it overwrites patches, kills tag references and disturbs the selection.
- **IME:** Adam doesn't use one and IME-only bugs go on the never-do list (#1144), so there is no tuning. The one rule is that text is never discarded: no repaint or repair during composition, and all touched beats sync when it ends. Suite `289-script-cell-ime` has to keep passing or be updated on purpose.

Integrations this must adapt, beyond `currentBeat()`, because the host is now the event target and active element:

- **Undo:** `ownsItsUndo` (`features/undo/routes.ts`) treats a non-script editable as having its own undo. The host needs explicit document-undo ownership on keyboard, menu and `beforeinput`, or Ctrl+Z reaches browser history and the DOM diverges from the model. This is a data-integrity blocker for phase 2. Comment drafts keep their separate undo.
- **Pending marks:** `forgetStalePendingMarks` compares against `activeElement`, so Ctrl+B then typing would lose the mark. These move to model positions.
- **Tag shortcuts:** `plain-tags.ts` checks focus and keeps span references that a repaint invalidates.
- **Leaving a beat:** sanitising, syncing and b-roll anchoring run on blur today, and moving between beats won't blur. A model-level "left this beat" transition runs them, separate from host blur, window blur and closing the writer.
- **Clipboard:** `clipboard/routes.ts` routes on `.cell-editable`, so the host needs its own range-aware route, or native paste bypasses sanitising.
- **Held selection:** a second selection shape for flow ranges, with the existing one-cell shape left for the split view.

Alternatives considered:

| Option | For | Against |
| --- | --- | --- |
| One host, native typing inside a beat, input adapter (recommended) | Reuses the input pipeline, smallest typing cost | Native edits at span edges can escape, needing repair; many focus assumptions to adapt |
| One host, every keystroke through the model | No escape, no repair | Composition still needs native handling; breaks spellcheck replacement more easily; more new code. Its typing cost is unmeasured |
| ProseMirror or similar, for the writer only | Solved selection, schema and repair | A second engine beside the split view; tags, ghost, b-roll, shortcuts and comments rebuilt on it; the app's first runtime dependency. **This is the fallback if phase 0 fails** |
| Keep one host per beat and paint our own selection | Least disruption to existing code | Not native: no real selection, drag or browser copy; the weakest fit for the decided behaviour |

### 4.4 Other parts

- **Clipboard:** a flow clipboard format holding partial end pieces, whole rows, paragraph edges and selected scenes, with id handling for copy versus move, and plain text and HTML fallbacks. It builds on the beat payload, and the size cap and its "pictures left out" report still apply.
- **Find:** a writer-only search over `flowOf`, using search logic moved down into core. Matches still stop at tags and b-roll (INV-03). A scene-name replacement over 200 characters is refused.
- **Comments beside the writer:** this is more than stacking order. Jumping to a comment searches `#rows` today, so it needs writer-aware jumps, selection capture for new comments, anchor highlighting, focus return and comment draft undo. No other comment behaviour changes.
- **Top bar:** one shared header with mode-specific slots, replacing `.writer-bar`.
- **Teleprompter:** `prompter.ts` works out paragraph membership before it filters out skipped and empty beats, then keeps its sentence rule and also breaks where a paragraph started. Otherwise a skipped or visual-only first beat would lose the break.

## 5. Phases

| Phase | Work | Lands | Exit |
| --- | --- | --- | --- |
| 0a | Engine slice and test page: a first cut of `src/core/flow/`, the 4.3 surface and adapter, the real text decoder, session and undo through a separate composition root, section 2's switches, and the acceptance set below | Not merged | Acceptance set passes in Chrome and Electron's Chromium, and Adam picks the settings |
| 0b | Small in-app slice of the same engine: undo replay, real paint notifications, toolbar and comment focus, save flush, Electron undo routing | `feat/writer-flow` | It holds up. If 0a or 0b fails, we reconsider the engine before anything lands on `main` |
| 1 | `paragraphStart`, merge and equality rules, `src/core/flow/`, commands, shared command changes, fuzz tests. No shipping UI writes the flag yet | `main`, after 0b | Unit, merge, differential and failure-path tests; Full review because it touches merge and saved data |
| 2 | Single-host surface: render, caret, typing, tags, directions, undo ownership and the selection pair, patching, mode switching, the sentence rule on first open, and a minimal comment jump | `feat/writer-flow` | Typing `perf-ab` against `main`, correctness suites |
| 3 | Cross-beat selection, delete, format, Enter, Backspace, Join, cut and paste | same | Browser suites |
| 4 | Markdown and headings | same | Browser suites; wording signed off |
| 5 | Ticks, visual note, visual-only chips, floating box | same | Browser suites |
| 6 | Find and the Visuals toggle | same | Browser suites |
| 7 | Shared top bar, save status, comments beside the writer | same | Browser suites, desktop smoke groups |
| 8 | Remove the switch and the old writer, update the suites that expect it, teleprompter rule, invariants and docs, help and changelog, full browser run, one perf comparison, one real script used by Adam | merge to `main` | Green gate, Normal review, Adam's okay |

Phase 0a's acceptance set, each with checks that untouched text, row ids and metadata survive and that the model matches what's on screen:

- Mapping between the DOM and model positions, saving the model back out, and undo and redo.
- Replacing a selection across beats, Backspace and Delete at boundaries, Ctrl+Backspace, plain paste and cut, spellcheck replacement.
- The gap: arrow and word movement across it, Shift-selection, copy, Find, typing a literal space beside it, and proof that it never reaches storage.
- Pending formatting, tags, comment marks, heading positions, empty beats and visual-only beats.
- Typing at both edges of a beat span, beside tags and at formatting boundaries.
- Repainting while text is selected, focus moving to the toolbar and back, and IME commit and cancel losing no text.
- A short script and a long, sectionless script as one huge paragraph, with typing timed on the long one.

Full Markdown, clipboard polish and the Visual box aren't needed to decide the engine, and can follow. The page can't check Electron's menu routing, app focus or saving, which is why 0b exists.

Only additions and extractions that demonstrably keep the old interfaces and behaviour merge to `main` early. Shared editing and focus routes, undo hooks, clipboard routing, render and panel wiring, and the top bar stay on `feat/writer-flow` until phase 8, because the old writer depends on them: removing `.writer-bar`, for one, breaks its mount lookup. The branch merges `main` in regularly to limit drift.

Phases 2 and 3 are one lane at a time, because they share the surface. Phases 4 to 7 can run in parallel once 3 lands. The old writer stays on `main` until the phase 8 merge. The switch stays on the branch through phase 7: new suites turn it on, and the old suites keep running against the old writer, so each phase PR's CI stays meaningful. Phase 8 flips it for good.

Existing writer suites (`06-writer`, `08-writer-width`, `267-writer-undo`, `78-split-join-model`) and the others that touch the writer's DOM (18 suites mention `.wr-para`, `#writer-doc` or `#writer`) are updated where the behaviour is meant to change, never weakened (AGENTS.md rule 2). New suites cover each section 2 rule.

## 6. Known risks

1. **Native edits escaping a beat span.** Chromium may place typed text outside a span at its edge, or merge adjacent spans on delete. Phase 0 tests this directly, before anything lands.
2. **Long scripts in one host.** Layout and selection cost grow with the document, and an old script with little punctuation can open as very large paragraphs. Phase 0 times exactly that shape, and phase 2 patches beats instead of repainting paragraphs.
3. **Undo and selection.** Undo must own every route in the host, and multi-beat edits need their selection recorded rather than guessed.
4. **Comment anchors.** Splitting, moving and deleting beats must keep threads whose text survives. Existing `comment-anchors` tests cover splits, not ranges.
5. **Pending heading.** The text stays a literal `# ` in the beat until decided, so autosave can write it. If the app dies mid-heading, the script holds `# Title` as narration, which is harmless and visible.
6. **Replacing without a fallback.** With no setting, a serious bug has no way back but a release revert, so phase 8 includes real use on a real script before the merge.
7. **The engine decision comes late if phase 0 is shallow.** Phase 0 is therefore bigger than a mock-up, and phase 1 waits for the in-app slice, because tags, repair, painting and visual-only beats could otherwise force a redesign after phase 1 has landed.
8. **A long-lived feature branch.** Phases 2 to 7 stay off `main` while `main` keeps moving. Regular merges from `main` are the mitigation, and a conflict-heavy stretch is a reason to speed up phase 8.

## 7. Found while planning: for Adam

1. **Narration export: circle back later (Adam, 2026-11-04).** `splitImportText()` reads narration back as one paragraph per beat, so grouping beats would merge them on re-import. It stays one paragraph per beat for now. A "narration as written" export is one option when we return to it.
2. **Backspace under a scene header: decided (Adam, 2026-11-04).** In the writer, Backspace at the start of the first beat under a header moves the caret to the end of the header and changes nothing. The split view keeps the two-press removal chosen on 2026-10-31.
3. **A selection that fully contains a header and is deleted removes the header.** It's an explicit deletion, and it's one Ctrl+Z.
4. **Headings are plain text, up to 200 characters.** Bold in a heading isn't stored, because scene names are plain.
5. **`# Title` then Enter at the end of the script creates a blank first beat,** because a scene can't exist without one.
6. **Forward Delete above a scene header: decided (Adam, 2026-11-04).** Delete at the end of the last beat above a header moves the caret to the start of the header and changes nothing, mirroring 7.2.
7. **Enter at the very start of a heading: decided (Adam, 2026-11-05), built in phase 4.** A blank beat goes above the heading and the caret moves into it, which is close to Google Docs without leaving a scene with no name. The blank beat ends the scene above. If the heading is the first thing in the script, the blank beat becomes unnamed scene A and the named scene moves to B. Until phase 4, Enter there only moves the caret to the scene's first beat.
8. **Deleting all of a heading's text: decided (Adam, 2026-11-05), built in phase 4.** The line stays empty while the caret is on it, and the saved name doesn't change, because a saved scene needs a name. Leaving the line empty, including by closing the writer, removes the header. Its beats join the scene above, and one Ctrl+Z brings the header and its name back. If the app dies first, the old name is still saved. Backspace at a heading's start still removes the header, as section 2 says. Until phase 4, nothing is written and the old name stays.
9. **Backspace on a blank beat: decided (Adam, 2026-11-05).** It removes the beat and passes any paragraph break to the next beat. This is the one exception to "Backspace at a paragraph's start removes only the paragraph break".
10. **A selection ending at the start of an empty beat: coordinator's call (2026-11-05, #1227).** That beat stays, with its visual, status and comments, because the selection stops before it. The exception is the script's last beat, which counts as selected because a selection can't reach past it. Adam can overrule this.
11. **Tag and Link buttons: phase 7.** The new writer has no such buttons yet, so their cross-beat limit arrives with the toolbar. Comment already has it.
12. **Alt+Enter: still works, removed by phase 8.** Section 2 drops it unless Adam wants it kept.

## 8. Outside review

Round 1 (read-only, at `97586dc0`). Blockers: undo ownership in the host, positions that couldn't address headings, row equality in merge, comment deletion semantics, headers missing from the clipboard, and heading conversion truncating narration over 200 characters. All are addressed in the sections above. Its call on the editing surface: one host with a writer-specific input adapter, keeping a writer-only editor engine as a credible fallback, which this plan adopts.

Not adopted from round 1: IME-specific composition identity and undo handling, beyond "never discard text", because IME-only bugs go on the never-do list (#1144).

The failure scenarios in round 1 were predicted from the code and event contract, not reproduced in a browser. Phase 0 is where they get tested.

Round 2 (read-only, at `b087ecfb`, with small in-memory probes of the real commands, session and undo). Blockers: `flow.ts` in a layer that can't import text, and contradictory clipboard rules for a selection holding a header but no whole beat. Concerns: no editing contract for the display gap, native sync bypassing the comment and selection guarantees, shared split-view commands not preserving paragraphs, and a standalone page not being enough to justify landing phase 1. All are addressed above. A standalone page was judged buildable through injected dependencies.

Two responses differ from what round 2 suggested. Rather than a native-sync transaction with comment candidates, within-beat deletion keeps today's split-view comment behaviour, which matches Adam's decision (comments go with fully selected beats) and the deferral of comment behaviour work. Native edits keep today's undo caret placement too, and only flow commands record selections.

Browser behaviour in both rounds is predicted, not reproduced. Phase 0a is where it gets tested.

## 9. Phase 0a results

The page is `tools/writer-lab/`. `node tools/writer-lab/build.mjs` builds it and `node tools/writer-lab/accept.mjs` runs its key-press checks. It isn't meant to merge, apart from `src/core/flow/`.

**The painted gap failed.** With CSS alone, the browser reads two beats as one word when the first ends mid-sentence: double-clicking "store" selected "storeand", Ctrl+Right skipped the boundary, and spellcheck underlined "store and" as one word. Neither outside review caught this. `gap-probe.mjs` compared four ways of building the gap. A zero-width space fixed double-click, Ctrl+arrow and the underline in that probe. Inside the beat's span, it also passes the page's wrapping and typing checks, and the caret gets one stop on each side of the gap.

**Not yet shown:**

- Spellcheck on the real page. The probe's underline result used a zero-width space between the spans, not inside them, and a planted typo never got underlined on the page itself, so the page's screenshot proves nothing.
- Choosing a spellcheck suggestion from the right-click menu. The check selects a word and inserts text instead.
- Real Ctrl+C and Ctrl+V. The checks fire clipboard events directly, so they don't touch the PC's clipboard.
- A real IME. The checks use simulated composition events.
- Typing time with spellcheck actually running. Since the planted typo was never underlined, no run shows that case. Typing in a 900-beat paragraph took about one frame in the final Chromium and Electron runs (median 15 to 18 ms by position in the script, worst 34 ms). The final Edge run measured 64 to 70 ms of page work per key and about 1,016 ms per frame, on the long script only. Those one-second frames also appeared in earlier Edge runs, so they look like headless pacing, but that isn't proven.
- Electron's menu routing, app focus and saving, which phase 0b covers. The Electron run used a hidden off-screen window on 44.4.5, not the repo's 44.10.

`src/core/flow/` has no unit tests yet. Phase 1 adds them.

## 10. Phase 0b results

**The engine holds up.** The same surface now runs inside the real app behind a branch-only switch (`localStorage "splitpage-writer-flow" = "1"`), with the old writer untouched when it's off. `node tools/writer-lab/slice.mjs --target electron|edge` drives it with real key events, and it isn't meant to merge.

| Run, on the final code | Result |
| --- | --- |
| In-app slice, real Electron 44.10 (Chrome 152) | 25 of 25 |
| In-app slice, Edge 156 | 19 of 19 |
| Test page, Edge, Chromium and Electron 44.10 | 88 of 88 each |
| Unit tests | 5,726 of 5,726, the two PDF checks run alone (their 4 GB free RAM guard trips while the whole set runs) |
| Browser regression, switch off | 9,948 of 9,952 in the one full run; see below |

The four regression failures:

- `1197-ctrl-click-link` (3): the suite measured a link about 20 ms after closing the comments panel, while the rows were still widening for about 100 ms, so the link had moved by mouseup. It passed on clean `main` and failed on this branch, and why this code tips the timing isn't established: each half of the flow code passes alone, and only both together fail. The suite now waits for the rows to settle, keeps every assertion, and passed 40 of 40 three times in a row. The full browser run wasn't repeated, and no app code changed after it.
- `219-sound-cues` (1): it fails the same way on a clean build of `main` on this PC, while `main`'s CI is green. The Production panel collapses beat A.2, so "upbeat intro" isn't in the panel's text, though the tag is in the document. It isn't from this work and is still open.

**What 0b checked:** undo replay and selection, real full renders and outside edits, toolbar clicks, focus to the title and back, comment Post and Cancel, close and Esc, Edit menu Undo and Redo through the real application menu, and Save As and plain Save to disk. The words, the flags and the paragraphs round-trip, and no zero-width space reaches the file.

**Found and fixed along the way, none of it specific to the new writer:**

- **Typing restyled the whole page on every key.** The save indicators replaced their text nodes on each key, even with no change. With `body:has(...)` rules on the page, each replacement made Chromium re-check `:has()` from `<body>`, and `.ev-field:has(> .ev-chevron) > button` then put every button in the page in the restyle: 4,753 elements on a 900-beat script. The indicators now write only changed text, and that rule names its one real button. Measured with `--profile` on the flow writer: main-thread time per key fell from 89 ms to 9.7 ms, and style from 76 ms to 3 ms.
- **Edit > Undo and Redo were often dead.** Those menu roles run Chromium's own command, which does nothing while its stack is empty, and script edits never go on that stack. Redo was already dead in today's split view. The items now send the same keys as the keyboard, so they reach every existing route, text boxes included.
- **Enter redrew the rows and panels behind the writer.** Flow commands now run under the paint guard, as typing does. The rows redraw when the writer closes.

Timing on the 900-beat, sectionless script, one run each:

| | Edge typing p50 / p95 / max | Edge Enter | Edge Undo | Electron Enter | Electron Undo |
| --- | --- | --- | --- | --- | --- |
| Flow, before | 58.5 / 76.7 / 85.3 ms | 489 ms | 384 ms | 537 ms | 331 ms |
| Flow, now | 10.8 / 24.8 / 46.4 ms | 77 ms | 269 ms | 109 ms | 208 ms |
| Old writer, before | 42.4 / 66.1 / 70.7 ms | 16 ms | 351 ms | 25 ms | 321 ms |
| Old writer, now | 3.8 / 20.9 / 46.2 ms | 12 ms | 233 ms | 54 ms | 247 ms |

Electron's typing figure isn't in the table because it isn't useful. It sits near 62 ms on the 6-beat and the 900-beat script alike, in both writers, with the page idle for most of it, so it looks like a measuring floor in the off-screen window, though its cause isn't known. Electron's cost per key is the 9.7 ms task time above. Enter in flow mode is still slower than in the old writer: 77 ms against 12 in Edge, and 109 against 54 in Electron, where flow Enter ranged from 70 to 141 ms across runs. In Edge, script length still shows a little: typing p50 goes from 6.3 ms on 6 beats to 10.8 on 900 in the flow writer, and from 1.1 to 3.8 in the old one.

**Not yet shown:**

- A gap of about one second appeared on a single key in some Electron runs, always about 1,000 to 1,090 ms, in both writers. The page had no long task and the main process was nearly idle (44 ms of fsync) during it. Timers weren't throttled and the window was visible, which ruled out my first guess. Its cause is unknown, and it needs watching with real keys on a real screen.
- Spellcheck on the real page, right-click suggestions, real Ctrl+C and Ctrl+V, and a real IME, as in section 9.
- Real keyboard Ctrl+Z against the menu in Electron. CDP keys may not pass through accelerators, though the new items have `registerAccelerator: false`, as Find does.
- A real script in Adam's hands.

The full Electron smoke and `tools/perf-ab.mjs` were outstanding here too. Both have since run, and section 11 has the results.

**Deliberately outside the slice:** the sentence rule on first open, Find, tags and direction shortcuts, the tag ghost, the comments panel beside the writer and its jumps, whole-beat clipboard, and the viewing-only guard. A script with no flags opens as one paragraph per scene until the sentence rule lands.

**Noted for later:** each idle refresh re-adds all 900 rundown buttons, even with the writer covering them, and the `body:has(...)` rules still cost a style pass of about 40 ms each time. Neither runs per key.

## 11. Phase 1 results

**On `main`, none of it called by the shipping writer yet:**

| PR | What |
| --- | --- |
| #1220 | The `paragraphStart` flag and `paragraphsDecided` marker, load, merge and equality rules, and paragraph membership in the shared commands |
| #1219 | `src/core/flow/`, `flowCommand`, the moved Find and sentence rules, and the fuzz and reload tests |
| #1217 | Typing no longer restyles the whole page |
| #1218 | Edit > Undo and Redo work in the script |

**Names and rules as built:**

- The document marker is `paragraphsDecided: true`. It merges true if either side has it. The row flag merges like `lengthSeconds`.
- Load keeps both only as a literal `true`, so a flag that's `false` is never stored.
- A flag-only change counts as a change for row equality, but adds no attribution or edited-row counts.
- `flowCommand` takes an operation, `(doc) => FlowOutcome`, and plans it against the live document. The slice still computes its edit first and passes `() => edit`. Phase 2 moves operations inside.
- A heading name with no content, whether empty or only whitespace, writes nothing (section 7.8).
- Joined galleries follow the saved limits: 20 links, one poster per picture, and the same link counted once. A join only says a poster was kept when one was. If the link limit drops the only poster link, the notice says the link was dropped.

**Left for the branch:**

- `UndoEntry`'s selection pair (section 4.2). The slice keeps its own map of selections for now.
- `joinBeatsCommand`'s refusal of two visuals. It stays until the new writer ships, because the old writer depends on it. The flow engine's own join already combines them.
- Deleting `tools/writer-lab/` before the phase 8 merge, and taking `lab.ts` back out of `tsconfig.web.json`. Until then the page's files pass the same gates as everything else, because CI runs them on every phase PR. `gap-probe.mjs` has done its job and is gone; it's in history at `01ef194b`.
- Taking `feat/writer-flow` back out of `ci.yml`'s `pull_request` branches at phase 8. It's there so phase PRs get CI.

**Results outstanding from section 10:**

- Full Electron smoke on #1218, in CI on Linux under Xvfb: 881 of 881, 1 skipped.
- `perf-ab` on #1217, one run with other work on the PC, so read it as a direction, median p50: short typing 4.4 to 2.7 ms, long typing 6.6 to 3.4, long new scene 57.2 to 38.5, long undo 56.8 to 34.2. Every median in the table improved. The only worse p95 was short typing, up 5.2%.

**The branch after merging `main`:** in-app slice 25 of 25 in Electron and 19 of 19 in Edge, test page 88 of 88 in Edge. 166 focused flow, render-guard and CSS tests pass. The full unit and browser sets didn't run on this merge.

**Test browsers and your account:** `accept.mjs` and `slice.mjs` started Edge without `msImplicitSignin`, so a fresh temp profile signed in to Adam's Microsoft account and synced into `%TEMP%`. Both now pass it, and #1221 fixes the printed-layout checks and adds a test for any browser script in the repo. 81 signed-in temp profiles were deleted. Whether anything went from those test browsers to the account isn't known.

## 12. Phase 2 results

**On the branch:** #1222 (2a) and #1223 (2b), both behind the switch, with the switch-off suites unedited.

- **2a:** the host owns document undo, undo entries carry a selection pair, operations plan against the live document, edits and full renders patch beats instead of repainting them, opening and closing are clean, and the sentence rule runs on first open.
- **2b:** tag and direction shortcuts, the tag ghost, pending marks on model positions, the "left this beat" transition, and a minimal comment jump.

**Decided along the way:**

- The sentence rule on first open stays out of the undo stack. Earlier edits stay undoable, because it updates their recorded paragraph flags too. Undo can't remove the marker or run the rule again.
- A composition's touched beats come from the input events that hit them, not from comparing text, and composition end flushes straight away.
- Moving focus from the host to the page body doesn't run the departure work. It waits for the next departure or close, because that blur can't be told apart from a window blur.
- Bracket tags, Tab completion, `((direction))` and line-start `SFX:` and `Music:` keep the split view's syntax. Plain keyword tags and b-roll anchoring stay visual-only.

**Left on purpose:**

- The never-do list (#1144) has a reload that lands during a cancelled composition, which is overwritten on close. Composing a heading then a beat can also move the caret back to the heading, with both texts kept; that one is IME-only too and wasn't logged separately.
- #1224: leaving a beat can mark an untouched script as changed when a comment mark sits inside a tag. The old writer does the same.

**Speed, one run each with other apps open.** The new writer on the 900-beat script, in ms:

| | Edge typing p50 / p95 / max | Edge Enter / Undo | Electron typing p50 / p95 / max | Electron Enter / Undo |
| --- | --- | --- | --- | --- |
| Section 10's "Flow, now" | 10.8 / 24.8 / 46.4 | 77 / 269 | Not tabulated | 109 / 208 |
| End of phase 2 | 5.4 / 19.5 / 22.0 | 49.4 / 119.6 | 61.9 / 67.1 / 69.9 | 106.5 / 201.1 |

These two rows aren't a controlled before and after. Electron's typing figure is still the 62 ms measuring floor from section 10, on the small script too, and its cause is still unknown.

`perf-ab` against `main`, three rounds, measures the shipping paths with the switch off, not the new writer. Median p50: short typing 2.5 to 2.6, long typing 2.8 to 2.7, long undo 28.3 to 30.8 (up 8.8%). The review found no switch-off undo path in 2b's diff that explains the undo figure. Noise is more likely, but that's unproven, so phase 8's comparison has to look at it again. Long HTML export also went from 2.2 to 3.5.

**Still unproven:** a real IME, the real clipboard, right-click spellcheck, a physical Ctrl+Z against the menu, the one-second gap on a single key from section 10, the comments panel beside the writer, and a real script in Adam's hands. CI on a phase PR runs only the core and security-policy browser suites and a fixed list of flow suites, and the nightly full run covers `main`, not this branch, so a full browser run on the branch has to be done locally.

**Full browser run at the end of phase 2, switch off:** 10,161 of 10,163 across 212 suites. `219-sound-cues` is the known failure on this PC, from section 10. `388-scene-numbering` failed on clean `main` too: it still expected rows to stay identical when a scene header is removed, and #1220 deliberately adds the paragraph flag there. #1225 updates the suite. A phase PR's CI can't catch this kind of miss, so each phase from here ends with one full local run.

The first `tests/core/flow/` file covers the rules Adam picked. Fuzz, merge and differential tests are phase 1.

## 13. Phase 3 results

Phase 3 took three PRs into `feat/writer-flow`: #1226 (selection across beats and formatting), #1227 (delete, typing over a selection, boundary keys, Join) and #1228 (cut, copy and paste). Reviews found real bugs in all three, and every one was fixed before merge. The worst were Delete removing a picture-only beat the selection stopped in front of, and an empty payload in the app's clipboard format deleting the selection and ignoring the plain text beside it.

**Full browser run:** 10,686 of 10,687 across 236 suites at #1228's first head, `678e74ae`, with only `219-sound-cues` failing. The fix round after it touched writer-only clipboard paths and re-ran the writer suites, 751 of 751 across 38 suites, and the unit tests, 5,914 of 5,914.

**Existing tests changed on purpose:** `tests/core/flow/reload.test.ts` gains the two clipboard operations, and the shared model behind `fuzz.test.ts` and `reference-fuzz.test.ts` states section 7.10's rule. Nothing else moved.

**Still unproven:** the real clipboard, a real IME, right-click spellcheck, a physical Ctrl+Z against the menu, and a real script in Adam's hands. All clipboard checks use synthetic events.

## 14. Phases 4 to 7 results

Four parallel lanes merged into `feat/writer-flow`: #1230 (phase 5), #1229 (phase 6), #1231 (phase 4) and #1233 (phase 7). Reviews found real bugs in three of the four, including Replace losing formatting and comment anchors, heading conversion losing tags and comments, and a failed Save retry hiding the save problem. All were fixed before merge.

**Full browser run, all four together:** 11,334 of 11,335 across 276 suites at #1233's final head, `548a09c6`, with only `219-sound-cues` failing. Writer suites 1,381 of 1,381 across 77, units 5,961 of 5,961.

**Coordinator's rulings Adam can overrule:**
- A heading line holding tags or comments refuses to convert, with the notice "A scene header can't hold tags or comments."
- On an emptied heading, Backspace and Enter both count as leaving it empty, so the header goes, no blank beat is added, and one Ctrl+Z brings it back.
- Clicking Visual on a pending heading finalises it first. If the beat went away, the box stays closed and the caret stays on the heading.

**Wording awaiting Adam:** "Visuals must stay within one beat.", "Put the caret in a beat to edit its visual.", "Add pictures in the split view.", "A scene header can't hold tags or comments.", "Split view", "Not saved yet", "Autosave off", "Tags must stay within one beat.", "Links must stay within one beat." and "Save to choose where this script is kept."

**Left for phase 8:** #1232 (the Visual box repaints every beat per keystroke, to measure), #1234 (Find starting from a stale position after a pending heading), removing Alt+Enter, and rechecking long undo and long HTML export.

**Still unproven:** a real IME, the real clipboard, right-click spellcheck, physical window and menu interactions, and a real script in Adam's hands.

## 15. Phase 8 results

The review candidate makes flow the only writer, shares the header/save status in both modes, removes the switch and lab, combines visuals through the shared join command, and resolves pending/empty headings before Find reads its start. Present computes paragraph membership before skipped/empty filtering. Alt+Enter is gone. Saved formats and goldens are unchanged.

**Measured at `7ccb6fd0`:** final verification passed, including 5,960 of 5,960 unit cases, 30 desktop script files and 23 tool script files. The final full headless browser run passed 11,288 of 11,289 across 277 suites; only the known `219-sound-cues` failed. 174 existing suite files changed, none were deleted, and one measurement suite was added. The PR lists every suite by reason.

**One performance comparison, three rounds, `origin/main` to `7ccb6fd0`:** long undo p50 29.1 to 30.8 ms (+5.8%), long HTML export 2.5 to 2.1 ms (-16.0%). The undo gap remains unexplained; this run does not establish its cause. Short HTML export rose from 0.3 to 0.9 ms (+200.0%). All 20 cases, medians and changes are in the PR. The tool types and undoes in split-view cells: it does not measure old-versus-new writer latency.

**#1232:** Visual typing now updates only the affected beat's decorations. The failing regression counted six updates on an unrelated beat; the fixed count is zero. A separate final 900-beat writer probe recorded 24 ordinary keys and 24 Visual keys: key-to-next-frame medians 18.2 and 17.4 ms respectively. This is one browser sample, not a controlled old/new writer comparison or an Electron measurement. Earlier diagnostic timings with a reused timestamp are excluded.

**Carried over on the coordinator's ruling:** Alt+Up/Down moves the caret's beat through the existing command as one undo step, with scene/paragraph flags following that command. Refused flow edits keep the typing undo group. Ctrl+Shift+Enter still splits a beat; Escape dismisses tag completion while keeping the writer open. Adam has not tried beat movement in flowing text.

**Still unproven:** local full Electron smoke was intentionally not run; desktop CI on this head, real IME/clipboard/spellcheck/window/menu interactions, wording, and Adam's real-script acceptance remain outstanding. This candidate targets `feat/writer-flow` only. Nothing reaches `main` before that acceptance.
