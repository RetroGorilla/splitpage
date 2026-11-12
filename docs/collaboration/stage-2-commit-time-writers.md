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
| `ENGINES` | Every use of a function or port member that makes records, placement or attribution from text, and every place that provides or reads a command's shared operation list: in an object literal or a spread, as a class member under `implements`, by destructuring or by element access |
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

- Two people change one beat at the same moment. The stamp is one value, so one
  name stays on every copy, chosen by the fixed rule of assumed rule 23, not by
  the later clock time.
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

## Stamp on undo

Settled as assumed rule 35: in a shared session undo leaves the stamp as it is. The
stamp is not part of an undo record, so undoing neither restores an earlier stamp
nor writes a new one, and stamped typing keeps coalescing into its typing groups.

In a normal script, undo and redo stamp a beat they change through a field step,
except a `paragraphStart` step, with the person and time of the undo. A beat that
undo puts back is not stamped.
