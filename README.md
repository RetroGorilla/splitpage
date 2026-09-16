# Splitpage

Splitpage is a two-column visual/audio script editor — pictures on one side,
narration on the other — with a teleprompter, comments for collaborating on a
draft, and a production breakdown tracking every prop, location, VFX shot and
person in the script.

Scripts save as plain Markdown (`.md`) you can open anywhere, or as
`.splitpage` files. Splitpage runs portable out of a folder, as a Windows
desktop app, or in a browser, and several people can work on the same script
at once.

<!-- help:skip-start -->
## Installing and running it

**The desktop app (Windows).** Run `SplitpageDesktopSetup-<version>-x64.exe`,
or `-arm64.exe` for Windows on ARM (Snapdragon, Surface Pro X — check Settings
▸ System ▸ About ▸ "System type"). It installs for you only, no administrator
needed, and updates itself from then on. The installers aren't code-signed
yet, so Windows may say it "protected your PC" — **More info ▸ Run anyway**.

It adds a desktop shortcut and a **Splitpage** Start Menu folder with
**Splitpage** and **Splitpage (shared session)**, the latter hosting for your
network straight away with a join PIN.

**The browser version.** Double-click `index.html` and it works. To get
"Install app", offline support, Follow My Voice and Google sign-in, the page
has to be served over `http://` rather than opened as a file:

- **Windows** — double-click `start.bat`.
- **macOS / Linux** — run `./start.sh`.
- **Anywhere with Node** — `node start.mjs`.

That serves the app at `http://localhost:8791/` and opens your browser there.
In Chrome or Edge, the **install icon** in the address bar then gives it its
own window and a Start Menu entry. Closing the window stops the server; your
scripts are ordinary files and don't depend on it.

Launcher options (`node start.mjs --help`): `--port 9000` if 8791 is taken
(it finds a free port by itself anyway), `--no-open` to skip the browser, and
`--library` to keep documents on the server in `./data` instead of as files
you save to disk.

**Upgrading from 1.0.** The 2.0 installer finds a 1.0 install, removes it and
keeps your shared-session documents. The browser version updates itself.

### Hosting for other people

Pick **Splitpage (shared session)** in the Start Menu, or run:

```
node start.mjs --host
```

It prints the addresses other people type into their browsers. Add `--pin` for
a six-digit join PIN printed beside them, or `--pin 4821` for a code you chose.

> **By default there is no password on it.** Anyone who can reach that address
> can read and edit. That is the point on your own network and a mistake on a
> public one, so the launcher says so every time it starts. Putting Splitpage
> on the *internet* is a different job — see [DEPLOY.md](DEPLOY.md), which
> puts Cloudflare Access in front.

The PIN stops someone merely on the same wifi from opening your scripts. It
does not hide anything: it travels in the clear over plain HTTP, so anyone
watching the network can read it and the scripts with it. It's a door lock,
not encryption. It's remembered for as long as the other person's tab is open
unless they tick "remember on this device", and restarting your session
invalidates every code you handed out.

For someone to connect *their* copy of Splitpage to your session (File ▸
Servers…), your launcher has to name the address their copy is served from:

```
node start.mjs --host --pin --allow-origin http://192.168.1.7:8791
```

A copy opened straight off disk counts as the origin `null`, so
`--allow-origin null` is what lets a portable copy connect — which is broad,
since every `file://` page shares that one origin. Serving their copy is
better where you can.

**Over SSH.** If the machine isn't on your network, don't put its port on the
internet — forward it instead, so the connection is encrypted and
authenticated by SSH and Splitpage's port never faces outward:

```
node start.mjs --tunnel me@studio.example.com
```

That runs `ssh -N -L 8791:localhost:8791 me@studio.example.com`, waits for the
tunnel and opens `http://localhost:8791/`. `--remote-port` and `--local-port`
change either end; closing the window closes the tunnel.

**Command-line flags** are the same for the desktop app: `--library`,
`--host`, `--pin [code]`, `--data DIR`, `--port N`, `--allow-origin URL` and
`--tunnel user@host` (which needs key-based SSH login there, since there's no
console to type a password into). Script files named on the command line open
at launch.

### The legacy browser installer

