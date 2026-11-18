# E3: standard undo under simultaneous changes

Prototype only, Yjs 13.6.33, Node 24.22.1, 2026-11-18. Nothing ships.

**Verdict.** With per-action formatting keys and the **keep-always** creation filter, standard selective
`Y.UndoManager` preserved characters and fields in the command tests and 600 generated histories. Copies and
late joiners agreed at every settled check. Applied presses emitted one Yjs `update` event and empty presses
emitted zero. The stack checks used Yjs's selected entry for 294 of 4,786 presses. With keep-holding, 38
generated losses came from writes still in flight. Both formatting key schemes show F1 and F2. The plain-key
comparison also had one undo press that emitted two updates.

## Standard Yjs and prototype policy

One `Y.UndoManager` per copy over every root but `births`/`edited` (here: segments, beats, visuals, comments, people,
tags, shots, meta, order). Standard Yjs use is a tracked local origin, the default `ignoreRemoteMapChanges: false`,
direct `undo()` and `redo()` calls, public `stopCapturing()` at command breaks, a `deleteFilter`, and a
relative caret captured before each edit and stored in stack-item `meta`. The layer resolves the caret on
`stack-item-popped`. Absent status reads `todo`.

- **Word grouping.** The app's rule in `src/application/editing/undo/history.ts` keeps keystrokes in one step
  within the same cell and under 1,000 ms apart. Replacing a selection or starting a word after a space breaks the
  group. The layer uses an infinite `captureTimeout` and calls `stopCapturing()` according to that rule, using an
  injected clock. This is an editing preference. Across nine timed 3,200-keystroke bursts on Node 24.22.1,
  median cost was 8.33 µs per key, compared with 8.07 µs under Yjs's default capture window, a measured
  increment of 0.26 µs per key. The samples overlap. The histories held 600 and 1 in-memory entries.
  Both policies encoded 6,881 bytes for 3,710 stored characters, so grouping added zero encoded bytes per
  stored character.
- **Keep-always.** The filter keeps created records and visual cells on undo (reproduction and cost below).
  Yjs runs the filter while undoing or redoing, so the filtering rule adds no work to an ordinary keystroke.
  In the same typing benchmark the keep-always and keep-holding medians were 8.33 and 8.37 µs per key,
  with identical encoded bytes.
- **History depth.** Removed the 200-entry cap implemented with `undoStack.shift()`. Yjs exposes no public
  depth bound. Shifting bypassed its cleanup and saved no encoded bytes in the previous A/B. The test now
  undoes all 205 steps.

## Answers

1. **Compound command** (a beat flag, bold, record creation, typing; `compound.test.ts`). Remote typing in the
   same cell, identical bold over the same range, an edit of the created record and removal of the beat, made after
   seeing the command and made concurrently; then undo, redo, undo on A, B and C in turn. After every step all copies
   and a late joiner agree with the checked expectations. Each press moves exactly one step between the presser's
   stacks (A: 1/0, 0/1, 1/0, 0/1). Other stacks stay the same. The first undo fires observers on the segments, beats
   and tags roots and emits one Yjs `update` event. A's undo keeps B's `Q`, B's record fields and C's bold and removal. One surprise for the
   record: after A undid creating `T1` (name `Alpha`, colour red) and B undoes its own recolouring, `T1` reads
   `{colour: red}`: B's undo restores the value B overwrote, which was A's.
2. **Each kind alone** (`kinds.test.ts`): typing, deleting, formatting, unformatting, split, join, remove, restore,
   status, tag, record creation, record edit, each with a remote change in between, undo/redo/undo: all pass with
   hand-written expected rows and the model.
3. **The standard skip** (`skip.test.ts`), in what a person sees, `abcd` and an older step that typed `x`:
   - A and B set `ready` at once and B's write stands: A's undo leaves `ready` and removes `x` in the same press.
   - The same, A's write stands: A's undo leaves no status (shown `todo`, also B's identical value); redo gives
     `ready`.
   - A types `abc` and deletes it within one group: that step is passed over; the press removes `x`.
   - A and B bold `ab` at once: A's undo changes nothing visible (B's bold stays), B's undo clears it.
   - B set `shot` after seeing A's `ready`: A's undo passes over its status step and removes `x`; status `shot`.
   - A bolds `bcd`, B unbolds `b`: with per-action keys A's undo passes over the bold step and removes `x`.
     With plain keys it applies the bold entry and leaves `x`. In both cases `cd` stays bold.
