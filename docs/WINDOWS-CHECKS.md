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
node test/smoke.mjs                    # dev + every packaged exe in dist/
node test/smoke.mjs --only-target dev   # dev only, fastest loop
```

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

A full dev-target run is 57 groups, ~487 checks and about **55 minutes** —
sixty-odd real app launches,
several of them deliberately crashed and relaunched. `--only-group <text>`
(debugging only, like `--only-target`) runs just the groups whose name
contains that text; it prints a banner and tags the summary `PARTIAL RUN`,
because a partial run that read like a full one is exactly what this file is
not allowed to produce.

CI (`.github/workflows/ci.yml`) runs the full dev target as its own
`desktop-smoke` job on every pull request. It starts `Xvfb :99` itself rather
than using `xvfb-run`: `xvfb-run` substitutes its own exit status when its
temp-directory cleanup fails, which happened once in two full runs here and
would turn a green suite red for a reason unrelated to the app.

---

## 1. Desktop smoke — what Windows still adds

The dev target's ~487 checks now run on Linux and in CI — one skip, the rest
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
  against the shared `chooseDuplicateLoser`. **The packaged half is still
  unrun**: that one depends on `stage.mjs` having copied `shared/` into
  `resources/splitpage`, which only a real build produces.
- **#64 — updater trust.** `update without a checksum` runs and passes.

What a Windows run still adds for this file:

- **The packaged targets.** `dist/win-unpacked/Splitpage.exe` and
  `dist/win-arm64-unpacked/Splitpage.exe` are the only packaged shape
  anything builds, so `resolveTargets()` looks for them on Windows only. They
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

Nothing below has produced a real installer. This is now the bulk of what
needs the machine.

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

## 4. The browser suites, on Windows

`driver.mjs` runs them one at a time on Linux and all 49 pass there. Two
reasons to re-run on Windows with `run-tests.ps1`:

- **Width assertions can legitimately disagree.** Google Fonts does not load in
  the container (the proxy's CA is untrusted), so the app falls back to generic
  sans/mono. SKILL.md has the CA-pinning recipe.
- `run-tests.ps1` runs them in one pass with its own orphan-process sweep,
  which is a different shape of run from 49 separate invocations.

New suites worth a first Windows run: `53-service-worker.txt` (#79),
`54-server-conflict.txt` (#72) and `55-pull-merge.txt` (#69), all written
here. 55 drives the real 2s heartbeat rather than poking the function, so it
is the most timing-sensitive of the three and the most worth a second
opinion on a different machine.

---

## Status

| Item | Needs | State |
| --- | --- | --- |
| #77 IPC table | desktop smoke | **runs and passes on Linux + CI** |
| #76 shared modules, dev path | desktop smoke | **runs and passes on Linux + CI** |
| #76 shared modules, packaged path | `dist:win` + packaged smoke | never run |
| #64 checksum case | desktop smoke | **runs and passes on Linux + CI** |
| MainWindowHandle probe | Windows | skipped by name off Windows |
| #75 / #80 packaging | `dist:win`, `verify-dist`, unzip and start | never run |
| #79 offline reload | by hand | unreachable by test |
| #79 deploy pickup | by hand | unreachable by test |
| #74 fsync | by hand, if at all | unreachable by test |
| #8 Follow My Voice | by hand | unreachable by any agent |
| browser suites | `run-tests.ps1` | pass on Linux |
