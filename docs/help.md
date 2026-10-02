# Splitpage

Splitpage is a two-column script editor for video: what the viewer sees on
the left, what gets said on the right. It has a teleprompter, comments, and a
production breakdown that tracks every prop, location, VFX shot and person in
the script.

Scripts save as plain Markdown (`.md`) you can open anywhere, or as
`.splitpage` files. Splitpage runs in a browser or as a
[desktop app](#desktop-app) for Windows. To work with other people,
[collaborate](#collaborating): one click gives you a link to send, and
whoever opens it works on the same script, with nothing to install. On your
own network you can also [host a shared session](#hosting-a-shared-session).

## What's new since 3.1

- In the desktop app, some menu-bar commands ran behind an open dialog, the
  writer or Present. They now stop and say what to close first: Save and
  Save As… (Ctrl+S, Ctrl+Shift+S) while a dialog or the command menu is
  open; Open… (Ctrl+O) and Export… while either of those, the writer or
  Present is; Find & replace while a dialog or the writer is; Hide shot
  scenes (Ctrl+Alt+H) while a dialog is. Search Commands… already stopped
  under a dialog, the writer, Present or the tour, and now says why too.
- Ctrl+Z right after opening writer mode closes writer instead of undoing a
  change hidden behind it in the split view. Ctrl+Shift+Z brings writer back.
- Merging two versions of a script could drop, duplicate or keep a deleted
  scene, comment, crew member, breakdown entry or b-roll shot whose id was a
  special word such as `constructor` or `__proto__`, and could blank a
  scene's text. Only a hand-edited or damaged file has such ids. They now
  merge like any other, and files that have them open unchanged.
- A scene or comment whose id was such a special word also tripped up undo,
  Hide shot scenes, comment highlights and replies, and the merge review:
  undoing the delete of such a scene could fail, and such a shot scene never
  hid. They now behave like any other.
- When a merge found that you and someone else had both added the same
  person, the production items and b-roll shots you had given that person
  came out unassigned. They now keep that person as their owner.
- Markdown export wrote `[text](null)` for a link with no address. It now
  writes the text alone.

## What's new in 3.1

- **Collaborate.** **Collab** in the header (or **File ▸ Collaborate…**)
  puts the script on your server and gives you two links to send: one to
  edit, one to comment. A link opens that one script, needs no account, and
  can be renewed or turned off. See [Collaborating](#collaborating).
- **Unsaved changes to a server script survive a closed tab.** The browser
  keeps them as you type and merges them back in the next time you open
  the script, with **Undo merge**.
- **Draw on your pictures.** In a scene's gallery, press **Annotate** to
  mark up a picture with a pen, a highlighter, text and an eraser (P, H, T
  and E pick them). Your marks stay editable, and **Remove annotations**
  gives you the original back. See [Annotating a picture](#annotating-a-picture).
- **Search commands** (Ctrl+K) puts the tagging reference first, and
  searching *tags* finds it.
- **Export to Excel.** File ▸ Export… ▸ **Spreadsheet** now makes an Excel
  workbook: sized columns, wrapped text, a frozen header with filters, a
  Notes column to write in, and a sheet for each part. **CSV** is the
  second choice on the same card, and the Breakdown and the B-roll shot
  list offer both. See [Exporting](#exporting).
- **The writer's tools are at the top**, under the title, where the
  script's formatting bar is, and **Close** is beside **Save**.
- **The tagging reference lists every word form**: `Prop:`, `Location:` or
  `Loc:`, `Cast:`, `VFX:`, `Gear:`, and `SFX:` or `Music:`, each with its
  tag colour, beside the bracket shortcuts.
- **Saving you can trust.** Text typed while a publish or a save is still
  going stays marked unsaved until it is saved, instead of being called
  saved. Opening another script during a publish leaves that script alone;
  the published copy waits on the server. **Save As** on a shared script
  now makes a copy without calling the shared one saved. And a malformed
  request can no longer stop a shared-script server.
- **An empty scene deletes in one click**: its **⋯ ▸ Delete** no longer
  asks twice when there is nothing in it to lose.
- **Version history from 2.x** is no longer converted. If you are updating
  straight from 2.x, install 3.0 first to keep it. Nothing changes if you
  already have 3.0.

## What's new in 3.0

- **A new look.** Calmer dark and light themes, a running order of the whole
  script under the header, each scene's status as a lamp, and side panels
  that open beside the script instead of over it.
- **A start screen for every new tab**: a blank script, three starter
  scripts, a long demo that shows off every feature, your recent documents
  and a drop zone for a file.
- **One undo for everything.** Ctrl+Z and Ctrl+Shift+Z take back typing,
  tags, scene moves, statuses, pictures, comments and Production changes.
- **Stage directions**: type `((beat))` in the Audio column.
- **Sound cues**: start an Audio line with `SFX:` or `Music:`.
- **Timing**: set a target length for the piece, or a scene's length by hand.
- **Several pictures and videos per scene**, with YouTube, Vimeo and dropped
  video files playing in the scene's gallery. Click a picture to see it
  full size.
- **Settings in one place** (File ▸ Settings), **script zoom**
  (Ctrl + mouse wheel), **Search commands** (Ctrl+K) and **one Export
  dialog** (Ctrl+E).
- **A B-roll panel built for the shoot**, with prop statuses and a
  full-page shot list.
- **Exports that match the app**: the PDF and Word script carry each
  scene's status, timecode and read time, tags in their colours, numbered
  comments, the breakdown and a b-roll shot list. Markdown and spreadsheets
  gain the same, and the packing list has sign-off lines.
- **Merging a word at a time**: two people's edits to one scene combine
  unless they changed the same words.
- **Plain-language tags**: type `VFX:` or `Prop:` in the Visual column and
  press Tab. The tagging reference is now a card that floats beside you.
- **Tag every mention at once**: find a word (Ctrl+F) and press
  **Tag all as…**.
- **Whole scenes**: drag out of a text box to select scenes, then copy, cut,
  paste or delete them, comments and pictures included.
- **The rundown** magnifies the scenes under the pointer, shows the script's
  length at its end, and shows where other people are working.
- **In the desktop app**: Follow My Voice through Windows' own speech
  recognition, Google Drive, and a server connection per tab.

Release notes for every version are on the
[releases page](https://github.com/RetroGorilla/splitpage-releases/releases).

## Getting started

- **Setup.** The first time you open a fresh copy, a short wizard asks how
  you'll be working and offers the tour. **File ▸ Set up** reopens it any
  time; it never changes your script.
- **The tour.** **File ▸ Tour** walks through five things to know, each
  with a **Read more** link into this guide.
- **Help.** **File ▸ Help** opens this guide (<kbd>F1</kbd> in the desktop
  app).

### The start screen

A new tab opens on a start screen rather than a document. The browser app
shows it too, on a fresh copy nothing has been opened in.

- **Blank script**: one empty scene.
- **Starter scripts**: **To-camera video**, **Interview** and **30-second
  spot**. Each opens as a new, unsaved script to write over.
- **Open a file**, or drop a `.md`, `.splitpage`, `.docx`, `.txt` or `.csv`
  file anywhere on the page. The drop zone's links paste a script or import a
  Google Doc link.
- **Join a shared session** opens the Servers dialog.
- **Recent** (desktop app): the last 20 documents you had open. Click one to
  reopen it; **×** takes it off the list, **Clear recent** empties it.
  **Continue** at the top reopens the most recent.
- **Take the tour**, or **Look at the example script** (or <kbd>Esc</kbd>)
  to close the start screen and see the demo script.
- **Open the long demo (30 scenes)**: a whole video, nearly ten minutes
  long, with every feature in use (all three scene statuses, every tag
  category, b-roll, comments, stage directions, set read times and a target
  length), to see how Splitpage handles a real-length script. Like a
  starter, it opens as a new, unsaved copy. The command menu
  (<kbd>Ctrl</kbd>+<kbd>K</kbd>) opens it too, keeping the script you had in
  Version history.

## Running it

**Desktop app**: install it from the
[releases page](https://github.com/RetroGorilla/splitpage-releases/releases)
(see [Installing and updating](#installing-and-updating)).

**Portable copy, in a browser**: unzip `splitpage-<version>.zip` anywhere and
double-click `index.html`. Writing, comments, the teleprompter and export all
work straight away. To install it as an app and use it offline, serve it
instead:

1. Run `start.bat` (Windows), `./start.sh` (macOS or Linux) or
   `node start.mjs`. It opens `http://localhost:8791/` in your browser.

2. In Chrome or Edge, click the **install** icon in the address bar to give
   Splitpage its own window and a Start Menu entry.

3. Keep the launcher running while you work: closing it stops the server.
   Your scripts are ordinary files and don't depend on it.

The launcher needs Node. Without it, open `index.html` directly.

## Writing and planning

Each scene is a row: **Visual** on the left, **Audio** on the right.

- **Format text**: select words and use the toolbar: bold
  (<kbd>Ctrl</kbd>+<kbd>B</kbd>), italic (<kbd>Ctrl</kbd>+<kbd>I</kbd>),
  underline (<kbd>Ctrl</kbd>+<kbd>U</kbd>), strikethrough, highlight, link,
  comment and tag.
- **New scene**: <kbd>Ctrl</kbd>+<kbd>Enter</kbd> starts the next scene and
  moves into it.
- **Split a scene**: <kbd>Alt</kbd>+<kbd>Enter</kbd> moves everything after
  the caret into a new scene below, in the same column.
- **Move a scene**: <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>Alt</kbd>+<kbd>↓</kbd>,
  or drag it by its number. The scene's **⋯** menu also has **Move up**,
  **Move down**, **Insert scene** and **Delete**. **Delete** asks for a
  second click, unless the scene is empty (no words, pictures, set length
  or comments): then one click does it. <kbd>Ctrl</kbd>+<kbd>Z</kbd> brings
  a deleted scene back.
- **The rundown**: the strip under the header shows every scene as a block.
  Hover it to magnify the scenes round the pointer, click a block to jump
  to that scene, or drop a
  dragged scene on it to move the scene. **File ▸ Minimise the rundown**
  shrinks it to a line; click the line to bring it back.
- **The header's buttons**: **Production**, **Gear**, **B-roll** and
  **Comments** open their panels; **Collab** invites people to the script
  (see [Collaborating](#collaborating)); **Write** and **Present** are the
  two other ways to see it. In a narrower window the panel buttons shrink to
  their icons and counts, and Collab and Write to their icons. Point at one,
  or <kbd>Tab</kbd> to it, and its name slides out over its neighbours.
- **Scene status**: click the lamp in the scene's gutter to cycle **To do →
  Ready → Shot**.
- **Hide shot scenes**: File ▸ Hide shot scenes
  (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd>) collapses Shot scenes into a
  thin strip. Click the strip to see them.
- **Undo and redo**: <kbd>Ctrl</kbd>+<kbd>Z</kbd> and
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> (or
  <kbd>Ctrl</kbd>+<kbd>Y</kbd>) work on the whole script from anywhere in it.
  Someone else's merged changes are never undone.
- **Find and replace**: <kbd>Ctrl</kbd>+<kbd>F</kbd>. <kbd>Enter</kbd> and
  <kbd>Shift</kbd>+<kbd>Enter</kbd> step through matches; **Aa** matches
  case. Tagged words are skipped; when that's the only place a word
  appears, the count says so ("No matches · 1 in a tag"). Rename those in
  Production.
- **Tag every mention at once**: in the find bar, **Tag all as…** tags every
  whole-word mention of the search in the Visual column as one category —
  find "drone", pick Gear, and all of them are tagged. It shows the count
  before it runs, leaves mentions that are already tagged, and one
  <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes the whole batch.
- **Zoom the script**: <kbd>Ctrl</kbd> + mouse wheel (or pinch) over the
  script, or <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>−</kbd> / <kbd>0</kbd>.
  Only the script changes size, from 70 % to 200 %. Click the size note to go
  back to 100 %.

On a Mac, read <kbd>Cmd</kbd> for <kbd>Ctrl</kbd> throughout.

### Timing

Splitpage estimates each scene's read time from its Audio words, at the
script's reading speed. Visual notes, stage directions and sound cues don't
count.

- **Script length**: the small time at the end of the rundown, just after
  the last scene (at the strip's right edge on a long script, and at the
  right of the status line on a phone). With shot scenes hidden it reads
  what's left / the whole script. It stays on the minimized rundown.
- **Reading speed**: click the script length. It's saved with the script.
- **A scene's length by hand**, for a montage, a title card or a pause: click
  the scene's time in the **Read** column, type `1:30`, `90`, `90s` or
  `1m30`, and press <kbd>Enter</kbd>. Clear it and press <kbd>Enter</kbd> to
  go back to the estimate. It turns amber if the words would take longer.
- **Target length**: click the script length and pick or type a **Target
  length** (or search commands for *target*). The length then reads
  *4:32 / 5:00 · 0:28 left*, or how far over in red. **No target** removes
  it.

### Whole scenes

- **Select**: click in a text box and drag up or down past its edge. The
  page scrolls at the window's edge. <kbd>Esc</kbd> or a click lets go.
- <kbd>Ctrl</kbd>+<kbd>C</kbd> copies, <kbd>Ctrl</kbd>+<kbd>X</kbd> cuts,
  <kbd>Delete</kbd> removes. Right-click for the same, plus **New script
  from these scenes** (it replaces this tab's script; the old one goes to
  Version history).
- **Paste** with the caret in any script, in another tab or the desktop app
  too: the scenes go in after that scene, or replace it if it's empty, with
  their comments, status, b-roll, breakdown details and pictures (up to
  16 MB of pictures per copy). One <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes it.
- **Into Word or Google Docs** they paste as a two-column table.
- A review copy can select and copy only.

### The writer

**Write** in the header opens the Audio column as one flowing document, for
when the job is writing narration. One paragraph is one scene. Its tools
sit along the top, under the title, and **Close** (or <kbd>Esc</kbd>) is
beside **Save**.

- <kbd>Enter</kbd> starts a new scene, <kbd>Shift</kbd>+<kbd>Enter</kbd> is
  a line break, and <kbd>Backspace</kbd> at the start of a paragraph joins it
  to the one above.
- The margin button cycles **Visuals** (each scene's visual, greyed; click
  it to jump there), **Numbers** and **Compact**.
- **Size** sets the text size for you on this device, not in the script.
- Tags, formatting and Save work as in the split view.
- Two scenes that both have a visual can't be joined here. Join them in the
  split view.

### Stage directions

A stage direction is a note for the reader, like *(beat)* or *(look to
camera 2)*, written into the Audio column where it applies.

- **Type** `((beat))`. The double brackets become a direction when you type
  the last one. <kbd>Ctrl</kbd>+<kbd>Z</kbd> straight after gives you the
  brackets back. Single brackets stay as you typed them.
- **Or select** words and press **( )** on the Audio column's formatting bar
  or the writer's bar. Press it again to turn a direction back into words.

Directions show dim and in brackets, appear in the teleprompter, are never
waited for by Follow My Voice, and don't count toward the read time.

### Sound cues

Start a line of the Audio column with `SFX:` or `Music:` (any case), and
that whole line becomes a sound cue: *SFX: door slam*. It turns into one
when you type the colon, and <kbd>Ctrl</kbd>+<kbd>Z</kbd> straight after
gives you plain words back. Mid-sentence, `SFX:` is just words; in the
Visual column it starts a Music/SFX tag instead.

A cue is its own small line in the Music/SFX colour, with a note in front,
so your eye skips it while reading. It is **never on the teleprompter**
(a pause for the sound is a stage direction's job), doesn't count toward
the read time, and is left out of the narration export. The script exports
print it as its own line. Each cue is an item in the Production panel's
**Music & SFX** list, named by the words after the colon (a tag or a stage
direction on the line is not part of the name), with its own status and
owner like any tag. Edit the cue's words and its item follows, keeping its
status.

### Comments

- **Leave one**: select text and press the comment button (the speech
  bubble) in the formatting toolbar. The words get a dotted underline and a
  number.
- **The Comments panel** shows one card per thread. Click a card to jump to
  its words. **Write a reply…** replies, **Resolve** closes the thread,
  **Assign** hands it to someone, and **⋯ ▸ Delete** deletes it.
- **Filter** with the **Open / Resolved / All** tabs and the person menu, and
  sort by **Script order** or **Most recent**.

### Pictures and video

- **Add a picture**: **Add picture** under a scene's Visual text, or drop an
  image file on the Visual column.
- **Paste or drop** a picture, a video file or a video link (YouTube, Vimeo
  and the like) into a scene and it goes into that scene's Image section,
  with **Undo** on the notice. The words you pasted with it stay in the text.
- **Several per scene**: the first is the cover, the next ones sit beside
  it, and **+N** stands for the rest. Videos are also listed underneath.
- **The gallery**: click any tile. Use **‹ ›** or <kbd>←</kbd>
  <kbd>→</kbd> to browse, <kbd>Shift</kbd>+<kbd>←</kbd> /
  <kbd>→</kbd> or drag to reorder, **Make cover**, **Remove**
  (<kbd>Delete</kbd>), and <kbd>Esc</kbd> to close.
- **See a picture at full size**: click the big picture in the gallery
  (or press <kbd>Enter</kbd> on it). A large picture opens fitted to the
  window; click it or scroll to see it at 100 %, and drag to look around.
  <kbd>←</kbd> <kbd>→</kbd> go through the scene's pictures, and
  <kbd>Esc</kbd>, **×** or a click outside goes back to the gallery.
- **Draw on a picture**: pick it in the gallery and press **Annotate**.
  See [Annotating a picture](#annotating-a-picture).
- **Watch a video**: press **▶** in the gallery. YouTube and Vimeo links
  play there, and so does a video file dropped since you opened the script.
  Anything else opens with **Open link** / **Open file**.
- **Video thumbnails**: pasting a YouTube or Vimeo link fetches its
  thumbnail once. Turn this off in **Settings ▸ Fetch video thumbnails**.
- **Comments** can carry a picture too: the image button in the comment
  box.

A saved file carries all its pictures. One that can't be found shows as
**Image unavailable**; the rest of the script is fine.

### Annotating a picture

Circle the thing that matters, highlight a corner, or write a note right on
a picture. Open the scene's gallery, pick the picture and press
**Annotate**. It opens over the whole window with the tools along the top:

- **Pen** and **Highlighter** draw where you drag, with a mouse, a pen or
  a finger. The highlighter is wide and see-through.
- **Text**: click the picture and type. Click away or press
  <kbd>Esc</kbd> to put it down. With Text picked, click a text to change
  it or drag it to move it.
- **Eraser**: drag over a mark to take the whole mark away.
- <kbd>P</kbd>, <kbd>H</kbd>, <kbd>T</kbd> and <kbd>E</kbd> pick the pen,
  highlighter, text and eraser (not while you're typing a text).
- Six **colours** and three **sizes** (S, M, L). Changing them while you
  type changes the text you're typing.
- **Undo** and **Redo** (<kbd>Ctrl</kbd>+<kbd>Z</kbd>,
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>) step through your marks,
  and **Clear all** takes them all away.
- **Done** saves. **Cancel** or <kbd>Esc</kbd> leaves without saving; if
  you've drawn something it asks first, so press it again to throw the
  marks away.

The scene shows the picture with your marks everywhere: the script, the
exports and the teleprompter. The original is kept, so **Edit annotations**
opens your marks again to change them, and **Remove annotations** puts the
picture back as it was. Saving is one step of the script's undo, so
<kbd>Ctrl</kbd>+<kbd>Z</kbd> afterwards takes it back too.

### Presenting

**Present** in the header opens the teleprompter.

- <kbd>Space</kbd> plays and pauses, <kbd>↑</kbd> / <kbd>↓</kbd> change the
  speed, and <kbd>Esc</kbd> closes it.
- **Follow My Voice** scrolls as you read aloud.
- **Mirror** (<kbd>M</kbd>) and **Flip** (<kbd>F</kbd>) are for a
  beam-splitter or an upside-down monitor.
- **Skip shot** leaves out scenes marked Shot.
- **Scene mode** plays one scene at a time and pauses at its end. The arrows
  (or <kbd>←</kbd> / <kbd>→</kbd>) step between scenes.

In the desktop app, Follow My Voice uses Windows' speech recognition; see
[Desktop app](#desktop-app).

### Getting the narration out

**File ▸ Export… ▸ Narration only** writes the Audio column as `.docx` or
`.txt`, one paragraph per scene; the `.docx` puts each scene's number in the
margin, so a session can pick up "from 14". **Include stage directions** puts them in as
*(beat)*. Sound cues are never in it. **Paste a script…** reads that shape back in.

## Tagging and the production breakdown

Tag things in the script and they appear in the **Production** panel, with
every scene they're in. While you type a tag you've used before,
<kbd>Tab</kbd> accepts the completion Splitpage offers.

**The tagging reference**: **File ▸ Tagging reference** (or search commands
for it) opens a card at the bottom right of the script (a sheet at the
bottom on a phone). It shows every way to type a tag, each in its tag
colour: the brackets, and a category's name and a colon for all six
categories. It stays while you scroll and type, fading while the caret is
under it. <kbd>Esc</kbd> or **×** closes it. Cast and Music/SFX have no
brackets: type `Cast:`, `SFX:` or `Music:`, or select the words and press
**Tag**.

**Icons on tags**: turn on **Settings ▸ Show icons on tags** to put a small
icon before each tag as well as its colour: a box for a prop, a pin for a
location, a person for cast, a sparkle for VFX, a note for music and sound,
a camera for gear. It helps when the colours are hard to tell apart, for
example in greyscale. The icons also show in the Production and Gear panels
and on the tagging reference. They are never part of your text, so copying,
exports and read times stay the same, and the teleprompter leaves them out.

**Plain-language tags**: in the Visual column, type a category and a colon
(`VFX:`, `Prop:`, `Location:` or `Loc:`, `Cast:`, `Gear:`, `SFX:` or
`Music:`, in any case). The words you type next are tinted in that
category's colour.

- <kbd>Tab</kbd> (on a phone, tap the note under the box) makes them one
  tag.
- <kbd>Esc</kbd> cancels and leaves the plain text.
- <kbd>Ctrl</kbd>+<kbd>Z</kbd> after <kbd>Tab</kbd> takes the tag off and
  leaves your words as you typed them.

**The Production panel**, grouped by category or person, is a table:
**Item · Status · Scenes · Owner**. Click a scene number to jump to it.

- **Open an item**: click its name, or the tag in the script. Set its
  **Status**, **Assigned to** (**Add person** adds a name), and **Notes &
  links**. **⋯** has **Rename** and **Remove label** / **Delete from list**.
- **Status**: **Needed → Sourcing → Have it → Returned**. Click the status to
  step it on. "Returned" also means finished with, for a location or VFX
  shot.
- **Several at once**: <kbd>Ctrl</kbd>+click items (<kbd>Shift</kbd>+click
  for a run) to assign, set status or delete them together. Deleting removes
  their tags from the script too; the words stay. <kbd>Esc</kbd> clears the
  selection.
- **Group** by category, person or scene, or **Shoot** to see scenes grouped
  by location, with what each needs.
- **Untagged mentions**: write the name of something already tracked in
  the Visual column without tagging it, and it gets a dotted underline and a
  **Tag** offer. <kbd>Tab</kbd> takes it, <kbd>Esc</kbd> waves it off.
  To tag them all at once, open the item and press **Tag all N mentions**.
- **Not in script**: deleting a tag from the script keeps the item, flagged,
  until you delete it.
- **Export** it with the panel's **CSV** button, or File ▸ Export… ▸
  Breakdown. PDF, Word and Markdown exports include the breakdown too.

### Gear

**Gear** in the header lists equipment: cameras, mics, lights. Gear that's
never written in the script goes in the **Add gear** box at the foot of the
panel, one item per line; press **Update list**. **List** or **Scene**
changes the view. **Packing list** prints a checklist with a box for going
out and one for coming back, and lines to sign.

### B-roll

Start a line in the **Visual** column with `B-roll:` and it becomes a shot
on the **B-roll** list. Lines under it, up to the next marker, are its
description.

- **Mark a shot done**: tick its box.
- **Filter** with **All / To shoot / Flagged / Shot**, and group by scene or
  location.
- **Open a shot** to set its location, who's getting it, its props, a note,
  or **Flag for reshoot**. **⋯** has **Rename in script** and **Delete from
  list**.
- **Props**: a prop tagged in a shot's lines counts for it. Add others with
  **Add prop**.
- **Several at once**: <kbd>Ctrl</kbd>+click or <kbd>Shift</kbd>+click shots,
  then mark, assign, move or flag them together.
- **Add a shot** at the foot of the panel for one the script doesn't have.
- **The shot list**: the arrows button beside the panel's **×** opens every
  shot on one page, grouped by location, scene or person, with **CSV** and
  **Print shot list**, which prints it as you see it there. **← Script** or
  <kbd>Esc</kbd> goes back.

## Saving your script

**Save** (<kbd>Ctrl</kbd>+<kbd>S</kbd>) writes the script to a file. The
first Save asks where, and in which format:

- **Markdown (`.md`)**, the default: a readable table of scenes, then the
  breakdown and comments, then a block Splitpage keeps for itself (tags,
  comment anchors, pictures, statuses). Leave that block alone.
- **Splitpage (`.splitpage`)**: the same information without the readable
  table.

**Save a copy…** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>) writes a new
file and leaves the one on screen where it is.

### Autosave

Once a script has a file, Splitpage writes each change to it a moment after
you stop typing, and when you leave the window. Before the first Save,
nothing is written. Turn it off with the **Autosave** switch at the top of
the File menu.

The **Save** button shows where things stand:

- **Saved just now** for a minute after a write, then **All changes saved**
  for as long as nothing changes. Autosave still writes a couple of seconds
  after every change.
- **Saving…** or **Unsaved changes**.
- **Not saving** when something is in the way: the file changed on disk, a
  write failed, or a sign-in lapsed.

Hover it for where and when ("Last saved to script.md at 2:52 PM") or what
to do. The writer shows the same status.

### If you edit the `.md` somewhere else

You can. Edit a cell in the table, save, and reopen it in Splitpage: your
edit is kept, and tracked names in it are tagged again. A comment on words
you rewrote loses its place. If you add or delete whole rows, Splitpage asks
whether to keep its own record or rebuild the scenes from your table.

If the file changes on disk while it's open here, Save offers **Merge
them**, with a side-by-side view before anything is written. Where both
versions changed the same words, the file's version goes in the script and
yours is kept as an **Unmerged edit** comment.

### Sending it to someone

- **Nothing installed?** **File ▸ Export… ▸ SplitShare** writes one `.html`
  file with the script and the whole app in it. It opens in any browser, on
  any device, with nothing to install, and they can read, edit and present
  it. It's a copy: their edits stay in their file.
- **Want their edits back?** **File ▸ Collaborate…** stores the script on
  your collaboration server and gives you two links: one to edit it, one to
  comment on it. Everyone who opens a link works on the same script, in
  their browser, phone included. See [Collaborating](#collaborating).

## Reopening a saved project

- **File ▸ Open…** (<kbd>Ctrl</kbd>+<kbd>O</kbd>) opens a `.md` or
  `.splitpage` file with everything back: scenes, tags, comments, pictures.
- **A `.docx`, `.txt`, `.csv` or other Markdown file** opens as a new
  script, with an empty breakdown and no comments.
- **A revised draft of the script you're in**: use **File ▸ Import ▸ Paste a
  script…** instead. It replaces or appends the scenes and keeps this
  document's breakdown, cast, b-roll and comments. Paste text or **Choose a
  file…**. Tick **Look for B-roll lines** to track `B-roll:` lines.
- **A Google Doc**: **File ▸ Import ▸ Google Doc link…** downloads it as a
  Word file in a new browser tab. Open that file with File ▸ Open….
- **An older `.html` project** opens as it always did. The first Save asks
  where to keep it as `.md`; the `.html` file isn't touched.

**In Chrome or Edge**, Splitpage reopens the last file you saved or opened
when you start it on a fresh page. If the browser needs a click first,
you'll see **Continue where you left off?**

## Version history

**File ▸ Version history…** lists snapshots of the script as you worked.
Pick one to restore it. Each script has its own history, kept on this
computer (not in the file). History from older versions of Splitpage appears
under **Older history** for 90 days. Only 3.0 carries history over from 2.x,
so coming straight from 2.x, install 3.0 first to keep it.

## Exporting

**File ▸ Export…** (<kbd>Ctrl</kbd>+<kbd>E</kbd>) opens one dialog for every
format, with a preview and the file name.

- **The whole script**: **PDF**, **Word**, **Markdown**, **Spreadsheet**
  (a row per scene, as Excel or CSV), or **SplitShare** (the script with the
  whole app built in, for any device).
- **Part of it**: **Narration only**, the **Breakdown** as a spreadsheet, a
  **Packing list** of gear or props, or the **B-roll shot list**: a
  landscape table of every shot with its scene, props, flags and their
  reasons, and lines for notes (or the same as a spreadsheet).

**PDF** and **Word** lay the script out the way the app does: the running
time and target at the top (the PDF adds the rundown strip), each scene's
number, start time, status and read time, tags in their colours, b-roll
keys, and each open comment's number beside its words. At the end come the
breakdown by category, the b-roll shot list and the numbered comments. The
PDF's links can be clicked, and every page says "Page 2 of 8".

**Markdown** comes in two shapes. **Stacked** reads like a script, one
heading per scene with its start time, status and read time; with pictures
it becomes a `.zip` with an `images` folder. **Two columns** is a table,
Visual beside Audio, that **Paste a script…** can read back in. The
**Spreadsheet** has a column each for start time, status, read time, tags,
b-roll and open comments.

Every spreadsheet — the script, the Breakdown and the B-roll shot list —
comes two ways. Pick one under **Format**:

- **Excel (.xlsx)** opens laid out and ready to read or print: columns sized
  to fit, long lines wrapped, the header row frozen with filters on it, a
  blank **Notes** column beside the scenes to write in, and a sheet each for
  the script, the comments, the breakdown and the b-roll (only the ones your
  script has). It opens in Excel, Google Sheets and Numbers.
- **CSV (.csv)** is the plain values and nothing else, for another tool to
  read. Splitpage can open a CSV of the script again.

Exports are copies to read, print or send. Opening one again brings back
its scenes only, not the tags, comment anchors or statuses a saved file
keeps. **Export again** in the File menu repeats the last format.

## The File menu

Click the **Splitpage** mark at the top left (the file icon on a phone). At
the top: where the script is saved and whether it's all saved (*All changes
saved · Markdown*; hover for the time), the **Autosave** switch and **Save a
copy…**. Below:

- **New & open**: New script, Open…, Open recent (desktop app), and Import
  (Paste a script, Google Doc link, Google Drive).
- **Share**: Collaborate…, and Servers… (with a server connected, Put this
  script on the server too).
- **Export**: Export…, and Export again.
- **This document**: Version history, Find & replace, Hide shot scenes,
  Minimise the rundown, and in the desktop app Present in browser and Use
  Chromium Speech Recognition.

Settings, Help, Tour, Set up, About, Tagging reference and Export app data
are along the bottom. An item that can't work right now says why.

### Keyboard shortcuts

| Shortcut | Does |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Save a copy… |
| <kbd>Ctrl</kbd>+<kbd>O</kbd> | Open… |
| <kbd>Ctrl</kbd>+<kbd>E</kbd> | Export… |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | Search commands… |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | Find & replace |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Undo / redo |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | New scene |
| <kbd>Alt</kbd>+<kbd>Enter</kbd> | Split the scene at the caret |
| <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> | Move the scene |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd> | Hide shot scenes |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> | Present in browser (desktop app) |
| <kbd>F1</kbd> | Help (desktop app) |
| <kbd>Ctrl</kbd>+<kbd>T</kbd> / <kbd>Ctrl</kbd>+<kbd>W</kbd> | New tab / close tab (desktop app) |
| <kbd>P</kbd> / <kbd>H</kbd> / <kbd>T</kbd> / <kbd>E</kbd> | Pen / highlighter / text / eraser (while annotating a picture) |

### Search commands

Press <kbd>Ctrl</kbd>+<kbd>K</kbd>, or click the search box in the header,
and type part of what you want: *pdf*, *gear*, *history*, *teleprompter*.
<kbd>↑</kbd> / <kbd>↓</kbd> choose, <kbd>Enter</kbd> runs, <kbd>Esc</kbd>
closes. With nothing typed, your recent commands come first, then the
tagging reference.

### Settings

**File ▸ Settings** holds your preferences on this device. None of them
change the script.

- **Appearance**: theme, 12- or 24-hour clock (used for times such as the
  save status's "Last saved … at"), whether the rundown strip starts
  small, and **Show icons on tags**.
- **Editor**: Hide shot scenes, Autosave, Fetch video thumbnails, the reading
  speed for new scripts, the writer's text size and script zoom.
- **Present**: the teleprompter's Mirror, Flip and One scene at a time.
- **You**: your name and colour, as collaborators see them. Clicking your
  name in the header opens these too.
- **Collaboration**: the server Collaborate stores scripts on, whether this
  device is signed in there, and **Sign out**.
- **Help & tips**: bring back the tagging reference, the tour and the
  desktop-app notice.
- **Data**: Export app data, Servers and Google Drive.

## On a phone

The whole app works on a phone, with the script first and scenes stacked
(visual above audio).

- **The bar at the bottom** opens **Write**, **Production**, **Gear**,
  **B-roll** and **Comments**; **Script** closes them. **File** and
  **Present** are at the top.
- **A scene's times** show on the scene you're in.
- **Accept a tag completion**: tap it (there's no <kbd>Tab</kbd>).
- **Find & replace** and **Search commands** are in the File menu.
- **Select several breakdown items**: long-press one, then tap others.
- **Move or add scenes** from a scene's **⋯** menu, or **+ Add scene** at the
  bottom.

## Desktop app

The desktop app for Windows (x64 and ARM64) is Splitpage in its own window,
with tabs, native Open and Save dialogs, and version history on disk.
Double-clicking a `.splitpage` file opens it here.

- **Follow My Voice** uses Windows' speech recognition, offline. Only one
  tab listens at a time. The status line names the microphone it's using. If
  it hears nothing, check, in Windows Settings:
  - **System ▸ Sound**: the default input is the right microphone.
  - **Privacy & security ▸ Microphone**: desktop apps may use it.
  - **Time & language ▸ Speech**: a recogniser for your language is
    installed.
- **Present in browser** (File menu, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>)
  opens a read-only teleprompter in your default browser, any browser, with
  the desktop app doing the listening. Save the script first. **Use Chromium
  Speech Recognition** opens it in Edge or Chrome to use that browser's
  recognition instead.
- **Crash recovery**: unsaved changes are kept as you type and offered back,
  tab by tab, at the next launch.
- **Closing with unsaved work** asks first. With several unsaved tabs, one
  dialog lists them all, with **Review** to go through them.

### Tabs

- <kbd>Ctrl</kbd>+<kbd>T</kbd> opens a tab, on the
  [start screen](#the-start-screen).
- <kbd>Ctrl</kbd>+<kbd>W</kbd> or a middle-click closes one.
- <kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd>
  switch tabs.
- Drag a tab out to give it its own window, into another window to move it,
  or along the bar to reorder.

Your tabs come back next time you launch Splitpage.

### Moving between the browser app and the desktop app

**File ▸ Export app data…** saves your version history, saved servers and
preferences as a `.json` file. In the desktop app, **File ▸ Import app
data…** merges one in; nothing is overwritten. Scripts themselves aren't
included (they're your files), and neither are sign-ins, PINs or API keys.

## Collaborating

**Collab** in the header, beside Write and Present (or **File ▸
Collaborate…**, or <kbd>Ctrl</kbd>+<kbd>K</kbd>, *collaborate*) shares the
script you have open. You get two links to send:

- **Can edit**: whoever opens it can change the script, comment and resolve
  comments.
- **Can comment**: whoever opens it can read the script, present it, export
  it and leave comments, but not change it.

A link opens that one script and nothing else on the server. The people you
send it to need no account, no code and nothing installed: the link opens
Splitpage in their browser, on a phone too.

**The first time**, on a script that's only on your computer:

1. Collaborate asks for your server's **owner key** (the long code the
   server was set up with, its join PIN). It's asked once per device and
   remembered there; untick **Remember on this device** on a computer that
   isn't yours.
2. It tells you what happens next: the script is stored on the server, and
   everyone edits that copy. **Save a copy…** still gives you a file any
   time.
3. **Collaborate** stores it and shows the two links. **Copy** puts one on
   the clipboard.

On a script that's already on the server, Collaborate goes straight to its
links.

**Managing the links.** Each link has **New link**, which makes a fresh
one and stops the old one working, and **Turn off**, which stops it
altogether. Both ask you to press again to confirm, because whoever is using
the old link loses it. A link that's off stays off until you press **Make a
link**. On a shared session hosted from the desktop app, the links stop
working when the session ends, and the dialog says so.

**Which server.** Collaborate uses the server in **Settings ▸
Collaboration** (built in: `https://script.bigmanonline.uk/`). If it can't
be reached, the dialog says so, with **Change the address…**. A script
already on a server stays with that server, and in the browser app opened
from a server, Collaborate uses that server. **Settings ▸ Collaboration ▸
Sign out** makes this device ask for the owner key again.

**What the people you invite see.** The script opens straight away. The
first time, a small box asks their name and colour (the same ones as
**Settings ▸ You**); **Skip** is fine. Their changes save as yours do, and
they show up in the header and on the rundown. Their browser remembers the
link, so a reload, a new tab or coming back next week gets them back in.
Things that aren't theirs to do say so in the File menu: *Your link opens
this one script* and *Only the script's owner can invite people* (which
is also what the dimmed **Collab** button says when they point at it).

If you turn their link off, they see **The owner turned off this link**.
Nothing more is saved to the server, their changes stay on their screen,
and **Save a copy…** still works.

**If the connection drops, or the tab closes.** Changes that haven't reached
the server yet are kept in the browser as they type, for any script on a
server (yours or one you were invited to). The next time that browser opens
the script (a reload, the link again, a new tab), the kept changes are merged
into whatever the server has now, both sides' edits kept, with **Undo merge**
if it's not what they wanted. Nothing is saved until they press Save. If the
link has been turned off by then, the changes open as an unsaved copy
instead, to keep with **Save a copy…**. Saving removes the kept copy; one
left unsaved is forgotten after 30 days. A private window may not keep
anything.

## Hosting a shared session

Let people on your network open and edit the same scripts. In the desktop
app, pick **Splitpage (shared session)** from the Start Menu. From a portable
copy, run:

```
node start.mjs --host --pin
```

The launcher shows the addresses to give people and a six-digit **join PIN**
they type in once. Edits to different scenes merge; if two people change the
same words, one version stays in the script and the other becomes a comment.

> Without `--pin`, anyone who can reach the address can read and edit. The
> PIN keeps out other people on the same wifi, but it isn't encryption:
> don't open a shared session to the internet.

| Launcher option | Does |
| --- | --- |
| `--pin 4821` | Use your own PIN |
| `--review-pin` | Add a comment-only address and code |
| `--allow-origin <address>` | Let another copy of Splitpage connect |
| `--port 9000` | Use another port (default 8791) |

Restarting the session cancels every code and link you handed out.

### Letting someone comment without editing

A reviewer can read the script, use the teleprompter and exports, and add
comments, but not change anything. The server enforces it.

- **One script**: open it from the server, then **File ▸ Collaborate…** and
  send the **Can comment** link. It opens only that script, and you can
  replace it or turn it off there. (A session from an older copy of
  Splitpage has **Copy review link** in **File ▸ Servers…** instead.)
- **The whole session**: start it with `--review-pin`. The launcher shows a
  second address and code that open every script for review.

### Seeing who else is here

In a shared session, coloured initials in the header show who else has the
document open, and a dot marks the scene each of them is in. Hover to see
names. Anyone without a name shows as **Guest**.

Each person also shows as a dot in their colour on the rundown, on the
scene they're working in. Hover it for their name; click it to go there.
The dot becomes an empty ring when they haven't moved or typed for about a
minute.

### Working on a server

On a server, two things appear in the File menu:

- **Put this script on the server** publishes the one you have open. Save
  then saves there.
- **Open from the server…** lists every published script.

**Collaborate…** gives you links to the script you have open (see
[Collaborating](#collaborating)). Someone who came in on a link sees these
items greyed, with *Your link opens this one script*.

If someone saved while you were typing, their version and yours are merged.
Where you both changed the same words, theirs stays and yours is kept as an
**Unmerged edit** comment. If your sign-in lapses or the page is out of date
for the server, Splitpage keeps your unsaved edits and asks you to reload.

## Connecting to a server

**File ▸ Servers…** connects this tab to a different server: someone else's
shared session, or your own machine from a laptop. You don't need it to
[collaborate](#collaborating) — Collaborate has its server built in.

- **Add a server**: a name, the address you were given, and the join PIN if
  there is one. The **PIN** button takes a server's long owner key as well
  as a six-digit PIN.
- **Use this server** switches to it; **Back to this copy** switches back.
- The host must allow your copy in with `--allow-origin` and your copy's
  address. A copy opened straight from disk can't connect: serve it first
  (see [Running it](#running-it)).

**Over SSH**: for a machine that isn't on your network, tick **Reach it over
SSH** when adding the server. Splitpage writes the `ssh` command for you,
with **Copy** and **Save a .cmd**. From a portable copy,
`node start.mjs --tunnel me@studio.example.com` opens the tunnel and the app.

## Google Drive files

**File ▸ Import ▸ Google Drive…** opens a small file manager for Google
Drive: browse, download and upload files.

- **Browser app**: works with a publicly shared folder. The first time, the
  panel walks you through making an API key (to browse) and an OAuth Client
  ID (to change anything) in the Google Cloud Console. Signing in needs the
  page served (see [Running it](#running-it)), not opened from disk.
- **Desktop app**: sign in with Google in your browser once, then browse
  your whole Drive. Uploading a file with the same name as one in the folder
  replaces it. Rename, delete and new folder are browser-only. **Sign out**
  in the panel forgets the sign-in.

**Setting up the desktop app's Google sign-in** (once per computer):

1. In the [Google Cloud Console](https://console.cloud.google.com/apis/library/drive.googleapis.com),
   pick or create a project and enable the **Google Drive API**.

2. Under **APIs & Services ▸ OAuth consent screen**, add the `…/auth/drive`
   scope, and add every Google account that will sign in as a test user.

3. Under **APIs & Services ▸ Credentials**, create an **OAuth client ID** of
   type **Desktop app** and download its JSON file.

4. Save it as `google-oauth-client.json` in the folder the Google Drive panel
   shows (on Windows, `%APPDATA%\Splitpage`). Then open the panel again.

## Installing and updating

- **Desktop app**: download `SplitpageDesktopSetup-<version>-x64.exe` (or
  `-arm64.exe` for Windows on ARM) from the
  [releases page](https://github.com/RetroGorilla/splitpage-releases/releases).
  It installs for you only, with no administrator needed. Windows may warn
  that it isn't signed: click **More info ▸ Run anyway**. If Splitpage is
  open with unsaved changes, it asks whether to save first, and Setup
  waits. If you choose **Stay**, save or close Splitpage yourself, then
  press **Retry** in Setup (or **Cancel** to install later).
- **Updates**: when there's a newer version, a bar says so. In the desktop
  app, press **Download**, then **Install and restart**. A portable copy
  doesn't update itself: **Open release page**, then unzip the new release
  over the old folder.
- **Uninstalling**: remove the desktop app in Windows' **Installed apps**. A
  portable copy is just a folder: delete it, after saving anything in its
  `data` folder you want to keep.
