# Splitpage — developer handoff

Written 2026-08-28. For whoever (or whatever) picks this up next.

`README.md` is the **user-facing** doc — what the features are and how to use
them. Read it first; this file deliberately does not repeat it. What follows is
the stuff that isn't obvious from either the README or a skim of the code, and
that will cost you a day if you learn it the hard way.

---

## 1. Orientation

Splitpage is Adam's personal tool for scripting videos: a two-column
visual/audio editor with a teleprompter, review comments, and a production
breakdown for props/locations/cast/VFX/sound.

- **The entire app is one file**: `index.html`, ~8,600 lines, HTML + CSS + JS.
- Supporting files: `README.md`, `start.bat` / `start.ps1` (local server),
  `manifest.webmanifest`, `icon.svg`, `sw.js` (PWA bits).
- **There is no git here.** `D:\vibecoding` is not a repository. There is no
  history, no branches, no undo. Treat every edit to `index.html` as
  irreversible and edit surgically — see §5.
- It began life as a Claude artifact and was converted to run standalone. A few
  artifact-era assumptions may still lurk; stale user-facing wording about "the
  artifact" is a bug, not a quirk.

---

## 2. Running and testing it

```bash
start.bat
```

Serves on `http://localhost:8791` via a pure-PowerShell static server (the
machine has no Python or Node). Opening `index.html` directly over `file://`
works for editing, but disables PWA install, IndexedDB persistence, **and the
microphone** — so test over http.

### The test harness lies to you

Everything below looked like an app bug at least once during this session and
was not. **Suspect the test before the code.**

| Symptom | Actual cause |
| --- | --- |
| A typing shortcut never fires | `computer.type` commits the whole string as **one** `insertText` event. Type the trigger character in its own call, or dispatch a real `InputEvent`. |
| Enter / Ctrl+Z appear to do nothing | `computer.key` often isn't recognised by the app's listeners. Dispatch a real `KeyboardEvent`, or call `document.execCommand` directly. |
| A click does nothing on the 2nd element | Your `NodeList` went stale — panels re-render and replace their DOM wholesale. **Re-query after every action.** |
| A CSS hover/transition assertion fails | `getComputedStyle` immediately after a class change returns the pre-transition value. Wait past the transition duration. |
| Focus jumps mid-batch | Editing `index.html` fires a hook that opens a stray `file://` preview tab. Close it, re-select the localhost tab. |

**Permanently present, always harmless console errors:** `"An unknown error
occurred when fetching the script"` (service-worker registration in the
sandbox) and blocked `beforeunload` panels. Don't chase these.

**What cannot be tested from an agent sandbox:** microphone capture is blocked,
so **Follow My Voice can never be verified end to end**. Verify its logic
against simulated transcripts and say plainly that live speech is unconfirmed.

### Run the tests first

There is a real regression suite now — 183 assertions across 8 suites, driving
headless Edge over CDP. **Run it before and after any change to
`index.html`:**

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/run-tests.ps1
```

`ALL PASS - 183/183` and exit 0, or it names every failing assertion and exits 1.
`-Only 02` runs one suite, `-Headed` shows you the browser. Full command
reference and the harness's own gotchas are in
`.claude/skills/run-splitpage-app/SKILL.md` — read that before writing a new
test, because most "failures" are the test, not the app.

The suite is verified to actually catch things: breaking the `[prop]` shortcut
produced four precise failures. Extend it whenever you add a feature; a
feature with no assertion is a feature nobody will notice breaking.

**If a suite passes alone but fails in the full run**, and the failure is an
aborted CDP socket on its *first* command, it is orphaned browsers, not your
code — see the last bullet of SKILL.md's gotchas. Both the driver and the
runner now sweep them by profile directory; that was found the hard way when
adding the sixth suite pushed the leak past twenty processes.

### Three techniques that make this app testable

Worked out on 2026-08-28 and worth reusing rather than rediscovering.

**Load any document you like.** Copy `index.html`, splice your own JSON into
its `#state-data` tag (the same operation `buildPublishHtml()` performs), drop
it in this folder and open it. The result is byte-for-byte a "saved project",
so it exercises the real load path — including `migrateRows()` on
deliberately old-shaped data with fields missing. Delete the copy afterwards.

**Catch an export without a download.** Downloads are blocked in the pane, but
every export goes through `deliverFile()` → `URL.createObjectURL`. Hook it:

```js
window.__caught = [];
var real = URL.createObjectURL.bind(URL);
URL.createObjectURL = function (b) { window.__caught.push(b); return real(b); };
HTMLAnchorElement.prototype.click = (function (c) {
  return function () { if (this.download) return; return c.apply(this, arguments); };
})(HTMLAnchorElement.prototype.click);
```

then read `await window.__caught[0].text()`. For the `.docx`, the zip is
store-only, so you can walk its local file headers in plain JS and parse
`word/document.xml` with `DOMParser` to check the tables are well-formed. The
PDF's content stream is uncompressed — `/1 0 0 1 (x) (y) Tm \((.*)\) Tj/`
gives you every drawn string and its position, which is how you prove a new
column doesn't run past the right margin. Note that PDF text is drawn one
**word** per `Tj`, so searching for `"Have it"` finds nothing; look for
`Have` and `it` on the same `y`.

