# Hosting Splitpage on Unraid

This puts Splitpage on your own domain so collaborators can open a link, sign
in with Google, and work on the same scripts you do — with edits merged rather
than overwriting each other.

**The container has no login of its own, on purpose.** Cloudflare Access does
that job in front of it, and does it better than anything hand-rolled here.
Follow §3 before you share the link with anyone.

---

## 1. What you get

- The app at `https://splitpage.yourdomain.com`, installable as a PWA.
- Documents stored **on the server**, not in each person's browser. Open one,
  edit it, and Save publishes straight back.
- **Concurrent editing that doesn't lose work.** Every save carries the version
  it started from. If someone saved while you were typing, the server hands
  their version back and Splitpage three-way merges the two. Edits to different
  scenes merge silently; edits to the *same* field keep theirs live and save
  yours as a review comment, so nothing is ever dropped.
- Your existing local workflow is untouched. Opening `index.html` from disk
  still works exactly as before, and **Save As** still gives you a local copy
  of a hosted script any time.

---

## 2. Build and run it

> **Stock Unraid has `docker` but not `docker compose`.** Compose only exists
> if you installed the *Compose Manager* plugin from Community Applications.
> The steps below use plain `docker`, which always works. If you do have
> Compose Manager, `docker compose up -d --build` in the source folder does the
> same thing and you can skip to §3.

### 2.1 Get the files onto the server

> **Build first if you are copying from the repository.** `index.html` is
> generated from the repo's own `src/` folder — run `node build.mjs` and copy
> the *result*. A checkout that has never been built either has no
> `index.html` or has a stale one, and the container will happily serve it.
> `node build.mjs --check` tells you which you have.
>
> The folder you make on the server below is also called `src`, which is an
> unrelated coincidence: it holds the *built* app, not the repo's source.

