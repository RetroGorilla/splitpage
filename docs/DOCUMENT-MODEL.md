# Structured document model — design (issue #85)

Status: **built** (2026-09-23), with the few leftovers §10 names — the
model (`04c-doc-model.js`), registry ids, the readers, every edit of a
script cell (`05b-cell-edit.js`, `05c-clipboard.js`, the tag panel, split
and join), undo (`12a-undo.js`) and the word-level merge. Adam made the
decisions in §12; the sections below reflect them. Not yet run on Windows:
the by-hand pass in `docs/WINDOWS-CHECKS.md` covers it with the rest.
#85 ships in the 3.0 pre-releases (from 3.0.0-beta.1) and in 3.0.0.

Line numbers are from `main` at `53eb67d`.

---

## 1. The problem

Each row's two cells, `visualText` and `audioText`, are HTML strings. The
editor is `contenteditable`, and `syncFieldFromDom()` (05-render.js:623)
copies `innerHTML` into state on every input event, unsanitised until the
cell loses focus. Everything else in the document is built on top of that
string:

| Construct | How it is stored today |
| --- | --- |
| Tag | `<span class="tag-anchor" data-tag-cat data-tag-name contenteditable=false>` — the registry is keyed by **category + name**, not an id |
| Comment anchor | `<span class="cmt-anchor" data-cmt>` **plus** `comment.rowId` / `comment.field` — anchored twice (invariant #18) |
| B-roll marker | `<span class="broll-key" data-broll-id contenteditable=false>B-roll:</span>`, then the shot name as ordinary text up to the next `<br>` |
| Formatting | `<strong> <em> <u> <s> <mark>`, `<a href>` (http, https, mailto) |
| Line break | `<br>` — the only structure a cell has |
| Pasted picture / video card | `<img data-blob>` / `<a class="video-embed-card">` — reachable in a cell only by pasting HTML |

What that costs, with the current numbers:

- **33 write paths** put cell HTML into state. 19 of them don't sanitise at
  the moment they write (typing, Enter, B/I/U, highlight, link, tag
  shortcuts, Tab completion, b-roll capture, writer row join, review-session
  anchors, `.docx`/`.csv` import, a reload). The sanitiser only catches up on
  blur.
- **Every reader re-parses HTML**: render, 5 exporters, the teleprompter,
  find/replace, word count, the production index, b-roll, comments, the
  on-disk merge review, the server's reviewer anchor check, and the blob
  reference scan. Readers have to skip tag spans (invariants #2, #3). A
  match across a formatting boundary is never found.
- **Renaming a tag re-parses and rewrites every cell** that has it
  (`eachTagSpan`, 07:1186).
- **Comment anchors drift.** A user can delete, split or paste an anchor.
  One comment id can end up in two rows, and `repointCommentsForRows()`
  exists to patch up after row changes.
- **Merge compares whole cells as strings** (`mergeRow`, 03-sync.js:339).
  Re-tagging a word on one side and fixing a typo on the other is a
  conflict. The loser's whole cell becomes an "Unmerged edit" comment.
- **Undo is three systems, none complete.** Native `contenteditable` undo is
  destroyed by every repaint. There is a one-level undo for split and move
  only. Version-history snapshots are the third. Ctrl+Z after deleting a
  row, applying a tag, posting a comment or Replace All does nothing.
- **`execCommand`** (deprecated) carries 17 editing calls, with per-browser
  fallbacks.

## 2. Goals and non-goals

**Goals**

1. One structured value per cell. Every reader and writer goes through it,
   and it is always valid.
2. Tags reference the registry **by id**. Renaming a tag touches one
   registry record.
3. A comment is anchored in one place only, and can't be duplicated by
   editing.
4. Merge at word granularity. Conflicts only where both sides changed the
   same words.
5. One undo/redo for everything a person does in a tab.
6. No `execCommand`.

**Non-goals**

- New formatting. No lists, headings, fonts or colours. Cells stay flat
  inline text with line breaks.
- Real-time co-editing (CRDT/OT). ROADMAP rejected it. Collaboration stays
  save, pull and three-way merge.
- Comments spanning rows. A comment stays inside one cell.
- Changing what anyone types. Delimiters, shortcuts and auto-tagging keep
  working exactly as they do (HANDOFF §9).

## 3. The model

A cell is an array of **runs**. A run is either text with marks, or the one
atomic inline object, the b-roll key:

```js
// a text run
{ text: "the red mug", marks: { b: true, tag: "t_8f2a", cmt: ["c12"] } }
// an atomic run
{ atom: "broll", id: "bs_41" }                   // the "B-roll:" key
```

**Marks**, all optional:

| Mark | Value | Notes |
| --- | --- | --- |
| `b` `i` `u` `s` `hl` | `true` | bold, italic, underline, strike, highlight |
| `dir` | `true` | a stage direction for the performer (#167, Audio column): stored as `<span class="stage-dir">`, nested just inside the comments; never on the b-roll key; its brackets are added by every reader, never stored; left out of `spokenText()` (the read time) and of the teleprompter's word spans |
| `href` | string | http, https or mailto only (`safeHref`) |
| `tag` | registry id | **at most one tag per run** — nested tags have no meaning |
| `cmt` | array of comment ids, sorted | comments may overlap |

**Line breaks** are `"\n"` inside `text`; a line feed inside an HTML text
node shows as a space (`white-space: normal`) and is read as one. No other
control character but tab is allowed. ZWSP never enters the model. A
no-break space **stays** — it is how two typed spaces survive `white-space:
normal` — and every reader treats it as a space (as `htmlToPlainText`
already does).

**Canonical form** is enforced by `normalizeCell()`:

- adjacent text runs with equal marks are joined
- empty text runs are dropped
- `cmt` is sorted and de-duplicated
- marks equal to `false`, `null` or `[]` are removed
- a `tag` or `cmt` id that doesn't resolve is removed
- across each stretch of one tag, `cmt` becomes the union, `href` the
  first one found and `dir` set if any of it was: a tag is one unit, so a
  comment, link or direction covers all of it or none of it — which is also
  what lets `toHtml` nest a tag inside its comments, directions and links
  without ever splitting it

Two cells with the same content are then the same JSON. That is what makes
comparison, merge and memoisation keys trivial.

**Why runs and not text-plus-ranges.** Ranges (`{start, end, type}` over a
plain string) handle overlapping comments well. But every text edit has to
shift every range after it, and a stale offset silently points at the wrong
words. Runs make an edit local, and overlapping comments are just a `cmt`
array. The issue's own sketch is runs.

**Tags are atomic in the editor, not in the model.** A tagged run is
ordinary text with a `tag` mark. The editor keeps the caret out of it and
deletes it whole, which matches today's `contenteditable=false`. The model
doesn't need a special node for it.

### 3.1 The registry gets ids (built, step 2)

`productionTags` entries gain `id`: `t_` plus a 64-bit hash of the entry's
key (category + normalised name) **at the moment it is created**, so two
people tagging the same thing independently mint the same id. A rename keeps
it. If the id a key would mint is already taken (a rename freed a name, and
the name came back as a new item), a counter goes on the end (`-2`).
`migrateRows` gives every entry one (`ensureTagIds`), so a file from before
ids, or an entry an older copy of the app merged without one, gets one on
load.

**Ids live in the registry only, not on the spans.** The stored HTML keeps
naming a tag by `data-tag-cat` + `data-tag-name` (D2), and a span's name is
always its entry's name (a rename rewrites the spans, as today). So (category,
normalised name) stays a unique key within a document, and the model resolves
a span to its entry's id through it: `registryTagHooks(registry)` gives
`fromHtml` its `tagId(cat, name)` and `toHtml` its `tagOf(id)`. Putting
`data-tag-id` on spans as well was dropped: every existing tagged cell's HTML
would change on its first load, an older copy of the app would strip the
attribute again (its sanitiser does not know it), and the server's reviewer
anchor check compares attributes — all churn in the whole-cell merge that
runs until step 6, for no gain the registry id does not already give.

- **Rename** changes `entry.name` and keeps `entry.id`. Until step 4 the
  spans are rewritten too; from step 4 cells hold ids and the HTML is
  written with the registry's current name, so a rename touches one record.
- **Remove** clears the mark from every run carrying that id.
- **Merge.** `mergeProductionTags` merges by id: a rename on one side and an
  assignment on the other are one item with both (a rename is taken from
  whichever side made it; both did, differently: theirs). Two ids that now
  name one item fold into the first, the way a rename onto an existing name
  already folds. The on-disk merge review lists the breakdown by id too.
- The one case ids do not fix: I rename an item while you edit a cell that
  still has the old name's span. Merged, your cell keeps the old name, and
  the heal gives it an entry of its own — as it does today.

### 3.2 Comments

A comment's anchor is the set of runs whose `cmt` contains its id. There is
no span to lose. `comment.rowId` / `comment.field` become derived and are
kept in step by one function, so the server and old readers still get them.
Invariant #18 goes away.
**Built:** that function is `syncCommentAnchors(state)` (04c): every
comment marked somewhere points at the first cell holding its mark, in
document order (row by row, visual before audio); one marked nowhere keeps
what it had. Split, join and a cut-then-paste call it in their own undo
entry, and `migrateRows` calls it, so every load and merge comes out in
step. HANDOFF invariant #18 now says this.

- Splitting a row moves the runs, and their marks move with them. Joining
  rows does the same. **Built:** `splitRowFieldCore` (06-rows.js) is
  `splitCell` at the caret; `mergeWriterRows` (19-writer.js) is
  `joinCells`, whose glue space carries a comment (or link) the text on
  both sides of it is in, so a phrase a split cut in two is one anchor
  again when joined back.
- **Copy** never copies a `cmt` mark. **Cut then paste** in the same tab
  moves it (D6).
  **Built** (`src/js/05c-clipboard.js`): a copy's clipboard HTML is the
  slice's `toHtml` with every `cmt` mark stripped. A cut keeps them and
  wraps the HTML in `<span data-splitpage-cut="nonce">`, the nonce random
  and held only in that tab's memory. A paste keeps `cmt` marks only when
  the HTML names the live nonce, and only for comments the document still
  has; the paste spends the nonce, so a second paste of the same cut, a
  drag, another tab's cut or another app brings words only. The moved
  comment's `rowId`/`field` follow it to the pasted cell in the same undo
  entry as the paste (`editCell`'s `also`).
- Deleting all of a comment's text leaves the comment **detached**
  (`anchor: null`). It still shows in the panel with its quoted text, which
  is today's behaviour for a lost anchor.

### 3.3 B-roll, pictures, video

The b-roll key is an atom with the shot id. The shot's name is still the
text after it up to the next line break, as today (08c:78-90). Only the key
is special. **It is the only atom.**

- **One id, one line.** The b-roll list finds a shot's record by its key's
  id, so no two keys in a document may share one. A copy of a key carries
  its id, so a **paste or drop** gives each pasted key a new id
  (`makeId("bs")`, as a typed key gets) whenever any key in the document
  has it, or any record in the list does; a key from another document whose
  id this one does not know keeps it. A **cut then paste** in the same tab
  (D6's nonce) is a move: the cut took the key out, so its id is free and
  it keeps it, and its shot — status, notes and all — is found by it again.
  Only another key holding the id then (the cut undone first, say) makes it
  a new one. A copy is a **new shot**: its record is made fresh in the
  paste's own undo entry, seeded from the scene it landed in the way a
  typed key's is, and nothing of the copied shot's status, notes, owner or
  location comes with it. Split and join move a key rather than copy it,
  and import brings only plain-text markers, which the anchoring pass keys.
  **Built:** `freshBrollIds` / `brollIdsTaken` (05c-clipboard.js),
  `recordPastedBroll` (08c-broll.js). A document that already has two keys
  with one id (pasted by an older version) is healed by the anchoring
  pass: the list reads the second as unanchored, a name match never takes
  a record a key further down still holds, and the pass gives the second
  key an id of its own. Tests: `clipboard.test.mjs`,
  `broll-model.test.mjs`, browser suite 80.

**Script cells hold no pictures or video cards (D7).**

- **Pasting.** A paste or a drop into a cell never puts them in it. Since
  #135 each one goes into the scene's **gallery** — its Image section — in
  the same undo entry as the pasted words (editCell's `also`): a picture
  (by its blob ref) is added after the ones there, and so is each video,
  as an item of its own: its link marked `poster`, with a thumbnail (a
  video file's first frame) or none (a placeholder). A link on a video host, a `<video>` and a
  video file count (a file by its name only: its bytes and its path are not
  the document's). #124 made a comment of each instead; comments it made
  stay as they are. The gallery's shape is `imageRef` (the first picture,
  unchanged), `imageLinks` (its caption) and `moreImages`
  (`[{imageRef, links}]`), 02d-gallery.js; the merge takes both sides'
  additions (a set merge, never a conflict).
- **Existing documents.** A picture or video card already inside a cell is
  **moved into a comment on the same scene** when the document is read:
  - The comment holds the picture (by its blob ref, #82) or the link.
  - It gets an id derived from the row id and the picture's sha or the
    link, so reading the document twice, or merging two copies that both
    moved it, makes one comment, not two.
  - It is a load-time normalisation like `healTagRegistry()`: it does not
    mark the document dirty on its own. It is written out with the next
    real save.
  - Nothing is lost: version history still has the original.
  - **Built:** paste and drop go through `fromHtml` with pictures and video
    cards taken out first and put in the scene's gallery (`pasteIntoCell`,
    `attachToGallery`, 05c-clipboard.js, #135), with a "Picture added to scene N" toast
    whose Undo takes back that paste's entry while it is still the last.
    `migrateRows` (02-state.js, `moveMediaOutOfCell`) does the move: the
    comment is by "Splitpage", dated the row's `updatedAt`, with an empty
    quote and a line saying where it came from; its id is
    `mediaCommentId(rowId, field, "img:"+sha | "video:"+href)`. Like every
    loaded comment without an `anchorId`, it gets its own id there, which
    no span carries: it is not anchored to any words. Every way a document
    arrives goes through `migrateRows` (a file, a server copy, a merge, a
    restore, a crash draft, an import), and nothing in the app puts a
    picture into a cell, so no cell holds one. `editCell` still declines
    one as a guard, and since §10 step 7 nothing else edits it; the HTML
    paths that read one without editing at the selection
    (`syncFieldFromDom`, `mergeTextField`, split and join, retag, the
    b-roll list's rename) are guards of the same kind.

## 4. Operations

Nothing outside the document model writes a cell. Its pure operations live
in `src/core/text/` (typed, and unit-tested under `node --test` without a
DOM): the edits in `edits.ts`, `toHtml` in `html.ts`, the readers in
`projections.ts`, the steps in `steps.ts`, and `mergeCells` in
`src/core/merge/cells.ts`. `src/js/04c-doc-model.js` exports all of them,
with `fromHtml` and `cellOf`, which still decode through the sanitiser:

- **Constructors and converters**
  - `fromHtml(html)` parses a sanitised HTML cell into runs. This is the
    migration path and the paste path.
  - `toHtml(runs)` renders for the editor and the stored format (§6). Its
    elements always nest in one order — each comment, the link, the tag,
    then highlight, bold, italic, underline, strike — and stay open across
    neighbouring runs that share them. So the output is canonical and a
    fixed point of `sanitizeHtml`, and `fromHtml(toHtml(c))` is `c`.
  - Until step 2, `fromHtml` takes `tagId(cat, name)` and `toHtml`
    `tagOf(id)`; without them a tag's id is `t:<cat>:<name>`.
  - `toPlainText`, `toMarkdown` and `toDocxRuns` replace `htmlToPlainText`,
    `htmlToMarkdown` and `htmlToRuns`. `toMarkdown` writes the same
    notation but not the same text: it lays its delimiters out for
    CommonMark rather than following an element tree (step 3).
- **Positions.** A position in a cell is a character offset into its
  plain-text projection, where an atom counts as one character. That is the
  coordinate the undo stack, find/replace, the teleprompter and caret
  restore all share.
- **Edits.** Each takes a cell and returns a new cell, never mutating:
  - `insertText(cell, pos, text, marks)`
  - `deleteRange(cell, from, to)`
  - `setMark(cell, from, to, mark, value)`
  - `splitCell(cell, pos) → [a, b]` and `joinCells(a, b)`
  - `replaceText(cell, from, to, text)` keeps the marks of the replaced
    range's first run
  - `insertBrollKey`
- **Steps.** Every document change is a list of steps. A step carries the
  value before and after in whatever form the state holds it (a cell's is
  its HTML, D2): `{op:"rowField", rowId, key, before, after}` for a cell,
  status or picture; `{op:"docField", key, before, after}` for the title,
  the registry, comments; `insertRow` / `deleteRow` / `moveRow`. One step
  list is one undo entry. `applySteps(state, steps)` returns a new state
  and refuses (throws, changing nothing) a step whose `before` is not what
  the state holds. `invertSteps` gives undo; `touchedCells` gives the cells
  a list touches, for D4.

Invariant #10 ("sanitise anything reconstructed") becomes "anything entering
the document goes through `fromHtml` or an edit function". Both can only
produce canonical, valid runs.

## 5. The editor

The cells stay `contenteditable`, and #84's keyed per-row rendering stays.
What changes is who owns the truth once the browser has changed the DOM.

**Proposed (D1): plain typing native, everything else intercepted.**

- **Plain typing** is left to the browser: `insertText`, composition (IME,
  dead keys, Windows emoji panel), and spellcheck replacement. That is the
  part hand-rolled editors get wrong. On `input`, the one cell that changed
  is read back with `fromHtml(cell.innerHTML)`. The result is diffed against
  the model to get a step, and the step is recorded. Cells are small, so the
  cost is a few hundred microseconds. During IME composition nothing is read
  back until `compositionend`.
- **Everything structural** is intercepted in `beforeinput` or `keydown`,
  applied to the model as steps, and the cell re-rendered with the caret
  restored by position:
  - Enter / Shift+Enter
  - Backspace or Delete touching an atom or a tag
  - paste and drop
  - B/I/U/S, highlight and link
  - tag shortcuts and Tab completion
  - b-roll capture
  - comment create/delete
  - `historyUndo` / `historyRedo`
- The browser's own undo stack is never used. `beforeinput` of type
  `historyUndo`/`historyRedo` is cancelled and routed to ours, and Ctrl+Z /
  Ctrl+Y / Ctrl+Shift+Z are handled in `onRootKeydown`.

**Built so far: formatting and line breaks.** In a script cell (#rows or
the writer) B/I/U/S, highlight, a link and Enter / Shift+Enter are model
edits through `editCell` (05b-cell-edit.js), one undo entry each, with the
selection kept:

- `toggleMark` (04c): every visible character of the selection already
  has the mark (line breaks and b-roll keys aside, `markThroughout`) → off,
  else on over all of it. The toolbars' lit state is the same question
  (`cellFormatState`, 05-render.js), so a lit button always means
  "pressing this removes it".
- A link is `setMark(…, "href", url)`; the caret goes just past it.
- `breakLine` (04c) replaces the selection with `"\n"`, or `"\n\n"` with
  the caret between them when nothing follows (the sentinel a trailing
  `<br>` needs to give the new line a box). Formatting carries through the
  break; a comment or link only where both sides are in it.
- With nothing selected, B/I/U is a *pending mark* for that caret position:
  the next `insertText` there is cancelled in `beforeinput` and inserted
  through the model with it, then run through the usual input handling
  (tag shortcuts, b-roll capture). Moving the caret forgets it.
- The comment composer and reply boxes, which are not document cells and
  may hold pictures and video cards, go through the same model functions
  by way of `editDraft` (`05d-draft-edit.js`, §10 step 7), with an undo
  history of each box's own. No edit anywhere uses `execCommand`; the
  page-wide `styleWithCSS` and `applyHighlight` are gone.

**Rejected alternatives**

- **Fully controlled** (every `beforeinput` cancelled and applied to the
  model). This is the cleanest in theory, but composition events can't be
  cancelled reliably, and Chrome's spellcheck/autocorrect replacements
  arrive as `insertReplacementText` with target ranges that would have to be
  mapped exactly. High risk for a one-person tool.
- **ProseMirror.** It solves this problem properly: schema, marks,
  transactions, undo. But it wants to own the whole editing surface. The row
  layout, writer mode, #84's per-row render, CSS-highlight untagged
  mentions, tag ghost completion, b-roll capture and the teleprompter's word
  spans would all have to be rebuilt as ProseMirror plugins and node views.
  Adding it is a rewrite of the editor, not a new model underneath it, and
  it adds ~150 KB to a single-file app.

## 6. What is stored

**Proposed (D2): the model is what the app holds; canonical HTML stays the
stored format for this release.**

- `rows[].visualText` / `audioText` keep holding HTML, but it is always
  exactly `toHtml(runs)`. That is the sanitiser's current output, plus
  `data-tag-id` on tag spans. The app converts once on load (`fromHtml`,
  memoised by string) and once on save.
- **What that keeps working, unchanged:**
  - older clients (2.x, 3.0) reading and writing the same server document
    or file
  - the server's reviewer anchor check (`placeAnchor`)
  - `shared/blob-policy.js`
  - history snapshots, drafts, the app-data bundle and the `.md` project
    format
  - every existing document, with no migration step to go wrong
- **What it costs:**
  - a parse per changed cell on load and after each merge (memoised; cheap)
  - an old client drops `data-tag-id`, because its sanitiser doesn't know
    it. The next load by a new client re-resolves the tag by category and
    name, which is the fallback anyway.
- **The alternative** is runs as JSON in the stored state (`schema: 3`).
  - It is cleaner, and diffs of `.splitpage` files become readable.
  - Every older client must be locked out:
    - the server refuses them with 426, as #82 did with `x-splitpage-client`
    - an old desktop app opening a new file would see empty cells and could
      save them back empty. `migrateRows` has no forward-version refusal
      today (02-state.js:162), so that has to ship one release **before** the
      format changes.
  - Every surface listed above has to change too.

Moving the stored format to runs later is a separate, mechanical change once
everything reads and writes through the model. This design doesn't block it.

## 7. Undo and redo

One stack per tab, of step lists (§4). What counts as one entry:

- **Typing** coalesces into one entry per word or per pause of 1 s, split
  also by caret jumps and by switching cells.
- A typing entry that coalesces back to where it began (the same runs) is
  dropped, so typing a letter and deleting it leaves no entry. A cancelled
  IME composition drops every entry it made in its cell, however long its
  updates took, whether `compositionend` comes before or after the input
  that reverts the cell; if its first update joined earlier typing, that
  typing keeps its own entry as it was (#380, PR #427). Typing that leaves
  no entry this way also gives back the redo it cleared.
- Every intercepted action is one entry:
  - a paste
  - a format
  - applying or removing a tag
  - renaming a tag, or changing its owner, notes or status, in the
    production panel
  - adding or deleting a b-roll marker
  - creating or deleting a comment (see below)
  - splitting, joining, adding, deleting or moving rows
  - a scene's status (todo/ready/shot)
  - setting or removing a scene's picture
  - the document title
  - Replace All
  - an import into the current document
  - "Use my version" on a conflict card
- `lastSplitUndo` and `S.lastMoveUndo` are deleted. Their cases are ordinary
  entries now.
- **Not undoable:** opening a file, restoring a snapshot, and a merge from
  someone else. These change what the document is rather than edit it, and
  version history already covers them. `undoMerge` stays as it is.

**Remote changes** (a pull, a 409 merge, a reload from disk, D4). Only the
touched cells are forgotten. Each
entry's steps record the `before` of the cells they touch. When a merge
changes a cell, entries touching that cell are dropped from the stack.
Entries for untouched cells survive. So Ctrl+Z never reverts someone else's
words, and never fails half way.

**Comments (D5).** Creating or deleting a comment is undoable, with one
limit:

- **In a local file**, always.
- **On a server document**, only until the comment has reached the server.
  Once the save or the comments-endpoint POST (#71) carrying it has been
  accepted, its entry leaves the stack, and the comment is deleted the usual
  way (the ✕ on the card). Undo never deletes something reviewers may
  already have seen.

## 8. Merge

`mergeRow` stops comparing whole strings. For each cell present on all three
sides:

1. Equal models: done. Only one side changed: take it (as today).
2. Both changed:
   - tokenise each side's plain-text projection into words, single
     whitespace characters and b-roll keys
   - three-way merge the token sequences (diff3, the same algorithm as
     `git merge-file`)
   - then merge marks per character of the words neither side changed: a mark added or removed on one side is
     applied to the result, and if both sides set the same mark to
     different values (only a link or a tag has a value), theirs wins and
     it is reported as a conflict (step 3)
3. Only overlapping token ranges changed on both sides are a conflict. A
   rewrite so large on both sides that the word diff would need more than
   4 million table cells (a few thousand words each) is treated as one
   conflicting change instead. For
   those, theirs stays live, and the conflict card holds **my version of
   the whole cell**, as today (D3). "Use my version" restores it as one
   undoable step. A link or tag both sides set differently on the same
   characters is a conflict too, with the same card; there the merged cell
   stays live, their link or tag on those characters.

This fixes the named case: a tag re-wrap (marks only) on one side plus a
word edit on the other merges cleanly. The on-disk merge review
(18a-local-merge.js) uses the same function, so its preview and its outcome
can no longer disagree.

**Built (step 6).** `mergeTextField(base, mine, theirs, ctx)` in
`src/core/merge/text-field.ts` (re-exported by `03-sync.js`, and reading
cells through the decoder its context carries) is the one decision,
returning `{html, outcome}` with outcome
`same`, `mine`, `theirs`, `merged` or `conflict`; `mergeRow` and the
on-disk review both call it (the review labels `merged` "both sets of
changes are combined"). What building it settled:

- **Each side is read through its own registry.** `textMergeContext()`
  builds `registryTagHooks` for base, mine and theirs from each side's own
  `productionTags`, so a span renamed on one side (the registry entry and
  its spans' `data-tag-name`, as `renameTag` does) resolves to the same id
  on all three: a rename is not a change to the cell.
- **The result names tags the way the merged registry does.** The registry
  is merged before the rows. A cell taken whole from one side is rewritten
  through the model only when the merged registry renamed a tag that side's
  spans name (checked once per side per merge, then per cell only if it has
  a tag span); otherwise its string goes in untouched. So a rename on one
  side plus a text edit on the other comes out with both. A tag id the
  merged registry no longer holds keeps the name a side gave it, so no span
  is dropped; `migrateRows`' heal re-registers it, as before.
- **Strings first, models only where they differ.** Equal strings are
  equal. Different strings are parsed, and two that read as the same cell
  (a different nesting, say) are the same: theirs' string is kept and
  nothing counts as an edit. "Only one side changed" is judged by model
  too, so a side that merely re-serialised a cell never wins or conflicts.
  When the merged cell equals one side's, that side's own HTML goes in
  rather than a rewrite.
- **A cell with a picture or video card is compared as a string**, whole,
  as before: `fromHtml` leaves them out (D7), so merging one through the
  model would drop it. Since §3.3's load-time move to comments this only
  happens for a side an older copy of the app wrote.
- **No ancestor** (a two-way merge, or a row base does not have): equal
  models are no conflict; any other difference is one, as before.
- **Stats.** A row whose cell combined both sides counts in `rowsFromMe`
  ("rows you edited"): my edit is in it. `rowsFromThem` now counts rows
  where their change was actually taken (by model), not every row whose
  string differs from base.
- **A link or tag both sides set differently is a conflict.** On those
  characters `mergeCells` keeps theirs and counts it in `markConflicts`;
  `mergeTextField` turns a count above zero into outcome `conflict` (with
  `marks: true`), so every caller of it reports it the way it reports a
  word conflict: `mergeRow` puts my whole cell on an "Unmerged edit" card
  (D3), which covers the hosted save's 409, the presence-heartbeat pull and
  the crash-draft and stash merges, and the on-disk review lists it as a
  conflict, worded as a link or tag. The difference from a word conflict
  is what stays live: the merged cell (their link or tag, everything else
  from both sides), not theirs whole, and if my other edits are in it the
  row counts in `rowsFromMe`. Formatting (bold and the rest) is on or off
  per character, so it can never conflict; a comment anchor neither. The
  live HTML is what it was before this was reported, so what the merge
  touches, and so what undo forgets (D4), is unchanged.
- **Not done:** rows only one side has (added, or kept over a delete) are still copied as
  they are, so one added on my side still names a tag by the name my
  registry had, even if theirs renamed it; the heal registers that name
  again beside the renamed entry, as it always did.

## 9. What changes where

| Area | Change |
| --- | --- |
| `02-state.js` `migrateRows` | resolves tag ids and heals the registry; `fromHtml` into a memo |
| `03-sync.js` | `mergeRow` per §8; conflict cards unchanged in shape |
| `04-richtext.js` | `sanitizeHtml` stays for comment bodies and paste input; cells go through `fromHtml` |
| `05-render.js` | cells render from `toHtml(runs)`; `syncFieldFromDom` becomes read back plus diff; toolbar actions become steps |
| `06-rows.js`, `19-writer.js` | split, join, move and delete become steps; `repointCommentsForRows` is deleted |
| `07-production-tags.js` | tag shortcut, completion and untagged accept become steps; `eachTagSpan` becomes a run walk; rename touches the registry only |
| `08c-broll.js` | capture and rename become steps; the marker is an atom |
| `09-find-replace.js` | searches the plain-text projection, so matches cross formatting; replace is `replaceText` |
| `10-comments.js` | anchors from `cmt` marks; create/delete are steps |
| `14-export.js`, `15-docx.js`, `16-csv.js`, `17-pdf.js`, `20d-formats.js` | read runs via `toPlainText` / `toMarkdown` / `toDocxRuns` (the `.md` project's table stays `htmlToMarkdown`, step 3) |
| `20-teleprompter.js` | word spans from runs |
| `21-events.js` | `beforeinput` / keydown routing (§5); paste via `fromHtml` |
| `server/server.js`, `shared/blob-policy.js` | unchanged (D2: HTML stays the stored format) |

`execCommand` goes from 17 editing calls to none.

## 10. Build order

Each step ships on its own, with the suites green, and changes no behaviour
until step 4.

1. **`04c-doc-model.js`, pure. Done.** Types, `normalizeCell`,
   `fromHtml`/`toHtml`, positions, edit functions, steps and their inverses,
   tokenised diff3. `src/test/doc-model.test.mjs` checks, on a fixture of
   every construct the sanitiser keeps, the demo document and 400 seeded
   random cells: `toHtml` is a fixed point of `sanitizeHtml`;
   `fromHtml(toHtml(c))` is `normalizeCell(c)`; a cell's text is what its
   stored HTML shows; `toPlainText` / `toDocxRuns` equal
   `htmlToPlainText` / `htmlToRuns` of `toHtml(c)`. (`toMarkdown` did
   too, until step 3 made it better than `htmlToMarkdown`; see there.)
   (`toHtml(fromHtml(x))` is not `sanitizeHtml(x)` byte for byte: the
   sanitiser keeps whatever nesting it was given, `<em><strong>` or
   `<strong><em>`, and `toHtml` always writes one. The first save of an old
   cell through the model changes its string, not its content — which is
   why merge compares models, not strings, from step 6.)
2. **Registry ids. Done.** `productionTags[].id`, minted from the key and
   kept through renames; the registry merges by id; `registryTagHooks` for
   the model. No ids on spans (§3.1 says why). `src/test/tag-ids.test.mjs`.
3. **Readers first. Done**, but for the one reader that has to stay on
   HTML. Word count, the plain-text, CSV, Word and PDF exports, the
   teleprompter and find/replace read cells through `cellOf`; find matches
   across formatting (never inside a tag or across a b-roll key). So does
   the b-roll list (`brollInField`): the same items as the HTML reader on
   every stored-shape cell. The last three:
   - **The plain Markdown export** (`toMarkdownDoc`) is `toMarkdown`. The
     HTML walker copied the elements' nesting into Markdown, which
     CommonMark reads differently wherever a delimiter touches a space
     (`**a **b`), two elements sit side by side (`**a****b**`) or two
     marks cross; over the model's one fixed nesting it also wrote
     `*x ****y***` for italic "x " then bold-italic "y". `toMarkdown` joins
     what reads as one, keeps bold, italic, strike and the rest off white
     space at their edges and out of blank lines, opens the longest-running
     mark outermost, and writes `<strong>`/`<em>`/`<s>` for a delimiter
     that still could not open or close where it stands (CommonMark's
     flanking rules, the rule of 3, a line break read as white space and
     as `<br>`). Checked when it was written against markdown-it and
     commonmark.js on 31,515 stored-shape cells (the random cells are
     harsh: spaces and line breaks at every edge), as a table cell and as
     paragraphs: the HTML walker's Markdown rendered other formatting than
     the cell's for 56–73% of them depending on reader and form,
     `toMarkdown`'s for none in a table cell and 4–5 as paragraphs — each
     a line starting with four spaces after a blank line, an indented code
     block, which the HTML walker wrote the same — and never for a cell
     the old one rendered right. Text is written as it is, as before: an
     asterisk typed into a cell is not escaped. Import reads the three
     fallback elements back (`legacyMdToHtml`).
   - **The production index** (`tagsInField`) counts one mention per
     stretch of one tag in the model, not per tag span. On shapes older
     copies of the app stored they differ — two spans of one tag side by
     side are one mention, a tag nested in a tag is the inner one with the
     outer either side of it, an empty tag span is none, a b-roll key
     inside a tag splits it — and the span count was the unstable one:
     each of those cells is written in the model's shape the first time
     anything edits it, so an item's count changed when someone fixed a
     typo beside it. The panel, the breakdown exports and Remove label's
     count all read it. On every other stored cell the two agree.
   - **The `.md` project's table stays `htmlToMarkdown`**, the reason in
     `mdSceneCellSource`: it is the comparison basis every copy of the app
     that opens the file uses to tell a hand edit from an untouched cell,
     and every copy in circulation renders with `htmlToMarkdown`. A table
     written in the model's Markdown would read in an older copy as edited
     by hand in every cell where the two differ, and be rebuilt from the
     table, losing its comment anchors and b-roll key. It is also what
     keeps an unchanged document's bytes the same. Reading already takes
     the model's form as unchanged too, so a later release can switch the
     writer once no copy from before this one is in use.
   Tests: `readers.test.mjs` (old and new readers over 1500 stored-shape
   cells), `find-replace.test.mjs`, `broll-model.test.mjs`,
   `tag-panel-model.test.mjs`, the `toMarkdown` cases in
   `doc-model.test.mjs` and the `.md` round trip over stored-shape cells in
   `formats.test.mjs`.
4. **Writers. Done for everything done at the selection.** Not by making
   `applySteps` the only door into `S.state` — that would have meant
   rewriting all 33 write paths first — but in three parts:
   - every keystroke is stored canonical (`syncFieldFromDom` through the
     model), so state never holds unsanitised HTML any more;
   - everything structural in a script cell goes through `editCell`
     (`05b-cell-edit.js`): bold/italic/underline/strike/highlight (with a
     collapsed caret too), links, Enter, the three tag routes, the b-roll
     key, paste, drop, copy and cut (`05c-clipboard.js`). Copy never
     carries a comment; cut then paste moves it (D6). A pasted b-roll key
     gets an id of its own unless a cut is moving it (§3.3). Pictures and video
     cards are dropped from pasted script text and moved out of existing
     cells into comments on load (D7).
   - splitting a scene (Enter in the writer, Alt+Enter) is `splitCell` at
     the caret and joining two (Backspace/Delete at a paragraph's edge) is
     `joinCells`; comments follow their marks (`syncCommentAnchors`, §3.2).
     Tests: `comment-anchors.test.mjs`, browser suite 78.
   The edits made away from the selection are model edits too: applying
   a tag from the composer to one or all occurrences (found in the cell's
   projection, never inside a tag or a link, across a b-roll key or a
   comment's edge; whole words), rename and remove through the panel
   (`retag`, the spans still renamed — D2), and the b-roll list's rename
   and anchoring pass. Tests: `tag-panel-model.test.mjs`,
   `broll-model.test.mjs`, browser suite 79. Still on the old paths only
   the HTML fallback each of these keeps for a cell still holding a
   picture (which D7's load-time move empties).
5. **Undo stack. Done** (`12a-undo.js`), recording every edit by diffing
   after `markDirty()` rather than per path — see §7 and HANDOFF invariant
   #53. The browser's own undo is never used in a script cell.
6. **Merge per §8. Done** — built ahead of steps 4–5, since it only needs
   the model and the registry ids. The on-disk merge review switched with
   it. §8 lists what building it settled. Tests: the "a word at a time"
   section of `src/test/merge-states.test.mjs`.
7. **Delete what is left. Done.** `lastSplitUndo` and the move undo are
   gone; HANDOFF invariants #2, #3, #10 and #18 are rewritten for the
   model and #53, #54 and #55 added. `repointCommentsForRows` is gone: split and
   join move runs, and `syncCommentAnchors` (§3.2) is the one place a
   comment's `rowId`/`field` is derived from its mark. And no edit uses
   `execCommand` any more:
   - **The comment composer and reply boxes** edit through the model
     (`editDraft`, `05d-draft-edit.js`), though no model stands behind
     them and they may hold pictures and video cards: each one is lifted
     out as a private-use placeholder character (U+E000–U+F8FF, never one
     the box or a paste already holds), which the model treats as a
     letter, and put back as itself when the box is written. A picture or
     card never carries formatting or a link (a card is an `<a>`), never
     counts toward "bold throughout", and `walkCell` counts it as one
     position so the selection lines up. B/I/U/S, highlight, a pending
     mark, a link, Enter, a paste, a drop from elsewhere, and the Image
     and Video buttons are all draft edits.
   - **Undo in a draft** was the browser's, which only worked because
     `execCommand` recorded into it; it cannot follow edits it did not
     make, so it never runs there now. Each box has its own history
     (snapshots of its stored HTML and its selection as model positions,
     200 deep): a structural edit is one entry; typing stays the
     browser's and is recorded after the fact, a burst closed by an 800 ms
     pause, by switching between typing and deleting, by the caret
     jumping, or by the next edit, undo or redo; nothing is recorded during
     an IME composition, and Ctrl+Z is the IME's while one is open.
     Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y and `beforeinput`'s `historyUndo` /
     `historyRedo` answer from it, and are taken even with nothing left to
     undo. The composer's history is dropped when it opens, is cancelled
     or posts; a reply box's goes with the element. The document's own
     undo (§7) never sees a draft (D5 is about sent comments). Tests:
     `draft-edit.test.mjs`, browser suite 80.
   - **The fallback for a script cell still holding a picture is
     deleted** (the browser's format, highlight, link, line break, paste
     and drop commands, and the tag and b-roll key put straight into the
     DOM): §3.3 says why no cell holds one. `editCell` still declines one,
     and nothing edits it instead. The tag and b-roll shortcuts, which
     also fell back when the model did not read the same words at the
     caret, now leave the typed words as they are.
   - Left: `execCommand("copy")`, the clipboard fallback of three copy
     buttons (13-hosted, 20b-onboarding, 20e-connect) — not an edit.
   IME and spellcheck in a draft stay the browser's, as in a script cell
   (§5), and the by-hand check list's Japanese-IME and spellcheck lines
   (§11) cover the comment composer and a reply box too.

Steps 1–3 are about a week of agent sessions. Steps 4–6 are the bulk and
the risk. Step 4 touches every editing path, and a regression there loses
words.

## 11. Risks

- **Losing text in step 4.** Mitigation: the debug assertion, the round-trip
  test over every fixture, and a draft snapshot before the first write of
  each new path. No step deletes an old path until its replacement has
  passed the full browser run on Windows.
- **Caret restore after re-render.** Position-based restore exists already
  (the writer's `(rowId, char offset)`, 19-writer.js). It gets one shared
  implementation used by every re-render.
- **IME and spellcheck.** These are left to the browser (§5) exactly because
  they are the risk. The by-hand check list gets a Japanese-IME and a
  spellcheck-replacement line, in a script cell and in a comment or reply
  draft.
- **Performance.** The memo is keyed on the cell string, so an unchanged row
  costs a map lookup. The typing hot path parses one cell.

## 12. Decisions (2026-09-23)

| | Question | Decided |
| --- | --- | --- |
| D0 | When | **A 3.0 pre-release first, then the full 3.0 release.** First decided as a pre-release *without* #85; changed the same day, once #85 was built: #85 is in the pre-releases from 3.0.0-beta.1, so the Windows pass runs on it before 3.0.0. The update check reads GitHub's `releases/latest`, which skips pre-releases, so nobody is offered the pre-release automatically. #100 (deleting #83's history migration) waits for the release **after** the full 3.0: the migration has to reach everyone who updates normally, not just pre-release testers. |
| D1 | Editing engine | **Hybrid** (§5): the browser types, Splitpage does everything else. |
| D2 | Stored format | **Keep canonical HTML** in files and on the server (§6). Runs on disk can come later as its own change. |
| D3 | Conflict card | **My whole cell**, as today. |
| D4 | Undo after a merge | **Forget only the cells the merge touched.** |
| D5 | Comments and undo | **Undoable until sent**: always in a local file; on a server document, until the server has it. |
| D6 | Cut and paste of commented text | **The comment moves with the text** within the same tab. Copy never duplicates it. |
| D7 | Pictures and video in script cells | **Kept out of the cell on paste** — since #135 put in the scene's gallery (its Image section; #124 attached them as comments). Ones already in a cell are **moved into a comment** on that scene when the document is read (§3.3). |
| — | Undo also covers | Scene status, scene picture, production-panel edits (owner, notes, status, rename), the document title. |
