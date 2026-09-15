# Splitpage — developer handoff

Written 2026-08-28, condensed 2026-09-15. For whoever (or whatever) picks this up next.

`README.md` is the **user-facing** doc — what the features are and how to use
them. Read it first; this file deliberately does not repeat it.

---

## 1. Orientation

Splitpage is Adam's personal tool for scripting videos: a two-column
visual/audio editor with a teleprompter, review comments, and a production
breakdown for props/locations/cast/VFX/sound.

- **Edit `src/`, never `index.html`.** Source is `src/page.html` (shell),
  `src/app.css`, `src/seed-state.json` (demo document), and `src/js/` — 22+
  numbered fragments sharing one closure as a single IIFE; filename order is
  load order. `node build.mjs` inlines them into `index.html`;
  `node build.mjs --check` fails a commit where they disagree.
- **The shipped app must stay one self-contained file.** Save writes
  `"<!doctype html>" + document.documentElement.outerHTML` with the document
  spliced into `#state-data` (`buildPublishHtml`, `PAGE_SHELL`). That's why
  there's an inlining build step instead of `<script src>`.
- Supporting files: `README.md`, `start.mjs`/`.bat`/`.sh`/`.ps1` (local
  launcher), `server/server.js` + `Dockerfile` (hosted mode), `package.mjs` +
  `installer/` + `tools/fetch-runtime.mjs` (portable zip, Windows setup.exe).
- Began life as a Claude artifact, converted to standalone. Stale "the
  artifact" wording anywhere is a bug, not a quirk.

---

## 2. Running and testing it

`start.bat` serves on `http://localhost:8791`. `file://` works for editing
but disables PWA install, IndexedDB, and the microphone — test over http.

Rebuild before testing any `src/` change, always:

```bash
node build.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/run-tests.ps1
```

The browser suite (`tests/01-core.txt` … `26-desktop-drafts.txt`, 16 retired)
drives headless Edge over CDP. `-Only 22` runs one suite, `-Headed` shows the
browser. Windows-only. Predates Google Drive, Google Doc import, two-column
Markdown export, and the update/About box — hand- and Chromium-tested only.
Full reference and gotchas: `.claude/skills/run-splitpage-app/SKILL.md`.
`run-tests.ps1` mints its own 8-hex `$RunId` per run so two runs can share
the machine without one's orphan-process sweep killing the other's browser.

**Desktop shell:** `desktop/test/smoke.mjs` drives a real Electron window
over CDP — the only thing exercising `main.js`/`preload.js`. Always launch
through it (`launchApp`, sets `SPLITPAGE_TEST=1` + a temp profile), never the
app directly.

```powershell
$env:PATH = "...\.cache\node-win-x64;" + $env:PATH
node test/smoke.mjs                    # dev + every packaged exe in dist/
node test/smoke.mjs --only-target dev  # dev only, fastest loop
```

Dev Electron is pinned to native ARM64 (`desktop/.npmrc`, `arch=arm64`); a
plain `npm install` in `desktop/` fetches the right one. Never run
`npm run dist`/`dist:win` outside a deliberate release build.
`desktop/drafts.test.mjs` unit-tests `desktop/drafts.js` directly, no
Electron. `tools/test-server.mjs` drives real `server.js` processes.

### The test harness lies to you — suspect the test before the code

- A typing shortcut never fires: `computer.type` commits the whole string as
  one `insertText` event — type the trigger character in its own call.
- Enter/Ctrl+Z do nothing: `computer.key` often isn't recognised — dispatch a
  real `KeyboardEvent` or call `document.execCommand` directly.
- A click does nothing on the 2nd element: a stale `NodeList` — panels
  re-render and replace DOM wholesale; re-query after every action.
- A hover/transition assertion fails: `getComputedStyle` right after a class
  change returns the pre-transition value — wait past the transition.
- **The app renders nothing, throws nothing:** a pending stylesheet blocks
  every classic script after it. Seeing the topbar proves nothing — it's
  static markup. Assert on `#rows` having children.
- Focus jumps mid-batch: editing `index.html` fires a hook that opens a
  stray `file://` preview tab — close it, re-select the localhost tab.
- Microphone capture is blocked in an agent sandbox, so Follow My Voice can
  never be verified end to end there.
- `document.visibilityState` reads `"visible"` even in desktop test mode;
  check `MainWindowHandle -eq 0` instead. A CDP `Runtime.evaluate` is not a
  user gesture unless `userGesture: true`.
- A suite that passes alone but fails in the full run with an aborted CDP
  socket on its first command is orphaned browsers, not your code.

### Three techniques that make this app testable

**Load any document you like.** Copy `index.html`, splice your own JSON into
`#state-data` (what `buildPublishHtml()` does), open it — byte-for-byte a
"saved project", exercising the real load path including `migrateRows()`.

