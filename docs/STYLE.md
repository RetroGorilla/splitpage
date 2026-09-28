# Wording in the app

How Splitpage talks to a person. `src/test/wording.test.mjs` holds the
mechanical rules; the rest is judgement.

- **Scene, not row.** A scene is what a person sees. "Row" belongs to the
  code and to the exported comments appendix (`Row 03`), which files read
  back in and so keep.
- **British spelling:** colour, labelled, minimise, centre (in words a
  person reads; CSS and code keep their own spelling).
- **Sentence case** for buttons, menu items and headings: "Take the tour",
  not "Take The Tour". A document's default title is the one exception: it is
  stored data, `Untitled Script`.
- **"Could not", not "Couldn't".** Full words in messages, with a curly
  apostrophe where one is needed.
- **Failures say what to check,** not what the browser threw. Use
  `plainReason(err)` (`src/js/13-hosted.js`) after the dash: "Could not open
  that folder — the connection failed — check that you are online".
- **No internal names or issue numbers** in text a person reads. Comments
  in code may have them; the build strips the shell's HTML comments.