**Drive the three-way merge.** Write `{base, mine}` into
`sessionStorage["splitpage-conflict-stash"]` and reload: `applyStashedWork()`
merges your `mine` against the file's own state on load. In hosted mode there
is a better way — publish a document, `PUT` a change to it with raw `fetch()`
as if you were a second collaborator, then edit and Save in the UI. That drives
the real 409 path end to end.

**A hosted test server without Node.** This machine has neither Node nor
Docker, so `server/server.js` cannot be run here. There is a PowerShell test
double implementing the same `/api` contract in the session scratchpad
(`testserver.ps1`), which is enough to exercise the entire client. **It bit
back once:** PS 5.1's `ConvertFrom-Json | ConvertTo-Json` round trip mangled an
em dash into mojibake, which fed the merge three genuinely different strings
and manufactured a conflict that looked exactly like a real bug in
`mergeStates()`. The fix was to stop parsing state in the double at all and
slice the raw `"state"` bytes out of the request body. If you write another
harness: never round-trip the document through PowerShell's JSON cmdlets, and
read files with `[System.Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes(...))`
rather than `Get-Content -Raw`, which decodes with the ANSI codepage.
Version history is the other round-trip: `pushSnapshot()` stores
`cloneState(state)` in `localStorage`, and restoring runs it back through
`migrateRows()` — so restore-then-restore-back proves a new field survives
serialisation *and* migration.

---

## 3. Architecture: five things that will bite you

### 3.1 The page *is* the database

`<script id="state-data" type="application/json">` holds the entire document.
On load, `defaultState()` parses it. On save, `buildPublishHtml()` splices the
current state back into **`PAGE_SHELL`** — a copy of the pristine served page
captured on the very first line of the app script, before the DOM goes live.

Consequence: a saved `.html` file is a complete, self-contained project. That's
why File ▸ Open accepts `.html` and reads the state straight back out.

Never serialise the live DOM to save. `PAGE_SHELL` exists precisely to avoid it.

**Since 2026-08-28 there is a second home for a document: a server.** When the
page is served by `server/server.js`, the state can live in a JSON file on the
server instead of inside the page, and Save does an HTTP compare-and-set rather
than a file write. This is strictly additive — `file://`, plain static hosting
and local `.html` files all behave exactly as before, because `detectServer()`
probes `/api/health` and everything hosted stays hidden when that fails. The
two homes are mutually exclusive by construction: opening a server document
clears `htmlFileHandle`, and opening a local file clears `serverDoc`, so Save
is never ambiguous about where it writes. See §3.6 and DEPLOY.md.

### 3.2 `migrateRows()` is the only door

Everything arriving from outside the page — a file on disk, a restored
snapshot, a merged stash — goes through `migrateRows(s)`. It normalises and
sanitises every field. It is the single choke point where untrusted input
becomes trusted state.

**If you add a top-level state field, you must add it in two places:**

1. `migrateRows()` — default it, clamp it, validate it. Old files won't have it.
2. `mergeStates()` — the merged object literal. **A field missing here is
   silently destroyed on every merge.**

That second one is not hypothetical: `people` and `productionTags` were both
missing from the merge literal and were being wiped, taking every crew
assignment and every tag note with them. Found by reading, not by testing.

### 3.3 Tags are atomic — this invariant is load-bearing

`.tag-anchor` spans carry `contenteditable="false"`, set in `walkSanitize()`
(the one place tags are ever reconstructed). This makes a tag a single
indivisible unit: the browser will not place a caret inside one, so typing
can't grow it and backspacing can't shrink it into no longer matching its own
stored `data-tag-name`.

Several bugs came from violating this. **Anything that mutates text must skip
`.tag-anchor` content.** Find & replace does this via `editableTextNodes()`;
if you add another text-mutating feature, do the same. Renaming a tag is the
Production panel's job — it changes the label and the tracked item together.

### 3.4 Tags are derived; the *registry* is not

Which scenes a tag appears in, and how many times, is always read live out of
the script text (`collectTags()`). But **which items are tracked at all** is
real persistent storage: `state.productionTags`.

This is a deliberate departure from the original "tags need no bookkeeping"
design. The reason: a prop someone is already sourcing shouldn't vanish from
the breakdown because the line mentioning it got cut. Items that disappear from
the script become **orphaned** — kept, flagged "Not in script", deletable only
on purpose.

`productionEntries()` merges the two: registry for membership, live script for
mentions, plus `owner`, `notes` and `status`. It also self-heals live tags
missing a registry entry, quietly, without marking the document dirty.

**That self-heal is why bulk delete strips labels.** Removing only the
registry entry of an item that is still tagged in the script is a no-op —
`productionEntries()` puts it straight back on the next render. So
`bulkDeleteSelected()` calls `removeTag()` as well, and the armed button says
how many of the script's labels are about to go. The single-card flow stays
two-step (Remove label → the item orphans → Delete from list) because there
you can see one item and mean one thing; a bulk selection is normally a mix of
live and orphaned, where the two-step is the wrong shape.