The older browser-based install — the same app in Chrome or Edge with a Start
Menu entry and auto-updates, as a self-extracting
`SplitpageSetup-<version>.exe` — still builds from source, but 2.0.0 no longer
publishes it. Double-click it and it asks where to put it: **Just for me**
(`%LOCALAPPDATA%\Programs\Splitpage`, no administrator), **Everyone on this
PC** (`C:\Program Files\Splitpage`, offered only if setup was started as an
administrator), or a folder you pick — plus desktop and shared-session
shortcuts. It registers with Add/Remove Programs. `SplitpageSetup.exe /Q`
installs silently for the current user, `/Q:A` for everyone.

### Uninstalling

An installed copy registers itself, so remove it from **Add/Remove Programs**.
That clears the shortcuts and leaves shared-session scripts in
`%LOCALAPPDATA%\Splitpage\data`.

For a portable copy run `uninstall.bat` or `./uninstall.sh`, which removes
exactly the files the release shipped and lists anything else it found. Your
scripts and the `data/` folder are never touched. `--dry-run` shows what would
go.
<!-- help:skip-end -->
## Writing and planning

The split view is one row per scene: the **Visual** column is what the viewer
sees, the **Audio** column is what gets said out loud.

- **Ctrl+Enter** starts the next scene and jumps into it.
- **Alt+Enter** splits the scene at the caret — everything after it becomes a
  new scene below, in the same column, leaving the other column untouched.
- **+** on any scene, or **+ Add row** at the bottom, adds one.
- Drag a scene by the grip beside its number to reorder it, or use ↑ / ↓ to
  move it one step.
- **Ctrl+F** finds and replaces across the script. Enter and Shift+Enter step
  through matches; **Aa** toggles case-sensitivity. Text inside a tag is left
  alone — rename those in Production, which changes the label and the tracked
  item together.
- **📎 Image** at the top of a visual column attaches a still; you can also
  drag an image file onto the column. Hover it for **Replace** and **Remove**.

**Scene status.** Click the dot in a scene's gutter to cycle **To do → Ready →
Shot**. Shot scenes are tinted and counted in the header, and the
teleprompter's **Skip shot** leaves them out.

**Runtime.** The chip beside your name is how long the Audio column takes to
read; each scene shows its own estimate in the gutter. Click the chip to set
your reading speed — it's saved with the file. Visual notes don't count.

**Comments.** Select some text and click **💬 Comment**; it stays anchored to
that phrase. Click a card in the **Comments** panel to scroll the script to
it. **Sort** offers **Script order** or **Most recent**.

**Present.** **▶ Present** opens the teleprompter. **Follow My Voice** scrolls
it as you read aloud (Chrome or Edge, served page, microphone).

### The writer

**✎ Write** opens the Audio column on its own as one flowing document, for
when you're writing narration rather than pairing it with picture. One
paragraph is one scene:

- **Enter** starts a new scene, **Shift+Enter** is a line break inside one.
- **Backspace** at the start of a paragraph joins it to the one above;
  **Delete** at the end pulls the next one up.
- Tag shortcuts, **Ctrl+B/I/U** and Tab-completion work as they do in the
  split view, and word count and running time update as you type.

On its bar: the margin button cycles **Visuals** (scene number and what's on
screen — click to jump back to that scene), **Numbers** or **Compact**;
**Size** sets the text from 16 to 34px, remembered per browser rather than
saved into the file; and **Save**, the same button as the header's.

To join two scenes that both have a visual, use the split view — one of the
two shot descriptions has to go, so the writer sends you there to pick.

## Tagging and the production breakdown

Anything you label in the script shows up in the **Production** panel, with
every scene it appears in. The tag is made as you type the closing character;
one **Ctrl+Z** undoes just the tag and leaves the text.

| Type | Becomes |
| --- | --- |
| `[gaffer tape]` | Prop |
| `{kitchen}` | Location |
| `~lens flare~` | VFX |
| `<wireless lav>` | Gear |

For **Cast** and **Music/SFX**, select the words and press **Tag**. Once a tag
exists, typing a bracket and the first few letters offers to complete it —
**Tab** accepts, keeping that tag's category.

