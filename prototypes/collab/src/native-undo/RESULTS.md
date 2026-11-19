# E3: standard undo under simultaneous changes

Prototype only, Yjs 13.6.33, Node 24.22.1, 2026-11-18. Nothing ships.

**Verdict.** With per-action formatting keys and the **keep-always** creation filter, standard selective
`Y.UndoManager` preserved characters and fields in the command tests and 600 generated histories. Copies and
late joiners agreed at every settled check. Applied presses emitted one Yjs `update` event and empty presses
emitted zero. The stack checks used Yjs's selected entry for 294 of 4,786 presses. With keep-holding, 38
generated losses came from writes still in flight. Both formatting key schemes show F1 and F2. The plain-key
comparison also had one undo press that emitted two updates.

## Follow-up with the chosen keys

**Verdict.** E3 holds for characters, record fields and agreement with keep-always, including under selective
undo and redo. It does not hold for production tags. The chosen scheme lost four explicitly requested tags at
settled checkpoints in each delivery order. In one of those histories undoing a plain insertion cleared part of
someone else's tag. In the other three, tags placed on text concurrently deleted and restored by another
copy did not follow that text onto its restored identities. The original one-update rule also fails.

The chosen mode uses plain attributes for simple marks, `c:<commentId>` for comment marks and a
`t:<tagId>` attribute with a writer-and-clock suffix for each tag application. In this experiment, insertion
with an explicit tag counts as an application and gets a key of its own, even inside a seen tag. The existing
unformat path still clears the selected keys and re-keys any surviving tails. One standard `Y.UndoManager`
per writer handles undo and redo. No cleanup gets filtered out of the update stream.

### The 131 command disagreements

The original counter compared the presence of a local Yjs update with a person-level model that assumed
per-action writes. The new model predicts display changes from the selected characters and the requested
state. It also predicts whether a plain-key command will rewrite a live marker, using the ordered markers
present before the command. The harness checks the resulting marks, character identities and values immediately
after each part and at the end of the command. There were zero update-presence mismatches with this prediction
under plain or chosen keys, including the marker rewrites. These classifications apply to the original counter.

| Class and cause | Per action | Plain | Chosen |
| --- | ---: | ---: | ---: |
| A · Redundant simple on. The selection already shows the mark and the call makes no write. | 0 | 102 | 102 |
| A · Redundant tag on. A plain tag key behaves like a plain bold key. | 0 | 23 | 0 |
| A · Pending integration. In batched 29, B tries to unbold `b` after getting C's dependent update, before the dependency arrives. B still sees plain `b` and the command writes nothing. | 1 | 1 | 1 |
| A · Restored marks. In continuous 103 and 264, the old model omits tags or bold on restored characters. Turning the visible marks off writes normally. | 2 | 2 | 2 |
| B · Bold covers previously plain typing when the other copy restores a deletion across the formatting boundary, batched 142. | 0 | 1 | 1 |
| B · Undo of bold typing leaves bold on later plain text, continuous 101. | 1 | 1 | 1 |
| C · A tag covers two plain characters outside the author's selection, batched 31. | 1 | 1 | 1 |
| Total A / B / C | 3 / 1 / 1 | 128 / 2 / 1 | 105 / 2 / 1 |

The display-based label hides earlier unexpected bold in seven of the 102 redundant simple-on commands in
each column, four on restored text and three on typing pulled into a bold range, including batched 170.

- **B, restored boundary.** Start with `ghij` and client ids A=1, C=3. C bolds `gh`, deletes `ghi`
  and undoes that deletion. A, who has yet to see C's writes, inserts a plain `l` between `h` and `i`.
  Reverse delivery settles on `[ghl|b]ij` on every copy. The excess bold stays until someone removes it.
- **B, undo of marked typing.** Start with `vw` and client ids A=2, B=1, C=3. B replaces `vw` with
  identical plain text and sends it to C. C types bold `rpz` before `v` and syncs. A inserts plain
  `u ` between `r` and `p`, and C undoes its typing before receiving A's insertion. The plain-key and
  chosen copies all settle on `u [vw|b]`. Nobody bolded `vw`, and the bold stays until someone removes it.
  The generated history settles on `zu [mo|b]` if settled before B's unbold command.
