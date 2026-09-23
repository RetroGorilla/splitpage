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

## What's new in 3.0

3.0.0-beta.2 is a pre-release. Copies on 2.1 are not offered it: download it
from the releases page. When 3.0.0 itself ships, a beta copy is offered it
like any other update.

- **One undo for everything.** Ctrl+Z and Ctrl+Shift+Z take back typing,
  formatting, tags, pasting, splitting, joining, moving and deleting scenes,
  a comment until it is sent, a scene's status and picture, the production
  panel and the title — see [Undo and redo](#writing-and-planning).
- **Merging works a word at a time.** When two people edit the same scene,
  their changes combine unless both changed the same words, or linked or
  tagged the same words differently; only then is it a conflict.
- **Find and replace** finds a phrase even when part of it is bold, a link or
  a tag.
- **Markdown export** writes bold, italic and strikethrough that other
  Markdown readers show correctly, even where they overlap.
- **Pictures stay out of script text.** Pasting into a script cell keeps the
  words and leaves pictures out; a picture already in a cell moves into a
  comment on that scene. Cutting text moves its comment with it.
- **Follow My Voice in the desktop app** through Windows' own speech
  recognition, or **Present in browser** to run the teleprompter in Chrome or
  Edge.
- **Google Drive in the desktop app**, and **each tab has its own server or
  tunnel connection**.
- **Pictures are stored once**, outside the document, so scripts with many
  pictures save and sync faster. Pictures in comments now print in the PDF
  and Word exports.
- **Faster with long scripts:** only the scenes that changed are redrawn.
- **Shared sessions** bring in a collaborator's saved changes without waiting
  for your next save; reviewers can only ever add comments.
- **Resizable side panels**, a File menu in sections, and smoother header and
  panel transitions.
- Fixes: a PDF scene with a picture and no text is no longer drawn over by
  the next scene; *Undo merge* after a save conflict puts your version back;
  File ▸ Open keeps a file's formatting; the teleprompter covers the header;
  autosave off means off.

## What's new in 2.1

- **Merge a file that changed on disk.** When a script was edited outside
  Splitpage while it was open here, the conflict dialog now offers *Merge
  them*, with a side-by-side view of every field that differs before anything
  is written.
- **Review links.** A host can hand out a comment-only address: reviewers see
  the script, use the teleprompter and exports, and add comments — but cannot
  change a word. Enforced by the server, not just the page.
- **Who else is here.** In a shared session, coloured initials in the top bar
  and a dot beside the scene each person is in.
- **Comments** record who resolved a thread and when, can be assigned to a
  person, and the panel filters by Open / Resolved / assignee.
- **Hide shot scenes** (Ctrl+Alt+H) collapses finished scenes so a half-done
  script reads as what is left to record; the teleprompter skips them too.
- **Teleprompter scene mode** plays one scene at a time, pausing at its end,
  with Next / Previous to step between takes.
- **Alt+Up / Alt+Down** moves the current scene without dragging.
- **B-roll lines** are tracked whether typed, pasted or imported, and the
  Import dialog asks what to look for in an incoming script.
- **Better exports:** styled .docx with real headings, table styles and page
  numbers; cleaner Markdown, with images shipped alongside instead of inline.
- Fixes: the header stays pinned when scrolling on a phone; the installer
  build check now proves the payload actually extracts.

## What's new in 2.0

Splitpage now comes as a real Windows desktop app: its own window, tabs,
crash-safe drafts, and per-document version history that doesn't run out of
browser storage — see [Desktop app](#desktop-app). The browser version keeps
working exactly as it always has.

**Which installer to pick.** Most Windows PCs (Intel/AMD) want
`SplitpageDesktopSetup-<version>-x64.exe`; Windows on ARM (Snapdragon,
Surface Pro X and similar) wants the `-arm64.exe` build. Not sure which you
have? Settings ▸ System ▸ About ▸ "System type". You only have to pick once:
from then on the app updates itself, and it picks the build matching the
machine it is running on.

**Windows SmartScreen warning.** The installers aren't code-signed yet, so
Windows may say it "protected your PC" — click **More info ▸ Run anyway**.

**Upgrading from 1.0.** If you installed 1.0 with its setup program, the 2.0
desktop installer finds it, removes it, and keeps your shared-session
documents. For a portable copy, unzip the new release over the old folder —
it no longer replaces its own files (see [Keeping it up to
date](#keeping-it-up-to-date)).

**Moving your data between the browser and desktop apps?** See
[Moving between the browser app and the desktop app](#moving-between-the-browser-app-and-the-desktop-app).

**Follow My Voice** works in the Windows desktop app through Windows' own
speech recognition — see [Desktop app](#desktop-app) below.

## Setting up

The first time you open a fresh copy of Splitpage, a short setup wizard walks
you through it: what Splitpage is and how saving works, where this copy lives
and what that means — a portable folder installs nothing and uninstalls by
being deleted, and the desktop app is the one that registers itself (see
[Installing it](#installing-it)) — how you'll be working (on your own, hosting
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

## Desktop app

Splitpage also comes as a desktop app for Windows (x64 and ARM64): the same
app in its own window, with native menus and Open/Save dialogs, and `.splitpage`
files open in it when you double-click them. Editing, saving and hosting a
shared session on your network all work the same as in the browser, with two
differences:

- **Follow My Voice** uses Windows' own speech recognition, so it works
  without an internet connection and nothing is sent anywhere. The first time,
  Windows may ask whether Splitpage can use the microphone. If it says it isn't
  hearing anything, check **Settings ▸ Privacy & security ▸ Microphone ▸ Let
  desktop apps access your microphone**. If Windows has no speech recogniser
  for your language, add one under **Settings ▸ Time & language ▸ Speech**.
  Only one tab follows your voice at a time: starting it in another tab stops
  it in the first. You can still read in your browser instead: choose
  **☰ File ▸ This document ▸ Present in browser (Follow My Voice)** or press
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>. Your default browser opens
  straight into the teleprompter with the same script, and Follow My Voice
  works there in Chrome or Edge. The browser shows a read-only copy: keep
  editing in the desktop app. If the script has never been saved, you'll be
  asked to save it first.
- **Google Drive files** work differently in the desktop app: you sign in once
  through your own browser instead of pasting an API key, and it needs a
  Google Cloud client set up on the computer first — see **Google Drive files
  ▸ In the desktop app** below. Rename, delete and new folder are browser-app
  only for now.

### Moving between the browser app and the desktop app

**File ▸ Export app data…** and **File ▸ Import app data…** work the same way
in both the browser app and the desktop app, so you can carry your version
history, saved servers, and preferences either direction — moving to the
desktop app, moving back, or just backing up:

1. **File ▸ Export app data…** saves a `.json` file with your history,
   servers, and settings (`splitpage-app-data-YYYYMMDD.json`).
2. On the other app (or the other machine), **File ▸ Import app data…** and
   pick the file you exported. Everything merges into what you already have —
   nothing is overwritten or deleted, and importing the same file twice adds
   nothing new.

**What travels:** version history (every snapshot you've saved, per document and
in the Older archive), saved servers (bookmarks including SSH settings), and
preferences (whether you've seen the setup wizard, your author name, comment
sorting preference, writer column width, and the tagging-help dismissal).

**What does not travel:** server sign-in tokens or PINs, Google Drive API keys,
the desktop app's Google Drive sign-in, and the documents themselves — those are files you already have on your
computer.

### Tabs

The desktop app opens documents in tabs across the top of the window, like a
browser:

- **Ctrl+T** opens a new tab.
- **Ctrl+W**, or a middle-click on a tab, closes it — if it has unsaved
  changes, Splitpage asks first.
- **Ctrl+Tab** / **Ctrl+Shift+Tab** step to the next or previous tab.
- Drag a tab out of the window to give it its own window, and drag it into
  another Splitpage window to bring it back in. Drag a tab past another one
  to reorder them.

Every tab you have open comes back the next time you launch Splitpage.

**A new tab starts on a choice, not on a document.** It asks for one of two
things — **New script**, which is a genuinely empty script (one blank scene,
no tags, no comments, nothing carried over), or **Open a file**, which is the
same picker as File ▸ Open a document…. The same page shows in the browser
app on a fresh copy nothing has been opened or saved into. It never appears
over a document: not one you opened, not a shared session's, and not one
coming back from a crash. If you would rather look at the example script that
ships with Splitpage, the link at the bottom of the page dismisses it (so does
Esc).

**Recent** is the third column, in the desktop app. It lists the last 20
documents you had open, most recent first, by title and file name; clicking
one reopens it in that tab with no picker in the way. If a file has been
moved or deleted since, clicking it says so instead of failing quietly, and
the **×** beside any entry takes it off the list — **Clear recent** takes
them all off. The list is kept with the rest of the desktop app's session
state on your own machine: it is not in a saved script, not in an export
(including **Export app data**), and nobody in a shared session can see it.
The browser app does not have this column — a browser can only reopen a file
it still holds permission for, so it remembers the last one and no more.

**Crash recovery.** If the app or your computer goes down with unsaved work
open, nothing is lost: every tab's unsaved changes are kept on disk as you
type, and Splitpage offers them back, tab by tab, the next time you launch
it. That includes a document from a shared session whose server you can no
longer reach — it comes back as an unsaved local copy, with a note naming
the server document it came from.

**Closing with unsaved work.** Closing a window or quitting the app while
any of its tabs have unsaved changes asks once, in a single dialog listing
every tab that would lose work, with **Review**, **Close without saving**,
and **Cancel**.

**Duplicate files.** If you open a copy of a file that's already open in
another tab — for example, the same `.md` file synced down onto two
machines — Splitpage notices and gives the copy its own version history,
separate from the original's. Nothing is written to either file until you
save.

**Installing:** run `SplitpageDesktopSetup-<version>.exe`. It installs for you
only (no administrator needed) and lets you choose the folder, and there is
nothing else to install first. It isn't on the releases page yet — for now it
is built from source (see DEPLOY.md) — and it isn't code-signed yet, so Windows
may warn before running it.

The installer adds a desktop shortcut and a **Splitpage** folder in the Start
Menu with two shortcuts:

- **Splitpage** — the app on its own.
- **Splitpage (shared session)** — starts hosting for others on your network
  straight away, always with a join PIN. The Servers dialog opens to show the
  addresses to open and the PIN; closing Splitpage stops sharing.

**Command-line flags** match the browser launcher's: `--library`, `--host`,
`--pin [code]`, `--review-pin [code]`, `--share-readonly`, `--data DIR`,
`--port N`, `--allow-origin URL` and `--tunnel user@host`. The desktop app has no console window to type an SSH
password into, so `--tunnel` needs key-based SSH login. Script files named on
the command line open at launch.

## Installing it

**For the desktop app** — its own window, tabs, and version history — see
[Desktop app](#desktop-app) above; that installer
(`SplitpageDesktopSetup-<version>-x64.exe` / `-arm64.exe`) is what's on the
releases page.

**For the portable copy**, download `splitpage-<version>.zip` from the same
place, unzip it anywhere, and run `start.bat` (Windows) or `./start.sh`
(macOS/Linux). Nothing is installed and nothing is compiled; it uses a Node
you already have. Without Node you can still open `index.html` directly in a
browser to write and export — you lose "Install app", the offline service
worker and the teleprompter's microphone, all of which need a served page.

There used to be a third way in here: a self-extracting
`SplitpageSetup-<version>.exe`, built by Windows' own `iexpress.exe` around a
PowerShell installer, a PowerShell uninstaller and its own copy of
`node.exe`. 2.0.0 had already stopped publishing it and DEPLOY.md called it
deprecated; it is deleted now, along with the PowerShell fallback server and
the portable uninstaller scripts. The Electron setup and the zip are the two
ways to install this.

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
> [DEPLOY.md](../DEPLOY.md), which puts Cloudflare Access in front.

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

### Seeing who else is in the document

In a hosted session the header shows coloured initials for the other people in
the document, and a dot in the gutter of the scene each of them is working in —
on the field itself when it is the field you are in, which is the one clash the
merge cannot resolve quietly. Hovering names them. Names come from the name your
comments are signed with; anyone who has not set one shows as **Guest**.

It updates every couple of seconds, goes away when someone closes their tab or
leaves it alone for a few minutes, and is never part of the document: it is not
saved, not in the version history, and not on the server's disk. A document you
are editing on your own sends nothing at all.

### Letting someone comment without letting them edit

```
node start.mjs --host --pin --review-pin
```

The launcher prints a second address — the same one with `#review=…` on the end
— and a second six-digit code beside it. Either one opens the session to be
**read and commented on**: the script renders, the teleprompter and every export
work, comments and replies can be added, and nothing else can change. Fields are
not editable and the header says *Viewing · comments only*. `--share-readonly`
is the same thing with both codes generated for you.

Those two are the *session's* credential: the code you read out covers every
script on the server, because you chose it before any of them was open. The
link **File ▸ Servers…** offers is narrower, and is the one to send. Open the
script you want read, press **Copy review link**, and the address you get opens
that one script and no other — the key is minted for it, and the server refuses
the rest of your library to anyone holding it. The button is there only while a
script is open on the server, because there is nothing to make a link to
otherwise.

The refusal is your computer's, not the page's: the server compares what a
review session sends against what it has stored and accepts only added comments
and replies, so it does not matter what the other person's copy of Splitpage
lets them click, or what they type into their browser's console. They cannot
resolve or delete anyone's comments either. Restarting your session invalidates
every review link and both codes.

Reviewers can put pictures in their comments, within an allowance: each
review link or code may upload about 20 MB of images per hour (the host can
change it with `REVIEW_BLOB_BUDGET_BYTES`). Past that, the comment waits and
Splitpage says so; try again later, or post it without the picture. The
server takes PNG, JPEG, GIF and WebP up to 8 MB each.

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

The desktop app registers itself, so remove it from **Add/Remove Programs** —
that clears the shortcuts too, and leaves any shared-session scripts in
`%LOCALAPPDATA%\Splitpage\data` where they are.

The portable copy is a folder. Delete it. There is nothing registered, no
service and nothing outside it, so there is nothing an uninstaller could do
that deleting the folder does not — which is why the `uninstall.bat` /
`uninstall.sh` / `uninstall.mjs` trio is gone. Check `data/` for scripts you
want to keep before you do: they live inside that folder unless you pointed
`--data` somewhere else.

## Keeping it up to date

```
node update.mjs           # is there a newer version?
```

The launcher checks at every launch too, and the app shows a bar when there is
something newer — with an **Open release page** button, because opening that
page is the whole of what a portable copy can do about it. **The portable copy
does not update itself**: download the new `splitpage-<version>.zip` and unzip
it over the old folder, or install the desktop app, which does update itself. Update checks go to a public releases
mirror so a shipped copy can still see new versions even though the main
repository is private.

That in-place self-update used to exist — the launcher staged a verified copy
of the release under `.update/` and swapped the files in at the next launch,
with a backup, a crash sentinel and a rollback. It was one distribution path
too many and the one that kept breaking releases, so it was removed. What is
left is the question it was really answering: is there something newer?

The desktop app is the copy that installs its own updates. It checks at
startup, and its Download button fetches the installer for your platform and
architecture inside the app. The download is checked against the `SHA256SUMS`
published with that release, and a release that published none is **not
installed** — the app says so rather than running a file it cannot vouch for.
When a download has finished and matched, the button becomes **Install and
restart**, which runs the installer and closes Splitpage. The release page
only gets offered when a release has no installer your machine can run.

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
- **Alt+Up / Alt+Down** moves the scene you're in one place earlier or
  later, caret and all — in the split view or the writer.
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

**Hide shot scenes.** File ▸ **Hide shot scenes** (or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd>)
collapses every Shot scene into a thin "N shot scenes hidden" strip — click
one open to see it again. The runtime chip switches to showing what's left
to read alongside the total. It's a reading preference for this device, so
it never touches the file: changing a scene you can see to Shot gives it a
moment before it collapses, and Find, comments and tag jump-to all expand a
hidden scene rather than missing it. The writer and the teleprompter both
honour it too.

**Scene mode**, in the teleprompter, plays one scene at a time instead of
scrolling straight through the whole script — the way a solo shooter records.
Turn it on with the **Scene mode** button on the prompter's bar (off by
default, remembered on this device); it cues the scene you had the caret in
(or the one you're reading if you switch it on mid-read) with its first line
at the reading guide, plays, and pauses itself the moment the last line
passes that guide, ready for the next take. **‹ Prev** / **Next ›** (or
<kbd>←</kbd>/<kbd>→</kbd>) jump to the neighbouring scene, and a small "Scene
4 of 12" readout says where you are — pressing Play again after an auto-pause
carries straight on into the next scene rather than replaying the one that
just stopped. It works the same way with **Follow My Voice**, and it skips
whatever **Hide shot scenes** above is currently hiding.

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

Resolving a thread records who closed it and when ("Resolved by Adam · 2
days ago"); unresolving clears that note. **Assign** on a card hands the
thread to anyone already in the Production breakdown, or anyone who has
commented. The **Open / Resolved / All** bar at the top filters the list —
Open is the old "Hide resolved" behaviour under a new name — and its
**Assigned** dropdown narrows further to "assigned to me" or to any one
person, each with its own count. The filter is remembered on this device
only; it never touches the saved document.

**Undo and redo.** <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> undoes the
last thing you did to the script, and <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>
(or <kbd>Ctrl</kbd>+<kbd>Y</kbd>) redoes it — typing a word at a time, and
everything else too: a deleted or moved scene, a split, a tag, a status, a
picture, a comment, Replace All, changes in the Production panel. It works
from anywhere in the script and in the writer, not only from the cell you
were typing in. A text box of its own (the title, a search, a comment you
are writing) keeps its own undo while you are in it. When someone else's
changes are merged into your copy, undo forgets only the scenes their
changes touched, so it never takes back their words. On a document hosted
on a server, a comment you have posted is already with everyone else, so
undo leaves it alone — delete it the usual way.

**Find and replace.** <kbd>Ctrl</kbd>+<kbd>F</kbd>. Enter and
Shift+Enter step through matches; **Aa** toggles case-sensitivity.
Formatting, links and comment anchors survive a replace untouched. Text
inside a tag is deliberately left alone — rename those in Production, which
changes the label and the tracked item together.

**Reference images.** The small **📎 Image** link at the top of a scene's
visual column attaches a still — or just drag an image file from your desktop
anywhere onto that column and drop it. Once a scene has one, hover it for
**Replace** and **Remove**. A comment can carry a picture too (**🖼 Image**
in the comment box), and a picture pasted into a scene or a reply is kept.

**Where pictures are kept.** The script itself only names each picture; the
picture is stored once, separately, wherever the script lives:

- In a browser, in that browser's own storage for the page, next to your
  version history.
- In the desktop app, in its app-data folder (a `blobs` folder beside
  `history`).
- On a server, on the server, alongside the scripts.

A file you save from Splitpage — `.splitpage`, `.md` or Standalone HTML —
still carries every picture inside it, so it opens complete anywhere,
including in an older copy of Splitpage. If a picture can't be found (a
version restored after its picture was lost, say), it shows as
**Image unavailable** and the rest of the script is untouched; a save then
tells you how many images it could not include. Splitpage looks for a
missing picture again whenever it redraws the spot, so one that turns up
later simply appears. On a hosted script it asks the server again only
when someone's newer version of the script arrives, or after a few
minutes — not every time the screen redraws.

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
  shut. That is **[DEPLOY.md](../DEPLOY.md)**.

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
comment flagged **Unmerged edit**. The same goes for a word you both linked, or
tagged, differently: their link or tag stays in the script, everything else
you both changed is combined, and yours is kept on the comment. Nothing is ever
silently dropped.

If your sign-in expires while you are working, Splitpage notices, keeps your
unsaved edits, and asks you to reload; signing back in reopens the document and
merges them in, along with anything that changed while you were away.

If the server has been updated and your open page is older than it, saving
stops with **This page is out of date for this server** and asks you to
reload. Do that: an older page cannot see the pictures a newer one stored, and
the server refuses its saves rather than let it drop them. Your unsaved edits
are kept and merged back in after the reload.

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

### In the desktop app

The desktop app has no API key or Client ID form. Instead you **sign in with
Google** in your own browser, once: the app opens Google's sign-in page,
you choose your account and allow access, and the browser tab tells you to
return to Splitpage. From then on the panel browses your whole Drive
(starting at My Drive, or paste a folder link), downloads files to your
computer (a Google Doc comes down as plain text), and uploads files — an
upload with the same name as a file already in that folder replaces it with a
new version rather than adding a second copy. Rename, delete and new folder are
browser-app only for now. **Sign out** in the panel forgets the sign-in and
tells Google to cancel it.

The sign-in is kept in your system's secure storage (Windows' own credential
encryption), never in your documents, drafts, or **Export app data**. On a
Linux computer with no keyring, it lasts until you quit, and the panel says
so.

**Setting it up (once per computer).** Google only lets an app sign in on your
behalf if it has a client ID from a Google Cloud project, and only the
project's owner can make one:

1. In the [Google Cloud Console](https://console.cloud.google.com/apis/library/drive.googleapis.com),
   pick or create a project and **enable the Google Drive API**.
2. Under **APIs & Services ▸ OAuth consent screen**, set the app up and add the
   `…/auth/drive` scope. Until Google verifies the app, add every Google
   account that will sign in as a **test user**.
3. Under **APIs & Services ▸ Credentials**, create an **OAuth client ID** of
   type **Desktop app**, and download its JSON file.
4. Save that file, unchanged, as `google-oauth-client.json` in Splitpage's
   settings folder — the Google Drive panel shows the exact path while nothing
   is set up (on Windows it is `%APPDATA%\Splitpage\google-oauth-client.json`).
   Or, instead of the file, set the environment variables
   `SPLITPAGE_GOOGLE_CLIENT_ID` and `SPLITPAGE_GOOGLE_CLIENT_SECRET` before
   starting Splitpage. The file can also be written by hand as
   `{"client_id": "…", "client_secret": "…"}`. Google calls the second value a
   secret, but for a Desktop-app client it isn't one — every copy of the app
   has it.

No restart is needed after adding the file; just open the panel again.

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

**File ▸ Export** has two Markdown options. **Markdown (.md)** reads
like a script rather than a filled-in form: a `### Scene 01` heading, then
the visual direction as an italic lead-in ahead of whatever's spoken, with
nothing printed for a field that has nothing to say. A picture is referenced
from a sibling `images/` folder instead of pasted inline as base64 — once a
script has any pictures, this export becomes a small `.zip` so the folder
actually travels with the `.md`. **Markdown, two columns (.md)** lays the
same script out as a table instead, one row per scene with a Visual column
next to an Audio column — the way the split view itself looks, and the way a
GitHub/Notion/Obsidian-style Markdown viewer actually renders a table, side
by side rather than stacked. It's also exactly the shape **Paste a
script…** already reads back in "Two columns" mode, so a two-column
Markdown export round-trips back into Splitpage with the split intact, and
it keeps embedding pictures inline so the single `.md` file stays complete
on its own.
Both carry the production breakdown and comments the same way.

**File ▸ Export ▸ Word (.docx)** carries the same polish: named
paragraph, character and table styles, a document theme font, scene numbers
in their own column, page numbers in the footer, and a production-breakdown
table whose columns size themselves to what's actually in them instead of a
fixed guess. Its comments section shows each picture in a comment or reply
where it was, as the PDF does; Markdown, CSV and plain text write
`[image]` in its place. Open one of these `.docx` files again and you get
the script's scenes back — its text and pictures — and nothing else: the
production-breakdown and comments sections stay behind, so they never turn
into extra scenes, and a picture from a comment never lands on a row.

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

### Autosave

Once your script has a file — because you saved it once, or opened one —
Splitpage keeps that file up to date on its own: a couple of seconds after
you stop typing, what is on screen is written back to it, with no dialog and
no toast. Leaving the window writes whatever is still pending immediately,
so switching to another app is as good as pressing Save. A hosted script on
a server works the same way, with the server as its home.

Before that first Save there is nothing to autosave *into*, so nothing is
written — Splitpage never pops a file dialog, or drops a file in your
Downloads folder, because you typed a word. Autosave also stands aside for
work you have not looked at yet: changes recovered after a crash sit on
screen until you press Save yourself.

Beside the **Save** button is a line of small text saying where things
stand — **Saved**, **Saving…**, **Unsaved changes**, or **Not saving** when
something is in the way (a file that changed on disk under you, a write that
failed, a lapsed sign-in). Hover it for the detail: which file, or what to
do about it. The writer has the same line beside its own Save button.

Turn it off with **File ▸ Autosave**, and the file is written only when you
press Save. The setting is remembered between launches. Either way, the
desktop app keeps its own crash-safe copy of everything typed since the last
save — see [Desktop app](#desktop-app).

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

If the file changed **while it was still open here** — you edited it in
another window, someone emailed a revision back, a sync client caught up —
Splitpage says so when you Save rather than overwriting it, and offers to
**Merge them**. That opens a review pane listing every field the two versions
disagree about, side by side, with the changed words highlighted: titles,
scene text, statuses, breakdown items, crew and b-roll. Nothing is written to
the file and nothing changes on screen until you press **Merge them** again at
the bottom of it — Cancel puts you back to the other choices, having changed
nothing. Confirming keeps both sides' edits where they touched different
things; where you both changed the same line, or linked or tagged the same
word differently, the file's version goes into the script and yours is kept as
a comment flagged **Unmerged edit**, exactly as on a server. The merged script sits on screen, unsaved, until you press Save.

### Sending it to someone who has nothing installed

**File ▸ Export ▸ Standalone HTML (.html)** writes one self-contained
page: your script with a copy of Splitpage wrapped around it. They
double-click it and the script is there, editable, with nothing to install
and no account. It is a far bigger file than a `.md`, so it is for sending,
not for working in.

It is a **copy**, though, and that is deliberate: it carries no link back
here, it never connects anywhere, and whatever they type stays in their
file. If you want their edits to come back, send a link instead.

### Sending a link, so their edits come back

**File ▸ Publish & copy a link** puts this script on the server you are
connected to and copies the address of it to your clipboard. Everyone who
opens that link is editing the *same* document — the same shared script the
rest of "Working together" describes, with saves merged rather than
overwriting each other — rather than their own fork of it.

- It needs a server to publish to. With none connected it says so and opens
  **Servers…** rather than doing anything; see "Working together" for the
  two ways to run one (an ad-hoc session from your own machine, or a
  permanent deployment).
- If the script is already on the server, it saves first, so the link never
  points at a version older than what is on your screen.
- The toast that confirms the copy also says what the person opening it will
  be asked for: the join PIN, a sign-in, or nothing at all.
- The link is just the server's address with `?doc=` and the document's id
  on it. Opening one goes straight to that document, asking for the PIN
  first if the server wants one.

## Version history

Splitpage keeps snapshots of your document as you work, so you can step back
to an earlier version. Open the **Version history** panel to see the list
and restore one.

History is per document: each script keeps its own list, separate from any
other script you have open. It's kept in the app's own storage on the
desktop app, and in that browser's storage on the web — either way it stays
on your machine, not in the saved file or an export. The first time
Splitpage sees the single shared history list an older copy of the app used
to keep, it's brought in automatically under **Older history**, where it
stays available for 90 days before it's cleared out for good.

## Reopening a saved project

A file Splitpage saved is a complete project, not just text — reopen it and
you get everything back: scenes, comments, tags, images, title. Two ways:

- **File ▸ Open a document…**, then pick the `.md` or `.splitpage` file.
  Useful when you're already in the app and want to switch projects.
- **Double-click a saved Standalone HTML file.** It opens straight into that
  project — that is what being self-contained means.

That same menu still opens `.docx`/`.txt`/`.csv`, and Markdown that isn't one
of Splitpage's own, as plain script text — but a file like that carries no
project of its own, so **opening one starts a new document**: a new script
with an empty breakdown, no cast list, no b-roll and no comments, and a Save
button that points nowhere yet. Nothing of the document you had open comes
with it.

If what you actually have is a **revised draft of the script you're already
working on**, use **File ▸ Paste a script…** instead. That modal replaces (or
appends to) the scenes and keeps the document you're in — its breakdown
statuses, owners and notes, its cast list, its b-roll list and its comments
all stay where they are. It takes a `.docx`, `.md`, `.txt` or `.csv` file
through **Choose a file…** as well as pasted text.

That modal also asks **what Splitpage should look for in the script**. The
one thing it looks for today is B-roll: with **Look for B-roll lines and
track them** ticked, every line starting `B-roll:` in the Visual column
comes in as a real marker on the b-roll list, so it keeps its status, notes
and owner when you later reword the line — and the import tells you how many
it found. Untick it and the text is left exactly as you pasted it. Your
answer is remembered, so if you import drafts all day you are only asked
once.

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
