# Splitpage architecture review

Reviewed 2026-09-22 against `main` at e217a4c (v2.1.0). Scope: `src/js`, `server/server.js`, `desktop/`, build and test tooling, and the open issues (#8, #10, #11, #51, #52, #53).

## Verdict

Line by line this is careful, well-commented code. Structurally it is an artifact that grew into a product without ever changing shape. Most of the 51 invariants in HANDOFF.md exist to hold together three early decisions that no longer pay for themselves: HTML strings as the document model, one 24k-line closure instead of modules, and "the page is the file". The desktop shell then re-solved the same problems a second time. The future plans are mostly fine, but two of them build on the weakest foundations.

## The debt that generates the rest

### 1. The document model is contenteditable HTML strings

`syncFieldFromDom()` copies `innerHTML` into state on every input event (`05-render.js:208`, `21-events.js:366`), unsanitized until blur. Tags are `contenteditable=false` spans identified by a name string, comments are `.cmt-anchor` spans plus a `rowId`, b-roll is a marker span.

Consequences:

- Every text walker must skip tag spans; every text mutation must walk nodes (invariants #2, #3).
- A tag rename re-parses every field (`eachTagSpan`, `07-production-tags.js`).
- Comments need `repointCommentsForRows()` (`19-writer.js:233`) because their two anchors drift. The span is editable, so a user can delete, split or copy-paste it, and one comment id can end up in two rows.
- Merge conflicts are whole-field string inequality (`03-sync.js:265`). A tag re-wrap on one side plus a word edit on the other is a "conflict", and the loser's whole cell becomes an "Unmerged edit" comment.
- Undo is three inconsistent systems: native `execCommand` undo that every `render()` destroys, a one-level split/move undo (`06-rows.js:96-144`), and history snapshots. Ctrl+Z after deleting a row, applying a tag from the composer, or posting a comment does nothing.
- `execCommand` (deprecated) is load-bearing in 25 places, with per-browser fallbacks patched case by case.

A structured model (rows of text runs with marks that reference the registry by id) fixes anchors, rename cost, merge granularity and undo at once. It is the single biggest change and the one worth planning.

### 2. Rendering is full innerHTML rebuilds

`render()` is called from 55 sites across 18 fragments. Every structural op (add/delete/move row, post/resolve comment, apply/rename tag) rebuilds all of `#rows`, then re-derives production entries twice, re-renders comments, and the writer if open (`05-render.js:174-203`).

Per keystroke, `onRootInput` (`21-events.js:360-390`) runs synchronously: shortcut detection, b-roll capture, innerHTML serialisation and compare, a layout read, and `updateTagGhost` which calls `productionEntries()` over all rows. Then four separate timers (180ms, 220ms, 400ms, 200ms) each re-derive `productionEntries()` again.

There are three builders for one editable cell (`fieldBlock`, `writerBlockHtml`, `replyComposerHtml`) and four string-concat copies of the tag span markup. `paintRowStatus()` (`01-scene-status.js:85`) hand-mirrors `rowHtml()` with a "change one, change the other" comment.

Keyed per-row reconciliation plus one derived index invalidated per mutation would remove most of the memo and timer patches.

### 3. Collaboration has no change notification

Nobody polls the document rev; only open and resume GET it (`13-hosted.js:306,693`). A reader sees a stale document until they type and hit a 409.

Autosave idle is 2s (`14-export.js:364`), so two active typists conflict on nearly every save. Each 409 ships the whole document, including base64 images, back to the client, and each retry files a "Before merging in someone else's changes" snapshot (`13-hosted.js:990`) into a 50-cap history, evicting snapshots that matter. Three rounds then gives up with a toast.

Presence already round-trips every 2s (`13a-presence.js:151`) and could carry `{docId, rev}` back. On mismatch: GET, `mergeStates(baseState, state, theirs)`, re-render. No PUT. That is roughly 30 lines for the most visible collaboration problem. CRDTs or OT are not warranted for a handful of people on coarse rows with save-on-pause.

### 4. List merges are two-way unions with no base

`mergeProductionTags()` and its people and b-roll siblings (`03-sync.js:482` onward) union both sides, so a deleted prop is resurrected by every merge, forever. The row merge already has the "deleted and unchanged since base" rule at `:299`. Pass `base` to the three list merges. `wordsPerMinute` is silently "theirs wins" (`:459`).

The merge core is single-sourced (good), but its orchestration (snapshot, `lastMergeUndo`, `baseState`, autosave halt) is copied in `saveToServer`, `resumeServerDoc` (three calls), `applyStashedWork` and `confirmFileMerge`. `baseState` is a module global assigned from six sites.

### 5. The review-role check is a whole-state diff and will break on normalization

`reviewWriteAllowed()` (`server.js:840`) deep-compares the raw stored JSON against the client's `migrateRows()`-normalized state, key by key. A document last saved by an older client has no `brollShots` key. The reviewer's client sends `brollShots: []`, `deepEqual(undefined, [])` is false, and every reviewer comment gets `403 review-only`. The same applies to any future top-level field, and to row keys such as `updatedBy: null` vs missing (`reviewRows`, `server.js:805`).

The check also relies on a hand-rolled HTML tokenizer (`fieldSignature`, `htmlTokens`) on the server. A `POST /api/docs/:id/comments` endpoint for the review role is simpler and cannot rot.

### 6. The one-IIFE build is now cost without benefit

39 fragments, 24,406 lines, 818 top-level functions in one scope, 2,939 `var` and 8 `let`/`const`, no lint, no types, no minification, no dependency graph. A fragment is not valid JS on its own, so nothing can be imported. `mergeStates`, `migrateRows`, the two file formats, `parseMarkdownTable` and `deriveDocId` are only testable through 12 `window.__*` backdoors shipped in production.

The stated reason ("a save writes `outerHTML`") is stale: saves are `.splitpage` and `.md`, and `PAGE_SHELL` only serves the standalone export. Real ES modules bundled by esbuild (`--bundle --format=iife --minify`) and inlined by `build.mjs` exactly as today keeps the one-file artifact, costs about a day of import/export plumbing plus one devDependency, and unlocks unit tests, ESLint, and a roughly 40% smaller page.

### 7. No CI, and the Node test driver exits 0 on failure

`.github/` contains only issue templates. The pre-commit hook is never installed (`core.hooksPath` is empty and no doc says to set it). `driver.mjs` only sets exit 1 on thrown errors; a FAIL line increments a counter and the process still exits 0 (`driver.mjs:635-659`). Any CI added today would be green on red.

Suite 01 runs here on Linux under Playwright's Chromium in about 40s and passes, so a GitHub Actions job is possible now. Fifty PRs merged on one day with nothing gating them is the risk this creates.

The test DSL also reproduces PowerShell semantics in Node (case-insensitive string equality, `[]` is false) so two 600-line drivers stay in lockstep, and 457 of its lines are fixed `sleep`s rather than condition waits.

### 8. The desktop shell duplicates the browser

`desktop/main.js` is 5,633 lines, sixteen concerns, one closure after the single-instance lock. Section numbering is out of order (`8b` at line 1408 precedes `7` at 2350).

- History store reimplemented (about 940 lines, `1408-2347`). `planHistoryEviction` is a byte-for-byte copy of the browser's, kept honest by a smoke test. The fake backend in `20f-desktop.js:616-767` is a third copy of trim/copy semantics.
- Doc-id claims exist twice (BroadcastChannel in `02b-doc-id.js:349` vs a main-process table at `main.js:428-666`), the latter carrying a dead birthtime branch and a `stat` whose result nothing reads.
- Tabs are a 1,500-line reimplementation of browser tabs: `WebContentsView` per tab, a second privileged origin with its own preload, tear-off, reorder, per-tab crash loop guard, and a close/quit state machine that exists because tabs and windows are separate authorities. Every tab is a full renderer running the whole app.
- Crash-safe drafts (`drafts.js`, 984 lines, plus 960 renderer-side) use two generations, base dedupe by sha, tombstones, a quarantine dir, and a hold/release latch that the comments identify as the source of most subtle bugs.

One `BrowserWindow` per document would delete most of the tab machinery. The pure policy code (planner, meta sanitize, claim rules) should be one shared file both builds consume; `drafts.js` already proves the pattern.

Security posture is sound: `contextIsolation`, `sandbox`, no `nodeIntegration`, origin-gated preload, every IPC handler re-checks the sender, opaque file ids. Two nits: `--tunnel` accepts a target starting with `-` (`argValueOf`, `main.js:171`), and the `/api` proxy strips `Origin`.

### 9. Update trust chain

The desktop updater spawns a downloaded unsigned `.exe` (`main.js:2856-2869`) and the SHA256SUMS check is optional; a missing checksum file lets the install proceed (`:2825`). HTTPS to GitHub is the whole chain. `electron-updater` gives signed manifests, differential downloads and a tested install-on-quit flow. A code-signing certificate is the real fix, and also removes the SmartScreen warning the README apologises for.

### 10. Smaller items worth knowing

- `sw.js` caches every same-origin GET including `update-status.json` (fetched with `no-store`, which service workers ignore) and each `?doc=` URL as its own 1.37MB copy of `index.html`, under a hard-coded `splitpage-v1` the build never stamps. After a deploy users run the old client for one full load.
- Images are base64 inside state, so they ride every save, 409 payload, snapshot and stash. The `.md` format stores them twice (table cell and JSON block), producing megabyte-long table lines.
- `productionEntries()` mutates the registry during a read without dirtying (`07-production-tags.js`, self-heal), so `mergeStates` sees unexplained changes.
- Three mutually exclusive home records (`docFileHandle`, `openedFile`, `serverDoc`) plus `docIdWrittenOut`, `baseState`, `diskBase`, `lastModified` are zeroed against each other by hand (`13-hosted.js:704-708`). `autoSaveTarget()` is already the shape of the single tagged union this should be.
- PIN rate limiting keys on socket address; behind cloudflared or Docker NAT everyone shares one bucket, so one stranger's ten bad guesses lock everyone out.
- `/api/presence` reads and parses up to 25MB of body before checking the token.
- Server PUT parses the whole existing file inside the lock just to compare `rev`; the list endpoint parses every document in full; `writeDoc` has no fsync before rename.
- Five distribution paths (double-click, start scripts, self-updating Node launcher, IExpress installer that DEPLOY.md calls deprecated, Electron NSIS x64+arm64) plus Docker is about 3,500 lines of packaging for one user. Each has had its own release-breaking bug. Cut the Node launcher updater and IExpress.
- HANDOFF.md §7 and §8 point at `C:\Users\Adam\.claude\plans\...`, unreachable from any clone. Invariants are referenced by number from code and tests, so renumbering is now impossible. The §6 fragment table lists 30 files; the tree has 39.
- `index.html` (1.37MB, generated) is committed on every code change. Build in CI or on release instead.
- README.md is a build input rendered by a 200-line untested Markdown parser in `build.mjs`. Split a `docs/help.md` from the repo README.
- `.githooks/demo-state.json` duplicates `src/seed-state.json` byte for byte. Raw `\x00`/`\x01` bytes are embedded literally in `08c-broll.js:493` and `server/server.js:601,744,768`, which makes grep and diff treat the files as binary.

## The future plans

**#8 Follow My Voice on desktop via a local speech model.** This is the one to push back on. The browser feature works because Chrome ships Google's speech backend and Electron does not. Bundling a local model plus a `SplitpageSpeech.exe` sidecar adds a native binary, an allowlist, and an arch-specific build to a project already bitten three times by packaging. Cheaper options: keep voice browser-only and say so plainly, or drive the Windows built-in speech recognition (`Windows.Media.SpeechRecognition`) through a tiny helper rather than shipping a model.

**#10 Google Drive via loopback OAuth.** Reasonable and correctly scoped to the desktop shell with argument-free bridge calls. It adds another storage home though. Do it after the home record is one tagged union (finding 10).

**#11 Per-tab server and tunnel connections.** This makes the tab architecture load-bearing. If tabs became one window per document, per-window connections fall out for free and the desktop `source` records already model it. Decide the tab question before starting this.

**#51, #52, #53 UI polish.** Fine and low risk. #53 correctly warns that animating padding on `#root` re-lays-out the whole document; that is a symptom of finding 2, and keyed row rendering would make it cheap.

## Smarter moves not yet used

- esbuild single-file bundle from ES modules: keeps the one-file artifact, gives modules, tests and lint.
- Rev returned in the presence answer: turns the existing heartbeat into change notification for free.
- Base-aware list merges: one parameter added to three functions stops deletions resurrecting.
- A comments-only endpoint for reviewers instead of a whole-state diff.
- Content-addressed image blobs (a sidecar folder for files, `/api/blobs/<sha>` for the server) so state holds a hash and images stop riding every payload.
- One shared policy module for history eviction and duplicate-id rules consumed by both browser and desktop.
- `electron-updater` plus a signing cert instead of the hand-rolled updater.
- One `BrowserWindow` per document instead of tabs, unless tabs are a hard product requirement.

## What I would do, in order

1. CI on ubuntu running `build.mjs --check`, the server, update and drafts unit tests, and the browser suites, with `driver.mjs` exiting nonzero on any FAIL. Retire `driver.ps1`.
2. Convert fragments to ES modules bundled by esbuild into the same single `index.html`. Then unit-test `mergeStates`, `migrateRows`, the formats and docId directly and delete the `window.__*` backdoors.
3. Rev-in-presence pull merge, base-aware list merges, a comments endpoint for reviewers, and hosted autosave idle raised to about 5s.
4. Pull the pure policy out of `desktop/main.js` into shared modules. Decide tabs vs windows before #11. Make the update checksum mandatory now, signing when a cert exists.
5. Only then plan the structured document model. It is the right long-term move but it touches everything, and it should land on a codebase that already has modules and tests.
