---
name: run-splitpage-app
description: Run, drive and test the Splitpage app in a real headless browser. Use when changing the app source in src/, verifying a Splitpage feature works, reproducing a reported bug, taking screenshots of the app, or running the regression suite before committing. Also use when asked to "test splitpage", "run the tests", or "check nothing broke".
---

# Running and testing Splitpage

Splitpage ships as one self-contained `index.html`, but **that file is
generated — do not edit it.** The source is `src/` (`page.html`, `app.css`,
`seed-state.json`, and the numbered fragments in `src/js/`), and
`node build.mjs` inlines them back into `index.html`. Edit `src/`, rebuild,
then test. A change made directly to `index.html` will look like it worked
and be destroyed by the next build; the pre-commit hook refuses a commit
where the two disagree.

There is no test framework beyond this skill: a PowerShell driver that serves
the app, launches headless Edge over the Chrome DevTools Protocol, and runs
plain-text command scripts against it.

The harness itself is Windows PowerShell 5.1 + .NET (`HttpListener`,
`ClientWebSocket`) + `msedge.exe`, so it runs on Adam's machine and nowhere
else. Building and packaging need Node 18+, which that machine may not have —
if `node build.mjs` cannot run, you cannot test a source change at all, and
saying so is better than testing a stale `index.html`.

## Run the regression suite

Do this before committing any change to `src/`, and **rebuild first** or you
will be testing the previous version of the app:

```bash
node build.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/run-tests.ps1
```

Ends with `ALL PASS - 998/998 checks across 25 suites` (01–26, 16 unused) and exit 0, or lists
every failing assertion and exits 1. Options:

- `-Only 02` — run just the suite whose filename starts with `02`
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

## The suites

