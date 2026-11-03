# Running and releasing Splitpage

This file covers running the app locally, building the desktop installers and
publishing releases. Splitpage's server serves the built app as static files and
nothing else. It has no API, no data folder and no settings you need to set.

---

## 1. Serving the app

From the project folder:

```bash
node start.mjs
```

`start.mjs` starts the static server and opens the app in the browser. The
server reads three settings, all optional:

| Setting | Default | What it does |
| --- | --- | --- |
| `PORT` | `8791` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to listen on |
| `STATIC_DIR` | `public/` beside `server/` | Folder of files to serve |

---

## 2. Desktop installers (Windows)

Splitpage is available as a standalone desktop application built with Electron 44
and packaged with electron-builder 26. Starting with 2.0.0, these installers are
part of the release recipe (§3) alongside the portable zip.

### Building the installers

From the `desktop/` folder:

```bash
npm install
npm run dist:win
```

This runs `stage.mjs` (which runs the app's `build.mjs`, verifies versions match,
stages files) and then `electron-builder`, producing:

- `dist/SplitpageDesktopSetup-<version>-x64.exe` — x64 only (~106 MB)
- `dist/SplitpageDesktopSetup-<version>-arm64.exe` — ARM64 only (~100 MB)
- `dist/SplitpageDesktopSetup-<version>.exe` — combined installer carrying both
  architectures (~206 MB); it installs the one that matches the machine
- `dist/win-unpacked/` and `dist/win-arm64-unpacked/` — the unpacked apps the
  installers are built from; `desktop/test/smoke.mjs` tests these directly

Nothing under `dist/`, `.stage/` or `node_modules/` is committed
(`desktop/.gitignore`).

**Check the architectures before publishing anything.** electron-builder
builds for the host's architecture unless told otherwise, and this build
machine is ARM64. `electron-builder.yml` and `dist:win` both pin x64 + arm64,
and `dist:win` finishes by running `node verify-dist.mjs` (also
`npm run verify-dist` on its own). The script reads the PE machine field of
each binary (014C x86, 8664 x64, AA64 ARM64) and fails unless:
- each unpacked `Splitpage.exe`, and every other `.exe`/`.dll`/`.node` beside
  it, is exactly its architecture (electron-builder's x86 `elevate.exe` is
  allowlisted);
- each installer's stub can start on its target PC. electron-builder's NSIS
  stub is x86 by design, so a setup exe reading 014C is correct;
- each installer is no older than the unpacked app it was built from.

The same trap shipped 1.0.1's IExpress `SplitpageSetup-x64.exe` as an ARM64
binary that no x64 PC could start: IExpress stamps the architecture of the
`iexpress.exe` that built it.

`verify-dist.mjs` also fails a package whose `resources/splitpage/index.html`
exposes a test hook outside the release list in `tools/release-hooks.mjs`, so
a test build cannot be published by mistake.

### The packaged smoke at a release gate