The selection itself (`productionSelection`) is **UI state only** — never
serialised, never in `migrateRows()` or `mergeStates()`. It is keyed by
`registryKey()`, which changes when an item is renamed, so
`pruneProductionSelection()` drops keys that no longer resolve and every bulk
action re-resolves keys to entries before writing.

**Read the panel through `productionEntries()`, never `collectTags()`.**
`collectTags()` returns only `{key, cat, name, mentions}` — no owner, no
status. The Shoot view used it and printed `item.owner` against every item,
which was silently always `undefined`, so "who's responsible" never rendered
there at all. Fixed 2026-08-28. If a view needs anything the *registry*
stores, it has to come from `productionEntries()`.

### 3.5 Comment boxes share the script's event handlers

The comment composer and every reply box use the same `.cell-editable` class,
and their events bubble to the same handlers as real script cells. Gate
anything script-specific on **`isScriptCell(cellEl)`**.

Two real bugs came from not doing this: typing `[boom pole]` in a *comment*
created a tag and registered a phantom production item; Ctrl+Enter in a comment
spliced a new scene onto the top of the document.

**The writer is the other side of the same coin.** Its paragraphs *are* script
cells — same `data-id` / `data-field`, same row behind them — so `isScriptCell`
deliberately accepts `#writer-doc` as well as `#rows`, and the writer gets
tagging, Tab-completion, Ctrl+B, paste-as-plain-text and the sanitiser without
a line of its own code. That is the whole design; see §3.9.

---

### 3.6 The merge was dormant for months — now it runs

`mergeStates()`, `baseState`, the `rev` compare-and-set, the conflict stash and
the "Unmerged edit" comment cards all came from the app's artifact days, where
saving published to a hosted copy. Converted to standalone, none of it had
anything to compare against and it sat unused. Hosted mode is what it was
written for, and wiring it up was mostly plumbing.

The save loop lives in `saveToServer()`:

1. `PUT /api/docs/:id` with `baseRev` = the rev this view loaded.
2. `200` → store the new rev, `baseState = published`, done.
3. `409` → the server returns **their whole state**. Three-way merge
   `(baseState, state, theirs)`, take the merged result, retry against their
   rev. Bounded to 3 rounds.

**`baseState` is the load-bearing part.** It must be exactly what the server
last confirmed. If it drifts, every field where all three versions differ is
reported as a conflict rather than merging, because `mergeRow()` falls through
to the conflict branch when `b` is missing or unequal. Any new save path must
set `baseState` to the state it successfully sent — nothing else.

Two traps found while building it:

- **`reportMerge()` ends with `markDirty(); queueAutoSave();`**, which is right
  when a merge arrives on load and wrong when it happened *during* a save —
  it queued a second write of identical content, and every needless rev bump
  pushes every other viewer into a 409 and a merge they didn't need. Hence
  `reportMerge(result, { alreadySaved: true })`.
- **`stashLocalWork()` was dead code** — defined, never called, left over from
  the artifact shell's forced reload. The lapsed-session path now calls it, so
  "your unsaved edits are kept" is a promise the app actually keeps. It is
  paired with `splitpage-server-resume` in sessionStorage, and
  `applyStashedWork()` deliberately **skips** a stash when that key is present:
  the stash belongs to a document on the server, and merging it into the page's
  own embedded default would splice someone's script into a blank document.
  `resumeServerDoc()` owns that case.

### 3.7 The server

`server/server.js` — plain Node, no dependencies, ~400 lines, deliberately
small enough to audit by reading. One JSON file per document in `DATA_DIR`;
that is the entire database.

- **No authentication, on purpose.** Cloudflare Access sits in front. The
  server only ever *reads* `Cf-Access-Authenticated-User-Email`, for display
  and attribution — never as a permission check, because by the time a request
  arrives Access has already made that decision. Do not add auth here without
  deciding it belongs here.
- **Document ids are whitelisted** (`^[a-z0-9][a-z0-9-]{0,63}$`), not
  sanitised — an id becomes a filename, and a whitelist can't be out-thought
  the way a blacklist can.
- **Writes are temp-file-plus-rename**, so a crash leaves the previous version
  intact rather than a half-written one, and **serialised per document id**
  (`withDocLock`) — Node is single-threaded but a read-modify-write spans
  `await`s, and without the chain two saves can interleave and the second can
  be written from a stale read, defeating the compare-and-set.
- **`Cache-Control: no-store` on every API response.** A cached rev would make
  a client think it is current and clobber.

---

### 3.8 Untagged mentions are painted, never wrapped

A breakdown item written into a visual cell as plain text is a mention nothing
counts — the item's `mentions` and its scene list are both short, and the
Shoot view is missing a scene. `scanUntaggedMentions()` finds them and offers
to label them.

