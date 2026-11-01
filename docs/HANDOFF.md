# Splitpage — developer handoff

Written 2026-08-28, condensed 2026-09-15. For whoever (or whatever) picks this up next.

`docs/help.md` is the **user-facing** doc — what the features are and how to
use them, and the file `build.mjs` renders into the in-app Help page. Read it
first; this file deliberately does not repeat it.

**What's new (Adam, 2026-09-27).** Every user-facing change adds a line to
the top list in `docs/help.md`, "What's new since <last release>", above the
last release's own list. When a release is cut, that heading becomes
"What's new in <version>" (a release's notes are built from it) and a fresh
"since" list starts with the next change. `README.md` is the
repo-facing half of what used to be one file (#80): building, releasing, and
the map of the tree.

---

## 1. Orientation

Splitpage is Adam's personal tool for scripting videos: a two-column
visual/audio editor with a teleprompter, review comments, and a production
breakdown for props/locations/cast/VFX/sound.

- **Edit `src/`, never `index.html`.** Source is `src/page.html` (shell),
  `src/styles/`, `src/seed-state.json` (demo document) and the owned folders
  (`core/`, `application/`, `adapters/`, `features/`, `bootstrap/`). `src/bootstrap/main.ts` is the bundle entry, which mounts the
  owners and features in a fixed order; `src/js/` is gone.
  `node build.mjs` bundles from `main.ts` with
  esbuild and inlines the result into `index.html`; `node build.mjs --check`
  says whether the copy on disk is in step. `node build.mjs --test` is the
  test build, which keeps the `window.__*Test` hooks and `window.__splitpageFormats` the suites and the
  desktop smoke drive; the plain build leaves them out. `index.html` is **not in the
  repository** since #80 — it is generated, it is ignored, and a fresh clone
  has none until you build one. Run `npm install` once first — esbuild is the
  one devDependency the build needs.
- **The build writes two files, not one.** `index.html` and, since #79,
  `sw.js` — whose cache name is stamped from `VERSION`, which is what makes a
  deploy take effect on the next load instead of the one after it. `sw.js` is
  stamped in place rather than generated from `src/`, because a worker needs
  its own URL so it cannot be inlined, and `tools/package.mjs` and
  `desktop/stage.mjs` all copy the repo-root file out verbatim. `--check`
  reports on both, separately, so two stale outputs are not found one at a
  time.
- **Document edits go through `DocumentSession`**, run through
  `src/bootstrap/wiring/session-owner.ts`.
  [docs/architecture/session.md](architecture/session.md) describes the
  session, the effect scheduler and the command shape as built.
- **The shipped app must stay one self-contained file.** Save writes
  `"<!doctype html>" + document.documentElement.outerHTML` with the document
  spliced into `#state-data` (`buildPublishHtml`, `PAGE_SHELL`). That's why
  there's an inlining build step instead of `<script src>`.
- Supporting files: `README.md` (repo-facing) and `docs/help.md` (the user
  guide, and a build input — it becomes the in-app Help page), `start.mjs`
  with thin `start.bat`/`start.sh`
  wrappers (local launcher), `update.mjs` (says whether a newer release
  exists; installs nothing), `server/server.js` (the static file server
  `start.mjs` runs),
  `tools/package.mjs` (the portable zip), `desktop/` (the Electron app and its NSIS
  installers). #75 deleted the rest of the packaging: `installer/` (the
  IExpress setup), `tools/fetch-runtime.mjs`, `start.ps1` (a third HTTP server
  implementation), `uninstall.*`, and the launcher's in-place self-update.
- Began life as a Claude artifact, converted to standalone. Stale "the
  artifact" wording anywhere is a bug, not a quirk.

---

## 2. Running and testing it

`start.bat` serves on `http://localhost:8791`. `file://` works for editing
but disables PWA install, IndexedDB, and the microphone — test over http.

**`index.html` is not in the repository** (#80). It is generated from `src/`,
`docs/help.md` and `VERSION`, it is in `.gitignore`, and a fresh clone has
none until you build one:

```bash
npm install              # once: esbuild, eslint, jsdom
node build.mjs           # writes index.html, stamps sw.js from VERSION
```

Nothing is committed that has to be kept in step with the source any more, so
there is no hook to install and nothing to stage after a build. `sw.js` is the
exception and is still tracked — it cannot be inlined into the page, so it is
the file you edit as well as the file that ships, and the build only stamps
its cache name. Rebuild after a version bump and commit `sw.js`; CI fails if
the committed copy's stamp has drifted from `VERSION`.

Rebuild (`node build.mjs --test`) before testing any `src/` change; a stale
`index.html` looks exactly like a change that had no effect. Which tests a
change needs, and when the full browser regression runs (milestone and
release gates), is the table in
[docs/architecture/testing.md](architecture/testing.md#what-to-run-for-which-change);
how to drive the suites, and their gotchas, is
`.claude/skills/run-splitpage-app/SKILL.md`.

On Windows the suites run under `run-tests.ps1`, which drives headless Edge
over CDP and mints its own 8-hex `$RunId` per run so two runs can share the
machine without one's orphan-process sweep killing the other's browser.

**Away from Windows**, `.claude/skills/run-splitpage-app/driver.mjs` is the
same driver in Node — same `tests/*.txt`, same commands, same `RESULT:` line —
so a `src/` change can be driven from the Linux cloud container, which has
neither PowerShell nor Edge. `tools/run-suites.mjs` runs suites through it in
parallel lanes, selected by a regex over full filenames; `driver.mjs --script`
runs one:

```bash
node build.mjs --test
node tools/run-suites.mjs ../splitpage-runs/latest '^01-core\.txt$'
node .claude/skills/run-splitpage-app/driver.mjs --script .claude/skills/run-splitpage-app/tests/01-core.txt
```

It finds Playwright's Chromium under `$PLAYWRIGHT_BROWSERS_PATH` on its own.
Google Fonts does not load there (the proxy's CA is untrusted), so the app
falls back to generic sans/mono and **width assertions can disagree with the
Windows result** — SKILL.md has the CA-pinning recipe that fixes it. Since
#57 `driver.mjs` exits 1 for a failed assertion, and for a suite that
asserted nothing at all, which is what lets CI gate on it; `driver.ps1` still
only exits non-zero for a command that throws, so read its `RESULT:` line.

**CI** (`.github/workflows/ci.yml`, #58) runs the fast gates on every pull
request: lint, types, the dependency and comment gates, the build and its
`sw.js` stamp, every discovered unit, desktop and tool test
(`npm run test:all`), and the smoke and CSP browser suites
(`01-core.txt`, `52-csp.txt`).
[docs/architecture/testing.md](architecture/testing.md#ci) lists the
jobs. A separate job, `desktop-smoke`, runs `desktop/test/smoke.mjs
--only-target dev` against an Xvfb display (#89) on pull requests and pushes that touch app or desktop code — that
is where `main.js` and `preload.js` are actually executed, ~600 checks of it.
It is its own job because it launches ~60 real Electron processes — 6.3
minutes on a Windows 11 x64 machine, far longer on a slow shared runner —
which is more than everything else together. None of this is the full
regression: every suite through `tools/run-suites.mjs` on Linux and
`run-tests.ps1` on Windows, plus the packaged targets, runs at milestone and
release gates.

Since #80 CI also **produces** the app. It builds `index.html` and uploads it,
with `sw.js`, `manifest.webmanifest`, the icons, `VERSION` and `server/`, as the
`splitpage-app` artifact. The upload is the last step, so an
artifact only exists for a run whose checks all passed. Since 2026-10-31 only
push runs upload it; pull request runs do not (artifact storage quota).

**`.githooks/` is gone** (#80). It held a pre-commit hook that did two jobs:
it re-ran `build.mjs --check` against the staged tree so a commit could not
ship a stale `index.html`, and it refused any `index.html` whose `#state-data`
line was not byte-for-byte `.githooks/demo-state.json` — the guard against
saving your own script into the app's own page and pushing it to GitHub.
Untracking `index.html` retires both: there is no committed build output to
go stale, and a script saved into your local `index.html` is an ignored,
untracked file that `git add` will not pick up. `git config core.hooksPath`
is no longer part of setting this repo up.

What still needs the Windows machine: `npm run dist:win`, `verify-dist.mjs`,
NSIS, and anything touching a packaged binary — plus, inside
`desktop/test/smoke.mjs`, the packaged `dist/*-unpacked/Splitpage.exe`
targets and the one `MainWindowHandle` probe. The **dev target of the
desktop smoke suite runs anywhere** since #89, which is what matters: it is
the only thing that executes `main.js` and `preload.js`. `build.mjs --check`,
`desktop/test/drafts.test.mjs`, `desktop/test/ipc-table.test.mjs` and
`tools/test-server.mjs` already ran anywhere before that. The running list of
what is genuinely left is `docs/WINDOWS-CHECKS.md`.

**Desktop shell:** `desktop/test/smoke.mjs` drives a real Electron window
over CDP — the only thing exercising `main.js`/`preload.js`. Always launch
through it (`launchApp`, sets `SPLITPAGE_TEST=1` + a temp profile), never the
app directly.

```powershell
$env:PATH = "...\.cache\node-win-x64;" + $env:PATH
node test/smoke.mjs                    # dev + every packaged exe in dist/ and dist-test/
node test/smoke.mjs --only-target dev  # dev only, fastest loop
```

The release packages in `dist/` run only the hook-free groups; the full
smoke runs on the test package in `dist-test/` (`npm run dist:win:test`,
never published). See [WINDOWS-CHECKS.md, Before you start](WINDOWS-CHECKS.md#before-you-start).

On Linux (#89) the same dev target runs, and CI runs it on every pull
request. It needs a display of its own and, on a first checkout, an explicit
fetch of the Electron binary — Electron 44 has no postinstall. The fetch
script selects the machine architecture, including Windows ARM64 with x64
Node running under emulation:

```bash
node build.mjs --test                    # main.js serves index.html from APP_ROOT
cd desktop
npm ci
npm run fetch-electron
xvfb-run -a node test/smoke.mjs --only-target dev
```

The suite adds `--no-sandbox` itself, for the Linux dev target only:
`node_modules/electron/dist/chrome-sandbox` is not setuid and these
containers have no user namespaces to fall back on, so Electron will not
start without it. It is a harness launch argument and reaches nothing that
ships. Every check the platform cannot answer is printed as a `SKIP` line and
listed again under `SKIPPED (n)` at the end of the run, above the pass line —
so a thinner run never reads like a full one.

A full dev-target run took 6.3 minutes on Windows 11 x64; the ~55 minutes
first quoted here was the slow cloud container, not the suite.
`--only-group <text>` (debugging only, same spirit as `--only-target`) runs
just the groups whose registered name (`open/boot/security`, not the printed
tag `boot+security`) contains the text; it prints a banner and tags the
summary `PARTIAL RUN`, so a one-case run can never be mistaken for the suite,
and a filter that matches nothing exits 1. Launches that end with a dirty
tab are torn down with `expectForceKill` — the same 15 needed the kill on
Windows as on Linux, so it is how those cases end, not a platform quirk;
any other teardown that needs it is listed under `FORCE-KILLED (n)`.

After `npm ci` in `desktop/`, run `npm run fetch-electron` on every machine.
`desktop/electron-arch.mjs` detects native Windows ARM64 even under x64 Node
emulation; elsewhere it uses Node's architecture. Explicit `npm_config_arch`
or `ELECTRON_ARCH` overrides detection, in that order; unknown values fail.
Never run `npm run dist`/`dist:win` outside a deliberate release build.
`desktop/test/drafts.test.mjs` unit-tests `desktop/drafts.js` directly, no
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
`applyStashedWork()` merges on load. Never round-trip that JSON through
PowerShell's `ConvertFrom/To-Json` (mangles non-ASCII); slice raw `"state"`
bytes instead.

---

## 3. Architecture

### 3.1 The page is the database *at boot*

`#state-data` holds the seed document from `src/seed-state.json`. That's its
whole job — **documents live in files, not copies of the app**. Save writes
`.md` (table + fenced `splitpage` data block) or `.splitpage` (that record
alone). The format codecs in `src/adapters/formats/` build and parse both; `openProjectFile()` (`src/application/transitions/local-files.ts`) dispatches
into `adoptProjectState()`, the one place a parsed project becomes *the*
document. `PAGE_SHELL`/`buildPublishHtml()` (`src/adapters/page/page-shell.ts`) exist only for Standalone HTML
export. A server was a second home from 2026-08-28 until the server
features were removed; the app now saves to files only.

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
(in the document model a tag is one atom, so no DOM walk is needed: [INV-03](architecture/invariants.md)).

### 3.4 Tags are derived; the *registry* is not

Which scenes a tag appears in is read live (`collectTags()`). Which items
are tracked at all is real storage, `state.productionTags`. A mention is
one stretch of one tag in the cell's document model (`tagsInField()`, via
`cellOf()`, #85), not one tag span: two spans of one tag side by side,
which older copies stored, are one mention, and an empty span is none —
the count a cell keeps once anything edits it (`docs/DOCUMENT-MODEL.md`
§10 step 3).
`productionEntries()` merges registry + live mentions + owner/notes/status.
It is a pure read since #84: one production index, derived lazily and kept
until its inputs change — each row's id and two fields, each registry
entry's five fields, compared rather than tracked (the `contentMemo()`
reasoning: a key that is the input cannot go stale). The badges, both
panels, the untagged scan and Tab completion all share it, so a render or an
idle refresh derives it once. A live tag missing a registry entry still
*shows*; giving it the entry is `healTagRegistry()`, an explicit step with
no dirtying, run by `render()` and the idle refresh — and by `migrateRows()`
(`missingRegistryTags()`) for every document that comes in, so a document
looks after load exactly as it did when the read did the healing. Bulk
delete must still also call `removeTag()`, or the heal puts the item back.
Selection state is UI-only, never serialised. Read the panel through
`productionEntries()`, never `collectTags()`.

### 3.5 Comment boxes share the script's event handlers

Comment composer/reply boxes use the same `.cell-editable` class as script
cells — gate script-only behaviour on `isScriptCell(cellEl)`. The writer's
paragraphs are script cells too (`isScriptCell` accepts `#writer-doc`), which
is how the writer inherits tagging/Tab/Ctrl+B/sanitising for free (§3.9).

A comment or reply box (`isDraftBox`, `src/features/editing/cell-page.ts`) is edited through
the document model like a script cell — `throughModel` in `src/features/rows/render.js` sends
a format, a link or Enter to `editCell` or `editDraft` — but it is not the
document: its pictures and video cards ride through the model as
placeholder characters, and Ctrl+Z there is the box's own history, never the
document's and never the browser's (invariant #55). No edit uses
`execCommand` any more.

### 3.6 The merge was dormant for months — now it runs

The merge is three-way: `(baseState, state, theirs)`. **`baseState` must be
exactly what the other side last confirmed** — any new save path sets it to
what it successfully wrote, nothing else. Since #72 the
merge paths do not write it themselves: `applyMerge()` (`src/bootstrap/wiring/document-merge.ts`) is the
one orchestration — snapshot, undo point, `baseState`, autosave, chips,
toast — and the only writer of `baseState` on a merge; since #96 that
includes the boot stash and the crash-draft file merge, the latter through
`awaitUndoPoint` (the undo point is on disk before the merge is on screen).
Every other write is "adopt what the other side just confirmed" after a
successful write or open (or `null`: no ancestor), and goes through
`setBaseState(next, why)` next to it, each call with its reason — so
`setBaseState(next, why)` (`src/application/session/session-merge.js`) is the one writer of the base, called through `applyMerge`. `reportMerge(result, {alreadySaved:true})`
avoids re-queuing an autosave for a mid-save merge.

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
Accepting is a model edit of the cell (`tagTextRange`). Tab is shared with the
completion ghost, which wins outright. Visual column only, deliberately.

### 3.9 The writer edits rows, it does not import a document

One paragraph is one row's `audioText`, a real `.cell-editable` carrying that
row's `data-id`/`data-field` — no parse step, no second copy of the
document. Only two operations change the row list: **`splitWriterRow()`**
(Enter, via shared `splitRowFieldCore()`, §3.10) and **`mergeWriterRows()`**
(Backspace/Delete at an edge; refuses when both rows have a visual; status
accumulates by rank; the narration joined as models by `joinCells`, whose
glue space stays inside a comment both sides are in). Both are views since
milestone 3: they decide what the user asked, run `splitSceneCommand` or
`joinScenesCommand` (`src/application/commands/split-join.ts`) through the
session, and repaint. `caretAtEdge()` must not count empty inline wrappers —
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
their own render/refocus. It splits the cell's model (#85): the caret as a
model position (`cellSelection`), a selection deleted first, `splitCell`,
each half written back with `toHtml`, the comments re-pointed by the
session's reconciliation (invariant #18) — one undo entry, written by
`splitSceneCommand`, not by the caller. A cell still holding a picture
(pasted before design D7) is split through the model as well: a picture is one atom, so the split is a text cut (INV-10 in [invariants.md](architecture/invariants.md)). Alt+Enter never reaches `onRootKeydown` inside the
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
one matching `.tag-anchor[data-tag-cat="gear"]` CSS rule (invariant 14;
since #143 also its `--tag-gear` tokens) —
everything else already iterates `TAG_CATEGORIES` generically. `#gear-panel`
reuses `tagEntityHtml()` cards filtered by `gearEntries()`.
**`wireTagEntityContainer(id)`** is `#production-panel`'s event wiring
pulled out so `#gear-panel` gets it by a second call; **`renderProduction()`**
is a two-line dispatcher so every existing call site refreshes both panels
for free. `applyGearQuickAdd()` diffs the textarea against `gearEntries()`:
a new line registers a tag (orphaned from creation); a removed line deletes
the registry entry only if already orphaned (a live one self-heals back,
§3.4). The packing list prints through `buildPackingListPrintPage(catId)`
(`src/adapters/formats/list-print.ts`), on the same print-page shell as the
script ([print-layout.md](architecture/print-layout.md)).

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
  every `ipcMain` handler re-checks the sender frame (`isTrustedSender` /
  `isTrustedTabStripSender` in `ipc-setup.js`). Renderer never
  sends file paths to main (#34) — main keeps an id → path registry; writes
  are atomic (temp+rename).
- `createTabWindow` (`main.js:985`) makes a `BrowserWindow` whose primary
  view loads the tab strip; each tab is a `WebContentsView` from
  `createTab(windowId, opts)` (`main.js:1104`). `tabId`/`windowId` are
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
  3-button dialog listing every title. `session-end` asks nothing.
- Session restore: `<userData>/desktop-state.json` v2 — windows, bounds,
  tabs, each tab's *source*, no docId, no draft id; one serialized write
  queue, frozen once quit begins. `splitpage:tab-boot-sync` (sendSync,
  resolves before page boot) returns `{tabId, windowId, launchIntent:{type},
  hadPriorSession, hasDraftToRestore}` — no path, no server doc id (#34
  again). Crash reload/loop guard: twice per 60s per tab, third crash
  leaves it `crashed`, no reload, no prompt.
- **No white frame before a page paints** (#214): every tab's
  `WebContentsView` gets `setBackgroundColor(backgroundColorForTheme())`
  in `createTab()` before it loads, and `nativeTheme`'s `updated` handler
  repaints every view as well as every window. `<userData>/theme.json`
  (`{"theme":"system"|"light"|"dark"}`, written by `splitpage:set-theme`)
  sets `nativeTheme.themeSource` before the first window, so a launch with
  Settings ▸ Theme differing from the OS starts in the right colours.
- **Crash-safe drafts** (`desktop/drafts.js`, plain CommonJS) live under
  `<userData>/drafts/<tabId>/`: two-generation writes, `base-<sha12>.json`,
  `session.json`. Write is fsync then one sync tick renaming
  current→previous, tmp→current. **Hold/discard ordering is load-bearing**
  (#40): a tab with `hasDraftToRestore` is `hold()`-ed immediately;
  `write()` on a held tab returns `HELD`, touches nothing; released only by
  `splitpage:draft-restore-done` or an explicit user decision — never
  crash/kill/session-end/quit. `buildDraftHeader` (`main.js:300`) is built
  only by main from allowlisted scalar fields, never a PIN/token (#29).
- **The browser keeps no drafts.** Crash-safe drafts are desktop-only. The
  browser draft store, its writer and its Web Lock were removed with the
  last server leftovers; a browser draft a former server document left in
  IndexedDB is no longer read.
- **Desktop version history** (#83, `main.js` §8b): one
  `shared/history-store.js` (the store the browser runs too; policy from
  `shared/history-policy.js`) over `desktop/history-fs-backend.js`, both
  made once in `whenReady` before `registerIpc`. `<userData>/history/`:
  `FORMAT` `"2"` (higher → read-only), `index.json` + `index.prev.json`
  (every bucket in one index, two durable generations; a torn current
  falls back to prev and is kept as `.corrupt-<ts>`), `bodies/` (a
  `createBlobStore` folder of its own, content-addressed, refcounted by
  the index; a dropped body is unlinked only after the next generation is
  durable). Body before index; no fsck — a missing body drops its entries
  on read. Ids validated in renderer and main (#38); the renderer names
  only `(docId, snapshot id)`. Per-tab holds (`historyHolds`, dropped in
  `forgetTab`) join every eviction. **Channels** (six since #83 step 4,
  all `invoke`, app origin, table in `desktop/ipc-channels.js`):
  `history-put(docId|null, meta, stateJson, {protect?, older?})` →
  `{ok, sizeBytes, duplicate, evicted, overCap}` or `{ok:false, code,
  evicted?}` — `{older:true}` (literally `true`) with a **null** docId
  writes into Older, put-if-absent with no stamp (what
  `history-import-older` was; the renderer's `importOlder` is one such put
  per entry); `history-list(docId|null)` → `{entries, older,
  olderExpiresAt, usage}`, `usage` = `{totalBytes, capBytes, overCap,
  docCount, readOnly}` or null (what `history-usage` was; the panel always
  asked for both);
  `history-get({docId}|{older:true}, snapshotId)` (the query also carries
  the page's holds as `protect`) → `{meta, stateJson}` or null; `history-copy(from, to)` → `{ok, copied, code?}`;
  `history-touch(docId, title)` → nothing; `history-list-docs()` →
  `[{docId, title, lastOpenedAt}]`, Older excluded. Wire metas carry no
  docId (the renderer stamps it). A malformed call rejects (the renderer
  reads that as `invalid` and drops the entry); everything a retry could
  fix is a code. #83's one-time move of the v1 folder tree shipped in
  3.0.0 and was deleted in #100. Since then main deletes 3.0.0's
  `history/v1-backup/` at launch (`removeHistoryV1Backup`, fire-and-forget
  3 s after the folder opens, skipped when read-only, retried next launch
  on failure). A raw v1 `docs/`/`older/` (someone who skipped 3.0.0) is
  left dormant: never read or deleted, and a fresh index starts beside
  it. Test-mode faults:
  `SPLITPAGE_TEST_HISTORY_FAULT` = `exit-after-body`, `enospc-once`/`-always`;
  `SPLITPAGE_TEST_HISTORY_CAP_BYTES`.
- **Content-addressed blobs** (#82, `desktop/blob-store.js`, `main.js`
  §8c). Images leave the document state and live in `<userData>/blobs`:
  `FORMAT` (`"1"`) and `sha256/<aa>/<sha64>`, the raw bytes named by their
  own SHA-256 (`<aa>` = its first two hex digits). Plain CommonJS, no
  Electron, like `drafts.js`. A put checks the bytes hash to the sha, writes
  `.tmp-<hex>` in the shard folder, fsyncs, renames (retrying a held target
  on Windows), then fsyncs the folder best-effort (a no-op on NTFS); a sha
  already there at the same size is `stored:false` and nothing is written.
  A get re-hashes what it read and, on a mismatch, **deletes the file** and
  answers null — the name is the checksum, so that file is provably not
  anyone's bytes, and a document file still inlines every image (#82 D1) to
  put it back. Per-sha operations are serialised, so a get that deletes a
  damaged copy cannot race a put's good one. The launch sweeps leftover
  `.tmp-*`; a `FORMAT` other than ours makes the store read-only (reads
  still work, every file is checked against its own name). Nothing else
  ever deletes (#82 D4: no GC); `list()`/`delete()` exist for a later
  collector and no channel reaches them. The store is not image-specific —
  #83 means to keep snapshot bodies there — so the image rule
  (`imageBlobRefusal`: PNG/JPEG/GIF/WebP by magic, never SVG, ≤16 MiB) is
  the **IPC door's**, exported from the same file only so main and the unit
  test share one copy. **Channels** (all `invoke`, app origin, a new
  `sha256` arg type in `ipc-channels.js` — 64 lowercase hex):
  `blob-put(sha, bytes)` → `{ok, stored}` or `{ok:false, code}`
  (`BAD_BYTES` for a string, `EMPTY`, `TOO_LARGE`, `NOT_AN_IMAGE`,
  `HASH_MISMATCH`, `READ_ONLY`, `UNAVAILABLE`, or a write errno such as
  `ENOSPC`); `blob-get(sha)` → `{bytes, mime}` (mime sniffed from the
  bytes, never remembered from a put; a non-image answers null) or null;
  `blob-missing(shas)` → the subset not held, ≤2000 shas per call, anything
  else rejects. A store that could not be created leaves the app running:
  puts answer `UNAVAILABLE`, gets null, every sha is missing. The renderer
  side is `makeDesktopBlobBackend(bridge)` in `src/adapters/desktop/desktop-blobs.js` (the page
  registry's `get`/`put`/`missing` interface; `put` rejects with
  `err.code`), and `makeFakeDesktopBackend({blobs:true})` fakes the three
  bridge calls for browser suites.
- **YouTube and Vimeo in the gallery** (#141, #168, `main.js` §9e,
  `shared/video-embed.js`). The page's policy is build.mjs's, re-served
  as a header (§10), so its `frame-src` — `'self'` plus YouTube's no-cookie
  embed and Vimeo's player — needed no second edit here; `TABSTRIP_CSP`
  keeps `frame-src 'none'`. Three things main does for it: (1)
  `splitpage:video-thumbnail(host, ref)` — typed `videoHost`
  (`youtube`|`vimeo`) and `videoRef` (an 11-character YouTube id, or Vimeo
  digits with `:hash`), never a URL — fetches the thumbnail with Node's
  fetch from the fixed hosts, no redirect, no cookie, no referrer,
  JPEG/PNG/WebP ≤ 1 MiB, answering `{ok, bytes, mime}` or `{ok:false,
  code}`; (2) YouTube's player refuses a request with no Referer ("Error
  153", checked server-side — confirmed with curl 2026-09-24), and a
  `splitpage://` page sends none, so `installPlayerReferer` adds
  `Referer: https://com.retrogorilla.splitpage/` (the app id, as YouTube
  asks embedding apps to) to the `…/embed/*` subframe request from one of
  this app's tabs, and to nothing else; (3) the permission handlers now
  judge by the asking frame (`details.requestingUrl`, or the origin for a
  cross-origin frame's check), so a player frame inside a tab gets no
  microphone or clipboard. Links a player opens in a new window go to the
  system browser through the existing window-open handler; frame
  navigation needs no handler of its own — `will-navigate` is the main
  frame's, and the page's `frame-src` already bounds the frame.
  `SPLITPAGE_TEST_VIDEO_BASE` (test mode only) points every host at a fake;
  `caseGalleryVideoThumbnail` in smoke.mjs uses it. Not run on this
  machine (no Electron binary for x64 here) — first run is CI's
  desktop-smoke job.
- Duplicate document-id claims reassign in memory only (§4, #36).
  `chooseDuplicateLoser(a, b)` (now `shared/doc-id-policy.js`, #76): server
  home beats file home; birthtime is **not** consulted between two files —
  `atomicWrite` measurably moves NTFS birthtime on save — so the loser is
  decided by claim order instead. #76 deleted the `DUP_TRUST_BIRTHTIME =
  false` flag, the `stat` behind it and the deferral it forced; the verdict
  is unchanged and `caseAtomicSaveKeepsBirthtime` stays as the guard against
  a birthtime rule being written back in. The reassigned tab doesn't
  dirty/autosave.
- Test mode: `SPLITPAGE_TEST=1` — window never shown/taskbarred, an
  unanswered dialog resolves Cancel, an uncaught main-process error exits
  to stderr instead of a modal. `SPLITPAGE_USER_DATA` gives a temp profile;
  `SPLITPAGE_TEST_DIALOGS` pre-answers dialogs. Test bridge:
  `__testRequestClose/Quit/CloseTab`, `__testShell(op, args)`. A page-run
  `window.close()` never fires the `BrowserWindow`'s `'close'` event —
  Chromium tears the page down without asking main; nothing in `src/`
  calls it.
- `desktop/test/smoke.mjs`: Node built-ins only, drives real window(s) over
  CDP. Covers boot/security/save/export/update plus the tabs surface,
  route-open dedupe, one-dialog-per-quit, session restore, crash
  reload/loop, duplicate-id reassignment, crash-safe drafts, the blob
  folder (#82). Runs on
  Windows and Linux since #89 — the dev target on both (under a virtual
  display on Linux), the packaged `.exe` targets on Windows only. macOS is
  written for but unrun. A check this platform cannot answer prints `SKIP`
  and is listed again in the run summary; it is never quietly dropped and
  never rewritten weaker.

### 3.14 Motion is a token layer, and `render()` stays synchronous

`src/styles/base.css` defines one motion vocabulary on `:root` — `--dur-press`,
`--dur-fast`, `--dur-enter`, `--dur-exit`, `--dur-move`, plus
`--ease-standard`/`--ease-enter`/`--ease-exit`. Every transition and
animation in the file reads from it. Add motion by reaching for a token, not
by picking a number: before this existed there were eight ad-hoc durations
and `ease` almost everywhere, and nothing matched anything else.

`prefers-reduced-motion` is handled **once**, by collapsing the movement
tokens to `0.01ms` in a single `@media` block. Near-zero rather than zero so
`transitionend`/`animationend` still fire. `--dur-flash`, `--dur-highlight`
and `--dur-pulse` are deliberately left alone: a colour flash is not
movement, and collapsing an *infinite* animation (`pp-rec-pulse`) towards
zero would spin the style engine. A component only needs its own
reduced-motion block if a duration change is not enough — dropping a
transform, or standing an effect down entirely.

Things that appear must also disappear. `[hidden]` is `display: none`, so a
keyframe animation can only ever play one way; the pattern for an exit is
`transition: … display <dur> allow-discrete` plus an `@starting-style` rule
for the entrance. Side panels, the File drawer and every `.modal-backdrop`
use it. A transition declaration outranks `!important` in the cascade, so
the global `[hidden] { display: none !important }` does not defeat it.

Present and the Writer use it too (#133, #136): each fades in over the view
it covers and back out, opacity only, on the container. Three rules keep a
fade from costing anything but pixels, and a change to either mode keeps
them:

- **`hidden` flips in the open/close call, and everything the mode needs is
  done in that call.** Keys, Play, Mirror/Flip and the Writer's caret work
  mid-arrival; the split view is painted when `closeWriter()` returns. Suites
  read `.hidden` straight after a click and must keep being right to.
- **`closeWriter()` syncs the focused paragraph (`syncFieldFromDom`) before
  anything about leaving happens** — then blurs it, then sets `inert` and
  `hidden`. A fading writer that still held the focus would go on taking
  keystrokes nobody could see. `closePrompter()` likewise stops playback,
  voice and the wake lock first. A leaving layer is `inert` with
  `pointer-events: none`, so a click during the fade reaches the view
  underneath.
- **No transform on either container.** Mirror/Flip are transforms on
  `.prompter-scroll`, the caret's `scrollIntoView` and the scene cue measure
  the page, and a transform would make the container a containing block for
  anything fixed inside it.

Two exceptions to "CSS only": a fullscreen prompter is held opaque
(`.is-holding`, the one rule that overrides the global `[hidden]`) until
`exitFullscreen()` settles (or 1s), so the browser's own exit and our fade
never run together; and `body.prompter-open` (the page scroll lock) goes on
when the arrival finishes, not in the frame it starts, so the scrollbar
leaving does not shift the editor under a still-clear layer.
`.claude/skills/run-splitpage-app/tests/150-mode-transitions.txt` slows the fades by setting the tokens inline
on the two elements and checks all of it.

**`render()` must stay synchronous.** `src/features/rows/row-motion.ts` animates scene
reorder/insert/delete/collapse with FLIP — measure, let render() reconcile
`#rows` (§3.16), measure again, put things back with a transform and animate
it away. It is FLIP and *not* the View Transitions API for one reason:
`startViewTransition()` runs its callback asynchronously, and roughly 120
assertions across `tests/` read the DOM immediately after a click with
nothing in between. `withRowMotion(rowsEl, paint)` calls `paint` exactly
once, synchronously, and defers only the pixels.

Two traps it already works around:

- **Measure in document space**, not viewport space (`rect.top + scrollY`).
  `render()` can refocus the cell that had the caret, and focusing can scroll
  the page — measured in viewport space that scroll reads as every scene in
  the document having moved, and the whole script slides on a render that
  changed nothing.
- **Nothing is animated out, and do not add it back as a clone.** The
  obvious fade-out for a departing scene is to clone it into a layer and
  fade the clone. That was written, and removed: for the length of its fade
  a clone is a second copy of real interface sitting in the document, where
  every selector in the app and every assertion in `tests/` can reach it.
  Stripping `id`/`data-id` off it is not enough — the **classes** are
  selector hooks too. Both `.row` and `.hidden-shot-strip` are queried
  unscoped here (`48-hide-shot.txt` asks
  `document.querySelectorAll('.hidden-shot-strip').length == 0` to mean "the
  run is expanded"), so a fading clone would have answered those queries
  with a scene that no longer exists. A departure is announced by the FLIP
  instead: everything below closes the gap, which is what actually reads as
  "it went away".

### 3.15 One loading indicator, and it waits before showing

`src/features/notices/busy.ts` owns the only "something is happening" affordance in the app:
a 2px indeterminate bar at the top of the window. `withBusyBar(label, fn)`
wraps an async operation; the result and any thrown error pass straight
through. Currently wrapped: every export (they all funnel through
`exportAs`) and the file parse in `loadFileIntoEditor`.

Two things keep it from becoming noise. It is a **counter**, not a flag, so
overlapping operations raise it once and drop it once. And it does not
appear for `BUSY_SHOW_DELAY_MS` (250ms) — a bar that flashes up for 30ms
reads as a glitch, so most exports on most scripts show nothing at all.

It is **`withBusyBar`, not `withBusy`**: `20e-connect.js` used to declare
`withBusy(button, label, work)`, and the fragments shared one function scope,
so the later file simply won. #66 ended that whole class of hazard — modules
have their own scope and a collision is now an esbuild error rather than a
silent last-one-wins.

### 3.16 `render()` reconciles `#rows`; `renderRow()` repaints one row

Until #84 every `render()` rebuilt all of `#rows` through `innerHTML`, so a
structural change anywhere (add, delete, move, a comment posted, a tag
applied) cost every row, and the focused cell came back with its caret at
the end. Now:

- **A row is five parts** — its class, gutter, visual media and two fields —
  built by `rowParts()` in `src/features/rows/render.js`. The part strings are the change
  detection: each row element carries the parts it was last painted from
  (an expando, never an attribute), and a part whose freshly built string is
  identical is not touched. `rowHtmlFromParts()` in `src/features/rows/render.js` is those parts joined, byte for byte
  what it always produced.
- **`render()`** keys `#rows` by row id (a shot strip by the ids it covers —
  `hiddenShotStripHtml()` in `src/features/rows/hide-shot.ts`, the key `rowMotionKey()` in `src/features/rows/row-motion.ts`
  uses), reuses every element still wanted, repaints only changed parts,
  creates new rows, drops gone ones, and moves the rest with a
  longest-increasing-run pass that never moves the row holding focus (a
  moved node loses focus). A focused field that was reused keeps its node,
  its content and its caret, untouched; one whose text changed underneath it
  is rebuilt and gets the caret at the end, as every render used to. A
  row's own attributes and its column wrappers' classes are reset each time
  (a drag's `draggable`/`is-dragging`, an image drag's `drag-over`), as a
  rebuild did.
- **`renderRow(rowId)`** is the same repaint for one row, and returns false
  when the row is not on screen (folded into a strip) so the caller renders
  instead. `cycleRowStatus()` uses it; `paintRowStatus()`, which mirrored
  `rowHtml()` by hand, is gone.
- **Typing keeps the signature current.** `syncFieldFromDom()` records that
  the field now shows what state says (`noteFieldPainted()`), so the next
  render leaves it alone. Only a `#rows` cell counts: the writer edits the
  same row and the `#rows` copy is repainted when it next renders.
- **One cell builder.** `editableCellHtml()` builds the script field, the
  writer's paragraph and the reply box.
- **One idle refresh.** `scheduleProductionRefresh()`, `scheduleUntaggedScan()`,
  `scheduleBrollRefresh()` and `scheduleWriterStats()` only mark their job
  pending on `scheduleIdleRefresh()` (`src/features/tags/production-tags.ts`): one 180ms
  debounce, capped at 1s of unbroken typing, runs everything pending against
  one production index (§3.4). They used to be four timers (180/200/220/400ms)
  each deriving the breakdown for itself.

What a rebuild used to give for free and a reconcile has to do on purpose:
`render()` still re-applies `ensureTrailingCaretSpot()` to every field,
disarms an armed row delete, and drops a saved link-popover Range only
if its cell is gone. `.claude/skills/run-splitpage-app/tests/67-render-perf.txt` holds the numbers: typing in a
300-scene document renders nothing and derives the breakdown once per idle
refresh; an insert elsewhere keeps the focused cell's node and caret and
builds two fields.

---

## 4. State schema

Section headers (I-31) are an optional `sections` list of
`{ id, name, firstSceneId }` records. They are boundaries anchored to real
scene IDs, never scene rows. Scenes before the first boundary are unsectioned.
The list is absent when empty, so sectionless files retain their old bytes.
Both `.splitpage` and the authoritative Markdown data block carry the list;
the legacy Markdown project table remains unchanged. Migration orders valid
boundaries by scene order and removes invalid, duplicate or orphaned entries.
Names are plain text, limited to 200 code points. See
[sections.md](architecture/sections.md) for editing, undo and merge rules.

```jsonc
{
  "title": "string ≤300 chars",
  "schema": 2,                  // SCHEMA_VERSION — docId did NOT bump it (#35)
  "docId": "d0123…(32 hex)",    // /^d[0-9a-f]{32}$/, minted by migrateRows if missing
  "rev": 0,                     // the in-document merge counter (max-plus-one)
  "lastEditedBy": null, "lastEditedAt": null,
  "wordsPerMinute": 150,        // clamped 60–400
  "targetSeconds": 120,         // #170 — whole seconds 1–86400, ABSENT for no target
  "rows": [{ "id": "r1", "visualText": "sanitised HTML", "audioText": "sanitised HTML",
    "imageRef": { "sha256": "64 lowercase hex", "width": 1, "height": 1,
                  "mime": "image/png | image/jpeg | image/gif | image/webp" },  // or null
    // the scene's gallery (#135, 02d-gallery.ts), each key absent when empty:
    "imageName": "wide.png",
    "imageLinks": [{ "href": "https://…" } | { "name": "clip.mp4", "size": 1 }],  // + "duration", "poster": true
    // a poster link's item's imageRef is its still: a file's first frame, or
    // a YouTube/Vimeo link's fetched thumbnail (#141) — an ordinary blob
    "moreImages": [{ "imageRef": { /* as above */ }, "name": "…", "links": [ /* as imageLinks */ ] }],
    // a length set by hand (#179): whole seconds 0–86400, absent = the estimate
    "lengthSeconds": 90,
    "status": "todo | ready | shot", "updatedAt": "ISO", "updatedBy": "name" }],
  "comments": [{ "id": "c1", "rowId": "r1", "field": "audioText | visualText | visualImage",
    "anchorId": "c1", "quotedText": "plain text", "author": "name", "body": "sanitised HTML",
    "resolved": false, "resolvedBy": "name or null", "resolvedAt": "ISO or null",
    "assignee": "name or ''", "kind": "anchor | conflict", "createdAt": "ISO", "updatedAt": "ISO",
    "imageValue": { /* an imageRef, or null */ },  // image conflict cards only
    "replies": [{ "id": "rp1", "author": "name", "body": "HTML", "createdAt": "ISO" }] }],
  "people": [{ "id": "p…", "name": "Jordan" }],
  "productionTags": [{ "cat": "prop | location | cast | vfx | sound", "name": "Camera Rig",
    "owner": "p… or ''", "notes": "plain text ≤2000",
    "status": "needed | sourcing | have | returned" }],
  "brollShots": [{ "id": "bs…", "name": "the line's words", "desc": "plain text",
    "status": "unshot | shot", "reshoot": false, "notes": "plain text ≤2000",
    "owner": "p… or ''", "audioRef": "plain text", "location": "plain text ≤80",
    "origin": "script | list",
    "props": [{ "id": "t_… (a productionTags id) or ''", "name": "≤80" }] }],  // ≤40, hand-added only (#149)
  "personColors": { "Adam": "#CBA1FA" }  // #194 — ABSENT until somebody picks; see below
}
```

**Filename naming (I-32)** uses optional `titleOrigin` (`file` or `user`)
and `titleVersion` (`v` followed by digits) fields. Neither has a default,
so older documents remain without them. `STATE_FIELDS` normalizes them,
keeps them in both project formats and includes them in undo. Their optional
scalar merge takes the changed side, including deletion; competing changes
take theirs. Schema remains 2. First picked save derives an untouched
untitled title, while later Save As changes only the tag for file-derived
titles. Explicit title edits retain the tag and mark the origin `user`.
Download-only browsers change neither field. See
[saving.md](architecture/saving.md#first-save-title-and-version-i-32) for
capture, completion, concurrency and undo rules.

**`personColors`** (#194) is the colour each person picked for themselves,
`{name: colour}`: a name (trimmed, ≤80 characters) to one of the eight
`PERSON_COLORS` (`src/core/document/person-colors.ts`), at most 200 of them. It has **no
default**: a document nobody picked in has no key at all, so a file from
before #194 reads, merges and saves byte for byte as it did, and an older
client that meets the key just carries it. Your pick lives in your prefs
(`splitpage-person-color`) and a session effect writes it under your name
into each document you edit (`src/application/save/session-effects.ts`). It
is bookkeeping, not content: `src/core/document/fields.ts` (`undo: false`) keeps it out of
the undo stack. `migrateRows()` cleans it (`normalizePersonColors`: garbage
dropped, names that differ only in case or padding kept once, the key
deleted when nothing valid is left); `mergeStates()` merges it per name with
`mergePersonColors` — the side that moved a name off the base wins, both
moved it is mine, a name either side (or only the base) has is kept, nothing
is ever removed. Both project formats carry it unchanged (it is just a
state key). A person's colour is resolved by `personColor(name)`
(`src/bootstrap/wiring/ports/person-colors.ts` over `resolvePersonColor`):
your own pick for your name, then this map, then the hash of the name — which is what everyone got before #194 and still gets until they
pick.

`ROW_FIELDS = ["visualText","imageRef","audioText","imageLinks","moreImages"]`
merges as content (an `imageRef` compared by its sha; the gallery's two
lists as sets, both sides' additions kept, never a conflict, #135); `rows[].status` and
`productionTags[].status` merge by rank (further-along wins);
`owner`/`notes` merge "filled beats empty".

**A scene's length** (#179) is `rowSeconds(row)` (`src/core/production/timing.ts`):
`rows[].lengthSeconds` when it is set, which replaces the estimate outright,
otherwise the Audio words at `wordsPerMinute`. Every consumer — the gutter's
start times, the program clock, the rundown strip, the Production and B-roll
panels, the CSV, Present's clock — reads `rowSeconds()`, never the words
directly (Present's *scroll speed* is still words and reading speed).
`migrateRows()` keeps a whole number 0–86400 and drops anything else, so a
file from before #179 reads as the estimate. It is set from the rail's Read
time (`src/features/rows/read-time.ts`; typed as `1:30`, `90`, `90s`, `1m30`, `1m 30s` —
`parseSceneLength()`). It is not in
`ROW_FIELDS` (not text): `mergeRow` takes the side that changed it since the
base, theirs when both did (no conflict card), and with no base a set length
beats none; `rowContentEqual()` counts it, so setting it outranks the other
side's delete. Undo needs nothing — `diffStates` makes it a `rowField` step.
A `.splitpage` and the `.md` data block carry it as any row key; the `.md`
table does not show it. Present counts it too, for a scene with no Audio
words as well (its clock steps over that scene's length as the reading
passes it, and the running order gives it a block); only Present's scroll
speed is words at the reading speed.

**A target length** (#170) is the document key `targetSeconds`, whole
seconds 1–86400, and — like `personColors` — has **no default**: no target
is no key, so a file from before #170 reads, merges and saves byte for
byte as it did. `migrateRows()` keeps it through `normalizeTargetLength()`
(`src/core/document/timing.ts`; 0 and garbage delete the key). `mergeStates()` uses
the `target-length` strategy, `mergeTargetLength()` (`src/core/merge/scalars.ts`): merged
like the title — the side that changed it since the base wins, and taking
it away is a change too (which `changed-side-wins`' `m || fallback` would
lose) — but both sides changing it keeps theirs with no conflict card, as a
scene's length does; with no base a set target beats none. Both project
formats carry it as a plain key; the `.md` table does not show it and no
export prints it. It is set only through `setTargetLength()`
(`src/features/rundown/target.ts`), one `markDirty()`, so undo sees a `docField` step. What reads it:
the script's length (`updateScriptStats()`: `1:35 / 2:00` and `0:25 left` /
`0:05 over` in `#runtime-slot`, via the pure `targetClock()`; since #207 a
label at the end of the rundown, `#runtime-chip`, placed by
`rundownLengthPlace()`, and at phone widths `#length-status` in the
header's status line — it was the header's program clock before; the
target is measured against the whole script — with shot scenes hidden the
remaining-to-shoot figure moves to the tooltip), and the rundown
strip (`setRundownExtraSeconds(target)`, so the span is
max(target, total) + 10s; `src/features/rundown/target.ts` draws the line, "Target 2:00" and
the hatching on `#rundown-overlay` from `rundownLayout().x` — the layout at
rest, never `rundownX()`, because the overlay is faded while the lens is on
and must be right when it settles; and never seconds × `pxPerSecond`, since
the rest floor (`REST_MIN_PX`, `rundownRestLayout()`) keeps short scenes'
blocks wider than to scale; minimized, CSS leaves only the line as a tick).
Present does not show it.

**Per person, not per document:** the script's zoom (#191) is
`localStorage["splitpage-script-scale"]` (a number, 1 = 100 %, absent at
100 %), applied as `--script-scale` on `#root` by `src/features/script-zoom/script-zoom.ts`, which
also re-applies on a `splitpage:pref` event (`detail.key` that key) and on
another window's `storage` event.

**The two script cells merge a word at a time** (#85,
`docs/DOCUMENT-MODEL.md` §8). `mergeRow` hands each to `mergeTextField()`
(`src/core/merge/text-field.ts`), which reads base, mine and theirs into the document model
(`fromHtml`, `src/bootstrap/richtext.ts`), **each through its own side's registry**
(`textMergeContext` → `registryTagHooks`), so a tag renamed on one side is
the same tag id on all three and a rename alone is not a change. Two
strings that read as the same cell are the same cell (a re-serialisation
never counts as an edit; theirs' string is kept). Both sides changed it:
`mergeCells` merges the words and then the marks, and only the same words
changed differently on both sides is a conflict — handled exactly as the
whole-cell conflict always was: theirs stays live, my **whole** cell goes on
an "Unmerged edit" card (design D3). The result names every tag the way the
**merged** registry does (the registry is merged before the rows for that),
so a rename from the other side reaches a cell taken from this one. A cell
holding a picture or video card (which the model leaves out, D7) is still
compared as a string, whole. The on-disk merge review (`src/features/merge/local-merge.ts`)
decides each cell with the same `mergeTextField()`, and shows "both sets of
changes are combined" for an outcome of `merged`.

**A stage direction** (#167) is the model's `dir` mark on words of the
Audio column, stored as `<span class="stage-dir">` (the sanitiser keeps the
class and nothing else), nested just inside the comments so only a comment
edge can cut one; never on a b-roll key; a tag is all in one or not
(`normalizeCell`). Its brackets are never stored: the stylesheets in `src/styles/` draw them in the
editor, the Writer and the prompter, and every text reader adds them —
`toPlainText` "(beat)" (its `directions: "omit"` and `spokenText()` leave
them out), `toMarkdown` `*(beat)*`, `toDocxRuns` a `(`/`)` run each side with
`dir: true` (the .docx writes the `SplitpageDirection` character style,
which `docxToRows` reads back; the PDF prints them grey italic), and
`htmlToMarkdown` — the `.md` project's table — `((beat))`, the typing
notation, so a hand-edited table cell gets them back (`audioDirectionsHtml`,
`src/adapters/formats/docx.ts`, also run on a `.docx`'s and a paste import's Audio). An older
copy's sanitiser unwraps the span, so there a direction reads as narration;
its `.md` table shows the `((beat))` literally. `wordCount` (so
`rowSeconds`) counts `spokenText`; `prompterSceneHtml` leaves a direction's
words out of the `.w` spans voice follow listens for. Typing: `((words))`
converts on the second `)` in the Audio column only (`directionShortcut`,
`src/core/text/directions.ts`, where the typing convention Adam signed off is recorded;
`maybeDirectionShortcut`, `src/features/rows/render.js`), one undo entry of its own; a
character typed at either edge of one is narration (`typingMarks`,
`typeAtDirectionEdge`). The narration export's "Include stage directions"
is `localStorage["splitpage-export-directions"]` (`"0"` off, absent on).

**Images are references, not bytes** (#82). The document state never holds
image bytes; the bytes live once, content-addressed by SHA-256, in a blob
store (browser IndexedDB `splitpage-blobs`, desktop `<userData>/blobs`,
server `DATA_DIR/blobs`), and `02c-blobs.ts` is the page's registry of them.
- A row's picture is `imageRef`, a record gated by `normalizeImageRef()`
  (`shared/blob-policy.js`): exactly those four fields, the type sniffed
  from the bytes, never SVG. The old key `visualImage` (a `data:` URI) is
  read, interned and deleted by `migrateRows()`; a valid one wins over an
  `imageRef` on the same row. The comment `field` value `"visualImage"` keeps
  its name (#82 D5).
- An image inside HTML — comment and reply bodies, pasted cell HTML — is
  `<img class="comment-img" data-blob="<sha>" data-w data-h data-mime>` with
  **no stored `src`**. `sanitizeHtml()` interns an inline `data:` image into
  that form, keeps a valid `data-blob` (attributes from the registry when it
  holds the bytes), strips any `src`, and drops everything else.
  `storedImageHtml(ref)` is the same string for HTML built outside it.
- The hydrator (a MutationObserver in `02c-blobs.ts`) gives every
  `<img data-blob>` in the live DOM a `blob:` `src` once `ensureBytes()`
  has the bytes (memory, then the backend); one nobody has
  is marked `data-blob-state="missing"`, alt "Image unavailable". The mark
  lives on the element only, so a re-render (the comments list rebuilds on
  every change) makes a fresh `<img>` and asks again. Anything
  that reads the DOM back into state without sanitising
  (`syncFieldFromDom`) passes it through `storedHtmlFromDom()`, which strips
  those attributes again.
- An image conflict card (`kind:"conflict"`, `field:"visualImage"`) holds the
  user's picture as `imageValue`; its `body` shows the same picture in the
  stored form. `imageValue` is the source of truth: "Use my version" puts
  it back, and the card draws it.
- `refsIn(state)` (`shared/blob-policy.js`; the server keeps its own copy)
  lists every sha a state names: `imageRef`, `imageValue`, and `data-blob`
  on an `<img>` in any row, comment or reply HTML. Every writer that must
  not name an unstored blob persists `refsIn` first (#52).
- The crash stash (`splitpage-conflict-stash`) names pictures by
  ref too, and carries `blobs: {sha: data URI}` for any the durable store
  does not hold yet; `acceptStash()` interns them on the way back in.

**`docId`** (`src/core/document/ids.ts`, frozen `sha256Hex`/`deriveDocId`) is
minted by `migrateRows()`, carried through `mergeStates()` via
`mergedDocId()`, derived deterministically for legacy files with none.
Never in the seed, `#state-data`, or Standalone HTML export. Join key for
per-document history, drafts, duplicate-tab detection. Invariants #35–#37.

**Per-document version history**, capped 50 snapshots/document, keyed by
`docId`. ONE store since #83, `shared/history-store.js` (put-if-absent by
snapshot id, the stamp after the bucket's newest, the trim to 50, cap
eviction, the quota retry, Older's creation and expiry, holds, index-only
copy, which bodies may go), run over a backend per place: in the browser
over `03c-history-idb.ts`'s IndexedDB (`splitpage-history` v3: an `index`
store, one DocRecord `{bucket, title, lastOpenedAt, migratedAt?,
expiresAt?, snapshots:[meta + sha]}` per bucket, and a `bodies` store,
`{sha, stateJson}`, one row per distinct content, shared by every entry
naming it), or over the shared memory backend when IndexedDB will not open
(for the rest of that page); on the desktop in main, over its folder
backend (§3.13), with `src/adapters/storage/history-backends.ts`'s `desktopHistoryBackend` a
thin IPC client. Totals are computed from the index (no stored counters);
a body goes only in the commit that stops naming it, and is written before
the commit that names it. Pre-tabs shared history migrated once into a
synthetic "Older" document, expiring 90 days after that migration
(`HISTORY_OLDER_TTL_MS`; an expiry ≤ 0 is "not stamped", never "expired").
Eviction order: expired Older, trim every doc to 50, Older oldest-first,
then docs by `lastOpenedAt` ascending — a doc's newest snapshot is never
evicted.

3.0.0 moved the browser's v1 layout (`docs`, `snapMeta`, `snapBody`,
`meta`) into v2 with a one-time migrator; #100 deleted it. The v3 upgrade
(`upgradeDb`) counts `snapMeta` and `snapBody` inside the versionchange
transaction and drops the four v1 stores only when both are empty, which
is what a finished 3.0.0 move leaves. v1 stores that still hold rows
(3.0.0 skipped, or its move unfinished) are kept dormant, never read or
written: there is no reader left, and dropping them would destroy
history. A database a newer build wrote is served read-only: every write
answers `read-only`, and captures stay pending in the page with ONE toast
and one panel line.

History fault injection and inspection controls are test-build-only. The
factories in `src/adapters/storage/history-*-testing.ts` and
`history-fault-queue.ts` are selected by `src/bootstrap/wiring/history.ts`;
the storage backends and recovery owner receive no-op defaults in release
builds. The shared memory backend takes the same injected write observer.
See [testing.md](architecture/testing.md) for the release-name scan and test setup.

**Crash-safe drafts** (§3.13): a `stateJson` full `state`
object plus a separate `DraftHeader` (never document fields) — not document
schema. On the desktop per tab, for every kind of document; in the browser
only for an unsaved copy restored from a draft a former server document
left (§3.13), in IndexedDB `splitpage-drafts`:
`meta` `{key, base, docId, rev, title, writtenAt, writerId, editSeq, schema,
docIdWrittenOut, bytes}` and `bodies` `{key, stateJson, baseJson}`, `key` =
`JSON.stringify([base, serverDocId])`. **`desktop-state.json` v2**: no document content and no docId, just
windows/bounds/tabs/each tab's *source*/`lastKnownTitle` — a launch recipe,
not a backup (§3.13).

**The two file formats**, both through the format codecs in `src/adapters/formats/`, entering state
only via `migrateRows()` (#2): **`.splitpage`** is
`JSON.stringify(inlineStateImages(migrateRows(cloneState(state))), null, 2)`,
no envelope (#31). Files carry their pictures inline, as they always have
(#82 D1): `inlineStateImages()` turns each `imageRef` back into
`visualImage: "data:…"`, each `<img data-blob>` into
`<img src="data:…" class="comment-img">`, and writes an image conflict
card's picture into its body — what an older client wrote and reads. A
picture whose bytes nobody has stays a ref and the save says "N images
could not be included". Standalone HTML gets the same inline form; the page
keeps the refs.
**`.md`** is `toMarkdownTableDoc()` (title, scene table, breakdown,
comments) followed by a fenced `~~~~splitpage` block holding the exact
`.splitpage` bytes (so its images are inline there too, and a row's picture
also inline in its Visual cell, #82 D2; HTML images are only in the block —
the table's text never showed them), fence length computed per file so a quoted example
can't shadow the real block. Reading reconciles hand edits cell-by-cell
against `mdSceneCellSource()`: equal keeps the block's HTML intact,
different rebuilds via `legacyMdToHtml()` + `sanitizeHtml()` (comment
anchors lost, `quotedText` kept); a differing row count asks
(`#md-rows-modal`), never reconciles silently; no data block ⇒ ordinary
lossy import (#32). The table's cells are `htmlToMarkdown()` of the
block's HTML, **not** the document model's `toMarkdown()` that the plain
Markdown export uses (#85): every copy of the app, older ones included,
compares the table with its own `htmlToMarkdown()` of the block, so a cell
written any other way is rebuilt from the table there, and an unchanged
document would stop re-saving byte for byte. Reading also accepts the
model's form as unchanged, so the writer can switch once no older copy is
in use (`mdSceneCellSource()`, `sceneCellEdits()`).

**Browser storage** (follows the reader, not the file): `splitpage-comment-author`,
`splitpage-snapshots` (legacy, read-once Older-bucket migration source, do
not write to it), `splitpage-conflict-stash`/`-reloaded` (sessionStorage),
`splitpage-tagging-help-dismissed`, `splitpage-files` (IndexedDB,
`FileSystemFileHandle` for resume-on-launch), `splitpage-history`
(IndexedDB v3, per-document history: `index` + `bodies`, plus the v1
stores until the one-time move has emptied them — see above), `splitpage-blobs` (IndexedDB, store
`blobs`, key = sha256, `{mime, size, bytes: Blob, addedAt, usedAt}`; image
bytes, #82 — nothing deletes them yet, D4).

**Per-person settings** (#181, the Settings dialog, `src/features/settings/settings.js`), all
localStorage, none in the document: `splitpage-theme` (`light`/`dark`,
absent = system; sets `data-theme` on `<html>` and, in the desktop app,
`nativeTheme.themeSource` through `splitpage:set-theme`), `splitpage-clock`
(`12`/`24`, absent = system; `formatClock()` in `shared/clock.js` is the one
clock formatter, #180), `splitpage-person-color` (#194),
`splitpage-default-wpm` (the reading speed a NEW script starts at),
`splitpage-video-thumbs` (#141: `"0"` = don't fetch a pasted YouTube or
Vimeo link's thumbnail; absent = fetch, the default — `preferences().videoThumbs()`),
`splitpage-rundown-min` and `splitpage-script-scale` (other lanes' own
controls; Settings only reads and writes them), plus the keys that already
had homes (`splitpage-hide-shot`, `splitpage-autosave`,
`splitpage-writer-size`, `splitpage-prompter-mirror`/`-flip`/`-scene-mode`,
`splitpage-comment-author`). The keys are private to the preferences owner
(`src/application/preferences/preferences.ts`); every announced write
stores the value and then fires `document`'s
`"splitpage:pref"` CustomEvent (`{detail: {key, value}}`); whatever draws a
setting listens for its key, so a change made anywhere shows everywhere.
File ▸ Export app data carries them (`settingsAppData()`).

---

## 5. Invariants — break these and data goes quietly wrong

The rules live in [docs/architecture/invariants.md](architecture/invariants.md): 62 entries, `INV-01` to `INV-62`, each with the behaviour it protects, its tests and its owner. Older notes that cite "invariant #N" mean `INV-N` there. Read it before touching saving, merging, history, undo or the document format.

---

## 6. Map of the source

`src/js/` is gone: every numbered module moved into the owned folders below
or was removed with the server and collaboration features. The old module
map is in git history (`git show 84282e24:HANDOFF.md`). For a feature,
`node tools/code-map.mjs` prints its files, wiring,
shared ports, actions and tests; [AGENTS.md](../AGENTS.md) has the layer rules.

| Folder | What is in it |
| --- | --- |
| `src/bootstrap/main.ts` | the composition root and build entry: calls `wireLegacyApp` (`src/bootstrap/wiring.ts`), then mounts owners and features in a fixed order (`tests/bootstrap/composition-root.test.ts`) |
| `src/bootstrap/` | `app.ts` (start and stop), `actions.ts` (the one ordered action list), `native-menu.ts` (the desktop menu's runner), `startup/` (page entry, the initial document, DOM ready, page lifetime) |
| `src/bootstrap/wiring/` | one module per feature or owner: builds its ports from the real owners and mounts it; the `*-owner(s).ts` modules hold the app's single owners (session, location, preferences, saves, recovery, editor) |
| `src/bootstrap/wiring/ports/` | shared ports, one module per responsibility (document, editing, effects, files, saving, screen, text, transitions…) |
| `src/features/<name>/` | one part of the screen each (rows, writer, prompter, tags, broll, file-menu, find, gallery, comments, history, settings, title…); `features/common/` holds stateless DOM helpers |
| `src/application/session/` | the document session (`document-session.ts`), change sets, merge (`apply-merge.ts`, `merge-incoming.ts`, `session-merge.js`) |
| `src/application/commands/` | document edits as session commands: cell text, split and join, clipboard, scene length and status, rows, comments, b-roll and production records |
| `src/application/editing/` | cell editing, the selection, focus memory, the paint guard, row drag, delete confirmation, and the undo stack (`undo/`) |
| `src/application/save/` | the save coordinator, autosave, file saving and import write-back (deprecated, switched off 2026-10-30), save completion, export capture, the status selector |
| `src/application/recovery/` | crash-safe drafts (`drafts.ts`), the capture schedule, draft restore and resume, the history owner (`history.ts`) |
| `src/application/transitions/` | bringing a document in: new, open, import, restore (`transitions.ts`, `local-files.ts`) |
| `src/application/` (other) | preferences, document location and identity (with the document guard), production index and b-roll records, media and picture store, files and recents, export registry and services, screen and screen state, actions, shortcuts |
| `src/adapters/` | `richtext/` (HTML in and out of cells), `formats/` (DOCX, PDF, CSV/XLSX, Markdown, the `.splitpage` file), `storage/` (blobs, gallery, history IndexedDB, desktop drafts), `files/`, `desktop/`, `page/`, `identity/`, `production/` |
| `src/core/` | pure rules: `document/`, `text/` (runs, marks, steps, anchors), `merge/`, `production/`, `migrate.ts` |
| `src/starters/` | the starter scripts and the 30-scene long demo |
| `src/styles/` | `base.css`, `layout.css`, `components.css` and the `overrides*.css` files that must follow specific feature styles |

**Desktop files** (optional; the web app runs without them):

| File | What is in it |
| --- | --- |
| `desktop/main.js` | Electron main: scheme handlers, window and tab creation, route-open dedupe, startup, the history store (`shared/history-store.js` over `history-fs-backend.js`), draft headers, native menus, updates, test mode. The pieces below were split out of it; [desktop-build.md](architecture/desktop-build.md) says what each holds |
| `desktop/desktop-state.js`, `file-service.js`, `doc-claims.js`, `recents.js`, `tab-registry.js`, `window-appearance.js`, `restore-notice.js`, `unsaved-dialog.js`, `update-release.js` | the state file (windows, tabs, recents), opaque file ids, the atomic write and its stamp, doc-id claims across tabs, the recent documents list, the tab and window maps, theme and window colours, the after-restore notice, the unsaved-changes question's wording, which release an update offers |
| `desktop/close-quit.js`, `session-restore.js` | closing a tab or window, quit and Windows session end: the unsaved-changes question, the kept-copy wait, draft settlement, the session-write freeze and the quit-to-install; restoring the last session at launch and reopening a window on macOS activation |
| `desktop/ipc-setup.js`, `ipc-files.js`, `ipc-shell.js`, `ipc-document.js`, `ipc-history-blob.js`, `ipc-tabstrip.js`, `ipc-test-mode.js` | how an IPC channel is registered (the wrappers, the sender and argument checks, `registerIpc` and the order of the handler groups); the file, file dialog and recents channels; the tab boot, theme, video file, update, teleprompter browser and Follow My Voice channels; the document state, route-open and crash-draft channels; the version history and image blob channels; the tab strip's channels; the `__test` channels, registered only in test mode |
| `desktop/preload.js` | preload for `splitpage://app`: origin-gated `window.splitpageDesktop` bridge |
| `desktop/ipc-channels.js` | the IPC channel table (IPC-TABLE): every channel's name, direction, argument schema and allowed origins, and the one validator main runs on every inbound message; the preloads get their slice over `splitpage:ipc-table-sync`. Version history is six channels (§3.13) |
| `desktop/tabstrip-preload.js` | preload for `splitpage://tabstrip` only — no file/draft/history methods (#43) |
| `desktop/tabstrip/` | title-bar tab strip: `tabstrip.css`/`.js`/`index.html`, served only under `TABSTRIP_ALLOWLIST` |
| `desktop/voice-helper.js` | Follow My Voice's listener process (#8): runs `desktop/voice/listen.ps1` with Windows' `powershell.exe`, rebuilds each JSON line it prints, one session at a time (#45–#47) |
| `desktop/drafts.js` | crash-safe draft store, plain CommonJS, no Electron dependency (§3.13, #40–#41) |
| `shared/history-store.js` | THE version-history store (#83), pure CommonJS run by the browser (03a, over 03c's IndexedDB or the memory backend) and desktop main (over `desktop/history-fs-backend.js`): put-if-absent, the stamp, the trim to 50, the cap, the quota retry, Older, holds, which bodies may go; also `createMemoryHistoryBackend` |
| `shared/history-policy.js` | the history rules both stores share: `sanitizeHistoryMeta`, `planHistoryEviction`, `historyStampAfter`, the Older key/TTL and its one expiry predicate, `historyUtf8Length` |
| `shared/blob-policy.js` | pure CommonJS shared by the page, `desktop/main.js` and the unit tests (#82): `normalizeImageRef` (the record gate), `refsIn(state)` (every sha a state names), `sniffImageMime`/`imageDims` (PNG/JPEG/GIF/WebP by magic, never SVG). `server/server.js` keeps its own copy of the walker and sniffer — change both |
| `shared/video-embed.js` | pure CommonJS shared by the page, `desktop/main.js` and the unit tests (#141, #168): which links are a YouTube or Vimeo video (`parseVideoLink`), the player's address (`playerUrl`; `PLAYER_ORIGINS` is build.mjs's `frame-src`), the desktop IPC's `videoRef`/`parseVideoRef`, and `fetchVideoThumbnail` over a fetch it is handed — fixed hosts, no redirects/cookies/referrer, JPEG/PNG/WebP ≤ 1 MiB. Staged into the desktop build by `stage.mjs` |
| `desktop/blob-store.js` | content-addressed blob folder (`<userData>/blobs`, images since #82), plain CommonJS, no Electron dependency; also the IPC door's image rule (§3.13) |
| `desktop/history-fs-backend.js` | version history on disk (#83, §3.13): `<userData>/history` index in two durable generations + content-addressed bodies, the backend `shared/history-store.js` runs over in main; plain CommonJS, no Electron dependency; a raw v1 `docs/`/`older/` is left dormant (#100) |
| `desktop/electron-arch.mjs` | pure architecture selection and the `fetch-electron` entry point; passes the selected architecture to Electron's installer (§2) |
| `desktop/electron-arch.test.mjs` | pure architecture and override tests, including Windows ARM64 under x64 Node emulation |
| `desktop/electron-builder.yml` | packaging config, x64 + ARM64 Windows |
| `desktop/build/installer.nsh` | NSIS include: "Splitpage (shared session)" Start Menu shortcut (`--host --pin`); 1.0.x removal (`customInit`); the running-app check (`customCheckAppRunning`), which never force-kills while the app has a visible window, so a save prompt is waited for, not killed (#198) |
| `desktop/stage.mjs` | build step: runs `build.mjs`, verifies version, stages files for packaging |
| `desktop/verify-dist.mjs` | post-`dist:win` check: PE machine field per binary, NSIS stub arch, installer freshness, installer payload actually extracts (#6) |
| `desktop/verify-dist-payload.mjs` | verify-dist.mjs's payload-extraction half: pulls the app package back out of a built setup.exe with 7z.exe + 7za and diffs its top-level PE files against the unpacked dir (#6) |
| `desktop/test/smoke.mjs` | integration suite over CDP (§3.13) |
| `desktop/test/drafts.test.mjs` | unit suite for `desktop/drafts.js` alone |
| `desktop/test/blob-store.test.mjs` | unit suite for `desktop/blob-store.js` alone (atomic put, hash checks, damaged-file delete, temp sweep, the image rule) |
| `desktop/test/history-fs-backend.test.mjs` | unit suite for `desktop/history-fs-backend.js` (two-generation write, torn index → prev, deferred unlink, kills via test hooks, a raw v1 tree left untouched) |
| `desktop/test/verify-dist-payload.test.mjs` | unit suite for verify-dist-payload.mjs's comparison logic, no 7-Zip or real build needed (#6) |
| `.claude/skills/run-splitpage-app/driver.ps1` | the test driver: static server + headless Edge over CDP, Windows only (§2) |
| `.claude/skills/run-splitpage-app/driver.mjs` | the same driver in Node, for the cloud container — same suites, same output (§2) |

Other source: `src/page.html` (shell), `src/styles/` (visual),
`src/seed-state.json` (demo document). `docs/help.md` is a build input too —
`build.mjs`'s `mdToHtml()` renders it into the Help modal at build time. It
was `README.md` until #80, with developer-only sections fenced off by
`<!-- help:skip-start/end -->` markers; splitting the user guide out into its
own file retired the markers, and means editing the repo's README no longer
rebuilds the app. An HTML comment left loose in `docs/help.md` now renders as
visible text on the Help page — keep any inside a fenced code block.

**Choosing a File menu item:** one click listener on `#file-menu`
(`mountFileMenu` in `src/features/file-menu/mount.ts`, wired by `src/bootstrap/wiring/views.ts`) hands an enabled item's id to `handleFileMenuAction()`
(`src/features/file-menu/local-files.js`), which runs the `onFileMenuChoice()` listeners, closes
the menu, remembers an export and invokes the action from the registry
(`docs/architecture/actions.md`). Help, Tour and Set up are actions
like the rest; the capture-phase listeners `20c-help.js`, `20e-connect.js`
and `20b-onboarding.js` once added are gone. The setup wizard registers with
`onFileMenuChoice()` and closes on *every* choice before the action is asked
whether it can run, keeping only one full-screen modal open at a time
(invariant #19); so a File menu command from the desktop app's native menu
closes the wizard and runs where its shortcut is refused under the wizard,
as in 3.1. The wizard's own Escape/Tab handling listens in the bubble phase
instead, since it can sit open, unnoticed, during an unrelated test.

Since #145 the menu is a dropdown (`src/features/file-menu/file-menu.js`), but every item is
still one `<button data-file-action>` inside `#file-menu`, exactly once. The
desktop native menu no longer clicks them: `runDesktopMenuCommand` hands the
command to `nativeMenuRunner()` (`src/bootstrap/native-menu.ts`), which runs a
File menu item's action through `handleFileMenuAction(id, "native-menu")`,
reading no rendered state; only a command it does not know (an export
format) still clicks its item. What an item's
state is lives on the button (`hidden`, `disabled`, the `.mi-why` second line
through `setMenuItemReason`), and a label is rewritten through
`setMenuItemLabel`, never the button's `textContent`, which would take its
icon with it. Items that are not actions (the Open recent / Import submenu
parents) carry `data-submenu` instead, so no listener mistakes them for one.

### Merging main into a branch that has `src/`

Main still edits `index.html` directly. Split main's `index.html` on the
same boundaries `src/` was cut on; prove the splitter reproduces this
branch's `src/` byte-for-byte from the merge base first; cut main's JS into
the same pieces by matching each base piece's first line as a unique
anchor; `git merge-file` each piece against its base; normalise trailing
newlines first; rebuild and read every **removal** in the diff against
main's `index.html` — a removal you can't name is main's work being dropped.

Since #66 the bundled `index.html` is minified, so this recipe no longer
applies to anything built from this branch: the two sides are no longer the
same shape of text. Re-derive it if it is ever needed again.

---

## 7. Where to pick up

**Bugs and features live in GitHub Issues** —
https://github.com/RetroGorilla/splitpage/issues. That is the tracker: open
one before starting work, close it with the commit that fixes it
(`Fixes #12` in the message), and don't keep a second list in a Markdown
file. Labels: `bug` / `enhancement` for the kind, `area:*` (editor,
desktop, installer, server, export, ui) for where it lives,
`needs-decision` for anything waiting on Adam, `blocked` for work that
can't start yet. Issue forms are in `.github/ISSUE_TEMPLATE/`.

Follow My Voice on desktop (#8) runs Windows' own recogniser (System.Speech, offline) through
`desktop/voice/listen.ps1`, driven by `desktop/voice-helper.js`, which
`desktop/voice-composition.js` creates and routes (invariants #45–#47); it has never heard a real voice from an agent
session — the by-hand check is in `docs/WINDOWS-CHECKS.md` §3.

**The header after Direction B (#169).** The row no longer overlaps
itself at any width (#174): its right column is never narrower than its
buttons (`minmax(max-content, 1fr)`), and "the header's widths" in
the stylesheets in `src/styles/` drop what they can as the window narrows — Search to its word
and then its magnifier (#175), the panel toggles to icon + count below
1300, the File button to its mark below 1180, Write to its
icon below 1000, the save status to a dot below 880 — each label staying
the button's name and tooltip. Since PR #233 the panel toggles' and
Write's labels close and open as an animation on the motion tokens
rather than leaving the layout in one frame, and a closed toggle
opens its name on hover (not touch) or keyboard focus over its
neighbours: a negative margin equal to the growth keeps every layout slot
still, the open button is `pointer-events: none` but for a `::before` over
its closed box so the neighbours it covers stay reachable, and the pill is
carried to a neighbour's edge (`--label-x`). Keep the margin, the label's
max-width, the padding and the `::before` edge on one duration, curve and
delay, or the row shivers while it opens. The mark and name are the File button (#166,
still `#btn-file`); the mark is ONE symbol, `#i-mark` in the sprite, which
the header and the New Tab page both `<use>` — a new logo changes that
symbol and nothing else. The title gives way before the facts and your
name never does (#183). `#root` spans the window and only the script is
held to 1800px (#190); the rundown strip runs the window's width, less an
open panel (#189), below 1100px too. One slim scroll-bar style app-wide,
and the page's own bar hidden while a panel is open (#187, #188), its
width handed back (`--page-gutter`, `src/features/panels/script-place.ts`) so nothing steps
sideways; a panel opening or closing keeps the scene at the top of the
view put (`holdScriptPlace`, as the script zoom does). `.claude/skills/run-splitpage-app/tests/85-header-fit.txt`
measures all of it by resizing an iframe; 250–251 the rest.

**#83's temporary migration code is gone (#100, after 3.0.0).** Both
migrators, their faults and tests are deleted; desktop main deletes
`history/v1-backup/` at launch, and IndexedDB v3 drops the v1 stores. One
deliberate difference from the issue's plan: history that was never
migrated (a user who skipped 3.0.0) is kept dormant, not deleted — the
desktop's raw `docs/`/`older/` and any v1 IndexedDB store with rows. It
isn't shown; installing 3.0.0 first is the way to carry it over. A
recovery tool, if ever wanted, finds it by `docs/`/`older/` with no
`migratedFrom` in `index.json`, or by v1 stores surviving in v3.

**Decided and changed (issue #7):** opening a `.docx`/`.md`/`.txt`/`.csv`
starts a **new document** — `loadFileIntoEditor` (`src/application/transitions/local-files.ts`)
now builds a fresh state through `migrateRows()`, so the document gets a new
`docId` and empty `productionTags`, `people`, `brollShots` and `comments`,
and its home becomes the imported file (`setHome("import")`,
`src/application/location/document-location.ts`), which replaces either Save target. It used to replace only `state.rows` and the title and keep the rest, which meant an
unrelated Word file inherited the last script's breakdown, cast list and
review comments, and Save still pointed at the previous project's file.

**Deprecated: import save-back (Adam, 2026-10-30).** An import now opens
with no home at all (`NO_DESTINATION`), like a new untitled script, and
Splitpage never writes to the imported file: the File menu's and the
desktop menu's Save to file and the conflict dialog's import overwrite are
gone, so nothing calls `saveBackToFile`. The save-back owner, its save
kinds and the `import` home kind stay in the code, unused; see
[saving.md, Deprecated: import save-back](architecture/saving.md#deprecated-import-save-back).

"Draft 2 of the same script" — the workflow that behaviour was useful for —
is the **Paste/Import modal** (`openImportModal`, `src/features/imports/imports.js`),
which is unchanged in what it keeps and now takes a picked `.docx`/`.md`/
`.txt`/`.csv` as well as pasted text. A `.docx` or `.csv` picked there
bypasses the textarea (`pendingFileRows`) so its columns and formatting
survive.

The one caller that is NOT an open keeps the document: `reloadFileFromDisk()`
passes `{reload: true}`, because re-reading the same `.docx` after it changed
under us is the same document with newer bytes.

**Recent documents (issue #15), contract DESKTOP-RECENTS.** Desktop only.
`recents: [{absPath, title, at}]` sits beside `windows` in
`desktop-state.json`, most recent first, capped at 20 and de-duplicated by
path on read. The list held by `createRecents` in `desktop/recents.js` is the
authority once the process is up (`recents.load()` at `whenReady`, and
`shellStateAsV2()` carries it into every session write, because that object
REPLACES the file). It is recorded on `deliverOpenFile` and refreshed on
every `set-document-state` report of a file tab, and only a real change
writes. Three IPC calls — `recents-list` / `recents-remove` /
`recents-clear` — all app-wide, all answering with the list as it stands
after. The renderer never sees a path (invariant #34): an entry is
`{fileId, name, title, at}`, and the `fileId` is the same opaque key
`routeOpen({kind:'file', fileId})` takes. It is deliberately NOT in the
app-data bundle (§5 #48) and must not be put in a draft header or anything
a shared session can read — it is a record of what someone has been working
on. The recents list itself is in `src/features/newtab/newtab.ts`.

**Server and collaboration features are removed from the app** (Adam's
decision): live collaboration, server connections, documents on a server,
share and review links, review mode, Google Drive and the launcher API. The
standalone HTML export stays a dead copy by design — `standaloneHtmlFor`
still strips `docId`, and nothing in the export connects anywhere. A draft
or session whose home was a server document restores as an unsaved local
copy with all its content.

---

## 8. Working with Adam

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
