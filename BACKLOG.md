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
- **Description:** If the last word in a paragraph is tagged, you can't type additional text into that scene (can't place cursor after the tag / continue the paragraph). Not yet confirmed whether this is specific to prop tags or affects all tag types.
- **Repro / notes:** Tag the final word of a paragraph, then try to add more text after it — typing doesn't work. Needs repro across different tag types (prop, person, etc.) to narrow scope. Likely related to `.tag-anchor` being `contenteditable="false"` (noted in `src/js/21-events.js` around line 334) — cursor may have nowhere to land after an atomic tag at the end of a line.

<!-- add entries here -->

---

## Features

<!-- add entries here -->

---

## Done / Implemented

<!-- move entries here once shipped, with a link to the commit or PR -->