- **C, wrong assignment.** Start with plain `vw`. A selects only `w` and applies `T1`. Unseen by A,
  B types plain `mm` just before `w`. Both writers and a late joiner show `v[mmw|T1]`. B untags
  only `mm` and all show `vmm[w|T1]`. The flagged command was B's correct removal. The wrong
  write was the preceding expansion of A's tag onto B's plain text. This case reproduces under both key forms.

The new prediction also accounts for seven display-neutral marker rewrites under plain keys and four under
chosen keys. These were outside the 131 and 108 because the old model predicted an update for their outer
command. Three plain and two chosen rewrites were standalone. In batched 160, bold `w`, tag the same
`w`, then bold it again. The last press of the formatting button moves a bold marker past the tag marker and
adds a history entry with the same display. Continuous 41 is the converse for a plain tag. In continuous 291,
two copies bold adjacent letters separately. Reapplying bold across both letters removes the close/open pair
between them. Batched 26, batched 241, continuous 25 and continuous 228 contain marker rewrites within compounds.

### Generated results

Each column has 300 batched and 300 continuous histories, 40 steps each, using E3's seed-selected mixture
of forward, reverse and duplicate batches. Each of those 600 seeds also ran three more times per scheme,
once with each schedule fixed throughout. A tag count is a unique (history, original character, tag kind)
triple, including the original identity if undo creates a replacement. The tag audit samples the acting
copy just after commands when it has no pending integrations, and all copies plus a late joiner after
settling. The settled tag counts below use the late joiner's view after checking individual character
marks for agreement with the writers.

| Measure | Per action | Plain | Chosen |
| --- | ---: | ---: | ---: |
| Histories completed / settled checks | 600 / 1,800 | 600 / 1,800 | 600 / 1,800 |
| Characters or fields lost / copies or late joiner disagree / stack check failures | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Undo and redo presses / applied undo / applied redo | 4,786 / 2,857 / 184 | 4,786 / 2,857 / 184 | 4,786 / 2,857 / 184 |
| Presses consulting the library's selected entry, undo / redo | 275 / 19 | 263 / 18 | 264 / 18 |
| Presses differing from a nonempty top, older entry / no entry applied | 44 / 8 | 43 / 8 | 43 / 8 |
| Presses emitting 0 / 1 / 2 updates | 1,745 / 3,041 / 0 | 1,745 / 3,040 / 1 | 1,745 / 3,040 / 1 |
| E3 F1 presses / inherited-tag F2 probe hits / predicted formatting skips | 14 / 0 / 1 | 17 / 0 / 0 | 17 / 0 / 0 |
| Missing requested tags, characters / histories | 17 / 11 | 20 / 13 | 7 / 6 |
| Missing requested tags at settled checks, characters / histories | 13 / 9 | 16 / 11 | 4 / 4 |
| Tags with no active explicit request, characters / histories | 105 / 43 | 117 / 40 | 106 / 43 |
| Tags with no active explicit request at settled checks, characters / histories | 90 / 37 | 103 / 35 | 91 / 37 |

Across the three fixed schedules the non-tag rows and settled missing-tag totals above repeated for each
scheme. The chosen scheme had four histories with missing tags in forward and twice, and six in reverse.
The two additional reverse histories were visible locally during delivery and recovered by the next settled
check. Extra settled tags affected 93 characters in 38 histories in forward and twice, and 91 in 37 in reverse.
For the explicit F2 example, the chosen mode shows `x[s|T1]y` after C undoes typing tagged `run` and A's
explicitly tagged `s` remains. Its independent key survives in this fixture.

The strict seed-254 test fails on C's continuous undo with either plain or chosen keys. The first
`Y.Doc` update comes from the manager and the second from Yjs formatting cleanup with a null origin.
The continuation in each regression verifies exactly those two origins and agreement at all three settled
checks. An editor that exposes one notification per press must coalesce its own view notification around
the press, allow the synchronous updates and caret restoration to finish, and publish the final view once.
Transport and persistence must still consume both Yjs updates, including the null-origin one.

### Missing tag histories

