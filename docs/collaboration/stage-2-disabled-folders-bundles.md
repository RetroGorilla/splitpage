# Shared sessions, the script's folder and file bundles

Package 13 detaches the work that copies or moves files beside the script through
`CapabilityPort`. `SHARED_SESSION_DISABLED` already declares both reasons: "Local
folders cannot be attached to a shared session." and "File bundles are not
available in a shared session." The plan (section 7) gives the rule: a shared
instance has no script folder, so copying or moving a file beside the script and
Create bundle are unavailable there. The running app still creates standalone
sessions; every check answers allowed there and behaviour is as before.

Every bundle and folder call to the desktop goes through the gallery feature
(`video-bundles.ts` and `create-bundle.ts`); the wiring only hands the desktop
functions on. The guards sit there and follow the lifetime rule in
[Shared sessions and local file saving](stage-2-disabled-file-saving.md#session-and-save-lifetimes).

## Where each step refuses

| Step | Entry | In a shared session | Shown |
| --- | --- | --- | --- |
| Copy or move a dropped or picked file into the script's folder | `offerAfterDrop` | `folders`: no prompt; the file is linked where it is, as for a script not saved to disk | Nothing |
| Copy or Move answered on that prompt | `answer` | `folders` asked again: nothing is copied or moved | Warning toast |
| A copy that finishes after the session became shared | `copied` | `folders` (or `bundles` for Create bundle): the live link is not changed; the copy is on disk beside the original, and the copy notice still says so | Copy notice only |
| A move that finishes after the session became shared | `copied` | The link follows the moved file, because the original no longer exists | Move notice |
| Automatic inspection on open and after the first save | `inspect` | `bundles`: no plan, no automatic relink of paths already in the folder, the outside bar stays hidden | Nothing |
| Create bundle from the File menu or the outside bar | `inspect` | `bundles`, at entry and again after the plan | Warning toast |
| Copy or Move answered in the Create bundle dialog | `answer` | `bundles` asked again: nothing is copied or moved | Warning toast |
| The Export dialog's line about the script's files | `exportPlan` | `bundles`: no plan, so no line | Nothing |
| Export with files (`.splitpage` with "Include the script's files") | `exportWithFiles` | `bundles`, at entry, after the plan and after the save dialog: nothing is written | Warning toast |

Assumed rule (for the plan review): a copy already running when the session becomes
shared finishes on disk, but the shared document keeps linking the original. A move
that already finished is followed, because the original no longer exists.

There is no folder watcher; a file is only found at save, open or an explicit
action.

## Limits

- Save As carrying the script's files to a new folder (`beginSave`, `ask`,
  `onCarry`) is not guarded here. A shared session refuses Save As at its entry
  (`saveDestinations`); a standalone Save As captured before the session became
  shared keeps its permission and finishes, carry included, so the standalone copy
  keeps its files. The carry notices change no link.
- Opening a bundled file (`openBundled`) and opening a linked path are reads and
  are not guarded. A shared tab has no script folder for the desktop to look in.
- Attaching a file still stores its location in the document. Per-device
  locations (plan section 7) are later work.
- The File menu enables Create bundle from the script's home, not from the
  capability; if it is offered in a shared session, choosing it shows the reason.
- The plain `.splitpage` export, and every other export, are unchanged.
- A zip export already being written when the session becomes shared still lands
  where the person picked.

## Inventory

`standalone-folder-bundle-callers.test.ts` lists, by declaration, every caller of the
desktop's bundle and folder functions, the feature's ports for them and the mount
entries the wiring hands on, using the scan's `references` mode. A new caller fails
the table and names its file.

Two deliberate defects for this area are in `tests/collab/disable-list-mutants.json`,
each listed in `tests/collab/mutants.md` with the test that fails.
