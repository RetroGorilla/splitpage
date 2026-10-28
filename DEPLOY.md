# Running Splitpage

Splitpage's server serves the built app as static files and nothing else. It
has no API, no data folder and no settings you need to set.

---

## 1. Serving the app

Without Docker, from the project folder:

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

With Docker, from a checkout:

```bash
docker build -t splitpage .
docker run -d --name splitpage --restart unless-stopped -p 8791:8791 splitpage
```

or `docker compose up -d --build` on a machine that has compose. The image
healthcheck asks `/` for a 200.

From the CI build (Actions, the run, *Artifacts*: `splitpage-app`), unzipped,
`Dockerfile.prebuilt` copies the built files in and compiles nothing:

```bash
docker build -f Dockerfile.prebuilt -t splitpage .
```

The root `Dockerfile` needs the repository's source, so it does not work on
the artifact.

---

## 2. Deploying with deploy.sh

This section is for the unRAID box that hosts the app, at
`/mnt/user/appdata/splitpage/`, a clone of `RetroGorilla/splitpage`.

### 2.1 Getting the code

The repository is private, so the box pulls it over SSH with a read-only
deploy key. Its private half lives at `/boot/config/ssh/root/splitpage_deploy`
(the unRAID USB stick keeps root's SSH settings, so it survives reboots):

```bash
ssh-keygen -t ed25519 -N "" -C "oldman splitpage deploy" -f /boot/config/ssh/root/splitpage_deploy
cat >> /boot/config/ssh/root/config <<'EOF'

Host github-splitpage
    HostName github.com
    User git
    IdentityFile /boot/config/ssh/root/splitpage_deploy
    IdentitiesOnly yes
EOF
cat /boot/config/ssh/root/splitpage_deploy.pub
```

Add the printed public key on GitHub under `RetroGorilla/splitpage` →
**Settings** → **Deploy keys**, with **Allow write access** unticked. Then
check it with `ssh -T git@github-splitpage`. The clone uses that host name:

```bash
git clone git@github-splitpage:RetroGorilla/splitpage.git /mnt/user/appdata/splitpage
```

If the folder already exists and is not empty, move it aside rather than
deleting it: `mv /mnt/user/appdata/splitpage /mnt/user/appdata/splitpage-old`.

### 2.2 Deploying

```bash
cd /mnt/user/appdata/splitpage
./deploy.sh
```

It, in order:

1. pulls the latest `main` from GitHub (and starts over if that changed
   `deploy.sh` itself);
2. keeps the version running now as the image `splitpage:previous`, only if
   it answers `/`;
3. builds the new image. **The server stays up during the build.**
4. stops the server;
5. starts the new container;
6. waits up to 60 seconds for `/` to answer, then shows the log.

It refuses to run, with a red **STOPPED** line saying what to fix, if `.env`
sets `PORT`, `HOST` or `STATIC_DIR`, if any setting appears twice, or if
`.dockerignore` no longer excludes `.env`. `.env` itself is optional.

To go back to the previous version:

```bash
./deploy.sh rollback
```

The code folder keeps the newer commit, so the next `./deploy.sh` builds it
again. Get the problem fixed on GitHub first. Anyone with Splitpage open
should reload it after a deploy.

### 2.3 Traps

- **`git remote`** should show `git@github-splitpage:RetroGorilla/splitpage.git`.
  If it shows `https://` or `git@github.com:`, run
  `git remote set-url origin git@github-splitpage:RetroGorilla/splitpage.git`.
- **`git pull` refuses** (a deploy stops at step 1). Someone edited files in
  the code folder on the server. Nothing was deployed. `git status` lists the
  edits; `git stash push -m server-edits` sets them aside, kept, not deleted.
  If it still refuses, stop and ask. Do not reach for `git reset`.
- **`Permission denied (publickey)`** means the deploy key step did not take,
  or the `Host github-splitpage` block has a typo.
- **`Permission denied` running `./deploy.sh`** means the file lost its
  executable mark. `bash deploy.sh` does the same thing.
- **`$'\r': command not found`** means `deploy.sh` was saved with Windows line
  endings. `git checkout -- deploy.sh` puts GitHub's copy back.
- **Run it from the project folder.** `git` and `./deploy.sh` only work there.

### 2.4 When something is broken

```bash
docker ps -a | grep splitpage       # running, or exited?
docker logs --tail 100 splitpage    # the actual error
```

| Symptom | What to do |
| --- | --- |
| `./deploy.sh` stops with **STOPPED:** | The line says which setting in `.env` is wrong. Nothing was changed. |
| Deploy ends *did not come up healthy* | Read the log it printed, then `./deploy.sh rollback`. |
| *Bad gateway* / 502 at the address | The container isn't running (`docker ps -a`), or the address points at the wrong port. Port `8791` is the one the box publishes. |
| Container exited straight away | Read the log. |

---

## 3. Desktop installers (Windows)

Splitpage is available as a standalone desktop application built with Electron 44
and packaged with electron-builder 26. Starting with 2.0.0, these installers are
part of the release recipe (§4) alongside the portable zip.

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
`stage.mjs`, and `main.js` resolves that same path (vs. `__dirname/tabstrip`
in dev) so both layouts serve identical files under the same allowlist. Run
`npm ci` followed by `npm run fetch-electron` in `desktop/` to fetch the
machine's dev Electron (see HANDOFF.md §2). The script detects native ARM64
on Windows even under x64 Node emulation, so dev smoke runs, including the
tabs cases, use native Electron. Explicit `npm_config_arch` or `ELECTRON_ARCH`
overrides detection, in that order; unknown values fail.

### Where they differ from the IExpress recipe that used to be here

Until 3.0 there was a second Windows installer: `package.mjs --installer` wrapped
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

---

## 4. Publishing a release to the mirror

**From CI.** Pushing a `v<version>` tag on the commit that bumped `VERSION`
runs `.github/workflows/release.yml` on a Windows runner: the two builds
below, `verify-dist`, and `SHA256SUMS.txt`. With the
`SPLITPAGE_RELEASES_TOKEN` secret (a fine-grained token with Contents
read/write on `splitpage-releases` only) it opens a **draft** release there
with the four files, marked pre-release for a version with a `-` in it;
review it and press Publish. Without the secret the files are left on the
run as an artifact to upload by hand, as in steps 1–3 below.

**By hand.** When it's time to cut a new release for users to update to, build the two pieces
separately — the portable zip from `package.mjs`, and the Electron installers
from `desktop/`:

```bash
node package.mjs
cd desktop && npm run dist:win
```

`node package.mjs` writes `dist/splitpage-<version>.zip` and nothing else — it
has no flags left. `npm run dist:win` runs `stage.mjs`, `electron-builder`, and
finishes with `verify-dist.mjs` (§3); do not publish if it does not print ALL
PASS.

Ship the zip every release. It is the portable app, and it is also what a
pre-3.0 copy looks for: the 1.0.x/2.x launcher hard-fails its own update unless
the release carries an asset matching `/^splitpage-.*\.zip$/`. A 3.0 copy no
longer installs it by itself — that self-update path is gone, and the portable
copy is updated by unzipping a newer release over it — but leaving the asset off
would break the copies still running the old launcher.

On the GitHub releases mirror repository (`RetroGorilla/splitpage-releases`):

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
code signing is set up (see §3, "What's NOT verified").

The 2.0.0 installer also removes a detected 1.0.x install from
`%LOCALAPPDATA%\Programs\Splitpage` before installing, keeping the shared-session
data folder untouched; see the `customInit` macro committed in
`desktop/build/installer.nsh`.

Existing installations check the mirror on startup and say when there is
something newer; the desktop app offers to install it.

**Where that mirror URL comes from.** `SPLITPAGE_UPDATE_API`, or the default
compiled into `update.mjs` and `desktop/main.js`, and nothing else. `release.json`
used to be copied into each release's `.splitpage-release.json` as an
`updateApi` field that the next update check would follow; #64 made that field
ignored (a release naming where the next release comes from is a redirect
nobody could revoke) and #75 stopped writing it. To move the mirror, change the
default in those two files and cut a release from it.