These are all missing-tag histories in the mixed schedules across the three key schemes. All are batched except
the final row. Brackets denote `T1`. Local gaps marked **transient** close at settlement. The report's
`--details` output gives the exact command, update delivery, stack actions, target character identities,
request step numbers and each observed cell for every row and every additional unrequested tag.

| Seed | Keys | History and outcome |
| --- | --- | --- |
| 0 | Per action and plain | In a split beat's visual cell, A types tagged `poq`, syncs, then appends tagged `nsk ` while B replaces `q` with a plain `n`. The appended four characters survive without their tag. |
| 3 | Plain | A tags `gh` and syncs. A explicitly tags `g` again while C, who saw only the first application, untags `g`. At merge the new request leaves `g` plain. |
| 14 | Per action and chosen | C inserts tagged `run ` into `xy` and syncs. A inserts plain text before the space and sends it to B, then undoes. Before receiving the undo, B adds plain text before `n`. After merge, `n` stays tagged and C's original space is plain. The short fixture yields `x[ru]Z[n] y`. |
| 23 | All three | In `ghij`, B deletes `j` and undoes before receiving A's tag on the original `j`. A sees `ghi[j]` before sync. All copies settle on plain `ghij`. A later restore produces another identity for the same `j` without the tag. |
| 34 | Plain | A tags `y` in visual `xy`. C receives it and untags the range including `y`. A, who has yet to receive the removal, tags `y` again. Merge loses A's second request. |
| 84 | All three | **Transient.** B tags `y` in a compound, inserts `z ` before it, then undoes and redoes. B sends the reversal batch in reverse to C. Cleanup relayed through C reaches A ahead of B's full batch. A sees `xz y` while B and C see `xz [y]`. After settling the tag returns. |
| 130 | Per action and plain | A tags `w` in `vw` and sends the tag to B. B types tagged `p` after `w`, using the seen tag. A deletes `vw` before receiving `p`, and formatting cleanup deletes the markers `p` depends on. When B receives the deletion, `p` goes plain. |
| 139 | Per action | A types tagged `zrl`. B receives that write ahead of A's plain insertion at the end of the tag and sees the tag extend over `v`. B types tagged `z ` after `v` using the same key. After A's plain insertion arrives, B's `z ` is plain on every copy. |
| 160 | All three | **Transient.** B tags `vr` and syncs, then undoes and redoes. C receives B's batch in reverse and sends cleanup to A ahead of B's full batch. A temporarily sees both `v` and `r` plain. Their tags return at settlement. |
| 176 | All three | C deletes and restores `y` in visual `xy` while B tags the original `y` in a compound. Sync retains the restored `y` without its tag. |
| 208 | Plain | A inserts tagged `ro ` into `vw`. Unseen by A, B tags `w`, then separately types and erases a letter. B's undo skips that exhausted entry and reaches its tag compound. All three of A's inserted characters lose their tags at merge. |
| 230 | Per action and plain | A deletes `w` from `vw`, tags `v`, then undoes the tag. C, before seeing A's changes, appends tagged `n`. Sync keeps `n` but drops its tag. |
| 234 | Plain | A types `uz ` and syncs. C inserts tagged `ozt ` just before A's space while B tags `z ` on its copy. B's original space is plain at merge. |
| 262 | All three | B replaces `gh` with `q` and undoes. On the original `ghij`, C tags `hi` and inserts `oks` before `g`. Sync shows restored plain `h` and tagged `i`. Another restore of `h` also lacks its tag. |
| Continuous 0 | Per action and plain | B types tagged `tzl` at the start of `abcdef`. C receives it and replaces `lab` with plain `u`. B, before seeing that edit, types tagged `ms` after `l`. Both letters are seen plain locally. At settled checks `m` survives plain. |

**Relay limit.** Deliver each writer's updates in the order they were made, or merge that writer's batch
into one update before applying it. The raw three-copy test starts with plain `vr`. B tags both letters and
syncs, then undoes and redoes before C receives either update. When C applies redo before undo, its
null-origin cleanup deletes the redo's start marker. C sends that cleanup to A before A applies B's two
updates in order. Full-state exchange leaves A, B and C on plain `vr` under all three key schemes.
The per-application and per-action variants use the same writer-and-clock suffix for this single tag
application. Sending undo before redo or merging B's two updates preserves the tag without that cleanup.

