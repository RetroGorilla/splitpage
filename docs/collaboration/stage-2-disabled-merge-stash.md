# Shared sessions and local merge, stash and reload

Package 13 detaches the local three-way merge, the conflict stash and reload from
disk through `CapabilityPort`. `SHARED_SESSION_DISABLED` declares the reasons for
`merge` and `stash`, and gains `reload`: "Reloading a local file is not available
in a shared session." The running app still creates standalone sessions; every
check answers allowed there and behaviour is as before.

The lifetime rule is the one in
[Shared sessions and local file saving](stage-2-disabled-file-saving.md#session-and-save-lifetimes):
work that changes the current session asks the current session's capability.
Nothing here writes a file, so no step keeps an answer captured at entry.

## Where each owner refuses

| Owner | Refusal | Shown |
| --- | --- | --- |
| `createConflictStash` | `save` false, `read` null, `clear` and `dropReloadGuard` do nothing, `accept` returns its argument; storage is not touched | Nothing |
| `createLocalWorkStash` | false, before reading the document | Nothing |
| `createStashedWork` | Asks `stash`, then `merge`, before reading stored work; answers the loaded document with `reason` | By the caller |
| `createDocumentMerge` | `apply` answers `{ state: null, result: null, snapshot: null, reason }`; `states` throws the reason; `report` does nothing | By the caller |
| `startLocalMerge` | The offer is dropped at entry and again after parsing; Review and Merge show the reason; a review already open closes without merging and without returning to the conflict dialog | Warning toast on Review and Merge only |
| `mountMergeBanner` | `show` answers false; Undo merge disarms and warns | Warning on Undo merge only |
| `local-files.ts` reload | Refused at entry, after the file is read, after parsing, and before the import path adopts rows | Warning toast |
| `startDrafts` | A file draft whose merge answers a `reason` is kept for the next launch (INV-40) | The existing kept notice |

A step a person asked for shows the reason through the existing warning toast.
A step the app takes by itself (offering a merge, showing a report, reading the
stash after a load) refuses without a message.

Reload passes a `permitted` check down `openProjectFile` and `loadFileIntoEditor`.
Opening, resuming and dropping a file use the same two functions with the default,
which always permits: those entries are package 14's.

## Limits

- `restoreMergeSnapshot` in `session-merge.ts` is not guarded at the owner. Its
  one caller, the merge banner, asks `merge` first. The history part of the
  package guards the restore owner with `history`.
- The session merge ports (`adopt`, `snapshot`, `armUndo`, `setBase`,
  `noteHistoryFrom`) carry no check of their own: they are reached only through
  `createDocumentMerge`, and a check inside them would break a continuation that
  already holds its ownership proof.
- Stored stash from before a shared session is neither read nor cleared while
  the session is shared. It is still there for the next standalone session.
- Last-file resume, an inbound open and the prompter launch are not in the
  disable list. Package 14 decides them when it wires entry to a shared session.

## Inventory

`standalone-merge-stash-callers.test.ts` lists, by declaration, every caller of
the merge, stash and reload boundaries, including the wiring functions that hand
them on (`applyMerge`, `reportMerge`, `applyStashedWork`, `stashLocalWork`,
`restoreMergeSnapshot`, `sessionMergePorts`). The scan counts a function passed as
a value as well as a call, so a new caller that only forwards a boundary fails the
table and names its file. The limits of the typed scan are those listed for
`standalone-save-callers.test.ts`.

Eleven deliberate defects for this area are in
`tests/collab/disable-list-mutants.json`, each listed in `tests/collab/mutants.md`
with the test that fails.