In Windows Explorer, open `\\TOWER\appdata` (replace `TOWER` with your
server's name — the same one you use for other shares). Create a folder
`splitpage`, and inside it a folder `src`, then copy the whole contents of
`splitpage-app` into `src`.

You should end up with:

```
/mnt/user/appdata/splitpage/src/
    index.html
    manifest.webmanifest
    icon.svg
    sw.js
    Dockerfile
    server/server.js
```

*If `\\TOWER\appdata` won't open*, the share isn't exported over SMB. In the
Unraid web UI: **Shares → appdata → SMB Security Settings → Export = Yes**.
(Set it back to No afterwards if you prefer it hidden — the container reads
from disk, not from the share.)

### 2.2 Build and start it

Unraid web UI → **Terminal** (the `>_` icon, top right). Then:

```bash
mkdir -p /mnt/user/appdata/splitpage/data
```

```bash
docker build -t splitpage /mnt/user/appdata/splitpage/src
```

That pulls `node:22-alpine` and takes a minute or two the first time. Then:

```bash
docker run -d --name splitpage --restart unless-stopped -p 8791:8791 -v /mnt/user/appdata/splitpage/data:/data --user 99:100 splitpage
```

`--restart unless-stopped` means it comes back by itself after a reboot. The
container now shows up on Unraid's **Docker** tab like any other.

### 2.3 Check it works

```bash
docker logs splitpage --tail 20
```

You want `listening on 0.0.0.0:8791`. Then, from your PC's browser, visit
`http://TOWER-IP:8791` — find the IP on Unraid's **Dashboard**, or run
`hostname -I` in the terminal. Splitpage should load, and **File** should show
*Open from the server…*.

### If it won't start

Almost always permissions on the data volume — the container runs as a
non-root user. `docker logs splitpage` showing `EACCES` means the uid is wrong.
Check what actually owns the folder:

```bash
ls -ln /mnt/user/appdata/splitpage
```

`99 100` is Unraid's usual `nobody:users` and matches the `--user 99:100`
above. If yours differs, remove and recreate the container with the right
values:

```bash
docker rm -f splitpage
```

### Updating later

Copy the changed files into `src` again, then:

```bash
docker rm -f splitpage && docker build -t splitpage /mnt/user/appdata/splitpage/src && docker run -d --name splitpage --restart unless-stopped -p 8791:8791 -v /mnt/user/appdata/splitpage/data:/data --user 99:100 splitpage
```

Your documents live in the `data` volume, which this does not touch.

### Where your documents live

One JSON file per script in `/mnt/user/appdata/splitpage/data`. That is the
whole database — no index, nothing to rebuild. **Back it up by copying the
folder.** Include it in your normal Unraid appdata backup and you are covered.

Each file is written with a summary on its first line and the script on its
second:

```json
{"id":"kitchen-ab12","rev":7,"updatedAt":"…","updatedBy":"…","title":"Kitchen","rows":9,
"state":{ …the whole script… }}
```

It is still one JSON object — the newline is whitespace, so anything that
reads JSON reads it unchanged. The point of the split is that the picker can
list twenty scripts, and a save can check the revision it is replacing,
without parsing twenty scripts in full. Documents written by an older version
have no such line; they are read the old way and quietly rewritten with one
the next time they are listed or saved. Each save is fsynced and renamed into
place, so a power cut leaves the previous version, never a half-written one.

---

## 3. Put it behind Cloudflare Access — do this before sharing the link

You already run a tunnel for Seer, so this is a second hostname on it plus a
policy. Nothing here touches the container.

### 3.1 Route the hostname

Cloudflare dashboard → **Zero Trust** → **Networks → Tunnels** → your tunnel →
**Configure** → **Public Hostnames** → **Add a public hostname**:

| Field | Value |
| --- | --- |
| Subdomain | `splitpage` |
| Domain | `yourdomain.com` |
| Service type | `HTTP` |
| URL | `192.168.1.50:8791` — your Unraid IP and the port |

Use `HTTP`, not `HTTPS` — the hop from the tunnel to the container is inside
your LAN, and the container speaks plain HTTP. Visitors still get HTTPS,
because Cloudflare terminates it at the edge.

The tunnel dials **out** to Cloudflare, so you never forward a port and 8791
stays off the internet.

### 3.2 Add Google as a sign-in method

Zero Trust → **Settings → Authentication** → **Login methods** → **Add new** →
**Google**. Cloudflare walks you through creating the Google OAuth client and
tells you exactly which redirect URL to paste in.

If that turns fiddly, **One-time PIN** needs no setup at all — collaborators
get a six-digit code by email instead. You can add Google later without
changing anything else.

### 3.3 Lock the hostname down

Zero Trust → **Access → Applications** → **Add an application** →
**Self-hosted**:

- **Application domain:** `splitpage.yourdomain.com`
- **Session duration:** 24 hours is a good default (see §5).
- Add a policy: **Action = Allow**, and either
  - **Include → Emails →** each collaborator's address, or
  - **Include → Emails ending in →** `@yourdomain.com` for everyone in your org.

Include your own address, or you will lock yourself out.

### 3.4 Check it

Open `https://splitpage.yourdomain.com` in a private window. You should get a
Cloudflare sign-in page, **not** Splitpage. Sign in and the app loads.

> If Splitpage loads without asking you to sign in, the policy is not applied.
> Stop and fix that before sending the link to anyone — until it is, the URL is
> open to whoever finds it.

Free tier covers 50 users, which is far more than a video crew needs.

---

## 4. Using it

**Publish your first script.** Open the app, then **File ▸ Put this script on
the server**. The chip by the title changes to *On the server*, and from then
on Save publishes there.

**Collaborators.** Send them the link. **File ▸ Open from the server…** lists
everything published; they pick one and start working. Their name is filled in
automatically from the Google account they signed in with, so review comments
are attributed without anyone typing anything.

**Two people at once.** Both just work. Splitpage merges on save. If you both
change the *same* line, theirs stays in the script and yours is kept as a
comment flagged "Unmerged edit" — click **Review conflicts** in the banner to
see them.

**Taking a copy.** **Save As** always writes a local `.html`, even when a
hosted document is open. That is how you fork a script, or keep an archive.

---

## 5. Things worth knowing

**Sessions expire.** At the duration set in §3.3. When one does mid-edit,
Splitpage notices — a background save would otherwise get a sign-in page back
where it expected data — stashes your unsaved work, and tells you to reload.
After you sign in again it reopens the document and merges your stashed edits
back in, including anything that changed while you were out. Longer sessions
mean fewer interruptions; shorter ones are stricter. 24 hours is a reasonable
middle.

**No per-user permissions.** Anyone Access lets in can edit and delete any
document. There are no roles. If you need a read-only audience, set
`READ_ONLY=1` in `docker-compose.yml` and run a second container pointed at the
same data folder on a different hostname with its own, broader Access policy.

**Deleting is immediate.** The picker's × asks once, then the document is gone
from the server. Your backup of the data folder is the undo.

**Large scripts.** Embedded images make documents big; the cap is 25 MB per
document (`MAX_BODY_BYTES`). Raise it if you hit it.

**`JOIN_PIN` is not a substitute for Access.** Setting `JOIN_PIN` in the
container's environment makes every `/api/*` route except `/api/health` and
`/api/join` require a token, which a client gets by posting the right PIN. It
exists for the *launcher's* case — someone hosting a session on a laptop for
the people in the room — where there is no Access and no TLS. On the internet
it buys nothing Access does not already do, and it is weaker in every way: one
shared string, the same for everyone, valid until the process restarts, tied
to no person, with nothing to revoke and nothing to audit. Use Access. Setting
both is allowed and changes nothing about who reaches the container; the PIN is
then just one more thing to type.

If you do set it: the token is minted per process and held only in memory, so a
redeploy signs everyone out; wrong PINs are limited to ten a minute per address;
and neither the PIN nor the token is ever written to disk, logged, or served by
the static handler.

**`TRUST_PROXY=1`** tells that rate limit to count `X-Forwarded-For` instead of
the socket. Set it when the container only ever hears from a proxy — a
Cloudflare tunnel, nginx, or Docker's own NAT — because there every request
arrives from the same address and the limit is one bucket for the whole house:
one stranger's ten wrong guesses lock everybody out for a minute. Only the
first entry of the header is read, and anything that is not an address is
ignored.

**Do not set it if anything can reach the port directly.** `X-Forwarded-For` is
just a request header: whoever can talk to the port writes what they like in
it, so trusting it there hands a guesser a fresh allowance per guess and turns
the limit off. Off is the default for that reason.

**`ALLOW_ORIGINS`** is a comma-separated allowlist of origins permitted to call
the API cross-origin. Empty (the default) means same-origin only, which is what
a deployment behind Access should stay. Entries match exactly and are echoed
back one at a time; `*` is never sent, and neither is
`Access-Control-Allow-Credentials` — so a cross-origin caller has to carry a
join token and cannot ride on somebody's Access cookie. Static files never
carry CORS headers either way.

The literal entry `null` used to be honoured, so that a copy opened from
`file://` could talk to a server. It is now ignored, with a line in the log
saying so: `null` is not one site. Every page opened from `file://`, and every
sandboxed iframe on every site on the internet, sends that same origin — so
allowing it allowed all of them. Serve the portable copy over `http://` and
name the origin it is served from.

**Updating.** Pull the new files and `docker compose up -d --build`. Documents
live in the mounted volume, so they are unaffected.

---

## 6. Desktop installers (Windows)

Splitpage is available as a standalone desktop application built with Electron 44
and packaged with electron-builder 26. Starting with 2.0.0, these installers are
part of the release recipe (§7) alongside the portable zip.

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
in dev) so both layouts serve identical files under the same allowlist. This
machine's dev Electron is pinned to a native ARM64 binary rather than the x64
build `npm install` fetches by default (`desktop/.npmrc`, `arch=arm64` — see
HANDOFF.md §2); `desktop/test/smoke.mjs`'s dev-target runs, including the
tabs cases, execute against that native ARM64 Electron, not under emulation.

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