**The paint is a CSS Custom Highlight, not a span.** `CSS.highlights.set()`
over live `Range`s. This is a remark *about* the document, not a change *to*
it, so wrapping it in markup would be wrong three times over: it would dirty
the file, land on the undo stack, and then have to be unpicked by the
sanitiser on the way out. Browsers without the API just don't get an
underline — feature-detected in `highlightApiOk()`, and the prompt still
works without it.

Things to know:

- **One highlight for all categories, not one per category.** Per-category
  colour would mean a *second* place a new `TAG_CATEGORIES` entry has to be
  registered in CSS (invariant 14 exists because that was already missed
  once). The prompt names the category in words instead.
- **One alternation regex for the whole registry**, longest name first so
  "gaffer tape" beats a "tape" entry inside it. Scanning each cell once per
  entry instead is fifty passes over the document on a fifty-item breakdown.
  Word boundaries use the same test as `tagFieldOccurrences()`, so "tape"
  never matches inside "tapered".
- **`render()` invalidates every stored Range**, so it schedules a re-scan.
  Debounced — nothing is wrong in the meantime beyond a missing underline.
- **Accepting goes through `execCommand("insertHTML")`**, like every other
  route to a tag in this file, so one Ctrl+Z puts the plain words back. The
  span keeps the casing that was *written*; `data-tag-name` keeps the
  registry's. That split is what stops labelling "Gaffer Tape" from forking a
  second breakdown item.
- **Tab is shared.** The ghost wins outright — you typed a bracket, so you
  asked for it. The untagged prompt only gets Tab when no ghost is in flight.
- **Visual column only**, deliberately: that column is what is physically in
  front of the camera, which is what the breakdown is a list of.

---

### 3.9 The writer edits rows, it does not import a document

The obvious way to build a word-processor view of the audio column is to join
every row into one blob of text, let the user edit it, then split it back into
rows on the way out. **Don't.** That is a lossy round trip — it has to guess
where the scene boundaries went, and every tag anchor, comment anchor and
`<strong>` in the document is riding on those boundaries.

What is there instead: **one paragraph is one row's `audioText`**, rendered as
a real `.cell-editable` carrying that row's `data-id` / `data-field`. There is
no parse step and no second copy of the document. `syncFieldFromDom()` writes
each keystroke straight back to the row, exactly as it does in the split view,
which is why closing the writer needs nothing but `render()`.

That leaves only the two operations that genuinely change the row *list*:

- **`splitWriterRow()`** — Enter. Extracts caret-to-end of the paragraph into a
  brand-new row spliced in after it, with an empty visual.
- **`mergeWriterRows()`** — Backspace at the very start (Delete at the very
  end). Joins the audio, then deletes the row. It **refuses** when both rows
  have a visual, because one of the two shot descriptions would have to be
  destroyed and a single keystroke must not do that silently.

Things worth knowing before changing it:

- **`onWriterKeydown` runs in the CAPTURE phase** on `#writer-doc`, ahead of
  the shared `onRootKeydown` bound to the same element. Enter means "new
  scene" here and `<br>` there; only a capture listener can get in first and
  `stopPropagation()` so the other doesn't also act on the keystroke.
- **`onRootClick` is deliberately NOT attached to the writer.** Its actions
  (open the production panel on this tag, jump to that scene) all reach for
  the split view's DOM, which is stale behind the overlay until the writer
  closes.
- **`renderWriter()` preserves the caret** as `(rowId, characters into that
  row)` — the only form that survives the paragraphs being rebuilt. It has to:
  `render()` calls it too, and `render()` can fire mid-sentence when a hosted
  merge lands from the server.
- **The gutter hangs in the margin** (`position: absolute; right: 100%`) rather
  than sitting in the flow. In the flow it pushes the prose column visibly
  off-centre, which is the one thing a page you write on cannot afford. Under
  1000px there is no margin to hang in, so it becomes a line above each
  paragraph instead.
