# Changelog

What changed for a person using Splitpage, newest first. The same entries
appear in the app under **Help**. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions are in `VERSION`.

## Unreleased

### Added
- Nest tags while typing, or use **Edit tag** and **Done** to label words inside
  a finished tag, with category colours, enclosing outlines and undo. Nested
  production tags appear in breakdowns, Gear, shot props and exports with their
  own details. Nested tag labels are preserved through project saves, clipboard,
  undo and merge.
- Select beats like in other apps: Shift+click selects a run of beats,
  Ctrl+click (Cmd+click on a Mac) adds or removes one, and Ctrl+A outside a
  text field selects all beats.
- Ctrl+click (Cmd+click on a Mac) on a link in a beat's text opens it: in a new
  window in the browser, and in your default browser in the desktop app.
- In the writer, Ctrl+scroll changes the text size, the same setting as the
  Size slider.
- Production now opens in **Scene prep**, an outline of scenes and beats. Under
  each beat you can mark what you already have, set its status, assign it and
  add notes. The Category, Person, Beat, Shoot, CSV and Gear views are still
  there.
- **Attach** (was Add picture) links any file to a beat, such as a PDF, a
  document or a sound, next to its pictures. Pictures are still kept inside the
  script. Programs, scripts, shortcuts, macro-enabled Office files and files
  without an extension are refused.
- In the desktop app, a video or file dropped on a beat keeps its location, so it
  opens again after a restart. For a saved script, Splitpage offers to copy it
  into a "<script name> files" folder next to the script, so it still opens when
  the script and its folder move together.
- Save As asks whether to copy the script's linked files to the new location,
  with a warning when they add up to more than 250 MB. **Copy files** saves the
  script at once and copies in the background; **Hide** tucks the progress away
  while you keep working. **Don't copy the files** links the new script to the
  files where they are. A save that can't copy everything keeps what it copied
  and says so.
- Type `@` and a name in a Visual cell to give every tag in that sentence an
  owner. The name becomes a chip; deleting the chip removes the owner. New names
  are added to People. Chips don't appear in the teleprompter or any export.
- Follow My Voice can listen on a microphone you choose, in the teleprompter and
  in Settings, in Chrome, Edge and the desktop app, including Present in Browser
  from the desktop app. The choice is remembered;
  if it isn't connected, the default is used and the status says so.
- Tags can be chosen from a compact menu above the Visual text toolbar, with the
  typing shortcut shown beside each category.
- Export can save a Splitpage script (.splitpage). In the desktop app it can
  also include the script's files as one .zip: the script plus its
  "<script name> files" folder, with every link pointing into that folder.
  Files that are missing, linked from elsewhere on the computer, or of a type
  Splitpage doesn't attach are left out, and the export says how many.
- While you type a keyword tag such as `prop:`, Splitpage suggests a matching
  name already in that category. Tab or a click on the hint uses the existing
  entry. Esc dismisses the suggestion so Tab makes a new tag.
- Attaching a file to a saved script in the desktop app now offers **Move it**
  as well as **Copy it** and **Leave it where it is**. Move puts the file in the
  script's folder: a rename on the same drive, otherwise a checked copy and then
  the original is deleted. It keeps both copies when the original is in use or
  changed. A path link whose file has moved into the script's folder still
  opens.
- Create a bundle of a script's linked files after its first save, from the
  outside-files bar, or from **File ▸ Create bundle…**. Old document paths are
  copied, and files added in this session can be moved.
- B-roll and Comments can be grouped by scene, with each panel remembering its
  choice.
- Scene headings can be created and renamed in place: Enter saves, Esc cancels,
  clicking away saves, and a brief animation respects reduced motion.

### Changed
- Show a subtle category-coloured underline when a visual tag is awaiting its
  name.
- Group Shoot view beats by scene in a responsive grid with filmed and current
  indicators.
- Printed shot list: the Notes handwriting lines are now 8 mm apart (they were
  about 4 mm), so there is room to write on them.