## 7. Publishing a release to the mirror

When it's time to cut a new release for users to update to, build the two pieces
separately — the portable zip from `package.mjs`, and the Electron installers
from `desktop/`:

```bash
node package.mjs
cd desktop && npm run dist:win
```

`node package.mjs` writes `dist/splitpage-<version>.zip` and nothing else — it
has no flags left. `npm run dist:win` runs `stage.mjs`, `electron-builder`, and
finishes with `verify-dist.mjs` (§6); do not publish if it does not print ALL
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
code signing is set up (see §6, "What's NOT verified").

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

---

## 8. Troubleshooting

| Symptom | Cause |
| --- | --- |
| App loads, but no server items in the File menu | The app can't reach `/api/health` — it's being served as static files, not by this container. Check the tunnel points at the container's port. |
| "Your sign-in expired" straight after signing in | Access is returning its login page to API calls. Usually the Access application covers a *path* rather than the whole hostname — it must cover `splitpage.yourdomain.com` entirely, `/api/` included. |
| `EACCES` in the logs | Data volume permissions — see §2. |
| Saves fail with 413 | Document over `MAX_BODY_BYTES`. Raise it and restart. |
| Everyone shows as the same person in comments | Access isn't passing an identity, so Splitpage falls back to asking for a name. Confirm the Access app is on and the tunnel isn't bypassing it. |
