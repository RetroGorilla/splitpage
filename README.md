# Splitpage

A two-column visual/audio script editor — pictures on one side, narration on
the other — with a teleprompter, comments, and a production breakdown that
tracks every prop, location, VFX shot and person in the script. It ships as
one self-contained `index.html`, plus an optional Node launcher, a small
document server for shared sessions, and an Electron desktop app for Windows
(x64 and native ARM64).

This file is the **repo-facing** documentation: how to build it, how to cut a
release, and what each file in the tree is for.

**Looking for the user guide?** It is [`docs/help.md`](docs/help.md) —
installing, running, hosting a session, tagging, exporting, saving,
everything the app itself can do. That same file is rendered into the app's
own Help page (File ▸ User guide…) at build time, which is why it lives
apart from this one: a change to the README no longer rebuilds the app.

Hosting Splitpage for other people on a server is [DEPLOY.md](DEPLOY.md).
Developer notes — architecture, invariants, how to test — are
[HANDOFF.md](HANDOFF.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md); to
report a security problem, [SECURITY.md](SECURITY.md); what changed in each
release is in [CHANGELOG.md](CHANGELOG.md).

## Version 4.0 beta

The 4.0 beta (`4.0.0-beta.1`) is a prerelease: the update check in 3.1 does
not offer it, so download it from the releases page below. The final 4.0.0
will be offered to everyone, beta users included.