- Desktop updates now verify the installer's release name, tag, API digest and
  size before allowing installation.
- **Hide filmed beats** is now a switch beside the filmed count, the rundown has
  a labelled **Minimise rundown** / **Show rundown** control, and **Present in
  browser…** sits in a dropdown beside Present. All three left the File menu,
  and Use Chromium Speech Recognition is gone.
- The File menu is tidier: **Create bundle…** sits under **Save a copy…**, the
  bottom has full-width **Settings** and **Help** rows, and Help opens User guide,
  Take the tour, Getting started…, Tagging reference and About Splitpage.
  **Export app data…** and **Import app data…** now live only in **Settings ▸ Data**.
- After a Save As, the new script starts with no undo history.
- The Production Panel labels an unnamed scene "Scene A" (its scene letter)
  instead of "Untitled scene".
- Production and Gear items are grouped by scene, with separate remembered
  choices for each panel.
- The Export dialog says to use **File ▸ Create bundle…** first when files
  outside the script's folder would be left out.
- Export with the script's files: a confirmed Replace now overwrites the
  existing .zip. The zip is still written to a temporary file first, so a
  cancelled or failed export leaves the old one as it was.
- The merge review shows both folders when a video sits in different folders
  and says which one is kept. A copy beside the script is now always kept over
  a path on one computer.
- Scene headers in the editor look like headings, with quieter controls that
  appear when needed.
- Clicking a beat in the Rundown scrolls the script there with a short, smooth
  scroll (or jumps, if you prefer reduced motion). The Rundown's magnifier
  keeps the beat under the pointer steady and every beat reachable, also with
  the keyboard and while dragging.
