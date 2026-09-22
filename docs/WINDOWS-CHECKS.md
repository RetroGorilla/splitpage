# What still needs a Windows machine

Running list for the 3.0 work on `claude/concurrent-lanes-phases-ea0b4t`.
Everything here was written and reasoned about in the Linux cloud container,
where it **cannot be executed** — `desktop/test/smoke.mjs` looks for
`node_modules/electron/dist/electron.exe`, `npm run dist:win` needs NSIS, and
the browser driver has no network emulation. So each item below is verified by
reading and by a static or unit test, and nothing more. That is not the same as
working.

Treat a green run here as the thing that lets a change ship, not as a formality.

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
node test/smoke.mjs --only-target dev
```

Never launch the app directly — always through `smoke.mjs`'s `launchApp`, which
sets `SPLITPAGE_TEST=1` and a temp profile.

---

## 1. Desktop smoke — the big one

`desktop/test/smoke.mjs` is the only thing that exercises `main.js` and
`preload.js`, and several substantial changes have landed under it unrun.

**#77 — one IPC channel table.** Every `ipcMain` registration and both preloads
were rewritten. Verified here only by `desktop/test/ipc-table.test.mjs` (19
static cases over the source text) and by reading. What a real window has never
executed:

- the `splitpage:ipc-table-sync` bootstrap — main hands each origin its rows
  over sendSync at preload time. If it fails, the preload dies before
  `contextBridge.exposeInMainWorld` runs and the page gets **no bridge at all**.
  That is the designed fail-closed behaviour; confirm it never triggers in
  normal use.
- `ipcOnSync` always setting `event.returnValue`, on a refusal and on a
  throwing handler alike.
- the one gate (`ipcRefusalReason`) running under a real sender, including the
  tab strip's structural check.

**#76 — shared policy modules.** Moved `planHistoryEviction`, the meta
sanitiser and the doc-id claim rules into `shared/`, deleted the desktop
copies, and deleted smoke's `caseHistoryPlannerTwin` drift case. `main.js`
now `require`s two files out of `APP_ROOT` **at startup**, so if the app
fails to launch at all, suspect the staging path rather than a feature.
Watch the packaged targets especially — that half depends on `stage.mjs`
having copied `shared/`. Also `caseAtomicSaveKeepsBirthtime` and
`caseDuplicateDocIdAcrossTabs`, which now run against the shared
`chooseDuplicateLoser` with no `stat` in front of it.

**#64 — updater trust** (phase 1). Per #89, its `update without a checksum`
case has never run anywhere, because it landed from Linux.

## 2. Packaged builds

Nothing below has produced a real installer.

- `npm run dist:win` and `desktop/verify-dist.mjs`, for x64 and arm64.
- **`desktop/stage.mjs` changed twice.** It now stages `server/package.json`
  beside `server.js` (#74 — `server.js` is CommonJS under a `"type": "module"`
  root, and without it the packaged server dies on its first `require`), and
  stages `docs/help.md` as `help.md`, served at `/help.md` instead of
  `/README.md` (#80).
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
| #77 IPC table | desktop smoke | static + read only |
| #76 shared modules | desktop smoke, packaged build | static + read only |
| #64 checksum case | desktop smoke | never run anywhere |
| #75 / #80 packaging | `dist:win`, `verify-dist`, unzip and start | never run |
| #79 offline reload | by hand | unreachable by test |
| #79 deploy pickup | by hand | unreachable by test |
| #74 fsync | by hand, if at all | unreachable by test |
| #8 Follow My Voice | by hand | unreachable by any agent |
| browser suites | `run-tests.ps1` | pass on Linux |

**#89** would close most of the first column: it makes `smoke.mjs`
platform-aware so the dev target runs under `xvfb-run` on Linux and in CI,
leaving only the genuinely Windows-bound cases (the `Win32_Process` /
`MainWindowHandle` probes and the packaged `.exe` targets) to be skipped by
name.
