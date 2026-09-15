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

- **Edit `src/`, never `index.html`.** The source is `src/page.html` (the HTML
  shell), `src/app.css` (~2,100 lines), `src/seed-state.json` (the demo
  document), and `src/js/` — 22 numbered fragments, `00-prelude.js` through
  `21-events.js`. `node build.mjs` inlines the lot back into `index.html`.
- **The `src/js/` files are fragments of ONE IIFE, not modules.**
  `00-prelude.js` opens the function, `21-events.js` closes it, and they all
  share a single closure — which is why none of them is valid JS on its own
  and why the build concatenates them in filename order. That was deliberate:
  it makes the scoping identical to the single file they were cut out of, with
  no bundler and no dependency. It also means **filename order is load order**,
  so renaming one moves it. (`20a-update.js` sorts between `20-` and `21-`
  precisely so it lands before the `init()` that calls into it.)
- **`index.html` is a build output.** Editing it directly looks like it works
  and is destroyed by the next build. The pre-commit hook refuses a commit
  where `index.html` and `src/` disagree; `node build.mjs --check` is the same
  test on demand.
- **The shipped app has to stay one self-contained file** — this is not a
  packaging preference. A save writes
  `"<!doctype html>" + document.documentElement.outerHTML` with the new
  document spliced into `#state-data` (`buildPublishHtml`, and `PAGE_SHELL` in
  `src/app.js`). If the page linked out to `app.css`/`app.js`, every saved
  `.splitpage.html` would be a shell that only works beside those files. That
  is why there is an inlining build step rather than plain `<script src>`.
- Supporting files: `README.md`, `start.mjs` + `start.bat` / `start.sh` /
  `start.ps1` (local launcher), `manifest.webmanifest`, `icon.svg`, `sw.js`
  (PWA bits), `server/server.js` + `Dockerfile` (hosted mode), and
  `package.mjs` + `installer/` + `tools/fetch-runtime.mjs` (portable zip and
  the Windows setup.exe — neither the IExpress step nor the PowerShell
  installer has ever been run, see §7).
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
| **The app renders nothing and throws no error** | A *pending stylesheet blocks every classic script after it*. On a network that hangs (rather than refuses) `fonts.googleapis.com`, the Google Fonts `<link>` never settles, so `<script id="app-logic">` never runs — the page shows only its static HTML and `document.readyState` sticks at `"loading"`. Seeing the topbar therefore proves NOTHING: it is markup. Assert on `#rows` having children. Fixed in the page (the font link is `media="print"` + `onload`), but the same trap applies to any blocking resource you add. |
| Focus jumps mid-batch | Editing `index.html` fires a hook that opens a stray `file://` preview tab. Close it, re-select the localhost tab. |

**Permanently present, always harmless console errors:** `"An unknown error
occurred when fetching the script"` (service-worker registration in the
sandbox) and blocked `beforeunload` panels. Don't chase these.

**What cannot be tested from an agent sandbox:** microphone capture is blocked,
so **Follow My Voice can never be verified end to end**. Verify its logic
against simulated transcripts and say plainly that live speech is unconfirmed.

### Run the tests first

There is a real regression suite — **998 assertions across 25 suites**
(`tests/01-core.txt` through `tests/26-desktop-drafts.txt`; 16 is retired and
unused), driving headless Edge over CDP. **Rebuild, then run it before and
after any change to `src/`:**

```bash
node build.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/run-tests.ps1
```

The rebuild is not optional. Without it you are testing the previous version
of the app, which looks exactly like a change that did nothing.

**The suite is Windows-only** — PowerShell 5.1 plus `msedge.exe` — so it does
not run in a Linux container, and a session that cannot run it should say so
rather than implying the app was tested. **And it predates several features**:
nothing in it covers the Google Drive file manager, Google Doc import, the
two-column Markdown export, or the update notice and About box. Those have
been exercised by hand and in a headless Chromium, never by the suite.

`ALL PASS - 998/998` and exit 0, or it names every failing assertion and exits
1. `-Only 22` runs one suite, `-Headed` shows you the browser. Full command
reference and the harness's own gotchas are in
`.claude/skills/run-splitpage-app/SKILL.md` — read that before writing a new
test, because most "failures" are the test, not the app.

**Two suite runs can now share the machine.** `run-tests.ps1` mints its own
8-hex `$RunId` and passes it to every `driver.ps1` it spawns; each spawned
Edge profile is named `splitpage-edge-<RunId>-<guid>`, and the orphan-process
sweep (`Clear-SplitpageEdge`, both before and after the suites run) matches
only that prefix. Before this, a second concurrent run's sweep could kill the
first run's live browser mid-suite (`WebSocket … Aborted`) — that failure
mode is gone; two simultaneous `-Only` runs, or a full run alongside one,
no longer interfere.

### Testing the desktop shell

`desktop/test/smoke.mjs` drives a real Electron window over CDP — this is the
only thing that exercises `desktop/main.js`/`preload.js`; the browser suite
above never launches Electron. **Always launch it through this script**
(`launchApp`, which sets `SPLITPAGE_TEST=1` and a temp profile) — never the
app directly. It currently runs **454 checks** across ~55 cases: tab shell
lifecycle, close/quit authority, session restore, doc-id/history and
crash-safe drafts are the bulk of the growth since phase 1. From `desktop/`:

```powershell
$env:PATH = "C:\Users\Adam\Documents\Splitpage\splitpage_local_development\.cache\node-win-x64;" + $env:PATH
node test/smoke.mjs                          # dev + every packaged exe found in dist/
node test/smoke.mjs --only-target dev         # dev only, fastest loop
node test/smoke.mjs --only-target packaged-arm64
node test/smoke.mjs --exe "<path to Splitpage.exe>"
```

**The dev Electron binary is pinned to native ARM64**, not the x64 build
`npm install` fetches by default. `desktop/.npmrc` (`arch=arm64`) makes a
plain `npm install` in `desktop/` fetch the right one from now on; it existed
only as a manual post-install step before 2026-09-15. To redo it by hand (or
to recover if the pin is ever bypassed):

```powershell
cd desktop
Remove-Item -Recurse -Force node_modules\electron\dist
$env:npm_config_arch = "arm64"
$env:npm_config_platform = "win32"
node node_modules\electron\install.js
```

The version stays `^44.3.0` — only the fetched architecture changes. Running
dev tests under x64-emulated Electron still works (Windows emulates it
transparently) but is measurably slower: 7m43s x64-emulated vs 7m25s native
ARM64 for the same 454 checks, so the suite is wait-bound (CDP round trips,
teardown polling), not CPU-bound — the native pin buys a modest, not dramatic,
speedup. **Never run `npm run dist` / `dist:win`** outside a deliberate
release build; it is slow, writes gigabytes to `desktop/dist/`, and is not
part of the day-to-day test loop.

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

### 3.1 The page is the database *at boot*

`<script id="state-data" type="application/json">` holds the **seed**
document — the demo script the app opens on when nothing else has been
loaded. On load, `defaultState()` parses it. `build.mjs` writes it from
`src/seed-state.json`, `tests/01-core.txt` asserts it exists, and
`.githooks/pre-commit` guards it. That is now its whole job.

**Documents live in files, not in copies of the app.** Save writes one of two
formats (§4), both plain text, neither carrying the app with it:

- `.md` — a readable two-column table plus Splitpage's own record of the
  script in a fenced `splitpage` data block. The default.
- `.splitpage` — that record on its own: exactly `migrateRows(state)`,
  pretty-printed, no envelope.

`20d-formats.js` builds and parses both. `openProjectFile()`
(`18-local-files.js`) dispatches on the extension and lands every format in
`adoptProjectState()` — the one place a parsed project becomes *the*
document. `docFileHandle = { handle, kind }` remembers which file and which
format, and `saveDoc()` picks the serializer from `kind`, so Save never has to
guess. A `.md` with no data block is somebody else's Markdown and still goes
through the old lossy import, unchanged.

**`PAGE_SHELL` and `buildPublishHtml()` still exist, for the HTML export
only.** `PAGE_SHELL` is a copy of the pristine served page captured on the
very first line of the app script, before the DOM goes live;
`buildPublishHtml()` splices a document into its `#state-data`. That is what
**Export a copy ▸ Standalone HTML** produces, and it is the only thing that
produces it — Save does not write HTML any more. A legacy `.html` project
still *opens*, and its first Save converts it to `.md` with a toast saying so
(`docFileHandle.kind === "html"` is the flag; nothing sets that kind except
opening such a file).

Never serialise the live DOM to save. `PAGE_SHELL` exists precisely to avoid it.

**Since 2026-08-28 there is a second home for a document: a server.** When the
page is served by `server/server.js`, the state lives in a JSON file on the
server — the same object a `.splitpage` file holds — and Save does an HTTP
compare-and-set rather than a file write. This is strictly additive:
`file://`, plain static hosting and local files all behave exactly as before,
because `detectServer()` probes `/api/health` and everything hosted stays
hidden when that fails. The two homes are mutually exclusive by construction:
opening a server document clears `docFileHandle`, and `adoptProjectState()`
clears `serverDoc`, so Save is never ambiguous about where it writes. See §3.6
and DEPLOY.md.

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

`server/server.js` — plain Node, no dependencies, ~600 lines, deliberately
small enough to audit by reading. One JSON file per document in `DATA_DIR`;
that is the entire database.

- **No *identity*, on purpose.** Cloudflare Access sits in front and decides
  who anybody is. The server only ever *reads*
  `Cf-Access-Authenticated-User-Email`, for display and attribution — never as
  a permission check, because by the time a request arrives Access has already
  made that decision. Do not add real auth here without deciding it belongs
  here.
- **`JOIN_PIN` is a door lock, not identity, and knows it.** Empty (the
  default) and the server behaves exactly as it always did. Set, and every
  `/api/*` route except `/api/health` and `POST /api/join` needs the header
  `x-splitpage-token` carrying the token this process minted at startup. The
  PIN is compared as sha256 digests through `timingSafeEqual` — equal lengths
  by construction, so it can neither throw nor leak how much matched — and
  wrong guesses are capped at ten a minute per address. It exists for the
  launcher's case: a laptop hosting for the people in the room, no TLS, no
  Access. One shared string, the same for everyone, revoked only by restarting.
  **The refusal is JSON `401 {error: "pin-required"}`**, because `apiFetch()`
  reads a non-JSON answer as a lapsed Access session and would stash and
  reload — exactly the wrong move for a code that is one dialog away.
- **CORS is opt-in per origin and never carries credentials.** `ALLOW_ORIGINS`
  is an exact-match allowlist (the literal `null` covers a page opened from
  `file://`). The headers are stamped onto the response object by the request
  handler, so a route added later cannot forget them, and `handleStatic()`
  never gets them. `OPTIONS /api/*` is answered 204 before any route runs: a
  preflight carries no token and must never meet the gate.
- **`/api/launcher/*` is the one route that runs another program**, hedged
  three ways: a launch token minted per launch by `start.mjs` and delivered in
  the URL fragment, `HOST === "127.0.0.1"` (so never under `--host`), and a
  fixed script path with nothing from the request anywhere near a command line.
  Any of those failing is a **404**, not a 401 — under those conditions the
  route genuinely does not exist. Invariant #28.
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

- **The same words can be tracked in two categories at once.** `registryKey()`
  keeps a "kitchen" prop and a "kitchen" location apart on purpose, but the
  untagged index is keyed on the name alone — plain text cannot say which was
  meant. `buildUntaggedIndex()` breaks the tie with `tagCompletionBeats()`,
  the same rule the Tab-completion ghost already uses (most mentions, then
  shortest, then alphabetical), and the prompt names the category so
  accepting it is never a surprise. It used to just keep whichever came
  first out of `productionEntries()`.
- **One highlight for all categories, not one per category.** Per-category
  colour would mean a *second* place a new `TAG_CATEGORIES` entry has to be
  registered in CSS (invariant 14 exists because that was already missed
  once). The prompt names the category in words instead.
- **One alternation regex for the whole registry**, longest name first so
  "gaffer tape" beats a "tape" entry inside it. Scanning each cell once per
  entry instead is fifty passes over the document on a fifty-item breakdown.
- **The word boundaries live INSIDE the pattern**, as
  `(?<![\p{L}\p{N}])(…)(?![\p{L}\p{N}])`, and that is not a detail. Two bugs
  came from testing the neighbours *after* the match: rejecting a match
  cannot un-consume it, so with names sorted longest-first the "gaffer" entry
  hiding inside a rejected "gaffer tape" was never seen at all; and the ASCII
  class `[A-Za-z0-9]` treats an accented letter as a word break, so a cast
  member "Ana" matched inside "Anaïs" and Tab wrapped half of somebody's name
  in an atomic tag. Lookarounds make the engine backtrack to the shorter
  alternative at the same position, and `\p{L}` knows what a letter is. The
  construction is wrapped in try/catch with the old pattern as a fallback
  (`boundedInPattern` says which one you got) — an engine without lookbehind
  or `\p{…}` throws at `new RegExp`, which would otherwise take the whole
  feature down.
- **`render()` invalidates every stored Range**, so it schedules a re-scan.
  Debounced — nothing is wrong in the meantime beyond a missing underline.
