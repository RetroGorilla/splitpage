# Structured document model — design (issue #85)

Status: **decided; steps 1–2 of §10 built** (`src/js/04c-doc-model.js`,
nothing in the app calls it yet). Adam made the decisions in §12 on
2026-09-23; the sections below already reflect them. The build follows §10.
#85 ships in the full 3.0 release. A 3.0 pre-release goes out first without
it.

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
- across each stretch of one tag, `cmt` becomes the union and `href` the
  first one found: a tag is one unit, so a comment or link covers all of it
  or none of it — which is also what lets `toHtml` nest a tag inside its
  comments and links without ever splitting it

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

- Splitting a row moves the runs, and their marks move with them. Joining
  rows does the same.
- **Copy** never copies a `cmt` mark. **Cut then paste** in the same tab
  moves it (D6).
- Deleting all of a comment's text leaves the comment **detached**
  (`anchor: null`). It still shows in the panel with its quoted text, which
  is today's behaviour for a lost anchor.

### 3.3 B-roll, pictures, video

The b-roll key is an atom with the shot id. The shot's name is still the
text after it up to the next line break, as today (08c:78-90). Only the key
is special. **It is the only atom.**

**Script cells hold no pictures or video cards (D7).**

- **Pasting.** A paste into a cell drops them. Comments keep both, and the
  scene picture is still set the normal way.
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

## 4. Operations

Nothing outside one module writes a cell. `src/js/04c-doc-model.js`
(pure, unit-tested under `node --test` like the other pure cores) exports:

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
    `htmlToMarkdown` and `htmlToRuns`.
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
     different values, theirs wins and it is reported
3. Only overlapping token ranges changed on both sides are a conflict. A
   rewrite so large on both sides that the word diff would need more than
   4 million table cells (a few thousand words each) is treated as one
   conflicting change instead. For
   those, theirs stays live, and the conflict card holds **my version of
   the whole cell**, as today (D3). "Use my version" restores it as one
   undoable step.

This fixes the named case: a tag re-wrap (marks only) on one side plus a
word edit on the other merges cleanly. The on-disk merge review
(18a-local-merge.js) uses the same function, so its preview and its outcome
can no longer disagree.

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
| `14-export.js`, `15-docx.js`, `16-csv.js`, `17-pdf.js`, `20d-formats.js` | read runs via `toPlainText` / `toMarkdown` / `toDocxRuns` |
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
   stored HTML shows; `toPlainText` / `toMarkdown` / `toDocxRuns` equal
   `htmlToPlainText` / `htmlToMarkdown` / `htmlToRuns` of `toHtml(c)`.
   (`toHtml(fromHtml(x))` is not `sanitizeHtml(x)` byte for byte: the
   sanitiser keeps whatever nesting it was given, `<em><strong>` or
   `<strong><em>`, and `toHtml` always writes one. The first save of an old
   cell through the model changes its string, not its content — which is
   why merge compares models, not strings, from step 6.)
2. **Registry ids. Done.** `productionTags[].id`, minted from the key and
   kept through renames; the registry merges by id; `registryTagHooks` for
   the model. No ids on spans (§3.1 says why). `src/test/tag-ids.test.mjs`.
3. **Readers first.** Exports, word count, the production index, b-roll,
   the teleprompter and find all read runs through the memo. This is where
   cross-formatting find starts working.
4. **Writers.** `applySteps` becomes the only way into `S.state`. Paths are
   moved one by one, in the §2 inventory's order, and a debug assertion
   catches any cell whose HTML is not `toHtml` of its runs. This is the big
   one: several PRs, with a browser-suite pass per PR.
5. **Undo stack.** The browser's native undo is disabled at the same time,
   since leaving it half on is worse than either.
6. **Merge per §8.** The on-disk merge review switches with it.
7. **Delete what is left:** `execCommand`, `repointCommentsForRows`,
   `lastSplitUndo`, and the invariants the model makes impossible to break
   (#2, #3, #18). HANDOFF is updated.

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
  spellcheck-replacement line.
- **Performance.** The memo is keyed on the cell string, so an unchanged row
  costs a map lookup. The typing hot path parses one cell.

## 12. Decisions (2026-09-23)

| | Question | Decided |
| --- | --- | --- |
| D0 | When | **A 3.0 pre-release first, without #85; #85 goes into the full 3.0 release.** The update check reads GitHub's `releases/latest`, which skips pre-releases, so nobody is offered the pre-release automatically. #100 (deleting #83's history migration) waits for the release **after** the full 3.0: the migration has to reach everyone who updates normally, not just pre-release testers. |
| D1 | Editing engine | **Hybrid** (§5): the browser types, Splitpage does everything else. |
| D2 | Stored format | **Keep canonical HTML** in files and on the server (§6). Runs on disk can come later as its own change. |
| D3 | Conflict card | **My whole cell**, as today. |
| D4 | Undo after a merge | **Forget only the cells the merge touched.** |
| D5 | Comments and undo | **Undoable until sent**: always in a local file; on a server document, until the server has it. |
| D6 | Cut and paste of commented text | **The comment moves with the text** within the same tab. Copy never duplicates it. |
| D7 | Pictures and video in script cells | **Stripped on paste.** Ones already in a cell are **moved into a comment** on that scene when the document is read (§3.3). |
| — | Undo also covers | Scene status, scene picture, production-panel edits (owner, notes, status, rename), the document title. |