- **Open a card** — click a tag in the script, or a card in the panel — to
  assign who's responsible and keep notes, links or file paths against it.
- **Track progress.** Click the pill in a card's corner to step its state on:
  **Needed → Sourcing → Have it → Returned**. The state travels in every
  export and shows in the **Shoot** view.
- **Work on several at once.** **Ctrl**+click cards to select them
  (**Shift**+click takes the run between two) and a bar appears: assign them
  all to one person, add a person and assign in one step, set one status, or
  delete them. **Esc** or **×** clears the selection. **Delete** takes the
  labels out of the script as well as the items out of the breakdown — the
  words stay — and asks first. Works in the Category and Person groupings.
- **Group** by category, person, scene, or **Shoot** — scenes grouped by the
  location tagged in them, so everything at one place can be shot in one
  block. Scenes with no location get their own group at the end.
- **Export** the breakdown as CSV with the **CSV** button, or File ▸ Export ▸
  Breakdown only. The Word, PDF, Markdown and text exports carry it too.
- **Untagged mentions.** If something already in the breakdown is written into
  a visual note untagged, it gets a dotted underline and a **Tag it** offer:
  **Tab** accepts (tap it on a phone), **Esc** dismisses. Worth taking — an
  untagged mention is missing from that item's scene list and from Shoot.
- Deleting a tag from the script leaves the item in the breakdown, flagged
  **Not in script**, until you delete it there too.
- **File ▸ Tagging reference** brings back the reference strip at the top.

### Gear

Camera, mics, lighting, stands — equipment rather than set dressing. Click
**Gear** in the header for its own screen.

Most gear is never written into the script, so the Gear screen opens with a
box: **one item per line**, then **Update list**, and each line becomes a card
with the same status pill, owner and notes as anywhere else. Take a line out
and it stops being tracked, unless it's also tagged in the script.

Gear appears in the **Production** panel too (group by Category). The Gear
screen groups by **List** or **Scene**.

**Packing list** — on the Gear screen, and for props from File ▸ Packing
lists — exports a plain checklist to print and tick off: a box, the name, and
who's got it.

## Saving your script

**Save** writes your script to a document file. The first Save asks where to
put it and offers two formats; after that it writes back to the same file.

- **Markdown (`.md`) — the default.** Your script as a table, one row per
  scene, Visual beside Audio with a Status column, then the breakdown and the
  comments — it renders properly in Obsidian, VS Code or GitHub. Underneath is
  a `~~~~splitpage` block holding what the table can't say: which words are
  tagged, where comments are anchored, images, scene statuses, crew list and
  reading speed. Leave that block alone and nothing is lost.
- **Splitpage (`.splitpage`).** The same information without the readable
  table, in a smaller file.

Either way the file is your script alone — it carries no copy of the app.

### Autosave

Once your script has a file, Splitpage writes to it a couple of seconds after
you stop typing, with no dialog and no toast. Leaving the window writes
anything still pending. Hosted scripts work the same way, with the server as
their home.

The line beside **Save** says where things stand — **Saved**, **Saving…**,
**Unsaved changes**, or **Not saving** when something is in the way (a file
changed on disk, a failed write, a lapsed sign-in). Hover it for the detail.
The writer has the same line beside its own Save button.

Two cases where nothing is written on its own: before that first Save, since
there's no file yet, and for changes recovered after a crash, which sit on
screen until you press Save yourself.

**File ▸ Autosave** turns it off, and the setting is remembered.

### Editing the .md somewhere else

You can. Fix a line in the table in any editor, save, and reopen it in
Splitpage: untouched cells keep everything they had, and a cell you rewrote is
taken from your version, with any tracked prop, location, cast, gear or sound
name in it tagged again automatically.

- Changing the `# ` heading renames the script.
- Adding or deleting whole scene rows makes Splitpage ask whether to keep its
  own record or rebuild the scenes from your table.
- A comment that pointed at words in a cell you rewrote keeps its quoted text
  but shows as no longer in the script.

## Reopening a saved project

Reopen a file Splitpage saved and everything comes back — scenes, comments,
tags, images, title.

- **File ▸ Open a document…**, then pick the `.md` or `.splitpage` file. The
  same menu imports `.docx`, `.txt`, `.csv` and other people's Markdown as
  plain script text.