- **The offer re-checks its own Range before taking it.** A `Range` is live:
  type a character into the middle of the phrase it covers and it silently
  grows to include it, while the rescan that would notice is 220ms behind.
  In that window `execCommand` would replace what the range covers *now*
  ("gafXfer tape") with the phrase the offer remembered ("gaffer tape") — and
  eat the character the writer just typed. `String(s.range) !== s.text` is
  the guard; `07-untagged.txt` types into the middle of a phrase and takes
  the offer immediately, then asserts the character survived.
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
  brand-new row spliced in after it, with an empty visual. The extraction
  itself now lives in `splitRowFieldCore()` (§3.10) — `splitWriterRow()` is a
  thin wrapper that adds the writer's own render/refocus.
- **`mergeWriterRows()`** — Backspace at the very start (Delete at the very
  end). Joins the audio, then deletes the row. It **refuses** when both rows
  have a visual, because one of the two shot descriptions would have to be
  destroyed and a single keystroke must not do that silently. **Status
  accumulates** rather than being picked between — the same rank rule
  `mergeStates()` uses, for the same reason: a join must never un-shoot
  footage somebody filmed. It used to carry the visual up and leave the green
  dot behind with the row it deleted.
- **`caretAtEdge()` must not count empty inline wrappers.**
  `Range.cloneContents()` emits a shallow, empty clone of every
  partially-contained ancestor, so `querySelector("*")` saw `<strong></strong>`
  and read "there is content before me" for a caret at the start of a bold
  word. Backspace then refused to join — and because each paragraph is its own
  editing host, the browser's own Backspace cannot cross it either, so the key
  did *nothing at all* on any scene beginning with formatting. The test proves
  it by reverting the fix.

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

---

### 3.10 Splitting a field is shared between the writer and the split view

Alt+Enter in `#rows` does what the writer's plain Enter always did: split the
field being edited, at the caret, into a new row directly below. **Only the
field you were in moves.** The row's other column — whichever one you weren't
writing in — is left completely alone, still whole, still on the original
row; the new row gets an empty value for it, not a copy. That's what makes
"Alt+Enter on Audio leaves Visual untouched, and Alt+Enter on Visual leaves
Audio untouched" true in both directions, and it falls straight out of
`splitRowFieldCore()` only ever writing to `state.rows[idx][field]` — never to
the other field, on either row.

- **`splitRowFieldCore(cellEl)`** is the shared core, reading `field` off
  `cellEl`'s own `data-field` rather than assuming `audioText`. Returns
  `{idx, created, field}` or `null`. Two thin callers each add their own
  render/refocus: `splitWriterRow()` (writer — `renderWriter()` +
  `focusWriterBlock()`) and `splitCellField()` (split view — `render()` +
  `focusRowField()`, which reuses the writer's `placeCaretAtTextOffset()`).
  Change the splitting logic once here, not in two places that can drift.
- **Alt+Enter never reaches `onRootKeydown` inside the writer.** The writer's
  own capture-phase handler (`onWriterKeydown`) treats *every* Enter —
  Shift excepted — as a split and calls `stopPropagation()` before the
  bubble-phase `onRootKeydown` (where the split-view branch lives) ever sees
  the event. The two branches never compete; each only ever runs in its own
  view.

**Keeping the caret in view through a large edit.** The browser follows the
caret on its own for ordinary typing; it does not reliably follow a big
paste or a big delete, and losing the scene you were just in is exactly how
that gets confusing. `keepCaretInView(cellEl)`, called from `onRootInput`
gated on `isScriptCell()`, is a near-always-no-op check: if the caret's own
`Range.getBoundingClientRect()` is already within a 32px margin of the
viewport, it does nothing, so ordinary typing never fights the browser's own
scroll-follow.

The one real trap in it: **scroll to the CARET, not to the CELL.**
`cellEl.scrollIntoView({block: "center"})` was the first attempt, and it is
wrong the moment the cell is taller than the viewport — which is exactly the
"large paste" case this exists for. `scrollIntoView` on an element centres
*the element*, not wherever inside it the caret happens to be; on a cell
several viewport-heights tall, that can leave the caret exactly as far out of
view as it started (verified by reproducing it: a caret near one end of a
70-line cell stayed off-screen after the "fix"). The actual fix computes the
caret's own midpoint from its rect and scrolls the nearest scrolling
ancestor — walked via `nearestScrollAncestor()` rather than hard-coded to
`window`, since a cell in `#rows` scrolls the document but a paragraph in
`#writer-doc` scrolls `.writer-scroll` instead.

### 3.11 A comment card is its own "jump to text" control

`.comment-card.is-jumpable` — the whole card, not a button on it. `onRootClick`
resolves the click to `jumpToAnchor()` unless it landed on `.reply-composer`,
an `<a>`, or (checked first, since every specific action branch above it
already returns) one of the card's own buttons. **`window.getSelection()
.isCollapsed` gates it too** — finishing a drag-select of the quote or the
body to copy it must never also fire a jump, and a `click` event fires
whether or not the mousedown/mouseup that produced it also dragged out a
selection.

`jumpToAnchor()` no longer calls `closeCommentsPanel()`. It never needed to on
anything wider than 1100px — `body.panel-open #root { padding-right: 420px }`
already keeps the panel from covering the script there — and closing the one
thing you're trying to look at *next to* the other defeats the point of
jumping in the first place.

**Sort mode.** `commentPositionCompare()` (row index, then Visual-before-Audio,
then post time) is the shared comparator: `commentEntries()` — the export
appendix — always uses it, regardless of how the panel is currently sorted, so
a file's own appendix reads the same way twice. The panel itself defaults to
the same order but can switch to `commentLastActivity()` — a comment's own
`createdAt`, or a reply's if later — descending. **Replies count on purpose**:
a thread someone just answered is exactly as "active" as a brand-new comment,
and sorting by the comment's own post time alone would leave a just-replied
thread buried wherever it started. The mode itself is a reader preference
(`splitpage-comments-sort` in `localStorage`), not part of the document — same
reasoning as the writer's text size.

---

### 3.12 Gear is a category, and its panel is not a second copy of anything

`{ id: "gear", label: "Gear", plural: "Gear", color: "#A67C1F" }` in
`TAG_CATEGORIES`, `{ open: "<", close: ">", cat: "gear" }` in `TAG_SHORTCUTS`,
a matching `.tag-anchor[data-tag-cat="gear"]` CSS rule (invariant 14 — this is
the entry that would have silently rendered green without it). That is the
*whole* addition on the tagging side — `renderTagCategories()`,
`tagsByCategory()`, every export, the Tab-completion ghost, all already
iterate `TAG_CATEGORIES` generically and picked Gear up for nothing.

**`#gear-panel` is a fourth `SIDE_PANEL_IDS` entry, not a fourth code path.**
Its cards are `tagEntityHtml()` — the exact same template `#production-list`
renders — filtered to `cat.id === "gear"` by `gearEntries()`. Status cycle,
expand, rename, remove/delete, owner assignment, notes: none of it is
reimplemented. What makes that possible:

- **`wireTagEntityContainer(id)`** is `#production-panel`'s event wiring
  (click → `onRootClick`, the rename/person-input Enter/Escape, the owner
  `<select>`, the notes textarea) pulled out so `#gear-panel` gets the exact
  same wiring by calling it a second time. Bulk selection and its bar stay
  production-panel-only, layered on as extra listeners on the same element
  rather than folded into the shared function — the gear panel has nothing to
  select in bulk.
- **`renderProduction()` is now a two-line dispatcher**: `renderProductionPanel()`
  (the old body, renamed) then `renderGearList()`. Every one of the ~35
  existing call sites — a status change, a rename, typing a tag — refreshes
  both panels for free, the same way `updateFileChip()` covers the header's
  chip and the writer's from one call. The alternative (finding and pairing
  every call site by hand) was rejected on sight: that is exactly the kind of
  edit some future call site is going to be added without, and the two panels
  would start silently drifting.
- **`updateTagBadges()`** is the same pattern one level down, for the
  DEBOUNCED path (`scheduleProductionRefresh`) and the handful of one-shot tag
  creations (`maybeAutoTagShortcut`, `acceptTagGhost`,
  `acceptUntaggedMention` ×2) that want the header badge to move *instantly*
  rather than wait out the 180ms debounce.

**Quick-add reconciles, it does not just append.** `applyGearQuickAdd()`
diffs the textarea (one name per line) against `gearEntries()`: a new line
calls `registerProductionTag("gear", name)` — the exact same call
`acceptUntaggedMention()` makes, so an item typed here with zero script
mentions is simply an *orphaned* registry entry from the moment it's created,
nothing new in the data model. A line taken back out calls
`deleteProductionTagEntry()`, **but only if the item is currently orphaned.**
An item that's still tagged live in the script is left alone even if its line
is removed from the box — deleting it would be pointless anyway, since
`productionEntries()`'s self-heal path (§3.4) would just re-add it from the
live scan on the very next render. The box only ever forgets what it alone
was responsible for remembering.

**Packing lists (`buildPackingListPdf(catId)`) are a second, smaller PDF
writer, not a call into `buildPdf()` with different content.** One font pair,
no images, one column — a checklist, not the six-column breakdown trying to
be one. Sharing `buildPdf()`'s page-building closures would need extracting
them into something both can drive, which is real surgery on a working,
tested export for a feature that's supposed to be simple; duplicating the
~30 lines of PDF object/xref plumbing was the cheaper, safer trade. Wired to
two categories today (`export-packing-gear`, `export-packing-prop`, both
just `"packing-" + catId` through `buildFileData`) but the function itself
takes any category id — extending it to a third is one File-menu button, not
new plumbing.

**A harness gotcha, not an app bug, cost real time here:** renaming a *live*
tag through a panel that was opened with `jsclick` right after typing looked
exactly like `renameTag()` corrupting the registry — the old name stayed
live, a phantom orphaned entry appeared under the new one. It reproduces with
`jsclick` and not with a real `click`. `jsclick` never moves
`document.activeElement`, so the script cell stays "focused" through
everything that follows; `render()` rebuilding `#rows` then detaches that
still-focused, now-stale node, and the browser's own blur/focusout on a
*detached* element fires with its stale content, which `onRootFocusOut`
dutifully syncs back over the correct rename. Full writeup and the fix (blur
before `jsclick`) are in SKILL.md's gotchas — read that before trusting a
"the registry is corrupted" symptom again.

---

### 3.13 The desktop shell

`desktop/main.js` + `desktop/preload.js` turn the web app into a native Windows
application (Electron 44 + electron-builder 26). The shell is optional: the app
still runs in a browser exactly as before. The browser suite drives headless
Edge; `desktop/test/smoke.mjs` is what drives the real desktop window.

As of the 2026-09-14 tabs build, the shell manages **multiple windows, each
with multiple tabs**, not one window with one document. What follows describes
that shape; §3.13 in earlier handoffs described a single-window, single-tab
predecessor and is superseded.

