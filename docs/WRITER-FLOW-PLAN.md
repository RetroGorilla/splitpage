# Writer flow: plan

Status: draft for outside review. Nothing here is built. Issues: #264, #1167, and the writer side of #1166 and #1168.

Words: a **beat** is a row. A **scene** is a group of beats under a header (saved as `sections`, anchored by `firstSceneId`). `audioText` is a beat's narration.

## 1. What we are building

The writer becomes one continuous document that types like a Google Doc. It replaces the old writer outright, with no setting and no period of keeping both.

Desktop Chromium is the target: the Electron app and Chrome. Phones get the same code with no tuning or phone-specific testing, on Adam's decision. Other browsers must not lose data, but they are not tuned either (assumption, not yet confirmed by Adam).

## 2. Decided behaviour

### Structure

- A paragraph holds one or more beats, running together as flowing text. A beat never crosses a paragraph break.
- **Enter** starts a new paragraph and a new beat. **Alt+Enter** starts a new beat in the same paragraph. **Shift+Enter** is a line break inside a beat.
- Existing scripts open with each scene as one paragraph, because old files have no saved breaks. Text imports keep their source paragraph breaks.
- The teleprompter keeps its sentence rule and also starts a paragraph at every saved break. Table exports stay per beat.
- Narration export: see 7.1.

### Editing

- Selecting, typing over, deleting, Ctrl+A and arrow keys all work across beats. Each edit is one Ctrl+Z.
- Deleting a selection removes beats fully inside it, with their visuals, comments and status. Partly selected beats keep their remaining text and their visuals. A notice says what went, such as "Removed 3 beats: 2 with visuals, 1 filmed".
- Bold, italic, underline, strikethrough and highlight work across beats. Comments, tags and links stay within one beat. With a selection across beats, those three buttons are disabled and say why.
- Backspace at a paragraph's start removes only the paragraph break. Backspace just after a tick deletes the previous character and leaves the boundary. Text typed at a tick goes into the beat before it.
- Beats join only through Alt+Backspace or Join on the tick, still refused when both have visuals.

### Cut and paste

- Whole beats keep everything: visual, comments, status, b-roll, breakdown details, pictures.
- Pasting whole beats mid-beat splits the target at the caret. The first half keeps its visual and status, and the second half is a new beat with no visual.
- Pasting between beats splits nothing. At a paragraph's start or end the block stays its own paragraph. Mid-paragraph it flows in.
- Partly selected ends become new beats with no visual, and their originals keep their visuals. With no whole beat selected, it is a plain text paste with no split.
- A scene header inside the selection moves with it. Copy and paste duplicates, as beat copy does today.
- Pasting from outside: each paragraph becomes a new paragraph and beat.
- Dragging selected text stays off. Pasted Markdown does not convert.

### What you see

- A clean centred column of narration. Filmed beats and folded scenes always show in full, whatever their split-view setting.
- A faint tick marks each boundary. Hovering shows its number, and a filmed beat's tick is coloured. The beat holding the caret gets a very light tint. Its visual shows as a quiet note beside the line, and clicking the note opens the floating box. The Visuals, Numbers and Compact margin button goes away.
- A beat with a visual and no narration gets its own compact line, like `▣ Drone over the harbour · 0:04`, with the time only if one is set. It breaks the flow visually without being a paragraph break. Typing on it adds narration and makes it a normal beat.
- A beat with neither narration nor a visual shows a small placeholder. Enter on one does nothing, so repeated Enter cannot fill the script with blank beats.
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
- Enter in a heading: the text after the caret becomes the scene's first beat. Backspace at a heading's start: the header goes away and its text becomes a new beat that flows into the paragraph above.

### Find

- Ctrl+F searches narration and scene headers. A **Visuals** toggle adds visuals, starts off and lasts until the writer closes. A match in a visual opens the floating box with it highlighted.
- A phrase crossing a tick is one match. Replace puts the new text in the first beat and removes the rest of the match from the later one, leaving the boundary. Replace All is one Ctrl+Z.
- Esc closes Find, then the writer on a second press.

### Top bar (#1167)

- Both modes: File menu, a mode button in a fixed position, save status, script length.
- Writer only: word count, counting the selection when there is one, and the Size slider. The formatting row uses the split view's icons and gains the missing buttons. Export narration leaves the bar and sits with the other exports.
- Save becomes quiet status text. It stands out and is clickable for an unsaved new script, Autosave off, or a save problem. Ctrl+S keeps working.

### Left for later

