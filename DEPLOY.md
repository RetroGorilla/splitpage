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

**Updating.** Pull the new files and `docker compose up -d --build`. Documents
live in the mounted volume, so they are unaffected.

---

## 6. Troubleshooting

| Symptom | Cause |
| --- | --- |
| App loads, but no server items in the File menu | The app can't reach `/api/health` — it's being served as static files, not by this container. Check the tunnel points at the container's port. |
| "Your sign-in expired" straight after signing in | Access is returning its login page to API calls. Usually the Access application covers a *path* rather than the whole hostname — it must cover `splitpage.yourdomain.com` entirely, `/api/` included. |
| `EACCES` in the logs | Data volume permissions — see §2. |
| Saves fail with 413 | Document over `MAX_BODY_BYTES`. Raise it and restart. |
| Everyone shows as the same person in comments | Access isn't passing an identity, so Splitpage falls back to asking for a name. Confirm the Access app is on and the tunnel isn't bypassing it. |
