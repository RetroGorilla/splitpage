# Shared undo

In a shared session each person's undo reverses only their own commands, by
meaning: it removes what the command added and brings back what it removed,
wherever that now is. It never restores earlier bytes.

The owner is `createSharedUndo` in `src/application/editing/undo/shared-undo.ts`.
The record it keeps is `SharedUndoRecord` in `src/core/collab/undo-record.ts`.
Nothing wires the owner, so the running app creates none and standalone undo is
unchanged. The tests in `tests/collab/undo/` run the owner against a model
executor that follows the rules below, and against the executor for the shared
document in `src/adapters/collab/undo-executor.ts`, described under "The adapter
executor". That executor covers text, marks, fields, status and records;
structure commands are a later cut.

## The record

One command is one record: a label, the selection to put back, and parts. A part
names what the command changed by identity, never by offset.

| Part | Holds |
| --- | --- |
| `text` | the identities it inserted and, for each unit it deleted, the identity, the value and its marks |
| `mark-add` | the mark and each occurrence it created with the units it covered |
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
| A group that deletes all it typed leaves no entry | kept: a group that deletes all it typed leaves no entry |
| 200 entries | kept: 200 entries; the oldest is dropped and only counted |
| A hold stops undo and redo until its last release | kept: while held, undo and redo change nothing; the last release lets them through |

## Different from standalone undo

| Standalone | Shared | Test |
| --- | --- | --- |
| A new change after an undo parks the redo entries and brings them back when the text returns to the parked state | A new command clears redo | different: a new command clears redo; nothing is parked |
| An undo that cannot apply is refused and its entry is dropped | A refused undo keeps its entry, so it can be asked again | a refusal from the executor leaves both stacks as they were |
| (no such outcome) | An entry whose change is already gone is used up: it is removed, adds no redo and the same key press reaches no older entry | top item: an entry whose change is already gone is used up, adds no redo and reaches no older entry |
| A group whose text ends as it began leaves no entry, whatever was typed in between | A group that deletes earlier text and types the same letters again keeps its entry: the new letters are other characters, and the entry's undo brings the first ones back so that older entries still reach them | different: a group that deletes earlier text and types the same letter again keeps its entry, which names both characters; and in `decided-rows.test.ts`: different: deleting an earlier letter and typing it again keeps an entry; its undo brings the first letter back, so the older entry still reaches it |
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

Where the adapter on main already decides an outcome, the model reproduces it,
and `tests/collab/undo/mirrored-rules.test.ts` runs the same history through
`executeSharedOperations` and through the model against one literal result:

- **A forward mark** mirrors `prepareSharedMarkChange` in
  `src/adapters/collab/mark-executor.ts`: one occurrence over the whole range
  the command was given, also where the mark already shows, and over what
  arrives inside that range unseen. Text typed later with the occurrence in
  view does not take it.
- **A field** mirrors `prepareScalar` in `src/adapters/collab/scalar-executor.ts`
  writing one key of a shared map: a set made after seeing another replaces it;
  of two sets that did not see each other the one from the higher client id
  stays; a clear removes only the value it saw, so an unseen set stays.

Where a decided row decides an outcome, the model follows the row: the same
change made by two people who had not seen each other's is one change, which
either can undo. When the other person's change has arrived before the undo,
this is the Stage 1 result and the Stage 1 record fixtures hold it.