Bullets and the Outline view (scenes as bullets, beats as sub-bullets), dragging selected text, pasted Markdown converting, a Visual box shortcut. Split-view restyling of headers (#1166, #1168) and scene descriptions (#1171) stay separate.

### To judge on the test page

Tick style, Enter versus double Enter, the Backspace rules, the visual-only line versus an inline chip, and the wall of text in existing scripts. The sentence rule is the fallback for that last one.

## 3. How it fits the code today

- `src/features/writer/writer.ts` renders one `contenteditable` `.wr-para` per beat, each a real `.cell-editable` with `data-id` and `data-field`. Browsers cannot make one text edit span two editing hosts, so continuous selection needs one host.
- The cell-editing owner (`src/application/editing/cell-editing.ts`) reads and writes one cell element through `CellPage`. Typing is native, then synced by decoding the cell's HTML into a `cellTextCommand`. Formatting, Enter and pending marks are already model edits.
- Everything assumes a cell is its own focused element. On `feat/writer-flow` at `87957b3f`, in the editing, rows, tags, undo, clipboard, comments, find, writer and common features plus `wiring/editor.ts`, non-test code has 34 `activeElement` lines, 21 `isScriptCell`/`closest` lines, 57 `cell-editable` lines and 29 `wr-para`/`writer-doc` lines. Not all of them need changing, and this is the largest known risk.
- One command is one undo entry, and multi-row commands exist (`joinBeatsCommand`, `pasteBeatsCommand`, `removeBeatsCommand`). The held selection (`src/application/editing/selection.ts`) is one row, one field, anchor and head.
- Whole-beat clipboard (`src/features/clipboard/beat-clip.ts`) already carries everything and treats a cut as a move, but pastes after the current beat, not at the caret.
- Scenes must be non-empty: no synthetic beats, and a scene with no beats loses its header (`docs/architecture/sections.md`). `name` is plain text capped at 200.
- `mergeRow` starts from a copy of "theirs" and only reconciles named fields, so a new row field needs its own rule or a local change to it is lost.
- Invariants that change: INV-15 (one paragraph is one row), the split-field invariant (Enter), the panel-closing and z-order invariant (side panels 140, writer 145), writer focus containment, and the Save button mirror. `docs/HANDOFF.md` 3.9 and `docs/DOCUMENT-MODEL.md`'s non-goals also need updating.

## 4. Proposed design

### 4.1 Saved data

- New optional row field `paragraphStart: true`. Absent means the beat runs on from the one before. The first beat of the script and of each scene always starts a paragraph, whatever the field says.
- Old files keep their exact bytes, because the key is only written when true. No schema bump. Paragraphs are never stored as a separate structure.
- Any combination of values renders correctly, so a merge cannot produce an invalid layout.
- Merge: changed side wins against the base, with incoming winning a real conflict, the same shape as `lengthSeconds`.
- Removing or moving a paragraph's first beat hands `paragraphStart` to the next beat in that paragraph, so a paragraph doesn't silently join the one above. This lives in the commands used by both views.
- Beat clipboard payloads carry the field. Exports ignore it, except the teleprompter.

### 4.2 Pure logic

A new `src/core/document/flow.ts` with no DOM:

- `flowOf(doc)`: the derived list of headers and paragraphs, used by the writer and teleprompter.
- A flow position `{ rowId, offset }` and a flow range between two positions.
- Pure functions returning the next rows and sections: replace a range, toggle a mark across a range, start a paragraph, start a beat, remove a break, move or insert beats at a position, make a heading, cut a selection into its own beat, and find and replace across a paragraph.

Each is wrapped as one command in `src/application/commands/flow.ts`. Under the review policy, parsing and transformation get seeded fuzzing, with properties such as: text outside the range is unchanged, no beat is duplicated, undo restores the exact document, scenes are never empty.

### 4.3 The editing surface (the key decision)

Recommended: **one editing host, with each beat an inline element inside it.**

```html
<div id="writer-doc" contenteditable="true">
  <h2 class="wr-heading" data-scene="...">Opening</h2>
  <div class="wr-par">
    <span class="wr-beat" data-id="..." data-field="audioText">First beat. </span>
    <span class="wr-beat" data-id="..." data-field="audioText">Second beat.</span>
  </div>
  <div class="wr-visual-line" data-id="..." contenteditable="false">...</div>
</div>
```

- Ticks are CSS on `.wr-beat + .wr-beat`, not DOM nodes, so the caret has nothing to get stuck on.
- **Inside one beat:** a collapsed caret types natively, then syncs that beat through the existing cell path. This keeps typing fast and keeps tag shortcuts, direction shortcuts, the completion ghost and spellcheck.
- **Anything crossing or changing structure:** `beforeinput` and `keydown` are cancelled, one flow command runs, the affected paragraphs repaint and the selection is restored from model positions.
- **Finding the current beat:** a selection-derived `currentBeat()` replaces `activeElement` and `event.target`, because both now report the host. `CellPage` keeps working on a beat element.
- **Repair:** after native input, any text that landed outside a `.wr-beat`, or a merged or split span, is folded back into the right beat and that paragraph is repainted from the model.
- **Held selection:** a second selection shape for flow ranges, with the existing one-cell shape left for the split view.

Alternatives for the review to challenge:

| Option | For | Against |
| --- | --- | --- |
| One host, native typing inside a beat (recommended) | Reuses the input pipeline, smallest typing cost | Native edits at span edges can escape, needing repair; many `activeElement` assumptions |
| One host, every keystroke through the model | No escape, no repair | Typing path gets slower, breaks autocorrect and spellcheck replacement more easily, more new code |
| ProseMirror or similar, for the writer only | Solved selection, schema and repair | A second engine beside the split view; tags, ghost, b-roll, shortcuts and comments rebuilt on it; a new runtime dependency |
| Keep one host per beat and paint our own selection | Least disruption to existing code | Not native: no real selection, drag or browser copy; fragile |

### 4.4 Other parts

- **Find:** a writer-only search over `flowOf`, sharing `matchesInPieces` where possible. Whether it extends `find.ts` or sits beside it is left to the Find phase.
- **Comments panel beside the writer:** the smallest change to the panel-closing and z-order rules. No comment behaviour work beyond that.
- **Top bar:** one shared header with mode-specific slots, replacing `.writer-bar`.
- **Teleprompter:** `prompter.ts` keeps its sentence rule and also breaks at a beat with `paragraphStart`.

## 5. Phases

| Phase | Work | Lands | Exit |
| --- | --- | --- | --- |
| 0 | Standalone test page with a demo script, using the 4.3 surface, with switches for section 2's open items | Not merged | Adam picks the settings |
| 1 | `paragraphStart`, merge rule, `flow.ts`, commands, fuzz tests | `main`, inert | Unit and merge tests; Full review because it touches merge and saved data |
| 2 | Single-host surface: render, caret, typing, tags, directions, undo, repaint, mode switching | `feat/writer-flow` | Typing `perf-ab` against `main` |
| 3 | Cross-beat selection, delete, format, Enter, Alt+Enter, Backspace, Join, cut and paste | same | Browser suites |
| 4 | Markdown and headings | same | Browser suites; wording signed off |
| 5 | Ticks, visual note, visual-only lines, floating box | same | Browser suites |
| 6 | Find and the Visuals toggle | same | Browser suites |
| 7 | Shared top bar, save status, comments beside the writer | same | Browser suites, desktop smoke groups |
| 8 | Teleprompter rule, invariants and docs, help and changelog, full browser run, one perf comparison, one real script used by Adam | merge to `main` | Green gate, Normal review, Adam's okay |

Phases 2 and 3 are one lane at a time, because they share the surface. Phases 4 to 7 can run in parallel once 3 lands. Inert work merges to `main` early so the feature branch doesn't drift from a fast-moving `main`. The old writer stays until the phase 8 merge.

Existing writer suites (`06-writer`, `08-writer-width`, `267-writer-undo`, `78-split-join-model`) and the others that touch the writer's DOM (18 suites mention `.wr-para`, `#writer-doc` or `#writer`) are updated where the behaviour is meant to change, never weakened (AGENTS.md rule 2). New suites cover each section 2 rule.

## 6. Known risks

1. **Native edits escaping a beat span.** Chromium may place typed text outside a span at its edge, or merge adjacent spans on delete. Phase 0 tests this directly, before anything lands.
2. **Long scripts in one host.** Layout and selection cost grow with the document, and today's repaint replaces all of `#writer-doc`. Phase 2 repaints only affected paragraphs and measures typing on the long fixture.
3. **Undo and selection.** History restores carets for one cell, so multi-beat edits need range restore.
4. **Comment anchors.** Splitting and moving beats must keep anchors in the right row. Existing `comment-anchors` tests cover splits, not ranges.
5. **Pending heading.** The text stays a literal `# ` in the beat until decided, so autosave can write it. If the app dies mid-heading, the script holds `# Title` as narration, which is harmless and visible.
6. **Replacing without a fallback.** With no setting, a serious bug has no way back but a release revert, so phase 8 includes real use on a real script before the merge.

## 7. Found while planning: for Adam

1. **Narration export can't follow paragraphs.** `splitImportText()` reads narration back as one paragraph per beat, so grouping beats would merge them on re-import. It was conditional in the discussion, so it stays one paragraph per beat. A "narration as written" export could be added later.
2. **The 2026-10-31 two-press Backspace.** At a scene boundary, Backspace at the following beat's start currently warns, then removes the header on the second press. It predates the new heading rules. Proposal: in the writer, that Backspace moves the caret to the end of the header and changes nothing, and the split view keeps two-press. Needs Adam's sign-off because it changes a keystroke.
3. **A selection that fully contains a header and is deleted removes the header.** It's an explicit deletion, and it's one Ctrl+Z.
4. **Headings are plain text, up to 200 characters.** Bold in a heading isn't stored, because scene names are plain.
5. **`# Title` then Enter at the end of the script creates a blank first beat,** because a scene can't exist without one.

## 8. Questions for the outside review

1. Is one host with native typing inside a beat right, or is one of the alternatives better? What would fail first?
2. Which assumptions about a cell being its own focused element will break in ways the plan doesn't name?
3. Is `paragraphStart` on the row right, including its hand-off rule and merge rule? What breaks through undo, history, drafts, project Markdown, or the on-disk merge?
4. Are multi-beat commands, undo and comment anchoring workable as described?
5. Is the phase order right, and is phase 0 able to answer the riskiest questions?
6. Where do the section 2 rules contradict each other or the invariants?
