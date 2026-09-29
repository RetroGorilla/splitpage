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
it, with `sw.js`, `manifest.webmanifest`, the icons, `VERSION`, `server/`
and `Dockerfile.prebuilt`, as the `splitpage-app` artifact, arranged so the
download is itself a working `docker build -f Dockerfile.prebuilt` context
(DEPLOY.md §8). The upload is the last step, so an artifact only exists for a
run whose checks all passed.

The owner's server does not use the artifact. `deploy.sh` pulls `main` and
builds the root `Dockerfile`, which is two-stage: `npm ci` + `node build.mjs`
in a `node:22-alpine` build stage, then only the built `index.html`/`sw.js`,
the static files, `VERSION` and `server/` in the runtime stage. Docker is not
on the Windows machine, so `.github/workflows/docker.yml` is where that image
is really built: `bash -n` and shellcheck over `deploy.sh`, a legacy-builder
`docker build`, then the container started as `99:100` with the settings
`deploy.sh` insists on, checked through `/api/health` (VERSION, `links`,
`linksPersist`), its own HEALTHCHECK and an owner sign-in that must survive a
restart. It runs only when a deploy-relevant file changes (its `paths:`).

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

A comment or reply box (`isDraftBox`, `05d-draft-edit.js`) is edited through
the document model like a script cell — `throughModel` in 05-render.js sends
a format, a link or Enter to `editCell` or `editDraft` — but it is not the
document: its pictures and video cards ride through the model as
placeholder characters, and Ctrl+Z there is the box's own history, never the
document's and never the browser's (invariant #55). No edit uses
`execCommand` any more.

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

`server/server.js` — plain Node, no dependencies, one file (~2,850 lines). One JSON file
per document in `DATA_DIR`.

- No identity of its own — `Cf-Access-Authenticated-User-Email` is read for
  display and attribution only. Without Access in front it is whatever the
  caller wrote (as trustworthy as the `by` in every write body), so nothing
  that decides what a token may do ever reads it.
- **Two shapes, one file.** No `JOIN_PIN`: open, everyone the owner, meant
  for behind Cloudflare Access or a VPN. `JOIN_PIN` set: a short code on a
  LAN (the desktop app's `--host`, `start.mjs`), or — with a long random key,
  `PERSIST_LINKS=1` and TLS in front (Adam's Unraid box behind a Cloudflare
  tunnel, NO Access) — the owner's key to a server that faces the internet on
  its own, with guests on per-document invite links. The gate at the top of
  `handleApi()` is the one place that decides what a token reaches.
- `JOIN_PIN` → the **owner token**: sha256 + `timingSafeEqual`, refusal is
  `401 {error:"pin-required"}` JSON. 10 wrong guesses/minute per address;
  only the join PIN itself clears an address's count — a link key or the
  review code used to as well, and every guest holds one, so a reviewer could
  walk six digits to the editor's PIN at 90% speed (9 wrong, 1 good join,
  repeat). Without `PERSIST_LINKS` the owner token is random per process (a
  restart signs everyone out, as always). With it, it is
  `HMAC-SHA256(secret, "owner\0" + JOIN_PIN)`, the secret in
  `DATA_DIR/links/secret`: a redeploy keeps the owner signed in, changing
  `JOIN_PIN` signs every owner device out. `PERSIST_LINKS=1` with a
  `JOIN_PIN` under 20 characters prints a loud startup WARNING (an
  internet-facing server with a guessable key); a LAN PIN does not.
- **Who the limiter counts** (#74): the socket; `TRUST_PROXY=1` → the first
  `X-Forwarded-For` entry (for a proxy that REPLACES the header);
  `TRUST_PROXY=cloudflare` → `Cf-Connecting-Ip`, which Cloudflare overwrites.
  Behind Cloudflare `=1` is spoofable: Cloudflare APPENDS to a client-sent
  X-Forwarded-For, so its first entry is the guesser's to choose — a fresh
  bucket per guess. Junk (or a comma list) in either header falls back to
  the socket. Any other `TRUST_PROXY` value is ignored with a warning (`0`
  silently).
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
- `REVIEW_PIN`/`REVIEW_KEY` are a second, LIBRARY-wide credential minting a
  second token with the role `review` (#30), unscoped, random per process
  even under `PERSIST_LINKS` (it belongs to the launcher's LAN session, the
  only thing that sets it). Both are ignored without a `JOIN_PIN`. Role and
  scope are read from the token on every request (`sessionOfToken`), so they
  survive a reconnect and cannot be asserted by a client. **A review session never
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
  included. `GET /api/share?doc=<id>` (owner only) is kept for older clients:
  it is get-or-create that document's REVIEW link from the store below,
  answered `{reviewAvailable:true, reviewKey, docId}` — never the PIN.
- **Invite links: the link store** (replaced #63's in-memory
  `reviewGrantFor`/`reviewGrantsBy*`/`reviewScopeByToken`). A link is
  `{id (12 hex), key (24 random bytes hex — what the URL carries), token (32
  bytes hex — what join hands back), docId, role "edit"|"review", createdAt,
  createdBy}`, at most ONE active per (docId, role), looked up through Maps
  (`linkByKey`, `linkByToken`, `linkByDocRole`) so the gate is O(1). Revoking
  leaves a tombstone of `sha256(key)` and `sha256(token)` — never either
  itself — capped at 2000, oldest dropped. Links need only a `JOIN_PIN`
  (not a review code), which is why `/api/health`'s `reviewAvailable` is now
  `!!JOIN_PIN`; health also says `links: 1` and `linksPersist`.
  - **Where it lives.** Without `PERSIST_LINKS`: memory only, a restart
    cancels every link and token (the LAN sessions, unchanged in lifetime).
    With `PERSIST_LINKS=1`: `DATA_DIR/links/` (0700) holding `secret` and
    `links.json` (both 0600, the mode set when the temp file is CREATED via
    `writeFileDurable(…, mode)`), rewritten whole on every change through a
    one-at-a-time chain that writes the store as it is when the write RUNS.
    On disk BEFORE a new key is handed out (a failed write drops the new
    link) or a revoke is confirmed. An unreadable `secret` or `links.json`
    stops the server at startup rather than being silently replaced (that
    would sign the owner out / drop every link). `links/` does not end in
    `.json`, so the list skips it; the static handler refuses all of
    `DATA_DIR`. The file holds keys and tokens in the clear: it must hold
    keys (the owner copies a link again) and a key mints its token on
    request, so hashing tokens there would protect nothing.
  - **Join** (`POST /api/join`): `{pin}` = JOIN_PIN → `{token, role:"edit"}`;
    `{key}` of an active link → `{token, role, docId, scope: docId}`; a
    tombstoned key → **410 `link-off`**, NOT counted as a guess (a dead
    link re-opened is not an attack, and must not lock out the house);
    library review code/key unchanged; else 401 `bad-pin`, counted.
  - **The gate.** `sessionOfToken` → `{role, scope, token}` (scope "" for
    the owner and the library review token), `{revoked:true}` for a
    tombstoned token → **401 `link-off`** (header or beacon body; the page
    tells a guest "this link was switched off" instead of asking for a PIN
    they never had), or null → 401 `pin-required`. A SCOPED token (either
    role): `GET /api/docs` lists only its document; any `/api/docs/:id…` on
    another id → 403 `wrong-document`, before the body; `POST /api/docs`
    → 403 `owner-only` for a scoped edit (review keeps `review-only`);
    `DELETE /api/docs/:id` (any id, its own included), the links API and
    `/api/share` → 403 `owner-only`; `POST /api/presence` on another docId
    → 403 `wrong-document` (it used to check no scope at all — a link could
    read who was in any document and its rev). A scoped EDIT token PUTs
    its own document through the ordinary compare-and-set/409/426/422 path
    and may PATCH-resolve its comments. `GET /api/me` →
    `{role, scope, email, name}`.
  - **Links API** (`handleLinks`, owner only = unscoped edit; else 403
    `owner-only`; no JOIN_PIN → 409 `no-pin`): `GET /api/docs/:id/links` →
    `{links:[{id, role, key, createdAt}]}` (active only; answers even for a
    document removed by hand, so its links can still be revoked);
    `POST {role, replace?}` (8 KB cap) → the active link (200) or a new one
    (201), `replace:true` revokes first and always mints; 400 `bad-role`,
    404 `not-found` (no such document), 403 `read-only` for an EDIT link
    under READ_ONLY (review links and revokes still work); runs under the
    document's lock so it cannot race a DELETE. `DELETE …/links/:linkId` →
    `{ok:true}`, off from the token's next request; 404 **`no-such-link`**
    (not `not-found`, which the client reads as "the script is gone").
    Deleting a document revokes its links first, persisted before the
    unlink. The token is never in any answer here. Placed above the
    comment/read/save routes, and any OTHER sub-path under a document is now
    404 — it used to be answered as the document itself, so a `DELETE` one
    letter off `/links/…` deleted the script.
- `POST /api/presence` (#28) is a heartbeat and a listing in one round trip,
  in memory only, capped and swept per request, TTL 15s. It is behind the
  same gate but carries its own copy of it, because a closing tab's
  `sendBeacon` cannot set the token header — including `link-off` and a
  link's scope (403 `wrong-document` for another docId). Presence is never
  part of a document and never touches one.
- Document ids whitelisted (`^[a-z0-9][a-z0-9-]{0,63}$`), not sanitised.
- Writes are temp-file-plus-rename, serialised per doc id (`withDocLock`).
  `Cache-Control: no-store` on every response except a blob's.
- **What an internet-facing server must not do** (found reviewing for the
  Unraid deployment). A request line of `GET //` threw in `new URL()`
  outside every handler — an uncaught exception, one request from anyone
  took the process down; now 400. A token or launch header with a non-ASCII
  byte reached `timingSafeEqual` with mismatched BYTE lengths (the string
  lengths matched) and threw — a 500 plus a stack trace per request;
  `sameToken` compares bytes now. The static handler refuses anything under
  `DATA_DIR` by real path, case-folded on Windows/macOS (`insideDataDir`):
  `start.mjs` serves its whole folder with the library in `data/` beneath
  it, so `GET /data/<id>.json` handed any document to anyone on the LAN,
  PIN or no PIN. And nothing whose path has a segment starting with `.`
  (`.git/config`, `.env` in a checkout).
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
    length over `MAX_BLOB_BYTES` (8 MiB) 413 and a metered guest over budget
    429 `review-budget` — all four before the body is read (#74); then
    `hash-mismatch` 400, not png/jpeg/gif/webp (SVG included) 415
    `unsupported-type`, already stored 200 `{stored:false}`, else 201
    `{stored:true}`.
  - `POST /api/blobs/missing {shas:[≤2000]}` (256 KB body cap) →
    `{missing:[…]}`, both roles, READ_ONLY too.
  - **Who sees what** (`blobVisibility(session)`). The owner and the
    library-wide review token: every blob. A per-document link of EITHER
    role: the shas its document's stored state names (`refsIn`, cached by
    doc id + rev) plus the shas it uploaded itself; anything else is 404 on
    GET and "missing" on `/missing` whether or not it exists, a PUT of such
    bytes is answered 201 `{stored:true}` (and charged) even when they were
    already here, and a comment naming one is 422 — and so, for an edit
    link, is a document PUT naming one (`refusedRefs(…, visible)`); the
    client uploads it, after which it is the link's own. None of these
    answers tells a link what the rest of the library holds. Residual: an
    edit link that already KNOWS a sha can put it in `acceptMissing`, save,
    and then learn from a GET whether the library holds those bytes — which
    needs the image's hash, i.e. effectively the image.
  - **Guest budgets** (`blobLedgers`, per token per rolling hour, each
    upload charged at least 4 KiB): review tokens `REVIEW_BLOB_BUDGET_BYTES`
    (20 MiB; screenshots in comments, D6), scoped edit tokens
    `LINK_EDIT_BLOB_BUDGET_BYTES` (100 MiB; stills in its one script). Over
    either is 429 `review-budget` — the code the client already words as
    "this link's image allowance is used up". The declared length is
    reserved before the body and settled to what was stored; a re-send of
    bytes the token could already see is free. The library-wide review
    token is one budget shared by everyone holding it. The owner is
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
  - **The client's half** (13-hosted.js, #82 P5). `apiFetch` sends
    `x-splitpage-client: 2` on every call (`fetchBlob` and `launcherFetch`
    too; `joinServer` in 20e-connect.js and the presence `sendBeacon` do
    not — neither route is gated and a beacon cannot carry headers).
    `/api/health`'s answer is kept per connection (`capsOf(conn)`, a
    WeakMap keyed by the `conn` record, so pointing the tab elsewhere
    forgets it); `blobs: 1` is what lets refs go to the server
    (`serverTakesBlobs`). A server on another origin that predates the
    header refuses it in its preflight, which looks like "offline":
    `probeHealth` asks once more without it and, if that answers without
    `blobs`, leaves it off for that connection. Every write that can name a
    blob — `saveToServer`'s PUT, `publishToServer`'s POST, a reviewer's
    comment/reply POST (`sendReviewRequest`, body only) — goes through
    `sendWithBlobs`: refs = `refsIn(state)`; none → the write as before; a
    server without `blobs` → the images INLINE in the copy sent (row
    `visualImage` data URIs, `<img src="data:…">`; the page keeps its
    refs); otherwise `POST missing` → `PUT api/blobs/<sha>` per missing one
    (raw bytes from the registry or the local store, `ensureBytes(…,
    {remote:false})`) → the write. A 422 uploads what it lists and retries
    ONCE, outside the 409 rounds; a sha with no bytes anywhere goes in
    `acceptMissing` for a document write and is a permanent refusal for a
    comment. `apiFetch` names the answers: `missing-blobs` (with
    `payload.missing`), `client-too-old` (426), `review-budget` (429),
    `blob-too-large` (413 on an upload, JSON or not), `blob-unsupported`
    (415); `handleApiError` toasts each. 426 latches `clientTooOld` like a
    lapsed sign-in — stash, one sticky "This page is out of date … Reload"
    toast, no further saves — and is neither a conflict nor a sign-out.
    Bytes come back through `fetchBlob(sha)` (its own `fetch`: a 200 is
    raw bytes, which `apiFetch` would call signed out), re-hashed by the
    registry's `intern` and refused on a mismatch; 13-hosted installs it
    as 02c's remote source (`setRemoteSource`, asked by `ensureBytes` after
    the local backend, only while a server document is open). Suite
    `tests/66-hosted-blobs.txt`.

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
glue space stays inside a comment both sides are in). `caretAtEdge()` must not count empty inline wrappers —
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
each half written back with `toHtml`, the comments re-pointed by
`syncCommentAnchors` (invariant #18) — one undo entry with the caller's
`markDirty()`. A cell still holding a picture (pasted before design D7) is
the one case still cut by a DOM range. Alt+Enter never reaches `onRootKeydown` inside the
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
  crash/kill/session-end/quit. `buildDraftHeader` (`main.js:807`) is built
  only by main from allowlisted scalar fields, never a PIN/token (#29).
- **The browser keeps drafts too, for server documents only** (PR #233 —
  a Collaborate guest has no desktop app). `20g-drafts.js` is one writer
  and one restore over a pluggable backend: `S.DESKTOP` → the bridge
  above; otherwise `03d-drafts-idb.js` (IndexedDB `splitpage-drafts` v1:
  `meta` + `bodies`, keyPath `key`), live only while the page's document
  is on a server and not in review mode (`browserDraftTarget`). Same
  triggers, throttle, dedup, NEED_BASE handshake, blobs-first and backoff
  as the desktop. ONE DRAFT PER DOCUMENT, not per tab: key
  `browserDraftKey(draftBaseOf(serverUrl), serverDocId)` — the base is
  origin + folder only (no query, fragment or user), so no token or link
  key can ride in; the record is the document, its ancestor and scalars
  (`rev`, `title`, `writerId`, …), never a credential (#29, #62). Each page
  has a random `writerId` and holds the Web Lock
  `splitpage-draft-writer-<id>` while showing (let go on `pagehide` — a page
  in the back-forward cache would otherwise look alive); a page removes only
  its own draft, and a draft whose writer is live is never "recovered". No
  launch hands a draft back, so it is looked for when a server document is
  about to open: `finishServerDetect()` for `conn.scope || ?doc= || the
  join's doc`, before `resumeServerDoc()` (so it beats an older
  sessionStorage stash, as the desktop's does), and `openServerDoc(id)` for
  the picker. Found → `armServerDraftResume()` + `applyTakenDraft()`, i.e.
  the desktop's `restoreServerDraft` path: merged with the draft's own base,
  "Undo merge" armed, `noAutoSave` (the chip says "not saved yet"). A link
  found off on a later load (`flagLinkOff`, nothing of the reader's on
  screen) opens the kept draft as an unsaved copy
  (`offerBrowserDraftAfterLinkOff`), which keeps writing that same draft
  (`browserCopyOf`, `keepBase`) until it is saved somewhere. Bounds: 30
  days, 20 drafts, 64 MiB, oldest first, inside each put. No IndexedDB →
  `UNAVAILABLE`, the writer stops with nothing on screen; a full quota says
  "this browser's storage is full". An unreachable server at load does NOT
  open the draft as a copy (unlike the desktop): the harness and a flaky
  start look alike, so it waits for the next load that reaches the server.
  Untitled scripts and local files are still desktop-only.
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
  side is `makeDesktopBlobBackend(bridge)` in `20f-desktop.js` (the page
  registry's `get`/`put`/`missing` interface; `put` rejects with
  `err.code`), and `makeFakeDesktopBackend({blobs:true})` fakes the three
  bridge calls for browser suites. The `--host` server keeps its own
  `DATA_DIR/blobs` (#82 D9).
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
`tests/150-mode-transitions.txt` slows the fades by setting the tokens inline
on the two elements and checks all of it.

**`render()` must stay synchronous.** `04a-row-motion.js` animates scene
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

### 3.16 `render()` reconciles `#rows`; `renderRow()` repaints one row

Until #84 every `render()` rebuilt all of `#rows` through `innerHTML`, so a
structural change anywhere (add, delete, move, a comment posted, a tag
applied) cost every row, and the focused cell came back with its caret at
the end. Now:

- **A row is five parts** — its class, gutter, visual media and two fields —
  built by `rowParts()` in `05-render.js`. The part strings are the change
  detection: each row element carries the parts it was last painted from
  (an expando, never an attribute), and a part whose freshly built string is
  identical is not touched. `rowHtml()` is those parts joined, byte for byte
  what it always produced.
- **`render()`** keys `#rows` by row id (a shot strip by the ids it covers —
  `rowGroupItems()` in `01b-hide-shot.js`, the same key `04a-row-motion.js`
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
  pending on `scheduleIdleRefresh()` (`07-production-tags.js`): one 180ms
  debounce, capped at 1s of unbroken typing, runs everything pending against
  one production index (§3.4). They used to be four timers (180/200/220/400ms)
  each deriving the breakdown for itself.

What a rebuild used to give for free and a reconcile has to do on purpose:
`render()` still re-applies `ensureTrailingCaretSpot()` to every field, puts
the presence marks back (a repainted gutter or field-wrap took its mark with
it), disarms an armed row delete, and drops a saved link-popover Range only
if its cell is gone. `tests/67-render-perf.txt` holds the numbers: typing in a
300-scene document renders nothing and derives the breakdown once per idle
refresh; an insert elsewhere keeps the focused cell's node and caret and
builds two fields.

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
  "targetSeconds": 120,         // #170 — whole seconds 1–86400, ABSENT for no target
  "rows": [{ "id": "r1", "visualText": "sanitised HTML", "audioText": "sanitised HTML",
    "imageRef": { "sha256": "64 lowercase hex", "width": 1, "height": 1,
                  "mime": "image/png | image/jpeg | image/gif | image/webp" },  // or null
    // the scene's gallery (#135, 02d-gallery.js), each key absent when empty:
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

**`personColors`** (#194) is the colour each person picked for themselves,
`{name: colour}`: a name (trimmed, ≤80 characters) to one of the eight
`PERSON_COLORS` (`00p-prefs.js`), at most 200 of them. It has **no
default**: a document nobody picked in has no key at all, so a file from
before #194 reads, merges and saves byte for byte as it did, and an older
client that meets the key just carries it. Your pick lives in your prefs
(`splitpage-person-color`) and `markDirty()` writes it under your name into
each document you edit (`recordMyColor`, 13a-presence.js; a reviewer's copy
is left alone). It is bookkeeping, not content: `12a-undo.js` keeps it out of
the undo stack. `migrateRows()` cleans it (`normalizePersonColors`: garbage
dropped, names that differ only in case or padding kept once, the key
deleted when nothing valid is left); `mergeStates()` merges it per name with
`mergePersonColors` — the side that moved a name off the base wins, both
moved it is mine, a name either side (or only the base) has is kept, nothing
is ever removed. Both project formats carry it unchanged (it is just a
state key). A person's colour is resolved by `personColor(name)`
(13a-presence.js over `resolvePersonColor`): your own pick for your name,
then what the people online now send with presence (`color` on
`/api/presence`, `#RRGGBB` only, whitelisted by the server and checked
against the eight again by the page), then this map, then the hash of the
name — which is what everyone got before #194 and still gets until they
pick.

`ROW_FIELDS = ["visualText","imageRef","audioText","imageLinks","moreImages"]`
merges as content (an `imageRef` compared by its sha; the gallery's two
lists as sets, both sides' additions kept, never a conflict, #135); `rows[].status` and
`productionTags[].status` merge by rank (further-along wins);
`owner`/`notes` merge "filled beats empty".

**A scene's length** (#179) is `rowSeconds(row)` (01-scene-status.js):
`rows[].lengthSeconds` when it is set, which replaces the estimate outright,
otherwise the Audio words at `wordsPerMinute`. Every consumer — the gutter's
start times, the program clock, the rundown strip, the Production and B-roll
panels, the CSV, Present's clock — reads `rowSeconds()`, never the words
directly (Present's *scroll speed* is still words and reading speed).
`migrateRows()` keeps a whole number 0–86400 and drops anything else, so a
file from before #179 reads as the estimate. It is set from the rail's Read
time (05r-read-time.js; typed as `1:30`, `90`, `90s`, `1m30`, `1m 30s` —
`parseSceneLength()`), which is read-only in a review session. It is not in
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
(01-scene-status.js; 0 and garbage delete the key). `mergeStates()` uses
the `target-length` strategy, `mergeTargetLength()` (03-sync.js): merged
like the title — the side that changed it since the base wins, and taking
it away is a change too (which `changed-side-wins`' `m || fallback` would
lose) — but both sides changing it keeps theirs with no conflict card, as a
scene's length does; with no base a set target beats none. Both project
formats carry it as a plain key; the `.md` table does not show it and no
export prints it. It is set only through `setTargetLength()`
(05t-target.js), one `markDirty()`, so undo sees a `docField` step and a
review session is refused there as well as in the popover. What reads it:
the script's length (`updateScriptStats()`: `1:35 / 2:00` and `0:25 left` /
`0:05 over` in `#runtime-slot`, via the pure `targetClock()`; since #207 a
label at the end of the rundown, `#runtime-chip`, placed by
`rundownLengthPlace()`, and at phone widths `#length-status` in the
header's status line — it was the header's program clock before; the
target is measured against the whole script — with shot scenes hidden the
remaining-to-shoot figure moves to the tooltip), and the rundown
strip (`setRundownExtraSeconds(target)`, so the span is
max(target, total) + 10s; 05t-target.js draws the line, "Target 2:00" and
the hatching on `#rundown-overlay` from `rundownLayout().x` — the layout at
rest, never `rundownX()`, because the overlay is faded while the lens is on
and must be right when it settles; and never seconds × `pxPerSecond`, since
the rest floor (`REST_MIN_PX`, `rundownRestLayout()`) keeps short scenes'
blocks wider than to scale; minimized, CSS leaves only the line as a tick).
Present does not show it.

**Per person, not per document:** the script's zoom (#191) is
`localStorage["splitpage-script-scale"]` (a number, 1 = 100 %, absent at
100 %), applied as `--script-scale` on `#root` by 05s-script-zoom.js, which
also re-applies on a `splitpage:pref` event (`detail.key` that key) and on
another window's `storage` event.

**The two script cells merge a word at a time** (#85,
`docs/DOCUMENT-MODEL.md` §8). `mergeRow` hands each to `mergeTextField()`
(03-sync.js), which reads base, mine and theirs into the document model
(`fromHtml`, 04c-doc-model.js), **each through its own side's registry**
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
compared as a string, whole. The on-disk merge review (18a-local-merge.js)
decides each cell with the same `mergeTextField()`, and shows "both sets of
changes are combined" for an outcome of `merged`.

**A stage direction** (#167) is the model's `dir` mark on words of the
Audio column, stored as `<span class="stage-dir">` (the sanitiser keeps the
class and nothing else), nested just inside the comments so only a comment
edge can cut one; never on a b-roll key; a tag is all in one or not
(`normalizeCell`). Its brackets are never stored: app.css draws them in the
editor, the Writer and the prompter, and every text reader adds them —
`toPlainText` "(beat)" (its `directions: "omit"` and `spokenText()` leave
them out), `toMarkdown` `*(beat)*`, `toDocxRuns` a `(`/`)` run each side with
`dir: true` (the .docx writes the `SplitpageDirection` character style,
which `docxToRows` reads back; the PDF prints them grey italic), and
`htmlToMarkdown` — the `.md` project's table — `((beat))`, the typing
notation, so a hand-edited table cell gets them back (`audioDirectionsHtml`,
15-docx.js, also run on a `.docx`'s and a paste import's Audio). An older
copy's sanitiser unwraps the span, so there a direction reads as narration;
its `.md` table shows the `((beat))` literally. `wordCount` (so
`rowSeconds`) counts `spokenText`; `prompterSceneHtml` leaves a direction's
words out of the `.w` spans voice follow listens for. Typing: `((words))`
converts on the second `)` in the Audio column only (`directionShortcut`,
04c-doc-model.js, where the typing convention Adam signed off is recorded;
`maybeDirectionShortcut`, 05-render.js), one undo entry of its own; a
character typed at either edge of one is narration (`typingMarks`,
`typeAtDirectionEdge`). The narration export's "Include stage directions"
is `localStorage["splitpage-export-directions"]` (`"0"` off, absent on).

**Images are references, not bytes** (#82). The document state never holds
image bytes; the bytes live once, content-addressed by SHA-256, in a blob
store (browser IndexedDB `splitpage-blobs`, desktop `<userData>/blobs`,
server `DATA_DIR/blobs`), and `02c-blobs.js` is the page's registry of them.
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
- The hydrator (a MutationObserver in `02c-blobs.js`) gives every
  `<img data-blob>` in the live DOM a `blob:` `src` once `ensureBytes()`
  has the bytes (memory, then the backend, then the server); one nobody has
  is marked `data-blob-state="missing"`, alt "Image unavailable". The mark
  lives on the element only, so a re-render (the comments list rebuilds on
  every change) makes a fresh `<img>` and asks again — the memory and the
  backend, but not the server: the registry remembers the server's "not
  here" per sha for five minutes (`REMOTE_MISS_MS`), and forgets it
  whenever new server state arrives (`forgetRemoteMisses()`, called when a
  document is opened or resumed, on a pull and on a 409's copy), since that
  is when a collaborator's upload can have made it fetchable. So a picture
  that turns up later still appears, without a request per re-render. Anything
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
  not name an unstored blob persists or uploads `refsIn` first (#52).
- The crash/sign-in stash (`splitpage-conflict-stash`) names pictures by
  ref too, and carries `blobs: {sha: data URI}` for any the durable store
  does not hold yet; `acceptStash()` interns them on the way back in.

**`docId`** (`src/js/02b-doc-id.js`, frozen `sha256Hex`/`deriveDocId`) is
minted by `migrateRows()`, carried through `mergeStates()` via
`mergedDocId()`, derived deterministically for legacy files with none.
Never in the seed, `#state-data`, or Standalone HTML export. Join key for
per-document history, drafts, duplicate-tab detection. Invariants #35–#37.

**Per-document version history**, capped 50 snapshots/document, keyed by
`docId`. ONE store since #83, `shared/history-store.js` (put-if-absent by
snapshot id, the stamp after the bucket's newest, the trim to 50, cap
eviction, the quota retry, Older's creation and expiry, holds, index-only
copy, which bodies may go), run over a backend per place: in the browser
over `03c-history-idb.js`'s IndexedDB (`splitpage-history` v3: an `index`
store, one DocRecord `{bucket, title, lastOpenedAt, migratedAt?,
expiresAt?, snapshots:[meta + sha]}` per bucket, and a `bodies` store,
`{sha, stateJson}`, one row per distinct content, shared by every entry
naming it), or over the shared memory backend when IndexedDB will not open
(for the rest of that page); on the desktop in main, over its folder
backend (§3.13), with `03a-history-store.js`'s `desktopHistoryBackend` a
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

**Crash-safe drafts** (§3.13): a `stateJson` full `state`
object plus a separate `DraftHeader` (never document fields) — not document
schema. On the desktop per tab, for every kind of document; in the browser
(PR #233) per server document only, in IndexedDB `splitpage-drafts`:
`meta` `{key, base, docId, rev, title, writtenAt, writerId, editSeq, schema,
docIdWrittenOut, bytes}` and `bodies` `{key, stateJson, baseJson}`, `key` =
`JSON.stringify([base, serverDocId])`. **`desktop-state.json` v2**: no document content and no docId, just
windows/bounds/tabs/each tab's *source*/`lastKnownTitle` — a launch recipe,
not a backup (§3.13).

**The two file formats**, both through `20d-formats.js`, entering state
only via `migrateRows()` (#2): **`.splitpage`** is
`JSON.stringify(inlineStateImages(migrateRows(cloneState(state))), null, 2)`,
no envelope (#31). Files carry their pictures inline, as they always have
(#82 D1): `inlineStateImages()` turns each `imageRef` back into
`visualImage: "data:…"`, each `<img data-blob>` into
`<img src="data:…" class="comment-img">`, and writes an image conflict
card's picture into its body — what an older client wrote and reads. A
picture whose bytes nobody has stays a ref and the save says "N images
could not be included". Standalone HTML and a server without blob routes
get the same inline form; the page and a blob server keep the refs.
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
(IndexedDB v2, per-document history: `index` + `bodies`, plus the v1
stores until the one-time move has emptied them — see above), `splitpage-blobs` (IndexedDB, store
`blobs`, key = sha256, `{mime, size, bytes: Blob, addedAt, usedAt}`; image
bytes, #82 — nothing deletes them yet, D4).

**Per-person settings** (#181, the Settings dialog, `20s-settings.js`), all
localStorage, none in the document: `splitpage-theme` (`light`/`dark`,
absent = system; sets `data-theme` on `<html>` and, in the desktop app,
`nativeTheme.themeSource` through `splitpage:set-theme`), `splitpage-clock`
(`12`/`24`, absent = system; `formatClock()` in `00p-prefs.js` is the one
clock formatter, #180), `splitpage-person-color` (#194),
`splitpage-default-wpm` (the reading speed a NEW script starts at),
`splitpage-video-thumbs` (#141: `"0"` = don't fetch a pasted YouTube or
Vimeo link's thumbnail; absent = fetch, the default — `videoThumbsOn()`),
`splitpage-rundown-min` and `splitpage-script-scale` (other lanes' own
controls; Settings only reads and writes them), plus the keys that already
had homes (`splitpage-hide-shot`, `splitpage-autosave`,
`splitpage-writer-size`, `splitpage-prompter-mirror`/`-flip`/`-scene-mode`,
`splitpage-comment-author`). Every write goes through `writePref(key,
value)`, which stores it and then fires `document`'s
`"splitpage:pref"` CustomEvent (`{detail: {key, value}}`); whatever draws a
setting listens for its key, so a change made anywhere shows everywhere.
File ▸ Export app data carries them (`SETTINGS_APPDATA_PREFS`).

---

## 5. Invariants — break these and data goes quietly wrong

1. **Edit with the Edit tool, one site at a time.** Never in-place regex
   substitution (`sed`/`perl -pi`) on `index.html` — no git to restore from.
2. **Change a script cell through the document model, never by editing its
   HTML** (#85, `docs/DOCUMENT-MODEL.md`): `editCell()` (05b-cell-edit.js)
   for anything done at the selection, the edit functions of
   `04c-doc-model.js` (`replaceText`, `setMark`, `insertText`, …) for the
   rest, `toHtml()` to write the result. Where a path still edits HTML
   (only the guards split/join and the tag and b-roll edits keep for a
   cell still holding a picture, which none does since D7), it walks the
   DOM, never regexes HTML. No edit uses `execCommand` (not in a comment
   or reply box either — invariant #55).
3. **Never touch text inside a tag** (§3.3): the model's edits keep a
   comment or link over all of a tag or none of it, and find/replace never
   matches inside one.
4. **New top-level state field ⇒ update `migrateRows()` *and* `mergeStates()`**
   (§3.2).
5. **Gate script-only behaviour on `isScriptCell()`** (§3.5).
6. **Don't run document-wide scans per keystroke.** Wire expensive refreshes
   through the one idle refresh (`scheduleIdleRefresh()` and its four
   `schedule*()` wrappers, 180ms debounce, §3.16); `contentMemo()` keys on
   the field's own HTML (never stale); the production index is derived once
   per change (§3.4).
7. **Repaint a row, don't re-render the document** for a single-row
   change: `renderRow(rowId)`, which repaints only the parts whose markup
   changed and never a field whose text did not (§3.16). `cycleRowStatus()`
   uses it.
8. **Escape values going into CSS attribute selectors** with `cssAttr()` —
   stripping quotes isn't enough, a backslash reads as a CSS escape.
9. **Markdown table cells need `mdCell()`**; a raw `|` shears the row.
10. **Anything entering a script cell goes through `fromHtml()` or a model
    edit**, which only produce canonical, sanitised cells;
    `syncFieldFromDom()` stores every keystroke that way. `sanitizeHtml()`
    on anything else reconstructed (a comment body) before it re-enters
    state.
11. **A control nested inside `.tag-entity-head` must be checked *before*
    `tag-expand`** in the click delegation's sequential `if` chain.
12. **A modifier-click on a breakdown card outranks every control inside
    it** — checked at the very top of the click delegation.
13. **Two different drags share the root handlers.** The image branch is
    gated on `isFileDrag(e) && !dragRowId`, or scene reordering breaks.
14. **A new `TAG_CATEGORIES` entry needs its colour tokens and a matching
    `.tag-anchor[data-tag-cat="…"]` CSS rule** — `--tag-<id>` and
    `--tag-<id>-tint` in `:root` and in both dark blocks of `app.css`, its
    `color` set to `"var(--tag-<id>)"`, and the rule pointing `--tag-color`/
    `--tag-tint` at them. Panels read the colour through `TAG_CATEGORIES`,
    the script through the rule; both land on the same token, so the dark
    theme and the prompter (which always takes the dark tokens) follow on
    their own (#143). Keep the hues off the Visual blue and Audio amber.
    It also needs its light hex in `TAG_PRINT_COLORS` (14-export.js, #171):
    the PDF and .docx exports draw categories in the light `:root` values
    (the page is white whatever the theme), and a file format cannot read
    a CSS token, so that table is a deliberate second copy — the one place
    they are written out, read through `tagPrintColor(catId)`.
    `src/test/palette.test.mjs` checks all of it, contrast included, and
    fails the moment `TAG_PRINT_COLORS` and `:root` disagree. It also needs
    an `icon` (#217): a stroked 24×24 SVG's inside in `TAG_ICON_PATHS`, next
    to `TAG_CATEGORIES`, which `tagIconCss()` gives to `[data-tag-cat]` as
    `--tag-icon` for Settings ▸ Show icons on tags. The icon is CSS only
    (`::before` and the panels' dots, under `<html data-tag-icons>`), never
    a node in a `.cell-editable`, or `syncFieldFromDom()` would read it back.
15. **The writer never re-parses the document into rows** (§3.9). Row-list
    changes go through `splitWriterRow()`/`mergeWriterRows()`; DOM rebuilds
    through `renderWriter()`.
16. **Anything that opens over the whole screen must close the side
    panels**, through the one helper `closeAllSidePanels()`
    (03b-side-panels.js, #163). It walks `SIDE_PANEL_IDS`, calls each open
    panel's own close function (`closeCommentsPanel()`,
    `closeProductionPanel()`, `closeGearPanel()`, `closeBrollPanel()`,
    `closeHistoryPanel()`, via `SIDE_PANEL_CLOSERS`) and then
    `syncPanelClass()` once, so `body.panel-open` and `#root`'s padding
    reset. Present (`openPrompter()`), the Writer (`openWriter()`, which
    also closes the find bar), Help, the tour, the setup wizard and the
    full-page shot list (`openBrollPage()`) all call it. Present and the
    Writer call it in the same call that starts their fade-in, so the
    panels' slide-out (`--dur-exit`) runs under and inside the mode's
    arrival (`--dur-enter`) as one transition (§3.14). Leaving Present or
    the Writer brings no panel back; the shot list alone reopens the B-roll
    panel on close if that is where it was opened from. A new panel goes in
    `SIDE_PANEL_WIDTH_DEFAULTS` (which is `SIDE_PANEL_IDS`) and, if it has a
    close function, in `SIDE_PANEL_CLOSERS`. `tests/128-side-panels-modes.txt`
    checks every panel against both modes. Writer and Present sit at
    `z-index: 145`, above panels (140), below modals (150) and toasts (200).
17. **A hint about the document must never edit the document** (§3.8).
18. **A comment's anchor is its `cmt` mark in the script; `rowId`/`field`
    only say where that is, and one function keeps them saying it** (#85,
    design §3.2). The mark is the `.cmt-anchor` span, and it moves with its
    words because every path that moves words between rows moves them as
    runs: a split (`splitRowFieldCore()`, `splitCell`), a join
    (`mergeWriterRows()`, `joinCells`), a cut then paste
    (05c-clipboard.js). Each then calls **`syncCommentAnchors(state)`**
    (04c-doc-model.js) in the same undo entry, which points every comment
    whose mark is somewhere at the first cell holding it, in document
    order; a comment whose words are gone keeps what it had (detached).
    `migrateRows()` calls it too, so every load and every merge — which
    can bring one side's split against the other side's old `rowId` —
    comes out in step. A new path that moves words between rows calls it;
    nothing else may write a comment's `rowId`/`field` for an anchored
    comment.
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
    Version history (#83) is the fifth, and its six channels are the
    fewest that say what a snapshot is. The page names a document by
    `docId` and a snapshot by its id (both typed in the table and checked
    again in main, invariant #38) and the Older bucket only by an explicit
    `{older:true}` flag — `history-get`'s query, or `history-put` with a
    null docId — never by a string: `"_older"` is not a docId, so it is
    refused as one, flag or no flag. Main builds every path under its own
    `userData/history`; answers carry metas, state JSON as text (never
    parsed in main) and counts, never a path. #83 step 4 took the set from
    eight to six by folding usage into `history-list`'s answer and
    import-into-Older into `history-put`'s flag rather than keeping a
    channel per store method. So a compromised page can at worst read,
    write and copy the history of documents whose ids it knows, fill the
    cap (which evicts oldest-first, never a document's newest snapshot),
    and list which documents have history — it cannot name a file or reach
    anything outside that folder.
    Follow My Voice (#8) is the sixth: invariants #45–#47.
    A pasted video's thumbnail (#141) is the seventh.
    `splitpage:video-thumbnail` takes a host from a list of two and a video
    id of a fixed shape, both typed in the table, and main rebuilds every
    address from them against `shared/video-embed.js`'s fixed hosts (a
    Vimeo oEmbed answer's `thumbnail_url` is used only when it is on
    Vimeo's own image host). No redirect is followed and only a raster
    image of at most 1 MiB comes back. So a compromised page can at worst
    make main fetch the thumbnail of a video it names from YouTube or
    Vimeo — what pasting the link does anyway.
29. **The join PIN, session token, and launch token never enter
    `update-status.json`, the document, or any file the static handler
    serves.** Client side: everything about connecting to a server is
    browser state, never `state`. A bookmark never carries a password, key,
    or passphrase. Since #11 the same holds for `desktop-state.json` and a
    draft header: a server tab's persisted source is `{kind, serverDocId,
    serverUrl, tunnel}` and nothing else, and a token only ever sits in
    main's memory between a route-open and the new tab's boot. Collaborate's
    owner token and link keys follow the same rule — where each may live is
    #62.
30. **The first-run setup wizard may only appear over a genuinely pristine
    copy of the app.** `<meta name="splitpage-seed-check">` (stamped by
    `build.mjs`, checked by `seedCheckPasses()`) plus
    `localStorage["splitpage-onboarding"]` plus checks that no document is
    already loading. File ▸ "Set up Splitpage…" bypasses this deliberately.
31. **A `.splitpage` file is exactly `inlineBlobs(migrateRows(state))`** —
    `inlineStateImages()` puts every picture's bytes back inline (§4), and
    nothing else wraps, renames, or adds fields on the way to disk (§3.1).
    A reader gets refs back through `migrateRows()`.
32. **The Markdown data block is authoritative for everything the table
    cannot show; the table is authoritative for scene text only, and only
    where it differs from the block.** Don't make the table authoritative
    for a column it renders but doesn't own (`Status`); don't let a
    row-count difference pick a side silently. Both halves carry images
    inline (#82 D2): a row's picture as a `data:` URI at the head of its
    Visual cell AND in the data block; HTML images in the data block.
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
    history folder. The Older bucket is reachable only via `{older: true}`
    (on the desktop wire: `history-get`'s query, and `history-put` with a
    null docId — a docId beside the flag rejects).
    The shared store (`shared/history-store.js`) refuses every other bucket
    itself, in the browser and in main alike.
39. **`pushSnapshot()` captures synchronously, and no save ever waits on
    history.** A restore overwrites the document only after its "Before
    restoring" backup is stored or an explicit second confirm.
40. **A crash draft is deleted only when its tab becomes clean, or on an
    explicit user decision** — never on crash, kill, renderer loss,
    session-end, quit, or restore. A discard writes a tombstone before
    anything is unlinked. The browser's (PR #233) keeps the same rule per
    page: removed only by the page that wrote it (or took it over after a
    restore) when that page is clean or has moved to another server
    document, never by another tab's save, never by a restore that failed —
    plus the store's own bounds (30 days, 20 drafts, 64 MiB). A link turned
    off, a lapsed sign-in or a page too old never stops the writer; they
    stop saves, and a restore never saves.
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

45. **The page can only ask the voice listener to start or stop, for
    itself.** `splitpage:voice-status`, `voice-start` and `voice-stop` take
    no argument (invariant #28's rule). Main alone builds the command line —
    Windows' own `powershell.exe` from `%SystemRoot%`, running
    `voice/listen.ps1` from APP_ROOT — and the script takes no arguments and
    reads nothing but stdin. A compromised page can at worst turn the
    microphone listener on for its own tab, which the voice button does
    anyway. Under `SPLITPAGE_TEST=1` the real listener never runs: only the
    fake named by `SPLITPAGE_TEST_VOICE_HELPER`, or nothing.
46. **What the listener says is rebuilt before the page sees it.**
    `parseHelperLine` (`desktop/voice-helper.js`) keeps a type from a fixed
    list, a capped `text`, a short lower-case `code`, a culture name or a
    capped microphone `name` without control characters (#118), and
    drops everything else; main adds the session number and sends it to the
    tab that owns the session, no other. The page uses `text` as words to
    match and `name` as status text, never as markup.
47. **One listener at a time, and it never outlives its tab or the app.**
    One microphone: a second tab starting takes it over, and the first is
    told (`end`, reason `taken`) rather than left to restart. `forgetTab`
    and quit end the session; the script exits when its stdin closes, so
    even a main-process crash stops it listening.

48. **An exported bundle contains no key matching
    `/token|api[-_]?key|client[-_]?id|secret|password|\bpin\b/i`, asserted
    before any byte is written; an import carrying one is refused.**
    The bundle (`20h-appdata.js`) is `{format:"splitpage-app-data",
    version:1, exportedAt, appVersion, snapshots, history:{docs:[{docId,
    title, lastOpenedAt, snapshots:[{meta, stateJson}]}], older, truncated},
    blobs:{"<sha256 hex>":{mime, b64}}, missingBlobs:["<sha256 hex>"],
    bookmarks, prefs}`. `blobs` (#82) holds every image an exported
    snapshot names (`refsIn`) whose bytes the page could get, once each;
    `missingBlobs` the ones it could not, which the export names in a
    warning. Blob bytes count toward `HISTORY_EXPORT_CAP_BYTES` (200 MB)
    with the snapshot bodies. Hex keys and `mime`/`b64` cannot match the
    regex (hex has no t/o/k/s/p/l; values are never walked).
49. **Import merges through the history store's public write path and
    never deletes; existing preferences are never overwritten; bookmarks
    union by URL with local winning.** Images first: `importHistoryBundle`
    verifies each `blobs` entry (key is a sha, strict base64, at most
    16 MiB, sniffed PNG/JPEG/GIF/WebP with a readable size, hashes to its
    key) and awaits the blob registry's `persist()` for the ones that pass
    BEFORE the first history put — no imported snapshot is stored naming an
    image the store does not already hold durably. A blob that fails is
    dropped and reported; its snapshots still import (placeholder). A blob
    no snapshot in the file names is ignored. A bundle without `blobs`
    (every pre-#82 export) imports exactly as before.
50. **The 1.0.x removal in the installer waits for the old folder to
    disappear before writing** — the old uninstaller's detached `rmdir`
    runs ~2s after it exits, into the same folder. `installer/uninstall.ps1`
    is gone from this repo (#75), but it is still on every machine that
    installed 1.0.x, which is exactly who this macro runs for:
    `desktop/build/installer.nsh` keeps it.
51. **Autosave writes only where the user has already sent this document,
    only work they have seen, and only while it is on.** With autosave off,
    neither path writes — not typing (`scheduleAutoSave`) and not a discrete
    action (`queueAutoSave`); both check the preference first. `autoSaveTarget()` (14-export.js) is the
    single gate: a file handle the user picked, or the server — never a
    picker, never a download. Anything that puts work on screen the user has
    not reviewed (a crash-draft restore's merge, `reportMerge`'s
    `noAutoSave`) calls `haltAutoSave()`, and only an explicit Save starts
    the automatic writes again (#41). A failed or conflicted automatic save
    halts too, rather than repeating a toast or a modal every two seconds.
52. **No durable record names a blob its store does not already hold
    durably** (#82). An image is uploaded (and fsynced) before anything
    that refers to it by sha is written; the list of what a record names
    is always `refsIn()`.
    - **Server half:** the 422 `missing-blobs` check on document POST/PUT
      and on the comments POST (§3.7); `acceptMissing` is the one
      deliberate exception, for a sha the client knows is lost for good, so
      a missing picture can never make a script unsaveable (a comment may
      not use it). The 426 `client-too-old` gate keeps a pre-#82 client from
      saving over a document that names blobs, since it would drop them.
    - **Client half:** the hosted client uploads what the server lacks
      before the PUT, POST or comment POST (`sendWithBlobs`); the history
      job and the desktop drafts await `persist(refsIn(state))` before they
      write, and inline (`inlineStateJson`) any blob the store refused; the
      stash carries non-durable blobs as `data:` URIs; app-data import
      stores blobs before snapshots (#49); file writers inline everything
      (#31, #32). Capture stays synchronous (#39) — only the job awaits.

53. **Every edit of the document ends in `markDirty()`, and nothing that is
    not an edit is recorded as one** (#85, `12a-undo.js`). The undo stack
    learns about an edit by diffing after `markDirty()`, so an edit path
    needs no undo code of its own — and a change that is not somebody's
    edit must say so, or Ctrl+Z will take it back: a new document is
    picked up by `render()` (`trackDocument`), someone else's merge by
    `noteRemoteChange()` (called in `applyMerge`), a reload in place by
    `absorbRemoteChange()`, and what an undo's own repaint heals by
    `settleAfterApply()`. On a server document, a change to the comments
    is never recorded (design D5).
54. **A b-roll key's id is one line's** (`docs/DOCUMENT-MODEL.md` §3.3):
    `state.brollShots` records are found by it, so two keys sharing one
    make two lines claim one shot. A path that brings a key into the
    script from outside it (paste, drop) gives it a new `makeId("bs")`
    whenever the document already knows its id — `freshBrollIds`
    (05c-clipboard.js) — except a cut then paste in the same tab, which
    moves it and keeps it. A path that moves a key (split, join, cut) keeps
    its id and never copies it. A new path that copies script text between
    places does the same; the anchoring pass (08c-broll.js) re-keys any
    second key that still gets through.
55. **A comment or reply draft owns its undo** (`05d-draft-edit.js`). Its
    edits go through the model (`editDraft`), which the browser's own undo
    stack never saw, so the browser's undo must never run in a draft box:
    Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y and `beforeinput` `historyUndo` /
    `historyRedo` are answered from the box's history and always taken. A
    new edit path in a draft box goes through `editDraft` (or
    `throughModel`), never `execCommand` or a bare DOM edit — either would
    be an edit nothing can undo. A picture or video card in a draft must
    survive every edit; `mediaTable` lifts and restores them, and a new
    kind of object in a comment body needs a place there and in
    `walkCell`'s atoms.
56. **A b-roll shot stores only the props added to it by hand, and names
    each by its registry id** (#149, 08c-broll.js). The props tagged on its
    own lines are read off the script every time (`brollPropsInCell`) and
    never copied onto the record. `props` is `[{id, name}]`: `id` is the
    `productionTags` entry's id, which a rename keeps, so a rename carries
    through with nothing to do; `name` is the fallback for an entry the
    breakdown no longer has, refreshed from the entry by `migrateRows`
    (`normalizeBrollProps`: garbage tolerated, an unknown name kept, a
    name-only one given the id of the prop of that name, capped at 40).
    The one rename that drops an id — folding onto another entry's name —
    re-points them (`brollPropsRenamed`, called from `renameTag` in the
    same edit). The merge is a base-aware set per shot (`mergeBrollProps`,
    03-sync.js): both sides' additions kept, a removal kept unless the
    other side still has it and did not have it in the base. A pasted copy
    of a shot's line gets none of them (`recordPastedBroll` makes a fresh
    record), exactly as it gets none of the status, notes or owner. A new
    field on a shot record needs `migrateRows`, `mergeBrollShots` (which
    clones a shot whole and folds the other side in field by field) and
    `newBrollRecord`; `state-fields.test.mjs` checks the record's keys
    survive a merge and a save.
57. **Every document export says what it says besides the words through
    the kit** (`14b-export-kit.js`, 2026-09-26): the facts line, each
    scene's number / start timecode / status / read time, the open
    threads' numbers (counted as the script's markers count them), a
    cell's tags, b-roll keys and markers, the breakdown by category and the
    b-roll by scene. A format that works any of these out for itself will
    drift from the others and from the app. The print colours are a second
    copy of `:root` (`PRINT_COLORS`, `TAG_PRINT_COLORS`) that
    palette.test.mjs holds to it.
58. **Anything an export prints that is not script is skipped on the way
    back in, for files exported before and after.** .docx: named styles —
    `SplitpageMeta` (paragraph, skipped anywhere), `SplitpageMarker` and
    `SplitpageSceneNo` (runs dropped), `SplitpageBroll` (its text kept, the
    chip's bold and padding dropped), `SplitpageTag` (its words kept); in a
    Splitpage .docx (a `SplitpageTable` table or a `SplitpageMeta`
    paragraph) a `w:u` carrying `w:color` is the export's drawing, so the
    writer's own underline is always written without one;
    `EXPORT_SECTION_HEADINGS` is Production breakdown / B-roll shot list /
    Comments; `isBreakdownHeader` knows the old seven-column head and the
    new five. Markdown: `MD_SCENE_META_RE`, `MD_SCENE_FACTS_RE`,
    `MD_MARKER_RE` (`<sup>N</sup>`), the hard breaks after a timed heading,
    and the `MD_EXPORT_TAIL_RE` headings (11-import.js). CSV: our header,
    then a cut at our own "Comments" line; the Total/Target rows read as
    empty. The .docx fixtures in `src/test/fixtures/` are the old writer's
    output — the "old files still reopen" contract; never regenerate them
    with the new writer. The narration .txt stays exactly title, blank
    line, a paragraph a scene: it has no styles to hide anything else in.
59. **The saved .md project's human half is frozen byte for byte.**
    `toMarkdownTableDoc(s)` without `opts.export`, and the tail without
    it, write what they wrote before the exports changed; everything
    export-only (the meta line, the Start/Status/Read columns, the grouped
    breakdown, the b-roll list, numbered comments) sits behind
    `opts.export`. `formats.test.mjs` keeps the pre-change writer verbatim
    and compares. (See also the comment above `mdSceneCellSource`.)
60. **An export is the same bytes all day.** Suite 98 exports every format
    twice, by two routes, and compares the bytes (zeroing only a zip
    entry's own timestamp): a PDF's `/CreationDate` and a .docx's
    `docProps` dates are the day, never the second, and nothing prints a
    time of export. The comments' own posted times are data, and fine.
61. **The PDFs' footer is a pagination artifact** (`/Artifact <<
    /Type /Pagination /Subtype /Footer >> BDC … EMC`, `pdfFooterOps`):
    text extraction skips it, and a test that reads the content streams
    must too — its hairline is the same operator as a scene's rule.
62. **Collaborate's credentials live in this browser's storage, per server,
    and nowhere else** (13-hosted.js, 13b-collaborate.js). The OWNER KEY
    (the server's JOIN_PIN) is never stored at all: it is typed, posted to
    `/api/join` and dropped; what is kept is the token it buys, in this tab
    (`splitpage-server-token`, sessionStorage) and — "Remember on this
    device", ticked by default in the Collaborate dialog — in the
    per-server map `splitpage-server-tokens` (localStorage), the same place
    the PIN dialog's "Remember" has used since #11. A LINK'S KEY (`#invite=`
    / `#review=`) is in the link, then in the tab (`splitpage-review-key`,
    sessionStorage) and, only for a server whose `/api/health` says
    `linksPersist: true`, on the device (`splitpage-invites`, `{serverUrl:
    {key, doc}}`) — so a LAN session's review key never reaches localStorage
    (suite 43). A link's TOKEN is the tab's only (`setLinkToken`): it never
    goes into, and a guest's join never clears, the owner's remembered map,
    and a link clicked on the owner's own device never replaces the owner's
    remembered sign-in (`holdsOwnerSignIn`). None of the three ever enters
    `state`, a file, an export, the app-data bundle (#48 — and no key name
    here may match its regex, nor suite 18's
    `/pass|secret|key|cred|ssh|pin/`), `desktop-state.json`, a draft header,
    the browser's draft store (PR #233: keyed by origin + folder and the
    server's document id, holding the document and scalars only — suite
    265 looks for the token and the key in it) or a URL other than the link
    itself; the key leaves the address bar the
    moment it is read. `link-off` forgets the key in the tab and on the
    device; Settings ▸ Collaboration ▸ Sign out forgets the owner's token
    for that server only.
---

## 6. Map of the source

`src/js/` (47 modules; filenames say where things live, and still set
evaluation order via `_entry.js`):

| Fragment | What is in it |
| --- | --- |
| `_state.js` | the 54 cross-module mutable vars, as one exported object `S` |
| `_home.js` | where the document lives: the one tagged `home` record (`none` / `file` / `import` / `server`) and `setHome()`, its only writer (#73); and this tab's connection `conn` (`serverUrl`, `token`, `role`, `scope`, `tunnel`) with `setConnection()` / `updateConnection()` — a server home holds `conn` itself (#11); `scope` (Collaborate) is the one document id a link's token opens, `""` for the owner's, as the server said and never stored |
| `_entry.js` | the bundle entry: calls every module's `__init()` in order |
| `00-prelude.js` | `PAGE_SHELL`, module-wide vars |
| `00p-prefs.js` | per-person preferences with no DOM or document behind them (#180, #181, #194): `writePref` (store + the `"splitpage:pref"` event), the one clock formatter (`formatClock`, `formatDateClock`; the save status's words `savedStatusText` and tooltip time `savedWhenText`, #208), the theme (`applyTheme`, run at boot right after `PAGE_SHELL` is captured), the eight `PERSON_COLORS` and the pure half of a person's colour (`resolvePersonColor`, `normalizePersonColors`, `mergePersonColors`), and the settings Export app data carries |
| `01-scene-status.js` | scene status and runtime estimates |
| `02-state.js` | `defaultState`, `migrateRows`, `legacyMdToHtml`, `buildPublishHtml` |
| `02b-doc-id.js` | document id: `DOC_ID_RE`, `mintDocId`, frozen `sha256Hex`/`deriveDocId` (over `sha256Bytes`, the synchronous SHA-256 core), `mergedDocId`, `reassignDocId`, duplicate-claim BroadcastChannel; `standaloneHtmlFor(s, head)` and `withPageHead`, which give the Standalone page export the script's `<title>` and a `<meta name="description">` (the app's own page and `buildPublishHtml` unchanged) |
| `02c-blobs.js` | image blob registry (#82): `intern`/`internDataUrl` (sync hash, sniff, measure), `recordFor`/`urlForSync`/`bytesForSync`/`dataUrlForSync`, `ensureBytes`/`persist`/`queuePersist`, a row's picture (`rowImage`, `rowImageUrl`, `rowImageBytes`, `blobImgHtml`), the file writers' `inlineStateImages`/`inlineStateJson`, the document-wide hydrator for `img[data-blob]` ("Image unavailable" when nobody has it), IndexedDB `splitpage-blobs` + memory backends (`setBackend` for the desktop folder), `setRemoteSource` (the hosted client's server fetch, asked after the backend); record gate and `refsIn` in `shared/blob-policy.js` |
| `03-sync.js` | identity, `mergeStates`, save loop, restore/undo-merge |
| `03a-history-store.js` | per-document version history, the renderer's half (#83): the backend choice (desktop IPC client / `shared/history-store.js` over 03c's IndexedDB backend / over the memory backend), synchronous `captureSnapshot` + pending entries and their retry, `historyPersistRefs` (#52), holds, the panel's list and notice line, the legacy `splitpage-snapshots` → Older migration, export/import, `window.__historyTest` |
| `03c-history-idb.js` | the browser's IndexedDB backend for `shared/history-store.js` (`splitpage-history` v3: `index` + `bodies`, one strict transaction per job; the v3 upgrade drops 2.1's v1 stores only when they hold no snapshot), `hashText` |
| `03d-drafts-idb.js` | the browser's store for crash-safe drafts of server documents (PR #233): `createIdbDraftStore` (`splitpage-drafts` v1: `meta` + `bodies`; `put` with the NEED_BASE rule and `keepBase`, `get`, `list`, `remove(key, writerId)`, `claim`; every call resolves, `UNAVAILABLE` with no IndexedDB), pure `browserDraftKey`, `draftBaseOf` (origin + folder), `planDraftEviction` (30 days, 20, 64 MiB); `src/test/browser-drafts.test.mjs` |
| `04-richtext.js` | `walkSanitize` (images in HTML become `<img data-blob>`, #82), `storedImageHtml`, `storedHtmlFromDom`, html→markdown (the `.md` project's table only), video link cards |
| `04a-row-motion.js` | FLIP for `#rows`: `withRowMotion` wraps render()'s reconcile, measures before and after in document space, animates what moved (§3.14) |
| `04b-busy.js` | the one loading indicator: `beginBusy`/`endBusy`/`withBusyBar`, the delayed top bar (§3.15) |
| `04c-doc-model.js` | the structured document model (#85): a cell as runs with marks, `fromHtml`/`toHtml`/`cellOf`, the readers (`toPlainText`, `toDocxRuns`, `toMarkdown`, …), edits, steps and `mergeCells` |
| `05b-cell-edit.js` | `editCell` — one edit of a script cell through the model with the selection kept; `domToPos`/`posToDom` |
| `05c-clipboard.js` | copy, cut, paste and drop in a script cell through the model; a cut comment moves with its words (D6); a pasted b-roll key gets an id of its own unless a cut moves it (invariant #54) |
| `05d-draft-edit.js` | `editDraft` — one edit of a comment or reply draft through the model, its pictures and video cards carried as placeholder characters (`mediaTable`); the draft's own undo history and typing bursts; `pasteIntoDraft`, `appendDraftMedia` |
| `12a-undo.js` | the one undo/redo stack: every edit recorded by diffing after `markDirty()`; remote merges forget what they touched; `foldIntoEdit` puts something the app finishes later (a pasted link's thumbnail, #141) into the edit's own entry, or nowhere when a later entry touches it |
| `05-render.js` | `editableCellHtml` (the one cell builder), `rowParts`/`rowHtml`, `render` (keyed reconcile of `#rows`) and `renderRow`, field sync, rich-text commands (§3.16) |
| `05g-scene-clip.js` | whole scenes on the clipboard (#204): the payload (`application/x-splitpage-scenes` JSON — the scenes and everything they name, comments, b-roll records, breakdown entries, owners, picture bytes up to `SCENE_BLOB_CAP`, 16 MiB, the rest by reference), the two-column table (the payload without bytes on its `data-splitpage-scenes` attribute) and labelled plain text; reading it back through `migrateRows`; `insertScenes` (fresh row/comment/reply ids, anchors renamed, a b-roll key's id kept only when free — invariant #54 — with its record, a live cut in the same document a move while none of its scenes are in it, so it follows undo) and `removeScenes` (comments re-pointed at words that stay) |
| `05h-scene-select.js` | selecting whole scenes by dragging out of a script cell (#204): the gesture, the autoscroll, the highlight (a `<style>` keyed by row id, since `render()` resets row classes), Ctrl+C/X, Delete/Backspace, Esc, the right-click menu, New script from these scenes, `pasteScenesAt` (called from 21-events.js's paste), each change one undo entry; a server document's pasted comments a second, unrecorded step (design D5) |
| `05q-cell-reach.js` | a press anywhere in a script cell puts the caret at the end of its field (#182) |
| `05r-read-time.js` | the rail's Read time as a button: setting and clearing a scene's length by hand (#179) |
| `05s-script-zoom.js` | Ctrl + wheel / pinch / Ctrl + `+` `−` `0` zoom the script alone via `--script-scale` (#191) |
| `05t-target.js` | a script's target length (#170): `setTargetLength()`, the clock popover's Target section, and the line / label / hatching on the rundown's overlay |
| `05v-video.js` | YouTube and Vimeo in a scene's gallery (#141, #168): a pasted link's thumbnail fetched once (`fetchThumbnailRecord` — the page's own fetch, or the desktop bridge's `videoThumbnail`; YouTube's letterbox trimmed), interned as a blob and folded into the paste's undo entry (`thumbnailsAfterPaste` → `foldIntoEdit`); the player's address (`playerSrc`) and where it cannot play (`embedRefusal`: YouTube from `file://`); `window.__videoTest` (a fake fetch/host for the suites; the drivers' `__splitpageNoRemote` keeps everything else off the network) |
| `05e-gallery-overlay.js` | a scene's gallery dialog (#135): the still, ‹ ›, the grid, Make cover / Remove / reorder as undo steps; click-to-play in the preview (#168: a sandboxed frame for YouTube/Vimeo, a `<video>` for a file dropped this session, a note plus Open where it cannot play), Retry thumbnail (#141) |
| `06-rows.js` | row add/move/drag, images; a gallery video's Open (`openGalleryLink`, `openVideoFile`), the desktop's per-run file grants, and the Files dropped or pasted this session (`hasSessionVideo`/`sessionVideoUrl`, #168) |
| `07-production-tags.js` | tag registry, people, tagging, autocomplete, untagged mentions |
| `07b-plain-tags.js` | plain-language tagging (#210): `VFX:` in a Visual cell opens a tag, Tab wraps it, Esc puts the keyword back — Adam's typing convention is written out at the top of the file; the keyword is only hidden on screen, never taken out of the document until Tab |
| `08-production-panels.js` | production and gear panels, multi-select, breakdown |
| `08c-broll.js` | the b-roll list itself: reading `B-roll:` lines off the model, the records in `state.brollShots`, anchoring (#21), a pasted key's record (invariant #54), the props a shot needs (#149, invariant #56), the badge and the idle refresh |
| `08d-broll-panel.js` | how the b-roll list is shown and edited (#148): the side panel — one line per shot, summary bar, filter chips and Group menu (remembered per device, `splitpage-broll-view`), the compact detail card, multi-select and the bulk bar (one change, one undo); and the full-page shot list (#150) — a table over the script at the writer's z-index that closes the side panels and traps the focus (invariants #16, #19), edited through the panel's own handlers (`wireBrollRoot`), with its CSV (`buildBrollCsv`) and printable PDF (`buildShotListPdf` in 17-pdf.js, the packing list's writer) |
| `09-find-replace.js` | find & replace |
| `10-comments.js` | comments: composer, panel, cards |
| `11-import.js` | paste import, two-column detection, `parseMarkdownTable`, Google Doc import; the Markdown exports reopened (`parseStackedMarkdownExport`, `markdownExportScript`), old shapes and new (invariant 58) |
| `12-dirty-toast.js` | dirty flag, toasts (`showActionToast`'s `sticky` for a state that lasts — a link turned off), draft-change hook, save-state indicator (`updateSaveStatus`) |
| `13-hosted.js` | server detection (`applyHealth`: `links`, `linksPersist`), picker, compare-and-set save, the review role (#30), Google Drive files, "Publish & copy a link" + `?doc=` (issue #19; out of the menu since Collaborate, its `serverDocShareUrl`/`shareAccessNote` still Collaborate's for an older server), image blobs on the wire (`x-splitpage-client`, `sendWithBlobs`, `fetchBlob`; #82). Collaborate's guest half: the link's key read out of `#invite=`/`#review=` (`readLinkKey`) and kept per tab, or per device for a server whose links persist (`splitpage-invites`); `joinWithLinkKey` at boot, over a stale token and after a restart; `conn.scope` and the File menu's "Your link opens this one script"; `openSharedDocFromLink` opening the link's script (its scope wins over `?doc=`); `flagLinkOff` — the latched `linkTurnedOff`: one sticky toast with Save a copy…, no saves, no presence, the key forgotten, and (nothing of the reader's on screen) this browser's kept draft opened as an unsaved copy (PR #233); a browser draft armed in `finishServerDetect` before `resumeServerDoc`, and in `openServerDoc`; `apiFetch`'s `link-off`/`owner-only`/`wrong-document` codes and `opts.base`/`opts.token` (ask a server the tab is not pointed at); the owner's remembered sign-in per server (`rememberTokenForServer`) never touched by a link's token (`setLinkToken`); `arrivingOnLink()` for the wizard, the start screen and the desktop pitch |
| `13b-collaborate.js` | File ▸ Collaborate… (and Ctrl K, the Export dialog's note, the desktop native menu): which server (`collabTarget` — the script's own server, else the one that served the page, else Settings' `splitpage-collab-server`, else the built-in `DEFAULT_COLLAB_SERVER`), the dialog's steps (checking → sign-in → confirm → publishing → links; unreachable / error / legacy / open-server) asked with apiFetch's `base` override so Cancel leaves the tab where it was, publishing through `pointTabAt` + `publishToServer({quiet, onError})`, the links API (list, make one of each the first time, New link = `replace:true`, Turn off = DELETE, both armed), the links' base (the desktop app hosting a session hands out its LAN address); the menu item's state (`collaborateBlockedReason`), which `updateCollaborateMenu` also puts on the header's **Collab** button (`#btn-collab`, PR #233: aria-disabled rather than disabled, so it stays tabbable and its tooltip is the reason; refreshed on pointerenter/focus, its click `openCollaborate`); Settings' view of it (`collabServerView`, `signOutCollab`); a guest's first-time name box (`maybeAskGuestName`, the header's and Settings ▸ You's own name and colour); pure `normalizeCollabServer`, `parseLinkFragment`, `inviteLink` (src/test/collaborate.test.mjs); `window.__collabTest` |
| `13a-presence.js` | who else is in a hosted document (#28) — heartbeat, header initials, gutter/field marks; `personColor(name)` (#192, #194: your pick, presence's colours, the document's `personColors`, the hash) and `recordMyColor` |
| `05p-rundown-presence.js` | other people's dots on the rundown strip (#202): one per person on the block of the scene presence says they are in, in their colour, an empty ring after `RUNDOWN_IDLE_MS` (60 s, worked out here: nothing sent says "idle") with nothing about them changing; its own layer in the track (`.rundown-presence`, never #rundown-overlay or the blocks), placed from the blocks' inline left/width and kept there by a MutationObserver on `.rundown-blocks`, so it follows the lens with no hook in 05f-rundown.js beyond `goToScene` and `rundownEdge()` (a dot whose block the sliding lens has carried off the track is hidden) being exported; `paintRundownPresence()` is called from `paintPresence()` |
| `14-export.js` | `saveDoc`, autosave (`autoSaveTarget`, `scheduleAutoSave`, `queueAutoSave`, `haltAutoSave`), Markdown writers, zip writer, `adoptSavedCopyDocId`, the exports' category colours (`TAG_PRINT_COLORS`, `tagPrintColor`, #171). The Markdown exports: `exportMetaLine()` (also the standalone page's description), timed scene headings with a status/read line, open threads' `<sup>N</sup>` markers (`markdownWithMarkers`), hard breaks (`mdHardBreaks`), and `appendExportTail` — the breakdown by category, the b-roll shot list as task lists, numbered comments — all behind `opts.export` (invariant 59); `opts.scenes` for the dialog's sketch |
| `14b-export-kit.js` | what every document export says besides the words, so they all say it alike and as the app does: the document's facts (`exportFacts`, `exportSummaryParts` — scenes, running time, target, shot count, date), each scene's gutter (`sceneFacts` — number, start timecode, read time and whether it was set by hand, status), the open threads' numbers counted as the script's markers count them (`commentNumbers`) and the comments in that numbering (`exportComments`, "Scene 03 · Audio"), a cell's runs with their tag and its colour, the comments over them, the markers after them and the b-roll key (`exportRuns`, over `toDocxRuns(cell, {annotate})`), the breakdown by category (`breakdownGroups`), the b-roll by scene (`exportBrollScenes`), and the rest of the light palette the exports print with (`PRINT_COLORS`, `STATUS_PRINT`, `TAG_STATUS_PRINT`; palette.test.mjs holds `PRINT_COLORS` to `:root`) |
| `15-docx.js` | .docx read/write, narration-only export. The script export draws the app's look (#169) — the facts line, the Scene/Visual/Audio/Read table ruled across only, each scene's gutter, tags, b-roll chips and comment markers, the grouped breakdown (rows that cannot split), the b-roll shot list and numbered comments, "Page X of Y", `docProps` — in named styles the reader skips (invariant 58); the narration .docx hangs each scene's number in the margin (`SplitpageSceneNo`) and reopens as the rows it always did |
| `16-csv.js` | the script spreadsheet — Scene, Start, Status, Read, Read set by hand, Visual, Audio, Tags (`sceneTagLists`), B-roll (`sceneBrollLists`), Open comments; a Total row and a Target row; the Comments block numbered — and `csvToRows`, which maps Visual/Audio by header and stops at our own "Comments" line |
| `17-pdf.js` | every PDF, through one assembler (`assemblePdf`: Info title and `/DisplayDocTitle`, link annotations, bookmarks) and shared pieces (`pdfTextOp`, `pdfLampOp`, `pdfCheckboxOp`, `pdfRoundRectPath`, `pdfFooterOps`, `pdfWrapRuns` carrying a run's annotations and making room for its markers). `buildPdf`: the script as the app lays it out — title block (facts line, rundown strip, status legend), column heads per page, each scene's gutter, annotated runs, clickable links, then the breakdown by category, the b-roll by scene and the numbered comments, each bookmarked, and a footer artifact (invariant 61) per page. The packing list and the b-roll shot list share the list-sheet helpers (`listSheet`, `listHead`, `listWrap`, `listLineOps`): a kicker and heading, Out/Back boxes and a sign-off block on the packing list (items from `breakdownGroups()`), groups as on screen on the shot list (`brollShotListForPrint()`), the opening of a shot's "cuts against" only |
| `18-local-files.js` | `openProjectFile`/`adoptProjectState`, save-back, File menu dispatch |
| `18a-local-merge.js` | the on-disk conflict modal's "Merge them": the mergeable-file probe, the retained ancestor (`diskBase`), the field-by-field review pane and its word-level diff |
| `18b-file-menu.js` | the File menu as a dropdown (#145): `toggleFileMenu`, the file card, `refreshFileMenu` (what is offered right now), `setMenuItemReason`/`setMenuItemLabel` (the second line and the label, never the button's textContent), shortcut chips from `data-keys`, submenus opening in place, Open recent, New script (`startNewScript`), the keyboard, and the browser's Ctrl+S / Ctrl+Shift+S / Ctrl+O (the desktop's are main's accelerators) |
| `18c-export-dialog.js` | File ▸ Export… (#146): the `EXPORT_FORMATS` table the cards and options are built from, the page sketch, summary and file name (`exportFileName`, 18-local-files.js, which `buildFileData` names every file with), `exportActionReason`, the remembered format (`splitpage-last-export`, per device) and Export again, Ctrl/Cmd+E. Builds nothing itself: Export clicks the format's own hidden `data-file-action` button. Each sketch shows its file's first page, from the kit and the writers themselves (the Markdown one is `toMarkdownDoc({scenes: 3})`), drawn in the print palette whatever the theme and escaped all the way; `exportSummary` names only the sections the script has |
| `18d-command-menu.js` | the command menu (#147, Ctrl/Cmd+K and File ▸ Search commands…): the `COMMANDS` list (File-menu buttons, each export format, the header's panel/Write/Present/Save buttons) with the words each is found by, ranking, recently run (`splitpage-recent-commands`, per device), and where it will not open (teleprompter, writer, a modal, the tour). Runs every command by clicking the button the menu or header already has, and reads whether it is offered and why not off that same button |
| `19-writer.js` | the writer (word-processor view of the audio column) |
| `20-teleprompter.js` | teleprompter and voice follow |
| `20a-update.js` | update notice (desktop: Download/Install; portable: release-page signpost), desktop-app notice, About box |
| `20b-onboarding.js` | first-run wizard, pristine-seed gate (invariant #30) |
| `20c-help.js` | in-app Help modal, coach-mark tour |
| `20d-formats.js` | the two document formats, hand-edit reconcile |
| `20e-connect.js` | join-PIN dialog (a six-digit PIN or a server's long owner key, since Collaborate), server bookmarks, SSH helper; `joinServer` carrying a link's `docId`/`scope` and its `link-off`; on a server with Collaborate's links the Servers dialog points a script's owner at Collaborate instead of its old review link |
| `20h-appdata.js` | app-data export/import: `assertNoSecrets` (#48), `importAppData` (#49), the bundle's `blobs`/`missingBlobs` (#82) |
| `20f-desktop.js` | desktop glue, inert unless `DESKTOP` set: bridge wrapper, tab-boot-sync handling, native-menu dispatcher; `window.__desktopTest`'s fake bridge, whose history (`makeFakeBackend({history:true})`) is the real `shared/history-store.js` over the memory backend behind main's IPC shapes |
| `20g-drafts.js` | crash-safe draft renderer: writer/idle-flush loop over a pluggable backend (the desktop bridge, or the browser's `03d-drafts-idb.js` for a server document, PR #233), `applyTakenDraft`, `sameDocContent`; the browser's restore — `armBrowserServerDraft` (finishServerDetect, openServerDoc), `offerBrowserDraftAfterLinkOff` (flagLinkOff), the writer's Web Lock; `__desktopTest.drafts.browser` |
| `20i-topbar.js` | the header on scroll (`.is-condensed`: the rundown's ruler shed, played as FLIP, two thresholds and the scroll offset put back); the title's full text as its tooltip; and the toolbar's labels (PR #233): each panel toggle's, Collab's and Write's label width measured with a Range into `--label-w` (the CSS animates the label closing below 1300 / 1000 and a closed one opening on hover or focus, over its neighbours, with a negative margin of the same width — app.css "the toolbar's labels"), `--label-x` to carry an opening pill to a neighbour's edge, and `.is-label-open` for a pointer that isn't a touch |
| `20j-newtab.js` | the New Tab page, a start screen since #144 ("On air" since #169: the clock band with the most recent script and Continue): its gate, the new documents (blank, a starter, a paste — `adoptNewDocument`), the drop zone, the desktop recents column (DESKTOP-RECENTS, issue #15) |
| `20k-phone-bar.js` | the phone's bottom bar (#169, ≤760px): Script, Write and the panel tabs, each clicking its header button, with the header badges' counts mirrored |
| `20s-settings.js` | the Settings dialog (#181): File ▸ Settings (capture-phase on `#file-menu`, like Help and Set up), Ctrl K "Settings", the desktop File ▸ Settings…; Appearance / Editor / Present / You / Collaboration / Help & tips / Data, each control on its old home's key and setter, redrawn on every `"splitpage:pref"` and `storage` event while open; Collaboration is the server address (13b-collaborate.js's pref, not in the app-data bundle), whether this device is signed in there and Sign out; `openSettings({focus})` for the Collaborate dialog's Change the address… |
| `_starters.js` | the starter scripts (#144): `src/starters/*.json`, stored already migrated and without a docId, bundled by esbuild's JSON loader (`with { type: "json" }`) rather than inlined like the seed; and `LONG_DEMO` (#215), the 30-scene demo written by `tools/make-long-demo.mjs`, opened from the New Tab page's footer and the command menu (`openLongDemo`, 18b-file-menu.js) |
| `21-events.js` | all event wiring, `init()` |

**Desktop files** (optional; the web app runs without them):

| File | What is in it |
| --- | --- |
| `desktop/main.js` | Electron main: scheme handlers, windows/tabs registries, route-open dedupe, close/quit lifecycle, session restore, recent documents (DESKTOP-RECENTS), doc-id claim table, the history store and its IPC (`shared/history-store.js` over `history-fs-backend.js`), draft headers, file dialogs, server launcher, native menus, test mode |
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
| `desktop/google-drive.js` | Google Drive for the desktop app: loopback OAuth listener + PKCE, token storage (safeStorage), Drive list/download/upload, plain CommonJS, no Electron dependency (§3.13, #10) |
| `desktop/test/google-drive.test.mjs` | unit suite for `desktop/google-drive.js` against `desktop/test/fake-google.mjs` (a strict fake of Google's token, revoke and Drive endpoints, shared with smoke.mjs); also checks every `./module` main.js requires is in electron-builder.yml's `files` |
| `desktop/.npmrc` | pins `npm install` to native ARM64 Electron (§2) |
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

Since #145 the menu is a dropdown (`18b-file-menu.js`), but every item is
still one `<button data-file-action>` inside `#file-menu`, exactly once — the
desktop native menu clicks them (`runDesktopMenuCommand`). What an item's
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
desktop (#8) runs Windows' own recogniser (System.Speech, offline) through
`desktop/voice/listen.ps1`, driven by `desktop/voice-helper.js` (main.js
§ 9d, invariants #45–#47); it has never heard a real voice from an agent
session — the by-hand check is in `docs/WINDOWS-CHECKS.md` §3. Google Drive via loopback OAuth is
built (#10, §3.13) and tested against a fake Google; it has never signed in
to the real one, because that needs a Desktop-type OAuth client ID from a
Google Cloud project only Adam can create — the by-hand check is in
`docs/WINDOWS-CHECKS.md` §3. Per-tab server/tunnel connections are built (#11,
§3.13).

**The header after Direction B (#169).** The row no longer overlaps
itself at any width (#174): its right column is never narrower than its
buttons (`minmax(max-content, 1fr)`), and "the header's widths" in
`app.css` drop what they can as the window narrows — Search to its word
and then its magnifier (#175), the panel toggles to icon + count below
1300 (1250 until Collab joined the row, PR #233), the File button to its mark below 1180, Write and Collab to their
icons below 1000, the save status to a dot below 880 — each label staying
the button's name and tooltip. Since PR #233 the panel toggles', Collab's
and Write's labels close and open as an animation on the motion tokens
rather than leaving the layout in one frame, and a closed toggle or Collab
opens its name on hover (not touch) or keyboard focus over its
neighbours: a negative margin equal to the growth keeps every layout slot
still, the open button is `pointer-events: none` but for a `::before` over
its closed box so the neighbours it covers stay reachable, and the pill is
carried to a neighbour's edge (`--label-x`). Keep the margin, the label's
max-width, the padding and the `::before` edge on one duration, curve and
delay, or the row shivers while it opens (suite 266 reads every frame).
**Collab** (`#btn-collab`, File ▸ Collaborate… in the header, between the
panels and Write) is Adam's ask. The mark and name are the File button (#166,
still `#btn-file`); the mark is ONE symbol, `#i-mark` in the sprite, which
the header and the New Tab page both `<use>` — a new logo changes that
symbol and nothing else. The title gives way before the facts and your
name never does (#183). `#root` spans the window and only the script is
held to 1800px (#190); the rundown strip runs the window's width, less an
open panel (#189), below 1100px too. One slim scroll-bar style app-wide,
and the page's own bar hidden while a panel is open (#187, #188), its
width handed back (`--page-gutter`, 03b-side-panels.js) so nothing steps
sideways; a panel opening or closing keeps the scene at the top of the
view put (`holdScriptPlace`, as the script zoom does). With people in a
hosted document the avatars fold into a "+N" chip rather than overflow
the row (`fitPresenceBar`, 13a-presence.js). `tests/85-header-fit.txt`
measures all of it by resizing an iframe; 250–252 the rest.

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

**Collaborate replaced it in the menu** (`src/js/13b-collaborate.js`, File
▸ Share's first item). Adam: "The end user shouldn't have to know that this
URL exists — they just go Collaborate and then it gets stored on my
server." The server is built in (`DEFAULT_COLLAB_SERVER`,
`https://script.bigmanonline.uk/`, changeable in Settings ▸ Collaboration);
the owner signs in once per device with the owner key, inside the dialog;
a script not on the server yet is stored there after one confirmation, with
this tab pointed at it; the dialog ends on two links, Can edit and Can
comment (`<server>?doc=<id>#invite=<key>`), each with Copy, New link and
Turn off, from the server's links API (`/api/docs/:id/links`, owner-only).
A guest's page reads the key (13-hosted.js, `readLinkKey`), joins with it,
learns the one script it opens (`conn.scope`), opens it, asks their name
once, and remembers the key for that server (invariant #62); every
library-wide File-menu item says why it will not work for them. A link the
owner turns off is `flagLinkOff`: latched like a lapsed sign-in, but no
reload and no PIN dialog, since neither fixes it. `publishAndCopyShareLink`
stays for `window.__shareTest` and SKILL.md's by-hand run; its address and
access note are Collaborate's for a server too old to make links. Suites
260–264; the server half is `tools/test-server.mjs`.

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
