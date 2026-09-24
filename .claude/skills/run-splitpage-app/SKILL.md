---
name: run-splitpage-app
description: Run, drive and test the Splitpage app in a real headless browser. Use when changing the app source in src/, verifying a Splitpage feature works, reproducing a reported bug, taking screenshots of the app, or running the regression suite before committing. Also use when asked to "test splitpage", "run the tests", or "check nothing broke".
---

# Running and testing Splitpage

Splitpage ships as one self-contained `index.html`, but **that file is
generated, and it is not in the repository** (#80) — do not edit it, and
expect a fresh clone not to have one until you build it. The source is
`src/` (`page.html`, `app.css`, `seed-state.json`, and the ES modules in
`src/js/`) plus `docs/help.md` (rendered into the in-app Help page) and
`VERSION`, and `node build.mjs` bundles them with esbuild and inlines the
result back into `index.html`. Run `npm install` once first — esbuild builds
the bundle, jsdom lends the unit tests a DOM. Edit the source, rebuild, then
test. A change made directly to `index.html` will look like it worked and be
destroyed by the next build — and, since it is ignored by git, will never
show up in a diff to warn you.

There are two layers. **Unit tests** over the pure cores in `src/js` run
under `node --test` with no browser at all — `npm test`, files in
`src/test/`, a couple of seconds, and they work on Windows, in the cloud
container and in CI alike. **Everything else** is this skill: a driver that
serves the app, launches a headless browser over the Chrome DevTools
Protocol, and runs plain-text command scripts against it.

Reach for the unit tests when what you changed is a pure function of a
document — `migrateRows`, `mergeStates`, the `.splitpage`/`.md` formats,
`parseMarkdownTable`, `deriveDocId`, `planHistoryEviction`. Reach for a
browser suite when there is a page involved: a click, a modal, a rendered
row, a file handle, IndexedDB, the desktop bridge. Before #67 the first
list had no tests at all and was reached through `window.__*` hooks from a
booted browser, which is why several suites still open a page to assert
something that is really just arithmetic over an object.

```bash
npm test                      # src/test/*.test.mjs, no browser
node build.mjs && node .claude/skills/run-splitpage-app/driver.mjs --script .claude/skills/run-splitpage-app/tests/01-core.txt
```

`src/test/_dom.mjs` is what makes the first one possible: the pure cores
sanitise HTML through a real `DOMParser`, so the suites borrow a
spec-compliant DOM (jsdom, a devDependency, never shipped) rather than
stub one. A module that needs a *page* — `#rows`, `#state-data`, a modal —
does not belong there.

There are **two drivers and one set of scripts**. They read the same
`tests/*.txt`, take the same commands, and print the same lines — pick by
where you are, never by what you are testing:

| | `driver.ps1` | `driver.mjs` |
| --- | --- | --- |
| Runs on | Windows only | anywhere with Node 22 + a Chromium |
| Built from | PowerShell 5.1 + .NET + `msedge.exe` | Node built-ins + Playwright's Chromium |
| Suite runner | `run-tests.ps1` (parallel lanes) | none — one suite per invocation |

`driver.ps1` is the original and still the one the full regression runs
under. `driver.mjs` exists so a source change can be driven from the Linux
cloud container, which has no PowerShell and no Edge — see "Driving it from
the cloud" below.

Building and packaging need Node 18+, which the Windows machine may not
have — if `node build.mjs` cannot run there, you cannot test a source change
at all, and saying so is better than testing a stale `index.html`.

## Run the regression suite

Do this before committing any change to `src/`, and **rebuild first** or you
will be testing the previous version of the app:

```bash
node build.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/run-tests.ps1
```

Ends with `ALL PASS` (suites 01–30, 16 unused) and exit 0, or lists
every failing assertion and exits 1. Options:

- `-Only 02` — run just the suite whose filename starts with `02`
- `-Parallel N` — how many suites run at once (default 4; each has its own ports, Edge profile and log)
- `-Headed` — watch it happen in a real Edge window
- `-TimeoutSec 300` — for a slow machine
- `-Port` / `-CdpPort` — pin the port bases instead of auto-picking (below)

With neither `-Port` nor `-CdpPort` given, the runner picks its own free port
bases: it derives a starting base from a hash of the worktree's own path, then
probes every port the run needs with a real socket bind and steps the base by
100 until the whole block is free on both ranges. That means two runs on one
machine (two worktrees, two agents) no longer collide on a fixed default port
and fail with "static server did not come up" — pass `-Port`/`-CdpPort`
explicitly only if you need a specific, repeatable block. This is a separate
mechanism from the Edge-profile sweep below (each run also gets its own
run-id-scoped browser profile, so two concurrent runs no longer kill each
other's live browser either) — see "Two `run-tests.ps1` invocations at once"
under Gotchas.

Logs land in `%TEMP%\splitpage-testlogs\`, screenshots in
`%TEMP%\splitpage-shots\`.

## The unit tests

`npm test` — `node --test "src/test/*.test.mjs"`. No browser, no server, no
build step: each file imports the module it is about straight out of
`src/js` and calls it. Add to these rather than to a browser suite whenever
the thing you changed is a pure function of a document.

| File | Covers |
| --- | --- |
| `src/test/_dom.mjs` | not a suite: the jsdom bootstrap every other file imports first, and the note on why a real DOM rather than a stub |
| `src/test/migrate-rows.test.mjs` | `migrateRows` (02-state.js), the one door every outside document comes through: garbage tolerated rather than thrown on, script/iframe/handlers stripped, a legacy inline `data:` image interned into an `imageRef` (#82: content-addressed, deterministic however the base64 is wrapped, a bad one no picture, a valid inline one winning over a ref, a bad ref refused) and an image conflict card's picture moved out of its body into `imageValue`, statuses and ids normalised, the legacy plain-text conversion (including the stray `<` it used to eat and the link query string it used to double-encode), conflict cards never given a fake row, anchorId's fallback, dangling owners cleared, the registry back-filled for a file that never had one and healed with any live tag an existing one lacks (#84's migration step, idempotent), wordsPerMinute clamped, migrating twice changing nothing, and a picture or video card in a script cell moved into one comment on that scene (#85 D7: an id derived from row, column and sha or link, so migrating twice or merging two copies that both moved it gives one comment; the picture still referenced); and a b-roll shot's hand-added `props` (#149): every shot given a list, garbage and a bare string tolerated, an unknown name kept by name, an id taking its entry's current name and a known name its entry's id (a Gear entry of the name never counting), duplicates dropped, names bounded, the list capped at 40, and migrating twice changing nothing |
| `src/test/production-index.test.mjs` | the production index (07-production-tags.js, #84): `productionEntries()` never writing the registry while a live tag lacks an entry, `healTagRegistry()` adding it without changing what the read says or re-deriving, the index kept through prose edits and re-derived by a tag added, a registry field, the rows' order or a new document, and the array a caller gets being its own |
| `src/test/merge-states.test.mjs` | `mergeStates` (03-sync.js) — all of the retired `tests/51-merge-fields.txt` (base-aware list merges, #61, and the field registry meeting the merge, #60) plus the row, comment and title reconciliation the browser suite never reached: an edit outranking a delete both ways, a re-inserted row landing beside its surviving neighbour, status as forward progress, both-sides conflicts preserved as comment cards, resolve/assignee/reply merging, and the document id surviving a merge. Pictures (#82): compared by the sha their `imageRef` names, one side's change winning silently, both sides' becoming a card holding mine as `imageValue` (and "cleared" when I removed it), `stashLocalWork` writing refs plus `blobs` for what is not durable, `acceptStash` re-hashing what it carries, and one release of the old `"__IMAGE__"` stash taking theirs' picture. A b-roll shot's hand-added props (#149) merged as a base-aware set: both sides' additions kept, a removal on either side kept, a removal and an addition both landing, no base copy of the shot unioning, a copy from before props never removing one, a name-only copy and its id'd twin one prop, and the shot's other fields merging as before |
| `src/test/state-fields.test.mjs` | the `STATE_FIELDS` registry (02-state.js, #60): every field has a strategy `mergeStates` knows, a merge keeps every field a migrated document has, nothing `migrateRows` produces is outside the table, and the shipped `src/seed-state.json` survives migration, a merge and a `.splitpage` round trip with nothing missing; and one level down (#149), every field migrateRows gives a b-roll shot — `props` among them — surviving a merge and a `.splitpage` round trip |
| `src/test/formats.test.mjs` | the serializer half of the two project formats (20d-formats.js): `.splitpage` having no envelope and round-tripping exactly, `parseSplitpage` refusing anything that is not ours and deliberately not migrating, the `.md` data fence outgrowing tildes in the script, the id travelling only inside the block, the last opening fence winning over a quoted decoy, a hand-edited cell winning for that cell only with its tags re-attached by name, and `noAsk` keeping the record when the scenes do not line up. Pictures (#82): a `.splitpage` carries them inline (`visualImage: data:…`, no `imageRef`) while the document holds refs, three ~200 KB pictures leave `JSON.stringify(state)` under 10 KB, a picture with no bytes anywhere stays a ref with no picture (`fileImagesMissing`), an image conflict card goes out with its picture in the body, and a `.md` cell an older client wrote with the picture spelled differently still reads as unchanged. A b-roll shot's `props` (#149) through `.splitpage` and the `.md` data block unchanged, and writing a `.md` (whose breakdown lists the shots each prop is for) adding no shot to the list |
| `src/test/markdown-table.test.mjs` | `parseMarkdownTable` (11-import.js): header-named columns wherever they sit, a header naming only one column never pointing both fields at it, escaped pipes staying in their cell, separator rows never read as data, and what `keepEmpty` does and does not resurrect |
| `src/test/doc-id.test.mjs` | the pure half of document identity (02b-doc-id.js): the FROZEN SHA-256 vectors and `deriveDocId` golden (HANDOFF invariant #37), `sha256Bytes` (#82) against the NIST byte vectors (empty, `abc`, 448/896-bit, a million `a`) and node:crypto at every padding boundary, `sha256Hex` still being exactly `sha256Bytes` over UTF-8, domain separation, `normalizeDocId` refusing to repair anything, `migrateDocument`'s file/server/fresh origins (a legacy file with a picture keeping the id its bytes derive, the seed read before the picture is interned), the `mergedDocId` truth table, and `decideDuplicateLoser`'s symmetry |
| `src/test/history-eviction.test.mjs` | `planHistoryEviction` (`shared/history-policy.js` since #76) — the fixtures (a)-(g) `tests/24-history.txt` used to run through `window.__historyTest.planEviction`, plus ordering, a custom `olderKey`, and garbage input |
| `src/test/history-store.test.mjs` | `shared/history-store.js` (#83), the ONE history store the browser (03a) and desktop main both run, over its memory backend in STRICT mode (every tx op on a later macrotask, the transaction inactive once one passes with nothing pending — IndexedDB's auto-commit rule, so a store that awaited anything but a `tx.*` call inside `exclusive()` fails here): put-if-absent by id, the stamp after the bucket's newest, the trim to 50 (counted in `evicted`), cap eviction, the quota retry and its stuck flag, holds, index-only copy, bodies shared by sha and dropped only when nothing names them, Older's creation, its expiry (≤ 0 = not stamped) and an expired Older reading as empty/null, `importOlder`, read-only, a missing body healing itself, and strict mode catching a stray await |
| `src/test/history-idb.test.mjs` | `src/js/03c-history-idb.js` (#83), the browser's IndexedDB backend for that store, over `fake-indexeddb`: the store's contract run over both backends, one transaction per job with dropped bodies deleted in it, quota → `quota`, a newer database served read-only, and the TEMPORARY v1 → v2 migrator over a raw v1 database (`seedV1HistoryDb`): everything moved, lost bodies skipped, bodies shared, a stopped move (`migrate-stop-after:N`) readable through the v1 reader and resumed to the same end. `tests/70-history-idb-migration.txt` is the same move in a real page |
| `src/test/apply-merge.test.mjs` | `applyMerge`'s orchestration (03-sync.js, #72) in its `mergeOnly` mode — the mode `applyStashedWork` runs in: the undo point's label chosen by `source`, "Undo merge" armed at it (with that `source`) and cleared rather than left stale when the store refuses the write, the 409's `server-conflict` undo point armed at the pre-merge document rather than the merged one (#97, which removed `armUndo:false`), `keepLabel`'s second snapshot, `unchanged` skipping the merge and the rev bump, `base`/`mine` normalised, and nothing on screen touched. Past `mergeOnly`, `awaitUndoPoint` (#96) adopting nothing — state, undo point, `baseState` — until the undo point's write has settled (held at the store's `delay-put` gate), a `newBase` function read only then, and `setBaseState` storing exactly what it is given with its reason. A stash's legacy inline picture and theirs' ref for the same bytes merging as one picture (#82). The rest of adoption reads the page and lives in the browser suites |
| `src/test/autosave-timing.test.mjs` | `autoSaveIdleFor` (14-export.js, #70): hosted strictly slower than local rather than three pinned numbers, the local path still 2s, a target that is not `"server"` never inheriting the hosted wait by default, both idles under the max timer, and the timing object staying live — which is what lets `tests/28-autosave.txt` drive real saves at 30ms |
| `src/test/api-fetch.test.mjs` | the `code` `apiFetch` (13-hosted.js) throws, which every caller branches on (#99): the server's own "no such document" 404 named `not-found` the way a 409 is `conflict`, every other 404 (`no-such-comment` above all) keeping `"404"` with its reason as the message, and 400/200 unchanged |
| `src/test/blob-policy.test.mjs` | `shared/blob-policy.js` (#82): `sniffImageMime` reading PNG/JPEG/GIF/WebP magic numbers and never SVG, `imageDims` over hand-built headers for all four (JPEG SOFn after DHT and fill bytes, EXIF orientation 5-8 swapping width/height, a 0x0 GIF screen falling back to the first frame, WebP VP8/VP8L/VP8X), `normalizeImageRef`'s accept/reject table, `refsIn` over rows, HTML fields, comments, replies and a conflict's `imageValue` (deduped, in order, only real `<img>` attributes, only lower-case shas), and the file loading identically through `require()` with no DOM |
| `src/test/blob-store.test.mjs` | the image registry (02c-blobs.js, #82 P1) against the memory backend and scripted fakes: `intern` determinism and copying, `internDataUrl` giving one sha however the base64 is wrapped and refusing what a browser would not decode, `dataUrlForSync` canonical, `urlForSync` reuse/revoke, `persist` resolving only after the backend's write lands (one write per sha, failures reported and retried, memory never counting as durable, `setBackend` forgetting durability) and `ensureBytes` reading the backend, re-hashing and reporting what is missing, neither ever rejecting. And a row's picture (P2a): `rowImage` reading a legacy data: URI or an `imageRef` (legacy wins, a bad ref is no picture), `rowImageUrl`/`Key`/`DataUrl`/`Bytes` for both forms (sniffed type over the claimed one), `rowImageShas`, and `blobImgHtml`'s src only when the bytes are here. The IndexedDB backend is `tests/65-blobs.txt`'s |
| `src/test/clipboard.test.mjs` | 05c-clipboard.js's pure half (#85 D6, D7): a copy's clipboard HTML/text without comment marks, a cut's with them and a nonce marker (`cutNonceIn` reading it however the clipboard wrapped it), a paste keeping comments only for this tab's live nonce and comments that exist, sanitised with formatting and tags kept and pictures/video cards kept out of the cell and listed to attach (#124: video links by host or file extension, a bare link attached rather than typed, a link inside words kept in them, a web-only picture counted as lost) and put in the scene's gallery by `attachToGallery` (#135: every picture and every video an item of its own after the ones there, a video's link its poster, never the same one twice, a video file's first frame as its thumbnail), plain text inserted as typing, a copied paragraph not bringing a line break, and b-roll keys (`brollIdsTaken`: every key in both columns, the pasted-into cell without its selection, the list's records unless a cut is moving it; `freshBrollIds`: a new id for a taken or repeated one, nothing else changed) |
| `src/test/gallery.test.mjs` | a scene's gallery (#135, 02d-gallery.js): `migrateGallery` keeping `imageLinks`/`moreImages` safe (unsafe or repeated links, bad records and stray keys dropped, a repeated picture once, an empty first slot taking the next picture, no keys added to a row without one, idempotent) and `refsIn` naming every picture; the slot operations (add beside, fill a placeholder, replace keeping the caption, remove moving the next up, a link off); `mergeStates` keeping both sides' pictures and links and either side's removals with no conflict card; a `.splitpage` carrying every picture inline and reading back the same gallery; `buildDocx` writing every picture and a "▶ " links line that `docxToRows` reads back into the gallery (a user's own "▶" line kept as words); `toMarkdownDoc` naming `images/scene-NN-2.ext` and each link; `buildPdf` drawing the further pictures and printing the links |
| `src/test/draft-edit.test.mjs` | 05d-draft-edit.js's pure half: pictures and video cards through the placeholder table and back unchanged, a placeholder never a character the box or a paste holds, formatting and a link over a picture leaving it out (an old body's `<strong>` round a picture undone), "bold throughout" ignoring pictures, `walkCell` counting a picture and a card as one position (every position round-trips, a caret inside a card's words lands at its edge), and the history: a typing burst as one entry, a structural edit ending the redo branch, typing after an undo doing the same, a burst that changed nothing leaving none, the selection an entry restores, 200 deep |
| `src/test/comment-anchors.test.mjs` | a comment follows its mark (#85 §3.2): `syncCommentAnchors` pointing each marked comment at the first cell holding its mark in document order (visual before audio), leaving a detached one, a conflict card and a title comment alone, the anchor id falling back to the comment's id; a split through a commented phrase marking both halves; `joinCells`' glue taking a comment or link both sides share and never formatting; `migrateRows` healing a stale pointer from an old file and from a merge where one side split the scene and the other kept the old `rowId` |
| `src/test/tag-panel-model.test.mjs` | the production panel's tag operations on the model (07-production-tags.js, #85): the old DOM code kept verbatim as the reference over stored-shape cells — tagging a phrase finds every occurrence the old walk found except a match whose neighbour across a formatting edge is a letter, and adds only matches that cross a formatting edge; the rules one by one (case, whole words in any script, never in a tag or link, across a line break, a b-roll key or a comment's edge); rename and remove leaving every cell reading as the old code left it and counting the same spans; a cell still holding a video card edited in place; and the shapes on which `tagsInField` would count differently from the model, which is why it stays on the HTML |
| `src/test/broll-model.test.mjs` | the b-roll list on the model (08c-broll.js, #85): `brollInCell(cellOf(html))` equal to the old HTML reader on every stored-shape cell and 2500 b-roll cells (keys and plain markers, in formatting, comments, links, tags), the by-design differences pinned (a line feed in a text node, a zero-width space, a key after an empty element or inside a tag); anchoring and renaming leaving each cell as the old DOM edits did, up to the marks on line breaks those used to split round; a cell still holding a video card edited in place; a key repeating an earlier line's id re-keyed by the anchoring pass (first keeps it, nothing else changes, in a card-holding cell too), an unanchored line never taking a record a keyed line holds, and `recordPastedBroll` making a fresh, scene-seeded record only for a pasted marker without one. And the props a shot needs (#149): `brollPropsInCell` reading the prop tags on each item's own lines (not before the first marker, not a location, one name once), `addBrollProp` finding an entry by any spelling or registering a new Prop the way the Gear box does, `removeBrollProp`, the shots each prop is needed for (tagged or added, each once), a rename in the breakdown carrying through (and a rename that folds re-pointing), a prop deleted from the breakdown still shown by name, a pasted copy getting none of the original's, and the breakdown CSV's last column. And the full-page shot list's files (#150, 08d-broll-panel.js / 17-pdf.js): `buildBrollCsv` one row per shot in script order with a Props column, quoting, and no record added by building it; `buildShotListPdf` over `brollShotListForPrint()` naming each shot and putting FLAGGED before a flagged one's note |
| `src/test/html-images.test.mjs` | images inside HTML (#82 P6), through the sanitiser (04-richtext.js): an inline `data:` image becomes `<img class="comment-img" data-blob data-w data-h data-mime>` with its bytes in the registry (type sniffed, wrapped base64 the same picture), idempotent, a `data-blob` image losing any `src` (the hydrator's `blob:` URL included), a known sha's attributes taken from the registry and an unknown one's kept only when valid, a bad sha dropped, never SVG or a remote or non-picture `data:`; `storedImageHtml` equal to the sanitiser's output; `storedHtmlFromDom` removing only the hydrator's attributes; an old document's comment/reply/cell images migrated and named by `refsIn`; `inlineStateImages` writing them inline (all, or only the listed shas) and `migrateRows` reading them back |
| `src/test/pdf-layout.test.mjs` | the script PDF's row layout around pictures (17-pdf.js `buildPdf`, run with `S.state` set and hand-made JPEG headers passed as its `jpegs`): the uncompressed content streams read back and every picture's draw rectangle checked — no two overlap, none leaves the page, and the row's rule and everything after it lie below it. A picture-only row (no text in either column) is a picture plus the normal row gap tall (it used to advance 14pt and be drawn over), a picture with short or long text beside or under it, and a picture pushed down the page a line at a time until it starts the next page. And pictures in comments and replies (`commentEntries({pieces:true})` and the comments layout, pictures interned into the registry as `ensureBytes` would leave them): drawn in body order between the text around them at the body's or the reply's indent, nothing overlapping the thing before it, sized to 60% of the column / 260pt tall / never past 96 dpi with the aspect kept, a picture-only body printing no "(empty)", a missing one as "[image unavailable]", an image conflict card's `imageValue` printed, one sha embedded once and listed on each page that draws it, a picture that no longer fits starting the next page, and `commentEntries()` without the option keeping its plain-text shape. And comment line spacing: the lines of one part of a thread (the header, the quote, the body, a reply's header or body) exactly LEAD (13pt) apart and each new part SIZE (9.5pt) further — not the 22.5pt a line the line-by-line room check gave every line — pictures keeping their order and room, and a comment near the page bottom carrying on under "Comments (continued)" with no line below the margin and no early break. And where a row's rule lands: a sweep of row lengths (0 to 100 lines a column) and picture heights (up to one filling its page) pushed down the page asserts every row's rule on or above the bottom margin (it used to fall to M - 11.5 finishing a continuation page, M - 19 under a picture, M - 23.5 for a picture-only row at the cap, 1.5pt under M past the old `+ 14` check), no baseline below M, every line printed, no rule alone at the top of a page, a row split only when it does not fit on a whole page and starting one, every page it leaves full (a last line whose rule would not fit goes overleaf with it), and a row moved to a new page only when it did not fit on the old one; a picture filling its page keeps its visual text (overleaf — it used to be dropped, with the rule drawn across the picture) |
| `src/test/comment-images-export.test.mjs` | pictures in comments and replies in the Word, Markdown and CSV exports (15-docx.js `buildDocx`, 14-export.js `toMarkdownDoc`/`toMarkdownTableDoc`, 16-csv.js `buildCsv`, 10-comments.js `commentBodyText`), run with `S.state` set and fake PNG/JPEG headers interned into the registry: the .docx read back with the app's own `zipRead` — one media part per picture (a comment showing a row's picture reuses the row's), each named and declared as its type, unique drawing ids, the pictures in body order between their text at the comment's or the reply's indent, sized to 60% of the column beside the indent / 260pt tall / never past 96 dpi with the aspect kept, an image conflict card's `imageValue` printed instead of "(empty)", a missing one as an italic "[image unavailable]"; the text formats writing "[image]" in reading order; and a text-only body reading exactly as its plain `body` |
| `src/test/docx-reimport.test.mjs` | reopening a .docx (15-docx.js `docxToRows`, `exportTailStart`): a `buildDocx` export with a row picture, comments with pictures, a quote, an assignee, replies and a resolved one reads back as exactly its rows — text, the row's own picture by sha, no row for the "Comments" heading or any comment line, no comment picture on a row — and matches the same export without comments; a hand-written Word document (`zipWrite`) whose table is not in the `SplitpageTable` style keeps its "Comments"/"Production breakdown" headings and what follows as rows, exactly as before; after a `SplitpageTable` table only a Heading1 reading exactly one of those two ends the script (a plain "Comments" paragraph, another Heading1, or the same heading before the table, is the user's). JPEG only — a PNG row picture needs a canvas jsdom lacks |
| `src/test/palette.test.mjs` | the tag palette and `--text-faint` read out of `src/app.css` (#143): every `TAG_CATEGORIES` entry naming `var(--tag-<id>)`, with that token and its tint in the light block and both dark blocks (which must agree) and a `.tag-anchor[data-tag-cat]` rule drawing it (HANDOFF invariant 14), no category within 25° of hue of the Visual blue or the Audio amber (teal and orange before #169), every category colour 4.5:1 on its theme's `--bg` and `--surface`, the text 7:1 on each tint, and `--text-faint` 4.5:1 on `--bg` in both themes — WCAG contrast computed in the test |
| `src/test/starters.test.mjs` | the New Tab page's starter scripts (`_starters.js`, `src/starters/*.json`, #144): the three ids, names and one-line descriptions, each starter passing through `migrateRows` unchanged but for the docId it mints (none in the file, a different one per copy, the bundled original untouched), no missing or unknown `STATE_FIELDS`, every `B-roll:` line a keyed marker whose record is already there with the name and description the list would read, at least four scenes with prop/location/VFX tags and a status, and a `.splitpage` round trip |

## The suites

| File | Covers |
| --- | --- |
| `tests/01-core.txt` | boot, typing, `[prop]` `{location}` `~vfx~` shortcuts, Tab autocomplete, Ctrl+Enter, runtime estimate |
| `tests/02-production.txt` | breakdown registry, status cycle, all four groupings, Ctrl+click multi-select, bulk status |
| `tests/03-exports.txt` | Markdown / CSV / breakdown CSV / DOCX / PDF actually produced, breakdown present, DOCX XML parses |
| `tests/04-prompter-find.txt` | teleprompter open/play/mirror/size, find & replace, tags survive replace-all |
| `tests/05-mobile.txt` | phone layout, no horizontal overflow, 16px inputs, long-press → tap-toggle selection, the File menu as a full-width sheet from the bottom (#145: scrim, its own close button, 44px items, nothing past the edge, the scrim closing it), File ▸ Search commands… opening the command menu inside the screen with no shortcut chips (#147), the writer on a phone |
| `tests/06-writer.txt` | the writer: paragraph-per-scene, Enter splits, Backspace joins, the join it refuses, tagging and rich text writing back, the visuals/numbers/compact gutter cycle, Save mirroring the header's, narration .txt/.docx |
| `tests/07-untagged.txt` | untagged mentions: found without wrapping anything, the prompt names its category, Esc mutes and typing revives it, Tab labels it, the breakdown's mention count catches up |
| `tests/08-writer-width.txt` | the writer's column at 1150px — the tightest window the hanging gutter still has to fit beside |
| `tests/09-alt-enter-and-scroll.txt` | Alt+Enter splitting only the focused column (both directions), a comment anchor repointed the same as the writer's, no scroll on ordinary typing, the scene follows through a large paste and a large delete |
| `tests/10-comments-panel.txt` | clicking a comment card jumps without closing the panel, a live selection suppresses the jump, script-order vs. most-recent sorting (replies count as activity), exports stay in script order regardless |
| `tests/11-comments-sort-persist.txt` | the comments sort preference survives a reload |
| `tests/12-gear.txt` | the `<gear>` shortcut and its colour, the header badge, quick-add reconciliation (orphaned items un-track, live-tagged ones don't), scene grouping, status/rename/remove/delete through the shared card wiring, mutual exclusivity, and both packing-list PDF exports |
| `tests/13-onboarding.txt` | the first-run setup wizard: shows on its own over a pristine copy with no key set, hidden once the key is set, Next/Back through all 4 steps (step 2's "cannot register here" text under the harness), Skip writes the key with `skipped:true`, hidden after reload, File ▸ Set up Splitpage… reopens it without clearing the key, Esc skips, `#rows` byte-identical throughout, and the pristine-seed gate (`seedCheckPasses()`) failing once `#state-data` no longer matches the shipped checksum |
| `tests/14-help.txt` | the in-app Help page: opens from the File menu, the TOC has more than 10 links and every href resolves inside `#help-body`, opening it closes the comments panel, Esc closes, and "Tagging reference" deep-links into the full guide |
| `tests/15-tutorial.txt` | the 5-step coach-mark tour: opens from the File menu, Next/Back/Finish, Skip at several steps, a "Read more" link into Help, `#rows` byte-identical before and after, `splitpage-tour-done` set, and the card stays inside the viewport at a 375px phone width |
| `tests/17-formats.txt` | the two project formats: `.splitpage` and `.md` round-trip the state exactly (tags, comment anchors, images — back as an `imageRef`, carried inline in both the `.md` table cell and its data block — statuses, wpm, people), a hand-edited table cell wins for that cell and its tags re-attach, an added scene asks rather than guessing, a legacy `.html` still opens, the data fence never collides with content |
| `tests/18-connect.txt` | the Servers dialog from the File menu, bookmarks persisting (and holding nothing credential-shaped), the SSH command, the join-PIN dialog's validation, `#launch=` stripped from the URL on load |
| `tests/19-save-conflict.txt` | the on-disk conflict check for project saves (`.md`/`.splitpage`): `saveDoc()` refuses to overwrite a file that changed on disk since it was opened, the same guard `saveBackToFile()` already had for the import re-save path, driven against a fake `FileSystemFileHandle`-shaped object since no real file picker can run headless. Pictures (#82): Save writes them inline, one whose bytes are nowhere goes in as its ref with a "1 image could not be included" toast, the page keeps its refs, and the guard still guards |
| `tests/20-comment-drift.txt` | a `.cmt-anchor`'s live text drifting from `quotedText`: still jumpable with a small red "Changed" tag (the original quote in its tooltip), orphaned once the span is edited down to nothing with a "No longer in script" tag after the quote on the same line, upright and `--danger`, and the tag alone with no empty quote marks when the quote was empty (#186) |
| `tests/21-desktop-shim.txt` | the desktop bridge (20f-desktop.js), driven with `window.__desktopTest`'s fake backend in place of a real Electron shell: a desktop file handle round-trips non-ASCII text byte-exactly, a cancelled Save As leaves `state.rev` and the toasts alone, the on-disk-conflict guard fires when the fake file's mtime moves, the native-menu-command dispatcher reaches the same find bar and comments panel the File menu and header button do, and the app-data import menu dispatcher and merge flow |
| `tests/22-doc-id.txt` | document identity (02b-doc-id.js) *in a running page*: boot minting a valid id, `reassignDocId`'s Save-As fork that never writes the user's file (overrides.md #1), a failed Save-As write not retargeting Save, identity surviving a document opened while the Save As dialog is up, exports carrying no id, a legacy `.splitpage`/`.md` re-deriving the same id on reopen, `adoptRestoredState` keeping the id regardless of the snapshot, and the fake-BroadcastChannel duplicate-claim reassignment. The pure half — the FROZEN SHA-256 vectors (HANDOFF invariant #37), the `deriveDocId` golden, hostile-id replacement, the `mergedDocId` truth table and `decideDuplicateLoser` — is `src/test/doc-id.test.mjs` (#67) |
| `tests/23-doc-id-reload.txt` | document identity (02b-doc-id.js) across a real page reload: a pristine boot always mints a fresh id, and ingress decides whether anything needs merging before adopting one — `goto` wipes `window`, so this is its own suite rather than a section tacked onto 22's |
| `tests/24-history.txt` | per-document version history (03a-history-store.js over `shared/history-store.js` and 03c's IndexedDB backend since #83, + the `03-sync.js` glue; `__historyTest`'s `listRaw`/`docRecord`/`bodyCount` read the store's index, `count`/`bytes` computed from it, and `bodyCount` counts the distinct bodies a bucket names): real captures via `loadFileIntoEditor`'s foreign-file push and a fixture `.splitpage` reopen (no direct `pushSnapshot` access — see build.mjs), the pristine seed never snapshotted until it's dirtied, per-document isolation and the open history panel following the active document, the newest-50 cap and call-order sorting under a frozen clock, restore backing up first and keeping the current docId, copy idempotence, the quota-always forced restore, and a document edit landing mid-backup aborting or completing the restore correctly |
| `tests/25-history-migration.txt` | the one-time migration of the old shared `splitpage-snapshots` localStorage list into per-document history's Older bucket (`startHistoryMigration`), and the merge-undo path (`lastMergeUndo`) that rides the same store: legacy entries (including a hostile id) re-minted into Older with the legacy key removed, a repeat migration adding only what's new, a failed import or a corrupt key never deleting the legacy key, a key that changes mid-migration never left deleted unless its latest content actually made it into Older, and Older itself being shared across every document, restoring under the current document's id, and expiring as a whole 90 days after the migration |
| `tests/26-desktop-drafts.txt` | crash-safe drafts, renderer half (20g-drafts.js): the writer's timing and dedup, and the restore's outcomes, against `__desktopTest.setBackend()`'s fake backend and `__desktopTest.drafts` — the scheduler never writing per keystroke, an edit during a save drafted and rebased, a clean save discarding the draft, visibility-hidden flush, the disk-unchanged decision made by content not mtime, a detached copy forking its id with a history copy, the pending latch, `applyStashedWork` override isolation, server-override outcomes, sanitisation, and browser inertness. Pictures (#82): with a blob-capable fake the draft's picture is `blobPut` before `writeDraft` (invariant 52) and the draft carries the ref, not base64; a refused `blobPut` puts that picture in the draft inline instead, and restoring it gives the ref back |
| `tests/27-app-data.txt` | export bundle shape (§5 #48 key walk, round trip), idempotence, merge rules for prefs/bookmarks/history, refusals (wrong format/version/truncated), legacy `snapshots` → Older, cap/ordering, and the import section of 21-desktop-shim.txt. Images (#82 P7, snapshots with hand-built `imageRef`/`data-blob` refs, canvas PNGs in the real `splitpage-blobs` IndexedDB): the bundle's `blobs` carries exactly the named images read back from the store and `missingBlobs` the absent one (File ▸ Export app data… warning about it), hex keys and base64 never tripping the §5 #48 walk, import storing every image durably while history puts are held at the `delay-put` gate (§5 #49 ordering) and the bytes round-tripping, a tampered / SVG / bad-base64 / over-16-MiB image refused while its snapshot still imports and an unnamed one ignored, an old bundle with no `blobs` importing as before, and images counting toward the export cap (`__historyTest.setExportCap`) |
| `tests/29-updates.txt` | the update bar (20a-update.js), fed a status through `window.__updateTest`: nothing shown when up to date or merely checking, the launcher copy's text and its staged-and-waiting line, dismiss staying dismissed when a later status arrives, and the desktop app's four states — Download (which calls the bridge, not a link), progress with no second button, Install and restart, Try again after a failure, and the release-page fallback for a release with no installer for this machine |
| `tests/30-new-tab.txt` | the New Tab page (20j-newtab.js), opted into with `?newtab=1`: it showing itself over the pristine demo and not over a document, Esc leaving the demo untouched, "New script" giving a genuinely empty document (one blank scene, no tags/comments/b-roll/people, its own fresh docId), "Open a file" running the real picker path against the desktop fake backend (a cancelled picker leaves the page up, a picked file loads into the tab and closes it), and the harness suppression every other suite depends on. Then the start screen (#144), over that opened file: the heading, Blank script and the three starter cards in `STARTERS` order with their previews, no Recent column and the desktop-app link in the browser build; each starter opening as a new document — its rows and title, a docId none of the others had, no file home, not dirty — and, after the idle passes, equal to a fresh copy of the starter (nothing about opening it changed it); Esc and "Look at the example script instead" over a starter leaving it exactly as it was; "paste one" opening the import modal in its new-document mode (Esc closing the modal and not the page, the pasted rows becoming a document of their own with nothing of the one before, File ▸ Paste a script… the ordinary import again); a real `DragEvent` drop — a picture refused with the page left up, a `.md` lighting the zone and opening as File ▸ Open would; the tour and the cheat sheet taking the page down to show the example; and Join a shared session being the Servers dialog, Esc closing it before the page |
| `tests/28-autosave.txt` | autosave (14-export.js) and the save-state indicator (12-dirty-toast.js): nothing written before the document has a file, one write per pause in the typing rather than one per keystroke, a window blur bringing a pending write forward, the File-menu toggle and its remembered preference, and a file changed on disk halting autosave instead of throwing a modal over the typing — driven against the same fake `FileSystemFileHandle` 19-save-conflict.txt uses |
| `tests/31-broll.txt` | b-roll markers (08c-broll.js): typing `B-roll:` at the start of a line makes a `.broll-key` chip regardless of active formatting — plain, bold, bold with a real Enter into a second line, and bold with a `<br>` forced to sit nested inside the bold element itself (issue #18) — plus the two negatives that still have to hold: mid-sentence text, and text inside a link (`isInsideTagOrLink`, unaffected by the fix), and the b-roll panel's own count once every line is read back, including the still-unwrapped fallback match inside the link |
| `tests/32-prompter-mirror.txt` | teleprompter Mirror/Flip (issue #27): both off by default, each toggling its own class on `#prompter-scroll` independently, both together for the full 180°, `M`/`F` while the prompter is open (and doing nothing once it's closed), the reading line and control bar never being descendants of the transformed element, the setting surviving a `goto` reload (per-device localStorage, not the document), and none of it tripping the save-state indicator |
| `tests/33-drag-autoscroll.txt` | auto-scroll while a scene is dragged to the top/bottom edge of the window (21-events.js's window-level `dragover` listener + 06-rows.js's `updateDragScroll`/`dragScrollStep`): scrolling starts from a single `dragover` and keeps going from its own `requestAnimationFrame` loop with the pointer held still, the drop marker tracks via `elementFromPoint` as the page moves under it, leaving the hot zone stops it with no drift, `dragend` stops it and clears `draggable`/`.is-dragging`/the drop markers, nothing scrolls once the drag is over, the top zone works even though the sticky header (not `#rows`) is what a pointer near the top is actually over, and a `dragover` in the zone with no scene armed (dragRowId unset, as for an incoming file drag) never moves the page — driven with synthetic `mousedown`/`dragstart`/`dragover`/`dragend` events since a real native drag session cannot be produced over CDP |
| `tests/34-desktop-app-data-export.txt` | File ▸ Export app data… driven on the desktop path (20h-appdata.js's X1, 03a-history-store.js's `desktopHistoryBackend`/`exportHistoryAll`, `DESKTOP.historyListDocs`; the fake's history is the real `shared/history-store.js` over the memory backend since #83, behind main's IPC shapes): two documents' history seeded directly against `__desktopTest`'s history-capable fake backend (not through an open document, so enumeration is genuinely exercised), the same §5 #48 key walk 27-app-data.txt's own case 2 runs, bundle shape matching the browser build's, a full round trip through the real import path into a fresh fake backend, and the File-menu Export/Import entries both visible once `initDesktop()` runs against the fake. Images (#82 P7): with the blob registry pointed at `makeDesktopBlobBackend` over the fake's blob bridge (`__appDataTest.useBlobBackend`), an image seeded only in the fake's blob store exports (read through `blobGet`) with a missing one listed, and importing into a fresh fake calls `blobPut` before the first `historyPut`, the bytes landing intact. And the wiring (#82 P2a): a bridge with the blob calls, set through `setBackend()` the way boot sets the real one, becomes the registry's own store (`backendInfo()` `desktop`/persistent, `persist` landing in the fake's blob store), a bridge without them leaves it alone, and `restoreBackend()` to no bridge hands the choice back |
| `tests/35-open-new-document.txt` | File ▸ Open of a foreign `.docx`/`.md`/`.txt`/`.csv` starting a NEW document (issue #7): a populated project adopted from a `.splitpage` fixture, then a plain `.txt` opened over it — a fresh `docId`, empty `productionTags`/`people`/`brollShots`/`comments`, both Save homes cleared, `docIdWrittenOut` back to false, no panel badges carried over; a foreign `.md` taking its `#` heading as the title; and the other half of the decision — File ▸ Paste a script… replacing the rows while keeping the document, its id and its whole record, driven both by pasted text and by a picked `.csv` whose two columns survive the modal's `pendingFileRows` bypass |
| `tests/36-newtab-recents.txt` | the New Tab page's recent-documents column (issue #15, `20j-newtab.js`), opted into with `?newtab=1`: hidden entirely in the browser build, shown and widened to three columns once a desktop bridge is there, drawn most-recent-first from `listRecents()` with the title and the file name and no path anywhere in it, a click reopening through the same `routeOpen` File ▸ Open uses, a rejected `routeOpen` (the moved-or-deleted file) saying so and leaving the entry to be forgotten, per-entry × and Clear recent both reaching the backend, the list never appearing in the app-data bundle (§5 #48); since #144 the column beside the New grid at ~380px (at a desktop width), the file name the one thing in mono, no desktop-app pitch with a bridge, and a starter opened over a file-backed document making no file call at all (dialog, read, write, stat, route) and telling main `fileId: null`, `dirty: false` and its new docId — all against `__desktopTest`'s fake backend |
| `tests/37-share-link.txt` | File ▸ "Publish & copy a link" (issue #19, `13-hosted.js`): the entry sitting with the exports and always shown, the `?doc=` link it builds (escaped, this page's own address when nothing is connected, replacing an existing `?doc=` rather than appending), the three things it says about getting in (open, join PIN, Access sign-in), the no-server path refusing and opening Servers… instead of publishing, a read-only server disabling it with the reason in its tooltip, `?doc=` being read once at boot and taken straight out of the address bar, and the standalone HTML export still carrying no document id. A real publish needs a real server — see "A share link end to end" below |
| `tests/38-newtab-phone.txt` | the New Tab start screen (#144) at 375px with touch emulation: nothing wider than the screen (the document, the page's own scroller, every card, the bar's buttons, the drop zone, the footer), one column of cards with the picture beside the name, the bar's actions on their short labels on one line (full names in `aria-label`), the 16px gutter; the Recent column under the grid once a (fake) bridge is there, its × inside the gutter; and a starter tapped open with no overflow after |
| `tests/41-export-polish.txt` | .docx and Markdown export polish (issue #20, 15-docx.js/14-export.js): the .docx's named styles, theme font, table style and page-numbered footer all present and every added XML part parses, a "No." scene-number column that survives a real reimport without disturbing the visual/audio split, a breakdown table whose column widths actually track content length (`fitColumnWidths`) rather than a fixed guess, the plain Markdown export's inline `*Visual —*` lead-in replacing the old bold-label-per-field paragraphs with no `_(no …)_` placeholders, an embedded picture shipping as a small zip (the .md referencing `images/scene-NN.ext` instead of inline base64) while the two-column Markdown export that feeds the `.md` project format keeps embedding base64 unchanged; and the PDF's picture rows (17-pdf.js) through the real export — picture only twice, picture + short text, picture + long text, and a picture that no longer fits at the bottom of a page — with its content stream parsed and no picture overlapping another, leaving the page, or drawn over by the rows after it; then pictures in comments and replies: a `.splitpage` with inline PNG/JPEG pictures in two comments and a reply opened through `openFile` and exported, the pictures drawn in body order between their text, nothing overlapping, each in its page's resources, the small PNG at its own size and the rest sized to the column, one pushed below twenty lines starting the next page, and a picture nobody has printing "[image unavailable]"; then the same for the other exports: a `.splitpage` whose comment holds a PNG and a JPEG, whose replies hold a JPEG between text and the body's PNG again, with a picture-only image conflict card and a picture nobody has, exported to Word — the `.docx` unzipped in the page, its media parts, relationships and content types, the pictures in the comments section in order at their indents and sizes, one part for the PNG shown twice, the conflict card's picture and an italic "[image unavailable]" — and to Markdown (both shapes), CSV and, through a foreign `.txt`'s Save to file, plain text, each writing "[image]" where a picture was and no "(empty)"; and reopening Splitpage's own .docx (`exportTailStart` in 15-docx.js): the breakdown export from the top reopens as its two scenes with no "Production breakdown" row, a `.splitpage` with a PNG and a JPEG row picture, comments with pictures, a quote, replies and a picture nobody has, exported through the File menu (the export checked to carry the comments and all five pictures), reopens as exactly its three rows — text compared through `__plain`, which reads escaped markup as text too, since File ▸ Open still escapes a .docx's formatting (a schema-less `migrateRows` in `loadFileIntoEditor`) — with the two row pictures at their sizes and no comment line, heading, author or picture on a row; and a Word document of the user's own (a store-only zip written in the page, table in Word's `TableGrid` style, then a "Comments" Heading1) still importing that heading and the line under it as rows |
| `tests/40-comment-assign-filter.txt` | Comment resolver attribution, assignment and the filter bar (issue #29): an old comment with none of the new fields keeps working, "Resolved by X · relative time" appears and clears on unresolve, the assign picker offers production-breakdown people plus anyone who has commented (escaped), the Open/Resolved/All filter bar and its "assigned to me"/"assigned to a person" dropdown narrow the list with live counts, the filter is a per-device localStorage preference that survives a reload and never dirties the document, and resolvedBy/resolvedAt/assignee round-trip exactly through both `.splitpage` and `.md` |
| `tests/47-move-scene-keys.txt` | Alt+Up/Alt+Down move the scene under the caret one place earlier/later (issue #24, `swapAdjacentRows`/`undoMoveRow` in 06-rows.js): no wrap at either end, the caret returns to the same field and plain-text offset, tags/status/comments travel with the scene, the production breakdown and comments panel pick up the new order, one Ctrl+Z step puts it back, the same gesture works in the writer and syncs `#rows` back on close, and it never fires inside a comment reply box |
| `tests/45-broll-anchoring.txt` | b-roll anchoring (issue #21): a `B-roll:` line getting a real `.broll-key` span however it arrived, not only when it was typed — a two-column import's Visual lines anchored with one id per line (never two lines sharing one), a clipboard paste left alone while the caret is still in the field and anchored the moment it is left, nothing still flagged `markerless` in the panel afterwards, and the consequence the issue measured: a status set on an imported line surviving a rewording of that line instead of orphaning its record |
| `tests/46-import-tag-prompt.txt` | the Import dialog's "What should Splitpage look for in this script?" choices (issue #22), built from `IMPORT_SCANS` rather than written into `page.html`: on by default and the imported lines arriving already anchored (no blur, no later pass), the count reported in the import's own toast, the answer remembered in `localStorage` both ways, and a declined import left byte-identical — including against the #21 anchoring pass, which has to keep its hands off it while the b-roll panel still counts it as it always did |
| `tests/43-review-mode.txt` | a review session (issue #30), driven through `window.__hostedTest.setSession()` since the harness cannot start a real server: the `#review=` key read out of the address and taken off it, a review key alone restricting nothing until a server says the role is review, the "Viewing · comments only" badge, every field non-editable with a Comment-only toolbar (and still focusable, so text can be selected to comment on), no status/reorder/insert/delete/image controls, typing and Ctrl+Enter doing nothing, a control left in the page shell (Add row) refused by the click guard with a toast rather than by CSS alone, no writer, no Replace, the body class being a symptom the role survives being stripped of, comment cards offering Reply but not Resolve/Delete (a Resolve button forced into a card refused by the click guard with the toast, the comment untouched — reviewers never resolve), the same session as an editor getting everything back, the review link offered to a host and not to a reviewer, and a local document in the same tab staying editable |
| `tests/44-presence.txt` | presence (issue #28), fed answers through `window.__presenceTest.apply()` since the harness cannot start a real server: nothing sent at all for a local document or an idle tab, coloured initials in the header naming each person on hover, a matching gutter dot on the scene they are in, the dot moving onto the field itself when it is the field you are in (and never INSIDE the `.cell-editable`, where it would be read back as script), "Guest" plus a stable colour for anyone anonymous, the colour following the name so one person looks the same in every window, a full re-render repainting the marks and leaving the row HTML byte-identical, marks taking no clicks, and what a beat actually carries — the author-name preference, the scene and field, and a per-tab id in sessionStorage |
| `tests/42-local-merge.txt` | "Merge them" on the on-disk conflict modal (18a-local-merge.js): the button offered only once the copy on disk parses back as a document (and never for a file that doesn't), the review pane listing both sides with `.diff-add`/`.diff-del` spans inside the field, a true three-way merge from the retained ancestor raising no conflicts for two disjoint edits, Cancel writing nothing and applying nothing, Confirm reporting through the merge banner with nothing yet on disk, the two-way fallback once the ancestor is dropped (`forgetDiskBase`) turning an overlapping edit into an Unmerged-edit comment and offering Review conflicts, and the whole flow again through a `makeDesktopHandle()` handle over `__desktopTest`'s fake backend. Pictures (#82): both sides replacing one scene's picture lists a "Visual image" conflict drawn from both refs (`img.diff-img[data-blob]` filled with `blob:` URLs), confirms to theirs live plus a card holding mine as `imageValue`, and "Use my version" puts my picture back |
| `tests/48-hide-shot.txt` | hide shot scenes (issue #25, 01b-hide-shot.js): off by default, the File-menu checkbox and `Ctrl`/`Cmd`+`Alt`+`H` both toggle it, collapsing every contiguous run of Shot scenes into one "N shot scenes hidden" strip that expands on click, a visible scene turning Shot getting a short grace before it joins its strip, Find & replace/comments "jump to"/tag "jump to" all expanding a hidden run to reach their target, the runtime chip switching to remaining/total, the writer and the teleprompter both leaving hidden scenes out, and none of it touching `state` or the dirty indicator (the per-device `localStorage` write itself is checked after every toggle; a `goto` reload leg is deliberately left out — this suite is already busy enough that one aborts the CDP socket, per the driver gotchas below) |
| `tests/49-prompter-scene-mode.txt` | teleprompter scene mode (issue #26, 20-teleprompter.js): off by default and remembered per device, opening from a scene (or with the caret in one) cueing it, Next/Previous by button and by `←`/`→`, the "Scene N of M" readout, and scenes "hide shot scenes" (#25) already hides being left out of the count entirely — driven through `window.__prompterTest`'s `checkSceneBoundaryNow`/`simulateVoiceWordCursor` since a real scroll-driven auto-pause needs `requestAnimationFrame`, throttled in a background/headless window (see "What this cannot test"), and Follow My Voice needs a real microphone: the one-shot auto-pause firing exactly once and arming the next scene's end without re-scrolling (so Play resumes into it rather than replaying it), and the same boundary tripping from a simulated recognised-word position |
| `tests/50-panel-resize.txt` | every side panel drag-resizable by its left edge, not just Comments (issue #50, 03b-side-panels.js): Production/Gear/B-roll default wider (520) than Comments/Gear/History (400), the same 280–720 clamp for all five, the legacy `splitpage-comments-panel-width` honoured as Comments' own initial width until it is actually dragged, double-click reset, the handle's mousedown preventing the browser's default, per-panel independence (widening one leaves the others alone and survives switching panels), `#root`'s padding-right tracking whichever panel is open at ≥1100px, and per-panel widths surviving a `goto` reload — driven with synthetic `mousedown`/`mousemove`/`mouseup` on the handle and `document`, the same way 33-drag-autoscroll.txt drives a scene drag |
| `tests/54-server-conflict.txt` | the compare-and-set save and its 409 merge (`saveToServer`, 13-hosted.js), with `fetch` replaced for PUTs to `api/docs/` only since the harness cannot start `server/server.js`: `baseRev` taken from the server's own answers and nowhere else, `state.rev` never pre-incremented by the client (#72), both sides' edits surviving the merge onto the screen and onto the wire, the banner appearing only once the merged version is stored, and "Undo merge" after it (#97): offered with the banner saying the next save replaces the merged copy, confirming as "Drop their changes?", restoring the PRE-merge document locally and dirty with no PUT forced, the next save going out at the rev the 200 handed back and carrying that version, a 409 on that save (somebody saved in between) keeping the undone changes undone while taking their new one, two 409s in one save filing one undo point at the user's own version rather than the half-merged one, and a pull afterwards taking the button off the banner even with that undo point armed |
| `tests/55-pull-merge.txt` | the pull channel (`notePresenceRev`/`pullServerDoc`, 13-hosted.js, #69): two clients on one page — this page is client B, client A is the document on the fake server — with `fetch` replaced the way 54 replaces it, for POSTs to `api/presence`, GETs of `api/docs/doc-pull` and PUTs held open on purpose. A saves, and B sees the row inside 3s off the REAL two-second heartbeat without saving anything; B's own unsaved edit in another row survives; no PUT goes out; a beat repeating a rev makes no request at all; a rev that moved but brought nothing new leaves the rendered HTML byte-identical and says nothing; NO history snapshot is filed (the fifty-entry cap is why) and the banner offers no "Undo merge" (#97); and nothing is pulled while a save is in flight, nor for a beat about another document, nor for the `rev: null` a document with no head line answers with |
| `tests/56-one-home.txt` | the one home record (`_home.js`, #73) through the real `saveDoc()` and the fake desktop backend, read back off `__hostedTest.home()`: a foreign file opens as the `import` home with the file chip on it; a cancelled or failed Save from it leaves that home in place (`undoRetarget` → `restoreHome`), one that writes makes the project file the home and takes the import chip with it; a Save As from a server document leaves the server home alone (the copy is a file on disk, not a second home) and leaving the server afterwards leaves nothing underneath; `setSession({docId:null})` only ever clears a server home |
| `tests/57-review-comments.txt` | the review client on the comments endpoints (#71, 13-hosted.js/10-comments.js), with `fetch` replaced for `api/docs/` since the harness cannot start `server/server.js`: a review session never PUTs and never PATCHes (the emulator answers a reviewer's PATCH 403 `reviewers-cannot-resolve`, as the server does); a new comment and a reply each go out as their own POST in document order; no Resolve on a reviewer's cards, and a resolve found in the reviewer's state (an old stash's shape) is not sent on Save but put back to the server's unresolved copy, with the rev unmoved and the document clean; the server's stored comment adopted in place of ours; `anchored:false` removing the span from the scene while keeping the comment; `home.rev` adopted only on an exact successor, so two real heartbeats afterwards fetch nothing, while a jump leaves it behind for the next pull; a failed post staying pending and resent with the same ids; and an editor on the same document still PUTting and never POSTing |
| `tests/58-prompter-open-in-browser.txt` | the browser side of the desktop teleprompter's "Open in browser" (#86, 20-teleprompter.js): `?teleprompter=1#script=<token>` fetching the script from the same origin and opening it read-only with no file handle and no history snapshot, `?teleprompter=1` beside `?doc=` opening the prompter once the hosted document loads, both clearing their parameters from the address bar and surviving a reload through `sessionStorage`, the desktop Follow My Voice button offering the hand-off instead of a dead end, and File ▸ This document ▸ Present in browser — the in-page route to View ▸ Present in Browser, whose menu bar Windows never draws — offered only with a bridge that can hand off, absent in the browser build, and the one button the native item clicks |
| `tests/59-per-tab-connection.txt` | per-tab server connections, the half one page can show (#11, `conn` in _home.js): a fresh page on its own origin, pointing THIS tab somewhere without moving the default for new pages, a token kept for the server it was given for (sessionStorage `{serverUrl, token}`, "remember" as a per-server map, the pre-#11 single remembered token migrated under its own base), another tab's pick reaching this page only as the localStorage default and a reload staying on this tab's server, a stale token forgotten for its server only, the review role belonging to the document's connection, a desktop open-server payload naming another server pointing the tab there first, and the document-state report carrying the server but never the token. Two pages on two real servers is the desktop smoke suite's "per-tab connections" groups |
| `tests/60-file-menu.txt` | the File menu as a dropdown under its button (issue #145, 18b-file-menu.js; 13-hosted.js's `updateServerMenu` writes the Share items' reasons): 372px wide, anchored to the button, 8px radius (`--radius-md`), no scrim or title bar off a phone, the menu itself focused when the mouse opened it; the file card ("Not saved yet", an Autosave `menuitemcheckbox` switch, Save a copy…, Save to file only with a foreign file open, `timeAgo`'s words); four headed groups in order and none collapsed (no `.menu-section-toggle` left); every item with an icon, sentence case, 36px, 14px; shortcut chips only for what works in the browser build (Ctrl+Shift+S, Ctrl+O, Ctrl+F, Ctrl+Alt+H; no F1) with `aria-keyshortcuts`; Publish & copy a link's "No server connected — set one up first" second line, still enabled; a switch leaving the menu open; the Import submenu opening in place; the keyboard (↓/↑ wrapping, Home/End, → and Enter into a submenu, ← out, Esc closing onto the File button, Enter and ↓ on the button opening on the first item); none of it dirtying the document; every `data-file-action` from the old menu plus New script, Export… and Export again (#146) and Search commands… (#147) present exactly once; Ctrl+S / Ctrl+Shift+S / Ctrl+O in the browser clicking the header's Save and the menu's own items, and standing down under a desktop bridge (whose accelerators send them) while the chips gain F1 and Ctrl+Shift+P; Open recent from the fake bridge's list (no path) opening the file and the card naming it and its format; and New script giving an empty, clean document with a fresh id and no home |
| `tests/61-transitions.txt` | the header's condense/expand as one movement (issue #52, `20i-topbar.js`) and the document keeping step with a side panel (issue #53, the `#root` rules in `app.css`): `.topbar` easing only its shadow now that everything which moves is a transform, the layout landing in the frame the class flips while the FLIP is still running, the brand line taken out of flow and fading rather than vanishing, the title's transform carrying a scale, the document below travelling with the header, a scroll reversed mid-movement replacing the running animation instead of layering over it, the scroll offset held across a toggle so the browser's scroll anchoring cannot flip the state back (the 64/24 gap alone never could), reduced motion driven through a stubbed `window.matchMedia` for the JS half and read off the shipped `@media (prefers-reduced-motion: reduce)` rules for the CSS half — the driver's `viewport` sets device metrics, not media features — and for #53 `#root` holding the panel's arriving timing when one is open and its shorter leaving timing when none is, Production→Comments settling once inside the span between the two widths, and the transition standing down for the span of a resize drag |
| `tests/62-server-not-found.txt` | a save to a document deleted on the server (#99, 13-hosted.js), with `fetch` replaced for PUTs to `api/docs/`: a 404 `not-found` runs saveToServer's own branch — the warning, the server home cleared through `setHome()`, no generic error toast, the edits kept on screen and dirty — including when it answers the merge's retry after a 409; a 404 about something else keeps the generic error and the home |
| `tests/63-restore-notice.txt` | the desktop restore notice (#93, `initDesktop`'s `onRestoreNotice`, 20f-desktop.js), fired through `__desktopTest`'s fake backend `_fireRestoreNotice()` with the `{skipped:[{name, reason}]}` main sends on `splitpage:restore-notice`: nothing listening until `initDesktop()` registers it, an empty or missing `skipped` saying nothing, and a real one giving exactly one sticky `warn` toast naming every skipped tab with its reason in words (`server-unreachable` → "server unreachable", an unknown code as-is, a nameless entry as "a document", a name as text never markup), still up after an ordinary toast would have faded, gone on a click, and the document's rev and id untouched |
| `tests/64-desktop-drive.txt` | Google Drive in the desktop app (#10), the modal's half, against `__desktopTest`'s fake backend with its drive members (`makeFakeBackend({drive:true})`, 20f-desktop.js): the File menu entry hidden for a bridge without them and offered with them, the not-configured panel naming the exact client file and both env vars with no API key / Client ID form, argument-free sign-in landing in My Drive, a folder listed with no rename/delete/new folder, a download saved through the desktop Save dialog (a Google Doc as `.txt`, a Sheet opened in Drive instead), an upload creating a file and a same-name upload replacing it (`fileId`, no name), no URL or token-shaped argument ever passed and no Drive key in either storage, a pasted folder link, SIGNED_OUT dropping back to the sign-in button, refused and state-mismatched sign-ins, the session-only wording, sign-out, and the web modal unchanged once the fake is removed. The main-process half (the loopback flow against a fake Google, safeStorage, relaunch, revoke) is `desktop/test/smoke.mjs`'s "google drive" groups and `desktop/test/google-drive.test.mjs` |
| `tests/65-blobs.txt` | the image blob registry in a real page (02c-blobs.js, #82 P1 — driven through `window.__blobsTest`): booting opens no `splitpage-blobs` database, canvas PNG/JPEG/WebP measured, sniffed and hashed equal to `crypto.subtle`, `internDataUrl` agreeing with the browser's own `<img>` verdict on a dozen base64 variants (wrapped, CRLF, spaces, unpadded, trailing VT accepted; inner NBSP/VT, mid `=` refused), `persist` → IndexedDB record `{mime,size,bytes:Blob,addedAt,usedAt}`, reload via `goto`, `ensureBytes` finding it again and a `blob:` URL rendering under the page CSP. Then the readers (#82 P2a), over rows given an `imageRef` by hand and re-rendered through `__renderTest.render`: bytes in memory render with `data-blob`, width/height and a `blob:` src straight out of the synchronous render; bytes only in IndexedDB render with `data-blob` and no src until the hydrator's `ensureBytes` fills it; a sha nobody has becomes `data-blob-state="missing"` / "Image unavailable" and a no-op render leaves it; a legacy inline row renders exactly as before; and the exports — PDF with every picture a JPEG stream (PNG/WebP converted, the missing one left out), Word with three, the Markdown zip with `scene-NN.png/.webp` and no reference to the missing one, the two-column table inlining canonical data: URIs |
| `tests/66-hosted-blobs.txt` | the hosted client's half of image blobs (13-hosted.js, #82 P5), with `fetch` replaced for every `api/` URL by a small emulator of health/me/presence/`blobs/missing`/blob PUT and GET/document PUT/comments POST that records each call's `x-splitpage-client` header and status, and states given `imageRef`s and `<img data-blob>` comment bodies by hand over canvas PNGs in the registry: every call carries `x-splitpage-client: 2`; a health without `blobs` → the save carries the images inline (`visualImage` data URI, comment `src="data:…"`) and makes no blob call while the page keeps its refs; with `blobs: 1` → `POST missing` → `PUT api/blobs/<sha>` (raw bytes, `image/png`) → document PUT, in that order, and nothing uploaded the second time; a 422 → upload what it lists → one retry; a 422 for bytes nobody has → retry with `acceptMissing`; a reviewer's image comment (by hand, and one written through the comment composer) → missing → blob PUT → POST, a 429 `review-budget` toast with the comment kept back, an image nobody has refused without `acceptMissing`; `fetchBlob` re-hashing (wrong image and a sign-in page refused) and `ensureBytes` reaching the server through it; an older cross-origin server's refused preflight retried without the header and remembered per connection; 426 → one "This page is out of date … Reload" toast and no further PUT; a picture nobody has asked of the server once, not on every re-render — remembered five minutes, forgotten when a pull brings new server state |
| `tests/67-render-perf.txt` | what rendering costs in a long script (#84), read off `window.__renderTest`'s counters (full renders, rows and fields repainted, production-index derivations, idle refreshes) on a 300-scene document opened through the real open path: typing into one cell with real key events renders nothing, repaints no row and derives the breakdown at most once per idle refresh; an insert, a move and a delete elsewhere (by `jsclick`, which leaves focus where it is — the shape of a server merge landing mid-sentence) keep the focused cell the same node, focused, with the caret at the same offset, build only the new scene's two fields, and leave every other field the same node; a status click repaints one row; and afterwards every scene's id, number and both fields still match the saved document |
| `tests/68-images.txt` | images out of the document state (#82 P2b), end to end in a real page: three canvas PNGs dropped onto three scenes by a real `DragEvent` carrying a `File` become `imageRef`s — state under 10 KB with no `data:image` in it, each shown through a `blob:` URL, each stored in the `splitpage-blobs` IndexedDB database on its own; a `.splitpage` Save carries all three inline and no `imageRef`; `stashLocalWork` carries only refs (every picture durable, so no `blobs`) across a real `goto`, after which the restored document's pictures render out of IndexedDB; and an old document with a base64 JPEG opens content-addressed (`imageRef.sha256` equal to `crypto.subtle`'s hash of the decoded bytes, no `data:image` left in state), still shows, and saves the same picture back inline |
| `tests/69-html-images.txt` | images inside HTML out of the document state (#82 P6), end to end in a real page: a picture attached in the comment composer and one pasted as HTML into a reply are stored as `<img class="comment-img" data-blob data-w data-h data-mime>` with no `src` (no `data:image`, no `blob:` in state), are in the `splitpage-blobs` IndexedDB database on their own, and show through `blob:` URLs on the card and the reply; one pasted as HTML into a scene's visual cell is kept out of it (#85 D7) and attached to the scene as a comment by sha (#124); opening the document as a `.splitpage` (both inline as `<img src="data:…" class="comment-img">`) gives the stored form back and a real Save writes them inline again, as does the `.md` data block; the stash carries only refs across a real `goto`, after which both render out of IndexedDB; and an old document with inline comment, reply and cell images opens content-addressed — the cell's picture moved into a comment on that scene — and saves them back inline |
| `tests/70-history-idb-migration.txt` | the browser's one-time move of version history from the v1 IndexedDB layout into v2 (#83, 03c-history-idb.js's migrator as the backend's first job): a raw v1 database written through `__historyTest.seedV1` (page backend closed, database deleted, then reload) — every snapshot with a body readable after the reload through `getHistorySnapshot` (`__historyTest.read`), titles/dates/Older's `migratedAt`/`expiresAt` as v1 had them, a lost body dropped, two snapshots of the same content sharing one body, the v1 stores emptied; then the same fixture with `injectFault('migrate-stop-after:2')` (kept in sessionStorage across the reload): the move stops, everything still reads (v2 plus the read-only v1 reader), a capture stays pending with ONE toast and the panel's one notice line; the fault cleared, a reload resumes and ends byte-identical (`__historyTest.inspect`) to the straight move. Before each reload the document is left clean, or its `beforeunload` would hold the navigation |
| `tests/71-prompter-bar-wrap.txt` | the teleprompter's control bar staying clickable wherever it wraps (the `.prompter-viewport` / `.prompter-scroll` rules in `app.css`): at 1400x864 (with scene mode's buttons, so it wraps under the container's fallback fonts too), 1000x864, 1100x700, 740x420 (the narrow-screen layout) and 375x600, every visible button and input in the bar is the element at its own centre (`elementFromPoint`), the scroller is exactly the box above the bar, and the reading line sits at that box's middle AND at `clientHeight / 2` (the offset scene mode's boundary checks use), a cued scene's first word lands on it, and the first and last lines still reach it — plus Mirror + Flip once. Resized in place with the prompter open (a `rows() > 1` guard at each size keeps it from passing on a bar that never wrapped); on the pre-fix CSS it is 15/42 |
| `tests/75-format-model.txt` | formatting and line breaks in a script cell as edits of its model (#85, design §5 — `toggleCellFormat`/`insertLineBreak` over `editCell`), asserted on state: Ctrl+B over a selection writing `<strong>` at once as one undo entry (Ctrl+Z / Ctrl+Shift+Z), the selection surviving the repaint and lighting the toolbar, bold across an existing run's edge making one run and the same key taking it off, italic and strike from the toolbar, highlight off on the second click, a link as `<a target rel>` with the caret just past it, B with nothing selected bolding what is typed next (and off again), Enter at the end of a cell leaving the sentinel pair so typing lands on the new line, one break mid-line, a break replacing a selection, a cell still holding a picture (put there by hand; none does since D7) left alone rather than edited behind the model's back, and a comment composer's bold through the model and taken back by its own Ctrl+Z |
| `tests/77-clipboard-model.txt` | copy, cut, paste and drop in a script cell through the document model (#85 §5, D6, D7; 05c-clipboard.js), with real `ClipboardEvent`s/`DragEvent`s carrying a `DataTransfer`: rich HTML pastes formatted and sanitised with the caret after it, as one undo entry; a copy of commented words carries no comment, and neither does a raw comment span pasted in; a cut then a paste moves the comment (the anchor goes with the words, the comment's row/column follow, the card's location changes, one undo entry, and undo puts it all back); a second paste of the same cut or another tab's cut brings no comment; a pasted or dropped picture or video card stays out of the cell (attached to the scene since #124, suite 89); a reply box still takes a pasted picture |
| `tests/78-split-join-model.txt` | splitting and joining scenes through the document model (#85 §3.2; `splitRowFieldCore`, `mergeWriterRows`, `syncCommentAnchors`): Alt+Enter through the middle of a commented phrase marks both halves and the card keeps pointing at the first, Alt+Enter just before it carries the comment and its card to the new scene, a selection is deleted before the split, the writer's Enter then Backspace brings it back, a phrase a split cut in two is one anchor again after the join — each split and join one undo entry, Ctrl+Z (and redo) putting the words and the comment's row back |
| `tests/79-tag-panel-model.txt` | the tag composer and the production panel's tag operations through the document model (#85; `tagFieldOccurrences`/`renameTag`/`removeTag`, 07-production-tags.js): "Label every matching mention" counting and tagging a phrase across formatting (`red <strong>mug</strong>`) but not inside a word, the words keeping their casing and bold under the one tag; a single mention tagging exactly the occurrence selected; rename and Remove label through the panel card. Each is ONE undo entry however many cells it touches, and one Ctrl+Z restores every cell and the registry exactly (redo too, for tag-all) |
| `tests/80-broll-paste-ids.txt` | a pasted b-roll key is a line of its own (#85 §3.3, HANDOFF invariant #54; `freshBrollIds`, `recordPastedBroll`): a copied "B-roll:" line pasted into another scene, the same cell, a third scene, or dropped, gets a new id every time, and a new unshot record seeded from its scene (one undo entry with the paste), the first shot keeping its status and notes; a cut then paste keeps the id and the shot, a second paste of it or another tab's cut is a copy; a key from another document keeps an id this one does not know; a document already holding one id twice is healed by the anchoring pass (first line keeps it, one record per id) |
| `tests/81-draft-edit.txt` | the comment composer and a reply box edited through the model with an undo history of their own (#85 §10 step 7, 05d-draft-edit.js): typing undone and redone, bold then Ctrl+Z (the selection back) and Ctrl+Y, `beforeinput` historyUndo/historyRedo answered by the box, italic and highlight from the toolbar, typing after an edit coming off on its own, B with nothing selected, a paste (sanitised, `<script>` gone) and a plain-text paste each one entry, a link, Enter, a picture attached through the Image button surviving bold/italic/highlight/a link over it (never inside one) and a paste of a second, undone one step at a time with the picture there until its own step, a video card in and out, the posted body carrying the formatting and the picture by sha with no src, a new draft with nothing to undo, and a reply box's bold and paste undone without touching the document |
| `tests/85-side-panels-modes.txt` | HANDOFF invariant #16 (#163): each of the five side panels opened, then Present and then the Writer — the panel hidden, `body.panel-open` cleared, `#root`'s right padding back to its no-panel value, no header toggle pressed, and still so after leaving the mode; Help closing B-roll and History; the full-page shot list closing every panel and bringing back only the B-roll panel it was opened from |
| `tests/86-gdocs-paste-bold.txt` | pasting a Google Docs clipboard fragment (#121, 04-richtext.js): the fragment's own `<b style="font-weight:normal" id="docs-internal-guid-…">` wrapper never bolds the whole paste, its `<span style="font-weight:700">` run still lands as `<strong>`, and the plain words in between stay plain |
| `tests/82-desktop-voice-clear.txt` | a desktop Follow My Voice warning giving way (#117, 20-teleprompter.js's `onwarning`), under the fake desktop backend: the listener's `clear` puts "Listening…" back over a no-signal or too-quiet warning and over nothing else (not too-noisy, not what words since have said, not after Stop Following). The grace period that holds those warnings back is C# in `desktop/voice/listen.ps1`, tested by `desktop/test/voice-grace.test.mjs` (Windows only; compiles the shim, never opens a microphone) |
| `tests/83-voice-mic-name.txt` | Follow My Voice naming the microphone it listens to (#118, 20-teleprompter.js's `listeningStatus`): on desktop the listener's `device` event (fake desktop backend) gives "Listening — <name>" at start and while following, as text not markup, a restarted listener's new name, the name again after a warning clears, and plain "Listening…"/"Listening" with no name and none kept from the last session; in the browser the microphone stream's track label, with `getUserMedia` and the recognizer's start/stop replaced so no microphone or speech server is touched. Windows' own name lookup (Core Audio, `listen.ps1`) is `desktop/test/voice-grace.test.mjs`; the line through main, `smoke.mjs`'s Follow My Voice group |
| `tests/84-undo-caret.txt` | the caret after an undo lands where the typing was (#119, `caretAfterStep()` in 12a-undo.js): typing at the end, the start, and in the middle of a cell each undone with the caret back at the exact plain-text offset the typing began at — the middle case chosen so the inserted text shares a character with what follows it (the ambiguity that used to grow the matched prefix one character too far), and an emoji inserted whole (as the Win+. picker does) undone the same way |
| `tests/91-scene-gallery.txt` | a scene's Image section as Adam's chosen gallery design (#135; model `02d-gallery.js`, cell `rowGalleryHtml` in 05-render.js, dialog `05e-gallery-overlay.js`), from a `.splitpage` with galleries of 1, 3, 4, 5 and 10 items (inline pictures, names, caption links, video posters): the cell's layouts (one picture with Add/Replace/Remove; a cover spanning three rows beside two or three tiles; a "+N" button tile holding the 4th item's picture and badge; the same mosaic height for 3–10 items; a video cover's big badge and "0:42"); the caption (one host + link line per video, at most three, then "+2 more videos"; pictures none) and a line opening through `window.open` / the fake bridge's `openExternal`; the dialog ("Scene 5 · Visual", "8 pictures · 5 videos", "4 / 10", the file name, a numbered grid with "behind +7" after item 3 and a "+" tile, focus on the picked tile, ‹ › and ← → picking without an undo entry, Open only for a video); Make cover, Remove by Delete, Shift+→ and a drag each one undo step (the toast's Undo, Ctrl+Z, the dialog following), "+" adding through the file picker with its toast; Esc closing with focus back in the gallery; "+N more videos" showing the videos alone and "Show all"; the single picture's Remove + Undo keeping its name; a `.splitpage` save inline and reopening the same |
| `tests/92-paste-into-gallery.txt` | pictures and videos pasted or dropped into a scene going into its gallery, each an item of its own (#135, replacing #124's comments; `pasteIntoCell`/`attachToGallery`/`readClipboardFiles` in 05c-clipboard.js, `announceAttached` in 21-events.js, `videoFirstFrame`/`grantVideoFile`/`openVideoFile` in 06-rows.js), with real `ClipboardEvent`s/`DragEvent`s carrying `File`s: a bare YouTube link into an empty scene a placeholder tile with a big play badge and a caption line, the "Video added to scene 4" toast and its Undo, redo; words with a picture and a video card as one undo entry, two tiles; a second picture and then a video each appended as tiles (never over the others; the same video twice one tile) with their caption lines; a link inside words kept in them and added as a tile; a real webm (MediaRecorder over a canvas) giving its first frame as its tile's picture, its name escaped, granted and opened (caption line and the dialog's Open) through the fake bridge; an unreadable video file a placeholder tile; a picture file after the video tiles; a web-only picture refused with a toast; drops onto the words and onto the Image section (a fifth item making "+2", the caption capped at three) and a non-media file refused; the toast's Undo refusing after another edit; no comments and nothing in state but refs |
| `tests/87-voice-relay.txt` | Follow My Voice relayed from the desktop app to Present in Browser (#122, `_voice-relay.js`), the browser end: `voice=<port>-<hex>` read from the launch fragment, taken out of the bar and kept in sessionStorage for a reload; with `window.EventSource` faked, the voice button opening `http://127.0.0.1:<port>/prompter-voice/<hex>` and never `getUserMedia`, the desktop helper's start/interim/final moving the prompter, a warning worded as on desktop, an unknown event type passed over harmlessly, Stop closing the stream, a dropped relay said once with no reconnect loop, a take-over ("restarted") stopping this page, and a launch without `voice=` (Present in Chromium) forgetting it. The main-process half is `desktop/test/smoke.mjs`'s "voice relay" group and `prompter-share.test.mjs` |
| `tests/88-present-in-chromium.txt` | "Use Chromium Speech Recognition" (#123, `openPrompterInChromium` in 20f-desktop.js), the renderer's half under the fake desktop backend: File ▸ This document's item hidden in the browser build and for a bridge without the call, shown beside Present in browser otherwise, one argument-free bridge call (the default-browser call untouched), save-first for a dirty file, the toast naming the browser main answered (as text, never markup), and NO_CHROMIUM pointing at Present in browser. Main's half is `desktop/test/smoke.mjs`'s "present in chromium" group and `chromium-browsers.test.mjs` |
| `tests/89-production-review-mode.txt` | the Production and Gear panels in a review session (#30; 08-production-panels.js, 20-teleprompter.js `wireTagEntityContainer`, 21-events.js), driven through `window.__hostedTest.setSession()` like 43: over a fixture opened as a `.splitpage`, the head's status pill a label that opens the card, an open card's status buttons and owner select drawn disabled and its notes read-only with every value still readable (the select with no caret or box), no + Person, Rename or Remove/Delete, and no "remove from crew" × in the Person grouping; no selection from Ctrl+click, Shift+click (both open the card instead) or a touch long-press, so no bulk bar; each control forced back in — the owner `change`, the notes `input`, a status button, an injected rename and add-person box's Enter, a forced bulk bar's owner and status selects and its add-person Enter, an injected person delete — refused with the "Viewing only" toast, the breakdown and the crew untouched and the card redrawn as it was; the body class stripped changing nothing; the Gear panel's cards the same and its hidden quick-add Save refused; the Production panel's CSV and the Gear panel's Packing list still exporting (each file caught at `URL.createObjectURL` and named from its `<a download>`, no "Viewing only" toast, `F.state()` byte-identical after each); the breakdown, the crew and the dirty flag unchanged at the end; and the same document as an editor getting every control, the selection and the bulk bar back |
| `tests/90-voice-mic-blocked.txt` | Windows blocking the microphone outright, named exactly (#134, `DESKTOP_VOICE_WARNINGS` in 20-teleprompter.js), under the fake desktop backend: `blocked-desktop`/`blocked-all` shown at once and given way by `clear` exactly like no-signal/too-quiet already are (suite 82), each naming the specific Settings switch to turn on and never the other one's wording; and no-signal/too-quiet naming the microphone (#118) once a `device` event has, instead of "the microphone", with the plain wording still there when none is known. The consent-store check itself (`SplitpageVoiceConsent`, driven with a fake registry reader so the real one is never touched) is `desktop/test/voice-grace.test.mjs` |
| `tests/93-broll-review-mode.txt` | the b-roll panel and the full-page shot list in a review session (#30, #148, #150; 08d-broll-panel.js), role from `window.__hostedTest.setSession()` as in 43: every tick, the status, the flag and the assignee drawn disabled with their values still showing, the note read-only, no location picker, + Person, Add prop, prop ×, Cuts against pencil or ⋯ menu, Add a shot and the bulk bar hidden, Ctrl+click opening a line and selecting nothing; each control forced back in (a tick, Flag, a Delete button, the assignee `change`, a note left, Add a shot by button and by Enter) refused by the panel's own handlers with the "Viewing only" toast and the record untouched, the body class stripped changing nothing; the filter chips, the Group menu, Go to scene, and on the full page its grouping, CSV and Print shot list still working; the list byte-identical to what the server sent; the same document as an editor getting every control back |
| `tests/94-broll-panel.txt` | the b-roll panel, one line per shot (#148, 08d-broll-panel.js), over a fixture opened as a `.splitpage`: the filter chips and the Group menu remembered in `localStorage` across a reload while the document stays clean and the undo stack untouched; the summary line and one bar segment per shot (shot / to shoot / flagged); every line 48–56px with location, initials, the script's and the hand-added props, flag and note icons, and no "Scene N" chip or "No audio reference." placeholder; scene groups with the audio line in italic and done/total (`--ok` when complete), "Added here" last; the checkbox marking a shot in one click as one undo entry (Ctrl+Z); the open shot's label–value card (96px labels, Status/Scene/Location/Assigned/Props/Cuts against/Note, Rename and Delete in its ⋯ menu), a location and a note set there; Ctrl+click and Shift+click selection, and Mark shot, Assign, Location and Flag from the bulk bar each ONE undo step; Esc clearing the selection |
| `tests/95-broll-props.txt` | the props a b-roll shot needs (#149): a prop tagged on a shot's lines on its panel line, one tagged a moment ago by typing `[tripod bag]` too; Add prop in the detail registering a new Prop and chipping it with its status, an existing prop by any spelling reused, both undone and redone as their own entries; the script's props with no ×, a hand-added one taken off with its ×; a `.splitpage` save and reopen keeping them; a rename in the Production panel carrying through by id |
| `tests/96-broll-page.txt` | the b-roll shot list as a full page (#150): "Open as a full page" closing the side panels and taking the focus; the summary, the table's header, groups by location (the default) with the pin and done/total, then by scene and by person (remembered as `pageGroup`, nothing dirty), the filter shared with the panel; rows 45–48px, a flagged one tinted `#FFF7F5` with a flag before its note, the card's 12px radius; the checkbox, the assignee and the note edited in place as undo entries of their own (Ctrl+Z and Ctrl+Shift+Z); the CSV button's file (one row per shot, a Props column, commas quoted) and Print shot list's PDF (the names, the people, FLAGGED) caught at `URL.createObjectURL`; dark mode's tokens; Escape closing it with the panel back and the focus on the button that opened it; the Scene link jumping to its scene and closing the page |
| `tests/97-broll-page-phone.txt` | the full-page shot list at 390px on an emulated phone: the table reflowed to a stack of labelled rows (no header row, each row a grid), nothing wider than the screen, 16px text boxes, a tick still landing on the record; light and dark screenshots |
| `tests/98-export-dialog.txt` | File ▸ Export… (#146, 18c-export-dialog.js), with every file caught at `URL.createObjectURL` and named from the `<a download>`: one Export… item where there were thirteen and the eleven formats' own buttons still in `#file-menu`, hidden; the dialog (a 940px, 10px-radius `role=dialog`) opening on PDF with the focus on its card, the two groups and eight cards in order, each with a name, purpose and mono extension, the preview carrying the real title, the summary, the file name; Packing list's Gear/Props option and "Nothing tagged Gear yet — nothing to pack" with Export disabled; Esc closing onto the File button with nothing exported or remembered; then **every card against its old action**: the old button and the dialog's Export each make a file with the same name (the one the dialog showed), type and bytes (a zip's entry timestamps zeroed on both sides), the dialog closing and `splitpage-last-export` naming the action; the remembered choice kept out of the document, File's "Export again as Markdown, two columns" making that file, Ctrl+E opening on that card and option; ↓ between cards and Enter exporting; the footer's Publish & copy a link closing the dialog onto Servers…; Ctrl+E not opening over the teleprompter; and the desktop native menu's `export-breakdown` and `export` reaching the same buttons |
| `tests/99-command-menu.txt` | the command menu (#147, 18d-command-menu.js): Ctrl+K from a script cell opening a fixed, centred, 640px, 10px-radius box with a 60px input row, focused, a `combobox` with `aria-activedescendant`; nothing typed and nothing run listing every group (File, Share, Export, View, This document, Help) with each export format, the panels and Find, desktop-only items left out, Ctrl+F's chips, Save active; typing narrowing ("gear" to exactly the Gear panel and the Gear packing list, the latter greyed with the Export dialog's own reason), synonyms through `__commandTest.results` (teleprompter → Present, voice over → narration, excel → CSV), Publish & copy a link's no-server reason, and "No command matches"; ↓/↑ and Enter opening the Production panel and remembering it (`splitpage-recent-commands`); Find & replace run through the menu's handler with the focus in its box; Recent first with nothing typed and no duplicate below; Enter on a greyed command doing nothing; Esc putting the caret back in the cell so typing lands there and Ctrl+K inserting nothing; a click on the scrim closing it; File ▸ Search commands… (with its Ctrl+K chip) opening it and Esc going back to the File button; and it not opening in the teleprompter, over the Import modal or over the writer; a review session greying Write and Paste a script with "Viewing only" reasons and Enter on Write doing nothing |

## The server's own tests

The harness serves static files from its own `HttpListener` and cannot start
`server/server.js` with an environment, so everything that depends on
`JOIN_PIN`, `ALLOW_ORIGINS` or `LAUNCH_TOKEN` is tested by a plain Node script
instead. No dependencies, a few seconds, real servers on free ports:

```bash
node tools/test-server.mjs
```

Ends with `ALL PASS` and exit 0. It covers the join PIN
(open health, gated routes, wrong PIN, the rate limit, the right PIN), the CORS
allowlist (including the literal `null` origin and static files never getting
the headers), the 409 compare-and-set, the launcher routes answering 404
without the launch token and under `--host` **with** it, the review credential
(#30: both roles, the link key, `/api/share`, and one PUT per kind of change a
review session may and may not make; the comments endpoints (#71), where a
reviewer's resolve/unresolve PATCH is a 403 `reviewers-cannot-resolve` refused
before its body is read and leaves the rev alone, while an editor's still
resolves and unresolves), and presence (#28: the gate, the
listing, the leaving beacon's body-carried token, expiry under a dialled-down
`PRESENCE_TTL_MS`, and nothing of it ever reaching a stored document) — plus
the rev the beat now carries for the pull channel (#69), which is read off the
head line and never by parsing the script, proved by a document with a good
head line and a body no parser can read. Run it
after any change to `server/server.js`.

### The join PIN end to end (a real server, by hand)

The two automated halves never meet: `tools/test-server.mjs` has no browser and
`18-connect.txt` has no server. To drive the whole thing, start a real one and
point the driver at it with an absolute URL (`goto` accepts one):

```bash
node start.mjs --library --pin 4821 --no-open --port 8890 --data %TEMP%\pindata
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/driver.ps1 -Script check.txt -Port 8894 -CdpPort 9394
```

with `check.txt` doing `goto http://localhost:8890/index.html`, then: the PIN
dialog appears on its own; `0000` is refused **in the dialog** with no reload
and no token stored; `4821` closes it and puts a 64-character token in
`sessionStorage` and nothing in `localStorage`; Put this script on the server
and Open from the server… both then work. Run 2026-09-10: 12/13, the one
failure being a wrong expectation in the check itself (the server menu entries
appear as soon as health answers, before the PIN is accepted — deliberate).

### A share link end to end (a real server, by hand)

Same split as the join PIN above: this suite has no server and
`tools/test-server.mjs` has no browser. To drive the whole of issue #19,
serve `index.html` from a real document server and point the driver at it
with an absolute URL:

```bash
mkdir -p /tmp/sp-static /tmp/sp-data && cp index.html /tmp/sp-static/
PORT=8890 HOST=127.0.0.1 DATA_DIR=/tmp/sp-data STATIC_DIR=/tmp/sp-static \
  node server/server.js &
```

Then a script that does `goto http://127.0.0.1:8890/index.html`, waits for
`window.__shareTest.mode().available`, calls
`window.__shareTest.publishAndCopy()` and reads `/api/docs` back. Run
2026-09-21 against this build: the publish lands one document, the toast
reads "Link copied — Anyone who can reach that address can open it.", and
the URL is `http://127.0.0.1:8890/index.html?doc=<id>`. A second script
opening that URL lands on the document ("On the server", the published
title), takes `?doc=` out of the address bar, and an edit saved from there
goes into the SAME document — rev 2, still one document on the server, not a
fork.

## Driving it from the cloud

`driver.mjs` is the same driver in Node. Use it in the Linux cloud container,
where PowerShell and Edge do not exist:

```bash
node build.mjs
node .claude/skills/run-splitpage-app/driver.mjs --script .claude/skills/run-splitpage-app/tests/01-core.txt
```

Flags mirror `driver.ps1`'s parameters (`--port`, `--cdp-port`, `--root`,
`--shot-dir`, `--script`, `--headed`), and a single dash is accepted too so a
command line copied from this file works against either driver. It finds a
browser in this order: `--chrome`, `$SPLITPAGE_CHROME`, Playwright's Chromium
under `$PLAYWRIGHT_BROWSERS_PATH` (`/opt/pw-browsers` in the container), Edge
on Windows, then `chromium`/`google-chrome` on `PATH`. Running as root it adds
`--no-sandbox` on its own, because Chromium's sandbox refuses to start there.
`--headed` needs a display — `xvfb-run node ... --headed` in a container.

Everything the suites depend on is deliberately identical: the onboarding
suppression injected before every navigation, `text=`/`text*=` selector
resolution, the key map, the pass/fail wording, and the `RESULT: n/m checks
passed` line. Two quirks are ported rather than fixed, because ~120 existing
assertions are written against them:

- **A literal comparison is case-insensitive.** PowerShell prints a bool as
  `True` and its `-eq` ignores case, which is the only reason
  `expect ... == false` ever passed. `driver.mjs` lowercases both sides.
- **`expect` truthiness is PowerShell's, not JavaScript's** — an empty array
  is false, a one-element array is its element.

**Read the `RESULT:` line — and `driver.mjs` now agrees with it.** A failed
assertion, or a suite that asserted nothing at all, exits 1 as well as saying
so on that line, so CI can gate on the exit code. `driver.ps1` still only
exits non-zero for a command that throws, which is why `run-tests.ps1` greps
for `RESULT:` and why CI runs the Node driver.

`run-tests.ps1` itself is *not* ported — there is no Linux suite runner, so
run one suite per invocation, each with its own `--port`/`--cdp-port`.

### Web fonts, and why a width assertion may differ there

The container reaches `fonts.googleapis.com` only through an intercepting TLS
proxy whose CA Playwright's Chromium does not trust, so the Google Fonts
stylesheet fails and the app falls back to generic sans/mono. The app itself is
fine — the font `<link>` is `media="print"` precisely so a dead stylesheet
cannot block the scripts (see `src/page.html`) — but the metrics are wrong, so
anything asserting a *width* can disagree with the Windows result.
`08-writer-width.txt` and `05-mobile.txt` are the ones to distrust.

To get the real fonts, pin the proxy's CA by public-key hash — this trusts
those CAs only and leaves certificate verification on everywhere else:

```bash
cd "$(mktemp -d)" && csplit -sz -f ca- -b '%03d.pem' "${SSL_CERT_FILE:-/root/.ccr/ca-bundle.crt}" '/BEGIN CERTIFICATE/' '{*}'
SPKI=$(for f in ca-*.pem; do
  openssl x509 -in "$f" -noout -subject | grep -qiE 'interception|egress|proxy' || continue
  openssl x509 -in "$f" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64
done | paste -sd, -)
export SPLITPAGE_CHROME_ARGS="--ignore-certificate-errors-spki-list=$SPKI"
```

`SPLITPAGE_CHROME_ARGS` appends anything to the browser command line and is
the general escape hatch for environment-specific flags. Verify it worked by
measuring instead of trusting it: a `"Chivo"` span and a `"NoSuchFamily"`
span render the same width when the fonts did *not* load.

A `favicon.ico` 404 in `logs` is the browser asking for a file the repo has
never had. It means nothing, on either driver.

## Ad-hoc driving

For one-off exploration, write a script and run the driver directly:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/driver.ps1 -Script mytest.txt -Port 8795 -CdpPort 9337
node .claude/skills/run-splitpage-app/driver.mjs --script mytest.txt --port 8795 --cdp-port 9337
```

Always pass `-Script`/`--script`. Piping to stdin works but the parent shell can sit on a
buffered pipeline long after the driver has exited, which looks like a hang.

## Commands

| Command | What it does |
| --- | --- |
| `open [path]` | start server + headless Edge, navigate (default `/index.html`) |
| `goto <path>` | navigate (reloads; use after `viewport` so load-time branches re-run) |
| `expect <js>` | **assert** truthy — counts toward the pass/fail total |
| `expect <js> == <literal>` | assert equals a literal (string/number/bool) |
| `wait <js>` | assert, polling up to 20 s — for anything async |
| `eval <js>` | run and print; no assertion |
| `click <sel>` | real CDP mouse click at the element's centre |
| `jsclick <sel>` | `el.click()` — use when the element is off-screen or overlapped |
| `caret <sel> [start]` | focus a contenteditable **and place the caret** |
| `press <text>` | per-character key events |
| `type <text>` | one `insertText` for the whole string |
| `key [mods] <Name>` | `Enter Tab Escape Backspace Delete Home End ArrowUp ArrowDown ArrowLeft ArrowRight KeyA KeyB KeyI KeyU KeyZ KeyY KeyF KeyM KeyH KeyS KeyO KeyE KeyK`, mods `ctrl shift alt` (combine as one token, e.g. `ctrl+alt`) |
| `viewport <w> <h> [mobile]` / `viewport reset` | device metrics; `mobile` also enables touch |
| `count <sel>` / `text <sel>` / `sel <sel>` | inspect |
| `shot <name>` | screenshot to `%TEMP%\splitpage-shots\<name>.png` |
| `logs` | dump collected console output |
| `sleep <ms>`, `quit` | |

Selectors are CSS, or `text=Exact Label` / `text*=Contains`. Prefer `text*=`
for header buttons: `Production` and `Comments` grow a count badge inside them
(`Production2`), so exact matching breaks the moment the document has content.

`text=` matches on **`innerText`**, which is the *rendered* casing, and it is
case-sensitive. Until #169 `.btn` was `text-transform: uppercase`, so older
suites matched `text*=WRITE`; the UI is sentence case now and those read
`text*=Write`. Better still, match header buttons by id (`#btn-write`) and
save yourself the guess.

## Gotchas that have already cost time

These are why tests fail when the app is fine. Check them before suspecting
the app.

- **Did you rebuild?** `node build.mjs` after every `src/` edit. Testing a
  stale `index.html` is the cheapest mistake to make here and looks exactly
  like a change that had no effect. `node build.mjs --check` answers it.

- **A blank page with no error is a blocked stylesheet, not broken JS.** A
  stylesheet that is still pending stops the browser running every classic
  script after it, so if `fonts.googleapis.com` hangs, `<script id="app-logic">`
  never executes: static markup renders, `document.readyState` sticks at
  `"loading"`, and the console is clean. The topbar being visible therefore
  proves nothing — it is markup. Assert on `#rows` having children.

- **`press`, not `type`, for tag shortcuts.** The `[ ] { } ~` shortcuts run off
  real key events; `type` commits the whole string as one `insertText`, so the
  closing character never arrives on its own and no tag is created.
- **`caret`, not `focus`, before typing.** Plain `.focus()` leaves the selection
  collapsed at offset 0 or nowhere, so text lands at the top of the cell or is
  swallowed.
- **`jsclick` doesn't blur what `caret`/`press` focused — a real click does.**
  `jsclick` calls `.click()` synthetically, which never touches
  `document.activeElement`; a script cell you just typed into stays "focused"
  through everything that follows. That produced a very convincing false
  positive: rename a *live* tag from a panel opened with `jsclick` right
  after typing into it, and the panel shows the OLD name still live plus a
  phantom orphaned entry under the NEW one — looks exactly like `renameTag()`
  corrupting the registry. It isn't. `render()` rebuilding that cell (its
  text changed — the rename rewrote the tag in it; since #84 a render only
  rebuilds a field whose text changed) detaches the still-focused, now-stale
  cell node, and the browser's own blur/focusout
  firing on that detached node carries its *stale* pre-rename content, which
  `onRootFocusOut` dutifully syncs back over the correct rename. A real click
  blurs the cell as part of the click itself, well before any of that — this
  reproduces with `jsclick` and does not with `click`. **After `press`-typing
  into a cell, `eval document.activeElement.blur()` before using `jsclick` on
  anything that might re-render `#rows`** — cheapest fix, and it's what a real
  user's next click would have done anyway.
- **A real `click` right after a burst of `press`-typing can miss a header
  button, and `jsclick` on the same button "works" for the wrong reason**
  (issue #31 — suites 02, 04, 07, 12). Root cause, confirmed with
  `elementFromPoint` at the computed coordinates a moment apart: `.topbar` is
  `position: sticky` and condenses on scroll (`src/js/20i-topbar.js`) through
  a scroll listener that is deliberately `requestAnimationFrame`-coalesced,
  i.e. asynchronous. Both drivers' old `click` called
  `el.scrollIntoView({block:'center'})` unconditionally before measuring —
  and calling `scrollIntoView` on an element that is already fully visible
  inside a sticky ancestor is its own trap: the browser computes the target
  from the element's un-stuck *static* position, so an already-visible
  header button gets scrolled anyway. That scroll crosses the topbar's
  un-condense threshold a frame later, moving the button out from under the
  coordinates already computed for the two `Input.dispatchMouseEvent` calls.
  `jsclick` never noticed because `el.click()` doesn't hit-test the page at
  all. Fixed in both drivers' `click` (not `jsclick`, which was always
  immune): skip the scroll when the target is already fully in the
  viewport, wait two animation frames for a pending layout class toggle to
  land, and confirm with `elementFromPoint` that the point about to be
  dispatched is really the element (or a descendant of it) before trusting
  it, retrying a few times and logging what was actually hit if it never
  settles. This also quietly helps a `click` right after a panel's own CSS
  open-transition (e.g. `.comments-panel`'s 0.18s transform), which could
  briefly measure zero size the same way.
- **A CSS fade-out reads its starting value until a frame after it starts, and
  that frame can be late.** A transition keeps its before-change value until
  the document timeline passes the frame it began in. An opacity or transform
  transition runs on the compositor, so Chromium keeps it `pending`
  (`currentTime` 0) until the compositor reports it started. That is often
  one frame after the class flips, and more under load. So `sleep N` then
  `expect opacity < 1` is a race against frame production, not a test of
  the fade: `tests/61-transitions.txt` lost about 1 run in 6-8 that way. Take
  the reading on the page's frames instead. Watch for the class flip, then
  sample in `requestAnimationFrame` until the value moves or the movement is
  over (`__snapMid` in that suite). A fade that never runs then still fails
  the suite. A value that is already displaced at t=0, such as a FLIP
  transform or a fade-in from 0, has no such gap.
- **Every suite runs in the light theme.** Both drivers pin
  `prefers-color-scheme: light` when they connect (#169). Headless Edge
  otherwise takes the colour scheme from Windows, so on a machine in dark
  mode every suite that reads a colour back failed against the light
  values it was written for. A suite that wants the dark theme sets
  `data-theme="dark"` on `<html>` itself (96 and 97 do).
- **Assert on `textContent`, not `innerText`.** `innerText` returns the
  *rendered* casing, which is not the source's wherever CSS transforms it —
  until #169 Splitpage uppercased most of its UI that way (`"HAVE IT"`,
  `"▶ PLAY"`), which produced two false failures. `textContent` returns the
  source.
- **Re-query after anything that re-renders.** Selecting, tagging, and status
  changes replace the panel's DOM wholesale. Events dispatched on a node you
  captured earlier hit a detached element and never reach the delegated
  handler. A real browser hit-tests at dispatch time, so this only bites tests.
- **No top-level `await` in `eval`.** Wrap it: `eval (async function(){ ... ; return true;})()`.
  The driver already awaits a returned promise.
- **`expect a == b` compares against a literal**, not an expression. For a
  computed comparison use one truthy expression: `expect x === y + 1`.
- **`viewport mobile` then `goto`.** `IS_TOUCH` and the `(hover: none)` rules are
  read at load, so emulation must be on *before* the page loads.
- **Set device metrics once, at the top of a suite, before any real work.**
  Changing them partway through a session that has already navigated and run
  scripts reliably aborts the CDP socket — every command after it fails with
  `WebSocket is in an invalid state ('Aborted')`. A second viewport needs a
  second suite; that is why 05-mobile and 08-writer-width are separate files
  rather than sections of the suites they belong to.
- **`goto` after a lot of prior DOM churn can abort the socket the same way** —
  not just a device-metrics change. A script that posted a comment, replied
  to it, and flipped a sort toggle a few times aborted reliably on the `goto`
  that followed; the identical `goto` in isolation, with nothing before it,
  was solid every time (`tests/11-comments-sort-persist.txt`). If a reload
  check needs to run after a script has already done real work, give it its
  own suite rather than trusting it to survive at the end of a busy one.
- **Don't assert formatting on the live DOM of a comment or reply box.**
  There it is still the browser's `execCommand`, which emits `<b>` or
  `<span style="font-weight: bold">` depending on the browser, and the
  sanitiser turns that into `<strong>` only when the body is posted. A
  *script cell* formats through the document model (#85): `<strong>`,
  `<em>`, `<mark>`, `<a>` are in state the moment the key is pressed, so
  assert on `F.state()` right away (`tests/75-format-model.txt`).
- **Test scripts are read as UTF-8** — they didn't used to be. `Get-Content`
  on PS 5.1 decodes a BOM-less file with the system ANSI codepage, so a `•`
  or an em dash inside an assertion arrived as mojibake and failed against an
  app that was perfectly fine. Fixed in the driver; if you write another
  harness, read files with
  `[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes(...))`.
- **Harmless console noise:** a 404 for `/favicon.ico`, and service-worker
  registration failures. Don't chase them.
- **Two `run-tests.ps1` invocations at once (two worktrees, two agents) are
  now safe.** Each invocation mints its own runId and hands it to every
  `driver.ps1` it spawns via `-RunId`; `driver.ps1` folds that id into its
  Edge profile directory name (`splitpage-edge-<runId>-<guid8>`), and the
  leftover-browser sweep in both files matches only
  `*splitpage-edge-<runId>-*` — its own run's orphans, never another run's
  live browser. That used to be a bare `splitpage-edge-*` glob: a second run
  starting up killed the first run's live browser and that suite died
  mid-command with `The WebSocket is in an invalid state ('Aborted')` —
  sometimes on the first command, sometimes twenty commands in — which looked
  exactly like a real failure (02-production and 07-untagged both "failed"
  this way during Phase 3 and both passed clean when re-run alone). Separate
  ports were never enough on their own; the run-id scoping is what actually
  fixed it. `driver.ps1` run standalone (no `-RunId` given) mints its own, so
  it stays self-contained too. If an aborted suite still turns up, re-run it
  with `-Only` before suspecting the app — that now points at something else,
  since run collisions are ruled out.

- **Orphaned browsers.** `Start-Process` hands back Edge's launcher, which
  spawns the real browser tree and exits, so killing it alone left a browser
  behind per suite. Twenty of them piled up over one full run until a later
  suite's CDP socket timed out on its first command — a suite that passed
  alone and failed in the full run. Both the driver and the runner now sweep
  by the `splitpage-edge-*` profile directory (never by process name — that
  would close the browser you are reading this in). If you see
  `The WebSocket is in an invalid state ('Aborted')` on the *first* command of
  a suite, check for leftovers before suspecting the app.

  `driver.mjs` on Windows had the same leak: `browserProc.kill("SIGKILL")`
  does not reach Edge's real process tree, which kept holding
  `--remote-debugging-port`. The next run on that `--cdp-port` attached to the
  OLD browser and every command timed out (`CDP Page.navigate timed out after
  30000ms`, `FAIL (timeout) document.querySelectorAll('#rows .row').length > 0`).
  It now does what `driver.ps1` does: after the kill, on win32 only, it stops
  every `msedge.exe` whose command line contains its own
  `splitpage-edge-<runId>-<rand>` profile directory, then deletes the
  directory. On every platform it also checks `--cdp-port` before launching
  the browser and stops with `ERROR: CDP port <n> is already in use` if
  anything is listening there, rather than attaching to a stranger. That error
  means a leftover browser (a driver killed before its cleanup ran, such as by
  Ctrl+C or a closed pipe, can still leave one) or another run on the same
  port: pick another `--cdp-port`, or count the leftovers:

  ```bash
  powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { \$_.CommandLine -like '*splitpage-edge-*' }).Count"
  ```

## What this cannot test

- **The microphone.** Follow My Voice needs real speech; headless has no audio
  input. Its logic can be checked against simulated transcripts, but a live
  read has to be done by hand.
- **Teleprompter scroll rate.** The animation is `requestAnimationFrame`-driven
  and throttled in a background/headless window. Play/pause state is tested;
  the actual scroll speed is not.
- **Real iOS Safari and Android keyboards.** `viewport mobile` is Chromium
  emulating a phone, which is not the same as the real thing.

## Desktop app (Electron)

The Splitpage desktop shell (Electron 44 + electron-builder 26) has its own
integration suite separate from the browser harness, because it drives a real
native window rather than headless Chromium.

### Smoke suite commands

From `desktop/`:

```bash
node test/smoke.mjs                       # dev + both packaged exes (if they exist)
node test/smoke.mjs --exe <path to .exe>  # one specific target
node test/smoke.mjs --only-target dev|packaged-x64|packaged-arm64  # filter (for debugging)
```

Every launch gets its own fresh temp `SPLITPAGE_USER_DATA`, its own free
`--remote-debugging-port`, and `SPLITPAGE_NO_UPDATE_CHECK=1`. Nothing touches
the developer's real Splitpage profile or documents.

The suite passes on both the dev and the packaged-arm64 target. The suite groups run in order: boot/security,
open/save/conflict/save-as/export, second instance (plain and relative-path),
session restore, `--library`, `--host --pin` (given, auto-generated, and the
no-`--pin` warning), update status, unsaved-changes close, close/quit
authority (with and without a user gesture), page-initiated `window.close()`,
clean close — then the tab shell added by step L2 (tabstrip origin, Ctrl+T
new tab, tab routing rules, close-tab clean/dirty, last-tab-closes-window /
last-window-quits, a window with 2 dirty tabs plus another window, quit
across two windows with dirty tabs, `--host` quit's stop-sharing prompt,
tear-off preserving live tab state, restore at launch, v1→v2 migration and a
corrupt-JSON fresh boot) — then document id and desktop history added by
step M (save-in-place birthtime vs. the duplicate rule, duplicate document id
across tabs, history round-trip and relaunch over the six history channels
(an Older put and `history-list`'s usage included), history id validation
(the Older flag beside any docId rejecting too), an exit-after-body relaunch
showing the prior index generation, a torn `index.json` falling back to
`index.prev.json`, cap-driven eviction and the 50-per-document trim,
concurrent puts and a copy from two tabs, legacy migration, a newer format
going read-only, and the #83 v1 folder tree migrating on first launch and
finishing after a kill mid-way) — then
crash-safe drafts added by step N (crash recovery of an untitled document, a
renderer crash of a dirty file tab, the file changed on disk while down, the
file deleted while down, quit without saving discarding every draft, closing
one tab without saving discarding only that draft, a power-cut mid-write, both
generations corrupt going to quarantine, ENOSPC pausing writes, a forged
fileId, and no secret ever reaching disk).

**Dev Electron is native ARM64**, switched on 2026-09-15. From `desktop/`:

```powershell
Remove-Item -Recurse -Force node_modules\electron\dist
$env:npm_config_arch = "arm64"
$env:npm_config_platform = "win32"
node node_modules\electron\install.js
```

The version pin (`^44.3.0`) is unchanged. A plain `npm install` reverts to
x64 unless `desktop/.npmrc` has `arch=arm64`. Measured dev smoke: 7m43s
(x64 emulated) vs. 7m25s (ARM64) for the same suite — the suite is
wait-bound, not CPU-bound, so don't expect a dramatic speedup from the
switch.

### SPLITPAGE_TEST rule

Every automated launch of the desktop app must set `SPLITPAGE_TEST=1` (HANDOFF
invariant #33) — the suite's `launchApp()` already does; any ad-hoc launch must
too. This is someone's working machine: without it, windows and error dialogs
appear on their screen. In test mode the window never shows, a dialog not
pre-answered through `SPLITPAGE_TEST_DIALOGS` resolves as Cancel, and a
main-process crash prints `[splitpage-test] uncaught main-process error` to
stderr and exits 70 — every case's teardown fails on that line. Kill whatever
you start (`taskkill /PID <pid> /T /F`). If a window or dialog ever appears
during a run, stop and fix that before anything else.

### Gotchas worth recording

- **Teardown is slow regardless of architecture.** It takes 10–15 s; poll for
  process exit rather than trusting timeouts.
- **`document.visibilityState` reads "visible" even in test mode.** Check invisibility
  with `(Get-Process -Id <pid>).MainWindowHandle -eq 0` instead.
- **A CDP `Runtime.evaluate` is not a user gesture unless `userGesture:true`.**
  Chromium only honours a page's `beforeunload` block after user activation, so an
  edit made through a plain evaluate leaves the page unactivated. Pass
  `userGesture:true` when a test means "the user typed this"; leave it off when the
  point is that the main process's own close prompt works without activation
  (`caseCloseAuthorityNoGesture`).
- **Never test "the user closes the window" with a page `window.close()`.** It skips
  the `BrowserWindow` `'close'` event entirely, so a dirty document closes with no
  prompt and the test proves nothing about a real close. Use the test-mode-only
  `window.splitpageDesktop.__testRequestClose()` (main calls `win.close()`, like the
  title-bar ×) or `__testRequestQuit()` (`app.quit()`, like File ▸ Exit). They don't
  exist without `SPLITPAGE_TEST=1`.
- **Page targets are found via `/json` (type "page").** This will need a target filter
  once tabs add more pages (currently there is only one page per window).