When the undo comes before the other person's change arrives, the model goes
beyond Stage 1 on purpose (assumed rule 24 on issue #1414):

- **The history**: the text is `ab` and tag P is registered. Alice and Bob each
  tag both letters with P without seeing the other's tag. Alice undoes before
  anything is delivered, then everything is delivered.
- **Stage 1**: both prototype copies keep P, under forward, duplicate and
  reverse delivery. Alice's undo removes only what her copy held, and Bob's
  tag arrives afterwards as a new one.
  `prototypes/collab/test/undo-records/identical-tag-late.test.ts` records
  this in "identical tag, Alice undoes before Bob's tag arrives: both prototype
  copies keep the tag", and the opposite order of events beside it.
- **The model**: no copy shows P, and Bob's undo is used up.
  `tests/collab/undo/mirrored-rules.test.ts` holds this in the three tests
  whose names start "Beyond Stage 1".
- **Why**: the decided row "identical changes count as one change either
  person can undo" must not depend on the order of delivery. In Stage 1 the
  same two tags and the same undo give no tag when Bob's tag arrives first and
  a tag when it arrives second.

- **Inserted text**: delete each inserted unit that is still there, following a
  unit to its restoration.
- **Deleted text**: restore each unit as a new unit at the place of the deleted
  one, with the marks the deleted one would show now. Skip a unit someone has
  already restored, and a unit whose character is visible again.
- **A mark added**: take the command's own occurrences away. The cancellation
  stays with the occurrence: an occurrence of the same mark over the same
  range, made without either having seen the other, is cancelled with it,
  also when it arrives after the undo. The other person's undo is then used
  up. A mark over other words, or one made after seeing this one, is another
  change and stays. If none of the command's occurrences shows anywhere, the
  entry is used up.
- **A mark removed**: put the mark back on the recorded units that are still
  there and do not show it. This is the only place a mark is written
  conditionally; a forward mark never is.
- **A field**: write the earlier value only while the field still holds the
  value the command wrote. The undo of a set that lost to an unseen set is used
  up.
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
| redone-mark-reversed | resolved | Alice tags `ab` while Bob bolds `a`. Alice undoes and redoes; her two updates arrive in reverse. The tag stays on every copy |
| pending-update | resolved | A copy given a writer's second update before the first reads as it was, takes commands, and reads both once the first arrives |
| insert-after-deleted-run | carried, shared document only | Alice deletes `bc` of `abcd`, delivered. Bob types `X` where the gap between `b` and `c` was. Alice undoes: `abcXd`, where the model and Stage 1 give `abXcd` |

`insert-after-deleted-run` is kept as a declared rule, assumed rule 30 on the
tracking issue: text typed where a run was already deleted sits after that run
if the deletion is undone. It comes from the forward insertion, not from the undo:
`prepareSharedTextInsert` places text by a position among the visible
characters, so text typed where a deleted run was sits after the whole run. The
undo restores each character in its original order and cannot move the other
person's text. The two Stage 1 runs that reach it (T01 and T01 composition
with a late joiner) are listed in `ADAPTER_BUFFER_LIMIT_RUNS` and fail in the
declared way in `limits.test.ts`; the model passes both.

`redone-mark-reversed` and `pending-update` were limits of the Stage 1
prototype, where formatting and delivery belonged to the shared library. Here a
mark is a record the adapter writes, and an update that arrives before the one
it depends on is held. Each has one literal test in `limits.test.ts`, on the
shared document.

## The adapter executor

`src/adapters/collab/undo-executor.ts` has the two halves:

- `executeSharedCommand` runs a forward command through
  `executeSharedOperations` and builds its record from what the document shows
  before and after its own transaction: the units inserted and deleted, the
  occurrences a mark created, the field values, the status event, and each
  record as it was before and is after.
- `reverseSharedUndoRecord` is the owner's `reverse` port. It plans every part
  from the document as it is now, runs the result as one
  `executeSharedOperations` call with the origin `local-undo`, and returns the
  inverse record. `supportsSharedUndoPart` is the owner's `supports` port.

An undo needs three operations a forward command never writes. Each is read by
`readOperation` like any other and has a handler registered by
`registerSharedUndoOperationHandlers`:

| Operation | What it writes |
| --- | --- |
| `text-restore` | each deleted unit as a new character after its left neighbour, with a birth record that names the unit it restores and a copy of each mark it is given |
| `mark-retract` | a removal that names one occurrence |
| `status-retire` | `retiredStatus` for the standing events of one value, only while the beat shows that value and retiring changes it |

How the points left open by the model are met:

1. **Which unit restores which.** The birth record of a restored character
   carries the identity of the unit it restores, in its operation name. No new
   root is added. `readSharedTextHistory` in `text-history.ts` reads the full
   order of a text with its deleted units and follows a unit to its
   restoration. A unit someone has already restored, or one that is visible
   again, is skipped. Units restored together are written in the order of
   their own places, so a character that was restored, deleted and is restored
   again stands where it stood. The keystrokes of one typing entry in one text
   are reversed as one part, so they keep their order. The generator on the
   shared document found both.
2. **Marks on a restored character.** The restoring operation writes one copy
   per occurrence the original showed. A copy stands for its source: what takes
   the source away over that place, and the undo of the command that made it,
   take the copy too (`mark-provenance.ts`, read in `readCollabMarkState`).
3. **One occurrence, not every mark in the range.** `mark-retract` names the
   occurrence, so another person's mark over the same words stays.
4. **An identical change that arrives after the undo.** A forward mark now
   carries one number in its operation name: one more than the highest number
   among the same marks over the same range it had seen, and no number when
   it had seen none. Marks made apart share a number; a mark made after seeing
   another carries the next. The name never contains another mark's name, so
   its size does not grow with the history: 200 rounds of bold and undo leave
   the longest stored key at 37 characters and add 481 to 497 bytes to the
   encoded document per round (`undo-mark-growth.test.ts`). The undo record
   holds no list of marks seen.
   A retraction cancels the occurrence and every addition of the same mark over
   the same range with the same number, also one that arrives later. This is
   the step beyond Stage 1 described above. Assumed rule 32 on the tracking
   issue settles the case the decided rows leave open: a mark made apart from
   another, but after seeing a third identical one, carries the next number and
   is its own change. The model executor and the generator's check follow the
   same rule.