The separate replica-layer test retains the tag on all copies. Its text observers read `event.delta` during
integration. Adding just that read on C to the raw test, with the same delivery and relay sequence, changes
C's cleanup to delete the original start marker. The redo marker survives. This standalone replay is outside
the generated history counts.

### Chosen-scheme controls and limits

Each control turns one write path into a silent in-memory no-op and reruns the 600 mixed histories.
Used counts histories that called the path. Effective counts histories with a visible or marker write, a
fresh application key, or an applied press. Each edit is checked before the next command. The two other
redo failures were already empty presses which changed stack housekeeping or broke a typing group.
For chosen keys, each explicitly tagged character is checked for a raw key with the writer's client id
and a clock within the typing write. A visible inherited tag can pass the display check while failing that
key check. The typing-key control mutes positive tag writes at `Y.Text.format` during the splice. It covers
403 histories with explicitly tagged typing and 19 more with only tail re-keying. For a tail rewrite the
harness reads the pre-write keys on either side of the insertion and checks for a newly allocated marker,
including markers deleted in the same replacement.

| Muted write | Used | Effective | Failed among effective | Other failures |
| --- | ---: | ---: | ---: | ---: |
| Typing | 600 | 600 | 600 | 0 |
| Fresh key on tagged typing or tail re-key | 422 | 422 | 422 | 0 |
| Deleting | 576 | 576 | 576 | 0 |
| Simple formatting | 594 | 568 | 568 | 0 |
| Tagging | 419 | 419 | 419 | 0 |
| Untagging | 282 | 24 | 24 | 0 |
| Split | 543 | 543 | 543 | 0 |
| Join or unjoin | 411 | 411 | 411 | 0 |
| Record field write | 443 | 443 | 443 | 0 |
| Undo | 596 | 594 | 594 | 0 |
| Redo | 544 | 159 | 159 | 2 |

The intent model records explicit tag ranges and tagged typing without reading resulting marks. An untag
withdraws the requests it could see, and a press reverses requests in the entry it applied. The model
carries requests to restored identities of the same character. Automatically extended ranges on unseen
typing count as extra when nobody requested the tag on those characters. That convention exposes possible
wrong assignments but cannot decide which implicit growth a person wanted. A tag applied concurrently
to a deleted character counts as lost if undo restores its text without that tag.

The harness still uses the current implementation's pre-command positions, visible marks and ordered live
markers as inputs, along with client ids, state vectors, delivered operations and the encoded removal
vector. It validates assigned character and field identities by kind and value, binds restored identities
through Yjs's `redone` link, and uses the raw order of split boundaries in its projection check.
The A/B/C labels use the implementation's display and the harness's bound restoration flags. In generated
runs the settled mark comparison records bold mismatches without failing, and it stops comparing that letter
and kind after the first mismatch. The generated tag audit counts missing and extra marks. The fixed-order
tests assert only the settled missing-tag totals from that audit.
An update still determines whether to install a model command entry, with an independent prediction
checked against that fact. For 282 of 4,786 chosen-scheme presses (264 undo, 18 redo), character and
field effects alone could not tell whether markers would make an entry apply. The expected stacks for
those presses use the library's selected entry. The reported skip-to-older total compares the pre-press top
identity to the returned one. Successful controls show detection per history even where the first
formatting-only press is ambiguous.

The 40-step generator uses one tag id on marks and bold as its simple kind. The key-shape fixture also
checks italic, underline, strike, highlight, direction, cue and comment identities. These runs cover
short ASCII editing on three writers and the delta-reading prototype observer. They omit editor selection
and composition, long offline histories, multiple tag ids and nested tag editing, interleavings beyond
the generated schedules, and independent CRDT character sequence prediction.

From `prototypes/collab`, run `node src/native-undo/chosen-report.ts` for the mixed schedule and add
`--fixed` for the three fixed schedules. Add `--details` for the per-command classifications and full
histories. Run `node --test test/native-undo/chosen.test.ts` for the regression and no-op controls.

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
