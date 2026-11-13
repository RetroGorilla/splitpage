# Commit-time writers

In a standalone session a commit also writes things the person did not state: who
changed a beat and when, records made from typed text, repaired comment anchors,
save stamps. In a shared session each of them is either a derivation (the
projection computes it from shared state, the same on every copy, never stored) or
an explicit operation in the list the command emits (stored once, by the copy that
made the edit). Nothing is written as a side effect of applying or receiving a change.

`tests/application/commit-time-writers.test.ts` holds the inventory. This first cut
changes no behaviour: it names every writer and its class. The pull requests that
follow make the shared path match the table, one family at a time.

## What the table holds

`WRITERS` has one entry per kind of writer, with its family (attribution, records,
anchors, other), its class in a shared session and the reason. The classes are
derivation, operation, not applicable and undetermined. Undetermined means the
decided and assumed rules do not say; nothing is built for such an entry until
they do.

The site tables list where each writer lives, and the test fails when the code and
a table differ in either direction:

| Table | What the scan finds |
| --- | --- |
| `STEPS` | In the two session owners, every call that hands the mutable document to something, receives one, or reaches a named engine |
| `FIELDS` | In any module under `src/`, every write of a who, when, placement or paragraph field: see below |
| `RECORDS` | Every write of a record collection (tags, shots, people, comments, a comment's replies): replacement, a mutating array call, an indexed write, a truncation, and a call to a generic appender that pushes into its argument, listed at the call site |
| `COMPUTED` | Every write whose field name is known only at run time, to a beat, a record, a reply or the document, or to a type one of them is assignable to, looking through casts; in the projection modules also to an open bag (`open`), and every merge or spread from one |
| `ENGINES` | Every use of a function or port member that makes records, placement or attribution from text, or builds, recognises or reads a shared beat stamp, and every place that provides or reads a command's shared operation list: in an object literal or a spread, as a class member under `implements`, by destructuring or by element access |
| `DOORS` | Every module that reaches the standalone session's `stamp`, `amend` or `noteEdit`, from the typed inventory of `session-caller-scan.ts` |

A field write in `FIELDS` is any of these:

- an assignment, compound assignment, increment or removal by name, constant key or
  union key, also through a cast;
- a key in an object literal, except a literal `true` (a table of names);
- a field carried by the source of an `Object.assign` into a value of a watched
  type, or by a spread into a literal of a watched type;
- a write into a sub-object of a watched field, such as `personColors[name]`;
- a call to a generic setter that writes its argument (`put(row, "updatedAt", at)`),
  listed at the call site with the key the call passes.

`personColors`, `rowId` and `field` count in a literal only when the literal is
merged by `Object.assign` or has a watched type. `docId` counts only on the
document, and `name`, `desc` and `owner` only on tags and shots (`desc` on shots),
or on an open-indexed type that one of them is assignable to, such as a `Partial`.

The scan resolves names with the type checker: a renamed import, a constant or
union key, a `Pick` of a port and a collection held under another name are all
found, and each form has a self-test on a probe module.

## What the scan does not see

- A write inside a helper that is not generic is listed at the helper. Its callers
  are listed only when the helper is a named engine.
- A port that a feature declares again under its own interface is followed by the
  wiring, not by the scan. `stampRow` reaches three features this way.
- A field name known only at run time on a loose bag (`Record<string, unknown>`,
  `any`) outside the projection modules, and a merge from such a bag there.
- A whole value of a watched type copied or merged: it carries every field and
  writes none.
- Field names are matched by name. A module that builds an export row with a
  `createdAt` key is listed and classed as no write to the document.
- `Reflect.set`, `Object.defineProperty`, a borrowed array method such as
  `Array.prototype.push.call`, and a destructuring-assignment target such as
  `({ a: row["updatedAt"] } = src)`. A self-test pins that the first, third and
  fourth find nothing.
- Counts are per top-level function. A write removed and another of the same field
  added in one function leave the count, and so the test, unchanged.

## Cases the rules do not decide

Four entries are undetermined. Each lists what a person would see.

| Writer | Options |
| --- | --- |
| A person's colour | (a) Each copy writes its own person's chosen colour once, keyed by name, so everyone sees it; two people with one name share an entry. (b) Colours are not stored and each copy derives one from the name; a chosen colour shows only to the person who chose it. (c) Colours wait for presence in Stage 5; until then the colours the script had when it was shared are shown and new people get the default. |
| A sound cue's entry following its edited words | (a) The editing copy renames the entry when its edit turns one cue into another. Two people editing the same cue at once can leave the old entry unused and a new empty one. (b) Each cue gets a stored identity so its entry follows any edit; this changes the stored format. (c) No rename: an edited cue is a new entry and its owner and notes are entered again. |
| A tag's owner following `@Name` on a line | (a) The editing copy sets or clears the owner when its edit adds or removes the pairing. Two different pairings made at once leave one owner by the fixed rule while the text shows both. (b) The shown owner is derived from the text whenever a pairing exists, and the stored owner is used only when none does; the owner picker then has no effect while a pairing exists. |
| Sentence paragraphs on first opening the Writer | (a) The first copy that opens the Writer writes them, once, as a command nobody typed. (b) They are derived until someone makes the first paragraph edit, which then writes them all; until then they follow the text as it changes. |

For the tag owner, a standalone script today behaves as follows. A person pairs a
tag with `@Sam` on a line, so Sam owns the tag. They pick Ann in the owner picker,
which writes only the tag's owner and leaves the text alone. Then they type elsewhere
in the beat. The tag still shows Ann, while the line still says `@Sam`. Owner sync
(`planOwnerSync` in `src/core/production/owners.ts`) acts only when the count of a
pairing changes: typing that keeps the pairing plans nothing, and typing in the
narration column is not read at all. The owner changes again only when a new
occurrence of a pairing is typed (it assigns that person) or the last one is
deleted (it clears the owner, unless the owner was changed since).
`tests/core/production/owners.test.ts` pins this at the planner level, in "owner
sync: an edit that keeps the pair leaves a panel change alone" and "owner sync:
deleting the chip keeps an owner the Production panel changed since". No test
runs the whole sequence through the picker command and the session.

Three more cases sit under entries whose class is determined:

- Two people change one beat at the same moment. One name stays on every copy:
  the one whose stamp has the later time, then the later name ([Stamps](#stamps)).
- A B-roll line is deleted. The shot keeps the name stored when it was created or
  last renamed by hand, not the last words of the line.
- The same comment anchor in both columns of one beat. A normal script places the
  comment in the visual column, and so does the shared assembly: within a beat it
  places comments from the visual cells before the narration, beat by beat in
  script order. `tests/adapters/collab/comment-anchor-columns.test.ts` holds this
  for the full projection on every copy and for the incremental projection
  against a fresh full one.

## The recovery write

One writer is an operation that no command stated. When the document refuses
buffered typing, the buffer writes the field to recovery as a list of its own: a
beat created and removed in the same list ([the rule 29 recovery write](stage-2-buffer.md#the-rule-29-recovery-write)).
`recovery-write` names it, class operation. It has two sites in `ENGINES`:

| Site | What it does |
| --- | --- |
| `createSharedBufferedText` in `adapters/collab/buffer.ts` | Provides a second shared list beside the commit's; its plan declares `undo: false` |
| `createSharedSession` in `application/session/shared-session.ts` | Reads that declaration when it delivers the change, and does not tell the undo port |

The list goes through the session's one `execute` like any other, by the copy whose
typing was refused; receiving it writes nothing. With it the table holds 30 writers:
6 derivations, 11 operations, 9 not applicable and 4 undetermined.

## Records made from Writer typing

Writer typing reaches the document as one buffered commit of a beat's narration.
In a normal script the commit then registers every tag the script shows without a
registry entry, cues included. In a shared session the commit's own list carries a
`record-create` for each tag the commit introduced: one the cell shows after the
edit, did not show unregistered before it, and that has no entry. The id and fields
are the ones a normal script mints (`newRegistryTag`), so two copies that introduce
the same tag at once create one entry. A tag the cell already showed unregistered
is not registered again, and a copy that receives the list writes nothing more.
`sharedTagsIntroducedByText` in `core/collab/text-records.ts` builds the list and
`createSharedBufferedText` calls it; `tests/collab/buffer-text-records.test.ts`
holds it. The operation writes `cat`, `name` and `status`; a normal script also
writes an empty `owner` and `notes`, which the readers give by default.

Declared consequences:

- Editing a cue's words gives a second entry. Before the edit the beat shows
  `SFX: door slam` with an entry; after it, `SFX: door slams`. The shared commit
  creates a new entry "door slams" and leaves "door slam" with its owner, notes
  and status, used by nothing. A normal script's `planRegistryHealing` renames the
  entry instead, keeping its id and fields.
- Once undo is wired, undoing the typing that created an entry removes the entry
  while it still holds the fields the commit wrote, even if another beat now uses
  the tag (assumed rule 39). That beat's tag then shows unregistered, and later
  commits in that beat do not register it again, because the beat already showed
  it unregistered. A normal script registers it at its next commit.
- When another beat shows the tag unregistered in another case (`chair`) and
  `Chair` is typed, the entry takes the typed name, where a normal script takes
  the first mention in the script.

Not built here:

- people from `@Name`, shots from B-roll lines and owners from pairings. They are
  read only from the visual column, which Writer typing does not edit. People
  have a builder for visual edits: "People from @Name".
- renaming a sound cue's entry when its words change, which is undetermined.
- the replica that runs these lists in the app. It must register the record
  handlers, or a commit that introduces a tag is refused as a whole.

## Stamps

A beat's stamp is who changed it last and when. In a shared session it is an
explicit step of the edit's own list: a `scalar` operation on the beat's `stamp`
field with `{at, by}`, the editor's name and the time of the commit. Writer typing
reaches the document as one buffered commit per run of typing in a beat, so that
commit carries one stamp, and only when it changes the text.
`sharedBeatStamp` in `adapters/collab/stamp.ts` builds it and
`createSharedBufferedText` appends it. A copy that receives the list writes nothing.

Each copy stores its stamp under a key of its own in the beat (`stamp:` and the
copy's writer id, so a later stamp from the same copy replaces its earlier one and
two copies whose commands share an author id still write two keys), and the copy
that writes it removes every stamp it has seen. The rule that decides what the beat
shows:

- A stamp replaces every stamp its copy had seen when it was written, even if its
  clock is behind.
- Stamps written without seeing each other are all kept. The beat shows the one
  with the later time; at the same time, the later name; both compared as text.
  A stored stamp under a `stamp:` key counts only if it has the form a stamp
  operation may write (a text time, a text or empty name).

The rule reads only the stamps themselves, so delivery order and the copies' client
ids do not change which one is shown; the client id only names each copy's key. A plain scalar set would leave the native register
winner, which depends on client ids; the stamp is the one scalar read this way.
A beat holds at most one stamp per copy that wrote without seeing the others. The
stamp a beat was created or hydrated with stays under `stamp` until the first stamp
step removes it, so a beat no step has stamped is read with one lookup; after that
the reader lists the beat's keys.
`tests/collab/buffer-stamps.test.ts` holds the rule over four delivery orders,
with the names swapped between the copies and with one author id on both copies.

Other commands send no shared list yet; each one that does adds its stamp the same
way.

## Stamp on undo

Settled as assumed rule 35: in a shared session undo leaves the stamp as it is. The
stamp is not part of an undo record, so undoing neither restores an earlier stamp
nor writes a new one, and stamped typing keeps coalescing into its typing groups.
The shared undo executor records no part for a stamp operation;
`tests/collab/buffer-stamps.test.ts` pins that two stamped keystrokes form one
group and that undoing it leaves the stamp on every copy.

In a normal script, undo and redo stamp a beat they change through a field step,
except a `paragraphStart` step, with the person and time of the undo. A beat that
undo puts back is not stamped.

## Comment stamps

Assumed rule 49 on #1414: a comment's resolution follows the stamp rule. In a
shared session the comment commands in `application/commands/comments.ts` send
their own record operations when given a shared author; their callers in
`features/comments` pass none yet (package 14).

- Adding a comment or a reply is one `record-create` each. `createdAt` is written
  once with the record; the record executor refuses any later change to it.
- Resolve and reopen send a `record-set` of the comment's `resolution-stamp` with
  `{at, by, resolution}`. The record executor stores it as `resolution:` and the
  copy's writer id, removing every resolution it has seen, as a beat stamp does,
  and the record reader shows the later time, then the later name. A stored entry
  counts only if a step could have written it. The hydrated `resolution` stays
  until the first such step. A plain `resolution` beside stamp keys shows instead
  of them, until the next resolve or reopen step; no command sends one today.
- A reply, an assignee change and a resolve or reopen also set `updatedAt`. No
  command edits a comment's body, so `updatedAt` is a plain field: of two written
  without seeing each other, the stored-field winner shows, as for any record
  field, not the later time. If a body edit command is added, this needs the
  stamp rule too.
- `updatedAt` and the resolution are left out of the undo record (assumed rule 35).
  A resolve or reopen holds only these, so its plan declares `undo: false` and the
  session records no undo entry for it; undo after an assignee
  change puts the assignee back and leaves both.

`tests/adapters/collab/comment-stamps.test.ts` holds these over four delivery
orders.

## People from @Name

In a normal script a commit gives a person record to each `@Name` that no line of
the script held before the commit and that no person has, compared without case.
In a shared session the copy whose edit of a beat's visual cell typed the name
puts a `record-create` of `people` in that edit's list.
`sharedPeopleIntroducedByText` in `core/collab/text-records.ts` builds it. It runs
the same plan as a normal script (`planOwnerSync`) on the script with the cell
before and after the edit, and mints with `addPerson`, so the id and the capped
name are the ones a normal script stores. The operation writes `name`. No caller
uses it yet; the callers come with package 14.
`tests/collab/people-text-records.test.ts` holds it.

Declared limits:

- A normal script also gives a person to a name that a new pairing with a tag
  uses when no person has that name, even if the script held the name before.
  That person exists only so the tag can have an owner, so it waits for the owner
  rule, which is undetermined (see "Cases the rules do not decide").
- The same new name typed on two copies at once gives two people with different
  ids, as the inventory row for `person-from-name` declares.
- A person's colour is not written here. That is `person-colour`, which is
  undetermined.
