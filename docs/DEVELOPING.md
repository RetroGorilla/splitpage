# Developing Splitpage

Build setup, release commands and the map of the source tree. For what the
app does and how to get it, see the [project overview](../README.md) and
[user guide](help.md). Read [HANDOFF.md](HANDOFF.md) before changing the
application.

## Working on the code

You need **Node 24.22.1** (the version in `.nvmrc`; CI uses it, and the test
runner warns on any other and refuses one outside `package.json`'s `engines`).

`index.html` is **generated, and it is not in the repository** — it is in
`.gitignore`. A fresh clone has no `index.html` until you build one, which
takes `npm ci` and one command:

```
npm ci
node build.mjs           # write index.html, stamp sw.js with VERSION
node build.mjs --check   # are both in step with src/ and VERSION?
node build.mjs --test    # the test build the browser suites need (keeps the test hooks)
```

The source is `src/` — `page.html` (the shell), `styles/`,
`seed-state.json` (the demo document), `starters/` (the starter documents),
the folders that own one job each (`core/`, `application/`, `adapters/`,
`features/` and `bootstrap/`), with `src/bootstrap/main.ts`, the entry point
esbuild bundles from — plus `shared/` (code shared with the desktop
app), `VERSION` and `docs/help.md`, which is rendered into the in-app
Help page. The CSS input list is `tools/css-inputs.mjs`. Which folder may import which is
[docs/architecture/dependencies.md](architecture/dependencies.md).

The build inlines everything into one self-contained page, and that is a
requirement rather than a preference: the SplitShare export writes this page's
own HTML back out with your document inside it, so a page that linked out to
`app.css`/`app.js` would produce exports that only worked next to those
files. Editing `index.html` by hand therefore gets overwritten by the next
build — and because it is untracked, there is nothing to commit by accident
either: the copy in your working tree is yours, script and all.

`sw.js` **is** tracked, unlike `index.html`. It is the one shipped file that
cannot be inlined into the page (a service worker has to have its own URL),
so it is both the file you edit and the file that ships; the build only
stamps its cache name from `VERSION`. Commit it like any other source file,
and rebuild after a version bump so the stamp is current — CI fails if it
isn't.

Before pushing, run the full local gate:

```
npm run verify        # lint, types, both gates, builds, generated-file checks, unit/desktop/tool tests
```

While you work, run the focused checks for what you changed, browser suites
included for anything you can see in the app: the table in
[docs/architecture/testing.md](architecture/testing.md#what-to-run-for-which-change)
says which, and the same page lists what each script runs.
[`.claude/skills/run-splitpage-app/SKILL.md`](../.claude/skills/run-splitpage-app/SKILL.md)
drives the browser suites.

The desktop dependency install is separate: `npm ci --prefix desktop` supplies
Electron's types for lint and typecheck. If changing a preload or the tab-strip
page script, edit its `.ts` source and run `node tools/build-preload.mjs`.
Commit the generated JavaScript too; `check-preload` requires those outputs to be
committed and current. See [desktop-build.md](architecture/desktop-build.md).

CI (`.github/workflows/ci.yml`) classifies the changed paths first. Markdown-only
prose skips code checks, except `docs/help.md`: it changes the built app and
therefore runs app checks. Code checks include lint, types, the gates and four
test shards; app changes also run browser flow suites, and desktop-affecting
changes run the desktop smoke. A passed exact tree can be reused on a push to
main. See [Local verification](architecture/testing.md) for commands and
classification details. App-affecting pushes upload `splitpage-app`.

## Media-heavy test bundles

For local media and Save As testing, `tools/make-media-bundle.mjs` (#1330)
creates a 150-beat, 30-scene script with generated JPG/PNG pictures and MP4
videos. It requires `ffmpeg` on PATH and a new output folder outside this
repository; the parent folder must already exist.

```
node tools/make-media-bundle.mjs D:\scratch\media-small --small
node tools/make-media-bundle.mjs D:\scratch\media-large --photos 300 --videos 60
```

The default is 300 pictures and 60 videos; `--small` uses six pictures and two
videos. The output includes `Media speed test.splitpage` and its files folder;
the command prints counts and total size. Pictures are embedded in the script; videos are
bundled beside it and reopen in desktop. The browser cannot reopen those local
video files. This is a local fixture, not a shipped starter or benchmark result.

## Building a release

```
node tools/package.mjs        # dist/splitpage-<version>.zip — portable archive
```

**Nothing needs installing to build this.** The zip is written by
`tools/package.mjs` itself rather than shelled out to `zip` or
`Compress-Archive`, so the same commit produces the same bytes on Windows and
on a Linux CI box.

For the desktop installers — x64 and native ARM64 — it's `cd desktop && npm
run dist:win`; see [Desktop app](help.md#desktop-app) and docs/RELEASING.md.
Pushing a `v<version>` tag runs `.github/workflows/release.yml`, which builds
all of it and opens a draft release on the releases page
([RELEASING.md §3](RELEASING.md#3-publishing-a-release)). On a portable copy
carrying both architectures' runtimes, `start.bat` picks the right one
automatically.

## Browser notes

**Follow My Voice** (in the teleprompter) needs a microphone, and browsers
only hand one to a served page — so it is disabled when you open
`index.html` straight off disk. Start it with **start.bat** and it works.
It also needs Chrome or Edge, and an internet connection (the speech
recognition itself is done by the browser's own service, not locally).

Chrome ends a speech-recognition session by itself roughly every 60
seconds, so Splitpage restarts it continuously while you read. It takes the
microphone once, when you press the button, and holds it for the whole
session — otherwise every restart would pop the permission prompt again.
That means the browser's recording indicator stays lit until you press
**Stop Following** or close the teleprompter, which is exactly when the
microphone is released. When Chrome asks, choosing **Allow on every visit**
(rather than "Allow this time") saves you the prompt on future launches.

In the **Windows desktop app**, Follow My Voice uses Windows' own speech
recognition instead (System.Speech, run through the system's PowerShell by
`desktop/voice/listen.ps1`): offline, nothing to install, and no browser
involved. Its **Present in Browser** hands the script to your default
browser, and there too Follow My Voice listens through the desktop app, so it
works in Firefox as well. Elsewhere the desktop teleprompter offers **Present
in Browser** for Chrome or Edge's own recognition. **Use Chromium Speech
Recognition** opens the same copy in an installed Chromium browser (Edge,
Chrome, Brave…) instead of the default one, to use its own recognition.

**Firefox / Safari note:** these don't support the File System Access API
(`showSaveFilePicker`), so **Save** falls back to downloading a fresh
`.md` or `.splitpage` copy each time — open the newest one next session.
Chrome, Edge, and other Chromium-based browsers get true in-place saving.

## Files

**The app**

- `index.html` — the whole app, and **a build output that is not committed**:
  generated from `src/` by `node build.mjs` and listed in `.gitignore`, so
  edit the source, not this, and expect a fresh clone not to have one at all.
  It is self-contained on purpose (that is what makes **Export ▸
  Standalone HTML** possible, and what lets the app run straight off a USB
  stick); the only thing it fetches is the Google Fonts stylesheet, loaded so
  that a slow or unreachable font server cannot stop the app starting.
- `src/` — the source. `page.html` (the shell), `styles/`,
  `seed-state.json` (the demo document), `starters/` (the starter documents),
  `core/`, `application/`, `adapters/`, `features/` and `bootstrap/` (see
  above).
  `bootstrap/main.ts` is the composition root: esbuild bundles it into the
  app's one inline script, and it sets the boot order.
- `shared/` — code shared by the app and `desktop/` (file names, document
  ids, history and blob policy), bundled into the app like `src/`.
- `tests/` — unit tests for the owned folders; `src/test/` holds the older
  ones and the browser suites' helpers. `tools/` — the gates and runners;
  [docs/architecture/testing.md](architecture/testing.md) says which to
  run.
- `docs/help.md` — the user guide, and a build input: `build.mjs` renders it
  into the in-app Help page. Editing it changes the app; editing this guide
  does not.
- `build.mjs` — inlines all of it back into `index.html` and stamps `sw.js`.
  `--check` says whether both are in step with the source.
- `manifest.webmanifest`, `icon.svg`, `icon-maskable.svg` — makes "Install
  app" possible (the maskable one is the same mark, shrunk into the safe
  zone for Android's round and squircle crops).
- `sw.js` — a small service worker so the app shell still opens offline
  once you've loaded it at least once while served over `http://`. Tracked,
  unlike `index.html`: it cannot be inlined into the page, so it is the file
  you edit as well as the one that ships, and the build only stamps its
  cache name from `VERSION`.

**Running it**

- `start.mjs` — the launcher: serves the app and opens your browser. It
  installs nothing.
- `start.bat` / `start.sh` — thin wrappers, the double-click and terminal ways
  in. Both prefer a bundled runtime, then a Node on PATH.
- `update.mjs` — says whether a newer release exists. It does not download or
  install one; the desktop app is the copy that updates itself.

**Packaging**

- `tools/package.mjs` — runs `build.mjs` and then builds the portable zip, and
  nothing else; `VERSION` is the single source of the version number.
- `tools/make-icon.mjs` — rasterises `icon.svg` into the Windows `icon.ico`
  that the shortcuts, the NSIS installer and the packaged app use. Run it
  after editing `icon.svg`.
- `desktop/` — the Electron desktop app: source, `npm run dist:win` to build
  the per-architecture installers, and its own test suite.

**Serving the app**

- `server/server.ts` — a dependency-free Node server that serves the built app
  as static files; `start.mjs` runs it on your own computer.

**Notes**

- `docs/HANDOFF.md` — developer notes: architecture, the invariants that keep the
  document from corrupting, how to test, and what is still unverified. Read it
  before changing anything in `src/`.
- `.github/workflows/ci.yml` — path classification, code checks, four test
  shards, app browser suites and desktop smoke as described above.
