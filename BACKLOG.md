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

<!-- add entries here -->

---

## Features

<!-- add entries here -->

---

## Done / Implemented

<!-- move entries here once shipped, with a link to the commit or PR -->