- **Double-click a saved Standalone HTML file** to open straight into it.
- **File ▸ Import from Google Doc link…** takes a Docs share link or ID. It
  opens Google's Word (.docx) export of the Doc in a new tab, which downloads
  using whatever account that tab is signed in to; then open the downloaded
  file with File ▸ Open a document…. If the Doc isn't shared "Anyone with the
  link", sign that tab in to an account that can see it, or you'll download a
  sign-in page instead.

**Older `.html` projects** open exactly as they always did. The first time you
Save one, Splitpage asks where to keep it as a `.md`; the original `.html` is
left untouched.

**Resuming on launch.** In Chrome/Edge, Splitpage reopens the file you last
saved or opened, but only when you're looking at a fresh, never-saved copy of
the page. Usually that's silent; when the browser needs a click first, a
**"Continue where you left off?"** banner appears instead. Opening files by
hand always works.

## Sending a copy to someone

**File ▸ Export a copy** makes copies for reading and sharing. They carry the
words, not the tagging, comment anchors, images or scene statuses — that's
what makes them different from Save.

- **Markdown (.md)** — scene by scene: a `## Scene 01` heading, the visual
  notes, then the audio.
- **Markdown, two columns (.md)** — the same script as a table, one row per
  scene, the way the split view looks. It's the shape **Paste a script…**
  reads back in "Two columns" mode, so it round-trips.
- **Standalone HTML (.html)** — one self-contained page: your script with a
  copy of Splitpage around it. They double-click it and the script is there,
  editable, with nothing to install. Much bigger than a `.md`, so it's for
  sending rather than working in.
- **Word, PDF, CSV and plain text**, all carrying the production breakdown.

**Narration only** exports the Audio column as an ordinary document — `.docx`
for a voice artist, `.txt` for anything else. One paragraph per scene, no
visual column, no breakdown, no comments. It's on the writer's bar too, and
**Paste a script…** reads that shape back in paragraph mode.

## Version history

Splitpage keeps snapshots as you work. Open the **Version history** panel to
see the list and restore one.

History is per document and stays on your machine — in the app's own storage
on the desktop, in the browser's storage on the web — not in the saved file or
an export. The single shared list older versions of the app kept appears under
**Older history**, where it stays for 90 days.

## Working with other people

When Splitpage is served from a computer rather than opened as a file, scripts
can live on that server and several people can edit the same one. Three things
appear in the File menu:

- **Put this script on the server** publishes what you have open. The chip
  beside the title changes to *On the server*, and Save publishes there from
  then on.
- **Open from the server…** lists every published script.
- **Servers…** points the app at a different server — someone else's session,
  or your own machine from a laptop — and remembers the ones you use. Add one
  with a name, the address they gave you (`http://192.168.1.20:8791/`) and the
  join PIN if there is one; the PIN is checked as you add it. **Use this
  server** switches to it, **Back to this copy** returns, and the File menu
  says which one you're on.

Your name fills in from whoever you signed in as. Splitpage stores a server's
name, address and (only if you ask) its PIN — never a password, SSH key or
passphrase.

**Two of you can edit at once.** Edits to different scenes merge silently. If
you both changed the same line, theirs stays in the script and yours is kept
as a comment flagged **Unmerged edit** — nothing is dropped. If your sign-in
expires, Splitpage keeps your unsaved edits and asks you to reload; signing
back in merges them.

To connect over SSH, tick **Reach it over SSH** when adding a server and
Splitpage writes the `ssh` command out for you, with **Copy** and **Save a
.cmd** buttons. It doesn't run `ssh` itself and keeps no key or passphrase.

Working locally is unaffected, and **Save As** always gives you a local copy
of a hosted script.

## Desktop app

The Windows desktop app is the same app in its own window, with native menus
and Open/Save dialogs; `.splitpage` files open in it when you double-click
them. Two things differ: **Follow My Voice** isn't available yet (use Chrome
or Edge), and **Google Drive files** can't be browsed, though **Import from
Google Doc link** still works.

**Tabs.**