| File | Covers |
| --- | --- |
| `tests/01-core.txt` | boot, typing, `[prop]` `{location}` `~vfx~` shortcuts, Tab autocomplete, Ctrl+Enter, runtime estimate |
| `tests/02-production.txt` | breakdown registry, status cycle, all four groupings, Ctrl+click multi-select, bulk status |
| `tests/03-exports.txt` | Markdown / CSV / breakdown CSV / DOCX / PDF actually produced, breakdown present, DOCX XML parses |
| `tests/04-prompter-find.txt` | teleprompter open/play/mirror/size, find & replace, tags survive replace-all |
| `tests/05-mobile.txt` | phone layout, no horizontal overflow, 16px inputs, long-press → tap-toggle selection, the writer on a phone |
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
| `tests/17-formats.txt` | the two project formats: `.splitpage` and `.md` round-trip the state exactly (tags, comment anchors, images, statuses, wpm, people), a hand-edited table cell wins for that cell and its tags re-attach, an added scene asks rather than guessing, a legacy `.html` still opens, the data fence never collides with content |
| `tests/18-connect.txt` | the Servers dialog from the File menu, bookmarks persisting (and holding nothing credential-shaped), the SSH command, the join-PIN dialog's validation, `#launch=` stripped from the URL on load |
| `tests/19-save-conflict.txt` | the on-disk conflict check for project saves (`.md`/`.splitpage`): `saveDoc()` refuses to overwrite a file that changed on disk since it was opened, the same guard `saveBackToFile()` already had for the import re-save path, driven against a fake `FileSystemFileHandle`-shaped object since no real file picker can run headless |
| `tests/20-comment-drift.txt` | a `.cmt-anchor`'s live text drifting from `quotedText`: still jumpable with a "text changed" note and the original quote kept visible, orphaned once the span is edited down to nothing |
| `tests/21-desktop-shim.txt` | the desktop bridge (20f-desktop.js), driven with `window.__desktopTest`'s fake backend in place of a real Electron shell: a desktop file handle round-trips non-ASCII text byte-exactly, a cancelled Save As leaves `state.rev` and the toasts alone, the on-disk-conflict guard fires when the fake file's mtime moves, and the native-menu-command dispatcher reaches the same find bar and comments panel the File menu and header button do |
| `tests/22-doc-id.txt` | document identity (02b-doc-id.js): boot minting a valid id, the FROZEN SHA-256 vectors (HANDOFF invariant #37), a hostile or missing id replaced vs. a valid one kept, `reassignDocId`'s Save-As fork that never writes the user's file (overrides.md #1), a failed Save-As write not retargeting Save, identity surviving a document opened while the Save As dialog is up, exports carrying no id, a legacy `.splitpage`/`.md` re-deriving the same id on reopen, the `mergedDocId` truth table, `adoptRestoredState` keeping the id regardless of the snapshot, and the fake-BroadcastChannel duplicate-claim reassignment |
| `tests/23-doc-id-reload.txt` | document identity (02b-doc-id.js) across a real page reload: a pristine boot always mints a fresh id, and ingress decides whether anything needs merging before adopting one — `goto` wipes `window`, so this is its own suite rather than a section tacked onto 22's |
| `tests/24-history.txt` | per-document version history (03a-history-store.js + the `03-sync.js` glue): real captures via `loadFileIntoEditor`'s foreign-file push and a fixture `.splitpage` reopen (no direct `pushSnapshot` access — see build.mjs), the pristine seed never snapshotted until it's dirtied, per-document isolation and the open history panel following the active document, the newest-50 cap and call-order sorting under a frozen clock, restore backing up first and keeping the current docId, copy idempotence, the quota-always forced restore, and a document edit landing mid-backup aborting or completing the restore correctly |
| `tests/25-history-migration.txt` | the one-time migration of the old shared `splitpage-snapshots` localStorage list into per-document history's Older bucket (`startHistoryMigration`), and the merge-undo path (`lastMergeUndo`) that rides the same store: legacy entries (including a hostile id) re-minted into Older with the legacy key removed, a repeat migration adding only what's new, a failed import or a corrupt key never deleting the legacy key, a key that changes mid-migration never left deleted unless its latest content actually made it into Older, and Older itself being shared across every document, restoring under the current document's id, and expiring as a whole 90 days after the migration |
| `tests/26-desktop-drafts.txt` | crash-safe drafts, renderer half (20g-drafts.js): the writer's timing and dedup, and the restore's outcomes, against `__desktopTest.setBackend()`'s fake backend and `__desktopTest.drafts` — the scheduler never writing per keystroke, an edit during a save drafted and rebased, a clean save discarding the draft, visibility-hidden flush, the disk-unchanged decision made by content not mtime, a detached copy forking its id with a history copy, the pending latch, `applyStashedWork` override isolation, server-override outcomes, sanitisation, and browser inertness (94 checks) |

## The server's own tests

The harness serves static files from its own `HttpListener` and cannot start
`server/server.js` with an environment, so everything that depends on
`JOIN_PIN`, `ALLOW_ORIGINS` or `LAUNCH_TOKEN` is tested by a plain Node script
instead. No dependencies, a few seconds, real servers on free ports:

```bash
node tools/test-server.mjs
```

Ends with `ALL PASS - 39/39 server checks` and exit 0. It covers the join PIN
(open health, gated routes, wrong PIN, the rate limit, the right PIN), the CORS
allowlist (including the literal `null` origin and static files never getting
the headers), the 409 compare-and-set, and the launcher routes answering 404
without the launch token and under `--host` **with** it. Run it after any
change to `server/server.js`.

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

## Ad-hoc driving

For one-off exploration, write a script and run the driver directly:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/driver.ps1 -Script mytest.txt -Port 8795 -CdpPort 9337
```

Always pass `-Script`. Piping to stdin works but the parent shell can sit on a
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
| `key [mods] <Name>` | `Enter Tab Escape Backspace Delete Home End ArrowUp ArrowDown KeyA KeyB KeyI KeyU KeyZ KeyF`, mods `ctrl shift alt` |
| `viewport <w> <h> [mobile]` / `viewport reset` | device metrics; `mobile` also enables touch |
| `count <sel>` / `text <sel>` / `sel <sel>` | inspect |
| `shot <name>` | screenshot to `%TEMP%\splitpage-shots\<name>.png` |
| `logs` | dump collected console output |
| `sleep <ms>`, `quit` | |

Selectors are CSS, or `text=Exact Label` / `text*=Contains`. Prefer `text*=`
for header buttons: `PRODUCTION` and `COMMENTS` grow a count badge inside them
(`PRODUCTION2`), so exact matching breaks the moment the document has content.

`text=` matches on **`innerText`**, which is the *rendered* casing — and `.btn`
is `text-transform: uppercase`, so `text*=Write` finds nothing while
`text*=WRITE` works. Match header buttons by id (`#btn-write`) and save
yourself the guess.

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
  corrupting the registry. It isn't. `render()` rebuilding `#rows` detaches
  the still-focused, now-stale cell node, and the browser's own blur/focusout
  firing on that detached node carries its *stale* pre-rename content, which
  `onRootFocusOut` dutifully syncs back over the correct rename. A real click
  blurs the cell as part of the click itself, well before any of that — this
  reproduces with `jsclick` and does not with `click`. **After `press`-typing
  into a cell, `eval document.activeElement.blur()` before using `jsclick` on
  anything that might re-render `#rows`** — cheapest fix, and it's what a real
  user's next click would have done anyway.
- **Assert on `textContent`, not `innerText`.** Splitpage uppercases a lot of UI
  through CSS `text-transform`, and `innerText` returns the *rendered* casing —
  `"HAVE IT"`, `"▶ PLAY"`. `textContent` returns the source. This produced two
  false failures.
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
- **Don't assert formatting on the live DOM.** Chromium's `execCommand` emits
  `<span style="font-weight: bold">`, not `<b>`. Splitpage's sanitiser turns
  that into `<strong>` on focusout — so a bold/italic assertion belongs *after*
  the field has been left, otherwise you are testing the browser, not the app.
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
  a suite, check for leftovers before suspecting the app:

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

The last full run (2026-09-15) passed 454/454 checks per target — dev and
packaged-arm64 both ALL PASS. The suite groups run in order: boot/security,
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
across tabs, history round-trip and relaunch, history id validation, a
crash-after-body relaunch adopting the orphan, a corrupt `index.json`
rebuilt by fsck, cap-driven eviction, concurrent puts, legacy migration, the
main-vs-renderer planner twin, a newer format going read-only) — then
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
(x64 emulated) vs. 7m25s (ARM64) for the same 454 checks — the suite is
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
