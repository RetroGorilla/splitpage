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
- App-data history import (`importHistoryBundle`) and the startup migration of
  legacy snapshots (`startHistoryMigration`) are app-wide and do not touch the live
  document; they are not guarded.
- A history copy for a standalone save that lands after the session became shared
  follows the current session, so it is not made; the snapshots stay under the old
  id. Package 14 decides captured-save effects together with the session owner.

## Inventory

`standalone-draft-history-callers.test.ts` lists, by declaration, every caller of
the draft writer, the draft taker and restore, the history writers, the history
storage writers and the restore paths, using the scan's `references` mode. A new
caller fails the table and names its file.

Two deliberate defects for this area are in `tests/collab/disable-list-mutants.json`,
each listed in `tests/collab/mutants.md` with the test that fails.
