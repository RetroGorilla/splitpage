# Splitpage — standalone

This is your Splitpage script editor, converted out of the Claude artifact
runtime into a plain, self-contained web app. Nothing here talks to Claude
or to any server — everything (script text, comments, tags, version
snapshots) lives in the page itself and in files you save to your own disk.

## Running it

**Quickest — just open it.** Double-click [index.html](index.html). Editing,
comments, the teleprompter, and Export all work straight away.

**For "Install app" / offline support.** Browsers only offer to install a
page as an app (and only let its service worker cache it for offline use)
when the page is served from `http://`/`https://`, not from a `file://`
path. To get that:

1. Double-click **[start.bat](start.bat)**. It opens a small window running
   a local server (pure PowerShell, nothing to install) and launches your
   browser to `http://localhost:8791/`.
2. In Chrome or Edge, click the **install icon** in the address bar (or
   Menu ▸ "Install Splitpage…") to add it as its own app window with a
   taskbar/Start Menu entry.
3. Leave the `start.bat` window open while you work; closing it stops the
   server. Re-run it any time — your saved `.html` file doesn't depend on
   the server, so you can always fall back to just double-clicking it.

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

**Cast** and **Music/SFX** have no shortcut (nothing else is safe to type
in normal prose) — select the words and press **Tag**. Once a tag of any
category exists, typing a bracket and the first few letters offers to
complete it: press **Tab** to accept. The completion keeps that tag's own
category, so you never end up with the same thing filed twice.

Other things worth knowing:

- **Ctrl+Enter** while writing starts the next scene and jumps into it.
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

Splitpage can also run as a small server, so a script lives on the server
rather than in a file on one person's disk. Collaborators open a link, sign in,
and work on the same document you do. See **[DEPLOY.md](DEPLOY.md)** for how to
set that up on Unraid behind a Cloudflare tunnel.

When the app is served that way, three things appear:

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
- In the teleprompter the screen **stays awake** while you read (on browsers
  that support it) and releases when you close it.
- **The writer** works the same, with the scene number and its visual on a
  thin line above each paragraph instead of out in the margin — a phone has
  no margin to put them in.

Typing shortcuts (`[prop]` `{kitchen}` `~vfx~`), comments, status, exports,
the server features — everything else is exactly the same.

## Reopening a saved project

A file Splitpage saved is a complete project, not just text — reopen it and
you get everything back: rows, comments, tags, title. Two ways to do that:

- **Double-click the saved `.html` file directly.** It opens straight into
  that project — this is how the file is self-contained in the first place.
- **File ▸ Open a document…**, then pick that `.html` file. Same result,
  useful when you're already in the app and want to switch projects. (This
  same menu still also imports `.docx`/`.md`/`.txt`/`.csv` as plain script
  text, same as before — Splitpage tells the two apart by file extension.)

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

- `index.html` — the app. Fully self-contained; the only thing it fetches
  is the Google Fonts stylesheet (falls back to system fonts if offline).
- `manifest.webmanifest`, `icon.svg` — makes "Install app" possible.
- `sw.js` — a small service worker so the app shell still opens offline
  once you've loaded it at least once while served over `http://`.
- `start.ps1` / `start.bat` — a zero-install local static server (built on
  .NET's `HttpListener` via PowerShell) so the page has a real origin.
- `server/server.js`, `Dockerfile`, `docker-compose.yml` — the optional hosted
  mode: a dependency-free Node server that serves the app and stores documents
  as one JSON file each. Only needed if you want collaborators; see
  [DEPLOY.md](DEPLOY.md).
- `HANDOFF.md` — developer notes: architecture, the invariants that keep the
  document from corrupting, how to test, and what is still unverified. Read it
  before changing `index.html`.
