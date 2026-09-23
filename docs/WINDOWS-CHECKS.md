# What still needs a Windows machine

Running list for the 3.0 work on `claude/concurrent-lanes-phases-ea0b4t`.

**#89 closed most of this file.** `desktop/test/smoke.mjs` — the only thing
that executes `main.js` and `preload.js` — now runs its `dev` target on Linux
as well as Windows, so a desktop change made in the cloud container is
exercised where it is made instead of shipped on a reading. (macOS should
work too: the dev binary is read from Electron's own `path.txt` and the
process probes are POSIX. Nobody has run it there, so do not claim it until
somebody has.)

What is left below is what a Linux run genuinely cannot answer: the packaged
`.exe` targets, NSIS, `verify-dist.mjs`, one `MainWindowHandle` probe, and
the handful of things no automated test reaches on any platform.

Treat a green Windows run as the thing that lets a **release** ship. It is no
longer the only thing that can tell you the desktop shell works at all.

## Windows runs so far

**Run 1 — Windows 11 x64, at `eb9904f`. Everything that was run passed.**

- Dev smoke 488/488 with `SKIPPED (0)`, the `MainWindowHandle` probe included.
- `npm run dist:win` + `verify-dist.mjs` 11/11.
- **Packaged-x64 smoke 488/488** — the first run of a real build. It confirms
  #76's `shared/` loads from `resources/splitpage` and #77's bridge exists in
  the installed app.
- Portable zip unzipped and started through `start.bat`, both of the branches
  that zip can reach (Node on PATH, and the error without it).