**Catch an export without a download.** Every export goes through
`deliverFile()` → `URL.createObjectURL`; hook that and guard
`HTMLAnchorElement.prototype.click` against `this.download`, then read
`await window.__caught[0].text()`. The `.docx` zip is store-only; the PDF's
content stream is uncompressed (`Tm \((.*)\) Tj` gives every drawn string —
one *word* per `Tj`).

**Drive the three-way merge.** Write `{base, mine}` into
`sessionStorage["splitpage-conflict-stash"]` and reload —
`applyStashedWork()` merges on load. In hosted mode, publish, `PUT` a change
with raw `fetch()` as a second collaborator, then Save in the UI for the real
409 path. A PowerShell double for `server.js`'s `/api` can stand in when
Node isn't available — but never round-trip JSON through PowerShell's
`ConvertFrom/To-Json` (mangles non-ASCII); slice raw `"state"` bytes instead.

---

## 3. Architecture

### 3.1 The page is the database *at boot*

`#state-data` holds the seed document from `src/seed-state.json`. That's its
whole job — **documents live in files, not copies of the app**. Save writes
`.md` (table + fenced `splitpage` data block) or `.splitpage` (that record
alone). `20d-formats.js` builds/parses both; `openProjectFile()` dispatches
into `adoptProjectState()`, the one place a parsed project becomes *the*
document. `PAGE_SHELL`/`buildPublishHtml()` exist only for Standalone HTML
export. Since 2026-08-28 a server is a second home: Save does an HTTP
compare-and-set, gated by `detectServer()` probing `/api/health`; the two
homes are mutually exclusive by construction (§3.6).

### 3.2 `migrateRows()` is the only door

Everything from outside the page goes through `migrateRows(s)` — the single
choke point where untrusted input becomes trusted state. A new top-level
field must be added in **two** places: `migrateRows()` and `mergeStates()`'s
merge literal — missing from the latter, it's silently destroyed on every
merge (happened to `people` and `productionTags`).

### 3.3 Tags are atomic

`.tag-anchor` spans carry `contenteditable="false"` (`walkSanitize()`), so
the caret can't enter one and typing/backspace can't corrupt its
`data-tag-name`. Anything mutating text must skip `.tag-anchor` content
(`editableTextNodes()`).

### 3.4 Tags are derived; the *registry* is not

Which scenes a tag appears in is read live (`collectTags()`). Which items
are tracked at all is real storage, `state.productionTags`.
`productionEntries()` merges registry + live mentions + owner/notes/status,
and self-heals a live tag missing a registry entry without dirtying the
document — so bulk delete must also call `removeTag()`, or the self-heal
puts the item back. Selection state is UI-only, never serialised. Read the
panel through `productionEntries()`, never `collectTags()`.

### 3.5 Comment boxes share the script's event handlers

Comment composer/reply boxes use the same `.cell-editable` class as script
cells — gate script-only behaviour on `isScriptCell(cellEl)`. The writer's
paragraphs are script cells too (`isScriptCell` accepts `#writer-doc`), which
is how the writer inherits tagging/Tab/Ctrl+B/sanitising for free (§3.9).

### 3.6 The merge was dormant for months — now it runs

`saveToServer()`: PUT with `baseRev`; 200 stores the new rev and
`baseState = published`; 409 three-way-merges `(baseState, state, theirs)`
and retries (3 rounds max). **`baseState` must be exactly what the server
last confirmed** — any new save path sets it to what it successfully sent,
nothing else. `reportMerge(result, {alreadySaved:true})` avoids re-queuing
an autosave for a mid-save merge. `stashLocalWork()` runs on the
lapsed-session path so unsaved edits survive; `applyStashedWork()` skips a
stash when `splitpage-server-resume` is present.

### 3.7 The server

`server/server.js` — plain Node, no dependencies, ~600 lines. One JSON file
per document in `DATA_DIR`.

- No identity of its own — Cloudflare Access decides who anybody is; the
  server only reads `Cf-Access-Authenticated-User-Email` for display.
- `JOIN_PIN` is a door lock: sha256 + `timingSafeEqual`, 10 wrong
  guesses/minute cap, refusal is `401 {error:"pin-required"}` JSON.
- CORS opt-in per origin, never carries credentials; `OPTIONS /api/*`
  answered 204 before any route runs.