5. **The origin.** `executeSharedOperations` takes `origin: "local-undo"`;
   without it a write is `local-command` as before.
6. **Only the command's own writes.** Updates that arrive during a command's
   notification are held and applied when its write ends. Both halves run
   inside one write frame (`sharedWriteFrame`) and read the record, or the
   inverse, before that frame ends, so no state they compare contains a held
   update. `undo-held-updates.test.ts` runs every supported part kind with
   another writer's change to the same target delivered during the
   notification.
7. **A value of two units.** The two halves of a character outside the basic
   plane are deleted and restored as one value. Its birth record covers both
   units; the history follows and traces each, and the inverse of a restore
   names every unit the restore wrote (`undo-runs.test.ts`).

### The provenance marker

Retractions and copies are rare; typing is not. A text's mark store therefore
carries the key `provenance` with the value `true` once it holds a retraction
or a copy. The undo handlers write it in the transaction of the first one,
through the operation entry, and never again; two first retractions made
apart write the same constant. The key is not a record: the record validators
refuse it and every reader of the store skips it, so a marker on a text
without retractions changes no mark state, preparation, projection or late
join (checked on the 291 reference documents in
`undo-provenance-marker.test.ts`).

`readSharedMarkProvenance` trusts the marker in one direction: absent means
no scan. The mark-state reader looks for it among the store keys it has
already read and sorted, so the check reads nothing more from the library and
the read cache's counts are as without it. A cached reading is keyed by the
text and its store; the marker and the first retraction arrive in one
transaction on that store, so a reading cached before them is not served
after (`undo-provenance-cache.test.ts`). Cost of typing one character, counted by `sharedMarkProvenanceCost`:

| Text | `executeSharedOperations` | `executeSharedCommand` |
| --- | --- | --- |
| no marker, 10 or 1,000 ordinary records | 0 scans, 0 visits | 0 scans, 0 visits |
| marker, n records | 1 scan, n visits and more | 3 scans, each n visits and more |

With the marker one scan is one pass: every record once, then every retraction
once and every member of a cancelled change once. The counter counts each of
these. A reading with r retractions over 2r records, each of its own change,
costs 4r visits: 40 for 10, 80 for 20, 400 for 100.

A typed command reads the mark state for its record once, after it has
written; which characters were there before is read from the text alone.

Declared limit: a text seeded by hand with a retraction and no marker reads
that retraction as a plain removal. The occurrence it names is gone where the
removal covers it, but the identical mark of another writer and copies on
restored characters still show. Every copy holds the same state, so every copy
reads the same. No scan is added to detect it; one literal test pins it.

### Records

Comments, replies, people, tags and shots (`SHARED_UNDO_RECORDS`). A command is
described once per record, by what the record was before and what it is after:
a creation, a removal, or one `record-field` part per field that changed. A
command that creates a record and sets its field is one creation.

| Part | Its undo | Used up when |
| --- | --- | --- |
| `record-create` | removes the record | the record is gone, or no longer holds exactly the fields the command wrote |
| `record-delete` | creates the record with the fields it had | the record is there |
| `record-field` | writes the earlier value, or clears the field | the record is gone, or the field no longer holds what the command wrote |

The inverse of each is the opposite part, so redo follows the same table. Two
choices the decided rows do not name, both waiting for a decided row:

- The undo of a creation is used up as soon as anyone changed the record. It
  never removes another person's change with it.
- A comment or reply keeps its author. Undoing your removal of another
  person's comment puts it back in that person's name.

A gallery slot and a visual are parts of a beat. Their undo comes with the
structure commands; until then a record of one is refused by name
(`undo-unsupported:record-create:gallery`) and nothing is written.

### The generator on the shared document

`tests/collab/undo/generator.test.ts` runs 300 seeded histories of 40 steps
with two writers and 300 with three writers and a late joiner, on the shared
document. A history draws every text, mark, field and status command, the
three record commands on the five kinds of record, undo, redo, and delivery
in order, duplicated and reversed. After each undo and redo it checks that
only this writer's work changed; at the end, that every copy and a new
joiner hold the same script and the same records. An undo that replaces or
removes a record value another writer wrote is a violation.

| Writers | Commands | Record commands accepted | Effective undo | Effective redo | Used up | Declared limit reached |
| --- | --- | --- | --- | --- | --- | --- |
| two | 5,791 | 1,986 | 1,467 | 607 | 19 | double-restore, seeds 6, 102, 105 |
| three, late joiner | 5,171 | 1,689 | 1,272 | 479 | 17 | double-restore, seeds 39, 297 |

No other violation is reached. A record command the document refuses (a
second creation of a record that is there, a change to a record that is not,
another person's comment text) is counted by its reason and changes nothing.

Not covered yet: structure commands, which the owner refuses by name.
The adapter tests are in `tests/adapters/collab/undo-operations.test.ts` and
`undo-records.test.ts`.
