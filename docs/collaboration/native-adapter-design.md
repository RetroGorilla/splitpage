# Design: the shared-document layer on standard Yjs

Proposal, 2026-11-18, revised after review and after experiments E1, E2, E3 and E5; nothing is built. It replaces
`src/adapters/collab/` under rule 12 of `AGENTS.md` (PR #1624). Sources: the native spike (draft PR #1623,
`prototypes/collab/src/native/REPORT.md`, "spike" below), the rule inventory (`docs/collaboration/native-rule-inventory.md`;
rule ids such as M01), the experiment results linked in section 8, the checks added with this note
([appendix B](#b-two-copy-checks-added-with-this-note)) and the Yjs and binding sources in [appendix A](#a-sources).
Server, invitations, disk storage, pictures and the screen are out of scope. One choice waits on the owner: formatting
keys, after experiment E4.

## 1. Stored shape

One `Y.Doc` per script. No subdocuments: official providers sync each as its own room (Yjs docs, Subdocuments) and
nothing here loads lazily. The layout is the spike's, which its numbers measure.

| Root | Type | Holds |
| --- | --- | --- |
| `meta` | `Y.Map` | `format` (section 6), `docId`, `wordsPerMinute`, `targetSeconds`, `paragraphsDecided`, the file's `schema`, unknown file fields as one JSON string; `title` is a `Y.Text` |
| `births` | `Y.Map` | creation id to `{at, by}`, one entry per conversion |
| `order` | `Y.Array` | segment keys in script order |
| `segments` | `Y.Map` of `Y.Map` | `head` (`{b: beatId}` or `{h: headingId}`) and `text`: narration, heading names, boundary embeds, atoms |
| `beats` | `Y.Map` of `Y.Map` | `status`, `lengthSeconds`, `paragraphStart`, `extra`; `joined`, `removed` when set |
| `visuals` | `Y.Map` of `Y.Text` | one visual cell per beat |
| `headings` | `Y.Map` of `Y.Map` | heading fields other than the name; `removed` when set |
| `comments`, `replies`, `people`, `tags`, `shots` | `Y.Map` of `Y.Map` | one record each with the file's fields and `rank`; replies keyed `comment/reply` |
| `edited` | `Y.Map` | per beat: `{by, at}` of the last typing group, one plain value |

**Beats, headings, atoms.** A beat or heading runs from its boundary (a segment's `head`, or an embed `{b: id}` or
`{h: id}`) to the next. A split inserts an embed; text never moves between containers. A heading name is ordinary
text after its boundary. Atoms are length-1 embeds carrying attributes like a character (`{k: shotId, label}`,
`{w: name}`, `{img: ref}`, `{video, host}`); no concurrent edit can split one.

**Formatting keys: owner decision pending, E4.** Native `Y.Text` attributes with the value `true`, keyed either by
kind (`b`, `i`, `u`, `s`, `hl`, `dir`, `cue`, `c:<commentId>`, `t:<tagId>`, `l:<url>`; library standard) or by
formatting action (the kind, U+001F, the acting copy's client id and clock in base 36, suffix stripped on read).
Reviewed facts so far:

- Key per kind: two touching bolds made at once can leave one plain (formatting nobody removed lost in 110 to 155 of
  1,000 histories, spike D); with `bc` bold and plain `X` typed inside remotely, undoing the bold leaves the text after
  `X` bold (spike E); one undo press sent two updates, the second an untracked Yjs formatting cleanup, in 1 of 600
  generated histories (E3).
- Key per action: bolding 100 growing prefixes left 100 live keys on the first character, 3,610 bytes against 113
  plain, 1,739 after unformatting all and rebuilding (appendix B); an undo took back an older step and the formatting
  step left the stack in 1 of 600 generated histories (E3).
- Under both, so standard Yjs behaviour (E3, F1 and F2): after someone else changes part of a range you formatted,
  your undo can leave the rest formatted; a tag picked up from a neighbour can go when the neighbour's typing is undone.
- E4, first review: after the simulated year, 521,823 bytes with action keys against 437,985 with kind keys. The
  proposed limit (collapse at 32 keys) lost edits in two-copy runs, so this note's earlier "collapse past 16 live keys"
  proposal is withdrawn. The normalisation rule changed visible formatting in 3.4% to 4.6% of generated histories and
  is not adopted. A side-by-side table follows from E4.

**Flags and records.** `joined = {into, glue, marks}` and `removed = {by, at}` on beats, `removed` on headings
(section 7). Record fields, status included, are plain map values: of two statuses set at once one wins, and an absent
status reads `todo` (section 3). A comment's `resolved` is one plain value, so of a resolve and a reopen made at once
Yjs keeps one; `edited` likewise (decided 2026-11-18). Bodies are whole strings (F40). `rank` orders records, ties by
id (F30).

**Not stored.** Derived values (`sections`, `firstSceneId`, row order, joined-row fields, paragraph positions until a
paragraph edit commits them (T14), tag extents, comment anchors, recovery entries, durations); the script's `rev` and
last editor (export only, plan 2026-11-09); presence (Yjs awareness, slice 7); undo stacks, selections, painted units (memory).

## 2. Writing

Each official binding turns one editor change into one `doc.transact(change, bindingOrigin)` (y-codemirror.next
`update`, y-prosemirror `_prosemirrorChanged`, y-quill `_quillObserver`). Here one command is one transaction:

| Transaction | Origin | Session kind | Undo |
| --- | --- | --- | --- |
| A command, typing included | the replica's local origin object | `edit` | captured |
| A command without undo (resolve, reopen, rule 29 recovery write) | a second, untracked local object | `edit` | no |
| Undo, redo | the `Y.UndoManager`, in its own transaction | `replay` | moves between stacks |
| Converting a file | `"hydration"` | `adopt` | no |
| Anything else (the provider) | the provider | `remote` | no |

A compound command (paste over beats, split with fields, cross-beat delete) is one transaction, one undo step, one
publication. Records minted from typed text and the `edited` value of a new typing group go in the typing
transaction; `edited` is outside the undo scope (F33). Text is addressed by cell, offset and base revision, as
y-codemirror.next applies changes. A replacement inserts before deleting (spike `splice`); offsets never cut a
surrogate pair (T11).

**Every write resolves its target by id when it runs** and checks it is live; otherwise its text goes to recovery and
the command does not report success. Yjs deletes anything written into a deleted type, and a held `Y.Text` goes stale
when another copy undoes and redoes the split that made it, since redo makes a new cell (E1, stale cells).

## 3. Undo

Standard selective undo, decided 2026-11-18: one `Y.UndoManager` per shared session, made on entry, destroyed on exit
(U38), called directly; it owns its transaction. Wrapped in `doc.transact(..., undoManager)` it left one undo entry and
no redo entry (appendix B). Held in E3 (`prototypes/collab/src/native-undo/RESULTS.md`): characters and fields kept in
the command tests and 600 generated histories, copies and late joiners agreeing at every settled check.

| Setting | Value |
| --- | --- |
| Scope | every root a command writes, `headings` included (E5), but `births` and `edited` |
| `trackedOrigins` | the local origin object; remote and hydration untracked (U01, U12) |
| `captureTimeout` | infinite; `stopCapturing()` by the app's rule in `src/application/editing/undo/history.ts`: a new step on a 1,000 ms pause, another cell, a command, a replaced selection, a word after a space, an undo. A policy: 8.33 µs per key against 8.07 under the default window, zero encoded bytes (E3) |
| `deleteFilter` | keep-always: undo never deletes a record or cell it created, and takes back only what its creator wrote into it |
| `ignoreRemoteMapChanges` | `false`: undo never overwrites another person's field |
| Stack item `meta` | the caret as a relative position captured before each edit, restored on `stack-item-popped` |
| Depth | no cap: Yjs has no public bound, and a 200-entry cap through `undoStack.shift()` skipped the manager's cleanup and saved nothing (E3) |

**Creations.** Keep-always closes a loss that "keep it while it holds anything" leaves open: A splits, B types `V` in
the new cell, A undoes before B's update arrives; the cell was empty on A, the filter let it go and `V` vanished on
every copy (38 losses in 600 generated histories, all of this kind). No copy can know at undo time what is in flight.
With keep-always redo gives back the same object. A person sees: an undone split leaves no row, and another person's
text in its cell is listed in recovery and returns with redo; an undone record nobody touched is an empty map, not
shown; one holding another person's field shows that field and the format default for its missing name. Cost: 37.67
bytes per undone record and 38.05 per undone split, never reclaimed in v1 (E3).

**Identical simultaneous changes** need no guard. When the presser's identical write stands, its undo leaves the
status absent on both copies: it reads `todo`, and redo brings the value back. A fallback written after the undo was
rejected because the following redo did nothing (appendix B). A step that changed nothing is passed over and the same
press undoes the step before, as Yjs does (E3, "the standard skip"; appendix B).

**Presses and compounds.** Each applied press emitted one Yjs `update` event and each empty press none (3,041 and 1,745
presses, E3). One press of a compound command (flag, bold, record creation, typing) moves exactly one step and keeps
everyone else's typing, fields, bold and removal. Surprise, standard: after A undid creating a tag, B's undo of its own
recolouring restored the colour B had overwritten, A's.

## 4. Incoming updates

A stock provider applies updates itself: Hocuspocus provider 4.8.0 and y-websocket call y-protocols
`readSyncMessage`, which calls `Y.applyUpdate(doc, update, provider)`. This layer checks nothing first and holds no
queue; main's ingress gate, byte bound and per-update trial copy go. Size limits belong to the server (plan section
10). y-prosemirror deletes a node it cannot render; this layer reads leniently and writes nothing back (plan section
4). A boundary without a record, a repeated boundary, crossing tags or an unknown key is read by fixed rules
(inventory S07, S08, S17, M08 to M12) and, if it cannot be placed, listed in recovery.

**Composition (T04).** One document, applied at once; only the repaint of the composing cell waits. Held in E1
(`prototypes/collab/src/native-e1/RESULT.md`): 43 hand tests, 7 undo tests and 40,000 generated histories, no
character lost or doubled, three copies and a late joiner agreeing, every negative control caught. The binding keeps
the cell's painted UTF-16 units (an embed is one) and folds every `Y.Text` event into them, from every origin, since
both bindings skip only their own writes: a retain moves over live units, a delete marks live units dead, an insert
adds unpainted units. The commit is one transaction: each typed run goes after its nearest painted unit to the left,
counted in live units, then only deleted units still live are deleted. The caller calls `stopCapturing()` first. At a
tie, the person's text goes before remote text that landed in the same painted gap, where CodeMirror keeps a caret.
The commit resolves its cell by id (section 2): `written`, `moved` (appended to the live cell), or `recovery`.

Declared difference, plain Yjs: text composed next to a character already deleted can land on the other side of a
simultaneous insertion next to it (25 of 20,000 histories with undo, 28 of 20,000 without); no public `Y.Text` call
inserts relative to a deleted character. Real input-method behaviour is for the browser stage (slice 6).

## 5. Telling the editor what changed

The session's `ReplicaPort` (`src/application/session/shared-session.ts`) stays. As in the spike's `changes()`,
`observeDeep` marks dirty segments, beats and records; a change to `order`, a boundary, `joined` or `removed` is
structural. After each transaction that changed the document the revision advances and the session is told once,
with the kind from section 2. A structural change regroups beats into rows; otherwise only rows owning a dirty beat
are rebuilt, plus rows showing a dirty record: projection keeps an index from tag, person and shot ids to the rows
that show them, so a renamed tag changes those rows without a text change. Rows that differ from those shown become
`SharedProjectionChanges`; unchanged rows keep their identity. Projection never writes, so a remote update and a
local no-op send nothing. Spike: a remote keystroke with its change set took 0.022 to 0.023 ms median at 30, 300 and
900 beats; main 1.58, 6.83 and 23.52 ms. A structural change at 900 beats is not measured (Q2).

## 6. One birth

Two conversions merged list the beat twice and drop one copy's typing, and a fixed client id that would make two
conversions coincide makes copies with different content disagree (appendix B). Detection is not prevention, so
birth needs an authoritative, durable create-or-load keyed by the plan's persisted creation id: the first call stores
the converted state; every call after it, a retry from the same copy included, returns the same encoded initial
state, and the copy adopts the returned bytes, never its own conversion. Where it lives is the server's design; this
layer needs only that contract. The conversion is one `"hydration"` transaction into an empty document writing
`meta.format = 1` and `births[creationId]`. Every record is hydrated as a `Y.Map`, never a plain object, so its fields
can be written and undone one by one (E3). In a hydrated script every heading is a segment head (E5). Every other
copy, and the same device after a restart, loads stored state.

Without that authority two births can only be detected after the fact, by two `births` entries. Each converting copy
keeps its encoded initial state, keyed by creation id, until the store confirms its birth. A document with two births
stops editing and publishing; each kept initial state loads alone into a fresh copy and exports, and the merged
document exports too. Client ids are unique per session: each session makes a new `Y.Doc` and never restores a stored
client id.

`meta.format` versions the shared shape, apart from the file's `schema` (`SCHEMA_VERSION` 2) and the wire protocol
(section 11). A document without it came from main's adapter; shared mode never shipped, so there is no migration.

## 7. Joins, removal and headings

All three are flags, costly rather than wrong. Copying a joined visual cell lost another copy's typing there
(appendix B); deleting a removed beat discards typing made in it unseen (inventory R01); deleting a heading's boundary
stranded 790 letters in 525 of 1,000 E5 runs where no editor or recovery reached them.

- **Join, contiguous reading** (E2, `prototypes/collab/src/native/E2-RESULT.md`): a join hides the boundary above the
  beat, and the joined beat attaches to the nearest visible row above it in stored order. `into` is written but not
  read for display. Over the same 1,000 generated histories, following `into` showed rows out of stored order in 325
  and the contiguous reading in 0; neither lost text. Known: a beat joined to a row someone removes at the same time
  stays visible, merged into the row above, until the removal is restored; after "removes R2; joins R3 to the row
  above (R1); restores R2" the person sees `R2+R3`.
- **Edits across a join.** Typing at the seam goes to the end of the earlier beat; a deletion across it deletes in
  each beat and keeps the flag; a split at the seam deletes the flag, elsewhere it splits the beat holding the place.
- **Shared container.** Deleting a boundary embed would join narration without a flag, but strands the later beat's
  visual cell in no row (E2), and a segment-head beat has no embed. The flag is the only join that keeps both cells.
- **Removal.** `removed = {by, at}` on every beat of the row, since a flag on the head alone would attach the joined
  beats to the row above (E2). Text stays; restore deletes the keys; typing into a removed beat stays there and is
  recoverable (decided 2026-11-18). Of two removals at once Yjs keeps one write, and a restore that saw only the other
  leaves the row removed; a removal racing a split leaves the split-off half visible (E2).
- **Headings** (E5, `prototypes/collab/src/native/E5-RESULT.md`): removed by a flag on the heading record, as beats
  are. The name stays in place and recoverable; restore is one map write (15 bytes); each create-and-remove cycle keeps
  66 to 123 bytes. Known and accepted: a join flag across a visible heading stays dormant, and restoring a heading can
  split a row someone joined while it was hidden (`B1 | #H | B2`, `B2`'s flag still set). A letter typed at the end of
  a name can land in a heading created at that spot at the same moment (plain Yjs insert order); it stays editable.
  A hydrated segment-head heading has its own container and cannot meet this.
- **Size.** A split keeps 54.5 bytes and a live join about 40, for the document's life; flags set and later deleted
  cost almost nothing once undo history is dropped (E2). Hidden content is never deleted in v1; reclaiming it needs
  compaction, which v1 lacks (plan section 6).

## 8. Experiments, then slices

| # | Experiment | State |
| --- | --- | --- |
| E1 | Composition fold (section 4) | Done: [`native-e1/RESULT.md`](../../prototypes/collab/src/native-e1/RESULT.md) |
| E2 | Split, join, remove, restore races, three copies and a late joiner | Done: [`native/E2-RESULT.md`](../../prototypes/collab/src/native/E2-RESULT.md) |
| E3 | Standard undo under simultaneous changes, compound command, memory | Done: [`native-undo/RESULTS.md`](../../prototypes/collab/src/native-undo/RESULTS.md) |
| E4 | Formatting keys over a long life | Open: in a fix round; the owner decides formatting keys after it |
| E5 | Heading races (Q4) | Done: [`native/E5-RESULT.md`](../../prototypes/collab/src/native/E5-RESULT.md) |

**Evidence rule for every slice**, from three failed first reviews: generated tests take expected values from a model
that imports neither Yjs nor the code under test; each write command made a silent no-op must fail the check; and the
result lists what is still read from the implementation.

Each slice is one pull request and reports, measured as the spike was (spike B): stored bytes per typed character
after the 11,287-character tape with two writers, on a copy without undo history; local keystroke median and p95 at
30, 300 and 900 beats, each the median of 3 rounds of 200 timed keystrokes after 20 untimed. Proposed stop: over 2.0
bytes per typed character (spike 1.84) or a median over 1 ms at 900 beats (spike 0.023 ms; the app limit in
`tools/perf-ab.mjs` is 8 ms). Code goes in `src/adapters/collab/native/`, the only place the dependency gate admits
Yjs (`tools/dep-report.mjs`).

| # | Slice | Exit check |
| --- | --- | --- |
| 1 | Shape, birth, typing, deleting, projection, change sets | Fixtures round-trip with every record a `Y.Map`; the tape agrees on three copies and a late joiner in every delivery order; birth checks; writes resolve by id |
| 2 | Formatting, identified marks, atoms | After the owner's E4 decision: spike marks generator, 1,000 histories per writer count and delivery |
| 3 | Split, join, removal, restore, headings, new beats | E2 and E5 histories on the adapter, contiguous reading; Stage 1 traces T01 to T12, T20, T21; structural time at 900 beats (Q2) |
| 4 | Records, status, comments, replies, stamps | Record and field tests; record-to-row changes; absent status reads `todo` |
| 5 | Undo settings, grouping, keep-always filter | E3's command and generated tests on the adapter, with its update-count check |
| 6 | Session and editor wiring, composition, test hook | E1 on the Writer; real input-method behaviour (E1, "Left for the browser stage"); Writer and Split browser suites |
| 7 | Presence | Decorations follow remote edits and structure changes without moving the local caret; cost per keystroke measured with five other people present; awareness data stays out of saved history |
| 8 | Delete the old adapter and tests | `npm run verify`; nothing imports the old files |

**Presence, slice 7** (owner, 2026-11-18: part of how the first version handles simultaneous edits, since seeing
someone in the same spot makes most conflicts far less confusing and discourages two people editing one block). Each
other person's cursor and selection shows in both editing views, Writer and Split, and a row someone else has focus in
carries a visible mark. It is standard Yjs awareness, per session: the session's client id, the person's id and name,
and selections as relative positions, resolved like the caret in section 3. A cursor inside a removed or joined-away
beat shows at the start of the row that holds it. Nothing is stored in the document; a session clears its own state on
exit, and awareness drops a silent session's state after its timeout. It does not cover edits made offline or not yet
synced: those arrive without warning, so the merge rules above must hold on their own.

What stays, changes and goes is in [appendix D](#d-what-stays-changes-and-goes).

## 9. Departures from standard Yjs

| Departure | Defect that forces it | Cost | Decision |
| --- | --- | --- | --- |
| A formatting key per action | Key-per-kind defects (section 1) | Section 1 facts; 521,823 against 437,985 bytes after the simulated year | Owner decision pending, E4 |
| Join as a flag, read contiguously | Copying the joined visual cell loses typing (appendix B); following `into` breaks stored order (E2) | About 40 bytes per live join; section 7 rules | Reading: engineering choice from E2, owner told |
| Beat removal as a flag | Deleting the beat discards unseen typing (R01) | Removed text kept for the document's life | Decided 2026-11-18 |
| Heading removal as a flag | Deleting the boundary strands the name (E5) | 66 to 123 bytes per create-and-remove cycle | From E5, as beat removal |
| Reading without writing back | y-prosemirror's deletion on read loses content | None | Plan section 4, set earlier |
| Repaint waits during composition | Owner rule T04 | The fold (section 4); one declared order difference | T04 set earlier; E1 |

Not departures: the keep-always delete filter (Yjs's extension point, as y-prosemirror's `defaultDeleteFilter`; cost
in section 3), word grouping by `stopCapturing()` (a policy, measured), the status read as `todo` when absent,
relative positions for the caret, one transaction per command under the binding's origin, the caret in stack `meta`.
Proposed to drop, for the owner: waiting for a restore before undoing typing in a removed beat (U14; the undo then
happens at once inside the removed beat, still in recovery). Assumed and dropped rules: [appendix C](#c-rules-dropped).

## 10. Open questions

| | Question | Settled by |
| --- | --- | --- |
| Q2 | Is regrouping rows after a structural change fast enough at 900 beats? | Slice 3 times against the Stage 0 structural baseline |
| Q8 | Where should composed text go when its cell was replaced meanwhile? E1 appends it to the end of the live cell | Product decision; slice 6 |
| Q9 | How often does an end-of-name keystroke change owners in real scripts (section 7)? | Slice 3 traces on real scripts |

## 11. Settled before release

**Garbage collection against undo history.** An editing copy holds every letter its own commands deleted, about one
byte per letter whatever the history depth, and clearing history frees nothing: 20,000 editing operations on 30 beats
gave 83,348 bytes against 77,649 freshly loaded; pasting and deleting a 10,000-letter block 100 times gave 1,003,678
against 3,678 (E3, `memory-results.json`). Only a rebuild from stored state frees it, and it drops undo history. E3
proposes a rebuild on entry and, at the next idle moment, once the letters this copy's commands deleted pass 1,000,000,
telling the person that undo history was cleared. Ordinary typing needs millions of operations to reach that; deleting
large pastes reaches it. Open: the threshold and the notice.

**Long-life size and rebuild.** Never reclaimed in v1: live formatting keys (section 1), 54.5 bytes per split, about
40 per live join, 37.67 per undone record and 38.05 per undone split, 66 to 123 per heading create-and-remove cycle,
and removed text. Before release, a year-long schedule of typical edits on one script reports encoded size, reload
time and keys per character against a stated ceiling (E4 gives the first such figures).

**Schema changes and old clients.** `meta.format` changes only when an older copy would misread or misplace what a
newer one writes; new optional fields do not change it, and writers never delete keys they do not know. A copy
refuses to edit a higher `format` and offers export. An older copy already connected could still write before it reads
the new value, so the connection must also carry the format and the server refuse a lower one (server design).

**Large pastes and one very large cell.** A paste is one transaction and one update. The command checks its size
against the server's stated message limit before writing, so an update the server would refuse never exists only
locally. Reading a cell with 1,000 keys took 0.37 ms (spike); a cell of 100,000 characters is not measured.

**Record-to-row change reporting.** Section 5's index is part of slice 4's exit check: renaming a tag, a person or a
shot remotely lists exactly the rows that show it.

## Appendix

### A. Sources

Yjs 13.6.33 `src/utils/UndoManager.js` (`popStackItem`, the after-transaction handler), `src/types/YText.js`;
y-prosemirror 1.3.7 `src/plugins/sync-plugin.js` (`_prosemirrorChanged`, `_typeChanged`, `createNodeFromYElement`
deleting what it cannot render) and `src/plugins/undo-plugin.js` (`defaultDeleteFilter`, `trackedOrigins`, selection
in `meta`); y-codemirror.next 0.3.5 `src/y-sync.js` (the delta observer), `src/y-undomanager.js`; y-quill 1.0.0
`src/y-quill.js`; y-protocols 1.0.6 `sync.js` (`readSyncStep2` calls `Y.applyUpdate`); y-websocket
`src/y-websocket.js` on its default branch, 2026-11-18; Hocuspocus 4.8.0 `packages/provider/src/MessageReceiver.ts`
(`readSyncMessage` on the provider's document, origin the provider); Yjs documentation "Y.UndoManager", "Y.Text",
"Subdocuments", "Document Updates". Experiment results E1, E2, E3 and E5 (section 8); E4's first review for the
figures marked E4.

### B. Two-copy checks added with this note

`prototypes/collab/test/native-design/native-design.test.mjs`, Yjs 13.6.33, Node 24.22.1; all 22 pass. Run
`npm ci --prefix prototypes/collab`, then `node --test test/native-design/native-design.test.mjs` in
`prototypes/collab`. They predate the experiments, which supersede two of them where noted.

| Check | Result |
| --- | --- |
| Two conversions of one file merged | The order lists the beat twice; one copy's typing is gone |
| Two conversions under one fixed client id, different text | The copies disagree |
| Join by copying the second visual cell while another copy types in it | That typing is gone |
| Join as a flag, the same race | That typing stays |
| Painted `b`, `c` of `abcd` held as relative positions; remote deletes `b`; local deletes `bc` | Both anchors resolve to one place; the commit leaves `a`, deleting `d` too |
| A sketch of the fold on `abcd`, local deleting `bc`: remote deleted `b`; remote deleted `bc`; remote typed `X` between `b` and `c`; remote put an embed there | `ad`; `ad`; `aXd`; `a`, embed, `d` (superseded by E1) |
| The sketch: remote deleted `b`, local replaces `bc` with `Y`; remote deleted `a`, local types `Y` after `a` | `aYd`; `Ybcd` |
| Deleting painted `bc` by painted offsets after a remote `X` | `acd` |
| Plain undo of a group that deleted all it typed | Passed over; the same press undoes the step before |
| Plain undo of a record's creation after another copy set a field | Record and field gone on both copies |
| `undo()` inside `doc.transact(..., undoManager)` | Text undone; 1 undo entry, 0 redo entries |
| The winner's undo of two identical statuses | Status absent on both copies; redo restores it |
| A fallback status written after that undo | The next redo does nothing |
| Delete filter keeping records with `type.size > 0`, creation undone after another copy set a field | `{colour}` kept on both copies; unchanged record deleted (superseded: E3 keeps always) |
| 10,000 characters inserted and deleted, then `clear()` | Over 10,000 bytes encoded; under 100 in a fresh copy |
| 100 growing prefixes bolded with a key per action | 100 live keys on the first character; 3,610 bytes; 1,739 after unformatting all and rebuilding; 113 plain |
| Resolve at 2,000 against an unseen reopen at 1,000, as two time fields | Resolved on both copies (no longer the design: one plain value) |

### C. Rules dropped

Assumed, class C or D, dropped on 2026-11-18 with no reproduced defect found: M02 to M04, M15; S11 to S15, S22; F03
to F05, F35 to F39; U03, U04, U15, U16, U18, U21, U25 to U33, U39; R02, R03, R05, R06, R08 to R10, R13, R17; Q02,
Q04, Q06, Q07. Owner-set and changed on 2026-11-18: F01 (one of two statuses wins), M01 (kept for selected text), U02
and U13 (standard selective undo, no guard), F13 and F32 (the plain value Yjs keeps). Dropped after E3: U10 (no
history cap). Owner-set and kept: R01.

### D. What stays, changes and goes

Wiring switches in slice 6; old files and the tools loading them (`tools/perf-shared.mjs`, `tools/perf-ab.mjs`)
change in slice 8.

| Code | Fate |
| --- | --- |
| Adapter: document state, ingress gate, trial replica, read caches; identities, anchors, text units, birth, creation and mark records; undo executors | Go: Yjs items, relative positions and `Y.UndoManager` replace them |
| Adapter: executors and preparation | Rewritten as four writers: text, formatting, structure, records |
| Adapter: projection, indexes; hydrate, text import | Rewritten: section 5; the one birth |
| Adapter: buffer, painted base, recorded selection | Replaced by the composition fold |
| Adapter: B-roll keying, move refusal | Stay as policy |
| Core: `operations.ts`, `read-operation.ts`, `base-reference.ts` | Change: text by cell, offset and base; kinds for dropped rules go (split and segment retire and restore, status events, `text-restore`, `mark-retract`, `discard`) |
| Core: `undo-record.ts` | Goes; a description keeps label, selection, typing key |
| Core: `recovery.ts`, `removal-state.ts` | Change: discard, deleted people and deleted records go |
| Core: projection, buffer, cell text, comment marks, records, B-roll, refusals | Stay |
| Application: `shared-session.ts` | Stays |
| Application: `shared-undo.ts`, `replayed-steps.ts` | Shrink to admission and the grouping policy |
| Application: `buffered-field.ts`; features: Writer and cell buffers | Change for the composition fold |
| Application: shared commands; feature: recovery panel | Change where they build unit identities or dropped operations; no discard |
| Bootstrap: `shared-session.ts`, `shared-test*.ts`, `ports/shared-*.ts` | Rewired |

| Tests | Fate |
| --- | --- |
| `tests/collab/delivery.ts` (D1, D2, D3, dup, rev, late-C), `agreement.ts`, `checker.ts`, `oracles/` | Carry over |
| `tests/collab/fixtures.ts`, `fixtures/projection-reference.json` | Carry over as round-trip goldens; dropped rules marked |
| Spike and experiment tests: marks generator, `marks`, `undo`, `traces`, E1, E2, E3, E5 | Move to `tests/collab/` against the adapter |
| `tests/collab/undo/`, `tests/collab/measure/` | Rewritten on the same harness; the spike's driver replaces main's |
| `tests/adapters/collab/` (173 files), `tests/collab/*-mutants.json` (41 lists) | Deleted: they assert main's stored records; one new mutant list (lost mark, duplicated identity, omitted field, stale base) |
| `src/test/shared-*-app.test.mjs` (41 files) | Kept; outcomes change only for dropped rules |