- `/api/launcher/*` is the one route that runs another program — launch
  token in the URL fragment, `HOST === "127.0.0.1"`, fixed script path. Any
  failing check is 404, not 401 (invariant #28).
- Document ids whitelisted (`^[a-z0-9][a-z0-9-]{0,63}$`), not sanitised.
- Writes are temp-file-plus-rename, serialised per doc id (`withDocLock`).
  `Cache-Control: no-store` on every response.

### 3.8 Untagged mentions are painted, never wrapped

`scanUntaggedMentions()` finds registry items written as plain text, painted
via `CSS.highlights.set()` over live `Range`s — never a span (would dirty the
file, land on undo). `buildUntaggedIndex()` breaks same-name ties with
`tagCompletionBeats()`. One alternation regex for the whole registry,
longest-name-first, word boundaries **inside** the pattern
(lookarounds, `\p{L}`/`\p{N}`, wrapped in try/catch with an ASCII fallback) —
checking neighbours after the match breaks on rejected longest-first
alternatives and accented names. The offer re-checks
`String(s.range) !== s.text` before accepting (a live Range can grow).
Accepting uses `execCommand("insertHTML")`. Tab is shared with the
completion ghost, which wins outright. Visual column only, deliberately.

### 3.9 The writer edits rows, it does not import a document

One paragraph is one row's `audioText`, a real `.cell-editable` carrying that
row's `data-id`/`data-field` — no parse step, no second copy of the
document. Only two operations change the row list: **`splitWriterRow()`**
(Enter, via shared `splitRowFieldCore()`, §3.10) and **`mergeWriterRows()`**
(Backspace/Delete at an edge; refuses when both rows have a visual; status
accumulates by rank). `caretAtEdge()` must not count empty inline wrappers —
`Range.cloneContents()`'s empty `<strong></strong>` clone looked like
content, blocking join on any scene starting with formatting.

`onWriterKeydown` runs capture-phase ahead of the shared `onRootKeydown`, so
Enter means different things in each view; `onRootClick` isn't attached to
the writer (stale split-view DOM). `renderWriter()` preserves the caret as
`(rowId, char offset)`. `data-gutter` is three-state (visuals/numbers/compact);
text size (`--wr-font`) lives in `localStorage`, floor 16px (iOS zoom).
Narration exports mirror this outward: one paragraph per row, read back by
`splitImportText()` in paragraph mode.

### 3.10 Splitting a field is shared between the writer and the split view

Alt+Enter in `#rows` does what the writer's Enter always did: split the
focused field at the caret, leaving the *other* column untouched on the
original row. **`splitRowFieldCore(cellEl)`** is the shared core (reads
`field` off `data-field`); `splitWriterRow()`/`splitCellField()` each add
their own render/refocus. Alt+Enter never reaches `onRootKeydown` inside the
writer (its capture handler treats every Enter as a split).

`keepCaretInView(cellEl)` is a near-always-no-op scroll (only fires outside a
32px viewport margin). **Scroll to the caret's own rect, never the cell's**
— `scrollIntoView({block:"center"})` centres the *element*, which can leave
the caret off-screen on a cell taller than the viewport. Walks the nearest
scrolling ancestor (`#writer-doc` scrolls `.writer-scroll`, not `window`).

### 3.11 A comment card is its own "jump to text" control

`.comment-card.is-jumpable` resolves clicks to `jumpToAnchor()` unless on
`.reply-composer`, an `<a>`, or a button, gated on
`window.getSelection().isCollapsed` so finishing a drag-select never also
fires a jump. `commentPositionCompare()` (row index, Visual-before-Audio,
post time) is the shared comparator the export appendix always uses,
independent of the panel's live sort mode (`commentLastActivity()`, where a
reply counts as activity) — a reader preference in `localStorage`, not part
of the document.

### 3.12 Gear is a category, and its panel is not a second copy of anything

Adding Gear was one `TAG_CATEGORIES` entry, one `TAG_SHORTCUTS` entry, and
one matching `.tag-anchor[data-tag-cat="gear"]` CSS rule (invariant 14) —
everything else already iterates `TAG_CATEGORIES` generically. `#gear-panel`
reuses `tagEntityHtml()` cards filtered by `gearEntries()`.
**`wireTagEntityContainer(id)`** is `#production-panel`'s event wiring
pulled out so `#gear-panel` gets it by a second call; **`renderProduction()`**
is a two-line dispatcher so every existing call site refreshes both panels
for free. `applyGearQuickAdd()` diffs the textarea against `gearEntries()`:
a new line registers a tag (orphaned from creation); a removed line deletes
the registry entry only if already orphaned (a live one self-heals back,
§3.4). `buildPackingListPdf(catId)` is a second, smaller PDF writer rather
than reusing `buildPdf()`'s page-building closures.

A harness gotcha, not an app bug: renaming a live tag via a panel opened
with `jsclick` right after typing can look like registry corruption —
`jsclick` never blurs the focused cell, so its stale, detached node's
blur/focusout fires after `render()` and syncs stale content back over a
correct rename. Fix: blur before `jsclick`.

### 3.13 The desktop shell

`desktop/main.js` + `desktop/preload.js` (Electron 44 + electron-builder 26)
turn the web app into a native Windows app; optional shell. Since the
2026-09-14 tabs build it manages **multiple windows, each with multiple
tabs**.

