# Shared undo

In a shared session each person's undo reverses only their own commands, by
meaning: it removes what the command added and brings back what it removed,
wherever that now is. It never restores earlier bytes.

The owner is `createSharedUndo` in `src/application/editing/undo/shared-undo.ts`.
The record it keeps is `SharedUndoRecord` in `src/core/collab/undo-record.ts`.
Nothing wires the owner, so the running app creates none and standalone undo is
unchanged. The executor that applies an undo to the shared document is a later
cut; the tests in `tests/collab/undo/` run the owner against a model executor
that follows the rules below.

## The record

One command is one record: a label, the selection to put back, and parts. A part
names what the command changed by identity, never by offset.

| Part | Holds |
| --- | --- |
| `text` | the identities it inserted and, for each unit it deleted, the identity, the value and its marks |
| `mark-add` | the mark, each occurrence it created with the units it covered, and the occurrences of that mark it had seen |
| `mark-remove` | the mark and, for each occurrence it took away, the units that lost it |
| `scalar`, `record-field` | the field, the value before and the value written |
| `status`, `status-retired` | the beat, the status event and its value |
| `record-create`, `record-delete` | the record and its fields |
| `structure` | the command kind and the operation identity |

`typing` is the text a keystroke inserted (`""` for a deletion key), or `null`
for a command that is not typing, such as cut or paste.

## Ports

`reverse(record, direction)` applies the inverse and answers either a refusal
with a reason, or whether anything changed, the inverse record and the selection.
`supports(part)` says whether the executor can reverse a part kind. `now()` is
the clock for typing groups. A command is recorded with `perform(run)`: `run`
makes the change and returns its record, or `null` when it changed nothing.

## Kept from standalone undo

| Rule | Test in `tests/application/editing/undo/shared-undo.test.ts` |
| --- | --- |
| Typing in one text within one second is one entry | kept: typing in one cell within one second is one entry, undone as one record |
| A second later, another text or a command that is not typing starts a new entry | kept: a second later, another cell, an explicit break or a command that is not typing starts a new entry |
| A word begun after a space starts a new entry | kept: a word begun after a space starts a new entry; the space and a deletion stay in the group |
| An undo or a redo ends the group | kept: an undo or a redo ends the typing group |
| Typing that returns to where its group began leaves no entry | kept: typing that returns to where its group began leaves no entry |
| 200 entries | kept: 200 entries; the oldest is dropped and only counted |
| A hold stops undo and redo until its last release | kept: while held, undo and redo change nothing; the last release lets them through |

## Different from standalone undo

| Standalone | Shared | Test |
| --- | --- | --- |
| A new change after an undo parks the redo entries and brings them back when the text returns to the parked state | A new command clears redo | different: a new command clears redo; nothing is parked |
| An undo that cannot apply is refused and stays | An entry whose change is already gone is used up: it is removed, adds no redo and the same key press reaches no older entry | top item: an entry whose change is already gone is used up, adds no redo and reaches no older entry |
| An entry restores the cell's earlier content | An entry reverses its own parts; other people's changes to the same text stay | decided: undo covers only your own changes; the other writer's text and format stay, and there is nothing older to reach |
| Groups single text changes of any origin | Groups only records marked as typing, so a cut and a paste are always two entries | decided: a cut and a paste into the same cell are two entries even in the same millisecond; undoing the paste leaves the cut |
| An entry dropped at the bound comes back when later entries are discarded | A dropped entry is only counted | kept: 200 entries; the oldest is dropped and only counted |
| Selection kept as a pair of row offsets | Selection kept as two anchors, resolved by the executor | Stage 1 record fixture: a selection held over deleted and restored text follows the restored characters |

## Refusals

A refusal leaves both stacks as they were. The reasons:

- `undo-unsupported:<kind>`: the entry has a part the executor cannot reverse.
  The executor is not called. Every structure command is refused this way until
  its executor lands: `segment-create`, `split`, `split-before`, `join`,
  `join-glue`, `remove`, `restore`, `segment-move`, `heading-create`,
  `heading-finalize`, `heading-remove`.
- `command-in-progress`: asked while a command is being recorded.
- `undo-in-progress`: asked from inside an undo.
- `held`: a hold is open.
- any reason the executor gives, passed on unchanged.

An executor that throws leaves the entry on its stack, and the error reaches the
caller. A command started inside another command or inside an undo throws and
records nothing.

## A remote change

The owner has no entry point for one. When another person's change arrives the
owner does nothing: no entry is added, removed, rewritten or reordered, redo is
kept, the typing group stays open and the serial does not move. This is safe
because a record holds identities and is resolved against the document at the
moment of the undo. If the change it names is gone by then, the entry is used
up. Test: "a remote change records nothing: the receiver's stacks, also its
redo, are as they were, and its records still resolve" in
`tests/collab/undo/decided-rows.test.ts`, and "a delivery changed the
receiver's stacks" in the generator.

## Rules an executor follows

The model executor in `tests/collab/undo/model-world.ts` follows these, and the
adapter executor has to meet the same fixtures and generator.

- **Inserted text**: delete each inserted unit that is still there, following a
  unit to its restoration.
- **Deleted text**: restore each unit as a new unit at the place of the deleted
  one, with the marks the deleted one would show now. Skip a unit someone has
  already restored, and a unit whose character is visible again.
- **A mark added**: take the mark away from what the command's own occurrences
  still cover. An occurrence by another person on exactly the same units, made
  without seeing this one, counts as the same change and goes too. If none of
  the command's occurrences shows anywhere, the entry is used up.
- **A mark removed**: put the mark back on the recorded units that are still
  there and do not show it.
- **A field**: write the earlier value only while the field still holds the
  value the command wrote.
- **A status**: retire the event, and the standing events with the same value,
  only while the beat shows that value and retiring changes it. A change that
  lost a conflict never applied, so its undo is used up.

## Declared limits

The table is `undoLimits` in `tests/collab/undo/limits.ts`; `limits.test.ts`
pins it. The generator fails on any violation the table does not carry.

| Limit | State | History |
| --- | --- | --- |
| double-restore | carried | Alice deletes `bc` and Bob deletes `c`. Both undo before either undo arrives: `c` is there twice |
| later-format | resolved | Alice bolds `ab`. Bob unbolds and bolds `bc`. Alice's undo takes bold from `a` only |
| sequential-status | resolved | Alice sets ready, then shot. Two undos give ready, then todo |
| status-redo-conflict | resolved | Alice's status lost a conflict. Her undo is used up, so there is nothing to redo |
| redone-recovery | waits for removal | Needs a removed beat |
| redone-mark-reversed | waits for the adapter executor | A limit of formatting inside the shared library |
| pending-update | waits for the adapter executor | A limit of delivery into the shared document |

## Open for the adapter executor

1. Nothing on main retires a status event, so undoing a status needs an
   operation that writes `retiredStatus`.
2. There is no shared record of which unit restores which. Undo of a deletion
   needs one, written with the restored text.
3. A `mark` operation with a null value removes every occurrence of that mark in
   the range. Undo of one person's mark needs to take away one occurrence.
4. `executeSharedOperations` labels every write `local-command`; an undo is
   `local-undo`.
5. Who builds the record of a forward command: the executor knows the units and
   occurrences a command touched, so it is the natural place.
