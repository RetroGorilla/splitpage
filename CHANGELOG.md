# Changelog

What changed for a person using Splitpage, newest first. The same entries
appear in the app under **Help**. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions are in `VERSION`.

## 4.0.0 — 2026-10-16

4.0 rebuilds how Splitpage is put together and adds no new feature. Your 3.1
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
