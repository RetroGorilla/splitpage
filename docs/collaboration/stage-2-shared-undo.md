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

## The seam to the shared session (composition C2)

- **Recording.** A shared plan may carry a description (`SharedCommandDescription`
  in `src/core/collab/undo-record.ts`: a label, the selection as anchors, a typing
  key). The shared session hands it to the replica's `execute`; a plan with
  `undo: false` (the rule 29 recovery write) hands `null`, and a plan without one
  is described by its command's name with no selection or typing key.
  `createSharedReplica(handle, count, undo)` runs a described list through
  `executeSharedCommand` inside `undo.perform`, so its record reaches the one owner
  once; an undescribed list, or a replica built without an owner, runs through
  `executeSharedOperations` and records nothing.
- **Typing.** Every buffered commit (`createSharedBufferedText`, which the Writer's
  text and headings, the Split cells and visual column, the rename form and the
  title all use) is described as `typing`, with the inserted text as its typing
  key and a collapsed selection where the edit began.
- **Undo and redo.** `sharedUndoActions(session, owner)` asks the session's
  `admit()` first: open typing commits through the `beforeCommand` listeners, and
  a refused admission reverses nothing. `sharedUndoOwner(handle, author, now)` in
  `src/bootstrap/wiring/ports/shared-undo.ts` builds the owner over
  `reverseSharedUndoRecord`.
- **Not here.** `breakGroup` at the standalone owner's `breakCoalescing` call sites
  waits for C4, which puts a shared owner in the app; dropping a refused entry
  (rule 71) is the undo lane's change to the owner.

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
| An undo that cannot apply is refused and its entry is dropped | Rule 71: a step that cannot be undone is skipped: the outcome keeps its `undo-unsupported:<kind>` reason and adds `skipped`, the message "This step cannot be undone in a shared session yet." is shown once, the entry is dropped and counted (`skipped()`), nothing is added to the other stack, and the next undo reaches the step before. Skipped: an unsupported part, and an executor refusal no later state lifts (`undo-unsupported:*`, `invalid-operation`). Kept: a refusal a later state can lift (`missing-target` and other preparation refusals), `command-in-progress`, `undo-in-progress`, `held`, and an executor that throws | rule 71: one unsupported entry on top of two supported ones: three undos give the skip, then the two older steps; rule 71: a refusal from the executor that a later state can lift leaves both stacks as they were |
| (no such outcome) | An entry whose change is already gone is used up: it is removed, adds no redo and the same key press reaches no older entry. Rule 90: the outcome says so (`reason: "used-up"`), so the message "That step could not be undone because someone else changed it." is shown once. Typing in a beat someone removed is not used up: its undo waits for the beat's restore, as decided, and its `missing-target` refusal keeps the step | top item, rule 90: an entry whose change is already gone is used up, says so, adds no redo and reaches no older entry; and in `undo-notice.test.ts`: rule 90, four ways a step is used up on real copies |
| A group whose text ends as it began leaves no entry, whatever was typed in between | A group that deletes earlier text and types the same letters again keeps its entry: the new letters are other characters, and the entry's undo brings the first ones back so that older entries still reach them | different: a group that deletes earlier text and types the same letter again keeps its entry, which names both characters; and in `decided-rows.test.ts`: different: deleting an earlier letter and typing it again keeps an entry; its undo brings the first letter back, so the older entry still reaches it |
| An entry restores the cell's earlier content | An entry reverses its own parts; other people's changes to the same text stay | decided: undo covers only your own changes; the other writer's text and format stay, and there is nothing older to reach |
| Groups single text changes of any origin | Groups only records marked as typing, so a cut and a paste are always two entries | decided: a cut and a paste into the same cell are two entries even in the same millisecond; undoing the paste leaves the cut |
| An entry dropped at the bound comes back when later entries are discarded | A dropped entry is only counted | kept: 200 entries; the oldest is dropped and only counted |
| Selection kept as a pair of row offsets | Selection kept as two anchors, resolved by the executor | Stage 1 record fixture: a selection held over deleted and restored text follows the restored characters |

## Refusals

A refusal leaves both stacks as they were. The reasons:

