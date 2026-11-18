# Design: the shared-document layer on standard Yjs

Proposal, 2026-11-18, revised after review; nothing is built. It replaces `src/adapters/collab/` under rule 12 of
`AGENTS.md` (PR #1624). Sources: the native spike (draft PR #1623, `prototypes/collab/src/native/REPORT.md`, "spike"
below), the rule inventory (draft PR #1622; rule ids such as M01), the checks added with this note
([appendix B](#b-two-copy-checks-added-with-this-note)) and the Yjs and binding sources in [appendix A](#a-sources).
Server, invitations, disk storage, pictures and the screen are out of scope. Three points wait on the owner (marked
PENDING); each is written so either answer fits, with what each costs.

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
| `headings` | `Y.Map` of `Y.Map` | heading fields other than the name |
| `comments`, `replies`, `people`, `tags`, `shots` | `Y.Map` of `Y.Map` | one record each with the file's fields and `rank`; replies keyed `comment/reply` |
| `edited` | `Y.Map` of `Y.Map` | per beat: author name to the time of that author's last typing group (shape PENDING, section 11) |

**Beats, headings, atoms.** A beat or heading runs from its boundary (a segment's `head`, or an embed `{b: id}` or
`{h: id}`) to the next. A split inserts an embed; text never moves between containers. A heading name is ordinary
text after its boundary. Atoms are length-1 embeds carrying attributes like a character (`{k: shotId, label}`,
`{w: name}`, `{img: ref}`, `{video, host}`); no concurrent edit can split one.

**Formatting keys (PENDING).** Native `Y.Text` attributes with the value `true`. Two answers:

- **A key per kind** (library standard): `b`, `i`, `u`, `s`, `hl`, `dir`, `cue`, `c:<commentId>`, `t:<tagId>`,
  `l:<url>`. Costs nothing stored. Known defects (spike D, E): two touching bolds made at once can leave one plain
  (formatting nobody removed was lost in 110 to 155 of 1,000 histories); with `bc` bold and plain `X` typed inside it
  remotely, undoing the bold leaves the text after `X` bold.
- **A key per formatting action** (decided 2026-11-18, re-put): the kind, U+001F, the acting copy's client id and
  clock in base 36; the reader strips the suffix. It removes both defects but is a costly workaround with unbounded
  growth: typed text takes its left neighbour's keys, and `markThroughout` (`src/core/text/edits.ts`) only stops a
  format command over a range that already shows the mark. Bolding 100 growing prefixes left 100 live keys on the
  first character and 3,610 encoded bytes against 113 for the plain text; after unformatting everything and
  rebuilding, 1,739 remained (appendix B; the review measured 2,808 of 4,584). Choosing it adds: experiment E4
  (section 8) before slice 2; a normalisation rule, proposed only if E4 shows identical visible formatting with and
  without it: a format command turns off, in the same transaction, every seen key of the same kind whose whole run
  lies inside its range, since the new key shows wherever the old one did; and a limit: past 16 live keys of one
  kind on a character (a number to set from E4), a format command collapses that cell's seen keys of the kind into
  one fresh key over the characters that showed it. The visible result is unchanged; protection against the two
  defects then holds only for keys written since. Removed formatting shrinks only by Yjs garbage collection.

**Flags and records.** `joined = {into, glue, marks}` and `removed = {by, at}` (section 7 policy). Record fields,
status included, are plain map values: of two statuses set at once one wins (decided 2026-11-18). Bodies are whole
strings (F40). `rank` orders records, ties by id (F30). Comment resolution is PENDING (section 11).

**Not stored.** Derived values (`sections`, `firstSceneId`, row order, joined-row fields, paragraph positions until a
paragraph edit commits them (T14), tag extents, comment anchors, recovery entries, durations); the script's `rev` and
last editor (export only, plan 2026-11-09); presence (section 11); undo stacks, selections, painted units (memory).

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
publication. Records minted from typed text and the `edited` stamp of a new typing group go in the typing
transaction; `edited` is outside the undo scope (F33). Text is addressed by cell, offset and base revision, as
y-codemirror.next applies changes. A direct command is planned and run in one synchronous call, so it always meets
its base; only a composition can be older (section 4). A replacement inserts before deleting (spike `splice`);
offsets never cut a surrogate pair (T11).

## 3. Undo

**Standard selective undo.** One `Y.UndoManager` per shared session, made on entry, destroyed on exit (U38). It owns
its transaction: `undoManager.undo()` is called directly. Wrapped in `doc.transact(..., undoManager)` it left one
undo entry and no redo entry (appendix B), because the manager files the outer transaction as a new change.

| Setting | Value |
| --- | --- |
| Scope | every root but `births` and `edited` |
| `trackedOrigins` | the local origin object; remote and hydration untracked (U01, U12) |
| `captureTimeout` | 1,000 ms (U08) |
| `stopCapturing()` | around commands that are not typing, on a cell change, at a word after a space, on undo and redo; the library groups by time alone (spike E) |
| `deleteFilter` | keeps a created type that still holds content: a visual cell with text, a record with a field (below) |
| `ignoreRemoteMapChanges` | `false`: undo never overwrites another person's field |
| Stack item `meta` | selection as relative positions, restored on `stack-item-popped`, as y-prosemirror's undo plugin does |
| Bound | 200 entries (U10), kept: history pins deleted content (section 11) |

**Creations.** The library undoes a creation by deleting the type with all anyone wrote in it. The `deleteFilter`
extension point, as in y-prosemirror's `defaultDeleteFilter`, keeps a created type that is not empty: undoing a split
keeps a visual cell another copy typed in (spike, Real findings: 104 bytes per 50 undone splits). For records the same
filter tests `type.size > 0`: undoing the creation of a person another copy had given a colour removed only the name
and kept `{colour}` on both copies; with no other change, undo deleted the record (appendix B). A kept record missing
a required field is read with the file format's default for it, as a partial record from a file is read; it stays
valid and editable, and nothing is written. Whole-entry cancellation is dropped.

**Status fallback, needed under any answer.** When two copies set the same status at once, the winner's undo
removes its value and the other copy's identical value was never written: the status is absent on both copies, a real
invalid value (spike F; appendix B). The reader shows an absent status as the file format's default. That writes
nothing, so redo still brings the status back. A fallback written after the undo was checked and rejected: the
following redo did nothing (appendix B).

**Compound commands.** One press reverts every part of the step that is still reversible. With
`ignoreRemoteMapChanges` false a field someone has since changed is left as they set it while the rest reverts; one
obsolete flag or record never uses up unrelated work. Any added layer must keep this.

**The guard (PENDING), an optional layer.** About 100 lines (spike `undoStep`, `redoStep`, appendix F). What it adds,
taken apart:

- *Top entry only* (U13): a step that changes nothing is reported used up instead of passing to an older one, which
  plain undo does (appendix B). A preference, not a correctness fix.
- *Identical changes*: after undo, same-kind keys over exactly the same characters, unseen when the command ran, are
  turned off. This undoes another person's change, a substantial departure: a concurrent identical edit cannot be told
  from a later informed one, so both are taken back.
- Its writes cannot share the undo transaction. The spike's carrier entry keeps redo through undo, redo, undo, but
  costs a second publication per press, and its effect on stack `meta` and on observer order is untested (E3).

Without it: no extra code; a used-up step passes to an older one; another person's identical change stays. With it:
the code above, E3's guard cases, two publications per guarded press, and the U13 and U11 net-empty cases (Q5).

## 4. Incoming updates

A stock provider applies updates itself: Hocuspocus provider 4.8.0 and y-websocket call y-protocols
`readSyncMessage`, which calls `Y.applyUpdate(doc, update, provider)`. This layer checks nothing first and holds no
queue; main's ingress gate, byte bound and per-update trial copy go. Size limits belong to the server (plan section
10). y-prosemirror deletes a node it cannot render; this layer reads leniently and writes nothing back (plan section
4). A boundary without a record, a repeated boundary, a join loop, crossing tags or an unknown key is read by fixed
rules (inventory S07, S08, S17, M08 to M12) and, if it cannot be placed, listed in recovery.

**Composition (T04).** Owner rule T04 (Stage 0, PR #1405): others' changes wait while a person composes. One document
is applied at once and only the repaint of the composing cell waits. An ordinary keystroke needs nothing, since
`beforeinput` and `input` run in one task. On composition start the binding lists the painted UTF-16 units of the
composing cell. While composing, it folds each remote delta of that `Y.Text` into the list, as y-codemirror.next's
observer turns a delta into editor changes: a retain moves over live units, a delete marks live units dead, an insert
adds unpainted units, and an embed counts as one unit. On commit the replacement goes after the last live painted unit
left of the range, and only live painted units inside the range are deleted. A relative position per painted
character was checked and rejected: after a remote deletion two anchors resolved to the same place and the commit
deleted a surviving character (appendix B). The fold passed six histories (appendix B); a boundary removed meanwhile,
surrogate pairs and composition through undo are E1's remaining cases. A second document (plan mechanism 3) is
dropped unless E1 fails.

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

Two conversions merged list the beat twice and drop one copy's typing (appendix B), and a fixed client id that would
make two conversions coincide makes copies with different content disagree (appendix B). Detection is not
prevention, so birth needs an authoritative, durable create-or-load keyed by the plan's persisted creation id: the
first call stores the converted state; every call after it, a retry from the same copy included, returns the same
encoded initial state, and the copy adopts the returned bytes, never its own conversion. Where it lives is the
server's design; this layer needs only that contract. The conversion is one `"hydration"` transaction into an empty
document writing `meta.format = 1` and `births[creationId]`. Every other copy, and the same device after a restart,
loads stored state.

Without that authority two births can only be detected after the fact, by two `births` entries. Each converting copy
keeps its encoded initial state, keyed by creation id, until the store confirms its birth. A document with two births
stops editing and publishing; each kept initial state loads alone into a fresh copy and exports, and the merged
document exports too. Client ids are unique per session: each session makes a new `Y.Doc` and never restores a stored
client id, since one id with two histories breaks the merge.

`meta.format` versions the shared shape, apart from the file's `schema` (`SCHEMA_VERSION` 2) and the wire protocol
(section 11). A document without it came from main's adapter; shared mode never shipped, so there is no migration.

## 7. Joins and removal

Both are flags, costly rather than wrong: copying a joined visual cell lost another copy's typing there (appendix B),
and deleting a removed beat discards typing made in it unseen (inventory R01).

- **Join.** `joined.into` names the beat before it in `order` at the time of the join. A chain reads as one row: the
  reader follows `into` to the first beat not joined. A cycle (possible after concurrent joins and moves) is broken
  at the beat earliest in order, which becomes a row of its own and is listed in recovery.
- **Edits across a join.** A selection over the seam maps to ranges in each beat's texts; deleting across it deletes
  in both and keeps the flag. Typing at the seam goes to the end of the earlier beat.
- **Splitting a joined row.** At the seam it deletes the flag; elsewhere it is an ordinary split inside the beat that
  holds the position, and the later part keeps its flag.
- **Shared container.** Beats in one segment share one narration `Y.Text`. Deleting the boundary embed would join the
  narration without a flag, and concurrent typing would survive. It is not used: visual cells are separate texts and
  still need the flag, and one mechanism keeps unjoining a single map write.
- **Removal.** `removed = {by, at}`: text stays and restore deletes the key. Typing into a removed beat stays there
  and is recoverable (decided 2026-11-18).
- **Retirement.** Hidden content (a joined beat's fields, a removed beat's text) is never deleted in v1; reclaiming it
  needs compaction, which v1 lacks (plan section 6), so it counts toward long-life size (section 11).

## 8. Experiments, then slices

Before any adapter code, each as a small Node test under `prototypes/collab/src/native-design/`:

| # | Experiment | Passes when |
| --- | --- | --- |
| E1 | Composition fold (section 4) | Appendix B's six histories, plus a boundary removed meanwhile, surrogate pairs and composition through undo, keep every remote change and the composed text |
| E2 | Three copies race split, join, remove and restore in narration and visual cells, then a late joiner loads | All copies agree, and every surviving character has one editable location in the projection |
| E3 | One command sets a flag, formats, creates a record and types, with remote changes interleaved, then undo, redo, undo | Stack lengths, `meta` and observer order as expected; copies agree; the guard's cases if it is chosen |
| E4 | Long life, only if action keys stay: repeated overlapping formatting, then type, paste, unformat, undo | Live keys per character and encoded size reported, with and without the normalisation rule |

Each slice is one pull request and reports, measured as the spike was (spike B): stored bytes per typed character
after the 11,287-character tape with two writers, on a copy without undo history; local keystroke median and p95 at
30, 300 and 900 beats, each the median of 3 rounds of 200 timed keystrokes after 20 untimed. Proposed stop: over 2.0
bytes per typed character (spike 1.84) or a median over 1 ms at 900 beats (spike 0.023 ms; the app limit in
`tools/perf-ab.mjs` is 8 ms). Code goes in `src/adapters/collab/native/`, the only place the dependency gate admits
Yjs (`tools/dep-report.mjs`).

| # | Slice | Exit check |
| --- | --- | --- |
| 1 | Shape, birth, typing, deleting, projection, change sets | Fixtures round-trip; the tape agrees on three copies and a late joiner in every delivery order; birth checks |
| 2 | Formatting, identified marks, atoms | Spike marks generator, 1,000 histories per writer count and delivery; nothing missing or misplaced |
| 3 | Split, join, removal, restore, headings, new beats | E2; Stage 1 traces T01 to T12, T20, T21, T08 and T09 headings; structural time at 900 beats |
| 4 | Records, status, comments, replies, stamps | Record and field tests; record-to-row changes; the status default |
| 5 | Undo settings, grouping, filter, guard if chosen | E3 on the adapter; spike `undo.test.ts`; main's declared limits rerun |
| 6 | Session and editor wiring, composition, test hook | E1 on the Writer; stale-base traces; Writer and Split browser suites |
| 7 | Delete the old adapter and tests | `npm run verify`; nothing imports the old files |

What stays, changes and goes is in [appendix D](#d-what-stays-changes-and-goes).

## 9. Departures from standard Yjs

| Departure | Defect that forces it | Cost | Decision |
| --- | --- | --- | --- |
| A formatting key per action | Key-per-kind defects (section 1; spike D, E) | 100 live keys on a character after 100 prefix bolds; 3,610 bytes against 113; +0.21 bytes per typed character on the tape; 0.37 ms to read a cell with 1,000 keys; E4, a rule and a limit | PENDING |
| The undo guard | None for correctness; identical changes and U13 are preferences (section 3) | About 100 lines; two publications per guarded press; untested `meta` and observer order | PENDING |
| Join as a flag | Copying the joined visual cell loses typing (appendix B) | A map value per join; section 7 rules; hidden fields kept | Needs the owner's decision |
| Removal as a flag | Deleting the beat discards unseen typing (R01) | Removed text kept for the document's life | Decided 2026-11-18 |
| "Later" read for stamps and resolution | None; a preference | Two fields per comment; a key per author per beat; clock skew (section 11) | PENDING |
| Reading without writing back | y-prosemirror's deletion on read loses content | None | Plan section 4, set earlier |
| Repaint waits during composition | Owner rule T04 | The fold (section 4), about the size of y-codemirror.next's observer | T04 set earlier |

Not departures: the delete filter (y-prosemirror's extension point), the status default on read, relative positions
for selections, one transaction per command under the binding's origin, `stopCapturing` at breaks, selections in
stack `meta`, the 200-entry bound. Proposed to drop, for the owner: waiting for a restore before undoing typing in a
removed beat (U14; the undo then happens at once inside the removed beat, still in recovery). Assumed C and D rules
are dropped ([appendix C](#c-rules-dropped)).

## 10. Open questions

| | Question | Settled by |
| --- | --- | --- |
| Q2 | Is regrouping rows after a structural change fast enough at 900 beats? | Slice 3 times against the Stage 0 structural baseline |
| Q4 | How is a heading that heads a segment removed without moving text, and do heading races keep every letter? | Headings against T08 and T09 header traces, which the spike could not run; part of E2 |
| Q5 | If the guard is chosen, can "top entry only" still drop a group that deleted all it typed (U11)? | Detect it from the stack item's own sets (`Y.iterateDeletedStructs`, `Y.isDeleted`); E3 |

## 11. Settled before release

**Garbage collection against undo history.** Yjs keeps every item a tracked transaction deleted, so undo can restore
it. 10,000 characters inserted and deleted stayed in the encoded state after `clear()` (over 10,000 bytes; the
review measured 10,022) and left under 100 bytes, 22 in the review, in a fresh copy (appendix B). History therefore
lives for one session: it is dropped when the copy is rebuilt from stored state, which happens on entry and when an
editing copy's encoded size passes a limit set from Q6's measurement. The rebuild tells the person that undo history
was cleared. The 200-entry bound stays, so history is finite and a rebuild drops a known amount. An editing copy grew
to 3,318,729 bytes against 642,549 reloaded after 102 heavy repetitions (spike C).

**Long-life size.** Live formatting keys (section 1), removed and joined content (section 7) and removed text are
never reclaimed in v1. Before release, a year-long schedule of typical edits on one script reports encoded size,
reload time and keys per character, against a stated ceiling.

**Schema changes and old clients.** `meta.format` changes only when an older copy would misread or misplace what a
newer one writes; new optional fields do not change it, and writers never delete keys they do not know. A copy
refuses to edit a higher `format` and offers export. An older copy already connected could still write before it reads
the new value, so the connection must also carry the format and the server refuse a lower one (server design).

**Presence.** Yjs awareness, per session: the session's client id, the person's id and name, and selections as
relative positions. A cursor inside a removed or joined-away beat shows at the start of the row that holds it.
Awareness removes a silent session's state after its timeout, and a session clears its own state on exit.

**Large pastes and one very large cell.** A paste is one transaction and one update. The command checks its size
against the server's stated message limit before writing, so an update the server would refuse never exists only
locally. Reading a cell with 1,000 keys took 0.37 ms (spike); a cell of 100,000 characters is not measured and is
before release.

**Change reporting.** Section 5's record-to-row index is part of the exit check of slice 4: renaming a tag, a person
or a shot remotely lists exactly the rows that show it.

**Timestamps (PENDING).** *Later wins by clock*: `resolvedAt` against `reopenedAt`, and `edited` per author, so the
later act shows whatever arrives first; a device clock running ahead wins every contest until real time passes it,
with no way to correct it afterwards. *One ordinary map value*: `resolved` and a single last editor per beat; no
clock, nothing extra stored, but of two acts made at once Yjs keeps one by client id, whichever happened later.
Sequential acts are right under both.

## Appendix

### A. Sources

Yjs 13.6.33 `src/utils/UndoManager.js` (`popStackItem`, the after-transaction handler), `src/types/YText.js`;
y-prosemirror 1.3.7 `src/plugins/sync-plugin.js` (`_prosemirrorChanged`, `_typeChanged`, `createNodeFromYElement`
deleting what it cannot render) and `src/plugins/undo-plugin.js` (`defaultDeleteFilter`, `trackedOrigins`, selection
in `meta`); y-codemirror.next 0.3.5 `src/y-sync.js` (the delta observer), `src/y-undomanager.js`; y-quill 1.0.0
`src/y-quill.js`; y-protocols 1.0.6 `sync.js` (`readSyncStep2` calls `Y.applyUpdate`); y-websocket
`src/y-websocket.js` on its default branch, 2026-11-18; Hocuspocus 4.8.0 `packages/provider/src/MessageReceiver.ts`
(`readSyncMessage` on the provider's document, origin the provider); Yjs documentation "Y.UndoManager", "Y.Text",
"Subdocuments", "Document Updates". Review of #1627 for the figures marked "the review".

### B. Two-copy checks added with this note

`prototypes/collab/src/native-design/native-design.test.mjs`, Yjs 13.6.33, Node 24.22.1; all 22 pass. Run
`node --test prototypes/collab/src/native-design/native-design.test.mjs` after `npm ci --prefix prototypes/collab`.

| Check | Result |
| --- | --- |
| Two conversions of one file merged | The order lists the beat twice; one copy's typing is gone |
| Two conversions under one fixed client id, different text | The copies disagree |
| Join by copying the second visual cell while another copy types in it | That typing is gone |
| Join as a flag, the same race | That typing stays |
| Painted `b`, `c` of `abcd` held as relative positions; remote deletes `b`; local deletes `bc` | Both anchors resolve to one place; the commit leaves `a`, deleting `d` too |
| The fold on `abcd`, local deleting `bc`: remote deleted `b`; remote deleted `bc`; remote typed `X` between `b` and `c`; remote put an embed there | `ad`; `ad`; `aXd`; `a`, embed, `d` |
| The fold: remote deleted `b`, local replaces `bc` with `Y`; remote deleted `a`, local types `Y` after `a` | `aYd`; `Ybcd` |
| Deleting painted `bc` by painted offsets after a remote `X` | `acd` |
| Plain undo of a group that deleted all it typed | Passed over; the same press undoes the step before |
| Plain undo of a record's creation after another copy set a field | Record and field gone on both copies |
| `undo()` inside `doc.transact(..., undoManager)` | Text undone; 1 undo entry, 0 redo entries |
| The winner's undo of two identical statuses | Status absent on both copies; redo restores it |
| A fallback status written after that undo | The next redo does nothing |
| Delete filter `type.size > 0` on records, creation undone after another copy set a field | `{colour}` kept on both copies; unchanged record deleted |
| 10,000 characters inserted and deleted, then `clear()` | Over 10,000 bytes encoded; under 100 in a fresh copy |
| 100 growing prefixes bolded with a key per action | 100 live keys on the first character; 3,610 bytes; 1,739 after unformatting all and rebuilding; 113 plain |
| Resolve at 2,000 against an unseen reopen at 1,000 | Resolved on both copies |

### C. Rules dropped

Assumed, class C or D, dropped on 2026-11-18 with no reproduced defect found: M02 to M04, M15; S11 to S15, S22; F03
to F05, F35 to F39; U03, U04, U15, U16, U18, U21, U25 to U33, U39; R02, R03, R05, R06, R08 to R10, R13, R17; Q02,
Q04, Q06, Q07. Owner-set and changed on 2026-11-18: F01 (one of two statuses wins), M01 (kept for selected text).
U02 and U13 now depend on the guard decision. Owner-set and kept: F13, F32, R01. U10 (the 200-entry bound) is kept.

### D. What stays, changes and goes

Wiring switches in slice 6; old files and the tools loading them (`tools/perf-shared.mjs`, `tools/perf-ab.mjs`)
change in slice 7.

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
| Application: `shared-undo.ts`, `replayed-steps.ts` | Shrink to admission, grouping policy and, with the guard, the used-up notice |
| Application: `buffered-field.ts`; features: Writer and cell buffers | Change for the composition fold |
| Application: shared commands; feature: recovery panel | Change where they build unit identities or dropped operations; no discard |
| Bootstrap: `shared-session.ts`, `shared-test*.ts`, `ports/shared-*.ts` | Rewired |

| Tests | Fate |
| --- | --- |
| `tests/collab/delivery.ts` (D1, D2, D3, dup, rev, late-C), `agreement.ts`, `checker.ts`, `oracles/` | Carry over |
| `tests/collab/fixtures.ts`, `fixtures/projection-reference.json` | Carry over as round-trip goldens; dropped rules marked |
| Spike tests: marks generator, `marks`, `undo`, `traces` | Move to `tests/collab/` against the adapter |
| `tests/collab/undo/`, `tests/collab/measure/` | Rewritten on the same harness; the spike's driver replaces main's |
| `tests/adapters/collab/` (173 files), `tests/collab/*-mutants.json` (41 lists) | Deleted: they assert main's stored records; one new mutant list (lost mark, duplicated identity, omitted field, stale base) |
| `src/test/shared-*-app.test.mjs` (41 files) | Kept; outcomes change only for dropped rules |