4. **Grouping and retention** (`grouping.test.ts`, `memory.ts`). `hello big world` typed 100 ms apart is three steps;
   a second's pause, another cell, a command, a replaced selection or an undo each start a step; backspace and other
   people's typing do not. Memory (`memory-results.json`): 20,000 editing
   operations (14,852 letters, about 4,300 backspaces, formatting, undo) on 30 beats: 83,348 bytes in the editing
   copy against 77,649 in a receiving copy and in a freshly loaded one. The editing copy keeps 4,838 deleted
   letters. `clear()` leaves the encoded size unchanged. Pasting and deleting a 10,000-letter block 100 times
   took 1,003,678 bytes against 3,678 loaded, one byte per deleted letter. **Rebuild** from stored state on entry and
   when the letters this copy's own commands deleted (countable from its tracked transactions' delete sets) pass
   1,000,000, at the next idle moment, telling the person undo history was cleared; ordinary typing needs millions
   of operations to reach it, deleting large pastes reaches it.
5. **Remote updates arriving continuously** (`stream.test.ts`, generated "continuous" pace): undo and redo between
   single remote updates delivered once or twice. Every remote letter stays. A group interleaved
   letter by letter with another person's undoes only its own.

## Creation rule (coordinator's corrections)

Crossing history, shortest form: A splits `abcd` after `b` (or creates a person, tag or comment); B types `V` in the
new visual cell (or sets a field); A undoes before B's update arrives. With "keep while holding" the cell was empty on
A, the filter let it go, and `V` is gone on every copy (`creations.test.ts`; 38 losses in 600 generated histories, all
of this kind). Stale target: B splits, A holds the new cell, B undoes and redoes, A writes `Y` through its reference:
gone, because redo made a new cell. A rule that keeps no container cannot close this window: the library deletes
every item integrated into a deleted type, and at the moment of undo no copy can know what is in flight.

**Rule held: undo never deletes a created record or cell; it takes back only what its creator wrote into it.** Both
histories then keep `V` and `Y`, and redo gives back the same object. What a person sees: an undone split leaves no
row; another person's text in the cell is listed in recovery and returns with redo; an undone record nobody touched
is an empty map, not shown (reader rule in `readRecords`); one holding another person's field is shown with that
field and the format default for its missing name. In the fresh encoded copy, keep-always cost 37.67 bytes per
undone record and 38.05 per undone split, 23.68 and 2.54 more than keep-holding. In the fixture with 800 stored
characters and 100 undone creations, those increments are 2.9600 and 0.3175 bytes per stored character respectively.
Ordinary typing added zero encoded bytes per stored character from this filter. Deleting the containers later
reopens the same window.

## Formatting under undo (reported, not failed)

- **F1.** B bolds `abcd`, A sees it and types plain `oo` between `b` and `c`, and B undoes. Both schemes give
  `aboo[cd]`, where brackets indicate bold.
- **F2.** C types tagged `run` between `x` and `y`, A types tagged `s` after `u`, and C undoes. Both schemes give
  `xsy` with the tag gone from `s`.
- **Skip.** A types `x` in front of `abcd`, then separately bolds `bcd`. B sees this and unbolds `b`. A undoes.
  Per-action keys give `ab[cd]` with A's stacks at 0/1. Plain keys give `xab[cd]` with A's stacks at 1/1.
  Copies and a late joiner agree in all three named histories under both schemes.

Each scheme ran 600 keep-always histories. The press-level probes count an F1 when an explicit format entry
is undone and a letter retains a mark the model expected to clear. They count an F2 when another person's
surviving letter loses a tag that shared a source with the undone text. They sample immediately on the
presser and at the next settled check. The skip count is a skipped entry with a predicted formatting effect.

| Key scheme | F1 presses | F2 presses | Formatting skips |
| --- | ---: | ---: | ---: |
| Per action | 14 | 0 | 1 (continuous seed 130) |
| Plain | 17 | 0 | 0 |

In the broader settled mark comparison, 45 per-action histories and 61 plain-key histories differed from
the person-level model. Of the 45 per-action histories, minimization found 25 that required no undo or redo,
18 with residual marks on letters and 2 affecting only beat boundaries. Some differences can reflect model
limits. See `generated-results.json`.

## Evidence and its limits

