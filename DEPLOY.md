# Running Splitpage's server

Splitpage's document server runs on the unRAID box **OldMan**, at
**https://script.bigmanonline.uk**. It keeps your scripts in one place, and
lets you hand someone a link to one script — to edit it or just comment on
it — without them installing anything.

Written to be followed without knowing Docker. If you only read one thing:

```bash
cd /mnt/user/appdata/splitpage
./deploy.sh
```

That is the whole deploy. It pulls the code, builds, snapshots your scripts,
swaps the container and shows the log. Everything below explains what it's
doing, how to set it up the first time, and how to fix things when they go
wrong.

- §1–5 are this server: where things live, first-time setup, deploying,
  looking after it, traps.
- §6–7 are how the desktop installers and releases are built.
- §8 is other ways to run the server (someone else's machine, Cloudflare
  Access in front, `docker compose`).
- §9 is what to do when something is broken.

**How it's locked.** There is no Cloudflare Access in front of this server,
on purpose (§2.5 says why). The server locks itself: a long **owner key**
that you type into Splitpage once per device, and an **invite link** per
script for everybody else, which opens that one script and nothing more.

---

## 1. Where everything lives

| Thing | Where |
| --- | --- |
| The app, live | https://script.bigmanonline.uk |
| Server | unRAID box (`OldMan`), reached over SSH as `root` |
| Project folder | `/mnt/user/appdata/splitpage/` — a clone of `RetroGorilla/splitpage` |
| Settings + the owner key | `/mnt/user/appdata/splitpage/.env` |
| **Your scripts** | `/mnt/user/appdata/splitpage/data/` — one `.json` file per script |
| Pictures in scripts | `/mnt/user/appdata/splitpage/data/blobs/` |
| **Invite links + sign-ins** | `/mnt/user/appdata/splitpage/data/links/` — `links.json` (the links you've made) and `secret` (what keeps your devices signed in) |
| Deploy-time snapshots | `/mnt/user/appdata/splitpage/backups/splitpage-*` (last 10) |
| Container name | `splitpage` |
| Port | `8791` — what the Cloudflare tunnel points at |
| Branch deployed | `main` (override for one run with `BRANCH=other ./deploy.sh`) |

**`data/` is the whole database.** No index, nothing to rebuild: copying the
folder *is* a backup. Three parts, and a backup needs all of them:

- the `.json` files — one per script, the script and its comments inside;
- `blobs/` — every picture, stored once, named by its fingerprint. A script
  whose picture file is gone shows a placeholder in its place;
- `links/` — **what keeps the links you've sent working, and you signed
  in.** Two files: lose `links.json` and every link you ever sent is dead
  (you'd have to make and send new ones); lose `secret` and every device
  has to type the owner key again. Both are readable by the server only,
  which is right — leave their permissions alone.

**Never edit anything inside `data/` or `backups/` by hand.** §4 explains
why the snapshots depend on it.

### Two different places

1. **The server** — where you SSH in. The project folder, `.env` and `data/`
   live here.
2. **Inside the container** — a sealed box running the server. It sees your
   scripts at `/data`; that is the *same folder* as
   `/mnt/user/appdata/splitpage/data` on the server, just viewed from inside.

The container is disposable. Deleting and rebuilding it is routine and loses
nothing, **as long as the data stays in the folder above, not inside it.**

---

## 2. First-time setup

Once, about twenty minutes. Everything happens in a terminal on OldMan:
`ssh root@oldman` from your PC, or the unRAID web UI's **Terminal** (the
`>_` icon, top right).

### 2.1 A deploy key for this repository

The repository is private, so the server pulls it over SSH with a read-only
**deploy key**, exactly as it does for BigManager. BigManager's key,
`bmo_deploy`, can't be reused: GitHub refuses a deploy key that is already on
another repository. So Splitpage gets its own, in the same place.

That place is `/boot/config/ssh/root/`, on the USB stick. unRAID keeps
root's SSH settings there, which is why `bmo_deploy` survives reboots, and
the `config` file beside it is what tells SSH which key to use for which
host. Have a look first:

```bash
ls -la /boot/config/ssh/root/
cat /boot/config/ssh/root/config
```

You should see `bmo_deploy` and a `config` with a `Host github.com` block
naming it. Leave that block alone.

**a. Make the key.**

```bash
ssh-keygen -t ed25519 -N "" -C "oldman splitpage deploy" -f /boot/config/ssh/root/splitpage_deploy
```

That makes two files: `splitpage_deploy`, the private half, which never
leaves the server, and `splitpage_deploy.pub`, the public half, which goes to
GitHub. `-N ""` means no passphrase — a deploy runs unattended, with no one
to type one.

**b. Tell SSH when to use it.** Both keys are for github.com, so this one
gets a made-up host name, `github-splitpage`, which only Splitpage's clone
uses; BigManager carries on using plain `github.com`. Run this **once**:

```bash
cat >> /boot/config/ssh/root/config <<'EOF'

Host github-splitpage
    HostName github.com
    User git
    IdentityFile /boot/config/ssh/root/splitpage_deploy
    IdentitiesOnly yes
EOF
```

`>>` adds to the end of the file. (A single `>` would replace the whole
file, BigManager's entry included — mind the two.) `IdentitiesOnly yes`
stops SSH offering BigManager's key instead, which GitHub would accept as
*a* key and then refuse for this repository.

**c. Give GitHub the public half.**

```bash
cat /boot/config/ssh/root/splitpage_deploy.pub
```

Copy the whole line it prints (it starts `ssh-ed25519`). On GitHub, open
`RetroGorilla/splitpage` → **Settings** → **Deploy keys** → **Add deploy
key**. Title: `OldMan (read-only)`. Paste the line into **Key**. Leave
**Allow write access** unticked. **Add key**.

**d. Check it.**

```bash
ssh -T git@github-splitpage
```

You want: `Hi RetroGorilla/splitpage! You've successfully authenticated, but
GitHub does not provide shell access.` If it asks *Are you sure you want to
continue connecting*, type `yes`. A warning about `known_hosts` ("Operation
not permitted") is harmless, the same as with BigManager: the USB stick
can't hold the link SSH tries to make. `Permission denied (publickey)` means
step c didn't happen, or step b has a typo.

### 2.2 Get the code

```bash
git clone git@github-splitpage:RetroGorilla/splitpage.git /mnt/user/appdata/splitpage
```

The address uses `github-splitpage`, not `github.com` — that is what picks
the key from 2.1. Every later `git pull` (which `deploy.sh` does for you)
uses it too.

If git says the folder *already exists and is not an empty directory*,
something is there from an earlier attempt. **Don't delete it** — it may
hold scripts. Move it aside, then clone again:

```bash
mv /mnt/user/appdata/splitpage /mnt/user/appdata/splitpage-old
```

(If `splitpage-old/data` has scripts in it you want, copy them in after
step 2.4, the way §4 *Restoring* does.)

### 2.3 Settings, and the owner key

```bash
cd /mnt/user/appdata/splitpage
cp .env.example .env
chmod 600 .env
KEY="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
sed -i "s/^JOIN_PIN=.*/JOIN_PIN=$KEY/" .env
grep '^JOIN_PIN=' .env
```

Line by line: copy the template to `.env`; make it readable by root only;
make a random 32-character key of letters and digits; write it into the
`JOIN_PIN=` line; show you that line.

**Copy the part after `JOIN_PIN=` into your password manager now**, as
"Splitpage owner key". That is the owner key. (It is called `JOIN_PIN` in
the file — a name left over from the laptop launcher.) Whoever has it can
open, change and delete every script and make or cancel links, so it is
only ever typed into Splitpage, never sent to anyone.

The other settings in `.env` are already what this server needs:
`PERSIST_LINKS=1`, `TRUST_PROXY=cloudflare` and
`ALLOW_ORIGINS=splitpage://app`. `nano .env` shows what each one does.

### 2.4 First deploy

```bash
cd /mnt/user/appdata/splitpage
./deploy.sh
```

The first build downloads Node and takes a few minutes; later ones are
quicker. It ends with **Done — deployed `<commit>`**, a line starting
`/api/health says:`, and then the server's log. Press Ctrl-C to leave the
log — the server keeps running.

Check it from a PC at home: `http://<unraid-ip>:8791` (the IP is on unRAID's
**Dashboard**) should load Splitpage.

### 2.5 Point the Cloudflare tunnel at it

The same thing you did for BigManager's `life.bigmanonline.uk`. Cloudflare
dashboard → **Zero Trust** → **Networks → Tunnels** → your tunnel →
**Configure** → **Public Hostname** → **Add a public hostname**:

| Field | Value |
| --- | --- |
| Subdomain | `script` |
| Domain | `bigmanonline.uk` |
| Service type | `HTTP` |
| URL | `<unraid-ip>:8791` — the same IP BigManager's entry uses |

`HTTP`, not `HTTPS`: the hop from the tunnel to the container stays inside
your home network, and visitors still get HTTPS because Cloudflare adds it.
The tunnel dials out to Cloudflare, so you never forward a port on your
router — and must not forward this one.

**Do not add an Access application for `script.bigmanonline.uk`.** The
Splitpage desktop app and the people you send links to talk to the server
directly and can't carry a Cloudflare Access sign-in, so Access would lock
them out; the server's owner key and invite links are the lock instead.
(If you have an Access application for `*.bigmanonline.uk`, it covers this
hostname too — check **Access → Applications**.)

### 2.6 Check it from outside

On your phone, **with Wi-Fi off**, open:

```
https://script.bigmanonline.uk/api/health
```

You should get one line of text containing `"authRequired":true`,
`"links":1` and `"linksPersist":true`. Then `https://script.bigmanonline.uk`
should load Splitpage — without a Cloudflare sign-in page. A sign-in page
means an Access application covers the hostname (2.5). *Bad gateway* means
the tunnel's URL is wrong or the container isn't running (§9).

### 2.7 Sign in from the app

In Splitpage — the desktop app or the web page — press **Collaborate** and
paste the owner key. That device stays signed in, through restarts and
deploys; do it once on each device you use.

From then on, **Collaborate** on a script makes a **Can edit** or **Can
comment** link to send. The person opens it in their browser: no account,
nothing to install, and they see that one script only.

---

## 3. Deploying a change

```bash
cd /mnt/user/appdata/splitpage
./deploy.sh
```

In order, it:

1. pulls the latest `main` from GitHub (and starts over if that changed
   `deploy.sh` itself);
2. keeps the version running now as the image `splitpage:previous` — only
   if it is healthy, so a re-run after a failed deploy can't replace the
   last good version with the broken one;
3. builds the new image. The app is compiled inside the build, so the
   server needs no Node of its own. **The server stays up during the build**,
   so a failed build costs you no downtime;
4. stops the server;
5. snapshots `data/` into `backups/` (§4);
6. starts the new container, as `99:100` (unRAID's `nobody:users`), after
   making sure `data/` belongs to that user;
7. waits up to 60 seconds for `/api/health` to answer, prints what it says,
   and shows the log.

**It refuses to run** — a red **STOPPED** line saying what to fix — if
`.env` is missing, if `JOIN_PIN` is missing, shorter than 20 characters or
has a quote or space in it, if `PERSIST_LINKS` isn't `1`, if `TRUST_PROXY`
isn't `cloudflare`, if any setting appears twice, or if `.env` sets `PORT`,
`HOST`, `DATA_DIR` or `STATIC_DIR` (the image sets those). It also won't
build if `.dockerignore` has stopped keeping `data/`, `backups/` and `.env`
out of what Docker is handed. It **warns** and
carries on if `ALLOW_ORIGINS` doesn't include `splitpage://app` (the desktop
app couldn't connect), or if the new server doesn't report
`"linksPersist":true`.

If it asks for a GitHub username or password, the clone's address is wrong —
see *git asks for a username* in §5.

The last lines either say **Done — deployed `<commit>`**, or that the new
version did not come up healthy, followed by:

```bash
cd /mnt/user/appdata/splitpage
./deploy.sh rollback
```

That starts the previous version again. It **does not touch your data**:
scripts, pictures, links and `.env` stay exactly as they are. The code
folder keeps the newer commit, so the next `./deploy.sh` would build it
again — get the problem fixed on GitHub first.

Run from a terminal, a deploy ends by following the log until you press
Ctrl-C. Run without one — `ssh oldman 'cd /mnt/user/appdata/splitpage &&
./deploy.sh'` from another machine, as Claude does — it prints the last 40
lines once and exits, so the command finishes by itself.

**Anyone with Splitpage open should reload it** after a deploy. A page
older than the server can't save a script that has pictures in it: the
server answers "This page is out of date for this server", because an older
page would drop the pictures it can't see.

---

## 4. Looking after it

### Everyday commands

```bash
cd /mnt/user/appdata/splitpage

docker ps                          # is it running?
docker logs --tail 100 splitpage   # what did it say?
docker restart splitpage           # turn it off and on again
nano .env                          # change a setting...
docker restart splitpage           # ...then restart to apply it
```

**Changing `.env` does nothing until the container restarts.** That trips
everyone up once. (`./deploy.sh` also applies it, and checks the file first;
it just takes longer.)

### Backups

Every `./deploy.sh` stops the server and snapshots `data/` — scripts,
pictures and links together — into `backups/splitpage-<date>-<time>/`,
keeping the newest 10.

Each snapshot is a **hard-link snapshot**: made in a moment and costing
almost no space, because a file that hasn't changed is *shared* with `data/`
rather than copied. That is still a real backup, because the server never
changes a file once it has written it. Every save writes a new file and
swaps it in under the old name; pictures are never rewritten at all. So the
file a snapshot shares is never touched again, and a script you delete from
the app disappears from `data/` only. The one thing that *would* break this
is editing a file inside `data/` or `backups/` by hand — editors like `nano`
rewrite a file in place, and every snapshot sharing it would change too.
Don't. (If the disk can't hard-link, `deploy.sh` makes an ordinary full
copy instead, and says so.)

The snapshots sit on the same disk as the app. For a copy somewhere else,
copy the newest one — it was taken with the server stopped, so it is
consistent:

```bash
cd /mnt/user/appdata/splitpage
mkdir -p /mnt/user/backups/splitpage
cp -a "$(ls -1d backups/splitpage-* | tail -n 1)" /mnt/user/backups/splitpage/
```

(Make a `backups` share in the unRAID web UI first, **Shares → Add Share**,
ideally on a different disk.) Including `/mnt/user/appdata/splitpage/data`
in whatever backs up the rest of your appdata works too.

**What no backup contains:** `.env`, which holds the owner key. The key is
in your password manager (2.3). If `.env` is ever lost, make a new one the
same way, with a new key: your scripts and every link you've sent carry on
working, and each device just signs in again with the new key.

### Restoring

Run on the server. This puts the current data aside rather than deleting
it, so a restore can itself be undone.

1. See which snapshots exist (newest last):

   ```bash
   cd /mnt/user/appdata/splitpage
   ls -1d backups/*
   ```

2. Stop the server and move the current data aside:

   ```bash
   cd /mnt/user/appdata/splitpage
   docker stop splitpage
   mv data "backups/before-restore-$(date +%Y%m%d-%H%M%S)"
   ```

3. Copy the snapshot in. Put the folder you picked from step 1 after `B=`:

   ```bash
   cd /mnt/user/appdata/splitpage
   B=backups/splitpage-20260927-120000
   cp -a "$B" data
   docker start splitpage
   ```

   `cp -a` makes a real copy, with the same owners, so the snapshot itself
   stays as it was.

4. Open the app and check your latest scripts are what you expect, and that
   a link you've sent still opens. If something is wrong, repeat steps 2–3
   with the `backups/before-restore-…` folder as `B` to put things back.

Never touch `.env` while restoring.

### If the server won't start: a damaged links file

Rather than quietly start with every link forgotten, the server refuses to
start when `data/links/links.json` or `data/links/secret` can't be read.
The container then keeps restarting, and `docker logs --tail 20 splitpage`
names the file. Put back the copy from the newest snapshot — moving the
damaged one aside first rather than copying over it, because copying over a
file changes it in place, and the snapshots may share it:

```bash
cd /mnt/user/appdata/splitpage
docker stop splitpage
ls -1d backups/splitpage-*        # the newest is last
F=links.json                      # or secret: whichever the log named
mv "data/links/$F" "backups/$F.damaged-$(date +%Y%m%d-%H%M%S)"
cp -a "backups/splitpage-20260927-120000/links/$F" data/links/
docker start splitpage
```

(Use the snapshot folder from the `ls` line in place of
`splitpage-20260927-120000`.) If no snapshot has a good copy, leave the file
moved aside and just `docker start splitpage`. Nothing else is lost:
without `links.json` every link you'd sent is dead, so make new ones from
**Collaborate**; without `secret` every device signs in again with the
owner key.

### Changing the owner key

If the key might have got out, or you just want a new one:

```bash
cd /mnt/user/appdata/splitpage
KEY="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
sed -i "s/^JOIN_PIN=.*/JOIN_PIN=$KEY/" .env
grep '^JOIN_PIN=' .env
docker restart splitpage
```

Put the new key in your password manager in place of the old one. **Every
device signed in with the old key is signed out** and needs the new one
typed once (Collaborate). **Invite links you've already sent keep
working** — they don't contain the key.

### Turning off a link

From the app: open that script, **File ▸ Collaborate…**, and press **Turn
off** on the link (twice — it asks you to confirm). **New link** instead
makes a fresh one and stops the old one working. Nothing to do on the
server. Changing the owner key does *not* turn links
off (see above).

---

## 5. Traps, and things worth knowing

- **This server does NOT have `docker compose`.** unRAID ships without it;
  `docker compose up` fails with `unknown shorthand flag: 'd'`. The
  `docker-compose.yml` in the repository is for other machines (§8). Here
  it's plain `docker build` + `docker run`, which is exactly what
  `deploy.sh` does.
- **Port must match the tunnel.** Cloudflare forwards to one port on this
  box; `deploy.sh` publishes `8791`. If the site gives *Bad gateway* after a
  deploy, that mismatch is the first thing to check. `PORT=1234 ./deploy.sh`
  overrides it (then change the tunnel to match). Not `PORT=` in `.env` —
  that is the port *inside* the container, and `deploy.sh` refuses it.
- **`EACCES` in the log means `data/` belongs to the wrong user.** The server
  runs as `99:100` (`nobody:users`), so everything in `data/` must belong to
  it. `deploy.sh` fixes this on every deploy; after copying files in by hand
  as root, fix it yourself:

  ```bash
  chown -R 99:100 /mnt/user/appdata/splitpage/data
  docker restart splitpage
  ```

- **Changing `.env` needs a restart.** See §4.
- **Never run it without the owner key.** Without `JOIN_PIN` the server is
  open: anyone who finds the address can read, change and delete every
  script. `deploy.sh` refuses to start it that way; a `docker run` typed by
  hand would not.
- **No quotes in `.env`.** Docker keeps them as part of the value, so
  `JOIN_PIN="abc…"` makes the key include the quote marks and the one you
  type never matches. `deploy.sh` refuses it. The same goes for a comment
  after a value on the same line.
- **`TRUST_PROXY` must be `cloudflare`, not `1`.** Behind the tunnel every
  request reaches the server from the same address, so it needs to be told
  where each visitor really is in order to limit wrong owner-key guesses
  (ten a minute, per visitor). `TRUST_PROXY=1` reads `X-Forwarded-For`,
  which a visitor can fill in themselves — Cloudflare passes their version
  along and adds the real address after it — so a guesser could claim a new
  address with every guess. `cloudflare` reads `Cf-Connecting-Ip`, which
  Cloudflare sets itself and nobody can forge through the tunnel.
- **Never forward port 8791 on your router.** The wrong-key limit trusts
  `Cf-Connecting-Ip` because only Cloudflare can set it — but anything that
  reaches 8791 *directly*, skipping the tunnel, can write whatever it likes
  in that header and get a fresh allowance of guesses every time. From your
  own home network that is acceptable (that is how the tunnel reaches it,
  and the owner key is long); from the internet it is not.
- **Don't put Cloudflare Access in front.** See 2.5. Symptoms if it
  happens: the desktop app shows the server as offline or "Your sign-in
  expired", and links you've sent show a Cloudflare sign-in page.
- **git asks for a username**, or a deploy stops at step 1 with
  *Permission denied (publickey)*. The clone must use the deploy key's
  address:

  ```bash
  cd /mnt/user/appdata/splitpage
  git remote -v    # should show git@github-splitpage:RetroGorilla/splitpage.git
  ```

  If it shows `https://github.com/...` or `git@github.com:...`, switch it
  (safe; it only changes where git fetches from):

  ```bash
  cd /mnt/user/appdata/splitpage
  git remote set-url origin git@github-splitpage:RetroGorilla/splitpage.git
  ```

- **`git pull` refuses** (a deploy stops at step 1 saying the code folder
  has changes of its own). Someone edited files in
  `/mnt/user/appdata/splitpage` on the server; nothing was deployed and the
  running server is untouched. That folder should only ever change through
  `./deploy.sh`. `git status` lists the edited files. To set the edits aside
  (kept, not deleted) and deploy:

  ```bash
  cd /mnt/user/appdata/splitpage
  git stash push -m server-edits
  ./deploy.sh
  ```

  If it still refuses, stop and ask — don't reach for `git reset`.
- **`Permission denied` running `./deploy.sh`.** The file lost its
  "executable" mark. `bash deploy.sh` does the same thing.
- **`$'\r': command not found`.** `deploy.sh` was saved with Windows line
  endings. `git checkout -- deploy.sh` puts GitHub's copy back.
- **Wrong folder.** `git` and `./deploy.sh` only work from
  `/mnt/user/appdata/splitpage`. `docker` commands work from anywhere.
- **Deleting a script is immediate.** The × in the script list asks once,
  then it's gone from the server. The snapshots are the undo (§4).
- **Limits.** One save can be up to 25 MB, one picture up to 8 MiB (PNG,
  JPEG, GIF and WebP only). Someone on a **Can comment** link may upload
  20 MiB of pictures an hour (screenshots in comments), someone on a
  **Can edit** link 100 MiB an hour; you, signed in with the owner key, are
  not limited. All of these are settings in `.env` (`.env.example` explains
  each). A comment has its own fixed half-megabyte cap.
- **Pictures are never deleted,** even when no script uses them any more.
  They are small, and `blobs/` only grows slowly.

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

## 7. Publishing a release to the mirror

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

## 8. Other ways to run it

§1–5 are one particular server. The same image runs anywhere Docker does;
these are the other setups, in brief. Whatever the setup, set `JOIN_PIN`:
without it the server lets in anyone who can reach it.

**With `docker compose`**, on a machine that has it. From a checkout:

```bash
cp .env.example .env            # then set JOIN_PIN (2.3's commands work)
mkdir -p data && sudo chown 99:100 data
docker compose up -d --build
```

`docker-compose.yml` runs the same container as `deploy.sh`, but has no
snapshots, no settings check and no rollback.

**From CI's built copy**, without a checkout. Every green CI run uploads the
built app as the artifact **`splitpage-app`** (Actions → the run → *Artifacts*
at the bottom). Unzipped, it holds `index.html`, `sw.js`, the manifest and
icons, `VERSION`, `server/` and `Dockerfile.prebuilt`, which copies those in
and builds nothing:

```bash
docker build -f Dockerfile.prebuilt -t splitpage .
docker run -d --name splitpage --restart unless-stopped --user 99:100 \
  -p 8791:8791 --env-file /path/to/.env -v /path/to/data:/data splitpage
```

The root `Dockerfile` needs the repository's source (it builds `index.html`
itself), so it won't work on the artifact.

**Behind Cloudflare Access instead of the owner key.** For a team that only
ever uses a browser and whose email addresses you know. Add the hostname to
the tunnel as in 2.5, then **Zero Trust → Access → Applications → Add an
application → Self-hosted**, covering the **whole** hostname (the API under
`/api/` included), with a policy allowing each person's email and a login
method (**Settings → Authentication**: Google, or One-time PIN, which needs
no setup). What changes:

- The desktop app can't connect, and invite links only work for people
  Access already lets in.
- The server reads the `Cf-Access-Authenticated-User-Email` header Access
  adds, and fills in each person's name in comments from it.
- Access sessions expire (24 hours is a reasonable setting). When one lapses
  mid-edit, Splitpage keeps the unsaved work, asks you to reload and sign in,
  and merges the work back in afterwards.
- Keep `JOIN_PIN` set anyway; it costs one extra step and protects the
  server if the Access application is ever removed by mistake.
- *"Your sign-in expired" straight after signing in*: the Access application
  covers a *path* rather than the whole hostname, so Access answers the
  app's API calls with its sign-in page.
- *Everyone shows as the same person in comments*: Access isn't passing an
  identity — check the application is on and the tunnel isn't bypassing it.

**For people in the same room**, on a laptop, there is no server to set up:
the launcher does it. See the user guide, *Hosting a shared session*
(`docs/help.md`).

---

## 9. When something is broken

```bash
docker ps -a | grep splitpage       # running, or exited?
docker logs --tail 100 splitpage    # the actual error
```

| Symptom | Cause, and the fix |
| --- | --- |
| `./deploy.sh` stops with **STOPPED:** | It says which setting in `.env` is wrong and how to fix it. Nothing was changed. |
| Deploy ends *did not come up healthy* | Read the log it printed; `./deploy.sh rollback` puts the previous version back (§3). |
| *Bad gateway* / 502 at the address | The container isn't running (`docker ps -a`), or the tunnel's URL isn't `<unraid-ip>:8791` with type `HTTP` (2.5). |
| A Cloudflare sign-in page instead of Splitpage | An Access application covers the hostname. Remove it (2.5). |
| Container exited straight away | Read the log. `EACCES` is the data folder's owner (§5); anything else is usually a bad value in `.env`. |
| Container keeps restarting; the log names `data/links/links.json` or `data/links/secret` | That file is damaged, and the server won't start without a readable one. §4, *If the server won't start*. |
| The owner key is refused though it's right | `.env` was changed without a restart (`docker restart splitpage`), or the key in the password manager isn't the one in `.env` (`grep '^JOIN_PIN=' .env`). |
| "Too many attempts" when typing the key | Ten wrong tries in a minute from your address; wait a minute. If it happens to everyone at once, `TRUST_PROXY` isn't `cloudflare`. |
| The desktop app can't connect; a browser can | `ALLOW_ORIGINS` in `.env` doesn't include `splitpage://app`. Add it, `docker restart splitpage`. |
| Links you'd sent stopped working after a restart or deploy; every device signed out | The server isn't keeping links: `/api/health` doesn't say `"linksPersist":true`. Check `PERSIST_LINKS=1` in `.env`, and that `data/links/` exists (a restore without it loses every link). |
| Saves fail with 413 | A script over `MAX_BODY_BYTES`, or one picture over `MAX_BLOB_BYTES`. Raise it in `.env` and restart. |
| "This page is out of date for this server" | The page was loaded before the server was updated, and the script has pictures. Reload the page. |
| Pictures show as "Image unavailable" | Their files under `data/blobs/` are missing — restored without `blobs/`. Restore `blobs/` too. |