- **Ctrl+T** opens one; **Ctrl+W** or a middle-click closes one, asking first
  if there are unsaved changes; **Ctrl+Tab** / **Ctrl+Shift+Tab** step between
  them.
- Drag a tab out for its own window, into another Splitpage window to bring it
  back, or past another tab to reorder.
- Every open tab comes back the next time you launch.
- Closing a window with unsaved work asks once, listing every tab that would
  lose work, with **Review**, **Close without saving** and **Cancel**.

**Crash recovery.** Unsaved changes are kept on disk as you type and offered
back tab by tab at the next launch — including a document from a shared
session whose server you can no longer reach, which returns as an unsaved
local copy noting where it came from.

**Duplicate files.** Open a copy of a file that's already open in another tab
and it gets its own version history. Nothing is written to either file until
you save.

### Moving from the browser app to the desktop app

1. In the browser app, **File ▸ Export app data…** saves a `.json` file.

2. Install and launch the desktop app.

3. **File ▸ Import app data…** and pick that file. Everything merges into what
   you have; importing twice adds nothing new.

**What travels:** version history (per document, and the Older archive), saved
servers including SSH settings, and preferences (author name, comment sorting,
writer column width, and which notices you've dismissed).

**What doesn't:** server sign-in tokens and PINs, Google Drive API keys, and
the documents themselves — those are files you already have.

## On a phone

The whole app works on a phone: scenes stack (visual above audio), scene
controls sit in a strip above each scene, and panels and menus go full screen.
What changes:

- **Complete a tag:** tap the dim completion instead of pressing Tab.
- **Find & replace:** in the File menu.
- **Select several breakdown items:** long-press a card to start, then tap
  cards to add or drop them.
- **Reorder scenes:** the ↑ / ↓ buttons.
- **Split a scene** (Alt+Enter) has no phone equivalent — add a scene with
  **+** and move the text by hand.
- **The writer** puts the scene number and its visual on a line above each
  paragraph instead of in the margin.
- The teleprompter keeps the screen awake while you read.

Everything else — typing shortcuts, comments, status, exports, Gear and its
packing lists, the server features — is the same.

## Google Drive files

**File ▸ Google Drive files…** opens a file manager for any publicly shared
Google Drive folder: browse, download, upload, rename, delete and create
subfolders, without leaving the app. It's separate from opening and saving
your script.

It needs two Google credentials of your own, kept only in your browser: an
**API key** to list and download from a public folder, and an **OAuth Client
ID** to change anything (uploading, renaming, deleting and creating always
need a signed-in Google account). The panel walks you through creating both in
the [Google Cloud
Console](https://console.cloud.google.com/apis/library/drive.googleapis.com)
the first time you open it. Then paste a folder's share link or ID to connect.

Sign-in needs the app served over `http://`/`https://` — start it with
`start.bat` or `./start.sh` rather than opening the file directly.

## Keeping it up to date

Splitpage checks at launch and shows a bar when there's a new version, with a
**Download** button that fetches and verifies it there and then.

In the browser version the files are swapped in the next time you start
Splitpage — updates never install while the app is open. In the desktop app
the button becomes **Install and restart** once the download finishes.

## Setting up again

**File ▸ Set up Splitpage…** reopens the setup wizard — what Splitpage is, how
saving works, how you'll be working, and the 5-step tour. It never touches
what you've written. **File ▸ Take the tour** starts just the tour, and **File
▸ User guide…** opens this guide.
<!-- help:skip-start -->
## Working on the code

`index.html` is **generated**. The source is in `src/` — `page.html` (the
shell), `app.css`, `seed-state.json` (the demo document) and the numbered
fragments in `src/js/`. Rebuild with:

```
node build.mjs            # write index.html
node build.mjs --check    # is index.html in step with src/?
```

The build inlines everything into one self-contained page, and that's a
requirement rather than a preference: Save writes this page's own HTML back
out with the document inside it, so a page that linked out to
`app.css`/`app.js` would produce saved files that only worked next to those
files. Hand edits to `index.html` are overwritten by the next build, and the
pre-commit hook refuses a commit where the two disagree.

`README.md` is a build input too: `mdToHtml()` renders it into the in-app Help
modal, minus anything between the `help:skip-start` and `help:skip-end`
HTML comments. **The Help modal is the user guide** — keep it about
how to do things; reasoning, install steps and build instructions belong in a
skipped section or in `HANDOFF.md`.

`HANDOFF.md` has the architecture, the invariants that keep documents from
corrupting, and how to test. Read it before changing anything in `src/`.

### Repository layout

- `index.html` — the built app. Self-contained apart from the Google Fonts
  stylesheet, which is loaded so an unreachable font server can't stop it
  starting.
- `src/` — the source: `page.html`, `app.css`, `seed-state.json`, and `js/`,
  numbered fragments of one script concatenated in filename order.
- `build.mjs` — inlines all of it into `index.html`.
- `manifest.webmanifest`, `icon.svg` — make "Install app" possible. `sw.js` —
  a service worker so the shell opens offline once served.
- `start.mjs` — the launcher: serves the app, opens the browser, installs a
  staged update, and with `--host` shares the session. `start.bat` /
  `start.sh` are the ways in; `start.bat` prefers the bundled runtime, then a
  Node on PATH, then `start.ps1` (a zero-install .NET `HttpListener` server
  that serves but cannot host).
- `update.mjs` — checks for a new version, verifies it and stages it.
  `uninstall.mjs` / `.bat` / `.sh` — removes a portable copy, and only the
  files the release shipped.
- `package.mjs` — builds the portable zip; `VERSION` is the single source of
  the version number. `installer/` and `tools/fetch-runtime.mjs` belong to the
  deprecated legacy setup.exe.
- `desktop/` — the Electron app: source, `npm run dist:win`, and its tests.
- `server/server.js`, `Dockerfile`, `docker-compose.yml` — hosted mode: a
  dependency-free Node server storing documents as one JSON file each. See
  [DEPLOY.md](DEPLOY.md).

### Building a release

```
node package.mjs              # dist/splitpage-<version>.zip — portable, ~165 KB
node package.mjs --installer  # ...and dist/SplitpageSetup-<version>.exe (deprecated)
```

Nothing needs installing to build this: the setup is a self-extracting archive
made by Windows' own `iexpress.exe`. `--installer` also downloads the official
Node build for Windows and checks it against nodejs.org's published SHA-256,
cached in `.cache/`. Run it on a non-Windows machine and it prepares
everything and names the one command to finish on Windows. On ARM64 it takes
`--arch arm64`, or `--arch both` to bundle both runtimes.

**Deprecated as of 2.0.0.** The Electron installers in `desktop/` replace it
(`cd desktop && npm run dist:win` — see DEPLOY.md); `--installer` still builds
but isn't published. The portable zip still ships with every release, and
1.0.x installs use it to update themselves.

### How updates install

`update.mjs` only ever downloads: it checks every file against the release's
own checksums and stages it, and `start.bat` puts it in place at the next
launch, before serving anything. Swapping `index.html` under a browser that
has it open isn't safe, so nothing installs while the app is running. A failed
update rolls back to the copy it made, and hand-edited app files are refused
without `--force`. Releases are fetched from a public mirror so shipped copies
can update even though the main repository is private.

The in-app Download button reaches `update.mjs` through
`POST /api/launcher/update/stage`, which exists only on a loopback bind and
only with the launch token the launcher handed the page — the same gate as the
"add me to the Start Menu" route.

### Browser platform notes

- **Follow My Voice** needs a microphone, so it's disabled on a `file://`
  page; start with `start.bat`. It needs Chrome or Edge and an internet
  connection — the speech recognition is the browser's own service, not local.
  Chrome ends a recognition session roughly every 60 seconds, so Splitpage
  restarts it continuously, taking the microphone once and holding it for the
  session (otherwise every restart would re-prompt). The recording indicator
  therefore stays lit until **Stop Following** or closing the teleprompter.
- **Firefox / Safari** don't support the File System Access API
  (`showSaveFilePicker`), so **Save** falls back to downloading a fresh copy
  each time. Chromium browsers get true in-place saving.
- **Resuming the last project** relies on IndexedDB, which needs a real page
  origin: it works over `http://`/`https://` and may not persist across
  launches from a raw `file://` path.
<!-- help:skip-end -->