4.0 is a rebuild of the inside of Splitpage and adds no new feature: the code
now lives in folders that each own one job, and saving and switching
documents is safer. What changed for a person using it is in
[CHANGELOG.md](CHANGELOG.md). Scripts, `.splitpage` and Markdown files and
shared-script servers from 3.1 work unchanged, and a 4.0 app and a 3.1 server
work with each other either way: 13 of 13 checks passed in each direction (see
[the release checklist](docs/architecture/release-4.0-checklist.md)). What is
still legacy is listed honestly in
[the implementation plan](docs/IMPLEMENTATION-PLAN.md#8-follow-up-refactors-for-4x).

Installers and the portable zip are on the
[releases page](https://github.com/RetroGorilla/splitpage-releases/releases):
`SplitpageDesktopSetup-<version>-x64.exe`, `...-arm64.exe` for Windows on ARM,
and `splitpage-<version>.zip`. The installers are not code-signed, so Windows
may warn on first run.

## Working on the code

You need **Node 24.22.0** (the version in `.nvmrc`; CI uses it, and the test
runner warns on any other and refuses one outside `package.json`'s `engines`).

`index.html` is **generated, and it is not in the repository** — it is in
`.gitignore`. A fresh clone has no `index.html` until you build one, which
takes a `npm install` and one command:

```
npm install              # once: esbuild (build), eslint + jsdom (checks)
node build.mjs           # write index.html, stamp sw.js with VERSION
node build.mjs --check   # are both in step with src/ and VERSION?
```

The source is `src/` — `page.html` (the shell), `app.css` and `styles/`,
`seed-state.json` (the demo document), the folders that own one job each
(`core/`, `application/`, `adapters/`, `features/`, `bootstrap/`, and
`legacy/` for the bridges to the old modules) and the numbered ES modules in
`src/js/` that are still legacy, which esbuild bundles — plus `VERSION` and
`docs/help.md`, which is rendered into the in-app Help page. Nothing else
feeds the build. Which folder may import which is
[docs/architecture/dependencies.md](docs/architecture/dependencies.md).

The build inlines everything into one self-contained page, and that is a
requirement rather than a preference: saving writes this page's own HTML
back out with your document inside it, so a page that linked out to
`app.css`/`app.js` would produce saved files that only worked next to those
files. Editing `index.html` by hand therefore gets overwritten by the next
build — and because it is untracked, there is nothing to commit by accident
either: the copy in your working tree is yours, script and all.

`sw.js` **is** tracked, unlike `index.html`. It is the one shipped file that
cannot be inlined into the page (a service worker has to have its own URL),
so it is both the file you edit and the file that ships; the build only
stamps its cache name from `VERSION`. Commit it like any other source file,
and rebuild after a version bump so the stamp is current — CI fails if it
isn't.

Before pushing, run CI's fast gate:

```
npm run verify        # lint, types, dependency and comment gates, build and sw.js stamp, every unit test
```

While you work, run the focused checks for what you changed, browser suites
included for anything you can see in the app: the table in
[docs/architecture/testing.md](docs/architecture/testing.md#what-to-run-for-which-change)
says which, and the same page lists what each script runs.
[`.claude/skills/run-splitpage-app/SKILL.md`](.claude/skills/run-splitpage-app/SKILL.md)
drives the browser suites.

CI (`.github/workflows/ci.yml`) runs the same fast gate on every pull
request, plus the smoke, CSP and persistence browser suites, builds the app,
and uploads the built files as a `splitpage-app` artifact — a ready-built
copy for running the server without a checkout (`Dockerfile.prebuilt`;
[DEPLOY.md](DEPLOY.md) §8). The server itself is deployed from a checkout by
`deploy.sh`, whose `Dockerfile` builds the app. Whenever a file either image
depends on changes, `.github/workflows/docker.yml` builds and starts both:
the root `Dockerfile` from the checkout, and `Dockerfile.prebuilt` from the
artifact's files alone.

## Building a release

```
node package.mjs              # dist/splitpage-<version>.zip — portable, ~165 KB
```

**Nothing needs installing to build this.** The zip is written by
`package.mjs` itself rather than shelled out to `zip` or
`Compress-Archive`, so the same commit produces the same bytes on Windows and
on a Linux CI box.

For the desktop installers — x64 and native ARM64 — it's `cd desktop && npm
run dist:win`; see [Desktop app](docs/help.md#desktop-app) and DEPLOY.md.
Pushing a `v<version>` tag runs `.github/workflows/release.yml`, which builds
all of it and opens a draft release on the releases page
([DEPLOY.md §7](DEPLOY.md#7-publishing-a-release-to-the-mirror)). On a portable copy
carrying both architectures' runtimes, `start.bat` picks the right one
automatically.

## What changed from the Claude artifact

The editor, comments, teleprompter, tags, and local version-history panel
are unchanged — none of that ever depended on Claude. Two things did, and
were rewired to work standalone:

- **Save** used to publish to Claude's hosted copy of the artifact (with
  multi-writer conflict/merge handling). Now, the first time you click
  **Save**, your browser's native *Save As* dialog appears — pick a spot on
  disk. Every Save after that (in Chrome/Edge/other Chromium browsers)
  writes straight back to that same file, silently, no dialog. Once you have
  picked a file, edits go to it on their own — see
  [Autosave](docs/help.md#autosave) — and before that first save they don't, so nothing
  ever pops the file dialog on you unprompted.
- **Exports** (Word, Markdown, CSV, PDF, and "Save a copy" of an opened
  file) used to go through Claude's download capability. They now use a
  plain browser download, landing in your normal Downloads folder,
  everywhere.

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
`.html` copy each time, same as Export — open the newest one next session.
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
- `src/` — the source. `page.html` (the shell), `app.css` and `styles/`,
  `seed-state.json` (the demo document), `core/`, `application/`,
  `adapters/`, `features/`, `bootstrap/` and `legacy/` (see above), and `js/`
  — the remaining numbered ES modules esbuild bundles into the app's one inline
  script, in the boot order the legacy initializer shim `js/_entry.js` sets.
- `tests/` — unit tests for the owned folders; `src/test/` holds the older
  ones and the browser suites' helpers. `tools/` — the gates and runners;
  [docs/architecture/testing.md](docs/architecture/testing.md) says which to
  run.
- `docs/help.md` — the user guide, and a build input: `build.mjs` renders it
  into the in-app Help page. Editing it changes the app; editing this README
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

- `start.mjs` — the launcher: serves the app, opens your browser, and with
  `--host` shares the session with your network. It installs nothing.
- `start.bat` / `start.sh` — thin wrappers, the double-click and terminal ways
  in. Both prefer a bundled runtime, then a Node on PATH.
- `update.mjs` — says whether a newer release exists. It does not download or
  install one; the desktop app is the copy that updates itself.

**Packaging**

- `package.mjs` — runs `build.mjs` and then builds the portable zip, and
  nothing else; `VERSION` is the single source of the version number.
- `tools/make-icon.mjs` — rasterises `icon.svg` into the Windows `icon.ico`
  that the shortcuts, the NSIS installer and the packaged app use. Run it
  after editing `icon.svg`.
- `desktop/` — the Electron desktop app: source, `npm run dist:win` to build
  the per-architecture installers, and its own test suite.

**Hosting for other people**

- `server/server.js`, `Dockerfile`, `docker-compose.yml` — the hosted mode: a
  dependency-free Node server that serves the app and stores documents as one
  JSON file each. See [DEPLOY.md](DEPLOY.md).
- `deploy.sh`, `.env.example` — the one-command deploy on the owner's
  server and the settings template it checks; `Dockerfile.prebuilt` builds
  the same image from CI's already-built `splitpage-app` artifact.

**Notes**

- `HANDOFF.md` — developer notes: architecture, the invariants that keep the
  document from corrupting, how to test, and what is still unverified. Read it
  before changing anything in `src/`.
- `.github/workflows/ci.yml` — lint, unit tests, server and updater tests and
  two browser suites on every pull request, plus the build whose output is
  uploaded as the `splitpage-app` artifact.

## License

[MIT](LICENSE).
