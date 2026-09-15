# Backlog

Running list of feature ideas and bugs to fix later. Add entries as you think of them; nothing here gets implemented until it's moved to an issue/PR.

## How to add an entry

Copy this template into the right section below:

```
### <short title>
- **Type:** Bug | Feature
- **Priority:** Low | Medium | High
- **Area:** (e.g. UI, sync, export, server)
- **Description:** what's wrong or what's wanted
- **Repro / notes:** steps to reproduce (bugs) or context/mockup links (features)
```

---

## Bugs

### Copy/paste doesn't preserve tags
- **Type:** Bug
- **Priority:** Medium
- **Area:** Tagging / copy-paste
- **Description:** When copying and pasting tagged objects into a new scene, the tags don't carry over. Tags should stick to the object through copy/paste.
- **Repro / notes:** Tag an object, copy it, paste into a different scene — tag is missing on the pasted copy. Relevant code likely around tag parsing/anchors in `src/js/21-events.js` (`.tag-anchor`, tag composer) and wherever copy/paste is handled.

### Can't add text after a tagged word ends a paragraph
- **Type:** Bug
- **Priority:** Medium
- **Area:** Tagging / editing
- **Description:** If the last word in a paragraph is tagged, you can't type additional text into that scene (can't place cursor after the tag / continue the paragraph). Not specific to prop tags — narrowed down to happening specifically when the tag falls on the bottom (last) row of the text cell.
- **Repro / notes:** Tag a word on the bottom row of a text cell, then try to add more text after it — typing doesn't work. Tags elsewhere (not on the bottom row) don't have this problem. Likely related to `.tag-anchor` being `contenteditable="false"` (noted in `src/js/21-events.js` around line 334) — cursor may have nowhere to land after an atomic tag when there's no row below it to fall into.

### Tags don't survive app updates
- **Type:** Bug
- **Priority:** High
- **Area:** Tagging / update process
- **Description:** Tags appear to get lost when the software is updated to a new version. Might have been a one-time thing, but needs confirming — either way, updates shouldn't break existing tags/features.
- **Repro / notes:** Noticed after updating to a newer version — existing tags were gone. Unconfirmed if reproducible on every update or a one-off. Check what update.mjs does to stored data/tags, and whether tag data survives a version bump intact.

### Undo fails after alt-enter moves text to a new cell
- **Type:** Bug
- **Priority:** Medium
- **Area:** Editing / undo
- **Description:** After using the alt-enter shortcut to move text into a new cell, undo doesn't undo the change.
- **Repro / notes:** Use alt-enter to split/move text to a new cell, then press undo — the move isn't reverted.

### Typing over a selection is invisible in dark mode
- **Type:** Bug
- **Priority:** Medium
- **Area:** UI / dark mode / editing
- **Description:** In dark mode, when text is highlighted (selected) and you type to replace it, you can't see what you're typing.
- **Repro / notes:** Switch to dark mode, select some text, start typing — the new text isn't visible (likely a text-color/highlight-color contrast issue in the selection style for dark mode).

### Highlight/text modifiers need a UX pass
- **Type:** Bug
- **Priority:** Medium
- **Area:** UI / editing
- **Description:** Highlight and other text modifiers (formatting tools) don't behave well overall — needs a general UX pass rather than one specific fix. May overlap with the dark-mode selection-visibility issue below.
- **Repro / notes:** No single repro — general behavior/feel issue across highlight and other text-modifier controls. Worth reviewing alongside the dark-mode typing-over-selection bug.

<!-- add entries here -->

---

## Features

### Main two-column layout should widen with the window
- **Type:** Feature
- **Priority:** Medium
- **Area:** UI / layout
- **Description:** The main two-column interface is too fixed-width — it should be more flexible and expand to use available space on wider windows/screens instead of staying capped.
- **Repro / notes:** Resize the window wider and the two-column view doesn't grow to fill it.

### Undo after highlighting text doesn't behave properly
- **Type:** Bug
- **Priority:** Medium
- **Area:** Editing / undo / highlight
- **Description:** Undoing after applying a highlight to text doesn't work as expected. Likely related to the broader highlight/text-modifier UX pass and the existing alt-enter undo bug — undo seems to have multiple gaps around text-formatting actions.
- **Repro / notes:** Highlight some text, then press undo — behavior is off (exact wrong behavior not yet pinned down, needs a clean repro).

### Comments/gear panel shrinks main script even when there's room
- **Type:** Bug
- **Priority:** Medium
- **Area:** UI / layout
- **Description:** Opening the comments or gear (settings) list panel shrinks the width of the main script column, even when the window is wide enough for the panel to pop in without taking space from it.
- **Repro / notes:** Widen the window, open the comments or gear panel — main script column narrows instead of the panel overlaying/using free space. Related to the "two-column layout should widen with window" entry above.

### File/production/gear/title should collapse into a toolbar on scroll
- **Type:** Feature
- **Priority:** Medium
- **Area:** UI / layout
- **Description:** When scrolling down into the body of the script, the file info, production list, gear (settings), and title should collapse into a compact toolbar instead of staying at full size / scrolling away, so they stay accessible without eating vertical space.
- **Repro / notes:** Scroll down into the script body — currently these elements don't condense into a sticky/compact toolbar.

### Slide-in animation for sidebars
- **Type:** Feature
- **Priority:** Low
- **Area:** UI / polish
- **Description:** Add a smooth slide-in/out animation when opening or closing the comments and gear (settings) sidebars, instead of an instant pop-in.
- **Repro / notes:** N/A — polish request. Worth pairing with the layout fix above (panel shrinking the main script) since both touch the same open/close behavior.

### Adjustable width for comment sidebar columns
- **Type:** Feature
- **Priority:** Low
- **Area:** UI / comments
- **Description:** The comment sidebar columns should be resizable/adjustable width instead of fixed.
- **Repro / notes:** N/A — UI enhancement request.

<!-- add entries here -->

---

## Done / Implemented

<!-- move entries here once shipped, with a link to the commit or PR -->
