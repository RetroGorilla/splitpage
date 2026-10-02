# Changelog

What changed for a person using Splitpage, newest first. The same entries
appear in the app under **Help**. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions are in `VERSION`.

## Unreleased

### Fixed
- In the desktop app, some menu-bar commands ran behind an open dialog, the
  writer or Present. They now stop and say what to close first: Save and
  Save As… (Ctrl+S, Ctrl+Shift+S) while a dialog or the command menu is
  open; Open… (Ctrl+O) and Export… while either of those, the writer or
  Present is; Find & replace while a dialog or the writer is; Hide shot
  scenes (Ctrl+Alt+H) while a dialog is. Search Commands… already stopped
  under a dialog, the writer, Present or the tour, and now says why too.
- Ctrl+Z right after opening writer mode closes writer instead of undoing a
  change hidden behind it in the split view. Ctrl+Shift+Z brings writer back.
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