The model imports neither Yjs nor the layer. It starts from fixed plain text, beat order and status, then binds
those values to the hydrated identities. It independently models map writes, text identity membership and values,
format effects at the person level, and stacks. Each local write checks the affected sequence of character
identities, values and marks against the command's expected transformation. It checks compound parts as they happen
and again after the outer transaction. Presses check expected text deletions and restorations immediately and check
the whole local document's content when there are no pending integrations. Row order is checked against the model's
join and removal projection, using the fixed segment order and the underlying CRDT boundary sequence. Recovery
output is compared across copies and covered by hand-written cases.

The generator picks valid actions and positions from the implementation's current beats, cells, flags and records.
Each command's local check starts with the copy's visible sequence and marks immediately before the edit. Later
compound parts can use earlier implementation writes as inputs. The model still reads the `seen` vector embedded
in removals, state vectors and delivered updates, and assigned item ids after checking the item's kind, container,
key and value. It binds restored items through Yjs's `redone` link and checks for missing or extra restorations.
The text membership comparison does not independently predict full CRDT sequence order after concurrent delivery
or restoration. For split boundaries it checks that any surviving anchors still bound the split's gap, then uses
the raw boundary order within segments as projection input.

The model cannot predict which formatting marker changes will apply a stack entry. When it predicts no character
or field effect and markers might change, it uses the library's selected entry to decide the expected stacks.
This happened on 294 of 4,786 per-action keep-always presses, including 275 of 3,335 undos and 19 of 1,451 redos.
For local commands the harness settles the model entry using update presence and checks it against the model's
prediction. It recorded five formatting-related disagreements in these histories. For plain keys there were
281 presses that used the selected entry and 131 commands where the outcome disagreed with the model.

The counted event is `Y.Doc`'s `update`. The harness observes it directly and checks it against the layer's
counter. All 3,041 applied and 1,745 empty per-action keep-always presses met the one-or-zero check. With plain keys, continuous seed 254
emitted an update from the manager and a second from Yjs formatting cleanup during one undo. The strict check
rejects that press. The recorded comparison continued through all three settled checks and saw no loss or divergence.
Document observers and the update run before caret restoration. The projection observer's separate empty
transaction when reading `event.delta` emits no update.

The no-op controls ran the same 600 histories. “Used” means at least one effective write in the unmodified
history. For formatting this includes turning on a fresh per-action key even if the visible mark was already
present. Formatting was called in 597 histories. The two additional redo failures were empty presses: muting
one left an exhausted entry on the stack, and muting the other failed to break the typing group.

| Muted command | Used | Failed among used | Other failures |
| --- | ---: | ---: | ---: |
| Typing | 600 | 600 | 0 |
| Deleting | 576 | 576 | 0 |
| Formatting | 591 | 591 | 0 |
| Split | 543 | 543 | 0 |
| Join or unjoin | 411 | 411 | 0 |
| Record field write | 443 | 443 | 0 |
| Undo | 594 | 594 | 0 |
| Redo | 159 | 159 | 2 |

The erase control now catches continuous seed 167 (`pp ` to `p ` in a split beat's visual cell).
The other controls catch a dropped character or field, a short stack, an unsent edit, an extra update,
a disabled update counter, identical incorrect row order on every copy, a remote origin accidentally tracked
for undo, and a filter that deletes a newly created cell.

Regression tests cover a person hydrated as a shared `Y.Map` with undoable fields, one emoji represented by
two UTF-16 identities, and restoring the caret to index 3 when undo restores `bc` in `abcd`. Capturing the
relative position before the deletion fixes the caret using the usual metadata pattern.

Generators: three copies, permuted client ids, 40 steps; typing (marked or plain), backspace and range delete,
replace, bold and tag on/off, status, length, remove/restore, join/unjoin, split, tag records, record fields,
compounds of 2 to 5 parts, undo, redo; delivery partial or continuous, each batch forward, reversed or twice; checks
every 15 steps and at the end with a late joiner. Coverage is limited to three copies, two starting beats,
40 steps, short ASCII edits and unique generated ids. The generator omits long offline undo histories and
histories crossing a depth bound. The one-update batches in `stream.test.ts` give forward and reverse the
same order. Other omissions include headings, atoms, comment anchors, composition, pictures, the server,
the app's editor, selections other than a caret, and targeted cases of three or more writers on one field.

Reproduce from `prototypes/collab` with `node --test "test/native-undo/*.test.ts"`,
`node src/native-undo/memory.ts`, `node src/native-undo/memory.ts --timing` and
`node src/native-undo/report.ts`. Pass `--write` to refresh the JSON reports.