The release package has no test hooks, and most smoke groups drive one. So
the packaged check runs twice (Adam, on #974):

- **The test package, every group.** `npm run dist:win:test` stages the test
  build (`stage.mjs --test`, which runs `node build.mjs --test`) and packages
  it, unpacked only, into `dist-test/win-unpacked/` and
  `dist-test/win-arm64-unpacked/`. It is never published: no installer, not
  built by `release.yml`, and `verify-dist.mjs` refuses it.
- **The release package, the hook-free groups.** `desktop/test/smoke.mjs`
  runs the groups marked `hookFree` against `dist/win-unpacked/` and
  `dist/win-arm64-unpacked/`, checks that their `index.html` exposes no hook
  outside the release list, and lists every other group as a skip.

The commands, and the rebuild of the dev target that follows `dist:win`, are
in [WINDOWS-CHECKS.md, Before you start](WINDOWS-CHECKS.md#before-you-start).

### What's NOT verified

- **The installers are unsigned.** They land in `dist/` unsigned; Windows SmartScreen
  will warn on first run (click "More info" then "Run anyway"). Signing (Windows
  SmartScreen + macOS notarization if macOS builds are added) is a pending decision.
- **macOS/Linux builds.** Only Windows installers are built and published; the `mac`
  and `linux` targets in `electron-builder.yml` are configured but unused so far.

### Tabs build (2026-09-14) and the ARM64 dev pin

Since the tabs build, the title-bar tab strip (`desktop/tabstrip/`: `index.html`,
`tabstrip.js`, `tabstrip.css`) is a second privileged origin
(`splitpage://tabstrip`) served from files on disk rather than from the asar —
`electron-builder.yml`'s `extraResources` ships them to
`resources/splitpage/tabstrip` in the packaged app, staged there by
`stage.mjs`, and `main.ts` resolves that same path (vs. `__dirname/tabstrip`
in dev) so both layouts serve identical files under the same allowlist. Run
`npm ci` followed by `npm run fetch-electron` in `desktop/` to fetch the
machine's dev Electron (see HANDOFF.md §2). The script detects native ARM64
on Windows even under x64 Node emulation, so dev smoke runs, including the
tabs cases, use native Electron. Explicit `npm_config_arch` or `ELECTRON_ARCH`
overrides detection, in that order; unknown values fail.

### Where they differ from the IExpress recipe that used to be here

Until 3.0 there was a second Windows installer: `tools/package.mjs --installer` wrapped
`installer/install.ps1`, `installer/uninstall.ps1` and a downloaded `node.exe`
in a self-extracting archive built by `iexpress.exe`. It had been deprecated
since 2.0.0 and unpublished since then; it is **deleted** now, along with
`installer/`, `tools/fetch-runtime.mjs` and the `--installer` flag itself. The
Electron-built installers, which ship instead:

- Run natively inside Electron's window frame with native title bar and menus
- Have stable `splitpage://app` origin, so localStorage/IndexedDB/version history
  survive across launches regardless of port changes
- Use `electron-builder`'s NSIS configuration instead of IExpress
- Carry their own runtime: Electron bundles Chromium and Node, so no separate
  portable Node has to be downloaded and packed
- Support both x64 and ARM64 architectures with native binaries


## 3. Publishing a release

**Branches.** `main` is the only long-lived branch, and it can hold work that
has not been released. A release is a tag on `main`, cut when things are
stable and not in the middle of a multi-PR feature. To fix a released version
while `main` isn't ready to ship, branch from its tag as `hotfix/<name>`, make
the fix and bump `VERSION`, and push. CI runs on pushes to `hotfix/` branches,
and the [release gate](architecture/ci.md#release-gate) needs it to pass on
the commit you tag. Then merge the branch back into `main`.

**From CI.** Pushing a `v<version>` tag on the commit that bumped `VERSION`
runs `.github/workflows/release.yml`. It first refuses a commit with no passed
CI run (the `verify-ci` job; see
[ci.md, Release gate](architecture/ci.md#release-gate)), then on a Windows runner
does the two builds below, `verify-dist`, and `SHA256SUMS.txt`. With the
`GITHUB_TOKEN` it opens a **draft** release in this repository with the four
files, marked pre-release for a version with a `-` in it; review it and press
Publish.

**By hand.** When it's time to cut a new release for users to update to, build the two pieces
separately — the portable zip from `tools/package.mjs`, and the Electron installers
from `desktop/`:

```bash
node tools/package.mjs
cd desktop && npm run dist:win
```

`node tools/package.mjs` writes `dist/splitpage-<version>.zip` and nothing else — it
has no flags left. `npm run dist:win` runs `stage.mjs`, `electron-builder`, and
finishes with `verify-dist.mjs` (§2); do not publish if it does not print ALL
PASS.

Ship the zip every release. It is the portable app, and it is also what a
pre-3.0 copy looks for: the 1.0.x/2.x launcher hard-fails its own update unless
the release carries an asset matching `/^splitpage-.*\.zip$/`. A 3.0 copy no
longer installs it by itself — that self-update path is gone, and the portable
copy is updated by unzipping a newer release over it — but leaving the asset off
would break the copies still running the old launcher.

On the GitHub repository (`RetroGorilla/splitpage`):

1. **Create a new release** with tag `v<version>` (where `<version>` matches `VERSION` in the repo).
2. **Upload the assets** (names must match `desktop/electron-builder.yml`'s
   `artifactName` exactly):
   - `dist/splitpage-<version>.zip` (the portable app; required for 1.0.x update compatibility)
   - `desktop/dist/SplitpageDesktopSetup-<version>-x64.exe` (Electron installer, x64)
   - `desktop/dist/SplitpageDesktopSetup-<version>-arm64.exe` (Electron installer, ARM64)
   - `SHA256SUMS.txt` (checksums for the three files above)

   The combined two-architecture installer (`SplitpageDesktopSetup-<version>.exe`,
   built when both archs are packaged together) is **not** published; only the
   per-arch installers are.
3. **Publish the release.**

The Electron installers are unsigned, so Windows SmartScreen will warn on first
run — click "More info" then "Run anyway" to proceed. This is expected until
code signing is set up (see §2, "What's NOT verified").

The 2.0.0 installer also removes a detected 1.0.x install from
`%LOCALAPPDATA%\Programs\Splitpage` before installing, keeping the shared-session
data folder untouched; see the `customInit` macro committed in
`desktop/build/installer.nsh`.

Existing installations check this repository's latest release on startup and
say when there is something newer; the desktop app offers to install it.

**Where that update URL comes from.** `SPLITPAGE_UPDATE_API` is honoured only
with `SPLITPAGE_TEST=1`, in both the desktop app and the portable update checker.
Otherwise they use the default compiled into `update.mjs` and
`desktop/update-release.ts`, and nothing else. Release page links must use
`https://github.com/RetroGorilla/splitpage/releases/tag/<tag>`; asset and checksum
URLs must use `https://github.com/RetroGorilla/splitpage/releases/download/<tag>/<asset>`.
Feed URLs pointing directly at GitHub's asset host are refused. After validating
the repository download URL, the desktop app follows GitHub's redirect to its
asset host normally. Test feeds may use their own HTTP or HTTPS origin only
under the test switch. Malformed or untrusted release fields fail the update check.
`release.json`
used to be copied into each release's `.splitpage-release.json` as an
`updateApi` field that the next update check would follow; #64 made that field
ignored (a release naming where the next release comes from is a redirect
nobody could revoke) and #75 stopped writing it, and the file itself is gone. To move it, change the
default in those two files and cut a release from it.