**Why a custom scheme.** The page loads from `splitpage://app` instead of
`http://localhost:<port>/`. This makes the document's origin stable:
`localStorage`, `IndexedDB`, and `FileSystemFileHandle` are all keyed by
origin, and if that origin changed every time a port assignment changed
(another instance running, a busy port, a user's `--port` flag), version
history and resumed file handles would vanish between launches.
`splitpage://app` never changes, so they survive regardless of what the
server is doing underneath. **Tabs add a second privileged origin**,
`splitpage://tabstrip`, for the title-bar strip — see below.

**The bridge contract.** `desktop/preload.js` exposes `window.splitpageDesktop`
to the page (contextIsolation, sandbox, no nodeIntegration). The preload only
defines it when `location.origin === "splitpage://app"`, and every `ipcMain`
handler checks again that the sender frame's URL starts with `splitpage://app/`
(`isTrustedSender`, `main.js:4004`). Two locks, because a `--tunnel` window
shows another machine's server content at `http://localhost:<port>/` in the
same window, and that content must never reach the file system; tunnel pages
also get no auto-granted permissions (clipboard, microphone). The renderer
never sends file paths to the main process (invariant #34): `main.js` keeps an
id → absolute path registry, holding only paths the user picked in a native
dialog, the OS handed over at launch, or persisted from the last session.
Writes are atomic (temp file in the same folder, then rename; the temp file is
removed if the rename fails), and `lastModified` is `Math.floor(mtimeMs)` so
the on-disk conflict guard's `!==` matches what a browser `File` reports.
`src/js/20f-desktop.js` wraps the bridge in a `FileSystemFileHandle`-shaped
object so `openProjectFile/saveDoc/deliverFile` run unchanged; every desktop
branch is gated on `DESKTOP` (from 00-prelude.js) and falls through to
unchanged browser code when it is null.

**Windows and tabs are two registries, not one.** Every `BrowserWindow` is
created by `createTabWindow(restoreSpec)` (`main.js:2528`) — hidden
title bar with a `titleBarOverlay` (`TITLEBAR_H = 36`, cross-referenced in
`tabstrip.css`), `autoHideMenuBar`, `skipTaskbar: TEST_MODE`, and a *primary*
`webContents` that loads `splitpage://tabstrip/index.html` — the title-bar
strip, not a document. Each tab is a `WebContentsView` created by
`createTab(windowId, opts)` (`main.js:2868`) loading
`splitpage://app/index.html?tab=<tabId>` with its own `preload.js`; the
active tab's view is positioned at `{0, TITLEBAR_H, w, h−TITLEBAR_H}` and
made visible, every other tab in that window is `setVisible(false)`. A
`tabId`/`windowId` is 32 lowercase hex from `crypto.randomBytes(16)`,
validated with `/^[0-9a-f]{32}$/` everywhere it crosses a trust boundary
(invariant #42). It never changes for the tab's life — it survives tear-off
because the `WebContentsView` itself moves to a different window rather than
being recreated, and it survives relaunch because `desktop-state.json` v2
persists it — and it is also the crash-draft folder name (§4). `TabRecord`
carries `{id, windowId, view, webContentsId, source, fileId, title, dirty,
pristine, docId, serverKey, launchIntent, ready, pendingPayload,
reloadTimes}`; lookup indices (`webContentsIdToTabId`, `pathToTabId` keyed by
`path.resolve()` and lowercased on win32, `serverDocIdToTabId`) are what let
main answer "is this already open?" without asking any renderer.

**The tab strip runs on its own origin, `splitpage://tabstrip`, with its own
preload and its own allowlist** (invariant #43). `desktop/tabstrip-preload.js`
only runs — and only calls `exposeInMainWorld('splitpageTabStrip', …)` —
when `location.origin === 'splitpage://tabstrip'`, and it never exposes a
file, draft or history method: its bridge is `windowId`, `platform`,
`getShellState()`, `onShellStateChanged(cb)`, and `newTab`/`activateTab`/
`closeTab`/`reorderTab`/`moveTabHere`/`tearOffToNewWindow`, each an IPC send
checked in main by `isTrustedTabStripSender` (`main.js:4018` — sender frame
URL starts `splitpage://tabstrip/` *and* the sender is a known window's own
`webContents`). `TABSTRIP_ROOT` (`main.js:318`) resolves to
`<APP_ROOT>/tabstrip` when packaged or `desktop/tabstrip/` in dev, and
`TABSTRIP_ALLOWLIST` restricts the custom-scheme handler for that origin to
exactly `/index.html`, `/tabstrip.js`, `/tabstrip.css` — no traversal, nothing
else servable. `ShellState` (`{windowId, activeTabId, tabs:[{tabId, title,
dirty, crashed, isServerDoc, pristine, fullPathForTooltip}]}`) is what
`desktop/tabstrip/tabstrip.js` renders; `crashed` is a tab whose renderer
died and was not reloaded (past the crash-loop budget below, or its window
already going) — such a tab closes with **no** prompt, so its `dirty` bit is
reported false regardless of what the page last said. Drag-and-drop between
strips uses `dataTransfer` type `application/x-splitpage-tab` carrying
`{tabId, sourceWindowId}` JSON; a drop on another window's strip calls
`moveTabHere` (re-parents the view via `contentView.removeChildView`/
`addChildView`, **no reload** — invariant #42's "undo history and unsaved
edits live only in the live page" is what this is for), and a `dragend` with
`dropEffect: 'none'` outside any strip calls `tearOffToNewWindow`. Middle
click (`auxclick`, `button === 1`) closes a tab the same way Ctrl+W does.

**Opening a document goes through one funnel, `splitpage:route-open`.**
Given `{kind:'file', fileId}` or `{kind:'server', serverDocId}` it answers
`'this-tab' | 'other-tab' | 'new-tab'`: an already-open tab with the same
resolved path or server doc id is activated wherever it is (`'other-tab'`,
or `'this-tab'` if that's the caller); otherwise a **pristine and ready**
sender tab is reused in place (`'this-tab'`); otherwise a new tab is created
in the sender's window with a pending payload (`'new-tab'`). The same
`routeOpenPath`/`routeOpenServerDoc` logic serves argv, a second-instance
hand-off, and macOS `open-file`, targeting `lastFocusedWindowId` — so
double-clicking a file that's already open in some tab focuses that tab
instead of opening a second copy, and dropping a file onto an idle blank tab
reuses it instead of spawning clutter.

**Close/quit authority is per tab and per window, and a quit asks at most one
dialog** (invariant #44). `unsaved(tab) = tab.dirty || drafts.isHeld(tab.id)`
— a tab counts as unsaved even with a *held, unrestored crash draft* and no
`dirty` flag of its own. Closing one unsaved tab (Ctrl+W, the strip's ×,
middle-click, or the test hook `__testRequestCloseTab`) shows the familiar
2-button dialog (`['Leave without saving', 'Stay']`). Closing a **window** or
quitting with two or more unsaved tabs shows **one** 3-button dialog listing
every unsaved title (`[Review] [Close/Quit without saving] [Cancel]`) —
scoped to that window for a window close, covering every window in
creation order for a quit — rather than one dialog per tab. Review activates
the first unsaved tab and cancels the close/quit. The hosting prompt (`['Stop
sharing and close', 'Cancel']`, shown when `--library`/`--host` is active) is
asked **at most once per quit**, in whichever of `before-quit` or the last
remaining window's close handler runs first, gated by `hostingConfirmed`, and
always before the unsaved-changes dialog. `before-quit` runs the hosting
prompt, then the all-window unsaved dialog; only after both pass does it set
`quitConfirmed`/`sessionWritesFrozen` and let the per-window close handlers
stand down. `will-prevent-unload` remains the safety net for reloads. The
document server and ssh tunnel are still killed in `will-quit`, never
`before-quit`, for the same reason as before: `before-quit` fires *before*
windows are asked to close, so killing them there let a cancelled quit leave
the app running with its server already gone. **On discard**,
`drafts.discardForUserDecision(tabIds, reason)` runs *before* any view is
destroyed — the review answer is a real, named path (`reason`), not an
afterthought. `session-end` (Windows sign-out/shutdown) sets `sessionEnding`,
calls `drafts.markSessionEnd()`, and asks **nothing** — no dialog, no
discard, because there is no time to ask and no user decision to honor.

**Session restore at launch** reads `<userData>/desktop-state.json` v2 —
`{version:2, windows:[{windowId, bounds, maximized, activeTabId,
tabs:[{tabId, source, lastKnownTitle}]}]}`, array order = window order = strip
order, no `docId` and no draft id (drafts are addressed by `tabId` alone, §4).
A v1 file (no `version` field — the pre-tabs `{lastFilePath, windowBounds,
windowMaximized}` shape) migrates on read into one window with one tab: a
file source if `lastFilePath` existed, otherwise blank. Writes go through one
serialized queue (read latest → merge → `writeFileDurableSync`, the same
temp-fsync-rename helper `desktop/drafts.js` uses); structural changes
(create/close/reorder/move/activate/document-source-change) write promptly,
window-bounds changes are debounced 400 ms, a blank-source tab is written
only if it has a draft, and nothing is written once `sessionWritesFrozen` is
set. `hadPriorSession` (surfaced to the renderer via tab-boot-sync, below) is
true if the state read at launch had any non-blank tab or any draft existed
at all — that is what a "restore your session?" affordance would key off.

**Every tab learns who and what it is from one synchronous IPC call at
boot**, `splitpage:tab-boot-sync` (sendSync — deliberately synchronous so it
resolves before the page's own boot logic runs), returning `{tabId, windowId,
launchIntent:{type}, hadPriorSession, firstTabOfLaunch, hasDraftToRestore}`.
`launchIntent.type` is one of `'blank' | 'open-file' | 'restore-draft' |
'open-server'` and **carries no path and no server doc id** — invariant #34
again, one level up: even the boot payload never puts a filesystem path in
the renderer's hands directly; the actual bytes arrive later over
`splitpage:open-file` as a `FileEntry` once the renderer signals
`splitpage:renderer-ready`. This one call replaces three separate calls and
two bridge members (`hasFileToOpen`/`getLastFile`/`setLastFile`) the
pre-tabs shell used; those are gone from the bridge, not merely deprecated.

**Renderer crash reload and the crash-loop guard.** A tab's renderer can die
independently of its window or any other tab. Main reloads it, up to **twice
per 60 seconds per tab** (`reloadTimes`, a sliding window on `TabRecord`); a
tab that crashes a third time in that window is left crashed rather than
reloaded again — it shows the strip's `crashed` mark, closes with no prompt
(see above), and its crash-safe draft (below) stays on disk untouched for the
next launch to recover, exactly as if the whole app had died.

**Crash-safe drafts** (`desktop/drafts.js`, a plain CommonJS module with no
Electron dependency — `desktop/test/drafts.test.mjs` exercises it directly,
11 cases) are what makes a tab's unsaved work survive a crash the reload
budget above gives up on. Layout under `<userData>/drafts/`:
`<tabId>/current.draft` and `<tabId>/previous.draft` (two generations — line
1 a `DraftHeader` JSON, line 2 the state JSON), `<tabId>/base-<sha12>.json`
(the on-disk/server baseline a three-way merge needs), `session.json`
tracking `{state: 'running'|'clean-exit'|'session-end'|'none', discardedTabIds}`,
and `corrupt/<tabId>-<ts>/` for anything that fails to parse back. A write is
`open → write → fsync → close`, then in **one synchronous tick**:
`renameSync(current → previous)`, `renameSync(tmp → current)` — that ordering
is why a crash mid-write can never lose both generations at once. **Hold and
discard ordering is the load-bearing part** (invariant #40): a tab whose boot
reported `hasDraftToRestore` is `hold()`-ed the moment main learns that, and
`write()` for a *held* tab returns `HELD` and leaves both generations
byte-identical — a held, unrestored draft can never be rotated out by a
stray autosave racing the recovery prompt. `HELD` is not a disk failure
(`status().failures` does not count it); the renderer backs off and shows a
sticky "Crash recovery is paused — <reason>" toast rather than treating it as
lost data. The hold is released only by `splitpage:draft-restore-done` with
an outcome other than `'failed'`, or by an explicit user decision (Leave
without saving, Quit without saving, closing an already-clean tab) —
**never** by a crash, kill, renderer loss, session-end, quit, or restore on
its own. A discard from a user decision writes a tombstone into
`session.json.discardedTabIds` durably *before* the files are renamed to
`.trash-*` and removed, so a lost write can never resurrect discarded work.
**The draft header is built only by main, from an allowlist of scalar
fields** (`buildDraftHeader`, `main.js:807`) — `seq, editSeq, title, docId,
docIdWrittenOut, schema, origin{kind, filePath (main-resolved, never
renderer-supplied), fileName, fileKind, importName, baseLastModified,
baseSize, server{base, docId, rev}}, placement, state{bytes, sha256},
base{…}` — and **never** a PIN, session token, or launch token (invariant
#29 extended to drafts). `desktop/main.js`'s IPC surface
(`splitpage:draft-write/discard/take`, `main → tab splitpage:draft-flush`)
resolves `tabId` from `webContentsIdToTabId(event.sender)`, never a
renderer-supplied id, and every handler requires `isTrustedSender`.

**Desktop version-history storage** (`main.js`'s own "8b. Version history
storage" section, `main.js:1212`) lives under `<userData>/history/`,
mirroring the browser's IndexedDB-backed store one level down in
`src/js/03a-history-store.js` but keyed by files instead: `docs/d-<docId>/`
holding `index.json` (`{formatVersion:1, docId, title, lastOpenedAt, bytes,
count, snapshots}`) and one `s-<snapId>.snap` per snapshot (a 3-line file:
format marker, meta JSON, state JSON), plus a top-level `older/` bucket for
the migrated legacy history (§4). **Validation**: both `docId` and snapshot
id are checked against their regexes in the renderer *and again* in main
before either is used to build a path, and `path.relative(root, p)` must be
non-empty, not start with `..`, and not be absolute — invariant #38, because
a `docId` can originate from an untrusted file's own embedded id, and a path
built carelessly from it would give pasted or opened content filesystem
reach the same way an unvalidated `fileId` would (invariant #34's reasoning,
one layer further in). The Older bucket is reachable only through the
explicit `{older: true}` flag, never by a docId collision. **fsck**:
`ensureHistoryTable()` (`main.js:1563`) is always the *first* job the
history write-queue runs — it adopts orphaned snapshot bodies, renames
anything that fails to parse to `*.corrupt`, rebuilds a corrupt `index.json`
from the bodies that still parse, and sweeps stale `.tmp-*` files older than
10 minutes; `fsckHistoryBucket()` (`main.js:1610`) is the per-bucket routine
it calls for each document folder and for `older/`. **The planner twin**:
`planHistoryEviction(docs, capBytes, nowMs, opts)` (`main.js:1721`) is a
byte-for-byte copy of the same pure function in
`src/js/03a-history-store.js` — same eviction order (expired Older bucket →
trim each doc to 50 → Older oldest-first → documents by `lastOpenedAt`
ascending, oldest snapshot first, a document's newest snapshot never evicted)
— kept in sync deliberately rather than shared, because the desktop copy
runs in a CommonJS main process with no module boundary connecting it to the
browser fragment; `caseHistoryPlannerTwin` in the smoke suite diffs the two
copies so a drift is caught rather than silently shipped. A `protect` list
(`[{docId, id}]`, from the renderer's `protectHistorySnapshot()`) rides on
both `history-put` and `history-get` and is *remembered per sender* — not
just honored for the one call it arrived on — because eviction is
process-wide: a put from another tab, a `history-copy`, or the expired-Older
sweep must all skip a snapshot some tab's restore is still reading, or a
desktop restore from Older could evict the very snapshot it is restoring.

**Duplicate document-id claims are reassigned in memory only, never written
to disk on their own** (§4, invariant #36, and overrides.md §1). Main keeps a
claim table (`Map<webContents.id, {docId, homeKey, seq, birthtimeMs, title,
pendingToId}>`) populated from every `set-document-state` call. When two live
tabs claim the same `docId`, `chooseDuplicateLoser(a, b)` picks which one gets
reassigned: a server home always beats a file home; between two files,
**birthtime is not trusted** — `DUP_TRUST_BIRTHTIME = false` (`main.js:473`)
— because `atomicWrite`'s temp-then-rename moves a saved file's NTFS
birthtime forward by roughly the elapsed save time on every save (measured
~2.5 s drift on this machine), so saving the *original* document can make it
look younger than an untouched copy and the birthtime rule would reassign
the wrong tab. **This corrects an earlier, wrong belief recorded in this
file** that NTFS "tunnelling" preserves a replaced file's birthtime across a
temp-then-rename — it does not, at least not here, and the flag stays
disabled with the measurement re-checked live every smoke run
(`caseAtomicSaveKeepsBirthtime` fails the case if the live measurement and
the flag ever disagree). With birthtime out of play, the loser is simply
whichever tab claimed the id later (`seq`). Main computes a deterministic
replacement id (`deriveDocId('splitpage-dup', fromId + '\n' + loser.homeKey)`,
matching the renderer's own frozen `deriveDocId`) and sends
`splitpage:reassign-doc-id {fromId, toId, otherTitle}` to the loser once per
`(loser, fromId)` pair. The renderer's `reassignDocId()` sets the new id,
copies history, shows one sticky warning toast, and — this is the
override — **does not mark the document dirty and does not autosave**. The
new id reaches the user's file only on their next ordinary save; Splitpage
never rewrites a file the user did not touch.

**Modes and launch arguments** are unchanged in shape from before tabs:
`--library` forks `server/server.js` into a `utilityProcess` on 127.0.0.1
(first free port from 8791); `--host` binds to 0.0.0.0 for LAN URLs; `--pin
[code]` (no value generates 6 digits); `--data DIR` (default
`%LOCALAPPDATA%\Splitpage\data`); `--port`, `--allow-origin`, `--tunnel
user@host [--remote-port N] [--local-port N]` run ssh with `BatchMode`
(key-based login only). Files passed as arguments (`.splitpage`, `.md`,
`.html`, `.htm`, `.docx`, `.txt`, `.csv`) open through the same
`routeOpenPath` funnel described above; relative paths resolve against that
launch's own working directory. Single instance: a second launch hands its
files to the running app (routed the same way, into whichever window was
last focused) and exits. **PIN per tab is a carried-forward default, not yet
built**: under `--host --pin`, a new tab asks for the PIN again unless
"Remember on this device" was ticked; no token or PIN ever crosses IPC
(invariant #29). True per-tab server connections are future work (§8b).

**Test mode and hooks.** `SPLITPAGE_TEST=1` marks an automated run (must
never put anything on screen). Every window is never shown or put on the
taskbar, any dialog a test did not pre-answer through
`SPLITPAGE_TEST_DIALOGS` resolves as Cancel instead of appearing, and an
uncaught main-process error exits with its stack on stderr instead of
raising Electron's modal error box. `SPLITPAGE_USER_DATA` gives each run a
temp profile. `SPLITPAGE_TEST_DIALOGS` is a JSON file holding answers (paths,
null for cancel, `"confirm"`/`"cancel"`/`"review"` — one shared cursor)
consumed in order by open/save dialogs and the unsaved/stop-sharing prompts.
`SPLITPAGE_NO_UPDATE_CHECK=1` skips the background update check.
`SPLITPAGE_UPDATE_API` overrides the release API URL for testing. Tab-aware
test-only bridge members: `__testRequestClose()` (closes the calling tab's
*window*), `__testRequestQuit()`, `__testRequestCloseTab()` (runs the Ctrl+W
path for the calling tab), and `__testShell(op, args)` — `invoke
'splitpage:test-shell'` with ops `getShellState`, `createTab`, `activateTab`,
`closeTab`, `reorderTab`, `moveTabToWindow` (a null `windowId` tears off to a
new window), `listTargets`, returning the full `{windows:[{windowId,
activeTabId, tabs:[…]}]}` shape — this is how the smoke suite drives tab
creation, reordering and moves without simulating real mouse drags on the
strip. `splitpage:test-dup-loser {a, b}` and `splitpage:test-history-plan`
are further TEST_MODE-only escape hatches for the duplicate-claim and
eviction logic above.

**Closing a window from inside the page is not a user close.** A page-run
`window.close()` never fires the `BrowserWindow`'s `'close'` event — Chromium
settles `beforeunload` itself and, with no user activation to honour, tears
the page down without asking the main process, so a dirty document closes
with no prompt. A real close (the title-bar ×, Alt+F4, File ▸ Exit, which is
`app.quit()`, or the strip's own × on a tab) does fire the appropriate
close/quit path above. Nothing in `src/js` calls `window.close()`; keep it
that way. `caseCloseFromPageIsUnguarded` pins down the page-initiated
behaviour so a change to it shows up.

**The smoke suite**, `desktop/test/smoke.mjs`, is Node built-ins only and
drives the real window(s) over CDP (`--remote-debugging-port`). It finds
targets by kind (`findTargetsByKind`: tab-strip targets whose URL starts
`splitpage://tabstrip/`, versus tab targets whose URL starts
`splitpage://app/index.html` and carry a `?tab=<tabId>` query string parsed
out for it) rather than assuming one page target as the pre-tabs suite did.
Run from `desktop/`: `node test/smoke.mjs` (dev + every packaged exe found
under `dist/`), `--exe <path to Splitpage.exe>`, or `--only-target
dev|packaged-x64|packaged-arm64`. It now covers, on top of the original
boot/security/save/export/update surface: tab creation, close, reorder,
move-to-window and tear-off through `__testShell`; route-open dedupe
(already-open activates instead of duplicating; pristine reuse; new-tab
fallback); one-dialog-per-quit and the window-scoped 3-button dialog; session
restore across a relaunch (`desktop-state.json` v2, renamed
`caseSessionRestore` from the old `caseLastFileResume`); renderer crash
reload and the crash-loop guard tripping into the `crashed` state; duplicate
document-id claims across two tabs and their reassignment; and 16 crash-safe
draft cases (single- and multi-tab, real renderer crashes via
`crashApp`/`splitpage:test-crash-renderer`, and server documents). **454
checks total** across ~55 cases on the dev target (§2), doubled/tripled on
packaged runs when those exes exist in `dist/`.

Gotchas worth recording: `document.visibilityState` reads `"visible"` even
in test mode, so invisibility is checked with `(Get-Process -Id
<pid>).MainWindowHandle -eq 0`. A CDP `Runtime.evaluate` is not a user
gesture unless `userGesture: true`, and `beforeunload` only blocks after
activation. Dev Electron now runs **native ARM64** rather than x64 under
emulation (§2); the emulated path still works and is only modestly slower,
so a smoke run under either binary is a valid signal — but check which one
you're actually running before reporting a timing regression.

---

## 4. State schema

```jsonc
{
  "title": "string, plain text, ≤300 chars",
  "schema": 2,                  // SCHEMA_VERSION — unchanged; docId did NOT bump it (invariant #35)
  "docId": "d0123…(32 hex)",    // /^d[0-9a-f]{32}$/, minted by migrateRows if missing (§3.13, §5 #35-#37)
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

### The document id (`docId`)

Added 2026-09-14 (`src/js/02b-doc-id.js`, frozen `sha256Hex`/`deriveDocId`).
Every document carries `state.docId`, minted by `migrateRows()` when absent,
carried through `mergeStates()` as `mergedDocId(base, mine, theirs)`, and
derived deterministically from content for a legacy file that has none
(`deriveDocId('splitpage-file', …)` for a file, `deriveDocId(
'splitpage-server-doc', serverId)` for a server document with no fallback).
It **never** appears in `src/seed-state.json` (`build.mjs`'s
`seedCheckValue()` throws if it does), `#state-data`, or the Standalone HTML
export (`standaloneHtmlFor()` deletes it before serialising) — a seed or
export with a real id would give every fresh copy of the app, or every
downloaded HTML export, the same identity. It is the join key for
per-document version history and crash-safe drafts, and it is what lets
Splitpage tell two tabs holding *copies of the same file* apart from two tabs
holding the *same* file twice (§3.13's duplicate-claim reassignment). See §5
invariants #35–#37 for exactly when it is allowed to change.

### Per-document version history

Replaces the old single shared snapshot list (below). Every document's
history is now its own bucket, keyed by `docId`, capped at 50 snapshots per
document:

- **Browser**: IndexedDB database `splitpage-history` (`src/js/
  03a-history-store.js`) — stores `docs` (one record per docId, or the
  literal `'_older'`), `snapMeta` and `snapBody` (meta and state kept apart
  so listing history never has to load every snapshot's full JSON), and
  `meta`. Falls back to an in-memory store when IndexedDB is unavailable.
- **Desktop**: files under `<userData>/history/docs/d-<docId>/` — one
  `index.json` plus one `s-<snapId>.snap` per snapshot (§3.13 has the full
  layout, validation and fsck story).
- **The Older bucket**: the pre-tabs shared history (`localStorage`'s
  `splitpage-snapshots`, previously listed below as its own key) is migrated
  **once**, on first run of the history code, into a synthetic document
  called Older — `startHistoryMigration()`, `docs['_older']` /
  `older/index.json`. **The whole bucket expires 90 days after that one-time
  migration**, not per snapshot (`HISTORY_OLDER_TTL_MS`, adopted as a default
  in `overrides.md` §2 and worth revisiting with Adam if it ever feels too
  short or too long). There is deliberately no "delete this document's
  history" button yet (same override).
- Eviction order (shared by the browser's `planHistoryEviction()` and its
  desktop planner twin, §3.13): expired Older bucket first, then trim every
  document to 50, then Older oldest-first, then documents by `lastOpenedAt`
  ascending — but **a document's newest snapshot is never evicted**, so a
  quota fight can shrink history to a thin trickle per document but never to
  zero.

### Crash-safe drafts (desktop only)

`desktop/drafts.js` under `<userData>/drafts/<tabId>/` — full layout, the
two-generation write ordering, and the hold/discard rules are in §3.13. In
schema terms: a draft's `stateJson` is a full `state` object (so it carries
`docId` like any other copy of the document) plus a separate `DraftHeader`
(never the document's own fields) recording *how* to offer it back — origin
kind, file path (main-resolved), server identity, and a base checksum for the
three-way merge. Nothing about a draft is document schema; it is desktop
process state that happens to hold a copy of one.

### `desktop-state.json` v2 (session restore)

`<userData>/desktop-state.json` — full shape and migration from v1 in §3.13.
Holds **no document content and no docId**: just which windows exist, their
bounds, which tabs each has open, and each tab's *source* (`{kind:'file',
absPath}` / `{kind:'server', serverDocId}` / `{kind:'blank'}`) plus a
`lastKnownTitle` for display before that tab's page has loaded. The actual
document identity and content are re-derived by opening the source fresh (or
recovered from a crash draft) — this file is a launch recipe, not a backup.

### The two file formats

Both are written by `20d-formats.js` and read back by it; both enter `state`
through `migrateRows()` and nothing else (invariant #2).

**`.splitpage`** is `JSON.stringify(migrateRows(cloneState(state)), null, 2)`
and nothing else. No envelope, no wrapper field, no renaming: the object above
*is* the file, which is why it is also byte-for-byte what the server stores in
`{id, rev, state, …}.state` and what `#state-data` holds at boot. Detection is
the extension; validation is `typeof parsed === "object" && Array.isArray(
parsed.rows)`. See invariant #31.

**`.md`** is `toMarkdownTableDoc()` — the `# ` title, the scene table
(`| # | Visual | Audio | Status |`), the production breakdown and the comments
appendix — followed by:

```
<!-- splitpage: everything below is Splitpage's own record of this script. … -->
~~~~splitpage
<exactly the .splitpage bytes>
~~~~
```

The fence length is computed per file (`splitpageDataFence`): four tildes
minimum, and always longer than the longest run of tildes anywhere in the
JSON, because CommonMark closes a fence on the first line of at least as many
tildes as opened it. The *last* opening fence in the file wins, so a script
that quotes this block as an example cannot shadow the real one; an opener can
never occur inside the block, since `JSON.stringify` escapes every newline and
every line of the pretty-printed JSON therefore starts with its indent.

Reading a `.md` reconciles hand edits (invariant #32): the scene table —
everything before the first `## ` heading, parsed by `parseMarkdownTable()`
with `keepEmpty` — is compared cell by cell against `mdSceneCellSource()` of
the block's row. Equal ⇒ the block's HTML is kept, tags and comment anchors
intact. Different ⇒ that field is rebuilt from the table text through
`legacyMdToHtml()` + `sanitizeHtml()`, and every registry name is re-wrapped
by `tagFieldOccurrences()` so a tag survives a wording tweak. Comment anchors
in a rebuilt field are gone; the comment keeps `quotedText` and renders as
not-in-script. A `![…](data:image/…)` prefix on the Visual cell becomes
`visualImage` via `safeImageSrc()`. A differing **row count** is never
reconciled silently — `#md-rows-modal` asks (Keep Splitpage's record / Use the
table's text; Esc means keep).

No data block at all ⇒ `parseMarkdownProject()` returns `null` and the file
goes through the ordinary lossy import, exactly as any foreign Markdown always
has.

**Browser storage** (not in the document — follows the reader, not the file):

| Key | Purpose |
| --- | --- |
| `splitpage-comment-author` | your name for comments/attribution |
| `splitpage-snapshots` | **legacy, read-once.** The pre-tabs shared version-history list. `startHistoryMigration()` copies it into the Older bucket of `splitpage-history` (IndexedDB) the first time the history code runs and removes the key only after a confirmed, byte-identical re-read. Do not write to this key; it is a one-way migration source, not live storage any more. |
| `splitpage-conflict-stash` | sessionStorage; survives a forced reload |
| `splitpage-conflict-reloaded` | sessionStorage reload guard |
| `splitpage-tagging-help-dismissed` | quick-reference strip dismissed |
| `splitpage-files` (IndexedDB) | the `FileSystemFileHandle` for resume-on-launch |
| `splitpage-history` (IndexedDB) | per-document version history, keyed by `docId` — see "Per-document version history" above |

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
18. **A comment is anchored twice — by `rowId` and by its `.cmt-anchor`
    span — and anything that moves text between rows has to move both.**
    Found the hard way: the writer's Enter carried an anchored phrase into a
    new row while `rowId` still named the old one. Nothing looked broken,
    because `anchorExistsInDom`, `jumpToAnchor` and
    `syncAnchorResolvedClasses` all search the *whole* document — but the
    panel labelled the comment with the wrong scene, and `deleteComment()`
    passes that stale `rowId` to `unwrapAnchorInState()`, which looked for
    the span in a row that no longer held it, found nothing, and left a
    highlighted orphan in the script that nothing could remove.
    `repointCommentsForRows()` is the fix; call it from anything new that
    splits, joins or moves text across rows. `splitRowFieldCore()` (§3.10)
    calls it too, so the split view's Alt+Enter inherits this for free — but
    that inheritance is exactly the kind of thing a refactor can silently
    break, so it's checked on its own rather than trusted: `06-writer.txt`
    compares the panel's label against the row the anchor is actually in
    after a writer split, and `09-alt-enter-and-scroll.txt` does the same
    after an Alt+Enter split.
19. **A full-screen overlay has to own the focus and the stacking, not just
    the pixels.** Two separate bugs from the same root: the Tab-completion
    ghost sat at `z-index: 60` under the writer's opaque 145, so it was laid
    out, positioned and marked visible *behind* the overlay and Tab silently
    committed a tag nobody had been shown; and Tab from the last control on
    the writer's bar walked focus into the header and the script cells hidden
    behind it, where you could type into a document you could not see. Fixed
    by raising `.tag-ghost-hint` to 146 and by a `focusin` trap on `#writer`
    that lets modals and toasts through. Anything else added over the top of
    the app needs both.
20. **There are two Save buttons and one save state.** The header's and the
    writer's go through `setSaveButtons()`; the writer's file chip is copied
    from the header's rendered state by `mirrorFileChipToWriter()`. Nothing
    addresses either one directly, so they cannot drift into disagreeing
    about whether there is anything to save.
21. **There is one place a field gets split, not two** (§3.10). Change
    `splitRowFieldCore()` and both the writer's Enter and the split view's
    Alt+Enter change with it. Writing the split logic again inside
    `splitCellField()` — even to "just handle the visual column" — is exactly
    how the two silently drift apart from each other.
22. **Scroll to the caret's own rect, never to the cell's, when the cell might
    be taller than the viewport** (§3.10). `cellEl.scrollIntoView()` centres
    the *element*; on a cell several viewport-heights tall (a big paste is
    exactly this), that can leave the caret exactly as far out of view as it
    started. `keepCaretInView()` computes the caret's own midpoint and scrolls
    the nearest scrolling ancestor instead — walked, not assumed to be
    `window`, because `#writer-doc` scrolls `.writer-scroll`.
23. **A click that ends a text selection must never also fire a click-target
    action.** The comment card is `window.getSelection().isCollapsed`-gated
    for exactly this reason (§3.11) — a `click` event fires whether or not
    the mousedown/mouseup that produced it also dragged out a selection, and
    without the guard, finishing a drag to copy a comment's quote would also
    jump the script out from under you.
24. **The export appendix and the panel's own display can be sorted
    differently, on purpose** (§3.11). `commentEntries()` always uses
    `commentPositionCompare()` regardless of `commentSortMode` — a file's own
    appendix should read the same way twice, independent of whatever the
    person exporting it happened to have the panel sorted to at the time.
25. **A new panel showing `tagEntityHtml()` cards is a fourth call to
    `wireTagEntityContainer()`, not a new event-handling path** (§3.12). Its
    render function is a new branch inside `renderProduction()`'s dispatch,
    not a render call some existing action forgets to also make. Both exist
    so the ~35 places that already call `renderProduction()` to refresh
    "whatever's showing" keep meaning that, for every panel, without being
    found and edited one at a time.
26. **A quick-add-style box that tracks things whether or not they're in the
    script must only ever forget what it alone added** (§3.12). Reconciling
    against the textarea can delete an *orphaned* registry entry a removed
    line no longer names, but never a *live* one — `productionEntries()`'s
    self-heal (§3.4) would just re-add a live one on the next render anyway,
    so refusing to delete it isn't even a compromise, just the accurate
    reflection of what the script itself still says.
27. **A "the registry looks corrupted" symptom from a `jsclick`-driven test
    is not proof the registry is corrupted** — check `document.activeElement`
    first. `jsclick` never blurs what `caret`/`press` last focused; a `render()`
    that follows can detach that still-focused, stale node, and the browser's
    own blur/focusout on it can sync stale content back over a change that
    already landed correctly in `state`. Full mechanism in SKILL.md's
    gotchas. Real user clicks blur the cell as part of the click itself and
    do not hit this.
28. **No HTTP endpoint spawns a process or installs files — except
    `/api/launcher/*`, which is loopback-only and launch-token-gated** (§3.7).
    This was the standing rule that kept `update-status.json` a *file the page
    reads* rather than an endpoint that installs updates: the local server has
    no real authentication, so any route that could run something would be
    reachable from every other tab in the browser. The launcher's two routes
    are the one agreed exception and stay inside three locks — the per-launch
    token from the URL fragment, `HOST === "127.0.0.1"`, and a fixed script
    path with no request data near a command line. A missing lock answers 404,
    not 401. Anything else that wants to run a program from a request is a
    redesign, not a patch.
29. **The join PIN, the session token and the launch token never enter
    `update-status.json`, the document, or any file the static handler
    serves.** `update-status.json` is handed to anyone who can reach the port,
    which is exactly the audience the PIN exists to exclude; the document is
    something people mail each other. The PIN is printed to the launcher's own
    console and passed to the server as an environment variable; the tokens
    live in the server's memory and the browser's session storage. Nothing
    writes any of the three to disk, and no code path may start.

    The same rule read from the client's side: **everything about connecting
    to a server is browser state, not document state.**
    `splitpage-server-base`, `-token`, `-bookmarks` and
    `splitpage-launch-token` (`13-hosted.js`, `20e-connect.js`) are
    localStorage and sessionStorage, per person and per browser. Invariant #4
    is deliberately not in play here — and what keeps it that way is that none
    of them ever moves into `state`. A bookmark carries a name, a URL and
    optionally an SSH host with two port numbers: never a password, a key or a
    passphrase, because Splitpage is not a credential store and has nowhere
    safe to be one.

30. **The first-run setup wizard may only appear over a genuinely pristine
    copy of the app — the demo document, never shown.** `build.mjs` stamps
    `<meta name="splitpage-seed-check" content="<length>-<checksum>">` in
    `<head>`, computed from `src/seed-state.json` by a cheap synchronous
    checksum (`checksumText()` — the same mixing step as FNV-1a, but run
    over a JS string's own UTF-16 code units rather than bytes, since the
    two copies of it — one in `build.mjs` at build time, one in
    `20b-onboarding.js` at runtime — only ever need to agree with each
    other, and both are plain JS strings with no encoding to get wrong; no
    `crypto.subtle`, because that is async and this gate has to run
    synchronously at boot, before the first paint could flash the wizard
    open and shut). `seedCheckPasses()` recomputes the same value against
    the *live* `#state-data` element and compares it to the meta tag. Phase
    2 means opening a `.md` or `.splitpage` never re-embeds the document
    into the page at all, so on a served or installed copy the only way
    `#state-data` can still read as the seed is that nothing has replaced
    it — this is the same thing `.githooks/pre-commit`'s demo-state check
    refuses to let into a commit, checked here at runtime instead. A legacy
    `.html` someone mails around still carries a real `#state-data` of its
    own, so the gate keeps working for that case even though Phase 2 saves
    never produce one again.

    The gate is necessary but not sufficient: the wizard also stays hidden
    once `localStorage["splitpage-onboarding"]` has ever been written (both
    Skip and Finish write it, so neither path shows it again), and it must
    never appear over a document that is about to load — a hosted document
    (`serverDoc.id`), a project already opened this load
    (`docFileHandle.kind`, set the moment `openProjectFile()` /
    `adoptProjectState()` runs), or a remembered file handle in IndexedDB
    that `tryResumeLastProject()` (`21-events.js`) is either about to
    reopen outright or about to offer to reopen via the resume banner —
    a handle existing at all is treated as "this browser already has a
    project", regardless of which of those two outcomes follows. File ▸
    "Set up Splitpage…" bypasses all of this deliberately: reopening the
    wizard on purpose should always work, on any document, and must never
    touch the key that keeps it from auto-showing again.

31. **A `.splitpage` file is exactly `migrateRows(state)` — nothing wraps,
    renames or adds fields on the way to disk** (§3.1, §4). The moment a
    file carries `{version: 3, doc: {…}}` instead of the state object,
    three things stop being the same object:
    what the server stores, what `#state-data` holds, and what a file
    holds — and every one of them then needs a translation layer that can
    drift. A new top-level field is added the way invariant #4 says
    (`migrateRows` *and* `mergeStates`) and it travels for free. If a
    format version is ever genuinely needed, it is `schema`, which is
    already in there.
32. **The Markdown data block is authoritative for everything the table
    cannot show; the table is authoritative for scene text only, and only
    where it differs from the block.** Tags, comment anchors, ids, images,
    statuses, people, `wordsPerMinute` and
    `rev` come from the block, always. A cell whose text matches the block
    keeps the block's HTML untouched — rebuilding a cell that did not
    change would silently dissolve its tags and anchors for nothing, which
    is precisely the lossy round trip these formats exist to end. Do not
    "improve" the reconcile by making the table authoritative for a column
    it renders but does not own (`Status` is written for a human reader and
    deliberately not read back), and do not let a row-count difference pick
    a side on its own.
33. **Every automated launch of the desktop app sets `SPLITPAGE_TEST=1`, and
    nothing a test does may appear on screen** (§3.13). This is someone's
    working computer. On 2026-09-11 a smoke run launched a build that crashed
    on every window close, without test mode, and Adam got Splitpage windows
    and "Object has been destroyed" error boxes popping up while he wasn't
    using the app at all. That modal error box also blocked the main process,
    which the test misread as "the debug port dies on the first close" — an
    environment quirk — instead of the app crash it was. In test mode the
    window is never shown, a dialog not pre-answered through
    `SPLITPAGE_TEST_DIALOGS` resolves as Cancel, and a main-process crash
    prints to stderr and exits 70, so it fails the run loudly instead of hiding
    behind a dialog. Two things it does not cover: a renderer
    `window.alert`/`confirm` (Help ▸ About uses `alert`), and proof of
    invisibility — `document.visibilityState` says "visible" in test mode;
    `(Get-Process -Id <pid>).MainWindowHandle` being 0 is what shows nothing is
    on screen.
34. **The renderer never sends a file path to the main process; files are
    addressed by opaque ids from the main process's registry** (§3.13). The
    page renders pasted and imported content, so if the bridge accepted a
    path, any markup that ever slipped past `sanitizeHtml()` could read or
    overwrite any file the user can. With ids, the most the page can reach is
    a file the user picked in a native dialog, one the OS handed over at
    launch, or the last file they had open; an unknown id is rejected. A new
    bridge method that works on a file takes an id — never add a path-taking
    convenience, not even for a test.
35. **Every document carries `state.docId` matching `/^d[0-9a-f]{32}$/`.**
    `migrateRows()` mints one when it is missing, and `mergeStates()` carries
    it through `mergedDocId()`. It never appears in `src/seed-state.json`,
    `#state-data`, or the Standalone HTML export, and `SCHEMA_VERSION` was
    deliberately not bumped for it (§4). WHY: history, drafts and duplicate
    detection all key on it. A missing id must fail as *unique*, never as
    *shared* — a seed with a real id would give every fresh copy of the app
    one identity, and a schema bump would re-run `legacyMdToHtml()` over
    every existing file for a field addition that doesn't need it.
36. **The id follows the Save target, not the edit.** A fork happens only on
    Save As or publish of an id already written out, or on a detached draft
    recovery, and history is copied only after the write succeeds. Restoring
    a snapshot never changes the id. A server document is never re-identified
    automatically. "Already open" (§3.13's route-open dedupe) is decided by
    absolute path or server document id, **never** by `docId`. WHY: copies
    legitimately share an id until main separates them — opening the same
    file twice, or a document mid-Save-As, must not be treated as two
    different documents. Re-identifying on open, restore or merge instead of
    on a successful write would split or cross histories silently.
37. **`sha256Hex` and `deriveDocId` are frozen.** WHY: a legacy file with no
    embedded id gets one derived from its content; changing either function
    re-identifies every legacy file, and every duplicate-replacement id
    (§3.13), which splits history on the very next open of a file that used
    to resolve to the same id.
38. **Version history is addressed only by `(docId, snapshot id)`.** Both are
    validated in the renderer and again in main; main checks the resolved
    path stays inside the history folder, and the renderer can never name a
    folder directly. The Older bucket is reachable only through
    `{older: true}`, never by a `docId` collision. WHY: a `docId` can come
    from an untrusted file's own embedded value, and a path built carelessly
    from it would give pasted or opened content filesystem reach — the same
    reasoning as invariant #34, one layer further in.
39. **`pushSnapshot()` captures synchronously, and no save ever waits on
    history.** A restore overwrites the document only after its "Before
    restoring" backup is stored, or after an explicit second confirm. WHY:
    eight call sites replace `state` on the very next line, so an `await`
    before the capture would snapshot the *wrong* document. Restore
    autosaves, so a backup held only in memory (not yet written) is lost the
    moment the window closes.
40. **A crash draft is deleted only when its tab becomes clean, or on an
    explicit user decision** (Leave without saving, Quit without saving,
    closing an already-clean tab) — **never** on a crash, kill, renderer
    loss, session-end, quit or restore. A user-decision discard writes a
    tombstone before anything is unlinked. WHY: drafts protect against
    crashes, not against the user's own decision. A lost dialog, a killed
    process, or a late write must never destroy real unsaved work — and a
    discard that isn't durably recorded first must never let that same work
    reappear on the next launch as if it had never been declined.
41. **Restoring a draft never writes the user's file by itself.**
    "Unchanged on disk" is decided by content, never by mtime. The draft
    header — including any file path — is built only by main from
    allowlisted scalar fields, and draft bodies are written with fsync and
    two generations. WHY: sync clients (OneDrive, Dropbox) preserve or touch
    mtimes arbitrarily, so mtime cannot stand in for "did this change". A
    silent write on restore would override disk edits the user has not seen
    yet. A renderer-supplied path or secret must never reach disk. The whole
    design is aimed at the moment power is lost mid-edit, not at making
    drafts a second save path.
42. **Each tab is its own page, and the main process is the only authority
    on tab identity, unsaved state, and what is already open** (§3.13). Tab
    identity is a 32-hex `tabId`, stable across tear-off and relaunch, which
    is also the draft folder name; unsaved state is
    `TabRecord.dirty || drafts.isHeld`. Moving a tab moves its
    `WebContentsView` and never copies it, and every `BrowserWindow` comes
    from `createTabWindow`. WHY: undo history and unsaved edits live only in
    the one live page — there is no safe way to duplicate that state, so
    "moving" a tab must never mean creating a second page and discarding the
    first. Chromium's `beforeunload` cannot be trusted without user
    activation (invariant #33's reasoning), so main — not the page — has to
    be the one asking.
43. **The tab strip runs on the separate origin `splitpage://tabstrip`.** It
    has no `splitpageDesktop` bridge and no `/api` proxy, and its IPC
    handlers check `isTrustedTabStripSender`; `isTrustedSender` and the
    document bridge's permission handlers accept only `splitpage://app/`.
    WHY: the strip is chrome — UI for switching between documents — not a
    document itself. Giving it a second, narrower origin with its own trust
    check means a compromise of either page (through, say, a maliciously
    crafted pasted document) cannot reach the other page's powers.
44. **One quit asks at most one unsaved-changes dialog and one stop-sharing
    prompt; Windows session-end asks neither and discards nothing.** Session
    persistence stops once a quit or last-window close begins, and
    `desktop-state.json` is written durably (temp + fsync + rename) through
    one queue. WHY: windows close one by one during a quit, and persisting
    session state after each individual close would erase the very restore
    set a quit is supposed to leave behind; a dialog per tab during a quit
    with a dozen tabs open would be unusable. A torn session file, written
    mid-quit without the durable-write discipline, would lose every window's
    tabs rather than just the one being closed.

---

## 6. Map of the source

`src/js/` is the map now — the filenames say where things live and, unlike the
line-number table this replaced, they do not drift as you edit.

| Fragment | Lines | What is in it |
| --- | --- | --- |
| `00-prelude.js` | 153 | opens the IIFE, `PAGE_SHELL`, module-wide vars (incl. `docFileHandle`), last-project memory |
| `01-scene-status.js` | 120 | scene status and runtime estimates |
| `02-state.js` | 252 | `defaultState`, **`migrateRows`**, `legacyMdToHtml`, schema, `buildPublishHtml` |
| `02b-doc-id.js` | 461 | **document id**: `DOC_ID_RE`, `mintDocId`, frozen `sha256Hex`/`deriveDocId`, `migrateDocument`, `mergedDocId`, `reassignDocId`, `docHomeKey`/`syncDocIdentity`, the browser duplicate-claim BroadcastChannel — see §3.13, §4, §5 #35–#37 |
| `03-sync.js` | 877 | identity, **`mergeStates`**, the save loop, restore/undo-merge glue into history |
| `03a-history-store.js` | 1835 | **per-document version history**: `pushSnapshot`/`captureSnapshot`, `restoreSnapshot`, IndexedDB store + memory fallback, the Older-bucket migration, `planHistoryEviction` (mirrored line-for-line in `desktop/main.js`), `window.__historyTest` — see §3.13, §4, §5 #38–#39 |
| `04-richtext.js` | 230 | `walkSanitize`, html→markdown, video link cards |
| `05-render.js` | 463 | `rowHtml`, `render`, field sync, rich-text commands |
| `06-rows.js` | 236 | row add/move/**drag**, images |
| `07-production-tags.js` | 1222 | the tag registry, people, applying tags, autocomplete, untagged mentions |
| `08-production-panels.js` | 962 | the production and gear panels, multi-select, the breakdown |
| `09-find-replace.js` | 273 | find & replace |
| `10-comments.js` | 560 | comments: composer, panel, cards |
| `11-import.js` | 396 | paste-a-script import, two-column detection, `parseMarkdownTable`, **Google Doc import** |
| `12-dirty-toast.js` | 102 | the dirty flag and toasts, draft-change hook |
| `13-hosted.js` | 1292 | server detection, the picker, compare-and-set save, **Google Drive files**, `draftServerResume` |
| `14-export.js` | 648 | **`saveDoc`**, the Markdown writers, binary helpers, the zip writer, `adoptSavedCopyDocId` |
| `15-docx.js` | 660 | .docx writing and reading, narration-only export |
| `16-csv.js` | 125 | csv |
| `17-pdf.js` | 578 | pdf, packing lists |
| `18-local-files.js` | 770 | **`openProjectFile`/`adoptProjectState`**, save-back, the **File menu dispatch** |
| `19-writer.js` | 477 | the writer (word-processor view of the audio column) |
| `20-teleprompter.js` | 495 | teleprompter and voice follow |
| `20a-update.js` | 130 | the update notice and About box |
| `20b-onboarding.js` | 573 | the first-run setup **wizard** (`openOnboarding`), the pristine-seed gate (`seedCheckPasses`, invariant #30) — see below |
| `20c-help.js` | 377 | the in-app Help modal (`openHelp`) and the 5-step coach-mark tour (`startTour`) — see below |
| `20d-formats.js` | 295 | **the two document formats**: `.splitpage`, the Markdown project writer and reader, the hand-edit reconcile, the row-count question |
| `20e-connect.js` | 552 | the join-PIN dialog, server bookmarks, the SSH helper |
| `20f-desktop.js` | 730 | **the desktop glue**, inert unless `DESKTOP` is set: the `FileSystemFileHandle`-shaped wrapper over the bridge, `tab-boot-sync` handling, window/tab title, native-menu dispatcher, the hosting summary, `makeFakeDesktopBackend`, `window.__desktopTest` |
| `20g-drafts.js` | 960 | **crash-safe draft renderer**: the writer/idle-flush loop, `applyTakenDraft` and its restore sequence, `sameDocContent`, `recoverDraftAsUnsavedCopy`, `window.__desktopTest.drafts` — see §3.13, §5 #40–#41 |
| `21-events.js` | 1310 | all event wiring, `init()` (now sequencing draft restore before `detectServer()` when `draftRestorePending`), closes the IIFE |

`src/js/` totals ~18,100 lines across 30 fragments.

**Desktop files** (the optional Electron shell; the web app runs without them):

| File | Lines | What is in it |
| --- | --- | --- |
| `desktop/main.js` | 4985 | Electron main process: the privileged `splitpage://app` **and** `splitpage://tabstrip` scheme handlers, windows/tabs registries, tab strip IPC, route-open dedupe, close/quit lifecycle, session restore (`desktop-state.json` v2), doc-id claim table, desktop history storage + fsck + planner twin, draft header building, file dialogs, the file id registry, server launcher, native menus, test mode |
| `desktop/preload.js` | 302 | preload for `splitpage://app`: contextIsolation/sandbox, origin-gated `window.splitpageDesktop` bridge (documents, history, drafts, tab-boot-sync) |
| `desktop/tabstrip-preload.js` | 84 | preload for `splitpage://tabstrip` only: `window.splitpageTabStrip` bridge — no file, draft or history methods (invariant #43) |
| `desktop/tabstrip/` | 245+276+24 | the title-bar tab strip page: `tabstrip.css`, `tabstrip.js` (renders `ShellState`, drag/drop, tear-off), `index.html` — served only under `TABSTRIP_ALLOWLIST` |
| `desktop/drafts.js` | 984 | **crash-safe draft store**, plain CommonJS, no Electron dependency: two-generation writes, hold/discard, `session.json`, `writeFileDurableSync` — see §3.13, §5 #40–#41; exercised directly by `desktop/test/drafts.test.mjs` (11 cases) |
| `desktop/.npmrc` | 2 | pins `npm install` in `desktop/` to fetch **native ARM64** Electron (`arch=arm64`) rather than x64 — see §2 |
| `desktop/package.json` | — | Electron dependencies, build scripts |
| `desktop/electron-builder.yml` | — | packaging config for x64 and ARM64 Windows installers and portable exes |
| `desktop/build/installer.nsh` | — | electron-builder's NSIS include: adds (and on uninstall removes) the "Splitpage (shared session)" Start Menu shortcut, which runs `--host --pin` |
| `desktop/stage.mjs` | 107 | build step: runs `build.mjs`, verifies version, stages files for packaging (now including `tabstrip/` outside the asar — see DEPLOY.md §6) |
| `desktop/verify-dist.mjs` | 171 | post-`dist:win` check: every unpacked binary's PE machine field matches its architecture, the NSIS stub is x86 as expected, and each installer is no older than the unpacked app it was built from |
| `desktop/test/smoke.mjs` | 4215 | integration suite: drives real Electron window(s) over CDP, covers tab shell lifecycle, close/quit authority, session restore, doc-id/history and crash-safe drafts, plus the original boot/security/save/export/update surface — see §3.13 |
| `desktop/test/drafts.test.mjs` | 548 | unit suite for `desktop/drafts.js` alone, no Electron: 11 cases covering the write/hold/discard contract directly |

**`20b-onboarding.js` stamps and checks the pristine-seed gate.**
`build.mjs` computes `<meta name="splitpage-seed-check">` from
`src/seed-state.json` via `checksumText()`/`seedCheckValue()` (next to
`slugify()`); `20b-onboarding.js` carries its own copy of the same
`checksumText()` and calls it `seedCheckPasses()` at runtime, against the
live `#state-data` element. See invariant #30 for what the two are for and
why they never need to agree on an encoding to agree with each other.
`20e-connect.js` gained one function for this wizard's Join-a-server step,
`addServerBookmark(name, url, opts)` — the one exception to "the wizard may
only edit `20b-onboarding.js`", added because duplicating
`addBookmarkFromForm()`'s join-then-save logic there would have been a
second copy that could drift from this one; nothing else in that file
changed.

Phase 5 added the in-app Help page and the tutorial without touching
`21-events.js`, which is worth understanding if you add a sixth thing the
same way — `20b-onboarding.js` follows the same two rules (wires itself,
capture-phase File-menu listener) rather than repeating them below:

- **`20c-help.js` wires itself, not through `init()`.** Every other fragment
  registers its listeners from `init()` (`21-events.js`), which runs on
  `DOMContentLoaded`. This fragment can't add itself to that function, so it
  runs its own top-level wiring immediately instead — safe because a classic
  `<script>` pauses the HTML parser in place, so every element earlier in
  `page.html` (which is where `#help-modal`, `#tour-overlay` and `#file-menu`
  all live) already exists in the DOM by the time this fragment's own code
  runs, `init()` or not. See `00-prelude.js`'s `PAGE_SHELL` comment for the
  same reasoning applied to reading the DOM instead of writing to it.
- **The File-menu items are a capture-phase listener on `#file-menu`
  itself, not a `handleFileMenuAction()` branch.** `handleFileMenuAction()`
  (`18-local-files.js`) is off limits for this change, and its own listener
  runs at the bubble phase. `20c-help.js` adds a *second*, capture-phase
  listener to the same `#file-menu` element that matches only
  `data-file-action="help"`/`"tour"` and calls `stopPropagation()`. Because
  both listeners sit on the exact same node, `stopPropagation()` during the
  capture pass stops the event before it ever reaches the target or bubbles
  back up — `18-local-files.js`'s dispatcher never sees these two actions.
  Any future menu item that a fragment other than `18-local-files.js` needs
  to own can reuse this pattern rather than adding a branch to
  `handleFileMenuAction()` in a file it isn't allowed to touch.
- **`README.md` is a build input now.** `build.mjs`'s `mdToHtml()` (~130
  lines, no dependencies) renders it to the Help modal's body and TOC at
  build time — see its own comment block for the escape-then-block-then-
  inline ordering and what it does and doesn't support. `.githooks/pre-commit`'s
  build-check trigger regex gained `README\.md` alongside `index\.html`,
  `src/`, `build\.mjs` and `VERSION`, so an edit to just the README also
  gets `node build.mjs --check`'d before it can be committed. Developer-only
  sections are wrapped in `<!-- help:skip-start -->`/`<!-- help:skip-end -->`
  and never reach the shipped page.

**`20e-connect.js` wires its own File-menu entry.** The dispatch in
`18-local-files.js` knows nothing about `data-file-action="servers"`; instead
`20e` listens on `#file-menu` in the **capture** phase, which runs before that
file's bubbling handler, and calls `stopPropagation()` when the action is one
of its own. That was the least invasive of the options (the alternative was
editing `handleFileMenuAction()` to reach forwards into a later fragment), and
it keeps everything about connecting to a server in one file. A second feature
wanting the same trick should think twice — two capture listeners racing for
the same element is how this gets confusing.

**`20b-onboarding.js`'s capture listener on `#file-menu` matches every
action, not just its own.** It registers before `20c-help.js`'s and
`20e-connect.js`'s (alphabetical fragment order), and on *any*
`[data-file-action]` click it closes the wizard first — without writing the
key, so it shows again on the next pristine load — before falling through
to whichever action was actually chosen. Help and the tour are the only
other full-screen modals in the app, and both only ever open from this same
menu, so this is the one place that can guarantee invariant #19's "never
two full-screen modals open at once": without it, opening Help while the
wizard is still up left two modals live together, each with its own Escape
listener, racing over which one Escape actually closed (this is what broke
`14-help.txt` while this fragment was being built). A real mouse click can
never trigger the conflict on its own — the wizard's backdrop sits over the
File button, so a genuine click cannot reach it — but a test's `jsclick`
(`.click()`, no hit-testing) or a keyboard user tabbing to the button can,
which is exactly the case this covers.

**The wizard's own Escape and Tab handling had to learn NOT to act like
Help's and Connect's.** Both of those add their Escape listener in the
capture phase and stop it there — safe for them because neither ever
auto-opens, so nothing else is competing for that Escape at the moment they
are up. The wizard is the one modal that opens over an otherwise-idle app
on its own, which means it can be sitting open, unnoticed, for an entire
unrelated test suite. A first version copied that same capture-phase
`stopPropagation()` pattern and broke `07-untagged.txt`: the wizard's
listener on `window` ran before the event ever reached `#rows`, where the
untagged-mention suggestion's own Escape handler lives, so pressing Escape
to dismiss that suggestion silently closed the wizard in the background
instead and the suggestion never got the key at all. The fix is to listen
in the bubble phase and never call `stopPropagation()` — the wizard only
ever acts once nothing closer to the actual target has already claimed the
key, which in practice means focus really was inside it. The same reasoning
ruled out a document-wide "steal focus back" trap for Tab: unlike Help's
modal (never auto-open, nothing else legitimately wants focus while it's
up), a reactive focusin trap here fights anything on the page that focuses
itself while the wizard happens to be open in the background — a test's
`caret` on a script cell included, which is the *other* way
`07-untagged.txt` broke (typing still landed, via the Selection API, but
real DOM focus had been dragged onto the wizard's own close button, so the
suggestion's Escape handler on `#rows` never saw the keydown that followed
because it never bubbles through an element it isn't a descendant of).
Invariant #19 ("owns focus, not just the pixels") is met here instead by
placing focus inside the wizard the moment it opens and trapping Tab so it
cannot walk a keyboard user out the back of it — the backdrop's own CSS
already stops a real click from reaching anything behind it, so a
keyboard-only Tab trap is the one piece worth adding.

`src/page.html` is the shell — topbar, File menu, modals, and the three build
markers. `src/app.css` is everything visual. `src/seed-state.json` is the one
line of JSON that is the demo document.

### Merging main into a branch that has `src/`

Main still edits `index.html` directly, so any branch carrying this refactor
will conflict with it, and a textual merge of a generated file is meaningless.
The way that worked (used for the Drive / Google Doc / Markdown merge):

1. Split main's `index.html` with the *same* boundaries `src/` was cut on —
   `<style>`, `</style>`, `#state-data`, `<script id="app-logic">` — to get a
   comparable "theirs".
2. Prove the splitter first: run it over the merge base and check it
   reproduces this branch's original `src/` byte for byte. If it does not,
   stop; every merge after that is guesswork.
3. Cut main's JS into the same 22 fragments by matching each base fragment's
   **first line** as an anchor, asserting each anchor is unique before use.
4. `git merge-file` each piece against its own base — `app.css`, `page.html`,
   `seed-state.json`, and every fragment. Fragments new on this side have no
   counterpart; skip them.
5. Normalise trailing newlines on all three sides first, or every fragment
   boundary reports a spurious conflict.
6. Rebuild, then diff main's `index.html` against the rebuilt one and read
   **every removal**. Additions are expected; a removal you cannot name is
   main's work being dropped.

---

## 7. Current status

### Built and verified live

- **The setup window (2026-09-11).** Double-clicking the setup used to look
  like nothing happening: IExpress runs install.ps1 with no console anyone can
  see, and the script sat on a Read-Host asking where to install. It asks in a
  WPF window now, with a progress window during the copy and a completion
  window that offers to open the app. If WPF will not load it installs to the
  per-user default rather than asking into a console nobody can answer, and a
  script-level trap reports any failure in a message box instead of exiting
  silently. Verified by driving the real, mark-of-the-web-marked arm64 setup
  from a plain double-click with UI Automation: dialog, both checkboxes,
  progress, completion, shortcuts, registry, native arm64 runtime on disk.
  Cancel leaves nothing behind. -Silent, -Dir, -InPlace and -Unregister are
  unchanged and were re-run.
- **Runtime selection no longer trusts $env:PROCESSOR_ARCHITECTURE.** A setup
  built by IExpress is an x64 program, so on Windows on ARM it runs emulated
  and calls an ARM64 machine "AMD64" - the arm64 setup then looked for a
  runtime it does not carry, found none, and installed an app with no Node at
  all. What the download carries decides it now (a single-arch setup has
  exactly one runtime), and where a choice is needed the registry and
  Win32_Processor are asked, both of which stay honest under emulation.

- **The ARM64 setup, natively (2026-09-10).** Adam's machine turned out to be a
  Snapdragon X running Windows 11 ARM64 - Git Bash is an x64 process under
  emulation and reports AMD64, which is why earlier notes called it an x64
  PC. `SplitpageSetup-1.0.0-arm64.exe /Q` installed, runtime
ode.exe is a
  native ARM64 binary (PE machine 0xAA64, `process.arch === "arm64"`), the
  installed copy served the app, and the silent uninstall left nothing. The
  x64 setup verified earlier ran the same way under emulation. Check
  architecture from native PowerShell (`[RuntimeInformation]::OSArchitecture`),
  not from Git Bash.

- **2026-09-10, on Windows 11 x64 (Adam's machine).** The installer end to end:
  `node package.mjs --installer` -> `SplitpageSetup-1.0.0.exe /Q` installs per
  user with shortcuts and the Add/Remove entry; the registered uninstaller
  removes everything and leaves `%LOCALAPPDATA%Splitpagedata`. The ARM64 and
  x64 setups built by `--arch both` carry one runtime each; install.ps1
  renames the right one to runtime
ode.exe and rewrites the manifest entry
  (x64 verified by a real install; ARM64 built only). A hosted session with
  two browsers: publish, join, a different-scene merge (banner "Kept 1 row
  you edited, 1 changed by someone else"), and a same-field conflict kept as
  an Unmerged-edit comment. A `--pin` server: the PIN dialog on load, a wrong
  code refused in place, the right one storing only a session token. The
  first-run wizard on a launcher-opened copy: "Add to Start Menu" registers in
  place (`install.ps1 -InPlace`), and the Add/Remove entry it writes runs
  `install.ps1 -Unregister`, which removes the shortcuts, the key and the
  marker and touches nothing else in the folder. The regression harness runs
  with the wizard pre-dismissed (driver.ps1 injects the onboarding key before
  page scripts; `?wizard=1` asks for it), because a rendered wizard swallows
  the suites' real mouse clicks.

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
`tests/06-writer.txt` (81 assertions) and a phone pass at the end of
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

Alt+Enter, caret-follow, and the comments panel (2026-09-02):
`tests/09-alt-enter-and-scroll.txt`, `tests/10-comments-panel.txt`,
`tests/11-comments-sort-persist.txt`. Alt+Enter splits only the focused
column in both directions (Audio split leaves Visual whole on the original
row and blank on the new one, and the same the other way round), lands the
caret in the new row's same field, and — proven by disabling the call and
watching the assertion fail — correctly repoints a comment anchor caught in
the split, the same as the writer's own Enter. `keepCaretInView()` verified
both directions: a ~3,000-character paste inserted before the caret, and a
Backspace removing most of it, each checked by reading the caret's own
`getBoundingClientRect()` afterwards, not by trusting that a scroll call was
merely made — the first implementation (`cellEl.scrollIntoView()`) passed
that shallower check while leaving the caret genuinely off-screen; only
measuring the caret's own position afterward caught it. A plain small edit
is confirmed to make zero `scrollBy` calls, so normal typing is unaffected.
The comment card's click-to-jump is verified to leave the panel open, and a
genuine non-collapsed selection (set via the Selection API, then a plain
`click` dispatched — a real drag-select is unreliable to fake faithfully
over CDP) is verified to suppress the jump rather than fire it alongside a
copy. Both sort modes are checked against a case where they disagree
(script order vs. posting order), a reply is confirmed to count as activity
for "most recent", the export appendix is confirmed to stay in script order
regardless of which the panel is currently showing, and the sort preference
is confirmed to survive a reload.

Gear (2026-09-03): `tests/12-gear.txt`, plus a mobile pass by hand. The
`<gear>` shortcut, its own colour (checked against a decoded RGB, not just
"a colour got applied" — the exact invariant-14 mistake this guards
against), and the header badge. Quick-add reconciliation checked in both
directions on the same document: a line with zero script mentions becomes a
correctly-flagged orphaned entry, and removing an item's line while it is
*still* tagged live in the script leaves it tracked — the self-heal path
(§3.4) doing its job, not a gap in the reconciliation. Status cycle, expand,
rename, Remove label vs. Delete from list all verified to work from
`#gear-panel` through the shared `tagEntityHtml()`/`wireTagEntityContainer()`
wiring — not re-tested as new code, confirmed as the SAME code reached from
a second container. A renamed live tag is checked two ways: the panel's
name and the anchor's `data-tag-name` both update, the anchor's own visible
text does not (deliberate — see §3.4's "the words on the page stay what was
written"). Mutual exclusivity with Production/Comments and the writer is
checked in both directions. Gear items are confirmed to appear in the
general Production panel unfiltered. Both packing lists — Gear from its own
panel button, Props from the File menu — are checked as well-formed PDFs
carrying the right item and excluding the other category's, and an
untagged category is confirmed to refuse the export with a toast rather
than produce a near-blank file.

Hosted mode (2026-08-28): server detection, Access identity auto-fill,
publish, open-from-server, compare-and-set save, clean auto-merge of edits to
different scenes, same-field conflict raised and preserved as a comment,
lapsed-session detection, and the full sign-out → reload → resume-and-merge
cycle — all exercised in a real browser against the API contract.

The first-run setup wizard (2026-09-10): `tests/13-onboarding.txt`. Shows on
its own over a fresh profile with no key set, stays hidden once
`splitpage-onboarding` is written, Next/Back walks all 4 steps, step 2 falls
back to plain instructions when `api/launcher/info` 404s (the harness is not
the launcher), Skip writes the key with `skipped:true` and the wizard stays
hidden across a reload, File ▸ Set up Splitpage… reopens it without clearing
that key, Esc skips, and `#rows` is checked byte-identical after every one of
the above (invariant #17). The pristine-seed gate (`seedCheckPasses()`,
invariant #30) is checked directly: true against the shipped `#state-data`,
false the moment its text no longer matches. Confirmed alongside this: the
whole regression suite still passes with the wizard auto-showing on a fresh
profile — two real interactions it broke along the way, both caught by
suites that have nothing to do with onboarding and both explained in §6:
opening another File-menu modal while the wizard was still up (`14-help.txt`,
fixed by making every File-menu click close the wizard first) and the
wizard's own Escape/focus handling swallowing a keystroke meant for
something else on the page while it sat open in the background
(`07-untagged.txt`, fixed by moving Escape to the bubble phase and trapping
Tab instead of focusin). Both are why the full suite, not just
`13-onboarding.txt`, is the real test of a feature that auto-opens over an
otherwise-idle app. And `.githooks/pre-commit`'s demo-state check still
passes with the new `<meta name="splitpage-seed-check">` in `<head>`, since
that check only ever looks at the `#state-data` line.

**Desktop app, tabs build (Electron 44, verified 2026-09-14, commit
`376b35e`):** the smoke suite drives the real window(s) over CDP and covers
everything the pre-tabs shell did — boot + security (bridge origin,
navigation/`window.open` blocked, allowlist and traversal refused, bogus file
id rejected), open via argv with non-ASCII, save in place round trip, on-disk
conflict guard, Save As and cancel, export, second instance (absolute and
relative path), `--library`, `--host --pin` (given and auto-generated),
`--host` without a PIN shows the warning, update status, clean close (exit 0,
no "Object has been destroyed"), and what a page-initiated `window.close()`
does — **plus the whole tabs surface**: tab creation/close/reorder/move/
tear-off via `__testShell`, route-open dedupe (already-open activates rather
than duplicating, pristine-tab reuse, new-tab fallback), the window-scoped
3-button unsaved dialog and the single hosting prompt per quit, session
restore across a relaunch (`caseSessionRestore`, `desktop-state.json` v2),
renderer crash reload and the crash-loop guard, duplicate document-id claims
across two tabs and their in-memory reassignment, desktop version-history
storage (id/path validation, the fsck, the planner-twin comparison against
the browser's own `planHistoryEviction`), and 16 crash-safe draft cases
(single- and multi-tab, real renderer crashes, server documents). **Final
counts: browser suite ALL PASS — 998/998 across 25 suites (01–26, 16
unused); server 39/39; `desktop/test/drafts.test.mjs` 11/11; desktop smoke
ALL PASS — 454/454 on the dev target (native ARM64 Electron) and 454/454 on
the packaged ARM64 exe; `npm run dist:win` ends with `verify-dist` 9/9.**
Fresh installers (unsigned, version 1.0.1) sit in `desktop/dist/`.

### NOT verified — say so, don't imply otherwise

- **The tabs UI has not been eyeballed by a human.** Everything above is
  CDP-driven assertions against `__testShell`/`ShellState`/the doc-claim and
  draft IPC — nobody has looked at the tab strip rendering. Specifically
  unverified by eye: the window controls (minimize/maximize/close) sitting
  correctly beside the tabs under the `titleBarOverlay`, the Alt menu bar
  interacting sanely with `autoHideMenuBar` and the strip, a **real** mouse
  drag-out of a tab into its own window (the smoke suite drives
  `tearOffToNewWindow` directly, never a real `dragend`), dark mode across
  the strip and every dialog, the packaged installer's tab behaviour by hand
  (only the dev target and the packaged *exe launch* have been driven by
  CDP — nobody has double-clicked the installed Start Menu shortcut since
  tabs landed), and the Older-history panel's scroll behaviour (noted as a
  known, unverified-by-eye issue in the phase-2 review; see §8). Follow My
  Voice and Google Drive remain unbuilt on desktop regardless of tabs (§8,
  unchanged from before this build).


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
- **`server/server.js` HAS now been executed** (2026-09-09, in a Linux
  container with Node 22 — the dev machine still has neither Node nor Docker).
  Exercised against the live process: health, identity parsing from the
  Cloudflare Access header, create, list, read, delete, id validation, path
  traversal, `READ_ONLY=1`, and the compare-and-set — five concurrent PUTs at
  one `baseRev` gave exactly one 200 and four 409s, so the per-document write
  lock does its job. One bug found and fixed: an over-length body destroyed
  the socket before its 413 could be written, so the client saw a reset rather
  than a reason.
  **Still unproven:** the Docker image has never been built (no daemon in that
  container), and no browser has driven the hosted client against this file —
  the client-side hosted tests still ran against the PowerShell double. §2 of
  DEPLOY.md remains the smoke test.
- **Phase 3's server half is tested; its edges are not.** `node
  tools/test-server.mjs` drives real `server.js` processes on free ports and
  covers the join PIN, the rate limit, CORS (allowed origin, other origin, the
  literal `null`, static files), the unchanged 409, and the launcher routes
  refusing without the token and under `--host` with it — 39/39. What has
  **not** happened: two browsers on two machines joining one PIN-protected
  session (**one** browser against a real `--library --pin` server has: dialog
  on load, wrong code refused in place, right code joining, publish and list
  working with the token — the recipe is in SKILL.md); a real cross-origin
  client (a `file://` copy with
  `--allow-origin null`) opening and saving a hosted document; `--tunnel`
  against a real SSH host; and `POST /api/launcher/register` actually running
  `install.ps1 -InPlace` (that writes shortcuts and a registry key, so it needs
  Adam's say-so first). The client-side dialogs are covered by
  `tests/18-connect.txt`, but only against a static harness — no dialog in that
  suite has ever received a real 401 from a real server.
- **"Add to Start Menu" has been clicked for real (2026-09-10)** from a
  launcher-opened copy: it registered in place, and the Add/Remove entry it
  wrote (`install.ps1 -Unregister`) took everything back without touching the
  folder. `tests/13-onboarding.txt` still only covers the no-launcher branch,
  because a headless suite is never launcher-opened.
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
- **Nothing Windows-side of the installer has ever run.** `iexpress.exe` and
  PowerShell are both Windows-only, so `installer/install.ps1`,
  `installer/uninstall.ps1` and the IExpress step are all unproven. What IS
  verified is everything they consume: the payload zip passes `unzip -t`, its
  manifest covers all 18 files, and the bundled `node.exe` comes out of it
  byte-identical to what nodejs.org served (PE32+, checksum matched twice).
  First run should be `node package.mjs --installer` on Windows, then the
  resulting setup.exe end to end: install, launch, host a session, uninstall.
- **The bundled runtime is pinned** in `tools/fetch-runtime.mjs`
  (`NODE_VERSION`). Bumping it is a deliberate act, so a release is
  reproducible; the download is verified against nodejs.org's SHASUMS256.txt,
  which guards a corrupt download rather than a compromised nodejs.org.
- **The update path fetches from a public mirror.** The main repository is
  private, so release assets are published to `RetroGorilla/splitpage-releases`
  and the shipped `.splitpage-release.json` manifest points there via
  `release.json`. The API URL is resolved by `updateApiUrl()` in `update.mjs`
  in priority order: `SPLITPAGE_UPDATE_API` env (for testing), `updateApi` from
  the local manifest (if valid https URL), or the hard-coded default. Testing
  with `node tools/test-update.mjs` covers the resolution precedence and backup
  recovery logic (detecting a sentinel file that marks an interrupted apply,
  restoring from backup first before proceeding fresh).
- Touch devices. HTML5 drag-and-drop doesn't work on touch; the ↑/↓ buttons are
  the deliberate fallback.
- **A real OS double-click of a .splitpage file after installing.** The
  installer has never been run on a real machine or a clean profile. The file
  association is defined in `electron-builder.yml`, and on Windows a
  double-clicked file reaches the app as a command-line argument — which the
  smoke suite does test, by launching the exe with a path — but the registry
  entry the installer writes and Explorer's hand-off have never been exercised.
- **Real native Open/Save dialogs and message boxes.** The smoke suite uses
  `SPLITPAGE_TEST_DIALOGS` to pre-answer every dialog, so the real Windows
  native dialogs and message boxes have never appeared.
- **`--tunnel` end to end.** No SSH server exists in the test environment. The
  command line is parsed and the ssh process would spawn; the connection itself
  is unproven.
- **macOS.** The `open-file` event and app menu entries for macOS exist in the
  code but have never run. No Electron build for macOS exists and no test
  machine has one.
- **Code signing.** The packaged installers are unsigned. Signing them
  (Windows SmartScreen and macOS notarization) is pending a decision on the
  release recipe.

---

## 8. Where to pick up

**Immediate, and all of it needs a Windows machine — none of it can be done
from a Linux container:**

1. ~~Run the regression suite~~ Done 2026-09-10: green after the seed-schema
   fix (see "Built and verified live"); it has grown to 19 suites since.
2. ~~Build and run the installer~~ Done 2026-09-10: `/Q` install, launch,
   host+join, and the registered uninstall all verified. IExpress needed
   `/Q` (not `/S`), a visible console, ASCII-only scripts, and the payload
   script named `install.ps1` - all fixed in `package.mjs`/`installer/`.
3. **Confirm voice follow** over a real 2-minute read — still the oldest open
   loop, and still unverifiable in any sandbox because the microphone is
   blocked.
4. **Point the updater at the mirror.** Create a release on
   `RetroGorilla/splitpage-releases` with the assets from `node package.mjs
   --installer --arch both`, tag it `v<version>`, then `node update.mjs check`
   against the mirror. The update path is verifiable end-to-end once a mirror
   release exists.

**Done, on this branch (2026-09-14, commit `376b35e`):**

(a) ~~**Tabs.**~~ Built and verified (§3.13, §7): windows/tabs registries, the
   `splitpage://tabstrip` title-bar strip, route-open dedupe, tear-off/move/
   reorder, per-tab and per-window close/quit authority with one dialog per
   quit, session restore via `desktop-state.json` v2, renderer crash reload
   with a crash-loop guard, crash-safe drafts for every unsaved tab
   (`desktop/drafts.js`), and per-document version history keyed by a
   document id stored inside the file (`02b-doc-id.js`), moved to IndexedDB
   in the browser and `<userData>/history/` files on desktop. The document id
   and per-document history apply to the browser app too, not just desktop.
   Known minor issues left from this build, not yet fixed — small enough to
   pick up individually, not blocking anything:
   - Help ▸ About still uses `window.alert` (never triggered by an automated
     test, and the one desktop dialog type test mode does not stub — see
     invariant #33's "two things it does not cover").
   - Desktop's `openLocalFile` swallows a read error that occurs *after* the
     native Open dialog has already returned a path — the dialog succeeds,
     the subsequent read fails silently.
   - `saveDoc`'s rev-rollback-on-failure can decrement a different document's
     rev if a different document was opened in that tab mid-save (a narrow
     race, not reproduced, found by reading).
   - The Older-history panel's scroll fix is unverified by eye (§7's NOT
     verified list).

**Pitched for the desktop app, next to build:**

(b) **Per-tab server and tunnel connections.** For now tunnels stay app-wide,
   and under `--host --pin` a new tab asks for the PIN again unless "Remember
   on this device" was ticked (no token or PIN crosses IPC — invariant #29).
   Later any tab should be able to connect to any server or tunnel, with a
   "New tab on server…" command and a connection badge on each tab. This needs
   a redesign of how connection details and server tokens are held across
   tabs — PIN/auth code. `main.js`'s doc-claim `homeKey` and
   `serverDocIdToTabId` both currently assume one app-wide server
   (`serverBase` is `''` in the desktop app); the plan is for `serverKey` to
   become an opaque `connectionId + '/' + slug` once this lands, additively,
   in both the claim table and routing (the draft header already records
   `server.base` in anticipation of this).

(c) **Follow My Voice in the desktop app.** The Web Speech API constructor
   exists in Electron, but recognition fails with a network error: Chrome and
   Edge reach Google's/Microsoft's speech service with credentials Electron
   does not have. The fix is a different speech backend reachable from the
   desktop app (an on-device engine, or the OS's own recognizer), not a
   permissions change. Until then `20-teleprompter.js` says it isn't available.

(d) **Google Drive via loopback OAuth.** Google Identity Services only
   authorizes http/https origins, never custom schemes. Making it work would
   need a Desktop-app OAuth client with Authorization Code + PKCE and a
   loopback redirect handled in the main process. Google Doc import still
   works: it opens Google's .docx export in the system browser and the user
   opens the downloaded file.

(e) **Pending decisions for Adam:**
   - **Release pipeline.** Do the desktop installers replace the IExpress
     setups and `update.mjs` in the release recipe, run alongside them, or
     stay a separate distribution channel — and electron-updater vs a plain
     download link?
   - **A 1.0.2 fix branch and VERSION bump.** The tabs build landed on
     `Splitpage-electron` at `desktop/package.json` version 1.0.1, unchanged
     from before it started; nothing has bumped it for this body of work yet.
   - **Code signing** (Windows SmartScreen and macOS notarization)?

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