- Page loads from `splitpage://app`, not `http://localhost:<port>/`, so
  origin-keyed storage survives port changes. `splitpage://tabstrip` is a
  second privileged origin for the title-bar strip, own preload, own
  allowlist, no file/draft/history bridge methods (#43).
- `preload.js` exposes `window.splitpageDesktop` only on `splitpage://app`;
  every `ipcMain` handler re-checks the sender frame (`isTrustedSender`,
  `main.js:4004` / `isTrustedTabStripSender`, `main.js:4018`). Renderer never
  sends file paths to main (#34) — main keeps an id → path registry; writes
  are atomic (temp+rename).
- `createTabWindow` (`main.js:2528`) makes a `BrowserWindow` whose primary
  view loads the tab strip; each tab is a `WebContentsView` from
  `createTab(windowId, opts)` (`main.js:2868`). `tabId`/`windowId` are
  32-hex, validated at every trust boundary (#42), stable across tear-off
  and relaunch, and double as the crash-draft folder name (§4). A crashed
  tab closes with no prompt, reports `dirty: false` regardless of the
  page's last word.
- Opening a document funnels through `splitpage:route-open` →
  `'this-tab' | 'other-tab' | 'new-tab'` — same logic for argv,
  second-instance hand-off, and macOS `open-file`.
- **Close/quit authority is per tab and per window; a quit asks at most one
  dialog** (#44). `unsaved(tab) = tab.dirty || drafts.isHeld(tab.id)`. One
  unsaved tab: 2-button dialog. Window close/quit with 2+ unsaved tabs: one
  3-button dialog listing every title. Hosting prompt fires at most once
  per quit, before the unsaved dialog. Server/tunnel killed in `will-quit`,
  never `before-quit`. `session-end` asks nothing.
- Session restore: `<userData>/desktop-state.json` v2 — windows, bounds,
  tabs, each tab's *source*, no docId, no draft id; one serialized write
  queue, frozen once quit begins. `splitpage:tab-boot-sync` (sendSync,
  resolves before page boot) returns `{tabId, windowId, launchIntent:{type},
  hadPriorSession, hasDraftToRestore}` — no path, no server doc id (#34
  again). Crash reload/loop guard: twice per 60s per tab, third crash
  leaves it `crashed`, no reload, no prompt.
- **Crash-safe drafts** (`desktop/drafts.js`, plain CommonJS) live under
  `<userData>/drafts/<tabId>/`: two-generation writes, `base-<sha12>.json`,
  `session.json`. Write is fsync then one sync tick renaming
  current→previous, tmp→current. **Hold/discard ordering is load-bearing**
  (#40): a tab with `hasDraftToRestore` is `hold()`-ed immediately;
  `write()` on a held tab returns `HELD`, touches nothing; released only by
  `splitpage:draft-restore-done` or an explicit user decision — never
  crash/kill/session-end/quit. `buildDraftHeader` (`main.js:807`) is built
  only by main from allowlisted scalar fields, never a PIN/token (#29).
- Desktop version history lives under `<userData>/history/docs/d-<docId>/`,
  mirroring the browser's IndexedDB store; ids validated in renderer and
  main, resolved path stays inside the history root (#38).
  `ensureHistoryTable()` (`main.js:1563`) fscks first in the write queue;
  `planHistoryEviction()` (`main.js:1721`) is a byte-for-byte copy of the
  browser's planner, kept in sync deliberately.
- Duplicate document-id claims reassign in memory only (§4, #36).
  `chooseDuplicateLoser(a, b)`: server home beats file home; birthtime is
  **not** trusted between two files — `DUP_TRUST_BIRTHTIME = false`
  (`main.js:473`, `atomicWrite` measurably moves NTFS birthtime on save) —
  loser decided by claim order instead; the reassigned tab doesn't
  dirty/autosave.
- Launch args: `--library`, `--host`, `--pin [code]`, `--data DIR`,
  `--port`, `--allow-origin`, `--tunnel user@host [...]`. Files as
  arguments open through `routeOpenPath`; a second launch hands files to
  the running app. Per-tab server/PIN connections not yet built (§8).
- Test mode: `SPLITPAGE_TEST=1` — window never shown/taskbarred, an
  unanswered dialog resolves Cancel, an uncaught main-process error exits
  to stderr instead of a modal. `SPLITPAGE_USER_DATA` gives a temp profile;
  `SPLITPAGE_TEST_DIALOGS` pre-answers dialogs. Test bridge:
  `__testRequestClose/Quit/CloseTab`, `__testShell(op, args)`. A page-run
  `window.close()` never fires the `BrowserWindow`'s `'close'` event —
  Chromium tears the page down without asking main; nothing in `src/js`
  calls it.
- `desktop/test/smoke.mjs`: Node built-ins only, drives real window(s) over
  CDP. Covers boot/security/save/export/update plus the tabs surface,
  route-open dedupe, one-dialog-per-quit, session restore, crash
  reload/loop, duplicate-id reassignment, crash-safe drafts.

---

## 4. State schema

```jsonc
{
  "title": "string ≤300 chars",
  "schema": 2,                  // SCHEMA_VERSION — docId did NOT bump it (#35)
  "docId": "d0123…(32 hex)",    // /^d[0-9a-f]{32}$/, minted by migrateRows if missing
  "rev": 0,                     // bumped per save; drives conflict detection
  "lastEditedBy": null, "lastEditedAt": null,
  "wordsPerMinute": 150,        // clamped 60–400
  "rows": [{ "id": "r1", "visualText": "sanitised HTML", "audioText": "sanitised HTML",
    "visualImage": "data: URI or null", "status": "todo | ready | shot",
    "updatedAt": "ISO", "updatedBy": "name" }],
  "comments": [{ "id": "c1", "rowId": "r1", "field": "audioText | visualText | visualImage",
    "anchorId": "c1", "quotedText": "plain text", "author": "name", "body": "sanitised HTML",
    "resolved": false, "kind": "anchor | conflict", "createdAt": "ISO", "updatedAt": "ISO",
    "replies": [{ "id": "rp1", "author": "name", "body": "HTML", "createdAt": "ISO" }] }],
  "people": [{ "id": "p…", "name": "Jordan" }],
  "productionTags": [{ "cat": "prop | location | cast | vfx | sound", "name": "Camera Rig",
    "owner": "p… or ''", "notes": "plain text ≤2000",
    "status": "needed | sourcing | have | returned" }]
}
```

`ROW_FIELDS = ["visualText","visualImage","audioText"]` merges as content;
`rows[].status` and `productionTags[].status` merge by rank (further-along
wins); `owner`/`notes` merge "filled beats empty".

**`docId`** (`src/js/02b-doc-id.js`, frozen `sha256Hex`/`deriveDocId`) is
minted by `migrateRows()`, carried through `mergeStates()` via
`mergedDocId()`, derived deterministically for legacy files with none.
Never in the seed, `#state-data`, or Standalone HTML export. Join key for
per-document history, drafts, duplicate-tab detection. Invariants #35–#37.

**Per-document version history**, capped 50 snapshots/document, keyed by
`docId`: browser IndexedDB (`splitpage-history`, `03a-history-store.js`,
memory fallback), desktop files (`<userData>/history/docs/d-<docId>/`,
§3.13). Pre-tabs shared history migrated once into a synthetic "Older"
document, expiring 90 days after that migration (`HISTORY_OLDER_TTL_MS`).
Eviction order: expired Older, trim every doc to 50, Older oldest-first,
then docs by `lastOpenedAt` ascending — a doc's newest snapshot is never
evicted.

**Crash-safe drafts** (desktop only, §3.13): a `stateJson` full `state`
object plus a separate `DraftHeader` (never document fields) — not document
schema. **`desktop-state.json` v2**: no document content and no docId, just
windows/bounds/tabs/each tab's *source*/`lastKnownTitle` — a launch recipe,
not a backup (§3.13).

**The two file formats**, both through `20d-formats.js`, entering state
only via `migrateRows()` (#2): **`.splitpage`** is
`JSON.stringify(migrateRows(cloneState(state)), null, 2)`, no envelope,
byte-for-byte what the server stores and `#state-data` holds at boot (#31).
**`.md`** is `toMarkdownTableDoc()` (title, scene table, breakdown,
comments) followed by a fenced `~~~~splitpage` block holding the exact
`.splitpage` bytes, fence length computed per file so a quoted example
can't shadow the real block. Reading reconciles hand edits cell-by-cell
against `mdSceneCellSource()`: equal keeps the block's HTML intact,
different rebuilds via `legacyMdToHtml()` + `sanitizeHtml()` (comment
anchors lost, `quotedText` kept); a differing row count asks
(`#md-rows-modal`), never reconciles silently; no data block ⇒ ordinary
lossy import (#32).

**Browser storage** (follows the reader, not the file): `splitpage-comment-author`,
`splitpage-snapshots` (legacy, read-once Older-bucket migration source, do
not write to it), `splitpage-conflict-stash`/`-reloaded` (sessionStorage),
`splitpage-tagging-help-dismissed`, `splitpage-files` (IndexedDB,
`FileSystemFileHandle` for resume-on-launch), `splitpage-history`
(IndexedDB, per-document history).

---

## 5. Invariants — break these and data goes quietly wrong

1. **Edit with the Edit tool, one site at a time.** Never in-place regex
   substitution (`sed`/`perl -pi`) on `index.html` — no git to restore from.
2. **Mutate text by walking text nodes, never by regexing HTML.** See
   `replaceInHtml()`/`tagFieldOccurrences()`.
3. **Never touch text inside `.tag-anchor`** (§3.3).
4. **New top-level state field ⇒ update `migrateRows()` *and* `mergeStates()`**
   (§3.2).
5. **Gate script-only behaviour on `isScriptCell()`** (§3.5).
6. **Don't run document-wide scans per keystroke.** Wire expensive refreshes
   through `scheduleProductionRefresh()` (180ms debounce); `contentMemo()`
   keys on the field's own HTML (never stale); one scan per render.
7. **Repaint a row, don't re-render the document** for a single-field
   change. `cycleRowStatus()` uses `paintRowStatus()`, focus-safe — mirrors
   `rowHtml()`'s markup.
8. **Escape values going into CSS attribute selectors** with `cssAttr()` —
   stripping quotes isn't enough, a backslash reads as a CSS escape.
9. **Markdown table cells need `mdCell()`**; a raw `|` shears the row.
10. **`sanitizeHtml()` on anything reconstructed** before it re-enters state.
11. **A control nested inside `.tag-entity-head` must be checked *before*
    `tag-expand`** in the click delegation's sequential `if` chain.
12. **A modifier-click on a breakdown card outranks every control inside
    it** — checked at the very top of the click delegation.
13. **Two different drags share the root handlers.** The image branch is
    gated on `isFileDrag(e) && !dragRowId`, or scene reordering breaks.
14. **A new `TAG_CATEGORIES` entry needs a matching
    `.tag-anchor[data-tag-cat="…"]` CSS rule** — panel colour comes from JS,
    script colour comes from CSS.
15. **The writer never re-parses the document into rows** (§3.9). Row-list
    changes go through `splitWriterRow()`/`mergeWriterRows()`; DOM rebuilds
    through `renderWriter()`.
16. **Anything that opens over the whole screen must close the side
    panels.** `openWriter()` closes Production, Comments, find. Writer sits
    at `z-index: 145`, above panels (140), below modals (150) and toasts (200).
17. **A hint about the document must never edit the document** (§3.8).
18. **A comment is anchored twice — by `rowId` and by its `.cmt-anchor`
    span — and anything moving text between rows must move both.**
    `repointCommentsForRows()` is the fix; `splitRowFieldCore()` calls it.
19. **A full-screen overlay must own the focus and the stacking, not just
    the pixels.** `.tag-ghost-hint` raised to 146; a `focusin` trap on
    `#writer` lets modals/toasts through.
20. **There are two Save buttons and one save state**, via
    `setSaveButtons()`/`mirrorFileChipToWriter()`.
21. **There is one place a field gets split, not two** (§3.10) —
    `splitRowFieldCore()`.
22. **Scroll to the caret's own rect, never the cell's**, when the cell
    might be taller than the viewport (§3.10) — `keepCaretInView()`.
23. **A click that ends a text selection must never also fire a
    click-target action** — the comment card's `isCollapsed` gate (§3.11).
24. **The export appendix and the panel's own display can be sorted
    differently, on purpose** (§3.11) — `commentEntries()` always uses
    `commentPositionCompare()`.
25. **A new panel showing `tagEntityHtml()` cards is a fourth call to
    `wireTagEntityContainer()`, not a new event-handling path** (§3.12).
26. **A quick-add box that tracks things whether or not they're in the
    script must only ever forget what it alone added** (§3.12).
27. **A "the registry looks corrupted" symptom from a `jsclick`-driven test
    is not proof — check `document.activeElement` first** (§3.12).
28. **No HTTP endpoint spawns a process or installs files — except
    `/api/launcher/*`, loopback-only and launch-token-gated** (§3.7). A
    missing lock answers 404, not 401.
29. **The join PIN, session token, and launch token never enter
    `update-status.json`, the document, or any file the static handler
    serves.** Client side: everything about connecting to a server is
    browser state, never `state`. A bookmark never carries a password, key,
    or passphrase.
30. **The first-run setup wizard may only appear over a genuinely pristine
    copy of the app.** `<meta name="splitpage-seed-check">` (stamped by
    `build.mjs`, checked by `seedCheckPasses()`) plus
    `localStorage["splitpage-onboarding"]` plus checks that no document is
    already loading. File ▸ "Set up Splitpage…" bypasses this deliberately.
31. **A `.splitpage` file is exactly `migrateRows(state)`** — nothing wraps,
    renames, or adds fields on the way to disk (§3.1, §4).
32. **The Markdown data block is authoritative for everything the table
    cannot show; the table is authoritative for scene text only, and only
    where it differs from the block.** Don't make the table authoritative
    for a column it renders but doesn't own (`Status`); don't let a
    row-count difference pick a side silently.
33. **Every automated launch of the desktop app sets `SPLITPAGE_TEST=1`,
    and nothing a test does may appear on screen** (§3.13). Doesn't cover a
    renderer `alert`/`confirm` (Help ▸ About); proof of invisibility needs
    `MainWindowHandle === 0`, not `document.visibilityState`.
34. **The renderer never sends a file path to the main process; files are
    addressed by opaque ids from the main process's registry** (§3.13). A
    new bridge method that works on a file takes an id, never a path.
35. **Every document carries `state.docId` matching `/^d[0-9a-f]{32}$/`.**
    Never in the seed, `#state-data`, or Standalone HTML export.
    `SCHEMA_VERSION` deliberately not bumped for it. A missing id must fail
    as *unique*, never as *shared*.
36. **The id follows the Save target, not the edit.** A fork happens only
    on Save As, publish of an id already written out, or detached draft
    recovery, and history copies only after the write succeeds. Restoring a
    snapshot never changes the id. "Already open" is decided by path or
    server doc id, never by `docId`.
37. **`sha256Hex` and `deriveDocId` are frozen.** Changing either
    re-identifies every legacy file and every duplicate-replacement id,
    splitting history on the next open.
38. **Version history is addressed only by `(docId, snapshot id)`**,
    validated in renderer and main; the resolved path must stay inside the
    history folder. The Older bucket is reachable only via `{older: true}`.
39. **`pushSnapshot()` captures synchronously, and no save ever waits on
    history.** A restore overwrites the document only after its "Before
    restoring" backup is stored or an explicit second confirm.
40. **A crash draft is deleted only when its tab becomes clean, or on an
    explicit user decision** — never on crash, kill, renderer loss,
    session-end, quit, or restore. A discard writes a tombstone before
    anything is unlinked.
41. **Restoring a draft never writes the user's file by itself.**
    "Unchanged on disk" is decided by content, never mtime. The draft
    header is built only by main from allowlisted scalar fields; draft
    bodies are written with fsync and two generations.
42. **Each tab is its own page, and the main process is the only authority
    on tab identity, unsaved state, and what is already open** (§3.13).
    Moving a tab moves its `WebContentsView`, never copies it.
43. **The tab strip runs on the separate origin `splitpage://tabstrip`**,
    with no `splitpageDesktop` bridge and its own trust check
    (`isTrustedTabStripSender`) — a compromise of either page can't reach
    the other's powers.
44. **One quit asks at most one unsaved-changes dialog and one
    stop-sharing prompt; Windows session-end asks neither and discards
    nothing.** `desktop-state.json` is written durably through one queue.

<!-- #45–#47: voice helper invariants, added with the V track -->

48. **An exported bundle contains no key matching
    `/token|api[-_]?key|client[-_]?id|secret|password|\bpin\b/i`, asserted
    before any byte is written; an import carrying one is refused.**
49. **Import merges through the history store's public write path and
    never deletes; existing preferences are never overwritten; bookmarks
    union by URL with local winning.**
50. **The 1.0.x removal in the installer waits for the old folder to
    disappear before writing** — the old uninstaller's detached `rmdir`
    runs ~2s after it exits, into the same folder.

---

## 6. Map of the source

`src/js/` (~18,100 lines, 30 fragments; filenames say where things live):

| Fragment | What is in it |
| --- | --- |
| `00-prelude.js` | opens the IIFE, `PAGE_SHELL`, module-wide vars |
| `01-scene-status.js` | scene status and runtime estimates |
| `02-state.js` | `defaultState`, `migrateRows`, `legacyMdToHtml`, `buildPublishHtml` |
| `02b-doc-id.js` | document id: `DOC_ID_RE`, `mintDocId`, frozen `sha256Hex`/`deriveDocId`, `mergedDocId`, `reassignDocId`, duplicate-claim BroadcastChannel |
| `03-sync.js` | identity, `mergeStates`, save loop, restore/undo-merge |
| `03a-history-store.js` | per-document version history, IndexedDB store, Older-bucket migration, `planHistoryEviction`, import/export |
| `04-richtext.js` | `walkSanitize`, html→markdown, video link cards |
| `05-render.js` | `rowHtml`, `render`, field sync, rich-text commands |
| `06-rows.js` | row add/move/drag, images |
| `07-production-tags.js` | tag registry, people, tagging, autocomplete, untagged mentions |
| `08-production-panels.js` | production and gear panels, multi-select, breakdown |
| `09-find-replace.js` | find & replace |
| `10-comments.js` | comments: composer, panel, cards |
| `11-import.js` | paste import, two-column detection, `parseMarkdownTable`, Google Doc import |
| `12-dirty-toast.js` | dirty flag, toasts, draft-change hook |
| `13-hosted.js` | server detection, picker, compare-and-set save, Google Drive files |
| `14-export.js` | `saveDoc`, Markdown writers, zip writer, `adoptSavedCopyDocId` |
| `15-docx.js` | .docx read/write, narration-only export |
| `16-csv.js` | csv |
| `17-pdf.js` | pdf, packing lists |
| `18-local-files.js` | `openProjectFile`/`adoptProjectState`, save-back, File menu dispatch |
| `19-writer.js` | the writer (word-processor view of the audio column) |
| `20-teleprompter.js` | teleprompter and voice follow |
| `20a-update.js` | update notice, About box |
| `20b-onboarding.js` | first-run wizard, pristine-seed gate (invariant #30) |
| `20c-help.js` | in-app Help modal, coach-mark tour |
| `20d-formats.js` | the two document formats, hand-edit reconcile |
| `20e-connect.js` | join-PIN dialog, server bookmarks, SSH helper |
| `20h-appdata.js` | app-data export/import: `assertNoSecrets` (#48), `importAppData` (#49) |
| `20f-desktop.js` | desktop glue, inert unless `DESKTOP` set: bridge wrapper, tab-boot-sync handling, native-menu dispatcher |
| `20g-drafts.js` | crash-safe draft renderer: writer/idle-flush loop, `applyTakenDraft`, `sameDocContent` |
| `21-events.js` | all event wiring, `init()`, closes the IIFE |

**Desktop files** (optional; the web app runs without them):

| File | What is in it |
| --- | --- |
| `desktop/main.js` | Electron main: scheme handlers, windows/tabs registries, route-open dedupe, close/quit lifecycle, session restore, doc-id claim table, history storage + fsck + planner twin, draft headers, file dialogs, server launcher, native menus, test mode |
| `desktop/preload.js` | preload for `splitpage://app`: origin-gated `window.splitpageDesktop` bridge |
| `desktop/tabstrip-preload.js` | preload for `splitpage://tabstrip` only — no file/draft/history methods (#43) |
| `desktop/tabstrip/` | title-bar tab strip: `tabstrip.css`/`.js`/`index.html`, served only under `TABSTRIP_ALLOWLIST` |
| `desktop/drafts.js` | crash-safe draft store, plain CommonJS, no Electron dependency (§3.13, #40–#41) |
| `desktop/.npmrc` | pins `npm install` to native ARM64 Electron (§2) |
| `desktop/electron-builder.yml` | packaging config, x64 + ARM64 Windows |
| `desktop/build/installer.nsh` | NSIS include: "Splitpage (shared session)" Start Menu shortcut (`--host --pin`) |
| `desktop/stage.mjs` | build step: runs `build.mjs`, verifies version, stages files for packaging |
| `desktop/verify-dist.mjs` | post-`dist:win` check: PE machine field per binary, NSIS stub arch, installer freshness |
| `desktop/test/smoke.mjs` | integration suite over CDP (§3.13) |
| `desktop/test/drafts.test.mjs` | unit suite for `desktop/drafts.js` alone |

Other source: `src/page.html` (shell), `src/app.css` (visual),
`src/seed-state.json` (demo document). `README.md` is a build input too —
`build.mjs`'s `mdToHtml()` renders it into the Help modal at build time;
developer-only sections are wrapped in `<!-- help:skip-start/end -->`.

**File-menu items owned outside `18-local-files.js`'s `handleFileMenuAction()`:**
`20c-help.js` and `20e-connect.js` each add a capture-phase listener on
`#file-menu` matching only their own action. `20b-onboarding.js`'s listener
matches *every* action and closes the wizard first, registering ahead of the
other two (alphabetical order) — keeping only one full-screen modal open at
a time (invariant #19). The wizard's own Escape/Tab handling listens in the
bubble phase instead, since it can sit open, unnoticed, during an unrelated
test.

### Merging main into a branch that has `src/`

Main still edits `index.html` directly. Split main's `index.html` on the
same boundaries `src/` was cut on; prove the splitter reproduces this
branch's `src/` byte-for-byte from the merge base first; cut main's JS into
the same fragments by matching each base fragment's first line as a unique
anchor; `git merge-file` each piece against its base; normalise trailing
newlines first; rebuild and read every **removal** in the diff against
main's `index.html` — a removal you can't name is main's work being dropped.

---

## 7. Current status

Status, verification history, and step-by-step state live in the plan
file's Progress table, not here:
`C:\Users\Adam\.claude\plans\breezy-booping-toucan.md`. Read it before
picking up any work on this branch.

---

## 8. Where to pick up

What to work on next, in what order, and the pending decisions for Adam are
tracked in the plan file, not here:
`C:\Users\Adam\.claude\plans\breezy-booping-toucan.md`. Follow My Voice on
desktop is paused pending a fresh look (parked files under
`.cache/voice-parked/`, plan companion `breezy-booping-toucan-VL.md` for an
opt-in local model, not yet approved). Google Drive via loopback OAuth and
per-tab server/tunnel connections are pitched but unbuilt.

**Noticed, deliberately not changed:** opening a `.docx`/`.md`/`.txt`/`.csv`
replaces `state.rows` and the title but leaves `productionTags`, `people`,
and `comments` from the previous document in place (`openAnyLocalFile`) —
useful when pasting a revised draft of the *same* project. Ask Adam before
changing either way.

---

## 9. Working with Adam

- **Get sign-off on anything that changes what they type** — delimiters,
  shortcuts, auto-formatting. Syntax used daily becomes muscle memory and is
  expensive to change.
- **Everywhere else, they hand over full autonomy** and expect work
  delivered, not discussed: *"Build em!"*, *"whole file, fix everything you
  find"*.
- **They report bugs precisely — take the details literally.** *"it seems
  to ask for permission every 60 seconds"* was the entire diagnosis of the
  microphone bug; 60s is exactly Chrome's speech-session limit.
- **Report honestly.** State what was verified, how, and what wasn't. If
  something went wrong — including your own mistake — say so plainly and
  show the repair.