- `undo-unsupported:<kind>`: the entry has a part the executor cannot reverse.
  The executor is not called. Every structure command but a join, an unjoin, a
  separator change, a split, a beat removal, a heading removal without a new
  beat and a restore of either is refused this way until its executor lands:
  `segment-create`, `segment-move`, `heading-create`, `heading-finalize`, and
  `heading-remove` with a new beat (a demotion). A split whose part cannot be
  recorded keeps the generic part, named `split` or `split-before`. A
  removal of another kind (range, became-heading) is named `remove` and
  refused by the executor with `undo-unsupported:remove`. See
  [Undo of a join](#undo-of-a-join), [Undo of a split](#undo-of-a-split),
  [Undo of a removal and a restore](#undo-of-a-removal-and-a-restore) and
  [Undo of a heading removal and its restore](#undo-of-a-heading-removal-and-its-restore).
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
  already restored, and a unit whose character is visible again. A unit the
  command moved into another beat of the same text (Enter over a selection
  moves the text after it into the new beat) was not deleted by the command,
  so its record does not list it, and its undo never brings it back, even after
  someone else deleted it. A heading made from the new beat's first line is
  such a deletion: it consumes the `# ` and the line break. Literals in
  `undo-heading-consumed.test.ts`, on three copies in every delivery order.
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
| pending-update | carried | `ab`, three writers. Bob types `X` at the end, then pastes `Y` over `a`. Carol receives the second update first and reads `b`, a text no copy ever had; when the first arrives she reads `YbX` |
| insert-after-deleted-run | carried, shared document only | Alice deletes `bc` of `abcd`, delivered. Bob types `X` where the gap between `b` and `c` was. Alice undoes: `abcXd`, where the model and Stage 1 give `abXcd` |
| typed-beside-restored | carried, shared document only | `ab`. Bob deletes `b` and undoes, neither delivered. Alice types `X` after `b`. Delivered: `aXb` on every copy, where the model gives `abX` |

`insert-after-deleted-run` is kept as a declared rule, assumed rule 30 on the
tracking issue: text typed where a run was already deleted sits after that run
if the deletion is undone. It comes from the forward insertion, not from the undo:
`prepareSharedTextInsert` places text by a position among the visible
characters, so text typed where a deleted run was sits after the whole run. The
undo restores each character in its original order and cannot move the other
person's text. The two Stage 1 runs that reach it (T01 and T01 composition
with a late joiner) are listed in `ADAPTER_BUFFER_LIMIT_RUNS` and fail in the
declared way in `limits.test.ts`; the model passes both.

`typed-beside-restored` is the one case left of a restored character changing
place. A restored character is written directly after the deleted one it
restores. Text another writer types directly after that same character, without
having seen the deletion, is written after it too, and the shared library
orders two such writes by writer number, not by meaning. When the typist has
the lower number the typed text ends before the restored character. Every copy
agrees and nothing is lost or doubled. The generator tells this apart from a
defect: an order a writer saw and its own command changed fails the run; an
order changed by what arrived from a writer who had not seen it is this limit.

Pictures have their own seeded generator in `undo-gallery.test.ts`: 36
histories of 20 steps in which Alice adds pictures and undoes and redoes, Bob
renames pictures his copy holds, Carol removes and restores the beat, and
messages arrive one at a time, some twice. Each delivery is followed by a check
that the incremental projection equals a fresh one; at the end every copy and
a late joiner must read the same. Its table of declared limits,
`DECLARED_LIMITS`, is empty: no shown picture without a record or record
without a picture, no picture another writer renamed left hidden, and no
removal that lists a picture that is not stored.

`redone-mark-reversed` was a limit of the Stage 1 prototype, where formatting
belonged to the shared library. Here a mark is a record the adapter writes. It
has one literal test in `limits.test.ts`, on the shared document.

`pending-update` is carried. An update that arrives before the one it depends
on is held whole only when it inserts and nothing else. A deletion in it names
characters the copy already has, so the library applies the deletion at once
and holds the insertions: until the earlier update arrives the copy shows the
later update's deletions without its insertions. The copy takes commands
meanwhile and every copy agrees once both have arrived. Two literal tests in
`limits.test.ts` pin the two halves.

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

An undo needs seven operations a forward command never writes. Each is read by
`readOperation` like any other and has a handler registered by
`registerSharedUndoOperationHandlers`:

| Operation | What it writes |
| --- | --- |
| `text-restore` | each deleted unit as a new character directly after the deleted unit, with a birth record that names the unit it restores and a copy of each mark it is given |
| `mark-retract` | a removal that names one occurrence |
| `status-retire` | `retiredStatus` for the standing events of one value, only while the beat shows that value and retiring changes it |
| `split-retire` | a mark in `meta` that holds what the undo saw of the new beat; the boundary atom stays; nothing when the split is already undone |
| `split-restore` | deletes that mark, so the boundary reads as a boundary again; refused while the new beat has a row |
| `gallery-retire` | the `retired` key of one picture, holding what the copy saw as it applies ([Pictures](#pictures)) |
| `gallery-restore` | deletes the `retired` key of one picture; nothing when it is not there |

How the points left open by the model are met:

1. **Which unit restores which.** The birth record of a restored character
   carries the identity of the unit it restores, in its operation name. No new
   root is added. `readSharedTextHistory` in `text-history.ts` reads the full
   order of a text with its deleted units and follows a unit to its
   restoration. A unit someone has already restored, or one that is visible
   again, is skipped. The keystrokes of one typing entry in one text are
   reversed as one part, so they keep their order.

   **Where a restored character is written.** Directly after the deleted unit
   it restores (`insertBeside` in `text-edit.ts`), not by a position among the
   visible characters. A write by position lands behind every deleted
   character at that place, so a restored character jumped over the deleted
   ones after it; restoring those later put them in front of it (`abcdef`, cut
   `de`, cut `bc`, undo, undo gave `adebcf`). Written beside the unit it
   restores, a restored character has the same place among all other
   characters, deleted or not, as that unit had. By induction the order of any
   two characters a writer has seen together never changes through that
   writer's undo or redo, whatever was deleted, restored or redone in between.
   `restore-order.test.ts` pins the single-writer and two-writer cases as
   literals on the model and on the shared document, and the generator checks
   the order after every undo and redo. The write uses the shared library's
   item constructor, since its text type has no insertion beside a deleted
   character; the library version is pinned in `package.json`.
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
8. **Formatting across a joined row.** A joined row stores each piece's mark
   records in that piece's own text, and the format of each join space
   (bold, italic, underline, strikethrough, highlight) as a value kept with
   the join. A mark command on a joined row records one `mark-add` or
   `mark-remove` part per piece, addressed to the piece's text, and, when it
   changed a space's stored format, one more part addressed to the row with
   no occurrences and the join groups in `spaces`. A space the command found
   already as it left it is not recorded, so undo leaves it. The space is a
   single value, so it follows the rule for numbers and record fields (rule
   39, the `scalar` part): undo writes the earlier value back only while the
   space still holds what the command wrote and its join is still in the row.
   It does so with a `mark` over the space alone (`["join-glue", group]`),
   which writes nothing else. When the row has since been joined into an
   earlier row, the space is read and written through the row that now holds
   the join. After an unjoin the pieces' records are still
   taken back and the old join's value is not written; a new join starts with
   a plain space. A space another writer cleared after the command stays
   plain through undo and redo. One case the rules leave open is pinned as it
   falls out: a space another writer cleared and then set again holds what the
   command wrote, so the undo clears it, as it would a number changed and
   changed back. Links, tags and comments have no stored space; their undo
   takes them off every piece the same way (`join-marks.test.ts`).

### Undo of a join

A `join` command records a `join` part: the native id of the join entry, the
source and target beats, the separator it wrote and its generation. Its group
is `sharedJoinRetirementGroup` of those, so it is not stored twice. The part
says whether it stands for the join (`retired: false`) or for its undo
(`retired: true`). `SHARED_UNDO_PARTS` names it, so the owner no longer refuses
it; any other structure part in the same record still refuses the whole entry
by name.

The part names the entry by the key this copy's join wrote
(`sharedStructureIdentity` of the writer and the operation id), since an
operation id is unique only per writer.

The two beats count as joined when, in the row that holds the source beat, the
source beat's part is attached through a live join of these two beats and a
part of the target beat comes before it (`readSharedJoinPlace` in
`undo-join.ts`). A join puts the source after the whole row, so on a row that
was already joined the source follows the row's last beat, not the target.

Undo runs `join-retire` on the entry (#1490). It writes only while all of these
hold: the join is not yet retired, neither beat is removed, the two beats count
as joined, and no live join of the same two beats with the same separator and a
later generation exists. Otherwise it is used up and writes nothing. Redo is a
fresh `join` of the same two beats with the separator the join showed when it
was undone, and a `mark` over the new join's space for each format the space
carried then. It is used up when either beat is removed or the two beats count
as joined.

Assumed rule 48 on #1414 settles the cases rule 34 leaves open. Each has a
literal in `undo-join.test.ts` over in-order, reversed and duplicated delivery
and a late joiner:

- The same join made apart by another writer is retired with ours (rule 34).
  Undoing a join made after seeing ours leaves ours in place.
- While a later join of the same two beats by someone else is live, our undo is
  used up and the row stays joined. The cost: if that person then undoes their
  join, ours remains and the row stays joined.
- A join onto a row that is already joined is undone and redone like any other.
- Ours already retired with the same join made apart, and the beats joined
  again since: the undo is used up.
- Another writer changed the separator since: the undo separates; the redo
  uses the separator the join showed.
- Another writer formatted across the join since: the undo separates, each
  piece keeps its own marks, and the space's format goes with the join; the
  redo brings that format back on the new space.
- Another writer typed in either piece since: the undo separates and the
  typing stays where it is.
- Either beat removed, or the first beat split so that the joined part follows
  the new beat: the undo is used up.
- Another writer joined the same two beats again after the undo, or either beat
  was removed: the redo is used up.

Declared limits:

- Undoing a join made after seeing a matching one retires only that join. The
  row looks the same and the undo counts as effective.
- A redo when the source beat was joined into another beat meanwhile writes the
  join, and the join interpreter decides which one shows.
- The later-join guard compares joins with the same separator; a later join of
  the same two beats with another separator does not stop the undo.

### Undo of an unjoin and of a separator change

A command with `join-retire` records, for each join it retired, the `join`
part with `retired: true`: the entry it retired, the separator the join showed
and the formats its space carried. Its undo is the redo above: a fresh `join`
of the same two beats with that separator, and the space formats written
again. It is used up when either beat is removed, when the two beats are
already joined again by anyone, or when the source beat is no longer the next
beat after the target's own row in the order (a split, a new beat or a heading
between them). The neighbour check also applies to the redo of an undone join.
A `join-retire` of a join that is already retired records nothing, and a join
retired twice in one command is recorded once.

A command with `join-glue` on a join that stood before the command records a
`join-glue` part with the separator before and after. Its undo sets the
earlier separator back only while the join is not retired and still shows the
separator the command wrote; a separator another writer changed since uses it
up (rule 28). A separator set on a join made in the same command keeps the
generic part and stays refused.

No command of the app emits `join-retire` or `join-glue` today: the app
separates joined beats with Enter at the join point, which is a split. These
parts are reached by operation lists that carry either operation. Literals in
`undo-unjoin.test.ts`.

### Undo of a split

A split writes a boundary atom (`{b: beat}`, or `{b: beat, before: source}`
for `split-before`) into the segment text and a record for the new beat. A
command with a `split` or `split-before` records a `beat-split` part: the new
beat (its writer-namespaced key), the source beat, and a comparison of the new
beat without its characters: its record without its stamp, status and events,
visual and gallery records, its row's pieces, how many boundary atoms it has
and the boundary just before its own. The stamp is left out because undo never
takes a stamp back (rule 35): typing in the new beat and undoing that typing
leaves a stamp that must not use the split's undo up. The comparison of a
restored beat (below) leaves it out for the same reason. A visual is compared
by its fields and the characters it shows with their marks, not by its mark
records, so typing undone in the new beat's visual leaves no difference; text
someone typed there and left uses the undo up. A heading made from the new
beat's first line, or a heading or a beat put between the source beat and the
new beat, changes the boundary just before the new beat's own, so the undo is
used up.

Two operations serve only undo, as `text-restore` does. Neither touches the
segment text:

- `split-retire` writes a mark under `meta` (`splitRetired:<beat>`) that holds
  what the undo saw of the new beat, read from the planned state of its
  operation list. It is the value every reader computes after that list.
- `split-restore` deletes the mark. It is refused (`existing-boundary`) while
  the new beat has a row.
- Both are read like any other operation, so a hand-made one from another copy
  is refused only when its beat or segment cannot be found.

While the mark holds, which means it still equals what the readers see of the
new beat now, the block interpreter reads the new beat's boundary as text of
the beat before it: the new beat's characters join the source beat and its
record, visual and status stay stored without a row, and nothing shows in
recovery.

The hold is judged on the new beat as it is now (assumed rule 103): a change
taken back leaves the beat as the undo saw it, so the split is undone again.
One table, `SHARED_SPLIT_WATCHED_PARTS`, defines each watched part once, and
every reader uses it: the full and incremental projections, the structure
index and the planned state of an operation list. The planned state asks the
same question of the planned document after each operation of a list, for
the marked beats whose parts that operation wrote, so a list is prepared as
every copy will read it after each of its operations. The parts:

| Part | Read as it is now |
| --- | --- |
| record | the new beat's record, without stamps (rule 35) |
| boundaries | how many boundary atoms of the new beat its segment holds |
| predecessor | the boundary just before the new beat's own, passing over other undone splits' boundaries; a boundary read as text joins the block before it, so the undo holds only while that block is still the source beat |
| joins | the joins into the new beat from other beats that are not retired |
| attachments | the new beat's visual and gallery records, with only the mark records whose mark still shows: no birth record, no mark a removal took back |
| status | the new beat's standing status events |

No source module of the watch reads a private field of the library; the one test that does, walking a text's items, is unchanged from main (`tests/adapters/collab/structure-identities.test.ts:401`). Every part is read through the library's public calls only: the stored
document through a small read view over its maps and texts, the planned one
through the preparation view. The structure index and the watch read a
boundary atom with the same reader, so an embed that names the beat but is no
boundary changes neither (literal: a hand-made `{ b, extra }` embed).

A test walks the table: for every part, a change and the change taken back,
both staged in a list and written to the store, give the planned state and the
readers the same answer at each step. Literals, two copies in three delivery
orders with a late joiner:
- another writer, while the undo is in flight, changes the new beat (a field,
  its status, its visual, a gallery picture, a removal, a join into it): the
  split stays and the redo is used up;
- another writer, while the undo is in flight, makes such a change and takes
  it back (a field set and cleared, a picture added and deleted, a status set
  and retracted, a beat joined in and unjoined, as one list and as separate
  lists; text typed into the visual and deleted, as separate lists, since a
  list cannot name text it inserts): the split is undone on every copy;
- on the copy that saw the undo, a gallery picture added to the hidden beat and
  deleted, then text for the new beat: refused in one list as in separate
  lists, and the document stays undone; with a deletion in the source beat as
  the third operation instead, both give `abd` / `ef`;
- another writer adds a scene heading above the new beat: seen before the undo,
  the undo is used up; while the undo is in flight, the split stays and the
  heading is named `Q`; another writer's split of the source beat, putting a
  beat between the source and the new beat while the undo is in flight, keeps
  the split.

Covered by the predecessor part: a heading or a beat put between the source
beat and the new beat, including by a paste. Not a change to the new beat: the
source beat joined into the beat before it, and text pasted at the end of the
source beat; the new beat's text then still joins the source beat.

Declared limit: a change to the new beat that is taken back before the undo
arrives does not keep the split.

Declared limit: the predecessor passes over every marked boundary, also one whose
mark no longer holds. When another writer splits the source beat, undoes that
split and then adds a picture to its hidden beat while this undo is in flight,
the result is `a` / `bcd` / `ef` rather than `a` / `b` / `cd` / `ef`; all copies agree
and nothing is lost (literal in `undo-split.test.ts`).

Cost. All marks are read in one pass per part. The incremental projection
keeps each part until something it reads changes; the boundary and predecessor
parts follow the structure index's count of boundary changes per segment, so
typing reads no part again. The structure index keeps each part and reads
again only the part a change touched, and reads every mark once when it is
built. Pinned in `split-retirement-cost.test.ts`: typing one character beside 1
or 100 undone splits of one beat reads 0 observation entries; a fresh
projection reads 11 with 1 mark and 308 with 100.

Declared limit, retention: a redo deletes its mark, but a mark whose redo is
used up stays in `meta`. A later cut may delete it: the retention work in
section 6 of the collaboration plan (garbage collection, retained recovery
content and quotas). There is no retention clean-up today; only a redo deletes a mark.

A split also makes the new beat's empty visual (#1545). It stays stored with
the new beat while the split is undone and comes back with it on redo. Literal
in `split-visual.test.ts`: split, type V in the new visual, undo the typing,
undo the split, and the document and recovery equal the start on three
copies; the redo brings the visual back.

Declared, refused by name (`undo-unsupported:split`): a command with two
splits (a middle selection to its own beat, where the second split names the
first's new beat by an alias), and Enter inside a scene heading name.

Not undone yet: blank-beat creation, a heading created by paste and a
demotion. Blank creation and every pasted heading add an entry to the segment
order, which no operation takes back yet; a demotion also needs the heading
removal raced with it to show what its undo writes.

### Undo of a removal and a restore

A command with one beat removal records a `remove` part: the key of the
removal record this copy wrote (`sharedStructureIdentity` of the writer, the
operation id and `removal`) and the beats that stopped being live, read from
the live beats before and after the command. A command with one restore of beat
removals records a `restore` part: the key of its restore record, the beats
that became live, the removal's place and a fingerprint of those beats as the
restore left them: the stored beat with its fields, flags and joins, its status
and status events, its visual and gallery records, and every piece of its
joined row with characters and marks. A command with
more than one removal or restore, or a removal of another kind, records the
generic structure part.

Undo of a `remove` part runs `restore` on the removal. Restore writes nothing
for comments or for a beat split off unseen (rules 44 and 47), so they come
back with the beat, and text typed by someone who had not seen the removal
stays in it. It writes only while the removal is the one the beat shows: the
beat's flags are removed at the removal's generation. If someone else
restored it, or removed it again afterwards (rule 33), it is used up. Its
inverse is a `restore` part.

Undo of a `restore` part runs a new `remove` of the same beats (a new change,
rule 33). It observes each beat's characters as the row shows them, over the
row's painted length, so a split made at the same moment and unseen sends both
halves to recovery, as for an ordinary removal (rule 44). It writes only while
every beat is live and the fingerprint is unchanged; once anyone typed in it
or in a piece joined to it, formatted it, set a field or the status, changed
its visual column or records, joined another beat into it, or removed and
restored it, it is used up. When two writers removed a beat apart and undo
their removals in turn, the first brings it back and the second is used up;
when they undo at the same moment, both write and the beat is live. Its inverse is a `remove` part,
so a redo after an undone removal follows the same rule. Each case has a
literal in `undo-removal.test.ts` over in-order, reversed and duplicated
delivery and a late joiner, with the incremental projection compared after
every delivery.

### Undo of a heading removal and its restore

A `heading-remove` without a new beat writes a `header` removal record, so it
is recorded as a `remove` part naming the heading in `headings`, and a restore
of one header removal as a `restore` part naming it. The same rules as for a
beat apply: undo of the removal runs `restore` while the removal is the one the
heading shows (its `removal:` field is removed at the removal's generation),
and a name typed by someone who had not seen the removal comes back with it.
Undo of the restore runs a new `heading-remove` that observes the whole name,
only while the heading is live and nothing stored for it or for its scene's
first beat changed since the restore: the heading record, the name's characters
and marks, and the first beat as compared for a beat. Literals in
`undo-heading.test.ts`.

Not undone yet, each refused by name with a literal: a demotion (a
`heading-remove` with a new beat), because restoring the removal leaves the
name in the new beat and undoing the split has no operation yet; a heading
created by paste, because every paste that creates a heading also creates a
beat (`segment-create`); a command that removes a heading and a beat together;
and a restore of a heading removal and a beat removal at once.

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

The inverse of each is the opposite part, so redo follows the same table. The
choices made here are assumed rule 39 on the tracking issue:

- The undo of a creation is used up as soon as anyone changed the record. It
  never removes another person's change with it.
- A comment or reply keeps its author. Undoing your removal of another
  person's comment puts it back in that person's name.

Two things a record holds are not plain fields, and the record part carries
both in the form a command writes:

- **The status of a tag or shot** is set by status events beside the record.
  The part holds the status the record shows, so the undo of a creation is
  used up once another person set the status, and a removed tag or shot comes
  back with the status it had. A status change itself is a `status` part, as
  for a beat.
- **The props of a shot** are read as `{ key, rank, fields }` and written as
  `{ id, name }`. The part holds the written form, so a shot with props is
  restored, re-created and changed back like any other.
- **The video links of a picture** are read and written the same way as props,
  without their rank and their `extra` metadata.

A change to a picture's fields is a `record-field` part like any other
(`undo-picture-fields.test.ts`): its caption, annotation and image
(`picture`), its video links, the beat it belongs to and its place among
the beat's pictures (`rank`). The undo writes the earlier value while the
field still holds what the command wrote, so it is used up when another writer
changed that field first or removed the picture. A change to another field
of the same picture leaves it whole. A picture in a removed beat is changed
back in recovery and comes back with the beat. A picture field holds no
stamp, so there is none to leave.

Declared, not changed here:

- Undoing your removal of another person's comment restores its text as it
  was when you removed it. An edit its author made at the same moment as your
  removal is not in it.
- An undo of a field change and another writer's change to the same field
  that did not see each other are two sets of one key: the one from the higher
  client id stays, as for every record field ("A field" under
  [Rules an executor follows](#rules-an-executor-follows)). When the undo is
  from the higher client id, the other writer's value is replaced. One literal
  test pins each direction for a picture's caption.
- A link's `extra` metadata is not written back when the undo restores a link
  that was removed.
- A visual is part of a beat. Its undo comes with the structure commands; until
  then a record of one is refused by name (`undo-unsupported:record-create:visuals`,
  `undo-unsupported:record-field:visuals`) and nothing is written. The undo owner
  still keeps a refused entry on top of the stack today; owner rule 71 on the
  tracking issue changes that to skipping the step with a message, and that
  change is pending in the undo owner's own pull request.

#### Pictures

A picture added to a beat's gallery, and a picture removed from it, can be
undone (`undo-gallery.test.ts`). The undo of an added picture does not delete
its record. It writes `gallery-retire`, which puts a `retired` key in the
picture's own record holding what the undo saw:

- `observed`: every key of the record and of its nested maps, each with the id
  of the library item that holds its last write and whether that write was a
  deletion. The library keeps that id when older items merge into the latest,
  so every copy and a late joiner compute the same list.
- `seen`: the keys of the beat's removals the undo's copy held.

A picture is hidden while that key is there, the record still gives the same
`observed` list, and no removal of its beat outside `seen` lists the picture.
A rename, a new link or any other write to the picture changes the list, so a
change another writer made without seeing the undo shows the picture again on
every copy, in any delivery order. A removal of the beat made without seeing the
undo lists the picture, which brings it back with the beat; a removal made after
seeing it does not list it, because the attachment index leaves hidden pictures
out. A stamp is not written to a picture, and typing in its beat changes neither
check.

| Part | Its undo | Used up when |
| --- | --- | --- |
| `record-create` of a picture | `gallery-retire`: hides the record | the picture is hidden or no longer holds exactly the fields the command wrote, or its beat is removed |
| `record-retired` | `gallery-restore`: deletes the `retired` key, so the same record with the same content reference shows again | the stored retirement is not the one this undo wrote (its `observed` list is kept in the part), or it no longer holds |
| `record-delete` of a picture | creates the record with the fields it had | the record is stored, also when it is hidden |

A command is recorded against the stored picture, hidden or not. A change to a
hidden picture is a `record-field` part with the stored earlier value, never a
creation, and its undo is the field undo above: the field goes back and the
picture stays shown, because the change made the retirement no longer hold and
the add's undo is used up. A redo is bound to the retirement its undo wrote, so
a later retirement from another device is not taken back by it.

One read decides which pictures a beat shows, in
`src/adapters/collab/gallery-retirement.ts`, over stored state and over the
state an operation list plans. A staged write has no library item yet, so the
`observed` check cannot run on planned state. Instead each operation notes what
it does to a picture as it is prepared: `gallery-retire` hides it, because its
observation is taken as it applies; `gallery-restore` and any field write show
it, because they delete the retirement or change what it observed. A picture
with no note reads as stored. A removal later in the same list lists the
pictures that read shows, so one list and the same operations as separate lists
write the same removal (`undo-gallery.test.ts`, three list forms, and a check at
the end of every generated history).

| Consumer | Module | Reads |
| --- | --- | --- |
| Projection and recovery list | `projection-source.ts` | shown pictures |
| `readSharedRecords` | `record-reader.ts` | shown pictures; the recorder's stored reading |
| Attachment index | `structure-index.ts` | shown pictures |
| Removal preparation | `removal-executor.ts` | the planned read |
| Retire and restore preparation | `undo-handlers.ts` | notes the planned state; reads the stored record as it applies |
| Field writes | `record-executor.ts` | notes the planned state |
| Picture undo and redo | `undo-executor.ts` | shown pictures for the undo, the stored picture for the recorder and the redo's retirement |
| Split and restore guards | `undo-removal.ts` | shown pictures, without the retirement key |
| Identity occupancy | `structure-reservations.ts` | the stored record, hidden or not |
| Undone split watch | `split-retirement.ts` | the stored record, hidden or not, through its read view of the store |
| Preparation view | `prepare.ts` | stored state for every collection; pictures in it go through the planned read |
| Hydration | `hydrate.ts` | writes only |
| Incremental projection | `incremental-project.ts` | observes changes only |
| Text targets and scalar fields | `text-target.ts`, `scalar-executor.ts` | other collections only |

The deliberate exceptions read the stored record whether hidden or not. Identity occupancy: a hidden record is still
stored, so nothing is created over its key, a removal's undo does not recreate
it, and a field write addresses it. The undone split watch: a picture added to
the hidden new beat and then undone stays stored with its retirement, which counts
as a change to the new beat, so the split stays (declared). `tests/adapters/collab/gallery-reads.test.ts`
scans the adapter folder for direct reads of the stores and fails on a module not
in this table.

A hand-made `record-create` or `record-set` that names `retired` is refused
(`invalid-record-field`, `immutable-record-field`).

What garbage collection can and cannot remove: it replaces only the content of
a deleted item and keeps its id and length, so the id and deletion flag the
observation lists for each key survive collection, an encoded reload and a late
joiner. It replaces the items themselves only under a deleted parent, and the
observation never walks into a deleted nested map; a deleted picture record
takes its retirement with it. So collection removes only what the observation
does not read, never an entry it lists.

Cost: the projection reads the beat's removals only for a picture whose stored
keys include `retired`, so a document where no picture was undone reads nothing
more. Measured on the reviewer's probe, 100 retired pictures add 100 observation
checks to a keystroke that also writes the beat's stamp, none to narration-only
typing, and none when no picture is retired. The cache is left as it is.

What is kept, and for how long: one `retired` key inside the undone picture's
record. The redo deletes it; it goes with the record when the record is
deleted. A used-up undo leaves its key in place for as long as the record lives,
and nothing is written to `meta`.

The choices made here, assumed rules on the tracking issue:

- Only a removal of the picture's beat counts as a change to its beat. Typing,
  fields, status and joins in the beat do not use the undo up.
- An undo is used up when its copy shows the beat removed; the picture stays
  in recovery with the beat.
- A removal and restore of the beat made without seeing the undo still bring
  the picture back, although the beat stands again.
- A hand-made `record-set` on a hidden picture shows it again. The app cannot
  name a hidden picture.
- The redo of an undone removal hides the picture rather than deleting it, so
  the record stays stored.
- A link's `extra` field is not kept through a re-creation, as a shot's prop
  rank is not.

### The generator on the shared document

`tests/collab/undo/generator.test.ts` runs 300 seeded histories of 40 steps
with two writers and 300 with three writers and a late joiner, on the shared
document. A history draws every text, mark, field and status command, four
record commands on the five kinds of record (create, change, remove, and a
status on a tag or shot; a shot is created with props and half of its changes
change the props), undo, redo, and delivery in order, duplicated and
reversed. At the end every copy and a new joiner must hold the same script
and the same records.

After each undo and redo the run checks, against its own account and not the
document's:

- Only this writer's work changed.
- What came back is what the entry had taken away: the same characters, in
  the order they were taken. The run keeps the entry's characters from the
  snapshots before and after the command, and names the origin of each
  restored character itself; a copy that names another origin fails.
- No two characters this writer had seen together changed order. The run
  keeps, per writer, every pair it has shown that writer.
- A record that was as the command left it is afterwards exactly as it was
  before the command: every field, the author, the status and the props.
- An undo that replaces or removes a name, text or status another writer
  gave a record is a violation.

| Writers | Commands | Record commands accepted | Effective undo | Effective redo | Used up | Declared limit reached |
| --- | --- | --- | --- | --- | --- | --- |
| two | 5,581 | 2,060 | 1,300 | 506 | 24 | double-restore, 3 seeds; typed-beside-restored, 9 seeds |
| three, late joiner | 5,097 | 1,859 | 1,118 | 422 | 19 | double-restore, 7 seeds; typed-beside-restored, 12 seeds |

No other violation is reached. A record command the document refuses (a
second creation of a record that is there, a change to a record that is not,
a status for a tag or shot that is not there, another person's comment text)
is counted by its reason and changes nothing.

Not covered yet: structure commands other than a join, a beat removal and a
restore, which the owner refuses by name. Joins, removals and restores are not
drawn either: the model has neither, and adding a command changes the draw and
so every pinned count.
Formatting across a joined row is not drawn either: the generator's rows are
never joined and the model has no join, so it is covered by the literal tests
in `join-marks.test.ts`.
The adapter tests are in `tests/adapters/collab/undo-operations.test.ts` and
`undo-records.test.ts`.