- The desktop Open dialog starts in the folder where you last saved a script.
- The writer is new and types like a word processor. Beats flow together inside
  paragraphs: Enter starts a beat, Enter again starts a paragraph, and
  Shift+Enter is a line break. You can select, type over, delete, cut and paste
  across beats, and each edit is one Ctrl+Z. Every beat has a small number. The
  caret's beat shows its visual beside the line, and **Visual** edits it in a
  small box. `# ` starts a scene header, and `**bold**`, `*italic*` and
  `~~strike~~` convert as you type. Joining two beats that both have visuals
  now keeps both. The old writer and its Visuals, Numbers and Compact button are
  gone. Older scripts get their paragraphs once, by sentence, the first time
  they open in the writer. See [The writer](docs/help.md#the-writer).
- The teleprompter also starts a paragraph at each paragraph break from the
  writer.
- New words throughout the app. A section is now a **scene**, and a scene is now
  a **beat**. As a status, Shot is now **Filmed** and To shoot is **To film**.
  Scene mode in Present is now **Beat mode**.
- Numbering follows the new words. Scenes are lettered A to Z, then AA, AB and
  so on. Beats restart in each scene, as in `B.8`, and B-roll shots follow tag
  order, as in `B.8.2`. The number beside each beat in the editor drops the dot,
  as in `B8`. Beats before the first header are in an automatic, unnamed Scene
  A. Numbers shift when you move beats or scenes. Saved scripts keep their
  contents; old files open as they are.
- Beat lists in Production and the Shoot view are grouped by scene: the letter
  appears once, followed by that scene's beat numbers. Dotted numbers elsewhere
  sit tighter around the dot.
- Excel columns are now `Beat` and `Beats`. Images in exported Markdown are
  named like `images/beat-A-3.jpg`; old `images/scene-N` names still import.
- Status markers are colour coded: Needed is hollow, Sourcing is yellow and
  Have it is green, in light and dark.
- Scene headers scale with the script zoom in the editor and with the Size
  slider in the writer.
- **Tag** with the cursor in the Visual column now opens the category menu right
  after or inside a word, and no space is added. In the Audio column, a link or
  another tag, it says why it can't start one.
- A video link whose thumbnail didn't download gets another try when you click
  its beat.
- Resizing the window with a script open does less work: the rundown strip moves
  its blocks and ruler instead of rebuilding them on every resize step.

### Fixed
- Production, Scene prep: renaming an item whose detail is open keeps the detail
  open and focus on the item.
- Production and Gear By-scene views no longer rescan the document's scene
  numbering on every render.
- A cut that finished late can no longer delete beats from a different script
  opened, merged or saved under a new name in the meantime.
- Copying whole beats from the writer into Split keeps their visuals, pictures,
  status, comments and scene headers.
- Edit > Undo and Redo now work in the script whenever the keyboard shortcuts
  do.
- The merge review now says what really happens to a beat that one side edited
  and the other deleted.
- Each key typed restyles much less of the page.
- The automatic Scene A at the top of a script can now be named: **Add a name**
  on its header turns it into a normal scene you can rename, move or fold.
- Naming a scene no longer covers the header or the whole beat. The name box has
  a set length, and the letter, beat count and run time stay visible.
- The comments panel's filter and sort dropdowns follow dark mode.
- Move up and Move down in a beat's menu ask before removing a one-beat scene's
  header, as Alt+Up and Alt+Down already did.
- Selecting across a folded scene no longer includes its hidden beats, so Delete
  can't remove beats you can't see.
- A link with an incomplete address now shows a warning in the desktop app too,
  when you Ctrl+click or Cmd+click it.
- Ctrl+press or Cmd+press on a link no longer changes your beat selection or
  starts a beat drag. The link opens only if you let go on it.
- Formatting or pasting while a tag is open no longer ends the tag: Tab still
  makes it, and text you formatted stays formatted. A paste with several lines
  cancels the open tag and keeps all the text.
- Cancelling a tag with nothing typed no longer adds an extra undo step.
- Naming yourself in a comment or reply box now sets your name everywhere at
  once: the name chip and your colour update straight away, and the name stays
  for every script.
- The open-tag highlight covers the first word of the tag again.
- A stalled Save As in one script no longer blocks Undo and Redo in a script
  opened afterward.
- A video link you removed stays removed when another editor only changed its
  thumbnail.
- Old scripts with an embedded picture show that picture in the beat again,
  instead of an empty Attach button.

## 0.4.1 — 2026-11-02

This release removes collaboration and server documents and fixes several
saving bugs. If you open or share scripts on a Splitpage server, read
**Removed** before you upgrade.

Version numbers restart here: 0.4.1 follows 3.1 and the 4.0 beta. Those copies
won't offer it as an update, so download it from the
[releases page](https://github.com/RetroGorilla/splitpage/releases). Older
release tags were renamed to match, such as `v3.1.0` to `v0.3.1`; the headings
below keep the numbers those releases shipped with.

### Added
- Downloads and update checks now use the Splitpage repository releases page.
- Named section dividers group scenes, fold for the current session and move
  as a group. Add one with **Add Section Header** in a scene's **⋯** menu. Section cues appear in the rundown and Present; print, PDF,
  Word and Markdown exports retain headings and section totals.
- First save through a desktop dialog or browser file picker names an untouched
  untitled script from the filename. A trailing version such as `v3` becomes a
  small tag beside the title. Typed titles are preserved; Save a copy updates
  only the tag while the title is still file-derived. Download-only browsers
  leave title and tag unchanged.
- With nothing selected in a Visual cell, **Tag** opens the existing label
  dialog with just its categories. Choose one to start an open tag at the
  cursor, then type its name as with a typed keyword. Escape or clicking
  outside dismisses the dialog without an edit; selected-text tagging is
  unchanged.
- Present: Ctrl+F opens Find above the script. Matches are highlighted, and
  Enter and Shift+Enter jump between them while playback stays paused.
- Pressing Tab straight after a tag keyword typed before existing words tags
  the rest of that line, stopping before an existing tag or link.
- Pasted text links lose known tracking parameters and keep their other
  parameters. Links with a recognised signature parameter are left alone.
- App-data export: when some history or images can't be read, **Export the
  rest anyway** exports what is readable and says how much was left out.

### Removed
- Collaboration and server documents are gone: live collaboration,
  presence, invite, share and review links, server bookmarks and PINs,
  saving and opening documents on a Splitpage server, hosting from the
  desktop app, and Google Drive. A Splitpage server now only serves the app.
  It does not read, change or delete the scripts a 3.1 or 4.0 server
  stored, but this version cannot open them. Before you upgrade, open each
  server script in your current version and save it to a file. Drafts and
  sessions that pointed at a server document open as unsaved local
  documents with their content intact. Collaboration will come back,
  rebuilt, in a later release.
- **Save to file** is gone, in the File menu and the desktop menu bar.
  Opening a `.docx`, `.txt`, `.csv` or other Markdown file now starts a
  separate script that is not saved yet, like a new script: Save asks where
  to keep it, and Splitpage never writes to the file you opened. Use
  **File ▸ Export…** to make a Word, CSV or other file.

### Fixed
- Desktop: a save now reaches the disk before it replaces the old file, so
  a power cut during a save can no longer leave an empty script.
- A save that reached the file is no longer reported as failed when reading
  the file's time afterwards fails, and the next save no longer sees a
  false "changed on disk".
- When the browser withdraws permission to a file, saving it now fails with
  an error and keeps your work instead of showing a conflict, and saving
  again once you grant permission works.
- Crash recovery that paused because the script could not be copied now
  starts again with your next change, and its notice closes once a copy
  works.
- Settings keeps keyboard focus after **Show the desktop-app notice
  again**, so Escape still closes it.
- Draft recovery keeps scenes and unsaved text when an older file has missing
  ids, and row ids stay the same when a file loads.
- Damaged history entries no longer hide intact snapshots or stop new backups,
  and History reports how many could not be listed.
- App-data exports keep intact history and images when a snapshot is damaged,
  cancel by default when stored data can't be read, and say what a partial
  export left out.
- Undo and redo after a crew merge keep removed people removed and restore item
  assignments correctly. Undo notices no longer count item owners who were
  already missing from the crew.
- Cancelling an IME composition after undoing its own update no longer leaves
  cancelled text in redo.
- Desktop: quitting checks for edits made in another window while a question or
  a draft copy was pending, before it discards drafts.
- Desktop: reviewing a script whose file is missing or unreadable at close now
  explains the problem and how to save a copy.
- On macOS, a window reopened after closing the last window saves its layout
  again.
- Update checks refuse untrusted release links and downloads, and cancel
  installation safely if the download is cleared.
- Toasts announce their messages and have a keyboard-accessible dismiss button
  that returns focus. They avoid repeating refusals, and stay visible with
  dialogs in fullscreen Present. A repeated warning comes back to the front for
  a full display time without being announced twice.
- Redraw recovery keeps focus in Writer, length editors keep their row
  highlight, and first-run setup waits for the screen to be ready.
- The tour waits for open pages and dialogs, app-data pickers wait for dialogs
  and the tour, and page focus stays with the overlay in front.
- Closing About returns keyboard focus, and the next Escape reaches the active
  view.
- Gear rename drafts keep their text and cursor when script edits refresh the
  panel.
- Pasting a gallery picture loads its image, or warns when the picture can't be
  copied.
- **Tag** on a selection that includes an existing tag now explains why it can't
  label it, and leaves the text and tags unchanged. It used to label a later
  plain copy of the words instead.

### Changed
- Export format cards put file extensions beneath the name, so B-roll shot list
  stays on one line, and its Format selector says **PDF**.
- Printed PDFs keep each table row on one page.
- In a browser, PDF exports now open the print dialog. Choose **Save as PDF**
  to save the script, a gear or prop packing list, or the B-roll shot list.
- The rundown's hover lens eases in and out instead of jumping.

## 4.0.0-beta.1 — 2026-10-16

This is the 4.0 beta. 4.0 rebuilds how Splitpage is put together and adds no new feature. Your 3.1
scripts, `.splitpage` and Markdown files and shared-script servers work as
before, and a 4.0 app and a 3.1 server work with each other either way.

### Changed
- A shared-script server now refuses a document whose state is not an object
  (400 `bad-state` when creating or saving, 409 `no-state` for a comment) and
  cuts names, comment quotes and titles by whole characters, not by UTF-16
  units. Nothing else in the server differs from 3.1.

### Fixed
- Saving and switching scripts: a save that failed or was cancelled after you
  opened another script no longer changes that script's revision, and a save
  that finishes after you reopen the same script no longer marks the reopened
  one saved. Retry, Overwrite and Save a copy on the save-error banner, and
  saving from the teleprompter, now wait for a save that is still writing
  instead of starting a second one.
- A save to a server now keeps to the server and sign-in it started with.
  Pointing the tab at another server, or a changed sign-in, part-way through
  no longer sends the rest of that save there. A publish that finishes after
  you have moved the tab to another server, or after your sign-in changed,
  now says so instead of saying nothing or claiming you opened another script.
- A paste, drop, thumbnail or annotation that finishes after you opened
  another script, or reopened the same one, is no longer written into it.
  A paste or drop says the picture was not added. A delayed paste puts its
  text where the paste began, not where the caret has since moved.
- Restoring a version from history, or a draft, after the script was
  replaced no longer overwrites the newer one. A draft restored onto a file
  that has not changed since is no longer written to the file by autosave
  before you save. A late draft write for the previous script no longer
  deletes the current script's draft, and a Google Drive list that arrives
  after you close the dialog no longer redraws it.
- Exports are built from the script as it was when you chose them: edits, or
  a changed clock setting, while an export is being prepared no longer change
  it, and an edit made while a file is being written back is no longer
  counted as written.
- A file or server copy whose top level is not a script is treated as no
  document, and a damaged or hand-edited file no longer stops a script
  opening or merging: scenes, comments, people, tags and shots stored as
  lists are dropped, names and reply times of the wrong type are ignored, and
  a merge no longer saves its revision as blank.
- If drawing the screen fails part-way, the previous picture stays instead of
  a mix of old and new scenes.
- Editing next to an emoji no longer splits it: no cell edit leaves half of
  one, and tag and person names cut at their length limit no longer keep half
  an emoji or end in a space. Titles and notes are cut by whole characters too.
- A cancelled IME composition, and typing a letter then deleting it, no
  longer leave an empty step in Undo. Ctrl+Z during a composition that is then
  cancelled no longer drops real typing.
- In review mode the writer refuses every edit with "Viewing only", and a
  split or join in the writer refreshes the Production and B-roll panels.
- At 1440 px with a long title focused, the search button and the identity
  chip no longer overlap.
- A tag name of only invisible characters is refused. Deleting a person
  clears them as owner of their b-roll shots at once, not at the next load.
  Gear quick add and tag suggestions handle names such as `constructor`.
  Drawing the b-roll badge no longer creates or renames shots; they are made
  when you create them.
- Pasting deeply nested formatting around many links can no longer produce a
  huge result: the extra markup is capped, and past the cap repeated
  formatting is kept once and the inner links are unwrapped.
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
  is, and Find & replace while Present is; Save to file, Put this script on
  the server, Present in Browser (Ctrl+Shift+P), Use Chromium Speech
  Recognition and each File ▸ Export format while a dialog or the command
  menu is.
- In the desktop app, a menu-bar command that opens a dialog opened it
  underneath the tour, or on top of a dialog that was already open. About
  Splitpage, Settings…, Servers…, Collaborate…, Paste a script…, Import from
  Google Doc link…, Google Drive files…, Open from the server…, Set up
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

### For maintainers
- The source moved from one set of numbered modules to owned folders:
  `src/core` (document, text, merge and production rules), `src/application`
  (session, commands, saving, recovery), `src/adapters`, `src/features`, and
  `src/bootstrap`, which wires them at startup. Milestones 0 to 7 of
  `docs/IMPLEMENTATION-PLAN.md` are closed; the composition root as build
  entry, the remaining bridges and the `S` fields are 4.x work. Building and
  testing need Node 24.22.0 (`.nvmrc`).

### Remaining legacy code

4.0 does not remove the old startup code; it fences it in.

- **The legacy initializer shim** is `src/js/_entry.js` (170 lines). It calls
  `wireApp` with dependencies it imports from the numbered modules, then starts
  **69 of the 79 numbered modules** in `src/js/`. The other ten (`03c`, `14c`,
  `14d`, `14e`, `22a` to `22f`) load only as imports. Its import list is frozen
  at 72 specifiers by `tests/bootstrap/legacy-shim.test.ts` and may only shrink.
- **23 bridge files** remain in `src/legacy/` (1,452 lines). Numbered modules
  import them 106 times from 57 files; `_entry.js` imports none of them.
- **Owner:** every bridge is owned by the integration owner until the 4.x
  bridge work (plan section 8, item 2), which removes each bridge together
  with the legacy modules that keep it.

| Bridge file | Lines | Kept alive by |
| --- | --- | --- |
| `richtext.ts` | 60 | the editor and format modules still in `src/js/` |
| `session-bridge.ts` | 218 | every numbered module that edits or reads the session |
| `transition-bridge.ts` | 89 | open, new, restore and publish callers in `src/js/` |
| `app-actions.ts` | 43 | numbered modules invoking actions by id |
| `document-ports.ts` | 42 | state entry and format modules (`02`, `02b`, `03`, `07`, `14b`, `14c`, `15`) |
| `plain-text.ts` | 7 | `08c`, `14b`, `14c`, `15`, `18a`, `19` |
| `save-bridge.ts` | 108 | `03`, `12`, `13`, `14`, `18` |
| `export-formats.ts` | 28 | `14e`, `18`, `18c`, `18d` |
| `review-wording.ts` | 1 | `05h`, `06`, `13`, `19` |
| `cache-freeze.ts` | 18 | `05f`, `07`, `14b` |
| `recovery-bridge.ts` | 86 | `03`, `20g` |
| `tour-pause.ts` | 18 | `20c`, `20e` |
| `screen.ts` | 69 | `18d` and the action bridges |
| `screen-state.ts` | 26 | the action bridges |
| `undo-adapter.ts` | 27 | `12a-undo.js` |
| `menu-items.ts` | 21 | the share actions |
| `file-actions.ts`, `help-actions.ts`, `share-actions.ts`, `this-document-actions.ts`, `view-actions.ts`, `zoom-actions.ts`, `native-menu.ts` | 99, 121, 166, 55, 82, 20, 48 | action definitions that call numbered modules |

Also still legacy: one runtime import cycle of 46 modules and 310 edges, three
modules that assign the global `S` (`00-prelude.js`, `02b-doc-id.js`,
`03-sync.js`), and 514 recorded dependency exceptions in
`tools/dep-baseline.json` (`npm run check:deps`: 0 new, 0 resolved).

Measured at `7b7b430`.

## 3.1.0 — 2026-09-29

### Added
- **Collaborate.** **Collab** in the header (or **File ▸ Collaborate…**)
  puts the script on your server and gives you a Can edit and a Can comment
  link. Each opens that one script only, needs no account, and can be
  renewed or turned off.
- Unsaved changes to a script on a server are kept in the browser and
  merged back in when it is next opened, so a closed tab or dropped
  connection no longer loses them.
- **Draw on your pictures.** In a scene's gallery, **Annotate** marks up a
  picture with a pen, a highlighter, text and an eraser (P, H, T and E pick
  them). The marks stay editable, and **Remove annotations** gives you the
  original back.
- **Export to Excel.** File ▸ Export… ▸ **Spreadsheet** makes an Excel
  workbook: sized columns, wrapped text, a frozen header with filters, a
  Notes column to write in, and a sheet for each part. **CSV** is the second
  choice on the same card, and the Breakdown and the B-roll shot list offer
  both.

### Changed
- An empty scene (no words, pictures, set length or comments) deletes with
  one click on **⋯ ▸ Delete**; any other scene still asks for a second click.
- Search commands (Ctrl+K) puts the tagging reference first, and searching
  *tags* finds it.
- The writer's tools are at the top, under the title, where the script's
  formatting bar is, and **Close** is beside **Save**.
- The tagging reference lists every word form (`Prop:`, `Location:` or
  `Loc:`, `Cast:`, `VFX:`, `Gear:`, `SFX:` or `Music:`), each in its tag
  colour, beside the bracket shortcuts.
- **About Splitpage** is a dialog in the app's own look, and no longer shows
  command-line instructions in a browser alert.
- The "get the desktop app" notice and start-screen line show only in a
  Windows browser, not on phones, Macs or Linux.
- The bottom button and several messages say "scene" where they said "row".
- Failure messages say what to check ("the connection failed — check that
  you are online") instead of the browser's own wording, and Google Drive
  errors say what to do.
- Messages read "Could not …" throughout, and menu text uses one spelling
  ("Minimise the rundown").

### Removed
- Version history from 2.x is no longer converted. Coming straight from
  2.x, install 3.0 first to keep it.

### Fixed
- Text typed while a script is publishing is no longer marked saved before
  it reaches the server; it is saved right after.
- Opening another script while one is publishing no longer attaches it to
  the published server copy.
- **Save As** on a shared script makes a copy without marking the shared
  script saved.
- **Save to** an opened CSV, Word or text file no longer says "up to date"
  when you typed more while it was saving.
- A malformed request can no longer stop a shared-script server.
- The Help contents list no longer shows raw backticks around code in a
  heading.
- The browser tab shows the script's name ("Keepwarm Mug — Splitpage"), so
  several open at once can be told apart.
- The link, video, import, Google Doc, Drive folder and tag name boxes are
  labelled for screen readers.
- The "×" on the update and desktop-app notices is an icon in the notice's
  colours, readable in both themes.
- Shorter, clearer wording in the setup wizard, the Import dialog and the
  Export dialog's b-roll message.

## 3.0.0 — 2026-09-26

### Added
- **A new look.** Calmer dark and light themes, a running order of the whole
  script under the header, each scene's status as a lamp, and side panels
  that open beside the script instead of over it.
- **A start screen for every new tab:** a blank script, three starter
  scripts, a long demo that shows off every feature, recent documents and a
  drop zone for a file.
- **One undo for everything:** typing, tags, scene moves, statuses, pictures,
  comments and Production changes.
- **Stage directions** (`((beat))`) and **sound cues** (`SFX:` / `Music:`) in
  the Audio column.
- **Timing:** a target length for the piece, or a scene's length by hand.
- **Several pictures and videos per scene,** with YouTube, Vimeo and dropped
  video files playing in the gallery; click a picture to see it full size.
- **Settings in one place,** script zoom (Ctrl + wheel), Search commands
  (Ctrl+K) and one Export dialog (Ctrl+E).
- **A B-roll panel built for the shoot,** with prop statuses and a full-page
  shot list.
- **Exports that match the app:** the PDF and Word script carry each scene's
  status, timecode and read time, tags in their colours, numbered comments,
  the breakdown and a b-roll shot list; Markdown and spreadsheets gain the
  same, and the packing list has sign-off lines.
- **Merging a word at a time:** two people's edits to one scene combine
  unless they changed the same words.
- **Plain-language tags:** type `VFX:` or `Prop:` in the Visual column and
  press Tab.
- **Tag every mention at once:** find a word (Ctrl+F), then **Tag all as…**.
- **Whole scenes:** drag out of a text box to select scenes, then copy, cut,
  paste or delete them, comments and pictures included.
- **The rundown** magnifies the scenes under the pointer, shows the script's
  length, and shows where other people are working.
- **In the desktop app:** Follow My Voice through Windows' own speech
  recognition, Google Drive, and a server connection per tab.

## Before 3.0.0

3.0.0-beta.1 to beta.8 were pre-releases of the 3.0 work above.