- `run-tests.ps1` 2054/2054 checks across 51 suites.
- Offline reload (#79) by hand in real Edge.
- Smoke took 6.3 minutes. The same 15 teardowns were force-killed as on Linux
  (see below — not a platform difference).

Not run: packaged-arm64 (needs the ARM machine), an upgrade over a 1.0.x
install (no safe old install to try it on — a VM or Windows Sandbox if ever),
and `start.bat`'s bundled-runtime branches (the zip has no `runtime/`).

**Run 2 — Windows 11 Pro x64 (10.0.26200), at `81b8e35`.** Before #83 and
#82's later parts. Every automated step passed.

- Dev smoke 679/679, `SKIPPED (0)` (the `MainWindowHandle` probe ran), no
  `FORCE-KILLED` list, the 15 by-design force-kills, 2.6 min.
- `dist:win` (x64, arm64 and the combined NSIS, 2.1.0) and `verify-dist`
  11/11. Full smoke 1358/1358 — dev and packaged-x64 — with one named skip:
  `packaged-arm64 (whole target)` on this x64 host, as #89's finding wanted.
  Both asars carry `google-drive.js` and `blob-store.js`.
- `run-tests.ps1` 2808/2808 across 63 suites. Its first pass failed
  53-service-worker on a stray, gitignored `update-status.json` a
  `node start.mjs` run had left in the repo root; the suite no longer
  depends on that file being absent (`454ea6f`).
- By hand: offline reload (#79) passed again in real Edge, with the network
  emulated offline and with the server killed. #86 "Present in Browser":
  saving first is enforced on an unsaved script (no Save dialog pops up);
  with a saved one, the listener came up and the app said the browser was
  opened — but **no browser window appeared, because of this machine**:
  http/https resolve to a Firefox ProgID with no open command (0x80070483),
  and a plain ShellExecute of any URL opens nothing either. So the real
  browser launch and Follow My Voice are still **unverified**. Two app bugs
  found along the way, fixed after the run (§3): the menu item was
  unreachable on Windows, and at 1400×864 the teleprompter's wrapped
  control bar was mostly covered by the scroll area. #10 Drive: no client
  ID; the unconfigured dialog names the right file and variables.

**Run 2b (addendum) — same machine, at `a49c4e6`** (#82 and #83 complete).
Every automated step passed.

- `npm test` 326/326, server 405/405, every desktop unit test.
- Dev smoke 750/750, `SKIPPED (0)`, 2.84 min. Full smoke 1500/1500 with the
  one named arm64 skip, 5.65 min; packaged-x64 ran 42 blob and 182 history
  checks. `blob-store.js`, `history-fs-backend.js` and
  `history-v1-migrate.js` are in `app.asar`; `shared/history-store.js` and
  `shared/blob-policy.js` in `resources/splitpage/shared/`.
- `run-tests.ps1` 3039/3039 across 66 suites.
- **#83's history move on the real profile: passed.** One document with one
  version: the same id, label, date, 90 rows and 96530 bytes after the move;
  the body's SHA-256 equals the old `.snap` body's; `v1-backup` holds the
  old files byte-identical to a backup taken first; restore through the real
  UI works. Quit and killed mid-move on a generated 114 MB profile (1230
  bodies) at five points, and killed three times the instant `index.json`
  appeared (two of them landed between the index write and the renames):
  every next launch finished the move with nothing missing and no temp files
  left.
- **#82 pictures in the installed app: passed.** Three dropped scene
  pictures and one comment picture live as refs in state and under
  `blobs\sha256\`, survive quit and relaunch, and a saved `.splitpage`
  carries all four inline — the old 2.1.0 app opens it with every picture.
  PNGs now appear in PDF export; the run found a separate, older PDF bug —
  a scene with a picture and no text was overdrawn by the next scene —
  fixed after the run (§3).

Still never run: packaged-arm64 (needs the ARM machine), an upgrade over a
1.0.x install, and a real browser launch for #86 on a machine whose default
browser works.

## Before you start

`index.html` is no longer committed (#80). A fresh clone has to build it:

```
npm install
node build.mjs
```

That writes both `index.html` and `sw.js`'s stamped cache name. `node
build.mjs --check` reports on both, separately.

Then, for the desktop shell:

```
cd desktop
npm install          # .npmrc pins native ARM64; a plain install gets the right one
node node_modules/electron/install.js  # x64 machines only — see below
node test/smoke.mjs                    # dev + every packaged exe in dist/
node test/smoke.mjs --only-target dev   # dev only, fastest loop
```

**On an x64 Windows machine, `npm install` leaves no Electron binary**, and
the dev smoke says "No target found". Electron 44 fetches its binary
lazily, and anything routed through npm picks up `desktop/.npmrc`'s
`arch=arm64` (it is there for the ARM machine). Run
`node node_modules\electron\install.js` once in `desktop\`: invoked
directly it falls back to the machine's own architecture and fetches x64.
The ARM machine does not need this. (Found in run 2b.)

Never launch the app directly — always through `smoke.mjs`'s `launchApp`, which
sets `SPLITPAGE_TEST=1` and a temp profile.

### The same suite, on Linux

```
node build.mjs                          # main.js serves index.html from APP_ROOT
cd desktop
npm ci
node node_modules/electron/install.js   # NOT npx — see below
xvfb-run -a node test/smoke.mjs --only-target dev
```

Three things to know:

- **`node install.js`, not `npx install-electron`.** Electron 44 has no
  postinstall — the binary is fetched lazily — and anything routed through
  npm picks up `desktop/.npmrc`'s `arch=arm64` (which is there for the
  Windows-on-ARM machine) as `npm_config_arch` and downloads a build an x64
  Linux box cannot run. Invoked directly, `install.js` falls back to
  `process.arch`.
- **A display is required.** Electron has no headless mode for a real
  `BrowserWindow`; `xvfb-run -a` picks a free display number itself.
- **The suite adds `--no-sandbox` for the Linux dev target, by itself.**
  `node_modules/electron/dist/chrome-sandbox` is not setuid and these
  containers have no unprivileged user namespaces, so Chromium refuses to
  start without it. It is scoped in `platformFlagsFor()` to `kind === "dev"`
  on `linux`, so it can never reach a packaged binary, and nothing in
  `main.js`, `electron-builder.yml` or the installer passes it — how the app
  ships is untouched.

Every check the running platform cannot answer prints a `SKIP - <name> ::
<reason>` line and is listed again under `SKIPPED (n)` immediately above the
pass/fail line. A skip is not counted as a pass and not counted in the
total, so a thin run cannot print the same summary as a full one.

A full dev-target run is 62 groups and ~600 checks — sixty-odd real app
launches, several of them deliberately crashed and relaunched. It took **6.3
minutes** on Windows 11 x64. The "about 55 minutes" this file used to quote
was the cloud container, which is slow and shared, not the suite. `--only-group
<text>` (debugging only, like `--only-target`) runs just the groups whose
**registered** name contains that text — the name in `runTargetSuite`'s list
(`open/boot/security`), not the tag printed on each check line
(`boot+security`). It prints a banner and tags the summary `PARTIAL RUN`,
because a partial run that read like a full one is exactly what this file is
not allowed to produce; and a filter that matches no group at all lists the
registered names and **exits 1**, instead of the `ALL PASS - 0/0` it used to
print.

**Force-killed teardowns are how some cases end, on every platform.** Every
launch is closed with CDP `Browser.close` first, and killed if it has not
exited 12 s later. #89 reported that 15 of 63 teardowns needed the kill on
Linux and called it a Linux/Windows difference. It is not: the first Windows
run force-killed the **same 15**. They are the launches that end with a dirty
tab — test mode answers the unsaved-changes prompt with Cancel, so the app
rightly stays open — or with a process the case crashed on purpose. Those
teardowns now say so (`expectForceKill`) and go straight to the kill instead of
waiting out the 12 s. Any other teardown that falls back to the kill is listed
under `FORCE-KILLED (n)` above the pass line: not a failure, since nothing is
orphaned, but a change worth looking at.

CI (`.github/workflows/ci.yml`) runs the full dev target as its own
`desktop-smoke` job on every pull request. It starts `Xvfb :99` itself rather
than using `xvfb-run`: `xvfb-run` substitutes its own exit status when its
temp-directory cleanup fails, which happened once in two full runs here and
would turn a green suite red for a reason unrelated to the app.

---

## 1. Desktop smoke — what Windows still adds

The dev target's ~600 checks now run on Linux and in CI — one skip, the rest
executed — which covers
`main.js` and `preload.js` end to end: boot and CSP, save/Save As/export,
second instance and argv routing, session restore, `--library`/`--host`, the
updater, close/quit authority, the tab shell, document ids and history, and
the crash-safe drafts. That includes everything the three items below used to
be listed for:

- **#77 — one IPC channel table.** The `splitpage:ipc-table-sync` bootstrap,
  `ipcOnSync` always setting `event.returnValue`, and `ipcRefusalReason`
  under a real sender all execute on every launch in the suite: no bridge
  means no `window.splitpageDesktop`, and the first case asserts it is there.
  The tab strip's structural gate is covered by the `tabstrip origin` case.
- **#76 — shared policy modules.** `main.js` requires them out of `APP_ROOT`
  at startup, so every launch proves the dev resolution path.
  `caseAtomicSaveKeepsBirthtime` and `caseDuplicateDocIdAcrossTabs` run
  against the shared `chooseDuplicateLoser`. The packaged half, which
  depends on `stage.mjs` having copied `shared/` into `resources/splitpage`,
  passed in Windows run 1.
- **#64 — updater trust.** `update without a checksum` runs and passes.

What a Windows run still adds for this file:

- **The packaged targets.** `dist/win-unpacked/Splitpage.exe` and
  `dist/win-arm64-unpacked/Splitpage.exe` are the only packaged shape
  anything builds, so `resolveTargets()` looks for them on Windows only. An
  arm64 build found on an **x64** host is not run — every group would fail
  with `spawn UNKNOWN` — and is listed as `SKIP - packaged-arm64 (whole
  target)` instead; an arm64 host runs both, the x64 one under emulation. They
  are the only way to exercise `APP_ROOT` as `resources/splitpage` — the
  staging path, the `files` allowlist in `electron-builder.yml`, and the
  `shared/` copy #76 depends on.
- **One `MainWindowHandle` probe**, in `unsaved-changes close`: "no visible
  top-level window appeared during the whole case". It asks Windows whether
  the process owns a visible top-level window. X11 has no equivalent, and
  under Xvfb there is no real screen for anything to have appeared on, so it
  is skipped by name off Windows rather than rewritten into something weaker
  that would read as the same coverage.
- **A second opinion on timing.** The suite drives real crashes, real
  dialogs and real relaunches; NTFS, the Windows process model and
  `Browser.close` behave differently enough that a Linux pass is evidence,
  not proof.

Three platform-dependent assertions were fixed rather than skipped while
making this run, because they were asking Windows-shaped questions about
platform-independent behaviour:

- the DOC-CLAIMS replacement id predicted `file:<path>.toLowerCase()`
  unconditionally; `main.js` lower-cases only on win32 (NTFS is
  case-insensitive, ext4 is not), so the harness now mirrors that rule.
- `caseHistoryCrashAfterBody` pinned exit code 1 for a self-inflicted
  `SIGKILL`, which is how Windows reports it. On POSIX the same call is a
  real signal with no exit code, so the expectation is now written in each
  platform's own terms.
- the `tabstrip origin` case expected a 404 from
  `fetch('splitpage://tabstrip/api/health')`. Since #65 the strip's own
  `connect-src 'none'` refuses the request before it leaves the page, so the
  fetch rejects instead. The assertion now checks that — strictly stronger
  than the 404 it replaced. It had never been re-run since #65 landed.

And one latent race, which a faster machine or a slower one could equally
expose on Windows: `caseDuplicateDocIdAcrossTabs` read the reopened tab's
`docId()` once, immediately after `waitForRows`. `routeOpenPath` creates a
tab with a pending payload, so the renderer boots a blank seed document and
the file arrives afterwards — the single read caught the seed's own random
id about half the time. It is polled for the expected id now, the same shape
the first reassignment assertion in that case already used; a second
reassignment settles on a different id, so the poll still times out and the
assertion still fails on the behaviour it exists to catch.

## 2. Packaged builds

Windows run 1 built and checked all of this for x64. It stays listed because
every change to `stage.mjs`, `electron-builder.yml` or `package.mjs` needs it
again, and arm64 has not been built at all.

- `npm run dist:win` and `desktop/verify-dist.mjs`, for x64 and arm64.
- **`desktop/stage.mjs` changed three times.** It stages `server/package.json`
  beside `server.js` (#74 — `server.js` is CommonJS under a `"type": "module"`
  root, and without it the packaged server dies on its first `require`),
  stages `docs/help.md` as `help.md`, served at `/help.md` instead of
  `/README.md` (#80), and stages `shared/` with its own `package.json` (#76).
- `desktop/electron-builder.yml`'s `files` list gained `ipc-channels.js`
  (#77). **A missing entry means no bridge in the packaged app** even though
  dev mode works. `shared/` deliberately does NOT go in that list — it rides
  on `extraResources` via `stage.mjs`, because `files` is rooted at
  `desktop/` and would land it at a different require path than dev uses.
- `node package.mjs` (portable zip) runs clean here and produces 14 entries
  including `docs/help.md` — but has never been unzipped and started on
  Windows. `start.bat` was rewritten as a thin wrapper when `start.ps1` was
  deleted (#75): bundled runtime, then per-arch runtime, then Node on PATH,
  then an error.
- `desktop/build/installer.nsh` still calls `uninstall.ps1`. That is
  deliberate — it runs against the copy on a 1.0.x machine, not a repo file
  (#75 deleted the repo one). Confirm an upgrade over an old install still
  works.

Once a build exists, `node test/smoke.mjs` (no `--only-target`) runs the whole
suite against each unpacked exe as well as dev, with nothing skipped (the
`MainWindowHandle` probe runs on Windows). That is the only thing
that proves #76's `shared/` staging and #77's `files` entry.

## 3. Things no automated test can reach

- **Offline reload** (#79). The driver has no CDP network emulation and the
  server running the suite is the one serving the page, so the network cannot
  be taken away mid-suite. `tests/53-service-worker.txt` proves the cached
  `index.html` is a whole, real app page — i.e. that the fallback has something
  correct to hand back — and stops there. Load the app, go offline, reload.
- **A real deploy picking up a new build** (#79). Change `VERSION`, rebuild,
  deploy, reload once, confirm the new client is served rather than the old one
  for a load.
- **`fsync` durability** (#74). Not observable over HTTP. The suite's closest
  proxies are "no temp file left behind" and head-line consistency.
- **Follow My Voice** (#8). Microphone capture is blocked in an agent sandbox,
  so this can never be verified end to end by any Claude session.
- **Teleprompter "Open in browser"** (#86). The smoke suite replaces
  `shell.openExternal` with a recorder in test mode, so it proves the URL
  main would open and the script it would serve — not that a real default
  browser launches. By hand, in the desktop app: open a saved script, then
  **☰ File ▸ This document ▸ Present in browser (Follow My Voice)** — the
  in-page twin of View ▸ Present in Browser, which run 2 found unreachable
  here because the hidden title bar leaves no menu bar (Alt shows nothing).
  The default browser should open straight into the teleprompter with the
  same text. Then press **Ctrl+Shift+P** (the native item's accelerator):
  it should do the same. No test presses a menu accelerator, so that key is
  also the check that accelerators fire at all under `titleBarStyle:
  "hidden"` — Ctrl+T/W/Tab and Ctrl+Alt+P/C lean on the same thing. Then
  start Follow My Voice and read aloud — this is the one way Follow My Voice works from
  the desktop app until #8 lands. It needs Chrome or Edge; Firefox has no
  Web Speech, and the page says so. Also try it on an unsaved new document:
  it should ask you to save first, with no Save dialog popping up by
  itself.
- **Google Drive, signed in to the real Google** (#10). The smoke suite runs
  the whole loopback flow against `desktop/test/fake-google.mjs`, so it has
  never met the real consent screen, a real Desktop-type client, DPAPI
  storing the token, or Drive's real answers. By hand, once a Google Cloud
  project has the Drive API enabled, a consent screen with the `…/auth/drive`
  scope and you as a test user, and an OAuth client ID of type **Desktop
  app**: save its downloaded JSON as
  `%APPDATA%\Splitpage\google-oauth-client.json`. Before that, open File ▸
  **Google Drive files…** once and check it shows exactly that path and the
  two `SPLITPAGE_GOOGLE_*` variable names. With the file in place, Sign in
  with Google: the default browser opens Google's consent page, and
  approving it lands on a page saying to return to Splitpage, with the app
  showing "Signed in as <you>" and My Drive listed. Open a folder, download
  a file and a Google Doc (it arrives as `.txt`), upload a file, then upload
  one with the same name and check Drive shows a new version rather than a
  second file. Quit and relaunch: still signed in, with
  `%APPDATA%\Splitpage\google-drive-token.bin` present and not readable as
  text. Sign out: the file is gone and
  https://myaccount.google.com/permissions no longer lists the app. Also
  refuse consent once (the app should say sign-in was cancelled) and leave
  the consent tab open for over 5 minutes once (it should say it timed out).

- **Version history moving to the new layout** (#83), on your real
  profile. Before installing the new build, open two or three documents
  that have history and note how many versions each lists (File ▸ History),
  and the Older group's if there is one. Install, launch, and open the
  same documents: the same versions, same labels and dates, and restoring
  one works. `%APPDATA%\Splitpage\history\` now holds `FORMAT` (`2`),
  `index.json`, `index.prev.json` after the first new snapshot, `bodies\`,
  and `v1-backup\` with the old `docs\` and `older\` folders (kept for one
  release; nothing in it is deleted). A launch that is quit while the move
  runs must finish it on the next launch with nothing missing.
- **Pictures as references** (#82), in the desktop app. Drop two or three
  pictures into scenes, add one to a comment, save as `.splitpage`, quit,
  relaunch: all still show. `%APPDATA%\Splitpage\blobs\sha256\` holds
  them. The saved `.splitpage` still carries the pictures inside it: if a
  1.x/2.x copy of Splitpage is to hand, it opens the file with the pictures.
  Export to PDF with a PNG picture in it — it appears (it used to vanish).

## 4. The browser suites, on Windows

`driver.mjs` runs them one at a time on Linux, and every suite in
`.claude/skills/run-splitpage-app/tests/` passes there (51 at Windows run 1;
more have landed since — `run-tests.ps1` prints the count). Two reasons to
re-run on Windows with `run-tests.ps1`:

- **Width assertions can legitimately disagree.** Google Fonts does not load in
  the container (the proxy's CA is untrusted), so the app falls back to generic
  sans/mono. SKILL.md has the CA-pinning recipe.
- `run-tests.ps1` runs them in one pass with its own orphan-process sweep,
  which is a different shape of run from one invocation per suite.

New suites worth a first Windows run: `53-service-worker.txt` (#79),
`54-server-conflict.txt` (#72) and `55-pull-merge.txt` (#69), all written
here. 55 drives the real 2s heartbeat rather than poking the function, so it
is the most timing-sensitive of the three and the most worth a second
opinion on a different machine.

---

## Status

"Windows x64, run 1" means it passed on the Windows machine at `eb9904f`.
Anything changed since then is due again in run 2.

| Item | Needs | State |
| --- | --- | --- |
| #77 IPC table | desktop smoke | passes on Linux + CI; **Windows x64, run 1** (dev and packaged) |
| #76 shared modules, dev path | desktop smoke | passes on Linux + CI; **Windows x64, run 1** |
| #76 shared modules, packaged path | `dist:win` + packaged smoke | **Windows x64, run 1** |
| #64 checksum case | desktop smoke | passes on Linux + CI; **Windows x64, run 1** |
| #89 smoke on Linux | a Windows run to compare | **Windows x64, run 1** — same results, same 15 force-kills |
| MainWindowHandle probe | Windows | skipped by name off Windows; **Windows x64, run 1** |
| #74 packaged server (`server/package.json` staged) | `dist:win`, packaged smoke | **Windows x64, run 1** |
| #75 / #80 packaging | `dist:win`, `verify-dist`, unzip and start | **Windows x64, run 1** (not the bundled-runtime `start.bat` branches) |
| #79 offline reload | by hand | **Windows x64, run 1**, real Edge |
| #79 deploy pickup | by hand | unreachable by test; not run |
| #74 fsync | by hand, if at all | unreachable by test |
| packaged-arm64 | the ARM machine | **never run** |
| upgrade over a 1.0.x install | a VM / Windows Sandbox | **never run** |
| #73, #71, #98, #11 | dev + packaged smoke, `run-tests.ps1` | **Windows x64, run 2** |
| #10 Drive, packaged | packaged smoke (fake Google) | **Windows x64, run 2**; real Google sign-in never run (no client ID) |
| #86 Open in browser | by hand, desktop app | save-first **Windows x64, run 2**; real browser launch **unverified** (that machine's default browser is broken); the menu route and the covered control bar were fixed after run 2 — re-check |
| #83 history move on a real profile | by hand, desktop app | **Windows x64, run 2b** (incl. kills mid-move) |
| #82 pictures in the desktop app | by hand + packaged smoke | **Windows x64, run 2b**; the PDF overlap it found was fixed after — re-check |
| #8 Follow My Voice | by hand | unreachable by any agent |
| browser suites | `run-tests.ps1` | pass on Linux; **Windows x64, run 2b** (66 suites, 3039 checks) |
