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
| `FIELDS` | Every write of a who, when or placement field, by assignment or in an object literal, in any module under `src/` |
| `RECORDS` | Every write of a record collection (tags, shots, people, comments): replacement, a mutating array call, an indexed write |
| `COMPUTED` | Every write to a beat, a record or the document whose field name is known only at run time |
| `ENGINES` | Every use of a function or port member that makes records, placement or attribution from text, and every place that provides or reads a command's shared operation list |
| `DOORS` | Every module that reaches the standalone session's `stamp`, `amend` or `noteEdit`, from the typed inventory of `session-caller-scan.ts` |

The scan resolves names with the type checker: a renamed import, a constant or
union key, a `Pick` of a port and a collection held under another name are all
found, and each form has a self-test on a probe module.

## What the scan does not see

- A write inside a core helper is listed at the helper. Its callers are listed
  only when the helper is a named engine.
- A port that a feature declares again under its own interface is followed by the
  wiring, not by the scan. `stampRow` reaches three features this way.
- A field name known only at run time is counted when the receiver is typed as a
  beat, a record or the document, and not when it is a loose bag.
- Field names are matched by name. A module that builds an export row with a
  `createdAt` key is listed and classed as no write to the document.

## Cases the rules do not decide

Five entries are undetermined. Each lists what a person would see.

| Writer | Options |
| --- | --- |
| Stamp on undo | (a) An undo stamps the beat with the person who undid, as in a normal script. (b) An undo puts back the stamp from before the undone change, unless someone else changed the beat since. (c) An undo leaves the stamp: the beat keeps the name of the person whose change was undone. |
| A person's colour | (a) Each copy writes its own person's chosen colour once, keyed by name, so everyone sees it; two people with one name share an entry. (b) Colours are not stored and each copy derives one from the name; a chosen colour shows only to the person who chose it. (c) Colours wait for presence in Stage 5; until then the colours the script had when it was shared are shown and new people get the default. |
| A sound cue's entry following its edited words | (a) The editing copy renames the entry when its edit turns one cue into another. Two people editing the same cue at once can leave the old entry unused and a new empty one. (b) Each cue gets a stored identity so its entry follows any edit; this changes the stored format. (c) No rename: an edited cue is a new entry and its owner and notes are entered again. |
| A tag's owner following `@Name` on a line | (a) The editing copy sets or clears the owner when its edit adds or removes the pairing. Two different pairings made at once leave one owner by the fixed rule while the text shows both. (b) The shown owner is derived from the text whenever a pairing exists, and the stored owner is used only when none does; the owner picker then has no effect while a pairing exists. |
| Sentence paragraphs on first opening the Writer | (a) The first copy that opens the Writer writes them, once, as a command nobody typed. (b) They are derived until someone makes the first paragraph edit, which then writes them all; until then they follow the text as it changes. |

Three more cases sit under entries whose class is determined:

- Two people change one beat at the same moment. The stamp is one value, so one
  name stays on every copy, chosen by the fixed rule of assumed rule 23, not by
  the later clock time.
- A B-roll line is deleted. The shot keeps the name stored when it was created or
  last renamed by hand, not the last words of the line.
- The same comment anchor in both columns of one beat. A normal script places the
  comment in the visual column; the shared derivation must do the same.
