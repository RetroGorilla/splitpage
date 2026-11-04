# Writer flow: plan

Status: revised after outside review (section 8). Nothing here is built. Issues: #264, #1167, and the writer side of #1166 and #1168.

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
- Narration export stays one paragraph per beat for now, and we circle back to it later (7.1).

### Editing

- Selecting, typing over, deleting, Ctrl+A and arrow keys all work across beats. Each edit is one Ctrl+Z.
- Deleting a selection removes beats fully inside it, with their visuals, comments and status. Partly selected beats keep their remaining text and their visuals. A notice says what went, such as "Removed 3 beats: 2 with visuals, 1 filmed".
- Bold, italic, underline, strikethrough and highlight work across beats. Comments, tags and links stay within one beat. With a selection across beats, those three buttons are disabled and say why.
- Backspace at a paragraph's start removes only the paragraph break. Backspace just after a tick deletes the previous character and leaves the boundary. Text typed at a tick goes into the beat before it.
- Beats join only through Alt+Backspace or Join on the tick, still refused when both have visuals.
- A beat fully inside a deleted selection takes its comments with it, unless part of a comment's marked text survives in another beat, which can happen after a split. Deleting words inside a surviving beat treats comments as the split view does today: the comment stays at its last position.
- The writer always has somewhere to type: Ctrl+A then Delete leaves one empty beat.
- Beats display with a gap the width of a space between them, unless the text already has whitespace there. The gap is painted, not text: it can't be selected alone, typed into or deleted, and the caret crosses it as the boundary between the two beats. A selection crossing it copies it as one space. It isn't stored, so it costs no read time and doesn't reach exports.
- Typing a space at a tick is an ordinary character in the beat before it, and the painted gap then steps aside.

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
- The heading takes the beat's first line, up to any Shift+Enter. Later lines stay as narration in that beat.
- A line over the scene name limit of 200 characters is refused the same way, with its own notice and all its narration kept.
- Enter in a heading: the text after the caret becomes the scene's first beat. Backspace at a heading's start: the header goes away and its text becomes a new beat that flows into the paragraph above. Backspace at the start of the first beat under a header: the caret moves to the end of the header and nothing changes.

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

Tick style, Enter versus double Enter, the Backspace rules, the visual-only line versus an inline chip, and the wall of text in existing scripts. The sentence rule is the fallback for that last one.

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
  | Alt+Enter, or Add beat in the split view | The new beat runs on |
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

- Ticks, placeholders and visual labels are decorations, never serialized and never in copied text. Every beat has a real narration position, including a visual-only beat, whose compact line is a styled beat span with its label beside it. Clicks and keys on the label map to that position.
- **Input decisions use the operation's target range, not the caret.** A collapsed caret can still delete across beats with Ctrl+Backspace, or replace text through spellcheck. Before each input the adapter reads the input type and `getTargetRanges()`.
- **Inside one beat:** when the target range sits within one beat and touches no decoration, the input goes native, then syncs that beat through `cellTextCommand`. This keeps typing fast and keeps tag shortcuts, direction shortcuts, the completion ghost and spellcheck.
- **The gap is painted, with no text node:** CSS on the boundary, so native editing has nothing to absorb into a beat. Repair and the save path assert that no synthetic whitespace reaches storage.
- **Crossing beats or changing structure:** `beforeinput` and `keydown` are cancelled, one flow command runs, and the DOM is patched with the selection restored from model positions.
- **Repair:** after native input, any text outside a `.wr-beat`, or a merged or split span, is folded back into the right beat before anything is saved, and never during composition.
- **Patches, not paragraph repaints.** An old script opens as one huge paragraph per scene, so repainting "the paragraph" could mean nearly the whole document. Ordinary edits patch the affected beat. This has to cover the app's own paint path: full renders on structural edits and replay reach `wiring/panels.ts`, which calls `paintWriterDraw`, and that replaces all of `#writer-doc`. Left alone, it overwrites patches, kills tag references and disturbs the selection.
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
| 2 | Single-host surface: render, caret, typing, tags, directions, undo ownership, patching, mode switching, and a minimal comment jump | `feat/writer-flow` | Typing `perf-ab` against `main`, correctness suites |
| 3 | Cross-beat selection, delete, format, Enter, Alt+Enter, Backspace, Join, cut and paste | same | Browser suites |
| 4 | Markdown and headings | same | Browser suites; wording signed off |
| 5 | Ticks, visual note, visual-only lines, floating box | same | Browser suites |
| 6 | Find and the Visuals toggle | same | Browser suites |
| 7 | Shared top bar, save status, comments beside the writer | same | Browser suites, desktop smoke groups |
| 8 | Teleprompter rule, invariants and docs, help and changelog, full browser run, one perf comparison, one real script used by Adam | merge to `main` | Green gate, Normal review, Adam's okay |

