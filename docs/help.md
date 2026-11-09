# Splitpage

Splitpage is a two-column script editor for video: what the viewer sees on
the left, what gets said on the right. It has a teleprompter, comments, and a
production breakdown that tracks every prop, location, VFX shot and person in
the script.

Scripts save as plain Markdown (`.md`) you can open anywhere, or as
`.splitpage` files. Splitpage runs in a browser or as a
[desktop app](#desktop-app) for Windows.

## What's new since 0.4.1

These changes are on development `main`, with 0.4.3 being prepared. The published
release is still 0.4.1. The instructions below describe the current app.

- **Scenes, beats and filmed.** Scene headers group beats; beats restart at 1
  in each lettered scene. The status is now **Filmed**, and Present uses
  **Beat mode** and **Skip filmed**.
- **Flowing writer.** Write narration across beats as one document. Enter
  starts a beat, Enter again starts a paragraph, and Shift+Enter adds a line
  break. Whole-beat copying preserves visuals, pictures and comments.
- **Scene prep** in Production shows each scene's beats and requirements.
  **By scene** groups Production, Gear, B-roll and Comments under scene headers.
- **Attach** adds pictures, videos and other supported files. In the desktop
  app, Copy / Move / Leave controls where local files live; **Create bundle…**
  gathers outside files beside the script. Export a Splitpage script with its
  files as a zip. See [Pictures and video](#pictures-and-video) and
  [Exporting](#exporting).
- **Save a copy** can copy bundled files or keep links to their old locations.
  A successful Save a copy to a picked file resets Undo; cancellation does not.
- **Complete tag names**: type `Prop: ca` and press Tab to accept an existing
  matching name. Esc dismisses the suggestion so you can keep your own words.
- An underline at the caret shows when a tag is waiting for its name.
- **Nested tags**: type a bracket tag inside an open keyword tag, or use
  **Edit tag** and **Done** to label words inside a finished tag. Each label
  keeps its category colour and production details. See [Nested tags](#nested-tags).
- **Controls where you need them**: Hide filmed beats sits beside the filmed
  count; the rundown has Minimise rundown / Show rundown; the dropdown beside
  Present opens Present in browser… in the desktop app. File has full-width
  Settings and Help rows, with a Help submenu.
- **Shoot** groups each location's beats under scene headings, with filmed and
  current indicators. Scene prep keeps an item's detail open after renaming it.
- Printed shot-list Notes lines are now 8 mm apart for handwriting, and desktop
  updates verify the installer's release name, tag, API digest and size.
- **Assign as you write**: an `@Name` chip assigns tags in its sentence to that
  person. See [Assigning with @Name](#assigning-with-name).
- **Choose a microphone** in Present, including when the desktop app does the
  listening for a browser teleprompter.
- Naming yourself in a comment or reply updates your name and colour everywhere
  and remembers the name for every script. Scene headers can be named in place,
  including the automatic Scene A.
- Formatting and pasting preserve an open tag; late cuts and saves stay with
  their original script, and removed video links stay removed after another
  editor changes only the thumbnail.

## What's new in 0.4.1

Historical names below: this release called beats “scenes” and scene headers
“sections”. Current instructions use the newer names.

- **New version numbers.** 0.4.1 follows 3.1 and the 4.0 beta. Those copies
  won't offer it as an update, so download it from the
  [releases page](https://github.com/RetroGorilla/splitpage/releases).
- Downloads and update checks now use the Splitpage repository releases page.
- **A title from your first filename.** Save an untouched untitled script as
  `Headset ad v3.md` and it becomes **Headset ad**, with a small **v3** tag.
  A title you typed stays yours. Download-only browsers leave both unchanged.
- **Section headers** group scenes without changing their running order.
  Open a scene's **⋯** menu and choose **Add Section Header** to name a
  section. Its header shows the scene count and total time, including shot
  scenes. Click the name to rename it; the ⋯ menu moves or removes the header.
  Drag the grip to move the whole section, or drag a scene across a header
  to change its section. The fold chevron hides scenes for this session only;
  folding changes neither the saved file nor the running order.
  Section names appear above rundown blocks and in Present's top bar as
  visual cues. They are never spoken or used by Follow My Voice. Print/PDF,
  full-script Word and Markdown exports retain headings and totals and include
  every scene, including folded ones. Narration Word keeps heading cues;
  plain narration text omits section headings. CSV/XLSX keep their existing columns.
  At the start of a scene after a header, press Backspace once to show
  “Press Backspace again to remove the section header”. Press it again
  within two seconds, without another key, click or caret move, to remove
  only the header. The scenes join the section above, or become unsectioned
  at the top. A further Backspace joins scenes normally. Delete at the end
  of the preceding scene works the same way. Other input, a caret move or
  waiting two seconds cancels the hint. Undo restores the header and its
  name in one step.
  - If <kbd>Alt</kbd>+<kbd>↑</kbd> or <kbd>Alt</kbd>+<kbd>↓</kbd> would move a
    section's only scene across its header, the first press changes nothing
    and shows “Press again to remove the section header”. Repeat the same
    shortcut within two seconds, without another non-modifier key, click or caret move,
    to move the scene and remove the emptied header. Undo restores both.
    Releasing and pressing Alt again does not cancel the hint; the same
    confirmation also applies when Shift is held with the shortcut.

- **Start a tag at the cursor.** With nothing selected in a Visual cell,
  press **Tag** and choose a category, then type its name. The same dialog
  shows just its categories; selecting existing words still opens the full
  label dialog.
- **Collaboration and server scripts are gone for now.** Live
  collaboration, invite and share links, opening and saving scripts on a
  Splitpage server, hosting from the desktop app, and Google Drive are
  removed. A draft of a server script opens as an unsaved script with its
  text intact; save it to a file. Collaboration will come back, rebuilt,
  in a later release.
- **Safer saving.** In the desktop app a save reaches the disk before it
  replaces the old file, so a power cut can no longer leave an empty
  script. A save that worked is no longer reported as failed, and the next
  save no longer sees a false "changed on disk". If the browser withdraws
  permission to a file, saving says so and keeps your work.
- **Save to file is gone.** Opening a `.docx`, `.txt`, `.csv` or other
  Markdown file starts a separate script that is not saved yet; Save asks
  where to keep it, and Splitpage never writes to the file you opened. Use
  **File ▸ Export…** to make a Word, CSV or other file.
- **Crash recovery starts again** with your next change after it paused.
- Settings keeps keyboard focus after **Show the desktop-app notice
  again**, and the rundown's hover lens eases in and out.
- **Find in Present.** Press <kbd>Ctrl</kbd>+<kbd>F</kbd> in Present to search
  the script. Matches are highlighted, and <kbd>Enter</kbd> and
  <kbd>Shift</kbd>+<kbd>Enter</kbd> jump between them while playback stays
  paused.
- **Tagging before existing words.** Type a keyword such as `VFX:` at the front
  of a line and press <kbd>Tab</kbd> to tag the rest of the line. **Tag** refuses
  a selection that includes an existing tag and tells you why.
- **Cleaner pasted links.** Pasted text links lose known tracking parameters.
  Links with a recognised signature parameter are left alone.
- **Damaged history.** History still lists intact snapshots and tells you how
  many damaged ones it couldn't list. If an app-data export can't read some
  history or images, it cancels and downloads nothing. When the failure isn't a
  temporary one and readable history remains, **Export the rest anyway** exports
  that and says how much was left out.
- Toasts have a keyboard-accessible **Dismiss** button, and a repeated warning
  comes back to the front. Closing **About** returns keyboard focus to where you
  were. Undo after a crew merge and draft recovery of older files are also more
  reliable.

## What's new in the 4.0 beta

- **No new features; sturdier saving.** 4.0 rebuilds the inside of
  Splitpage. Your 3.1 scripts and files open as before.
- **Saving and switching scripts is safer.** A save, paste, drop,
  thumbnail, annotation, history restore or draft restore that finishes after
  you opened or reopened another script no longer lands in it. A failed save
  no longer changes the next script's revision, and saves to one place wait
  for each other. A paste or drop that was too late says the picture was not
  added.
- **Exports are built from the script as you chose them.** Edits made while an
  export is prepared no longer change it.
- **Damaged files open or merge instead of failing.** A file whose top level is
  not a script counts as no document; odd scenes, comments, people, tags,
  shots and reply times are dropped or ignored.
- **Editing.** No edit leaves half an emoji; names cut at their limit keep
  whole characters. A cancelled IME composition leaves no empty Undo step.
  A split or join in the writer refreshes Production and B-roll. If drawing the screen fails,
  the previous picture stays.
- **Production.** A tag name of only invisible characters is refused. Deleting
  a person clears them as owner of their b-roll shots at once. Gear quick add
  and tag suggestions handle names such as `constructor`. Drawing the b-roll
  badge no longer creates or renames shots.
- **Pasting deeply nested formatting around many links** can no longer
  produce a huge result.
- At 1440 px with a long title focused, the search button and the identity
  chip no longer overlap.
- In the desktop app, some menu-bar commands ran behind an open dialog, the
  writer or Present. They now stop and say what to close first: Save and
  Save As… (Ctrl+S, Ctrl+Shift+S) while a dialog or the command menu is
  open; Open… (Ctrl+O) and Export… while either of those, the writer or
  Present is; Find & replace while a dialog or the writer is; Hide shot
  scenes (Ctrl+Alt+H) while a dialog is. Search Commands… already stopped
  under a dialog, the writer, Present or the tour, and now says why too.
- In the desktop app, more menu-bar commands ran behind the writer, Present,
  the B-roll shot list page or the tour. They now stop and say what to close
  first: Present, Write, Production (Ctrl+Alt+P), Gear, Comments
  (Ctrl+Alt+C) and Version history… while a dialog, the command menu, the
  writer, Present, the shot list or the tour is open (Present and Write not
  for themselves); Open… (Ctrl+O), Export… (Ctrl+E), Search Commands…
  (Ctrl+K) and Find & replace (Ctrl+F) also while the shot list or the tour
  is, and Find & replace while Present is; Save to file, Present in Browser (Ctrl+Shift+P), Use Chromium Speech
  Recognition and each File ▸ Export format while a dialog or the command
  menu is.
- In the desktop app, a menu-bar command that opens a dialog opened it
  underneath the tour, or on top of a dialog that was already open. About
  Splitpage, Settings…, Paste a script…, Import from Google Doc link…, Set up
  Splitpage… and Tagging reference now stop and say what to close first while
  the tour or a dialog is open. User guide… (F1) still opens during the
  tour, but not over another dialog.
- Ctrl+Z right after opening writer mode closes writer instead of undoing a
  change hidden behind it in the split view. Ctrl+Shift+Z brings writer back.
- Merging two versions of a script could drop, duplicate or keep a deleted
  scene, comment, crew member, breakdown entry or b-roll shot whose id was a
  special word such as `constructor` or `__proto__`, and could blank a
  scene's text. Only a hand-edited or damaged file has such ids. They now
  merge like any other, and files that have them open unchanged.
- A scene, comment or person whose id was a special word such as
  `constructor` also tripped up undo, Hide shot scenes, comments, Find and
  the Production panel: undoing the delete of such a scene could fail, and
  such a shot scene never hid. They now behave like any other.
- When a merge found that you and someone else had both added the same
  person, the production items and b-roll shots you had given that person
  came out unassigned. They now keep that person as their owner.
- Commenting a b-roll key's line no longer moves the comment off the key or
  gives the shot a new id.
- Words marked as both a comment and a production tag or b-roll key in one
  piece of markup, as a script or paste from elsewhere can carry them, kept
  the tag or key but lost the comment's highlight, leaving its card "No
  longer in script". Both are now kept.
- A comment on a stage direction or a sound cue, in a script or paste that
  carries both marks on the same words in one piece of markup, kept the
  comment but lost the direction or cue mark. Both are now kept.
- Markdown export wrote `[text](null)` for a link with no address. It now
  writes the text alone.
- Deleting one SFX: or Music: cue and editing another in the same cell at
  once could hand the deleted cue's Production item, with its status and
  notes, to the edited cue, and leave the edited cue's own item "Not in
  script". The edited cue now keeps its own item when its new words are
  close to its old ones and to no other cue that went. When that can't be
  told, it gets a new item at Needed and both old items stay, "Not in
  script", rather than the wrong one being renamed.
- Fixed: when one edit to a cell's sound cues lost a cue, added another and
  changed a third, the changed cue's item could be renamed to the wrong name.
  Cues are now matched to their old names by how alike they are, and when
  that is unclear they get a new item instead. Find-and-replace across
  several cues in one cell no longer renames their items.
- Saving while a script was still opening, with **Save** in the header or in
  the desktop app's menu bar (Ctrl+S), did nothing and reported an error in
  the background. It now says "Still loading…", as the File menu's commands
  already did.
- In Present, Ctrl+F, Ctrl+M, Alt+F and the like flipped or mirrored the
  text, and Ctrl, Cmd or Alt with Space still played or paused it. M, F and
  Space now do nothing in Present while Ctrl, Cmd or Alt is held, none of
  Present's keys act while you type in a field such as the Find box, and
  pressing M or F with the caret still in a script cell no longer types the
  letter into it.
- An emoji no longer breaks in two when a tag name cut inside it is tagged
  with "Tag all mentions", or when text is pasted, cut or split at a
  position inside it.
- Pasted or imported text with a link inside another link could lose text
  the next time it was saved, merged or pasted. The inner link now keeps its
  own address and the outer link continues around it, as when you set a link
  inside a link in the editor, and a video card inside a link stays a card.

## What's new in 3.1

- **Collaborate.** **Collab** in the header (or **File ▸ Collaborate…**)
  puts the script on your server and gives you two links to send: one to
  edit, one to comment. A link opens that one script, needs no account, and
  can be renewed or turned off.
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
- **Saving you can trust.** Text typed while a save is still going stays
  marked unsaved until it is saved, instead of being called saved.
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
  length at its end.
- **In the desktop app**: Follow My Voice through Windows' own speech
  recognition.

Release notes for every version are on the
[releases page](https://github.com/RetroGorilla/splitpage/releases).

## Getting started

- **Getting started.** The first time you open a fresh copy, a short
  introduction explains the file formats and installing the desktop app, then
  offers the tour. **File ▸ Help ▸ Getting started…** reopens it any time; it
  changes no settings and never changes your script.
- **The tour.** **File ▸ Help ▸ Take the tour** walks through five things to
  know, each with a **Read more** link into this guide.
- **User guide.** **File ▸ Help ▸ User guide** opens this guide
  (<kbd>F1</kbd> in the desktop app).

### The start screen

A new tab opens on a start screen rather than a document. The browser app
shows it too, on a fresh copy nothing has been opened in.

- **Blank script**: one empty beat.
- **Starter scripts**: **To-camera video**, **Interview** and **30-second
  spot**. Each opens as a new, unsaved script to write over.
- **Open a file**, or drop a `.md`, `.splitpage`, `.docx`, `.txt` or `.csv`
  file anywhere on the page. The drop zone's links paste a script or import a
  Google Doc link.
- **Recent** (desktop app): the last 20 documents you had open. Click one to
  reopen it; **×** takes it off the list, **Clear recent** empties it.
  **Continue** at the top reopens the most recent.
- **Take the tour**, or **Look at the example script** (or <kbd>Esc</kbd>)
  to close the start screen and see the demo script.
- **Open the long demo (30 beats)**: a whole video, nearly ten minutes
  long, with every feature in use (all three beat statuses, every tag
  category, b-roll, comments, stage directions, set read times and a target
  length), to see how Splitpage handles a real-length script. Like a
  starter, it opens as a new, unsaved copy. The command menu
  (<kbd>Ctrl</kbd>+<kbd>K</kbd>) opens it too, keeping the script you had in
  Version history.

## Running it

**Desktop app**: install it from the
[releases page](https://github.com/RetroGorilla/splitpage/releases)
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

Scenes contain beats. Scene letters continue after Z as AA, AB and so on. Beats restart at 1 within each scene: **B.8** is beat 8 in Scene B, shown as **B8** beside the beat in the editor. B-roll shots follow tag order within a beat: **B.8.2** is its second shot. Beats before the first header belong to an automatic, unnamed Scene A. Moving scenes, beats or tags updates their numbers; plain-text references in notes and comments must be updated by hand. **Remove scene header** keeps its beats in the previous scene (or automatic Scene A at the top), and supports Undo.

**Scene headers**: choose **Add Scene Header** in a beat's **⋯** menu. Click a
header's name to edit it, or **Add a name** on automatic Scene A. The letter,
beat count and time stay visible while naming. Drag its grip to move the scene;
its chevron folds beats for this session. Folding changes neither the file nor
exports, and selecting across a folded scene leaves its hidden beats alone.
At a header boundary, Backspace or Delete first asks you to press again within
two seconds to remove only the header. The same confirmation protects a
one-beat scene when moving its beat across the header. Undo restores the header.


Each beat is a row: **Visual** on the left, **Audio** on the right.

- **Format text**: select words and use the toolbar: bold
  (<kbd>Ctrl</kbd>+<kbd>B</kbd>), italic (<kbd>Ctrl</kbd>+<kbd>I</kbd>),
  underline (<kbd>Ctrl</kbd>+<kbd>U</kbd>), strikethrough, highlight, link,
  comment and tag.
- **New beat**: <kbd>Ctrl</kbd>+<kbd>Enter</kbd> starts the next beat and
  moves into it.
- **Split a beat**: <kbd>Alt</kbd>+<kbd>Enter</kbd> moves everything after
  the caret into a new beat below, in the same column.
- **Move a beat**: <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>Alt</kbd>+<kbd>↓</kbd>,
  or drag it by its number. The beat's **⋯** menu also has **Move up**,
  **Move down**, **Insert beat**, **Add Scene Header** and **Delete**. **Delete** asks for a
  second click, unless the beat is empty (no words, pictures, set length
  or comments): then one click does it. <kbd>Ctrl</kbd>+<kbd>Z</kbd> brings
  a deleted beat back.
- **The rundown**: the strip under the header shows every beat as a block.
  Hover it to magnify the beats round the pointer, click a block to jump
  to that beat, or drop a
  dragged beat on it to move the beat. **Minimise rundown**, at the strip's
  right edge, shrinks it to a thin strip; **Show rundown**, or a click
  anywhere on the strip, brings it back.
- **The header's buttons**: **Production**, **Gear**, **B-roll** and
  **Comments** open their panels; **Write** and **Present** are the two other
  ways to see it. In a narrower window the panel buttons shrink to their icons
  and counts, and Write to its icon. Point at one,
  or <kbd>Tab</kbd> to it, and its name slides out over its neighbours.
- **Beat status**: click the lamp in the beat's gutter to cycle **To do →
  Ready → Filmed**.
- **Hide filmed beats**: the switch beside the filmed count in the header
  (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd>) collapses Filmed beats into a
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

Splitpage estimates each beat's read time from its Audio words, at the
script's reading speed. Visual notes, stage directions and sound cues don't
count.

- **Script length**: the small time at the end of the rundown, just after
  the last beat (at the strip's right edge on a long script, and at the
  right of the status line on a phone). With shot beats hidden it reads
  what's left / the whole script. It stays on the minimized rundown.
- **Reading speed**: click the script length. It's saved with the script.
- **A beat's length by hand**, for a montage, a title card or a pause: click
  the beat's time in the **Read** column, type `1:30`, `90`, `90s` or
  `1m30`, and press <kbd>Enter</kbd>. Clear it and press <kbd>Enter</kbd> to
  go back to the estimate. It turns amber if the words would take longer.
- **Target length**: click the script length and pick or type a **Target
  length** (or search commands for *target*). The length then reads
  *4:32 / 5:00 · 0:28 left*, or how far over in red. **No target** removes
  it.

### Whole beats

- **Select**: click in a text box and drag up or down past its edge. The
  page scrolls at the window's edge. <kbd>Esc</kbd> or a click lets go.
- <kbd>Ctrl</kbd>+<kbd>C</kbd> copies, <kbd>Ctrl</kbd>+<kbd>X</kbd> cuts,
  <kbd>Delete</kbd> removes. Right-click for the same, plus **New script
  from these beats** (it replaces this tab's script; the old one goes to
  Version history).
- **Paste** with the caret in any script, in another tab or the desktop app
  too: the beats go in after that beat, or replace it if it's empty, with
  their comments, status, b-roll, breakdown details and pictures (up to
  16 MB of pictures per copy). One <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes it.
- **Into Word or Google Docs** they paste as a two-column table.

### The writer

**Write** in the header opens the Audio column as one flowing document that
types like a word processor, for when the job is writing narration. A
paragraph holds one or more beats running together, and a small number marks
each beat. Its tools sit along the top, under the title, and **Close** (or
<kbd>Esc</kbd>) is beside **Save**.

- <kbd>Enter</kbd> starts a new beat, <kbd>Enter</kbd> again starts a new
  paragraph, and <kbd>Shift</kbd>+<kbd>Enter</kbd> is a line break.
- Select, type over, delete and use the arrow keys across beats as in any
  document. Each edit is one <kbd>Ctrl</kbd>+<kbd>Z</kbd>. A notice says when
  whole beats were removed, and those beats take their visuals with them.
- <kbd>Backspace</kbd> at the start of a paragraph removes the paragraph break.
  Just after a beat's number it deletes a character and leaves the beats apart.
- Click a beat's number for a menu: **Join Back**, **Join Next** and
  **Add Visual**. <kbd>Alt</kbd>+<kbd>Backspace</kbd> also joins a beat to the
  one before. If both have visuals, the joined beat keeps both.
- <kbd>Alt</kbd>+<kbd>Up</kbd> and <kbd>Alt</kbd>+<kbd>Down</kbd> move the
  beat with the caret.
- The caret's beat shows its visual as a note beside the line. Click the note
  or press **Visual** to edit it in a small box. Add pictures in the split view.
  A beat with a visual and no narration shows as a chip in the text, and typing
  on it adds narration.
- Type `# ` at the start of a paragraph for a scene header, which takes effect
  when the caret leaves the line. `**bold**`, `*italic*` and `~~strike~~`
  convert as you type, and <kbd>Ctrl</kbd>+<kbd>Z</kbd> straight after gives you
  the characters back.
- Bold, italic, underline, strikethrough and highlight work across beats. Tags,
  links and comments stay within one beat.
- Cut, copy and paste keep a whole beat's visual, comments, status, b-roll and
  pictures.
- **Size** sets the text size for you on this device, not in the script.

Scripts from before this writer get their paragraphs once, the first time they
open in it: a beat starts a paragraph when the beat before it ended a sentence.

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
  sort by **Script order**, **Most recent** or **By scene**. Unplaced threads
  follow the scene groups under **No scene**.
- Your name in a comment or reply is remembered for every script; changing it
  updates the identity chip and your colour immediately.

### Pictures and video

- **Attach** under a beat's Visual text picks pictures, videos and other
  supported files, including PDFs, audio and documents. You can also drop or
  paste them there. Unsupported files, including macro-enabled Office files,
  are refused.
- **Paste or drop** a picture, a video file or a video link (YouTube, Vimeo
  and the like) into a beat and it goes into that beat's Image section,
  with **Undo** on the notice. The words you pasted with it stay in the text.
- **Several per beat**: the first is the cover, the next ones sit beside
  it, and **+N** stands for the rest. Videos are also listed underneath.
- **The gallery**: click any tile. Use **‹ ›** or <kbd>←</kbd>
  <kbd>→</kbd> to browse, <kbd>Shift</kbd>+<kbd>←</kbd> /
  <kbd>→</kbd> or drag to reorder, **Make cover**, **Remove**
  (<kbd>Delete</kbd>), and <kbd>Esc</kbd> to close.
- **See a picture at full size**: click the big picture in the gallery
  (or press <kbd>Enter</kbd> on it). A large picture opens fitted to the
  window; click it or scroll to see it at 100 %, and drag to look around.
  <kbd>←</kbd> <kbd>→</kbd> go through the beat's pictures, and
  <kbd>Esc</kbd>, **×** or a click outside goes back to the gallery.
- **Draw on a picture**: pick it in the gallery and press **Annotate**.
  See [Annotating a picture](#annotating-a-picture).
- **Watch a video**: press **▶** in the gallery. YouTube and Vimeo links
  play there, and so does a video file dropped since you opened the script.
  Anything else opens with **Open link** / **Open file**.
- **Local files after reopening**: the desktop app remembers their location
  and opens them with **Open file**. Keep the script's bundled files folder
  beside it when moving or sending it. Browsers cannot reopen a saved local
  path; add the file again for this session. Pictures are saved inside the
  project and do not need the original file.
- **Video thumbnails**: pasting a YouTube or Vimeo link fetches its
  thumbnail. If it failed, clicking the beat tries again. Turn fetching off in
  **Settings ▸ Fetch video thumbnails**.
- **Comments** can carry a picture too: the image button in the comment
  box.

A saved file carries all its pictures. One that can't be found shows as
**Image unavailable**; the rest of the script is fine.

### Annotating a picture

Circle the thing that matters, highlight a corner, or write a note right on
a picture. Open the beat's gallery, pick the picture and press
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

The beat shows the picture with your marks everywhere: the script, the
exports and the teleprompter. The original is kept, so **Edit annotations**
opens your marks again to change them, and **Remove annotations** puts the
picture back as it was. Saving is one step of the script's undo, so
<kbd>Ctrl</kbd>+<kbd>Z</kbd> afterwards takes it back too.

### Presenting

**Present** in the header opens the teleprompter. In the desktop app, the
dropdown beside it offers **Present ▸ Present in browser…** to open a read-only
teleprompter in your default browser, with the desktop app doing the listening.
Save the script first. This replaces the old Chromium speech-recognition option.

- <kbd>Space</kbd> plays and pauses, <kbd>↑</kbd> / <kbd>↓</kbd> change the
  speed, and <kbd>Esc</kbd> closes it.
- **Follow My Voice** scrolls as you read aloud.
- **Microphone** chooses the input on supported browsers and in the Windows
  desktop app. The choice is remembered on this device. When browser recognition
  cannot select an input, use the browser or system default. A disconnected
  choice is reported; pick it again or select another input.
- **Mirror** (<kbd>M</kbd>) and **Flip** (<kbd>F</kbd>) are for a
  beam-splitter or an upside-down monitor.
- **Skip filmed** leaves out beats marked Filmed.
- **Beat mode** plays one beat at a time and pauses at its end. The arrows
  (or <kbd>←</kbd> / <kbd>→</kbd>) step between beats.

In the desktop app, Follow My Voice uses Windows' speech recognition; see
[Desktop app](#desktop-app).

### Getting the narration out

**File ▸ Export… ▸ Narration only** writes the Audio column as `.docx` or
`.txt`, one paragraph per beat; the `.docx` puts each beat's number in the
margin, so a session can pick up "from 14". **Include stage directions** puts them in as
*(beat)*. Sound cues are never in it. **Paste a script…** reads that shape back in.

## Tagging and the production breakdown

Tag things in the script and they appear in the **Production** panel, with
every beat they're in. While you type a tag you've used before,
<kbd>Tab</kbd> accepts the completion Splitpage offers.

**The tagging reference**: **File ▸ Help ▸ Tagging reference** (or search commands
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

You can also put the caret in the Visual column with nothing selected and
press **Tag**. A compact category menu above the toolbar shows the typing
shortcut beside each category. Click a category to start the same open tag at
your saved caret. <kbd>Esc</kbd> or a click outside closes the menu without
changing the script. With selected words, choosing a category labels those words.
To type inside a finished tag, open it with **Edit tag** first.

- <kbd>Tab</kbd> (on a phone, tap the note under the box) makes them one
  tag.
- When a matching name already exists in that category, a completion appears
  beside the caret. <kbd>Tab</kbd> fills and tags it in one step. <kbd>Esc</kbd>
  first dismisses the completion; keep typing a new name, or press
  <kbd>Esc</kbd> again to cancel the open tag.
- <kbd>Esc</kbd> cancels and leaves the plain text.
- <kbd>Enter</kbd> or leaving the cell ends the open tag as plain text;
  <kbd>Enter</kbd> also inserts a line break.
- <kbd>Ctrl</kbd>+<kbd>Z</kbd> after <kbd>Tab</kbd> takes the tag off and
  leaves your words as you typed them.

### Nested tags

One tag can contain another. In Visual text or the writer's Visual box, type
`SFX: rain on [umbrella]` and press <kbd>Tab</kbd>. The brackets finish the
inner Prop tag **umbrella**; Tab finishes the outer Music/SFX tag **rain on
umbrella**. The outer tag stays open while you finish the inner one. You can
also use location `{park}`, VFX `~glow~` and gear `<camera>` brackets inside
an open keyword tag. A second keyword such as `VFX:` inside that draft stays
ordinary text; use brackets there, or finish the outer tag and use Edit tag
to add another label.

If an inner name completion appears, <kbd>Tab</kbd> accepts it first; press
<kbd>Tab</kbd> again to finish the outer tag. On a phone, tap the completion
and the note for the open tag instead.

To label words inside a finished tag, click or tap it and choose **Edit tag**.
Only that occurrence opens for editing. Select its inner words and use **Tag**
and a category, or place the caret inside and type a bracket or keyword tag.
**Done** protects the occurrence again. <kbd>Esc</kbd> first dismisses any
suggestion, then cancels an unfinished tag, then acts like Done. Clicking
outside the cell also finishes editing. Edits are undoable; opening an occurrence
does not rename its production item or open its other occurrences.

Each label keeps its own category colour; an enclosing tag has an outline
around its children. Each also has its own status, owner and notes in the
breakdown, Gear, shot props and exports where that category applies. Saves,
clipboard, Undo and merge retain the nesting. Tags must fit completely inside
one another; a selection that crosses a tag boundary is refused. Editor Find
and replace still skips tagged words.

### The Production panel

**The Production panel** offers **Scene prep**, **Category**, **Person**,
**Beat**, **Shoot** and **By scene**. Category and Person show a table:
**Item · Status · Beats · Owner**. Click a beat number to jump to it.

- **Open an item**: click its name in the panel. Clicking a tag in the script
  offers **Edit tag** for that occurrence. Set the item's
  **Status**, **Assigned to** (**Add person** adds a name), and **Notes &
  links**. **⋯** has **Rename** and **Remove label** / **Delete from list**.
- **Status**: **Needed → Sourcing → Have it → Returned**. Click the status to
  step it on. "Returned" also means finished with, for a location or VFX
  shot.
- **Several at once**: <kbd>Ctrl</kbd>+click items (<kbd>Shift</kbd>+click
  for a run) to assign, set status or delete them together. Deleting removes
  their tags from the script too; the words stay. <kbd>Esc</kbd> clears the
  selection.
- **Group** by category, person, beat or scene, or **Shoot** to see beats grouped
  by location, then scene, with what each needs. Shoot's beat cells wrap to fit
  the panel; filmed beats have a fill and tick, and the current beat has its own
  outline. Its count reads, for example, **7 of 18 filmed**, beside the duration.
- **Untagged mentions**: write the name of something already tracked in
  the Visual column without tagging it, and it gets a dotted underline and a
  **Tag** offer. <kbd>Tab</kbd> takes it, <kbd>Esc</kbd> waves it off.
  To tag them all at once, open the item and press **Tag all N mentions**.
- **Not in script**: deleting a tag from the script keeps the item, flagged,
  until you delete it.
- **Export** it with the panel's **CSV** button, or File ▸ Export… ▸
  Breakdown. PDF, Word and Markdown exports include the breakdown too.

### Scene prep and scene grouping

**Scene prep** opens a scene-and-beat outline in Production. Expand a scene and
beat to see its tagged requirements, change status or owner, or open an item's
notes. Renaming an item with its detail open keeps the detail open and focus on
the item. The ready button marks an item **Have it**; already-ready requirements
can be expanded separately. Filmed beats can be shown again from the outline.

**By scene** is also available in Production, Gear, B-roll and Comments. Each
scene appears in script order, including automatic Scene A when present.
Production and Gear list an item once in every scene that mentions it. These
are the same items: changing one updates its other appearances. Entries without
a current beat follow under **No scene**. Grouping is remembered separately for
each panel on this device and changes no script data or export order.

### Assigning with @Name

In Visual text, including the writer's Visual box, type `@` and choose a person.
Type to filter, use the arrow keys to choose, and press <kbd>Tab</kbd> or
<kbd>Enter</kbd>; <kbd>Esc</kbd> leaves the typed text alone. The list can add a
new person too. The chip assigns production tags in that sentence to the person;
it is an assignment, not a notification. A B-roll line can use the same chip
for its owner. The chip stays out of narration and read-time estimates.

### Gear

**Gear** in the header lists equipment: cameras, mics, lights. Gear that's
never written in the script goes in the **Add gear** box at the foot of the
panel, one item per line; press **Update list**. **List**, **Beat** or **By scene**
changes the view. **Packing list** prints a checklist with a box for going
out and one for coming back, and lines to sign.

### B-roll

Start a line in the **Visual** column with `B-roll:` and it becomes a shot
on the **B-roll** list. Lines under it, up to the next marker, are its
description.

- **Mark a shot done**: tick its box.
- **Filter** with **All / To film / Flagged / Filmed**, and group by beat,
  scene or location, or choose **Not grouped**.
- **Open a shot** to set its location, who's getting it, its props, a note,
  or **Flag for reshoot**. **⋯** has **Rename in script** and **Delete from
  list**.
- **Props**: a prop tagged in a shot's lines counts for it. Add others with
  **Add prop**.
- **Several at once**: <kbd>Ctrl</kbd>+click or <kbd>Shift</kbd>+click shots,
  then mark, assign, move or flag them together.
- **Add a shot** at the foot of the panel for one the script doesn't have.
- **The shot list**: the arrows button beside the panel's **×** opens every
  shot on one page, grouped by location, beat or person, with **CSV** and
  **Print shot list**, which prints it as you see it there. **← Script** or
  <kbd>Esc</kbd> goes back.

## Saving your script

**Save** (<kbd>Ctrl</kbd>+<kbd>S</kbd>) writes the script to a file. The
first Save asks where, and in which format:

- **Markdown (`.md`)**, the default: a readable table of beats, then the
  breakdown and comments, then a block Splitpage keeps for itself (tags,
  comment anchors, pictures, statuses). Leave that block alone.
- **Splitpage (`.splitpage`)**: the same information without the readable
  table.

On the first save through the desktop dialog or a browser file picker, an
untouched untitled script takes its title from the chosen filename without
the extension. A trailing `v3` or `V3` (any number), separated by a space,
underscore or hyphen, becomes a small `v3` tag beside the title, leaving the
separator out of the title. Names such as `Rev2` and `Headsetv3` stay whole
without a tag. Splitpage never invents or increments a version. Both the title and
tag survive reopening a `.md` or `.splitpage` project.

A title you typed is never replaced. While the title still comes from a
filename, Save a copy updates the tag from the new name, or removes it when
there is no version; it keeps the title. Once you edit the title, Save a
copy leaves both title and tag alone. Undo reverses automatic naming as one
change and keeps the chosen file as the save destination.

**Download-only browsers: no change; the app never sees the final name.**
There is no extra filename prompt.

**Save a copy…** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>) writes a new
file. With a desktop dialog or browser file picker, that new file becomes the
destination for later saves; the original stays on disk. Saving the copy to a
file you chose in that dialog clears Undo and Redo. Cancelling or failing keeps
the original destination and history. In browsers that save by downloading,
Save a copy downloads a file and keeps Undo and Redo; it cannot choose a new
destination for later saves.

In the desktop app, if the script has bundled files, **Copy files** puts them
beside the new script. **Don't copy the files** links the new script to their old
locations instead, so sending the new script alone will not send those files.
That choice is unavailable when the old files are on a network share. **Cancel**
stops the save. Missing files or different files with the same names in the new
folder can block copying; Splitpage reports the problem instead of overwriting
them. After the first save of a script with outside files, **Create bundle?**
offers to gather them beside it.

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
- **Not saving** when something is in the way: the file changed on disk or a
  write failed.

Hover it for where and when ("Last saved to script.md at 2:52 PM") or what
to do. The writer shows the same status.

### If you edit the `.md` somewhere else

You can. Edit a cell in the table, save, and reopen it in Splitpage: your
edit is kept, and tracked names in it are tagged again. A comment on words
you rewrote loses its place. If you add or delete whole rows, Splitpage asks
whether to keep its own record or rebuild the beats from your table.

If the file changes on disk while it's open here, Save offers **Merge
them**, with a side-by-side view before anything is written. Where both
versions changed the same words, the file's version goes in the script and
yours is kept as an **Unmerged edit** comment.

### Sending it to someone

- **Nothing installed?** **File ▸ Export… ▸ SplitShare** writes one `.html`
  file with the script and the whole app in it. It opens in any browser, on
  any device, with nothing to install, and they can read, edit and present
  it. It's a copy: their edits stay in their file.

## Reopening a saved project

- **File ▸ Open…** (<kbd>Ctrl</kbd>+<kbd>O</kbd>) opens a `.md` or
  `.splitpage` file with everything back: beats, tags, comments, pictures.
- **A `.docx`, `.txt`, `.csv` or other Markdown file** opens as a new
  script, with an empty breakdown and no comments. It is not saved yet, like
  a new script: Save asks where to keep it, and Splitpage never changes the
  file you opened. For a Word, CSV or other file of it, use **File ▸ Export…**.
- **A revised draft of the script you're in**: use **File ▸ Import ▸ Paste a
  script…** instead. It replaces or appends the beats and keeps this
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
  (a row per beat, as Excel or CSV), or **SplitShare** (the script with the
  whole app built in, for any device), or **Splitpage script** (a copy of the
  .splitpage file).
- **Part of it**: **Narration only**, the **Breakdown** as a spreadsheet, a
  **Packing list** of gear or props, or the **B-roll shot list**: a
  landscape table of every shot with its beat, props, flags and their
  reasons, and handwriting lines 8 mm apart for notes (or the same as a
  spreadsheet).

**Sending a script with its files.** In the desktop app, pick **Splitpage
script** and turn on **Include the script's files, as one .zip**. Splitpage
shows how many files that is and how big, then writes one .zip with the script
and its "<script name> files" folder. Whoever unzips it can open the script and
every file in that folder, wherever they unzip it. Only files in the script's
folder go in: files that are missing, linked from elsewhere on your computer,
or of a type Splitpage doesn't attach are left out, and Splitpage tells you how
many. To include files outside the folder, use **File ▸ Create bundle…** first.
You can keep working while it exports, hide the progress, or press
**Cancel**, which leaves no new zip and preserves an existing zip selected for
replacement. A confirmed **Replace** overwrites that chosen zip on success.
In the browser, the card exports the
script on its own.

**PDF** and **Word** lay the script out the way the app does: the running
time and target at the top (the PDF shades filmed rows grey), each beat's
number, start time, status and read time, tags in their colours, b-roll
keys, and each open comment's number beside its words. At the end come the
breakdown by category, the b-roll shot list and the numbered comments. The
PDF's links can be clicked, and pages carry a title and page numbers.

In a **browser**, PDF, gear/prop packing lists and the PDF B-roll shot list
open a print page and the browser's **print dialog**. Choose **Save as PDF**
there, then choose where to save it. Allow pop-ups for Splitpage if asked.
There is no automatic PDF download; cancelling the dialog leaves your script
and its save status alone. The print page closes after the dialog finishes;
if your browser leaves it open, close it when you are done. Pages use your
computer's fonts, including the languages those fonts support. The browser
chooses page breaks, without a continued-row label, and supplies no PDF
bookmarks.

The **desktop app** still saves a PDF file directly, with bookmarks to its
scenes. It prints the same page as the browser, so it also uses your
computer's fonts and lets the page breaks fall where they fit.

**Markdown** comes in two shapes. **Stacked** reads like a script, one
heading per beat with its start time, status and read time; with pictures
it becomes a `.zip` with an `images` folder. **Two columns** is a table,
Visual beside Audio, that **Paste a script…** can read back in. The
**Spreadsheet** has a column each for start time, status, read time, tags,
b-roll and open comments.

Every spreadsheet — the script, the Breakdown and the B-roll shot list —
comes two ways. Pick one under **Format**:

- **Excel (.xlsx)** opens laid out and ready to read or print: columns sized
  to fit, long lines wrapped, the header row frozen with filters on it, a
  blank **Notes** column beside the beats to write in, and a sheet each for
  the script, the comments, the breakdown and the b-roll (only the ones your
  script has). It opens in Excel, Google Sheets and Numbers.
- **CSV (.csv)** is the plain values and nothing else, for another tool to
  read. Splitpage can open a CSV of the script again.

Exports are copies to read, print or send. Opening one again brings back
its beats only, not the tags, comment anchors or statuses a saved file
keeps. **Export again** in the File menu repeats the last format.

## The File menu

Click the **Splitpage** mark at the top left (the file icon on a phone). At
the top: where the script is saved and whether it's all saved (*All changes
saved · Markdown*; hover for the time), the **Autosave** switch, **Save a
copy…** and, in the desktop app, **Create bundle…**. Then **Search
commands…**, and below it:

- **New & open**: New script, Open…, Open recent (desktop app), and Import
  (Paste a script, Google Doc link).
- **Export**: Export…, Export again, and Export narration.
- **This document**: Version history… and Find & replace.

Two full-width rows along the bottom: **Settings**, and **Help**, which opens User
guide, Take the tour, Getting started…, Tagging reference and About
Splitpage. Export and Import app data live in **Settings ▸ Data**. Hide filmed
beats, Minimise rundown and Present in browser are beside their header controls.
An item that can't work right now says why.

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
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | New beat |
| <kbd>Alt</kbd>+<kbd>Enter</kbd> | Split the beat at the caret |
| <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> | Move the beat |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd> | Hide filmed beats |
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
- **Editor**: Hide filmed beats, Autosave, Fetch video thumbnails, the reading
  speed for new scripts, the writer's text size and script zoom.
- **Present**: the teleprompter's Mirror, Flip and One beat at a time.
- **You**: your name and colour, which sign your edits and comments.
  Clicking your name in the header opens these too.
- **Help & tips**: bring back the tagging reference, the tour and the
  desktop-app notice.
- **Data**: Export app data…, and in the desktop app Import app data….

## On a phone

The whole app works on a phone, with the script first and beats stacked
(visual above audio).

- **The bar at the bottom** opens **Write**, **Production**, **Gear**,
  **B-roll** and **Comments**; **Script** closes them. **File** and
  **Present** are at the top.
- **A beat's times** show on the beat you're in.
- **Accept a tag completion**: tap it (there's no <kbd>Tab</kbd>).
- **Find & replace** and **Search commands** are in the File menu.
- **Select several breakdown items**: long-press one, then tap others.
- **Move or add beats** from a beat's **⋯** menu, or **+ Add beat** at the
  bottom.

## Desktop app

The desktop app for Windows (x64 and ARM64) is Splitpage in its own window,
with tabs, native Open and Save dialogs, and version history on disk.
Double-clicking a `.splitpage` file opens it here.

- **Follow My Voice** uses Windows' speech recognition, offline. Only one
  tab listens at a time. Present's microphone selector chooses a Windows input
  or **System default**. The choice is remembered on this device; changing it
  while listening restarts recognition. The status line names the microphone. If
  it hears nothing, check, in Windows Settings:
  - **System ▸ Sound**: the default input is the right microphone.
  - **Privacy & security ▸ Microphone**: desktop apps may use it.
  - **Time & language ▸ Speech**: a recogniser for your language is
    installed.
- **Present in browser…** (the menu beside Present,
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) opens a read-only
  teleprompter in your default browser, any browser, with the desktop app
  doing the listening. Save the script first. The desktop relay's microphone
  selector lists the desktop app's Windows inputs, not the browser's
  microphones.
- **Crash recovery**: unsaved changes are kept as you type and offered back,
  tab by tab, at the next launch.
- **Closing with unsaved work** asks first. With several unsaved tabs, one
  dialog lists them all, with **Review** to go through them.
- **Attaching a file** to a saved script (dropping, pasting or picking a video
  or other file on a beat) asks whether to **Copy it** (the default), **Move
  it**, or **Leave it where it is**. Copy and Move put the file in a
  "<script name> files" folder next to the script, so it opens wherever the
  script goes. Move takes it out of where it was, so other scripts that link it
  there lose it. Leave keeps the link to where the file is now. Move is offered
  only for a file you added since Splitpage started.
- **Files outside the script's folder**: when a script links files outside its
  "<script name> files" folder, a bar across the top says how many. **Create
  bundle…** copies them into that folder, or moves the ones you added this
  session, so they open wherever the script goes. The × hides the bar until you
  open the script again. **File ▸ Create bundle…** does the same at any time.
- **Copy or Move failures** keep links to the original location. Move renames
  on the same drive where possible; otherwise it checks the copy before removing
  the original. If the original changed or cannot be removed, both files are
  kept and a notice explains why. Undoing an attach
  removes its script link, not files already copied or moved on disk.

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

**Settings ▸ Data ▸ Export app data…** saves your version history and
preferences as a `.json` file. In the desktop app, **Settings ▸ Data ▸ Import
app data…** merges one in; nothing is overwritten. Scripts themselves aren't
included (they're your files).

## Installing and updating

- **Desktop app**: download `SplitpageDesktopSetup-<version>-x64.exe` (or
  `-arm64.exe` for Windows on ARM) from the
  [releases page](https://github.com/RetroGorilla/splitpage/releases).
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