- **`data-gutter` on `#writer` is a three-state setting**, not a toggle:
  `visuals` (number + what's on screen), `numbers`, `compact` (nothing).
  Compact adds `margin-bottom` to each block, because with nothing marking the
  joins a page of scenes otherwise reads as one undifferentiated block and you
  cannot see where Enter and Backspace will act.
- **The column is `clamp(640px, 60vw, 1100px)`, and the gutter's margin is
  what that leaves.** Tying the width to the window means the margin beside it
  shrinks as the window does, so the 162px the hanging gutter needs is not
  guaranteed by construction — it is why the stacking breakpoint is 1100px
  and not 1000px, and why `08-writer-width.txt` exists to check the tightest
  case (1150px) rather than trusting the arithmetic. Change one of those three
  numbers and you have to re-check the other two.
- **Text size is `--wr-font` on `#writer`**, set inline by the slider so it
  reaches every paragraph and outranks the stylesheet. The phone's smaller
  default is a *different value of the variable*, not a `font-size` override —
  otherwise it would win over a size the writer had actually chosen. The
  floor is 16px because iOS zooms the page on focusing anything smaller. It
  lives in `localStorage`, not the document: it is about the reader, and
  saving it into the file would push it onto whoever opened it next.
- **`.writer-scroll` sets `scrollbar-gutter: stable both-edges`.** Without it
  the centred column jogs sideways the moment the document grows past one
  screen and the scrollbar appears — under the cursor, mid-sentence, caused by
  the words being typed. `06-writer.txt` asserts the column's left edge is
  identical in compact and visuals mode, which guards this *and* the gutter
  staying out of the flow.

The narration exports (`buildNarrationText`, `buildNarrationDocx`) are the same
idea pointed outward: one paragraph per row, blank line between, which is the
exact shape `splitImportText()` reads back in paragraph mode — so the scenes
survive a round trip, apart from the title line, which comes back as one extra
row. That was the trade: a narration document handed to somebody else needs a
title far more than the round trip needs to be exact to the row.
`packDocx()` was split out of `buildDocx()`
so the narration document reuses the page setup, relationships, styles and zip
rather than growing a second copy of them.

## 4. State schema

```jsonc
{
  "title": "string, plain text, ≤300 chars",
  "schema": 2,                  // SCHEMA_VERSION
  "rev": 0,                     // bumped per save; drives conflict detection
  "lastEditedBy": null,
  "lastEditedAt": null,
  "wordsPerMinute": 150,        // clamped 60–400; drives runtime estimates

  "rows": [{
    "id": "r1",
    "visualText": "sanitised HTML",
    "audioText":  "sanitised HTML",
    "visualImage": "data: URI or null",
    "status": "todo | ready | shot",
    "updatedAt": "ISO", "updatedBy": "name"
  }],

  "comments": [{
    "id": "c1", "rowId": "r1",
    "field": "audioText | visualText | visualImage",
    "anchorId": "c1",           // matches a .cmt-anchor span in the row HTML
    "quotedText": "plain text",
    "author": "name", "body": "sanitised HTML",
    "resolved": false, "kind": "anchor | conflict",
    "createdAt": "ISO", "updatedAt": "ISO",
    "replies": [{ "id": "rp1", "author": "name", "body": "HTML", "createdAt": "ISO" }]
  }],

  "people": [{ "id": "p…", "name": "Jordan" }],   // crew list; nothing verified

  "productionTags": [{
    "cat": "prop | location | cast | vfx | sound",
    "name": "Camera Rig",
    "owner": "p… or ''",        // → people[].id
    "notes": "plain text, ≤2000",
    "status": "needed | sourcing | have | returned"   // TAG_STATUSES order = rank
  }]
}
```

`productionTags[].status` merges **by rank**, like `rows[].status` does: the
further-along side wins, so a merge can never un-buy a prop somebody bought.
`owner` and `notes` still merge "filled beats empty".

Note `ROW_FIELDS = ["visualText","visualImage","audioText"]` — that's the list
the merge reconciles *as content*. `status` is merged separately, by rank
(`todo < ready < shot`), so a merge can never un-shoot a scene someone filmed.

**Browser storage** (not in the document — follows the reader, not the file):

| Key | Purpose |
| --- | --- |
| `splitpage-comment-author` | your name for comments/attribution |
| `splitpage-snapshots` | local version history (max 12, ~1.2 MB budget) |
| `splitpage-conflict-stash` | sessionStorage; survives a forced reload |
| `splitpage-conflict-reloaded` | sessionStorage reload guard |
| `splitpage-tagging-help-dismissed` | quick-reference strip dismissed |
| `splitpage-files` (IndexedDB) | the `FileSystemFileHandle` for resume-on-launch |

---

## 5. Invariants — break these and data goes quietly wrong

1. **Edit with the Edit tool, one site at a time.** Never in-place regex
   substitution (`sed`/`perl -pi`) on `index.html`. There is no git to restore
   from. A speculative `|| perl -pi -e 's/…/PLACEHOLDER/g'` one-liner in this
   session wrote `PLACEHOLDER` into five call sites; it was caught and fully
   repaired, but nothing would have caught it automatically.
2. **Mutate text by walking text nodes, never by regexing HTML.** A regex over
   markup will happily rewrite the inside of an attribute — a tag's stored
   name, a link's `href`, a comment anchor's id — and corrupt things that only
   surface much later. See `replaceInHtml()` / `tagFieldOccurrences()`.
3. **Never touch text inside `.tag-anchor`** (§3.3).
4. **New top-level state field ⇒ update `migrateRows()` *and* `mergeStates()`**
   (§3.2).
5. **Gate script-only behaviour on `isScriptCell()`** (§3.5).
6. **Don't run document-wide scans per keystroke.** Reading tags back parses
   every field of every row. Wire expensive refreshes through
   `scheduleProductionRefresh()` (180 ms debounce).

   Since 2026-08-29 there are two more layers under that, and new code should
   use them rather than working around them:

   - **`contentMemo()`** wraps the two per-field parses (`tagsInField`,
     `wordCount`). It is keyed on **the field's HTML itself**, not a document
     version counter — deliberately, because a content key cannot go stale.
     There is no mutation site anyone can forget to invalidate, which is the
     failure mode of a version counter and the one that would quietly show
     the wrong breakdown. Its budget is in **characters, not entries**: a
     field can hold a pasted image as a data: URI (`walkSanitize` allows
     `<img>`), so an entry-count cap would have been a leak measured in
     gigabytes.
     *The arrays it returns are shared — read them, never mutate them.*
   - **One scan per render.** `renderProduction()` calls
     `productionEntries()` once and threads the array into pruning, the list,
     the bulk bar and the badge. They used to call it separately: four reads
     of the same document in one synchronous pass.

   Measured at 120 scenes / 240 tags: a debounced refresh was ~840 DOM
   parses (one scan = 240 parses = 2.9 ms); it is now **2**.

7. **Repaint a row, don't re-render the document.** `render()` rebuilds every
   row (13 ms at 120 scenes) — fine for structural changes, wrong for
   changing one dot. `cycleRowStatus()` uses `paintRowStatus()` instead:
   0.4 ms, and focus-safe, so a caret mid-sentence survives. It mirrors the
   status markup in `rowHtml()` — change one, change the other.
8. **Escape values going into CSS attribute selectors** with `cssAttr()`.
   Stripping quotes isn't enough — a backslash in a tag name reads as a CSS
   escape and silently matches nothing.
9. **Markdown table cells need `mdCell()`**; a `|` in a note shears the row.
10. **`sanitizeHtml()` on anything reconstructed** before it re-enters state.
11. **A control nested inside `.tag-entity-head` must be checked *before*
    `tag-expand` in the click delegation.** The head is itself the expander,
    and the delegation is a sequential `if` chain — whichever branch matches
    first wins, so a later branch would both fire *and* toggle the card open.
    See the `tag-status-cycle` branch.
12. **A modifier-click on a breakdown card is the multi-select gesture and
    outranks every control inside the card.** It is checked at the very top of
    the click delegation, before the status pill, Rename, and the expander.
    That is deliberate: "Ctrl+click anywhere on a card selects it" is only a
    reliable target if it holds over the controls too. A new control added to
    a card inherits this for free — but a new control added *outside* a card
    that wants modifier-clicks of its own has to be checked ahead of it.
13. **Two different drags share the root handlers.** A file coming from the
    desktop and a scene being reordered both hit `onRootDragOver/Drop`. The
    image branch is gated on `isFileDrag(e) && !dragRowId` — without both
    halves, dragging a scene across another scene's visual column gets
    swallowed by the image handler and reordering silently stops working.
14. **A new `TAG_CATEGORIES` entry needs a matching
    `.tag-anchor[data-tag-cat="…"]` CSS rule.** Category colour in the panel
    comes from the JS table, but the colour of the tag *in the script* comes
    from CSS. `sound` was added to the table without the rule and rendered in
    the default green for weeks. Fixed 2026-08-28.
15. **The writer never re-parses the document into rows** (§3.9). A paragraph
    is a row's `audioText`, bound through `.cell-editable`. Anything that
    changes the row *list* from in there goes through `splitWriterRow()` /
    `mergeWriterRows()`, and anything that rebuilds its DOM goes through
    `renderWriter()`, which is what puts the caret back.
16. **Anything that opens over the whole screen must close the side panels.**
    `openWriter()` closes Production, Comments and the find bar. The writer
    sits at `z-index: 145` — above the panels (140), below the modals (150)
    and the toasts (200), which still have to be able to speak over it.
17. **A hint about the document must never edit the document** (§3.8).
    Untagged mentions are painted with the CSS Custom Highlight API over live
    Ranges. Anything that wraps text in a span to draw attention to it dirties
    the file, lands on the undo stack, and has to be unpicked by the
    sanitiser.
18. **There are two Save buttons and one save state.** The header's and the
    writer's go through `setSaveButtons()`; the writer's file chip is copied
    from the header's rendered state by `mirrorFileChipToWriter()`. Nothing
    addresses either one directly, so they cannot drift into disagreeing
    about whether there is anything to save.

---

## 6. Map of `index.html`

CSS ends around line 1750; the app script runs from there to the end.

| Section | Line |
| --- | --- |
| scene status and runtime | 1831 |
| state / `migrateRows` | 1906 |
| sync: identity, snapshots, **merge** | 2060 |
| sanitizing rich text (`walkSanitize`) | 2628 |
| rendering (`rowHtml`, `render`) | 2847 |
| rich text commands | 2984 |
| row actions (add/move/**drag**) | 3224 |
| **production tags** (registry, people, panel, shoot view) | 3375 |
| **find & replace** | 4613 |
| comments | 4857 |
| import | 5317 |
| save / export | 5602 |
| docx write / read | 5979 / 6230 |
| csv | 6560 |
| pdf | 6678 |
| local documents: open, save back | 7079 |
| **the narration on its own** (narration .txt / .docx) | 7711 |
| **the writer** (word-processor view of the audio column) | 9092 |
| **teleprompter + voice follow** | 9464 |
| events + `init()` | 9886 |

Line numbers drift with every edit — grep for the section banner text instead.

---

## 7. Current status

### Built and verified live

Tagging shortcuts `[prop]` `{location}` `~vfx~`, Tab autocomplete (category-aware,
falls back across categories and says so), Music/SFX split out from VFX,
production registry with orphan warnings, crew list + per-item owner + notes,
per-item status (Needed/Sourcing/Have it/Returned — cycling pill on the card,
segmented control in the open card, shown in the Shoot view, in all five
exports, and rank-merged), Ctrl/Shift+click multi-select in the breakdown with
bulk assign / add-person / status / delete, reference images behind a small
paperclip with the whole visual column as the drop target,
group by Category/Person/Scene/Shoot, CSV + Word + PDF + Markdown + text
exports carrying the breakdown, runtime estimates, scene status
(To do/Ready/Shot) with teleprompter skip, find & replace, drag-to-reorder with
a visible grip, Ctrl+Enter for a new scene, dismissible tagging reference.

All exercised in a real browser: round-tripped through a real save and reopen,
checked against old-schema files with none of the new fields, and DOCX/PDF
output verified as well-formed by unzipping and parsing.

Mobile (2026-08-29): the phone layout and every touch translation, tested in
the pane's mobile emulation (375×812, real touch translation, hover:none):
stacked labelled cells, horizontal gutter strip, tag typing shortcuts, **tap
the ghost** to accept a completion (Tab doesn't exist on phone keyboards),
Find & replace from the File menu, **long-press** to start a breakdown
multi-selection then taps to toggle (scroll-drift cancels the press; the
trailing click is swallowed; desktop Ctrl/Shift+click unchanged and
re-verified), touch-visible image Replace/Remove, full-screen panels and
modals, teleprompter layout, and a screen wake lock while presenting
(acquired on open, released on close, re-acquired on tab return). Layout
verified overflow-free at 375px. Three real bugs found and fixed in the
process: a bare `1fr` grid track blown out past the viewport by the focus
toolbar's min-content (fix: `minmax(0, 1fr)`), a content-box `max-width:100%`
toolbar 6px wider than its cell, and the status segment's nowrap labels
min-contenting wider than a phone card.

Mobile touch-translation notes for future features:
- `IS_TOUCH` (`matchMedia("(hover: none)")`, read once at load) is the switch
  the touch behaviours key off. Anything hover-revealed needs a
  `@media (hover: none)` always-visible rule; anything modifier-key-driven
  needs a touch gesture.
- The long-press machinery (`wireTouchSelection`) is delegated on
  `#production-list`, which survives re-renders. It swallows the click that
  follows a fired press *in capture phase* — remove that and every long-press
  also expands the card.
- Keep every text input at ≥16px inside the mobile media query, or iOS zooms
  the page on focus.

The writer + narration exports (2026-08-31): the whole surface is covered by
`tests/06-writer.txt` (70 assertions) and a phone pass at the end of
`05-mobile.txt` — one paragraph per scene with the visual as non-editable
gutter context; Enter splitting at the caret with the tail and the cursor both
moving and the new scene getting an empty visual; Backspace joining with no
invented double space; the join refused when both scenes carry a visual;
`[boom pole]` tagging and Tab-completing an existing tag name from inside the
writer; Ctrl+B and the bar's own buttons landing as real `<strong>`/`<em>`
after the sanitiser; the gutter cycling visuals → numbers → compact with the
writing column proved not to move between them; the text-size slider driving
the writing and not the chrome, and storing the choice per reader rather than
per document; Save and the file chip agreeing with the header's; Escape; and
everything arriving in the split view the moment it closes. The column's
window-scaled width is checked separately, at 1150px, in
`08-writer-width.txt` — the tightest window the hanging gutter still has to
fit beside. Narration `.txt` verified to carry the
audio and *only* the audio (no visual column, no breakdown, no comments) in
the blank-line-separated shape the importer reads back, and the `.docx`
verified by unzipping it: parses, has the narration, and is flowing paragraphs
rather than the two-column table every other export produces. The
empty-narration guard was checked by hand.

Untagged mentions (2026-08-31): `tests/07-untagged.txt` plus a phone pass in
`05-mobile.txt`. A registry item written into a visual cell as plain text is
found and underlined *without* the document changing — asserted directly:
zero `.tag-anchor` in that cell while the prompt is up, and the highlight
registered with the Custom Highlight API. The prompt names the category it
would land in; Escape mutes it for that cell and typing brings it back; Tab
(desktop) and a tap (phone, where there is no Tab) both label it as an atomic
`contenteditable="false"` anchor without forking a second breakdown item; and
the item's card then reads the mention count it was previously short of.

Hosted mode (2026-08-28): server detection, Access identity auto-fill,
publish, open-from-server, compare-and-set save, clean auto-merge of edits to
different scenes, same-field conflict raised and preserved as a comment,
lapsed-session detection, and the full sign-out → reload → resume-and-merge
cycle — all exercised in a real browser against the API contract.

### NOT verified — say so, don't imply otherwise

- **No real phone has touched the mobile interface.** Everything above ran in
  Chromium's mobile emulation — real touch translation, but not a real iOS
  Safari (its keyboard/viewport dance is famously its own thing) or a real
  Android keyboard (which commits text in odd chunks — the auto-tag guard
  handles that in principle, `e.data` ends-with check, but it has only been
  proven against synthetic events). First thing to do on a real phone: type
  `[a prop]`, long-press a breakdown card, and run the teleprompter for a
  minute to see the wake lock hold. Add to that list: **press Enter in the
  writer.** Splitting a scene hangs off a real Enter keydown, and a soft
  keyboard's Enter is exactly the kind of key that arrives differently — an
  Android IME may commit it as text, and iOS may send it with no `key` at all.
- **`server/server.js` has never been executed.** No Node and no Docker on the
  dev machine. It parses, and it was checked line by line against the contract
  the client actually calls, but every client-side test above ran against a
  PowerShell double implementing the same API — not against this file. The
  first real run will be on Unraid. §2 of DEPLOY.md is the smoke test: build,
  `curl /api/health`, publish a document, open it in a second browser.
  Treat anything in that file as unproven until that passes.
- **Cloudflare Access has never been in the loop.** The identity header and the
  lapsed-session path were tested by simulating what Access sends (an email
  header, and an HTML sign-in page where JSON was expected). The real thing may
  differ in details — particularly whether the login page arrives as a redirect
  or a 200, which `apiFetch()` handles both of.
- **Follow My Voice against real speech.** The microphone is blocked in the
  agent sandbox. The 60-second re-prompt fix (holding one `getUserMedia` stream
  for the whole session, so restarts never re-request the mic) is verified
  structurally — `getUserMedia` is called from exactly one place, restarts only
  call `recognition.start()`, and acquire/release is balanced on every path —
  but a live read has never been done. **Ask Adam to confirm via `start.bat`.**
- Firefox/Safari fallback paths (no File System Access API) are coded but
  untested; only Chromium was available.
- Touch devices. HTML5 drag-and-drop doesn't work on touch; the ↑/↓ buttons are
  the deliberate fallback.

---

## 8. Where to pick up

**Immediate:** get Adam to confirm voice follow works over a real 2-minute read.
That's the one open loop.

**Pitched and accepted, already built:** runtime estimates, scene status, shoot
order, find & replace, drag reorder.

**Pitched and explicitly deferred:**

- *Custom tag categories* — five covers it; more becomes admin.
- *Cost/budget fields on production items* — a spreadsheet is better at that,
  and the breakdown already exports to one.

**Natural next steps nobody has committed to.** Pitched 2026-08-28; Adam took
none of them and went off to actually use the tool instead, which is the right
call — the two bugs found that day (sound-tag colour, Shoot-view owners) had
both shipped and gone unnoticed, which is what happens to features that are
verified but never lived with. Ask what annoyed him in real use before
reaching for this list.

1. *Per-scene shot notes / take log.* Status covers To do → Ready → Shot, but
   there is nowhere to write "take 3 was the one". That currently goes in a
   comment, which is a review channel, not a production one.
2. *Duplicate scene.* Copy text, image and tags into a new row below — fresh
   id, status reset to `todo`, comments deliberately not copied.
3. *Teleprompter countdown.* 3-2-1 before scrolling starts.
4. *Group the breakdown by status.* Category/person/scene/shoot exist; the
   "what is still not in hand" view is the one you would check the night
   before a shoot, and it is the obvious follow-on from per-item status.
5. *Call-sheet export.* The Shoot view already holds the right data — location
   blocks, scenes, what is needed, who is on it, what is in hand — but it
   cannot leave the screen. The one item on this list that produces something
   handable to another person.
6. *Word-level teleprompter scrub*, for restarting a take mid-scene.

**Noticed, deliberately not changed:** opening a `.docx`/`.md`/`.txt`/`.csv`
replaces `state.rows` and the title but leaves `productionTags`, `people` and
`comments` from the previous document in place (see the `openAnyLocalFile`
tail). Every carried-over item then shows as "Not in script". That reads as a
bug until you consider the common case — pasting a revised draft of the *same*
project, where you very much want to keep the props you are already sourcing.
Left alone on purpose. Worth asking Adam before changing it either way.

---

## 9. Working with Adam

- **Get sign-off on anything that changes what they type** — delimiters,
  shortcuts, auto-formatting. Syntax used daily becomes muscle memory and is
  expensive to change. When offered four tag delimiters at once, they took one
  and came back for the rest later, once it had proven itself.
- **Everywhere else, they hand over full autonomy** and expect work delivered,
  not discussed: *"Build em!"*, *"whole file, fix everything you find"*.
- **They report bugs precisely — take the details literally.** *"it seems to ask
  for permission every 60 seconds"* was the entire diagnosis of the microphone
  bug; 60 s is exactly Chrome's speech-session limit.
- **Report honestly.** State what was verified, how, and what wasn't. If
  something went wrong — including your own mistake — say so plainly and show
  the repair. That has been the norm here and it's worth keeping.