Phase 0a's acceptance set, each with checks that untouched text, row ids and metadata survive and that the model matches what's on screen:

- Mapping between the DOM and model positions, saving the model back out, and undo and redo.
- Replacing a selection across beats, Backspace and Delete at boundaries, Ctrl+Backspace, plain paste and cut, spellcheck replacement.
- The gap: arrow and word movement across it, Shift-selection, copy, Find, typing a literal space beside it, and proof that it never reaches storage.
- Pending formatting, tags, comment marks, heading positions, empty beats and visual-only beats.
- Typing at both edges of a beat span, beside tags and at formatting boundaries.
- Repainting while text is selected, focus moving to the toolbar and back, and IME commit and cancel losing no text.
- A short script and a long, sectionless old script as one huge paragraph, with typing timed on the long one.

Full Markdown, clipboard polish and the Visual box aren't needed to decide the engine, and can follow. The page can't check Electron's menu routing, app focus or saving, which is why 0b exists.

Only additions and extractions that demonstrably keep the old interfaces and behaviour merge to `main` early. Shared editing and focus routes, undo hooks, clipboard routing, render and panel wiring, and the top bar stay on `feat/writer-flow` until phase 8, because the old writer depends on them: removing `.writer-bar`, for one, breaks its mount lookup. The branch merges `main` in regularly to limit drift.

Phases 2 and 3 are one lane at a time, because they share the surface. Phases 4 to 7 can run in parallel once 3 lands. The old writer stays on `main` until the phase 8 merge.

Existing writer suites (`06-writer`, `08-writer-width`, `267-writer-undo`, `78-split-join-model`) and the others that touch the writer's DOM (18 suites mention `.wr-para`, `#writer-doc` or `#writer`) are updated where the behaviour is meant to change, never weakened (AGENTS.md rule 2). New suites cover each section 2 rule.

## 6. Known risks

1. **Native edits escaping a beat span.** Chromium may place typed text outside a span at its edge, or merge adjacent spans on delete. Phase 0 tests this directly, before anything lands.
2. **Long scripts in one host.** Layout and selection cost grow with the document, and an old script opens as very large paragraphs. Phase 0 times exactly that shape, and phase 2 patches beats instead of repainting paragraphs.
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
6. **Open: forward Delete above a scene header.** The Backspace decision in 7.2 doesn't cover it. Proposal: Delete at the end of the last beat above a header moves the caret to the start of the header and changes nothing. Needs Adam's sign-off because it changes a keystroke.

## 8. Outside review

Round 1 (Codex Sol, High, read-only, at `97586dc0`). Blockers: undo ownership in the host, positions that couldn't address headings, row equality in merge, comment deletion semantics, headers missing from the clipboard, and heading conversion truncating narration over 200 characters. All are addressed in the sections above. Its call on the editing surface: one host with a writer-specific input adapter, keeping a writer-only editor engine as a credible fallback, which this plan adopts.

Not adopted from round 1: IME-specific composition identity and undo handling, beyond "never discard text", because IME-only bugs go on the never-do list (#1144).

The failure scenarios in round 1 were predicted from the code and event contract, not reproduced in a browser. Phase 0 is where they get tested.

Round 2 (Codex Sol, xhigh, read-only, at `b087ecfb`, with small in-memory probes of the real commands, session and undo). Blockers: `flow.ts` in a layer that can't import text, and contradictory clipboard rules for a selection holding a header but no whole beat. Concerns: no editing contract for the display gap, native sync bypassing the comment and selection guarantees, shared split-view commands not preserving paragraphs, and a standalone page not being enough to justify landing phase 1. All are addressed above. A standalone page was judged buildable through injected dependencies.

Two responses differ from what round 2 suggested. Rather than a native-sync transaction with comment candidates, within-beat deletion keeps today's split-view comment behaviour, which matches Adam's decision (comments go with fully selected beats) and the deferral of comment behaviour work. Native edits keep today's undo caret placement too, and only flow commands record selections.

Browser behaviour in both rounds is predicted, not reproduced. Phase 0a is where it gets tested.
