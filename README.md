# Splitpage

Splitpage is a two-column visual/audio script editor — pictures on one side,
narration on the other — with a built-in teleprompter, comments for
collaborating on a draft, and a production breakdown that tracks every prop,
location, VFX shot, and person mentioned in the script.

Scripts save as plain Markdown (`.md`) files by default, so you can open and
edit them anywhere, or as native `.splitpage` files that keep everything —
tags, comments, version history — in one file. Splitpage itself runs
portable straight out of a folder with nothing to install, or you can
[install it](#installing-it) properly, with a Start Menu entry and
auto-updates.

You can also work with other people: [host a shared session](#hosting-a-shared-session)
so others on your network open and edit the same scripts live, or
[connect to a server](#connecting-to-a-server) someone else is hosting.

## Setting up

The first time you open a fresh copy of Splitpage, a short setup wizard walks
you through it: what Splitpage is and how saving works, whether to add this
copy to your Start Menu (if it was started by the launcher — see
[Installing it](#installing-it)), how you'll be working (on your own, hosting
others, or joining someone else's session — see
[Hosting a shared session](#hosting-a-shared-session) and
[Connecting to a server](#connecting-to-a-server)), and an offer to take the
5-step tour. Skip it or finish it and it won't show up again on its own.

Changed your mind, or want to run through it again? **File ▸ Set up
Splitpage…** reopens it any time, on any document — it never touches
anything you've written. It only ever appears by itself over the demo
script Splitpage ships with, never over something you've opened or are
hosting, so it won't get in the way once you're actually working.

## Running it

**Quickest — just open it.** Double-click [index.html](index.html). Editing,
comments, the teleprompter, and Export all work straight away.

**For "Install app" / offline support.** Browsers only offer to install a
page as an app (and only let its service worker cache it for offline use)
when the page is served from `http://`/`https://`, not from a `file://`
path. To get that:

1. Start the local server:
   - **Windows** — double-click **[start.bat](start.bat)**.
   - **macOS / Linux** — run **`./start.sh`** in a terminal.
   - **Anywhere, if you have Node** — `node start.mjs`.

   Either way it serves the app at `http://localhost:8791/` and opens your
   browser there. `start.bat` uses Node if you have it and falls back to a
   pure-PowerShell server that needs nothing installed at all.
2. In Chrome or Edge, click the **install icon** in the address bar (or
   Menu ▸ "Install Splitpage…") to add it as its own app window with a
   taskbar/Start Menu entry. That *is* the desktop app — a real window and
   a taskbar entry, running in the browser engine that all of Splitpage's
   features (in-place saving, Follow My Voice) are built on.
3. Leave that window open while you work; closing it (or Ctrl+C) stops the
   server. Re-run it any time — your saved script is an ordinary file on
   your computer and doesn't depend on the server at all.

**Options** (`node start.mjs --help`): `--port 9000` if 8791 is taken —
though it finds the next free port by itself; `--no-open` to skip launching
a browser; and `--library`, which keeps documents on the server in `./data`
instead of as files you save to disk. Without `--library` the launcher
serves files and nothing else, so the app behaves exactly as it always has.

## Installing it

**`SplitpageSetup-<version>.exe` is the whole product.** One download, one
installer, and you are working — open a local script, or host a session other
people on your network join. It carries its own Node runtime, so there is no
second thing to go and install first.

The installer asks where to put it:

- **Just for me** — `%LOCALAPPDATA%\Programs\Splitpage`, no administrator.
- **Everyone on this PC** — `C:\Program Files\Splitpage`, needs administrator.
- **Somewhere else** — type any path.

and whether you want a desktop shortcut and a *shared session* shortcut. It
registers with Add/Remove Programs like anything else. `SplitpageSetup.exe /Q`
installs silently for the current user and `/Q:A` for everyone (needs an
administrator prompt). To choose the folder as well, override the command:
`SplitpageSetup.exe /Q /C:"powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Silent -Dir C:\path"`.

<!-- help:skip-start -->
### Building a release

```
node package.mjs              # dist/splitpage-<version>.zip — portable, ~165 KB
node package.mjs --installer  # ...and dist/SplitpageSetup-<version>.exe — ~33 MB
```

**Nothing needs installing to build this.** The setup is a self-extracting
archive made by `iexpress.exe`, which is part of Windows. `--installer` also
downloads the official Node build for Windows and checks it against
nodejs.org's published SHA-256 before packing it — that happens once and is
cached in `.cache/`.

Run `--installer` on a non-Windows machine and it prepares everything and
tells you the one command to finish on Windows.

**The portable zip** is still there and still tiny. Unzip it anywhere and run
`start.bat` or `./start.sh`; it uses a Node you already have, and without one
it falls back to a PowerShell file server that serves the app but cannot host
a session.
<!-- help:skip-end -->

### Windows on ARM

On Windows machines with ARM64 processors, build with `node package.mjs --installer --arch arm64` for an ARM64-only setup, or `--arch both` to bundle both architectures. The installer detects your machine's architecture and uses the matching runtime; for portable copies with both runtimes, `start.bat` picks the right one automatically.

## Hosting a shared session

Pick **Splitpage (shared session)** in the Start Menu, or run:

```
node start.mjs --host
```

It prints the addresses other people type into their browsers. Everyone edits
the same scripts; two people editing different scenes merge silently, and two
people editing the same field keep both versions — one live, one as a review
comment.

> **By default there is no password on it.** Anyone who can reach that address
> can read and edit. That is the point on your own network and a mistake on a
> public one, so the launcher says so every time it starts. Putting Splitpage
> on the *internet* is a different job with a different answer — see
> [DEPLOY.md](DEPLOY.md), which puts Cloudflare Access in front.

### Asking for a code

```
node start.mjs --host --pin
```

The launcher prints a six-digit **join PIN** in a box beside the addresses.
Everyone who opens the address is asked for it once; read it out to them.
`--pin 4821` uses a code you chose instead of a generated one.

What the PIN does: it stops someone who is merely on the same wifi — a hotel, a
co-working floor, a client's office — from opening your scripts by typing an
address. What it does **not** do is hide anything. It is checked by your
computer but travels in the clear over plain HTTP, so anyone able to watch the
network can read it as it goes past, and read the scripts with it. It is a door
lock for a room you are already in, not encryption, and it is not a substitute
for Cloudflare Access on the internet.

The code is remembered for as long as the other person's browser tab is open,
unless they tick "remember on this device". Restarting your session invalidates
every code you handed out.

## Connecting to a server

Normally the app talks to whatever served it. **File ▸ Servers…** lets it talk
to a different one — someone else's shared session, or your own machine from a
laptop — and remembers the ones you use.

- **Add a server**: a name, the address they gave you
  (`http://192.168.1.20:8791/`), and the join PIN if they set one. The PIN is
  checked as you add it, so a typo in either is caught there and then.
- **Use this server** points the app at it; **Back to this copy** returns to the
  one you have open. The File menu says which one you are on.
- Splitpage stores the name, the address, and (only if you ask) the join PIN. It
  never stores a password, an SSH key or a passphrase, and there is nowhere in
  it that could.

For this to work the person hosting has to let your copy in: their launcher
needs `--allow-origin` with the address *your* copy is served from, e.g.

```
node start.mjs --host --pin --allow-origin http://192.168.1.7:8791
```

A copy opened straight off disk (a `file://` page) counts as the origin `null`,
so `--allow-origin null` is what lets a portable copy connect — which is broad,
because every `file://` page in every browser shares that one origin. Serving
your copy is better where you can.

## Connecting over SSH

If the machine is not on your network, do not put its port on the internet.
Forward it over SSH instead: the connection is then encrypted and authenticated
by SSH, and Splitpage's port never faces outward at all.

From the launcher:

```
node start.mjs --tunnel me@studio.example.com
```

That runs `ssh -N -L 8791:localhost:8791 me@studio.example.com`, waits for the
tunnel, and opens `http://localhost:8791/`. `--remote-port` and `--local-port`
change either end; closing the window closes the tunnel. If the local port
collides with a Splitpage you are already running, give `--local-port`
something else.

From inside the app: tick **Reach it over SSH** when adding a server, and
Splitpage writes the exact `ssh` command out for you, with a **Copy** button and
a **Save a .cmd** button for a double-clickable shortcut. It does not run `ssh`
itself — a page that could start programs would be a far bigger hole than the
one it opened — and it keeps no key, password or passphrase; ssh's own agent
does that job.

## Uninstalling

The installed copy registers itself, so remove it from **Add/Remove Programs**
— that clears the shortcuts too, and leaves any shared-session scripts in
`%LOCALAPPDATA%\Splitpage\data` where they are.

For the portable copy, run **`uninstall.bat`** (Windows) or **`./uninstall.sh`**,
which removes exactly the files the release shipped and lists anything else it
found so you can see what it is leaving behind. Your scripts are never touched:
saved scripts and the `data/` folder both survive, and it tells you they
did. `--dry-run` shows what would go without doing it.

## Keeping it up to date

```
node update.mjs check     # is there a newer version?
node update.mjs           # download and verify it
```

The launcher also checks in the background, and the app shows a bar when
there is something waiting. Updates are fetched from a public releases mirror
so the shipped copy can stay up to date even though the main repository is
private.

**Updates install on restart, never while the app is open.** Downloading is
safe at any time; swapping out `index.html` under a browser that has it open
is not. So `update.mjs` only downloads, checks every file against the new
release's own checksums, and stages it — and `start.bat` puts it in place the
next time you launch, before it serves anything. If an update fails halfway it
rolls back to the copy it made, and if you have hand-edited any of the app's
files it refuses to overwrite them until you say `--force`.

<!-- help:skip-start -->
## Working on the code

`index.html` is **generated**. The source is in `src/` — `page.html` (the
shell), `app.css`, `seed-state.json` (the demo document) and the numbered
fragments in `src/js/`. Rebuild with:

```
node build.mjs           # write index.html
node build.mjs --check    # is index.html in step with src/?
```

The build inlines everything into one self-contained page, and that is a
requirement rather than a preference: saving writes this page's own HTML
back out with your document inside it, so a page that linked out to
`app.css`/`app.js` would produce saved files that only worked next to those
files. Editing `index.html` by hand therefore gets overwritten by the next
build — the pre-commit hook refuses a commit where the two disagree.

## What changed from the Claude artifact

The editor, comments, teleprompter, tags, and local version-history panel
are unchanged — none of that ever depended on Claude. Two things did, and
were rewired to work standalone:

- **Save** used to publish to Claude's hosted copy of the artifact (with
  multi-writer conflict/merge handling). Now, the first time you click
  **Save**, your browser's native *Save As* dialog appears — pick a spot on
  disk. Every Save after that (in Chrome/Edge/other Chromium browsers)
  writes straight back to that same file, silently, no dialog. This also
  means comment/tag actions can auto-save quietly in the background once
  you've picked a file — before that first save, they don't, so nothing
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

**Firefox / Safari note:** these don't support the File System Access API
(`showSaveFilePicker`), so **Save** falls back to downloading a fresh
`.html` copy each time, same as Export — open the newest one next session.
Chrome, Edge, and other Chromium-based browsers get true in-place saving.
<!-- help:skip-end -->

## Tagging and the production breakdown

Anything you label in the script shows up in the **Production** panel, with
every scene it appears in. There are three typing shortcuts — the tag is
made the moment you type the closing character, and one Ctrl+Z undoes just
the tag and leaves the plain text:

| Type | Becomes |
| --- | --- |
| `[gaffer tape]` | Prop |
| `{kitchen}` | Location |
| `~lens flare~` | VFX |
| `<wireless lav>` | Gear |

**Cast** and **Music/SFX** have no shortcut (nothing else is safe to type
in normal prose) — select the words and press **Tag**. Once a tag of any
category exists, typing a bracket and the first few letters offers to
complete it: press **Tab** to accept. The completion keeps that tag's own
category, so you never end up with the same thing filed twice.

Other things worth knowing:

- **Ctrl+Enter** while writing starts the next scene and jumps into it.
- **Alt+Enter** splits the scene you're in at the caret — everything after
  it becomes a new scene right below, in the same column. The *other*
  column isn't touched: splitting the Audio doesn't disturb the Visual next
  to it, and it doesn't disturb the Visual next to the new scene either —
  that one starts blank, the way a beat nobody's framed a shot for yet
  should.
- Click a tag in the script — or any card in the panel — to open it and
  **assign who's responsible** and keep **notes, links or file paths**
  against it. The crew list is just names you type; nothing is verified.
- **Track how far along each item is.** Every card carries a state —
  **Needed → Sourcing → Have it → Returned**. Click the pill in the card's
  top corner to step it on by one, or open the card and pick a state
  outright. The same four words are used whatever the category: "Returned"
  means a hired prop went back, and for a location or a VFX shot it just
  means finished with. The state travels in every export, and shows against
  each item in the **Shoot** view so on the day you can see what still isn't
  here. If two people edit the same file, a merge keeps whichever state got
  further — it can never un-buy something somebody already bought.
- **Work on several items at once.** <kbd>Ctrl</kbd>+click cards in the
  breakdown to select them (<kbd>Shift</kbd>+click takes the whole run
  between two), and a bar appears at the top of the panel: assign them all to
  one person, add a new person and assign them in the same step, set them all
  to one status, or delete them. A plain click still just opens a card and
  leaves the selection alone — <kbd>Esc</kbd> or the **×** clears it. Works in
  the Category and Person groupings, which are the two that show cards.
  **Delete** here removes the items from the breakdown *and* takes their
  labels out of the script — the words stay, only the labels go. It asks once
  first and tells you how many labels are about to go with them.
- Group the breakdown by **category, person or scene**, and export the
  whole thing as CSV (the **CSV** button in the panel, or File ▸ Export ▸
  Breakdown only). One sheet with a Category column, so it filters down to
  a props list, a graphics list, or one person's pull list. The Word,
  PDF, Markdown and plain-text exports carry the breakdown too, including
  who each item is assigned to and what state it's in.
- Deleting a tag from the script doesn't delete it from the breakdown — it
  stays, flagged **Not in script**, until you delete it deliberately.
- **File ▸ Tagging reference** brings back the reference strip at the top
  once you've dismissed it.

### Gear

Camera, mics, lighting, stands — equipment, not set dressing. It's its own
category (Prop is still there for what's actually in front of the camera),
with its own shortcut, and its own screen: click **Gear** in the header.

The one thing gear needs that the others don't is that most of it never gets
*written* anywhere — nobody says "wireless lav" out loud, and it's not always
worth describing in the visual notes either. So the Gear screen opens with a
plain box: **one item per line**, and whatever you type there is tracked,
whether or not it's ever mentioned in the script. Add three lines, hit
**Update list**, and all three show up as cards — same status pill, same
owner assignment, same notes field as everywhere else in the breakdown. Take
a line back out and it stops being tracked, *unless* it's also tagged
somewhere in the script — an item that's actually written in stays, because
the box only remembers what it alone was responsible for adding.

Everything else about the breakdown still applies: gear shows up in the main
**Production** panel too (group by Category to see it alongside everything
else), and it merges the same way — a status can't be walked backwards, an
item can't be silently dropped. The Gear screen itself has a lighter version
of the same grouping: **List**, or **Scene** to see what's needed where.

**Packing list** (on the Gear screen, and Props too from File ▸ Packing
lists) exports a plain checklist — a box, the name, who's got it — meant to
be printed and ticked off before you leave, not the six-column breakdown
sheet trying to double as one.

## Writing and planning

**The writer.** **✎ Write** in the header opens the Audio column on its own,
as one flowing document — a plain word processor for when the job is writing
a lot of narration rather than pairing it with picture. One paragraph is one
scene. **Enter** starts a new one, **Shift+Enter** is a line break inside the
one you're in, and **Backspace** at the very start of a paragraph joins it
onto the one above (**Delete** at the end pulls the next one up).

What sits in the margin beside each paragraph is a three-way setting — the
button on the bar shows where it's at and cycles:

- **Visuals** — the scene number and what's on screen for it, greyed out and
  not editable. Click it to jump back to that scene in the split view.
- **Numbers** — just the scene number.
- **Compact** — nothing at all. Only the writing, with the paragraphs spaced
  a little further apart so you can still see where the scenes divide.

**Size** on the bar sets how big the writing is, from 16 to 34px. It's your
setting, not the script's — it's remembered in this browser rather than saved
into the file, so it doesn't follow the document to whoever opens it next. The
column itself widens with the window (up to a point — a line of prose running
the full width of a big monitor is unreadable), so a wider window and a bigger
size together keep the line length about where you want it.

**Save** is on the writer's bar too, with the same file chip beside it — it
covers the header, and an hour of writing shouldn't have to be closed to be
saved. It's the same button as the header's, so it always says the same thing.

It isn't a copy of your script: every paragraph *is* the row it came from, so
the tag shortcuts, <kbd>Ctrl</kbd>+<kbd>B</kbd>/<kbd>I</kbd>/<kbd>U</kbd> and
Tab-completion all work exactly as they do in the split view, and the moment
you close it everything is already where it should be. Word count and running
time update as you type. Joining two scenes that *both* have a visual is the
one thing it won't do on a keystroke — one of the two shot descriptions would
have to be thrown away, so it sends you to the split view to pick.

**Getting the narration back out.** File ▸ **Narration only** exports the
Audio column as an ordinary document — `.docx` to hand to a voice artist or
carry into Word, `.txt` for anything else. One paragraph per scene, no visual
column, no breakdown, no comments. That's the same shape **Paste a script…**
reads back in its paragraph mode, so narration written elsewhere and pasted in
lands one paragraph per scene — and a `.txt` exported here and re-imported
gives you your scenes back, plus one extra row holding the title line, which
you delete. The same button is on the writer's own bar.

**Runtime estimate.** The chip beside your name shows how long the Audio
column takes to read, and each scene shows its own estimate in the gutter.
Visual notes are directions, not spoken words, so they don't count. Click
the chip to set your reading speed — it's saved with the file, so the
estimate means the same thing to whoever opens it next.

**Scene status.** The dot in each scene's gutter cycles **To do → Ready →
Shot**. Shot scenes are tinted, and a counter appears in the header once
you've shot anything. In the teleprompter, **Skip shot** leaves those
scenes out, so on day two you only read what's left.

**Mentions you forgot to tag.** Once something is in the breakdown, Splitpage
watches the Visual column for it. Write "gaffer tape" into a scene without
labelling it and the words get a faint dotted underline, with a small **Tag
gaffer tape** offer below them — <kbd>Tab</kbd> takes it, or tap it on a
phone. <kbd>Esc</kbd> waves it off. Nothing about the document changes until
you accept, and the underline is painted over the text rather than wrapped
around it, so it can't touch what you've written.

This matters more than it looks: an untagged mention is a mention nothing is
counting, so that item's mention count and scene list are both short — and
the **Shoot** grouping is missing a scene it should have listed.

**Staying with the scene.** Delete or paste a large amount of text and the
page follows you — it doesn't just sit where it was and let the scene you
were editing scroll off somewhere else. That's the moment it's easiest to
lose your place in the script, so Splitpage keeps the scene you're actually
in front of you rather than leaving the page static.

**Comments.** Select some text and click **💬 Comment** to leave one; it
stays anchored to that exact phrase. The card in the **Comments** panel
*is* the "jump to this text" control — click anywhere on it (not a link, not
while you're selecting its text to copy) and the script scrolls to the
phrase, without closing the panel, so you can read the two side by side.
**Sort** at the top of the panel defaults to **Script order** — a comment
sits where the thing it's about sits — with **Most recent** alongside it for
coming back after a while and wanting to see what actually moved, replies
included, wherever in the script they landed.

**Find and replace.** <kbd>Ctrl</kbd>+<kbd>F</kbd>. Enter and
Shift+Enter step through matches; **Aa** toggles case-sensitivity.
Formatting, links and comment anchors survive a replace untouched. Text
inside a tag is deliberately left alone — rename those in Production, which
changes the label and the tracked item together.

**Reference images.** The small **📎 Image** link at the top of a scene's
visual column attaches a still — or just drag an image file from your desktop
anywhere onto that column and drop it. Once a scene has one, hover it for
**Replace** and **Remove**.

**Reordering.** Drag a scene by the grip beside its number (the dots to the
left — they brighten as you move over the row). The ↑ / ↓ buttons still work
for nudging one step, and are the way to do it on a touchscreen.

**Shooting order.** The **Shoot** grouping in Production reorganises the
script the way a shoot day runs: scenes grouped by the location tagged in
them, so everything at one place can be shot in one block, each with what
has to be there, who's responsible for it and whether it's actually in hand
yet. Scenes with no location tagged get their own group at the end rather
than being dropped.

## Working with other people (hosted)

When Splitpage runs as a server, a script lives on the server rather than in a
file on one person's disk, and several people edit the same one. There are two
ways to get there, and they are the same app underneath:

- **For an afternoon** — [host a shared session](#hosting-a-shared-session)
  from your own machine. Nothing to set up, nothing to sign in to, and it stops
  when you close the window.
- **For good** — put it on your own domain, behind a Cloudflare tunnel and
  Access, so collaborators sign in and the scripts outlive your laptop being
  shut. That is **[DEPLOY.md](DEPLOY.md)**.

Everything in this section applies to both. When the app is served, three
things appear:

- **File ▸ Put this script on the server** publishes what you have open. The
  chip beside the title changes to *On the server*, and Save publishes there
  from then on.
- **File ▸ Open from the server…** lists every published script.
- Your name fills in automatically from whoever you signed in as, so review
  comments are attributed without anyone typing it.

**Two of you can edit at once.** Every save carries the version it started
from. If someone saved while you were typing, Splitpage takes their version and
merges yours into it — edits to different scenes merge silently, and if you
both changed the *same* line, theirs stays in the script and yours is kept as a
comment flagged **Unmerged edit**. Nothing is ever silently dropped.

If your sign-in expires while you are working, Splitpage notices, keeps your
unsaved edits, and asks you to reload; signing back in reopens the document and
merges them in, along with anything that changed while you were away.

None of this affects working locally. Opened from disk, the app behaves exactly
as it always has, and **Save As** still gives you a local copy of a hosted
script whenever you want one.

## Google Drive files

**File ▸ Google Drive files…** opens a small file manager for any publicly
shared Google Drive folder — browse it, download files, upload new ones,
rename, delete, and create subfolders, right from Splitpage. It's separate
from opening and saving your script; think of it as a way to move files in
and out of a shared folder without leaving the app.

Google splits this into two permissions, so Splitpage needs two credentials
of your own (the app has no server to hold them for you — they're kept only
in your browser's local storage):

- An **API key**, to list and download files from a public folder — no
  sign-in needed, since Google treats "anyone with the link" as exactly that.
- An **OAuth Client ID**, to make changes — uploading, renaming, deleting, or
  creating a folder always needs a real signed-in Google account, even on a
  folder anyone with the link can edit.

The panel walks you through creating both in the [Google Cloud
Console](https://console.cloud.google.com/apis/library/drive.googleapis.com)
the first time you open it (enable the Drive API, create an API key, create
a Web-application OAuth client with this page's address as an authorized
JavaScript origin). Paste a folder's share link or its ID to connect, and
sign in with Google when you want to change something — browsing and
downloading work without signing in at all.

Note: sign-in needs the page served over `http://`/`https://` — see
**Running it** above for `start.bat`; it doesn't work opened straight off
disk (`file://`).

## On a phone

The whole app works on a phone — same file, same features, re-flowed. Scenes
stack (visual above audio, each labelled), the scene controls sit in a strip
above each scene, and panels and menus go full screen. A few things translate:

- **Completing a tag:** phone keyboards have no <kbd>Tab</kbd>, so while the
  dim completion is showing, **tap it** to accept.
- **Find & replace** is in the File menu (no <kbd>Ctrl</kbd>+<kbd>F</kbd>).
- **Selecting several breakdown items:** **long-press** a card to start, then
  tap cards to add or drop them. The **×** in the bar clears the selection.
- **Reordering scenes:** the ↑ / ↓ buttons (drag needs a mouse).
- **New scene:** the **+** button on any scene, or **+ Add row** at the bottom.
- **Splitting a scene at the caret (Alt+Enter)** is a keyboard shortcut with
  no phone keyboard to trigger it from — add the scene with **+** and move
  the text over by hand.
- In the teleprompter the screen **stays awake** while you read (on browsers
  that support it) and releases when you close it.
- **The writer** works the same, with the scene number and its visual on a
  thin line above each paragraph instead of out in the margin — a phone has
  no margin to put them in.

Typing shortcuts (`[prop]` `{kitchen}` `~vfx~` `<gear>`), comments, status,
exports, the **Gear** screen and its packing lists, the server features —
everything else is exactly the same.

## Two shapes of Markdown export

**File ▸ Export a copy** has two Markdown options. **Markdown (.md)** lists
the script scene by scene — a `## Scene 01` heading, then the Visual notes,
then the Audio, stacked. **Markdown, two columns (.md)** lays the same
script out as a table instead, one row per scene with a Visual column next
to an Audio column — the way the split view itself looks, and the way a
GitHub/Notion/Obsidian-style Markdown viewer actually renders a table, side
by side rather than stacked. It's also exactly the shape **Paste a
script…** already reads back in "Two columns" mode, so a two-column
Markdown export round-trips back into Splitpage with the split intact.
Both carry the production breakdown and comments the same way.

Neither is the same thing as **Save**. These are copies for reading and
sharing: they carry the words, not the tagging, the comment anchors, the
images or the scene statuses. Saving as `.md` writes the same two-column
table *plus* Splitpage's own record of the script underneath it, so nothing
is lost — see [Saving your script](#saving-your-script).

## Importing a Google Doc

**File ▸ Import from Google Doc link…** takes a Google Docs share link (or
just the document's ID) instead of a file. Splitpage has no server and no
Google sign-in of its own, so it can't read the Doc directly — instead it
opens Google's own Word (.docx) export of it in a new tab, which downloads
straight to your computer using whatever Google account you're signed in to
in that tab. Once the download lands, bring it in the same way as any other
Word file: **File ▸ Open a document…**. If the doc isn't shared "Anyone with
the link," make sure the browser tab that opens is signed in to an account
that can see it, or the download will be a Google sign-in page instead of a
document.

## Saving your script

**Save** writes your script to a real document file. The first Save asks
where to put it and offers two formats; after that, Save writes straight
back to the same file.

**Markdown (`.md`) — the default.** A plain-text file anyone can read. At
the top is your script as a table, one row per scene, Visual beside Audio,
with a Status column, followed by your production breakdown and your
comments — it renders properly in Obsidian, VS Code, GitHub, or anything
else that knows Markdown. Below that is a fenced block Splitpage writes for
itself:

```
<!-- splitpage: everything below is Splitpage's own record of this script. … -->
~~~~splitpage
{ … }
~~~~
```

That block holds what the table cannot say: which words are tagged as props
or locations, where your comments are anchored, your storyboard images,
each scene's status, your crew list and your reading speed. Leave it alone
and nothing is ever lost.

**Splitpage (`.splitpage`).** The same information with none of the
readable table — just Splitpage's own record, and a smaller file. Pick this
if you never intend to read the file anywhere else.

Either way the file is your script and nothing else: it carries no copy of
the app, so it stays small and it opens in seconds.

### If you edit the `.md` somewhere else

You can. Open it in any editor, fix a line of narration in the table, save,
and reopen it in Splitpage — your edit is there. Splitpage compares the
table against its own record cell by cell: a cell you did not touch keeps
everything it had, and a cell you rewrote is taken from your version, with
any tracked prop, location, cast, gear or sound name in it tagged again
automatically. The one thing it cannot rescue is a comment that pointed at
exact words in a cell you rewrote — the comment stays, along with the text
it quoted, but it no longer has a place to point to and shows in the panel
as no longer in the script. Changing the `# ` heading renames the script.
Adding or deleting whole scene rows is the one thing Splitpage will not
guess at: it asks whether to keep its own record or rebuild the scenes from
your table.

### Sending it to someone who has nothing installed

**File ▸ Export a copy ▸ Standalone HTML (.html)** writes one self-contained
page: your script with a copy of Splitpage wrapped around it. They
double-click it and the script is there, editable, with nothing to install
and no account. It is a far bigger file than a `.md`, so it is for sending,
not for working in.

## Reopening a saved project

A file Splitpage saved is a complete project, not just text — reopen it and
you get everything back: scenes, comments, tags, images, title. Two ways:

- **File ▸ Open a document…**, then pick the `.md` or `.splitpage` file.
  Useful when you're already in the app and want to switch projects.
- **Double-click a saved Standalone HTML file.** It opens straight into that
  project — that is what being self-contained means.

That same menu still imports `.docx`/`.txt`/`.csv`, and Markdown that isn't
one of Splitpage's own, as plain script text, same as before.

### Older `.html` projects

Splitpage used to save every project as a page like the standalone export
above. Those files still open exactly as they always did — there is nothing
to convert by hand. The first time you Save one, though, Splitpage asks
where to keep it as a `.md` instead and tells you why; from then on it is an
ordinary Markdown project. Your original `.html` file is left where it is,
untouched.

## Resuming your last project on launch

In Chrome/Edge, Splitpage remembers the file you last saved or opened and
tries to reopen it automatically the next time you start the app — but only
when you're looking at a fresh, never-saved copy of the page (so opening one
specific saved project never gets silently swapped for a different one).
Two ways this can go:

- **Silent.** Most of the time it just reopens with no prompt at all.
- **One click.** Browsers require an actual click before quietly reusing
  file access across separate launches in some cases — when that hasn't
  happened yet, you'll see a small **"Continue where you left off?"** banner
  at the top instead of a picker. One click on **Continue** reopens it.

This relies on IndexedDB, which needs a real page origin to behave
reliably — it works over `http://`/`https://` (i.e. via **start.bat**), and
may not persist across launches when the page is opened as a raw `file://`
path. Either way, opening files by hand (double-click, or File ▸ Open)
always works regardless.

## Files

**The app**

- `index.html` — the whole app, and **a build output**: generated from `src/`
  by `node build.mjs`, so edit the source, not this. It is self-contained on
  purpose (that is what makes **Export a copy ▸ Standalone HTML** possible,
  and what lets the app run straight off a USB stick); the only thing it
  fetches is the Google Fonts stylesheet, loaded so that a slow or
  unreachable font server cannot stop the app starting.
- `src/` — the source. `page.html` (the shell), `app.css`,
  `seed-state.json` (the demo document), and `js/` — numbered fragments of
  one script, concatenated in filename order.
- `build.mjs` — inlines all of it back into `index.html`. `--check` says
  whether the two are in step.
- `manifest.webmanifest`, `icon.svg` — makes "Install app" possible.
- `sw.js` — a small service worker so the app shell still opens offline
  once you've loaded it at least once while served over `http://`.

**Running it**

- `start.mjs` — the launcher: serves the app, opens your browser, installs a
  staged update, and with `--host` shares the session with your network.
- `start.bat` / `start.sh` — the double-click and terminal ways in. `start.bat`
  prefers the bundled runtime, then a Node on PATH, then `start.ps1`.
- `start.ps1` — the zero-install fallback: a static server built on .NET's
  `HttpListener`, for a machine with no Node. Serves the app; cannot host.
- `update.mjs` — checks for a new version, verifies it, stages it. The
  install happens at the next launch, never while the app is open.
- `uninstall.mjs` / `uninstall.bat` / `uninstall.sh` — removes a portable
  copy, and only the files the release shipped.

**Packaging**

- `package.mjs` — builds the portable zip, and with `--installer` the Windows
  setup.exe. `VERSION` is the single source of the version number.
- `installer/` — `install.ps1` and `uninstall.ps1` (the installer proper) and
  `icon.ico` for the shortcuts.
- `tools/fetch-runtime.mjs` — downloads and verifies the Node runtime that
  ships inside the setup.exe.

**Hosting for other people**

- `server/server.js`, `Dockerfile`, `docker-compose.yml` — the hosted mode: a
  dependency-free Node server that serves the app and stores documents as one
  JSON file each. See [DEPLOY.md](DEPLOY.md).

**Notes**

- `HANDOFF.md` — developer notes: architecture, the invariants that keep the
  document from corrupting, how to test, and what is still unverified. Read it
  before changing anything in `src/`.
