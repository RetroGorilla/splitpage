# Splitpage — developer handoff

Written 2026-08-28, condensed 2026-09-15. For whoever (or whatever) picks this up next.

`docs/help.md` is the **user-facing** doc — what the features are and how to
use them, and the file `build.mjs` renders into the in-app Help page. Read it
first; this file deliberately does not repeat it. `README.md` is the
repo-facing half of what used to be one file (#80): building, releasing, and
the map of the tree.

---

## 1. Orientation

Splitpage is Adam's personal tool for scripting videos: a two-column
visual/audio editor with a teleprompter, review comments, and a production
breakdown for props/locations/cast/VFX/sound.

- **Edit `src/`, never `index.html`.** Source is `src/page.html` (shell),
  `src/app.css`, `src/seed-state.json` (demo document), and `src/js/` — 41 ES
  modules with explicit `import`/`export` (#66; they were fragments of one
  IIFE until then). Filename order is still evaluation order, but it is
  pinned by hand now, not by concatenation: no module does anything at
  evaluation time except declare functions, and `_entry.js` calls each
  module's `__init()` in filename order. `node build.mjs` bundles them with
  esbuild and inlines the result into `index.html`; `node build.mjs --check`
  says whether the copy on disk is in step. `index.html` is **not in the
  repository** since #80 — it is generated, it is ignored, and a fresh clone
  has none until you build one. Run `npm install` once first — esbuild is the
  one devDependency the build needs.
- **The build writes two files, not one.** `index.html` and, since #79,
  `sw.js` — whose cache name is stamped from `VERSION`, which is what makes a
  deploy take effect on the next load instead of the one after it. `sw.js` is
  stamped in place rather than generated from `src/`, because a worker needs
  its own URL so it cannot be inlined, and `package.mjs`, the `Dockerfile` and
  `desktop/stage.mjs` all copy the repo-root file out verbatim. `--check`
  reports on both, separately, so two stale outputs are not found one at a
  time.
- **Two files carry what one closure used to.** `src/js/_state.js` holds the
  57 `var`s that are written from a module other than the one declaring them:
  an ESM import binding is read-only, so they are properties of one exported
  object `S`. `src/js/_entry.js` is the bundle entry and the evaluation
  order.
- **The shipped app must stay one self-contained file.** Save writes
  `"<!doctype html>" + document.documentElement.outerHTML` with the document
  spliced into `#state-data` (`buildPublishHtml`, `PAGE_SHELL`). That's why
  there's an inlining build step instead of `<script src>`.
- Supporting files: `README.md` (repo-facing) and `docs/help.md` (the user
  guide, and a build input — it becomes the in-app Help page), `start.mjs`
  with thin `start.bat`/`start.sh`
  wrappers (local launcher), `update.mjs` (says whether a newer release
  exists; installs nothing), `server/server.js` + `Dockerfile` (hosted mode),
  `package.mjs` (the portable zip), `desktop/` (the Electron app and its NSIS
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

Rebuild before testing any `src/` change, always:

```bash
node build.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/run-tests.ps1
```

The browser suite (`tests/01-core.txt` … `28-autosave.txt`, 16 retired)
drives headless Edge over CDP. `-Only 22` runs one suite, `-Headed` shows the
browser. Windows-only. Predates Google Drive, Google Doc import, two-column
Markdown export, and the update/About box — hand- and Chromium-tested only.
Full reference and gotchas: `.claude/skills/run-splitpage-app/SKILL.md`.
`run-tests.ps1` mints its own 8-hex `$RunId` per run so two runs can share
the machine without one's orphan-process sweep killing the other's browser.

**Away from Windows**, `.claude/skills/run-splitpage-app/driver.mjs` is the
same driver in Node — same `tests/*.txt`, same commands, same `RESULT:` line —
so a `src/` change can be driven from the Linux cloud container, which has
neither PowerShell nor Edge. One suite per invocation (`run-tests.ps1` is not
ported):

```bash
node build.mjs
node .claude/skills/run-splitpage-app/driver.mjs --script .claude/skills/run-splitpage-app/tests/01-core.txt
```

It finds Playwright's Chromium under `$PLAYWRIGHT_BROWSERS_PATH` on its own.
Google Fonts does not load there (the proxy's CA is untrusted), so the app
falls back to generic sans/mono and **width assertions can disagree with the
Windows result** — SKILL.md has the CA-pinning recipe that fixes it. Since
#57 `driver.mjs` exits 1 for a failed assertion, and for a suite that
asserted nothing at all, which is what lets CI gate on it; `driver.ps1` still
only exits non-zero for a command that throws, so read its `RESULT:` line.

**CI** (`.github/workflows/ci.yml`, #58) runs `npm run lint`, `node
build.mjs`, `npm test`, `desktop/test/drafts.test.mjs`,
`desktop/test/ipc-table.test.mjs`, `desktop/test/google-drive.test.mjs`, `tools/test-server.mjs`,
`tools/test-update.mjs` and browser suites 01 and 52 on every pull request.
A second job, `desktop-smoke`, runs `desktop/test/smoke.mjs --only-target
dev` against an Xvfb display (#89) — that is where `main.js` and `preload.js`
are actually executed, ~600 checks of it. It is its own job because it
launches ~60 real Electron processes — 6.3 minutes on a Windows 11 x64
machine, far longer on a slow shared runner — which is more than everything
else together. It is not the
full regression run — that is still `run-tests.ps1` on Windows, or
`driver.mjs` one suite at a time here, plus the packaged targets.

Since #80 CI also **produces** the app. It builds `index.html` and uploads
it, with `sw.js`, `manifest.webmanifest`, `icon.svg`, the server and the
`Dockerfile`, as the `splitpage-app` artifact — the set of files DEPLOY.md §2
copies onto the server, arranged so the download is itself a working `docker
build` context. The upload is the last step, so an artifact only exists for a
run whose checks all passed.

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
node test/smoke.mjs                    # dev + every packaged exe in dist/
node test/smoke.mjs --only-target dev  # dev only, fastest loop
```

On Linux (#89) the same dev target runs, and CI runs it on every pull
request. It needs a display of its own and, on a first checkout, an explicit
fetch of the Electron binary — Electron 44 has no postinstall, and going
through npm would obey `desktop/.npmrc`'s ARM64 pin and fetch a build this
machine cannot execute:

```bash
node build.mjs                           # main.js serves index.html from APP_ROOT
cd desktop
npm ci
node node_modules/electron/install.js    # NOT npx — see .npmrc
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

Dev Electron is pinned to native ARM64 (`desktop/.npmrc`, `arch=arm64`); a
plain `npm install` in `desktop/` on the Windows machine fetches the right
one. Never run `npm run dist`/`dist:win` outside a deliberate release build.
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

`saveToServer()`: PUT with `baseRev` — **the document's rev, never
`state.rev`** — 200 stores the new rev and `baseState = published`; 409
three-way-merges `(baseState, state, theirs)` and retries (3 rounds max).
**`baseState` must be exactly what the server last confirmed** — any new
save path sets it to what it successfully sent, nothing else. Since #72 the
merge paths do not write it themselves: `applyMerge()` (03-sync.js) is the
one orchestration — snapshot, undo point, `baseState`, autosave, chips,
toast — and the only writer of `baseState` on a merge; since #96 that
includes the boot stash and the crash-draft file merge, the latter through
`awaitUndoPoint` (the undo point is on disk before the merge is on screen).
Every other write is "adopt what the other side just confirmed" after a
successful write or open (or `null`: no ancestor), and goes through
`setBaseState(next, why)` next to it, each call with its reason — so
`grep -rn "S\.baseState *=" src/js/` shows the declaration, `applyMerge` and
`setBaseState`, and nothing else. `reportMerge(result, {alreadySaved:true})`
avoids re-queuing an autosave for a mid-save merge.

Since #69 the heartbeat is also a **pull** channel: `/api/presence` answers
`{docId, rev, here}`, and when that rev moves and no save is in flight
(`S.saveButtonBusy`, checked before the GET and again after it)
`pullServerDoc()` GETs the document once and merges through `applyMerge`.
No PUT, and no undo point — a pull fires whenever anybody saves, so one
snapshot per pull would fill the 50-entry history in under two minutes.
`pullServerDoc` therefore joins the list of `baseState` writers, via
`applyMerge`'s `newBase`. `stashLocalWork()` runs on the
lapsed-session path so unsaved edits survive; `applyStashedWork()` skips a
stash when `splitpage-server-resume` is present.

### 3.7 The server

`server/server.js` — plain Node, no dependencies, one file (~2,300 lines). One JSON file
per document in `DATA_DIR`.

- No identity of its own — Cloudflare Access decides who anybody is; the
  server only reads `Cf-Access-Authenticated-User-Email` for display.
- `JOIN_PIN` is a door lock: sha256 + `timingSafeEqual`, 10 wrong
  guesses/minute cap, refusal is `401 {error:"pin-required"}` JSON.
- CORS opt-in per origin, never carries credentials; `OPTIONS /api/*`
  answered 204 before any route runs.
- `/api/launcher/info` is loopback-only and launch-token-gated — launch
  token in the URL fragment, `HOST === "127.0.0.1"`. Any failing check is
  404, not 401 (invariant #28). It answers with this process's `root`,
  `platform` and `arch`, and the first-run wizard's step 2 uses it to name
  the folder this copy runs from. It used to have company: `register`
  spawned `installer/install.ps1 -InPlace` for a Start Menu entry, and
  `update/stage` spawned `update.mjs stage --json` for the update bar's
  Download button. #75 deleted both of those programs, so both routes went
  with them, along with `stageUpdate()` and `installedHere()` — this server
  no longer starts another process at all. The gating rules above stay as
  written: they are why a route here could exist, and anything that ever
  joins `info` inherits them.
- `REVIEW_PIN`/`REVIEW_KEY` are a second credential minting a second token
  with the role `review` (#30). Both are ignored without a `JOIN_PIN`. The
  role is read from the token on every request (`roleOf`), so it survives a
  reconnect and cannot be asserted by a client. **A review session never
  PUTs** (#71): `POST /api/docs/:id/comments` takes one new comment or reply
  from either role. **Reviewers never resolve or unresolve** (owner's
  decision): `PATCH /api/docs/:id/comments/:cid` is editor-only, and a
  review-role PATCH is a flat 403 `reviewers-cannot-resolve`, refused before
  its body is read. Authorship cannot be established — an author is a typed
  name and every reviewer on a link shares one token — so any resolve by a
  reviewer would be a resolve of somebody else's comment. The review client
  never sends a PATCH (a stray local resolve is put back to the server's,
  `dropLocalResolves` in 13-hosted.js), offers no Resolve button, and the
  click guard plus `toggleResolve()` itself refuse one. No client sends the
  PATCH today: editors resolve through PUT like every other edit. A
  review-role PUT is a flat 403 `review-only`, refused before its body is
  read. The whole-state
  proof that used to decide whether a review PUT changed "only comments" —
  `reviewWriteAllowed`, a key-by-key `deepEqual`, and the rest — is gone.
  What survives is `htmlTokens`/`fieldSignature`, now scoped to ONE field:
  the comments endpoint uses them to check that an anchor adds a
  `.cmt-anchor` span and changes no words, which plain string comparison
  cannot do (wrapping a selection across a `<strong>` splits it, and
  attributes may re-serialise in a different order). A stale anchor is not
  a refusal — it is dropped and the comment lands with `anchored:false`.
  The client adopts `home.rev` from a comments response only when it is the
  exact successor, so a collaborator's save in between is still pulled by
  the next heartbeat. Edit-role users keep PUT for everything, comments
  included. `GET /api/share` hands an editor the review LINK's key, never
  the PIN.
- `POST /api/presence` (#28) is a heartbeat and a listing in one round trip,
  in memory only, capped and swept per request, TTL 15s. It is behind the
  same gate but carries its own copy of it, because a closing tab's
  `sendBeacon` cannot set the token header. Presence is never part of a
  document and never touches one.
- Document ids whitelisted (`^[a-z0-9][a-z0-9-]{0,63}$`), not sanitised.
- Writes are temp-file-plus-rename, serialised per doc id (`withDocLock`).
  `Cache-Control: no-store` on every response except a blob's.
- **Images are content-addressed blobs** (#82). Bytes live at
  `DATA_DIR/blobs/<first 2 hex>/<sha256>`, written like a document (temp in
  the same dir, fsync, rename, fsync the dir — `writeFileDurable`), global
  across documents, never deleted (D4); a successful save or comment touches
  the mtime of every blob it names. The list route skips `blobs/` (it only
  reads `*.json`). `GET /api/health` carries `blobs: 1`. All three routes
  sit behind the token gate:
  - `GET /api/blobs/<sha>` (64 lowercase hex, else 400): raw bytes,
    `Content-Type` sniffed (png/jpeg/gif/webp only), `Cache-Control:
    private, max-age=31536000, immutable`, `ETag: "<sha>"` (304 on
    `If-None-Match`), `nosniff`, `CSP: default-src 'none'; sandbox`. A file
    whose bytes do not hash to its name is 404 and logged, not served.
  - `PUT /api/blobs/<sha>`, raw body: READ_ONLY 403, bad sha 400, declared
    length over `MAX_BLOB_BYTES` (8 MiB) 413 and a reviewer over budget 429
    `review-budget` — all four before the body is read (#74); then
    `hash-mismatch` 400, not png/jpeg/gif/webp (SVG included) 415
    `unsupported-type`, already stored 200 `{stored:false}`, else 201
    `{stored:true}`.
  - `POST /api/blobs/missing {shas:[≤2000]}` (256 KB body cap) →
    `{missing:[…]}`, both roles, READ_ONLY too.
  - **Who sees what.** Editors and the library-wide review token: every
    blob. A per-document review link: the shas its document's stored state
    names (`refsIn`, cached by doc id + rev) plus the shas it uploaded
    itself; anything else is 404 on GET and "missing" on `/missing` whether
    or not it exists, a PUT of such bytes is answered 201 `{stored:true}`
    (and charged) even when they were already here, and a comment naming
    one is 422. None of the four answers tells a link what the rest of the
    library holds.
  - **Reviewer budget.** Review tokens may PUT (screenshots in comments,
    D6) up to `REVIEW_BLOB_BUDGET_BYTES` (20 MiB) per token per rolling
    hour, each upload charged at least 4 KiB. The declared length is
    reserved before the body and settled to what was stored; a re-send of
    bytes the token could already see is free. The library-wide review
    token is one budget shared by everyone holding it. Editors are
    unmetered.
  - `refsIn(state)` counts `imageRef.sha256` / `imageValue.sha256` anywhere
    in the state and `data-blob="<sha>"` on any TAG in any string (comment
    and reply bodies, row HTML) — read through `htmlTokens`, so the same
    characters typed as words are not a ref.
  - **422 `{error:"missing-blobs", missing}`**: a document POST or PUT whose
    state names a sha that is not on disk, not already named by the stored
    document, and not listed in the request's `acceptMissing` array (after
    the token/role and the PUT's rev check, before anything is written); a
    comment or reply POST whose body names one (no `acceptMissing` there).
    The client uploads what is listed and retries. Legacy states carrying
    base64 images are accepted forever; `MAX_BODY` stays 25 MB.
  - **426 `{error:"client-too-old"}`** (D7): clients send
    `x-splitpage-client: 2` on every API call (listed in the CORS allowed
    headers). A document PUT without it, or with a lower number, is refused
    before its body when the STORED document names any blob — an older
    client cannot see those images and its save would drop them. A
    document with no refs is still saveable by an old client; a document
    that gains refs between the check and the write is caught by the rev
    compare-and-set. The comments POST is NOT gated: an old client's
    comment only appends, and its anchor HTML must match the stored field
    tag for tag, images included, or it is dropped as stale.

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
  `planHistoryEviction()` is no longer duplicated: #76 moved it, the meta
  sanitiser and the eviction constants into `shared/history-policy.js`,
  which both builds load — the browser through `03a-history-store.js`'s
  re-export, main through `APP_ROOT`. The smoke case that existed only to
  detect drift between the two copies went with them.
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
  side is `makeDesktopBlobBackend(bridge)` in `20f-desktop.js` (the page
  registry's `get`/`put`/`missing` interface; `put` rejects with
  `err.code`), and `makeFakeDesktopBackend({blobs:true})` fakes the three
  bridge calls for browser suites. The `--host` server keeps its own
  `DATA_DIR/blobs` (#82 D9).
- Duplicate document-id claims reassign in memory only (§4, #36).
  `chooseDuplicateLoser(a, b)` (now `shared/doc-id-policy.js`, #76): server
  home beats file home; birthtime is **not** consulted between two files —
  `atomicWrite` measurably moves NTFS birthtime on save — so the loser is
  decided by claim order instead. #76 deleted the `DUP_TRUST_BIRTHTIME =
  false` flag, the `stat` behind it and the deferral it forced; the verdict
  is unchanged and `caseAtomicSaveKeepsBirthtime` stays as the guard against
  a birthtime rule being written back in. The reassigned tab doesn't
  dirty/autosave.
- Launch args: `--library`, `--host`, `--pin [code]`, `--data DIR`,
  `--port`, `--allow-origin`, `--tunnel user@host [...]`. Files as
  arguments open through `routeOpenPath`; a second launch hands files to
  the running app.
- **Per-tab server connections** (#11). A tab's connection is its own
  page's `conn` (`src/js/_home.js`): `serverUrl` (`""` = this app's own
  server behind `splitpage://app/api`), `token`, `role`, `tunnel`. A server
  tab's `source` is `{kind:'server', serverDocId, serverUrl, tunnel}` and
  routing keys it by server AND id (`serverRouteKey`), so the same id on two
  servers is two tabs. `set-document-state` reports `serverUrl`/`tunnel`/
  `role` (never a token). `route-open` for a server document carries the
  asking tab's `serverUrl`, `token` and `tunnel`; a malformed address is
  refused. The token is held in memory **only in transit** — on a new
  tab's record until TAB-BOOT-SYNC hands it over as `connection`, then
  dropped; a this-tab route stores none. `desktop-state.json` gets
  `normalizeTabSource()`'s whitelist and never a token or role, so a
  restored tab boots on its own server and asks for the PIN again unless
  the reader chose "Remember on this device" for that server (the page's
  own per-server localStorage map). The teleprompter's Open in browser
  answers `REMOTE_SERVER` for a tab on someone else's server. A `tunnel` is
  host and ports only — the SSH forward the reader runs; nothing starts
  ssh for a tab. `--tunnel` is still its own single non-tab window.
- **Google Drive through a loopback OAuth redirect** (#10,
  `desktop/google-drive.js`, `main.js` §9c). The web build's Google
  Identity Services flow needs an http(s) origin; `splitpage://app` can
  never be one. So main owns the whole flow: a one-shot listener on
  `127.0.0.1:0`, PKCE S256 plus a random `state`, the consent URL handed to
  `shell.openExternal`, the code-for-token exchange, and every Drive
  request, to Google's fixed hosts only, no redirects followed. The first
  request to the listener's `/` is the callback — wrong `state` →
  `STATE_MISMATCH`, `error=` → `DENIED`, nothing in 5 minutes → `TIMEOUT`;
  the listener closes after it either way. A wrong Host header gets 421 and
  does not spend the callback. **Tokens:** the refresh token is written only
  as a `safeStorage` blob, `<userData>/google-drive-token.bin`; Linux's
  `basic_text` backend counts as unavailable, and then the token lives in
  memory for the session and the modal says so. The access token never
  leaves memory. Neither reaches the renderer, `desktop-state.json`, a
  draft, or the app-data export (those are written by code that cannot see
  this module's state). Sign-out revokes (5s, best effort) and deletes the
  blob. **Config**, read on every call: `SPLITPAGE_GOOGLE_CLIENT_ID` /
  `SPLITPAGE_GOOGLE_CLIENT_SECRET`, else `<userData>/google-oauth-client.json`
  — `{"client_id","client_secret"}` or the `{"installed":{…}}` file Google
  Cloud Console downloads, as is. A Desktop-type client's "secret" is not
  confidential (Google says so); it is config, not a credential. No
  in-modal client field, deliberately: it would be a renderer-supplied
  string steering where main signs in. **Channels** (all `invoke`, app
  origin): `drive-status`, `drive-sign-in`, `drive-sign-out` take nothing;
  `drive-list` and `drive-download` take a Drive id
  (`^[A-Za-z0-9_-]{1,200}$`, `root` = My Drive); `drive-upload` takes
  `{parentId, name, bytes, mimeType?}` (new file) or `{fileId, bytes,
  mimeType?}` (new revision), name ≤255 chars with no control characters,
  bytes ≤64 MB. Answers are `{ok, …}` or `{ok:false, code}`, never a token
  and never an exception's text. The modal (13-hosted.js) browses, downloads
  (a Google Doc as `.txt`) and uploads — an upload whose name matches one
  ordinary file in the folder replaces it; rename, delete and new folder
  stay web-only. **Test mode:** `SPLITPAGE_TEST_GOOGLE_BASE` points every
  endpoint at `desktop/test/fake-google.mjs`, honoured only under
  `SPLITPAGE_TEST=1` and refused by the module itself without `testMode`;
  `SPLITPAGE_TEST_DRIVE_BASIC_TEXT=1` lets a keyring-less Linux run use
  safeStorage's plain-text key so the stored-token path is exercised.
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
  reload/loop, duplicate-id reassignment, crash-safe drafts, the blob
  folder (#82). Runs on
  Windows and Linux since #89 — the dev target on both (under a virtual
  display on Linux), the packaged `.exe` targets on Windows only. macOS is
  written for but unrun. A check this platform cannot answer prints `SKIP`
  and is listed again in the run summary; it is never quietly dropped and
  never rewritten weaker.

### 3.14 Motion is a token layer, and `render()` stays synchronous

`src/app.css` defines one motion vocabulary on `:root` — `--dur-press`,
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

**`render()` must stay synchronous.** `04a-row-motion.js` animates scene
reorder/insert/delete/collapse with FLIP — measure, let render() do its
innerHTML swap, measure again, put things back with a transform and animate
it away. It is FLIP and *not* the View Transitions API for one reason:
`startViewTransition()` runs its callback asynchronously, and roughly 120
assertions across `tests/` read the DOM immediately after a click with
nothing in between. `withRowMotion(rowsEl, paint)` calls `paint` exactly
once, synchronously, and defers only the pixels.

Two traps it already works around:

- **Measure in document space**, not viewport space (`rect.top + scrollY`).
  `render()` refocuses the cell that had the caret, and focusing can scroll
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

`04b-busy.js` owns the only "something is happening" affordance in the app:
a 2px indeterminate bar at the top of the window. `withBusyBar(label, fn)`
wraps an async operation; the result and any thrown error pass straight
through, which matters because callers read `publishToServer()`'s
true/false. Currently wrapped: every export (they all funnel through
`exportAs`), publish, server save, the server document list, and the file
parse in `loadFileIntoEditor`.

Two things keep it from becoming noise. It is a **counter**, not a flag, so
overlapping operations raise it once and drop it once. And it does not
appear for `BUSY_SHOW_DELAY_MS` (250ms) — a bar that flashes up for 30ms
reads as a glitch, so most exports on most scripts show nothing at all.

It is **`withBusyBar`, not `withBusy`**: `20e-connect.js` already declares
`withBusy(button, label, work)`, and the fragments shared one function scope,
so the later file simply won. #66 ended that whole class of hazard — modules
have their own scope and a collision is now an esbuild error rather than a
silent last-one-wins — but the two names are still distinct functions and
still mean different things.

That scan turns up one pre-existing collision worth knowing about, left
alone here because it is outside a motion change and the suites are green
on it: **`saveInFlight` is declared three times** — `12-dirty-toast.js:14`
(the save-state indicator) and `14-export.js:481`, whose comment
("serialize auto-saves so two quick ones never overlap") plainly intends a
latch private to `queueAutoSave`. One scope, so it is one bit, and
`saveDoc()` sets and clears that same bit at `14-export.js:46`/`65`/`132`/
`166`/`182`/`248`. The effects look accidentally benign today — an autosave
queues behind a manual save, and the indicator lights during an autosave,
both arguably wanted — but `queueAutoSave`'s inner `saveDoc()` call clears
the latch on its own way out, so the serialization is not held by the
mechanism the comment describes. Anyone touching autosave or the save
indicator should give the two their own names first.

---

## 4. State schema

```jsonc
{
  "title": "string ≤300 chars",
  "schema": 2,                  // SCHEMA_VERSION — docId did NOT bump it (#35)
  "docId": "d0123…(32 hex)",    // /^d[0-9a-f]{32}$/, minted by migrateRows if missing
  "rev": 0,                     // the in-document merge counter (max-plus-one);
                                // conflict detection uses the server's own doc.rev
  "lastEditedBy": null, "lastEditedAt": null,
  "wordsPerMinute": 150,        // clamped 60–400
  "rows": [{ "id": "r1", "visualText": "sanitised HTML", "audioText": "sanitised HTML",
    "visualImage": "data: URI or null", "status": "todo | ready | shot",
    "updatedAt": "ISO", "updatedBy": "name" }],
  "comments": [{ "id": "c1", "rowId": "r1", "field": "audioText | visualText | visualImage",
    "anchorId": "c1", "quotedText": "plain text", "author": "name", "body": "sanitised HTML",
    "resolved": false, "resolvedBy": "name or null", "resolvedAt": "ISO or null",
    "assignee": "name or ''", "kind": "anchor | conflict", "createdAt": "ISO", "updatedAt": "ISO",
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
28. **No HTTP endpoint spawns a process or installs files.** No exception:
    `server/server.js` does not require `node:child_process` at all. There
    used to be one — `/api/launcher/*`, loopback-only and launch-token-gated
    (§3.7) — where `register` ran `installer/install.ps1` and `update/stage`
    ran `update.mjs stage --json`. #75 deleted both of those programs and
    both routes went with them; all that is left under `/api/launcher/` is
    `info`, which reports this process's own `root`, `platform` and `arch`
    and nothing else. The gate stays on it, and anything ever added beside
    it inherits the gate: a missing lock answers 404, not 401. In the
    desktop app the equivalent
    pair is `splitpage:update-download` / `splitpage:update-install`, and
    neither takes an argument: the renderer can ask for the update to be
    fetched and run, but never names the URL to fetch or the file to
    execute (main picked both from the release it checked).
    `splitpage:prompter-open-in-browser` (#86) follows the same rule: no
    arguments at all. Main builds the loopback URL from the calling tab's
    own record — the path it registered, or the server document id it
    holds — so a compromised page can at worst open a loopback page of this
    app showing a document that tab already has open. The script is served
    from memory by `desktop/prompter-share.js` behind a 256-bit token in the
    URL fragment and a Host-header check; no temp file is ever written, so
    a crash leaves nothing on disk.
    Google Drive (#10) is the third application of it. Signing in, signing
    out and asking for status take no argument: the page never names the
    consent URL, the redirect address or the client, so it cannot point the
    browser anywhere or steer the code to a listener of its own. The Drive
    calls take the least that says WHICH folder or file — a Drive id, or an
    upload's name and bytes — validated in `desktop/google-drive.js`, and
    main builds every request against Google's fixed hosts. No answer
    carries a token. So a compromised page can at worst read and write the
    signed-in person's Drive through main while it runs — what the Drive
    modal does anyway — and can never take the credential out of the app.
    The alternative, handing the page a short-lived access token so it
    could call Drive itself, was rejected for exactly that last reason.
    The blob folder (#82) is the fourth. The page names a blob by the
    SHA-256 of its bytes and nothing else — `sha256` is a typed argument
    (64 lowercase hex), so a path, a URL or a `..` is refused by the table
    before a handler runs, and main builds `sha256/<aa>/<sha>` under its own
    `userData`. Answers carry shas, bytes and a sniffed mime, never a path.
    A put must hash to its sha and be a raster image, so a compromised page
    can at worst add images to the folder (up to 16 MiB each) and read back
    ones it already knows the sha of — it cannot name a file, read anything
    outside the folder, or plant an SVG that a later page would render.
29. **The join PIN, session token, and launch token never enter
    `update-status.json`, the document, or any file the static handler
    serves.** Client side: everything about connecting to a server is
    browser state, never `state`. A bookmark never carries a password, key,
    or passphrase. Since #11 the same holds for `desktop-state.json` and a
    draft header: a server tab's persisted source is `{kind, serverDocId,
    serverUrl, tunnel}` and nothing else, and a token only ever sits in
    main's memory between a route-open and the new tab's boot.
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
    runs ~2s after it exits, into the same folder. `installer/uninstall.ps1`
    is gone from this repo (#75), but it is still on every machine that
    installed 1.0.x, which is exactly who this macro runs for:
    `desktop/build/installer.nsh` keeps it.
51. **Autosave writes only where the user has already sent this document,
    and only work they have seen.** `autoSaveTarget()` (14-export.js) is the
    single gate: a file handle the user picked, or the server — never a
    picker, never a download. Anything that puts work on screen the user has
    not reviewed (a crash-draft restore's merge, `reportMerge`'s
    `noAutoSave`) calls `haltAutoSave()`, and only an explicit Save starts
    the automatic writes again (#41). A failed or conflicted automatic save
    halts too, rather than repeating a toast or a modal every two seconds.
52. **No durable record names a blob its store does not already hold
    durably** (#82). An image is uploaded (and fsynced) before anything
    that refers to it by sha is written. On the server that is the 422
    `missing-blobs` check on document POST/PUT and on the comments POST
    (§3.7); `acceptMissing` is the one deliberate exception, for a sha the
    client knows is lost for good, so a missing picture can never make a
    script unsaveable.

---

## 6. Map of the source

`src/js/` (41 modules; filenames say where things live, and still set
evaluation order via `_entry.js`):

| Fragment | What is in it |
| --- | --- |
| `_state.js` | the 54 cross-module mutable vars, as one exported object `S` |
| `_home.js` | where the document lives: the one tagged `home` record (`none` / `file` / `import` / `server`) and `setHome()`, its only writer (#73); and this tab's connection `conn` (`serverUrl`, `token`, `role`, `tunnel`) with `setConnection()` / `updateConnection()` — a server home holds `conn` itself (#11) |
| `_entry.js` | the bundle entry: calls every module's `__init()` in order |
| `00-prelude.js` | `PAGE_SHELL`, module-wide vars |
| `01-scene-status.js` | scene status and runtime estimates |
| `02-state.js` | `defaultState`, `migrateRows`, `legacyMdToHtml`, `buildPublishHtml` |
| `02b-doc-id.js` | document id: `DOC_ID_RE`, `mintDocId`, frozen `sha256Hex`/`deriveDocId`, `mergedDocId`, `reassignDocId`, duplicate-claim BroadcastChannel |
| `03-sync.js` | identity, `mergeStates`, save loop, restore/undo-merge |
| `03a-history-store.js` | per-document version history, IndexedDB store, Older-bucket migration, `planHistoryEviction`, import/export |
| `04-richtext.js` | `walkSanitize`, html→markdown, video link cards |
| `04a-row-motion.js` | FLIP for `#rows`: `withRowMotion` wraps render()'s innerHTML swap, measures before and after in document space, animates what moved (§3.14) |
| `04b-busy.js` | the one loading indicator: `beginBusy`/`endBusy`/`withBusyBar`, the delayed top bar (§3.15) |
| `05-render.js` | `rowHtml`, `render`, field sync, rich-text commands |
| `06-rows.js` | row add/move/drag, images |
| `07-production-tags.js` | tag registry, people, tagging, autocomplete, untagged mentions |
| `08-production-panels.js` | production and gear panels, multi-select, breakdown |
| `09-find-replace.js` | find & replace |
| `10-comments.js` | comments: composer, panel, cards |
| `11-import.js` | paste import, two-column detection, `parseMarkdownTable`, Google Doc import |
| `12-dirty-toast.js` | dirty flag, toasts, draft-change hook, save-state indicator (`updateSaveStatus`) |
| `13-hosted.js` | server detection, picker, compare-and-set save, the review role (#30), Google Drive files, "Publish & copy a link" + `?doc=` (issue #19) |
| `13a-presence.js` | who else is in a hosted document (#28) — heartbeat, header initials, gutter/field marks |
| `14-export.js` | `saveDoc`, autosave (`autoSaveTarget`, `scheduleAutoSave`, `queueAutoSave`, `haltAutoSave`), Markdown writers, zip writer, `adoptSavedCopyDocId` |
| `15-docx.js` | .docx read/write, narration-only export |
| `16-csv.js` | csv |
| `17-pdf.js` | pdf, packing lists |
| `18-local-files.js` | `openProjectFile`/`adoptProjectState`, save-back, File menu dispatch |
| `18a-local-merge.js` | the on-disk conflict modal's "Merge them": the mergeable-file probe, the retained ancestor (`diskBase`), the field-by-field review pane and its word-level diff |
| `19-writer.js` | the writer (word-processor view of the audio column) |
| `20-teleprompter.js` | teleprompter and voice follow |
| `20a-update.js` | update notice (desktop: Download/Install; portable: release-page signpost), desktop-app notice, About box |
| `20b-onboarding.js` | first-run wizard, pristine-seed gate (invariant #30) |
| `20c-help.js` | in-app Help modal, coach-mark tour |
| `20d-formats.js` | the two document formats, hand-edit reconcile |
| `20e-connect.js` | join-PIN dialog, server bookmarks, SSH helper |
| `20h-appdata.js` | app-data export/import: `assertNoSecrets` (#48), `importAppData` (#49) |
| `20f-desktop.js` | desktop glue, inert unless `DESKTOP` set: bridge wrapper, tab-boot-sync handling, native-menu dispatcher |
| `20g-drafts.js` | crash-safe draft renderer: writer/idle-flush loop, `applyTakenDraft`, `sameDocContent` |
| `20j-newtab.js` | the New Tab page: its gate, the blank document, the two choices, the desktop recents column (DESKTOP-RECENTS, issue #15) |
| `21-events.js` | all event wiring, `init()` |

**Desktop files** (optional; the web app runs without them):

| File | What is in it |
| --- | --- |
| `desktop/main.js` | Electron main: scheme handlers, windows/tabs registries, route-open dedupe, close/quit lifecycle, session restore, recent documents (DESKTOP-RECENTS), doc-id claim table, history storage + fsck (policy from `shared/history-policy.js`), draft headers, file dialogs, server launcher, native menus, test mode |
| `desktop/preload.js` | preload for `splitpage://app`: origin-gated `window.splitpageDesktop` bridge |
| `desktop/tabstrip-preload.js` | preload for `splitpage://tabstrip` only — no file/draft/history methods (#43) |
| `desktop/tabstrip/` | title-bar tab strip: `tabstrip.css`/`.js`/`index.html`, served only under `TABSTRIP_ALLOWLIST` |
| `desktop/drafts.js` | crash-safe draft store, plain CommonJS, no Electron dependency (§3.13, #40–#41) |
| `desktop/blob-store.js` | content-addressed blob folder (`<userData>/blobs`, images since #82), plain CommonJS, no Electron dependency; also the IPC door's image rule (§3.13) |
| `desktop/google-drive.js` | Google Drive for the desktop app: loopback OAuth listener + PKCE, token storage (safeStorage), Drive list/download/upload, plain CommonJS, no Electron dependency (§3.13, #10) |
| `desktop/test/google-drive.test.mjs` | unit suite for `desktop/google-drive.js` against `desktop/test/fake-google.mjs` (a strict fake of Google's token, revoke and Drive endpoints, shared with smoke.mjs); also checks every `./module` main.js requires is in electron-builder.yml's `files` |
| `desktop/.npmrc` | pins `npm install` to native ARM64 Electron (§2) |
| `desktop/electron-builder.yml` | packaging config, x64 + ARM64 Windows |
| `desktop/build/installer.nsh` | NSIS include: "Splitpage (shared session)" Start Menu shortcut (`--host --pin`) |
| `desktop/stage.mjs` | build step: runs `build.mjs`, verifies version, stages files for packaging |
| `desktop/verify-dist.mjs` | post-`dist:win` check: PE machine field per binary, NSIS stub arch, installer freshness, installer payload actually extracts (#6) |
| `desktop/verify-dist-payload.mjs` | verify-dist.mjs's payload-extraction half: pulls the app package back out of a built setup.exe with 7z.exe + 7za and diffs its top-level PE files against the unpacked dir (#6) |
| `desktop/test/smoke.mjs` | integration suite over CDP (§3.13) |
| `desktop/test/drafts.test.mjs` | unit suite for `desktop/drafts.js` alone |
| `desktop/test/blob-store.test.mjs` | unit suite for `desktop/blob-store.js` alone (atomic put, hash checks, damaged-file delete, temp sweep, the image rule) |
| `desktop/test/verify-dist-payload.test.mjs` | unit suite for verify-dist-payload.mjs's comparison logic, no 7-Zip or real build needed (#6) |
| `.claude/skills/run-splitpage-app/driver.ps1` | the test driver: static server + headless Edge over CDP, Windows only (§2) |
| `.claude/skills/run-splitpage-app/driver.mjs` | the same driver in Node, for the cloud container — same suites, same output (§2) |

Other source: `src/page.html` (shell), `src/app.css` (visual),
`src/seed-state.json` (demo document). `docs/help.md` is a build input too —
`build.mjs`'s `mdToHtml()` renders it into the Help modal at build time. It
was `README.md` until #80, with developer-only sections fenced off by
`<!-- help:skip-start/end -->` markers; splitting the user guide out into its
own file retired the markers, and means editing the repo's README no longer
rebuilds the app. An HTML comment left loose in `docs/help.md` now renders as
visible text on the Help page — keep any inside a fenced code block.

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
the same pieces by matching each base piece's first line as a unique
anchor; `git merge-file` each piece against its base; normalise trailing
newlines first; rebuild and read every **removal** in the diff against
main's `index.html` — a removal you can't name is main's work being dropped.

Since #66 the bundled `index.html` is minified, so this recipe no longer
applies to anything built from this branch: the two sides are no longer the
same shape of text. Re-derive it if it is ever needed again.

---

## 7. Current status

Status, verification history, and step-by-step state live in the plan
file's Progress table, not here:
`C:\Users\Adam\.claude\plans\breezy-booping-toucan.md`. Read it before
picking up any work on this branch.

---

## 8. Where to pick up

**Bugs and features live in GitHub Issues** —
https://github.com/RetroGorilla/splitpage/issues. That is the tracker: open
one before starting work, close it with the commit that fixes it
(`Fixes #12` in the message), and don't keep a second list in a Markdown
file. Labels: `bug` / `enhancement` for the kind, `area:*` (editor,
desktop, installer, server, export, ui) for where it lives,
`needs-decision` for anything waiting on Adam, `blocked` for work that
can't start yet. Issue forms are in `.github/ISSUE_TEMPLATE/`.

Longer-range sequencing and the pending decisions for Adam are
tracked in the plan file, not here:
`C:\Users\Adam\.claude\plans\breezy-booping-toucan.md`. Follow My Voice on
desktop is paused pending a fresh look (parked files under
`.cache/voice-parked/`, plan companion `breezy-booping-toucan-VL.md` for an
opt-in local model, not yet approved). Google Drive via loopback OAuth is
built (#10, §3.13) and tested against a fake Google; it has never signed in
to the real one, because that needs a Desktop-type OAuth client ID from a
Google Cloud project only Adam can create — the by-hand check is in
`docs/WINDOWS-CHECKS.md` §3. Per-tab server/tunnel connections are built (#11,
§3.13).

**Decided and changed (issue #7):** opening a `.docx`/`.md`/`.txt`/`.csv`
starts a **new document** — `loadFileIntoEditor` (`src/js/18-local-files.js`)
now builds a fresh state through `migrateRows()`, so the document gets a new
`docId` and empty `productionTags`, `people`, `brollShots` and `comments`,
and its home becomes the imported file (`setHome("import")`,
`src/js/_home.js`), which replaces either Save target. It used to replace only `state.rows` and the title and keep the rest, which meant an
unrelated Word file inherited the last script's breakdown, cast list and
review comments, and Save still pointed at the previous project's file.

"Draft 2 of the same script" — the workflow that behaviour was useful for —
is the **Paste/Import modal** (`openImportModal`, `src/js/11-import.js`),
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
path on read. `recentDocuments` in `desktop/main.js` is the authority once
the process is up (`loadRecentsAtLaunch` at `whenReady`, and
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
on. The column itself is in `src/js/20j-newtab.js`.

**A share link (issue #19).** The standalone HTML export stays a dead copy
by design — `standaloneHtmlFor` still strips `docId`, and nothing in the
export connects anywhere. What was added is the delivery half:
`publishAndCopyShareLink()` (`src/js/13-hosted.js`) publishes to the
connected server (saving first if the document is already hosted), copies
`<server>/?doc=<id>`, and names what the recipient will be asked for. With
no server it refuses and opens **Servers…** instead. The other end is
`readSharedDocParam()`, which reads `?doc=` once at boot, strips it from the
bar, and opens that document after the server has answered — but only if
`resumeServerDoc()` did not already claim the page, since a crash draft or a
lapsed sign-in is unsaved work that must not be replaced.

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
