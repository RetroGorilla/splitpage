# E3: standard undo under simultaneous changes

Prototype only, Yjs 13.6.33, Node 24.22.1, 2026-11-18. Nothing ships.

**Verdict.** Standard `Y.UndoManager` holds for every command kind, compound commands, continuous remote updates
and 600 generated histories with no lost character or field, copies and a late joiner always agreeing, the expected
stack sizes and exactly one change notification per press that changes something, **provided undo never deletes a
created record or cell** (rule "keep-always", below). With the decided rule "keep it while it holds anything",
content in flight is lost. Formatting shows two undo-related differences (F1, F2); both come from the spike's
per-action keys, not from the undo manager.

## The layer (`layer.ts`, 166 lines)

One `Y.UndoManager` per copy over every root but `births`/`edited` (here: segments, beats, visuals, comments, people,
tags, shots, meta, order); `trackedOrigins` = the copy's own origin; `ignoreRemoteMapChanges` false; `undo()` called
directly, never inside `doc.transact`. Grouping is the app's rule from `src/application/editing/undo/history.ts`
(`record`): same cell, under 1,000 ms since the last keystroke, no replaced selection, and a word typed after a space
starts a new step; it calls the public `stopCapturing()` and leaves `captureTimeout` unlimited, so the clock is
injectable. Commands, undo and redo end the group. Bound: 200, by dropping `undoStack[0]` on `stack-item-added`
(no library option exists). The caret before each step is a relative position in stack-item `meta`, restored on
`stack-item-popped`. `deleteFilter` never deletes a created type (rule below). Absent status reads `todo`.

## Answers

1. **Compound command** (a beat flag, bold, record creation, typing; `compound.test.ts`). Remote typing in the
   same cell, identical bold over the same range, an edit of the created record and removal of the beat, made after
   seeing the command and made concurrently; then undo, redo, undo on A, B and C in turn. After every step all copies
   and a late joiner agree with the model; each press moves exactly one step between the presser's stacks (A: 1/0,
   0/1, 1/0, 0/1), nobody else's stacks change; one notification per press. A's undo keeps B's `Q`, B's record fields and C's bold and removal. One surprise for the
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
   - A bolds `bcd`, B unbolds `b`: A's undo passes over the bold step (see F1) and removes `x`; `cd` stays bold.
4. **Grouping and bound** (`grouping.test.ts`, `memory.ts`). `hello big world` typed 100 ms apart is three steps;
   a second's pause, another cell, a command, a replaced selection or an undo each start a step; backspace and other
   people's typing do not. 205 commands leave 200 undoable. Memory (`memory-results.json`): 20,000 editing
   operations (14,852 letters, about 4,300 backspaces, formatting, undo) on 30 beats: 83,348 bytes in the editing
   copy against 77,649 in a receiving copy and in a freshly loaded one; 4,838 deleted letters retained; identical with
   the bound and without; `clear()` frees nothing. Pasting and deleting a 10,000-letter block 100 times: 1,003,678
   bytes against 3,678 loaded, one byte per deleted letter, bound in force. **Rebuild** from stored state on entry and
   when the letters this copy's own commands deleted (countable from its tracked transactions' delete sets) pass
   1,000,000, at the next idle moment, telling the person undo history was cleared; ordinary typing needs millions
   of operations to reach it, deleting large pastes reaches it.
5. **Remote updates arriving continuously** (`stream.test.ts`, generated "continuous" pace): undo and redo between
   single remote updates delivered in order, reversed and twice; every remote letter stays; a group interleaved
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
field and the format default for its missing name. Cost: about 38 bytes per undone creation in stored state (14 for
a deleted record, 36 for a deleted split). Nothing reclaims it in v1: deleting it later reopens the same window; only
compaction could.

## Formatting under undo (reported, not failed)

- **F1**: B bolds `abcd`; A, having seen it, types plain `oo` inside (or unbolds part); B undoes: `cd` stays bold.
  The spike's `retire` gives the rest of B's run a key A owns. Also the cause of skip 6.
- **F2**: C types tagged `run`; A types tagged `s` after `u`, taking C's key; C undoes: A's `s` loses its tag.

Generated, 600 "keep-always" histories: 45 show a formatting difference from the person-level model; minimized,
25 need no undo (concurrent formatting with per-action keys, E4 and slice 2 ground, some possibly model limits) and
20 need undo or redo: 18 formatting that stays on after its undo, as in F1, and 2 marks on beat boundaries, which
nobody sees (`generated-results.json`).

## Evidence and its limits

Model (`model.ts`) imports neither Yjs nor the layer: characters by identity, map writes ordered by the library's
documented rule, formatting as a person sees it, each copy's stacks with the grouping rule restated. Values still
read from the implementation: positions a person acts at and the `seen` vector inside a removal (inputs); what each
copy has integrated (state vectors, delivered updates); Yjs ids of new items, bound to model ids after count, kind,
container, value and key match; restored items via the library's `redone` link (missing or extra restorations
fail); and, for presses where only formatting markers remain (149 of 2,425 and 145 of 2,361), which entry applied,
plus 5 formatting commands' changed or not. Controls (`controls.test.ts`) fail as required: no-op typing, undo, redo
and record-field write in memory; a dropped letter, a dropped field, a stack one short, an unsent change, a second
notification, a layer tracking remote origins, a filter deleting created cells. On a press, document observers and
the change notice run before the caret is restored (`meta.test.ts`); the spike's projection observer reads
`event.delta`, which opens one empty transaction that changes and sends nothing.

Generators: three copies, permuted client ids, 40 steps; typing (marked or plain), backspace and range delete,
replace, bold and tag on/off, status, length, remove/restore, join/unjoin, split, tag records, record fields,
compounds of 2 to 5 parts, undo, redo; delivery partial or continuous, each batch forward, reversed or twice; checks
every 15 steps with a late joiner. Not covered: headings, atoms, comments' anchors, composition, pictures, the server,
the app's editor; selections other than a caret; three or more writers on one record field outside generated runs.

Reproduce from `prototypes/collab`: `node --test test/native-undo/*.test.ts`; `node src/native-undo/memory.ts`;
`node src/native-undo/report.ts` (`--write` refreshes the JSON).
