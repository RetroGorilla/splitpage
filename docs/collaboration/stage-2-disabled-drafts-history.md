# Shared sessions, drafts and version history

Package 13 detaches crash drafts and version history through `CapabilityPort`.
`SHARED_SESSION_DISABLED` already declares both reasons: "Independent drafts are
not available in a shared session." and "Earlier versions cannot replace a shared
session." The running app still creates standalone sessions; every check answers
allowed there and behaviour is as before.

The lifetime rule is the one in
[Shared sessions and local file saving](stage-2-disabled-file-saving.md#session-and-save-lifetimes):
work that changes the current session asks the current session's capability, and
asks again after each wait.

## Where each owner refuses

| Owner | Refusal | Shown |
| --- | --- | --- |
| `startDrafts`, writer | `drafts` is asked wherever the writer asks whether it may write: a change schedules no capture, a flush answers `{ ok: true }` as a store that cannot write does, nothing is written and no draft on disk is discarded | Nothing |
| `startDrafts`, `taker` | Answers null, so the startup takes no draft | Nothing |
| `startDrafts`, `applyTaken` | A draft already taken answers `kept` before it is read, and again after the file of a file draft is read; the desktop keeps it for the next launch | Nothing |
| `HistoryOwner.captureSnapshot` | Answers null before it reads the document or mints an id | Nothing |
| `HistoryOwner.copyHistory` | Answers `{ ok: true, copied: 0 }` and copies nothing | Nothing |
| `HistoryOwner.historyDocumentChanged` | Writes no title or open time; listeners are still told | Nothing |
| `restoreSnapshot` (`session-merge.ts`) | Answers `refused` at entry, after the snapshot is read and after the backup is written; nothing is adopted and no further backup is kept | By the caller |
| History panel and gallery restore | On `refused`, show the `history` reason | Warning toast |
| Merge banner, Undo merge | Asks `merge` first, as before; on `refused` from the restore, shows the `history` reason | Warning toast |

Listing and reading snapshots stay available: what was kept before the session
became shared remains a recovery checkpoint, as the plan allows. A restore from it
cannot replace the shared session.

## Limits

- Snapshots already captured before the session became shared still finish their
  write and their retries; only new captures are refused.
- A keep flush (closing a file tab whose file is gone) answers as a store that
  cannot write. A shared instance needs its own tab source, which package 14 adds.
- A history copy for a standalone save that lands after the session became shared
  follows the current session, so it is not made; the snapshots stay under the old
  id. Package 14 decides captured-save effects together with the session owner.

Open for package 14, from the review of #1519 (assumed rule 53 on #1414). None can
happen until a shared session is composed in the app:

1. Two waits in a file-draft restore can still show the "kept" message if the
   session becomes shared meanwhile (`drafts.ts`, the superseded check and the
   refused merge).
2. A draft found at startup and refused leaves the restore marked as pending for the
   life of the page, so a tab that later turns standalone writes no crash drafts.
   This matters only if a shared session can exist at startup.
3. A tab that goes shared and back to standalone with a clean document deletes the
   draft from before the shared stretch at its first flush. That is correct only if
   entering the shared session dealt with that unsaved work.
4. Closing a tab whose file is gone, in a shared session that still has an older
   standalone draft, closes without the unsaved question; the old draft is kept.
5. App-data import of history (`importHistoryBundle`) and the legacy snapshot
   migration (`startHistoryMigration`) are not guarded; neither touches the open
   document.
6. Whether a shared session should take snapshots after all: the plan permits it.

## Inventory

`standalone-draft-history-callers.test.ts` lists, by declaration, every caller of
the draft writer, the draft taker and restore, the history writers, the history
storage writers and the restore paths, using the scan's `references` mode. A new
caller fails the table and names its file.

Two deliberate defects for this area are in `tests/collab/disable-list-mutants.json`,
each listed in `tests/collab/mutants.md` with the test that fails.
