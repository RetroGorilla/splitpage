# Design: the shared-document layer on standard Yjs

Proposal, 2026-11-18; nothing is built. It replaces `src/adapters/collab/` under rule 12 of `AGENTS.md` (PR #1624).
Sources: the native spike (draft PR #1623, `prototypes/collab/src/native/REPORT.md`, "spike" below), the rule
inventory (draft PR #1622; rule ids such as M01), the checks added with this note ([appendix B](#b-two-copy-checks-added-with-this-note))
and the Yjs and binding sources in [appendix A](#a-sources). Server, invitations, disk storage, pictures and the
screen are out of scope.

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
| `edited` | `Y.Map` of `Y.Map` | per beat: author name to the time of that author's last typing group |

**Beats, headings, atoms.** A beat or heading runs from its boundary (a segment's `head`, or an embed `{b: id}` or
`{h: id}`) to the next. A split inserts an embed; text never moves between containers. A heading name is ordinary
text after its boundary, so promoting a typed line copies nothing. Atoms are length-1 embeds carrying attributes like
a character (`{k: shotId, label}`, `{w: name}`, `{img: ref}`, `{video, host}`); no concurrent edit can split one.

**Formatting keys.** Native attributes with the value `true`, one key per formatting action (decided 2026-11-18): the
mark name (`b`, `i`, `u`, `s`, `hl`, `dir`, `cue`, `c:<commentId>`, `t:<tagId>`, `l:<url>`), U+001F, the acting
copy's client id and clock in base 36. The reader strips the suffix. Against pile-up: a format command over a range
showing the mark throughout turns it off (`markThroughout` in `src/core/text/edits.ts`); typed text takes its left
neighbour's keys, then is changed, since inserting with explicit attributes writes a marker that later formats to the
end of the text (spike, Surprises); unformatting turns a key off over its run and re-keys only what follows the gap.
What still grows is format-then-unformat over one text: 37 to 38 bytes per act while showing, 15 once unformatted
(spike C). Showing keys cannot be reclaimed; turned-off markers shrink only by Yjs garbage collection (no compaction
in v1, plan section 6).

**Flags and records.** `joined = {into, glue, marks}`: texts stay in their beats; the reader joins rows.
`removed = {by, at}`: text stays; restore deletes the key. Record fields, status included, are plain map values (of
two statuses one wins, decided 2026-11-18). Bodies are whole strings (F40). A comment is resolved while `resolvedAt`
is later than `reopenedAt`, so the later choice shows (decided 2026-11-18). `rank` orders records, ties by id (F30).

**Not stored.** Derived values (`sections`, `firstSceneId`, row order, joined-row fields, paragraph positions until a
paragraph edit commits them (T14), tag extents, comment anchors, recovery entries, durations, a row's
`updatedAt`/`updatedBy` from `edited`); the script's `rev` and last editor (export only, plan 2026-11-09); presence,
colours, cursors (Yjs awareness); undo stacks, guard notes, selections, painted base (memory).

## 2. Writing

Each official binding turns one editor change into one `doc.transact(change, bindingOrigin)` (y-codemirror.next
`update`, y-prosemirror `_prosemirrorChanged`, y-quill `_quillObserver`). Here one command is one transaction:

| Transaction | Origin | Session kind | Undo |
| --- | --- | --- | --- |
| A command, typing included | the replica's local origin object | `edit` | captured |
| A command without undo (resolve, reopen, rule 29 recovery write) | a second, untracked local object | `edit` | no |
| Undo, redo | the `Y.UndoManager` | `replay` | moves between stacks |
| Converting a file | `"hydration"` | `adopt` | no |
| Anything else (the provider) | the provider | `remote` | no |

A compound command (paste over beats, split with fields, cross-beat delete) is one transaction, one undo step, one
publication. Records minted from typed text and the `edited` stamp of a new typing group go in the typing
transaction; `edited` is outside the undo scope, so undo never restores a stamp (F33). Text is addressed by cell,
offset and base revision, as y-codemirror.next applies changes. A direct command is planned and run in one
synchronous call, so it always meets its base; only a buffered edit can be older (section 4). A replacement inserts
before deleting (spike `splice`); offsets never cut a surrogate pair (T11).

## 3. Undo

One `Y.UndoManager` per shared session, made on entry, destroyed on exit (U38).

| Setting | Value |
| --- | --- |
| Scope | every root but `births` and `edited` |
| `trackedOrigins` | the local origin object; remote and hydration untracked (U01, U12) |
| `captureTimeout` | 1,000 ms (U08) |
| `stopCapturing()` | around commands that are not typing, on a cell change, at a word after a space, on undo and redo; the library groups by time alone (spike E) |
| `deleteFilter` | never deletes a beat record or a visual cell holding text |
| `ignoreRemoteMapChanges` | `false`: undo never overwrites another person's field |
| Stack item `meta` | selection as relative positions and the guard's notes, as y-prosemirror's undo plugin does |
| Bound | none proposed: Yjs has none, and trimming `undoStack` frees nothing the manager keeps (Q6) |

**Creations stay out of deletion.** The library undoes a creation by deleting the type with all anyone wrote in it:
undoing a split deleted a collaborator's text in the new visual cell. The filter fixed it in every transaction shape
tested, for 104 bytes per 50 undone splits (spike, Real findings). y-prosemirror's `defaultDeleteFilter` does the same.

**The guard** (about 100 lines: spike `undoStep`, `redoStep`, appendix F). Undo takes the top entry only; a step that
changes nothing is used up, says so and reaches no older step (U13). Each command notes in its stack item what it
meant: a flag's value written and value before; a mark's names, keys in view and range; a created record's fields.
Before undo, a flag no longer holding what was written, or a created record someone changed, makes the step used up.
After undo, a flag still meaning the same (an identical write by someone else) or left blank gets the value before,
and same-name keys over exactly the same characters, unseen when the command ran, are turned off. Redo mirrors it.
Nothing is stored. Accepted gaps (2026-11-18): an undo before the other's identical change arrives leaves it showing;
a later informed identical change is taken back too.

## 4. Incoming updates

A stock provider applies updates itself: Hocuspocus provider 4.8.0 and y-websocket call y-protocols
`readSyncMessage`, which calls `Y.applyUpdate(doc, update, provider)`. This layer checks nothing first and holds no
queue; main's ingress gate, byte bound and per-update trial copy go. Size limits belong to the server (plan section
10). y-prosemirror deletes a node it cannot render; this layer reads leniently and writes nothing back (plan section
4). A boundary without a record, a repeated boundary, a join loop, crossing tags or an unknown key is read by fixed
rules (inventory S07, S08, S17, M08 to M12) and, if it cannot be placed, listed in recovery.

**The hold.** Owner rule T04 (Stage 0, PR #1405): others' changes wait while a person types or composes. An ordinary
keystroke needs nothing, since `beforeinput` and `input` run in one task. Composition spans tasks, and one document
under a stock provider cannot be held without wrapping the provider, so main's hold cannot stay as built:

- **A, proposed.** One document, applied at once; only the repaint of the composing beat waits. On composition start
  the binding takes a relative position per painted character of that beat and maps the final replacement through
  them: deleting painted `bc` keeps an unpainted `X` (`aXd`), where painted offsets give `acd` (appendix B). Adds
  nothing to Yjs.
- **B.** Two documents (plan mechanism 3), forwarding to the editor's only while nothing is held. Double memory, not
  measured.

## 5. Telling the editor what changed

The session's `ReplicaPort` (`src/application/session/shared-session.ts`) stays. As in the spike's `changes()`,
`observeDeep` marks dirty segments, beats and records; a change to `order`, a boundary, `joined` or `removed` is
structural. After each transaction that changed the document the revision advances and the session is told once,
with the kind from section 2. A structural change regroups beats into rows; otherwise only rows owning a dirty beat
are rebuilt, and records by the keys their event names. Rows that differ from those shown become
`SharedProjectionChanges`; the session's plain document is the previous one with those rows replaced, unchanged rows
keeping their identity. Projection never writes, so a remote update and a local no-op send nothing. Spike: a remote
keystroke with its change set took 0.022 to 0.023 ms median at 30, 300 and 900 beats; main 1.58, 6.83 and 23.52 ms.
A structural change at 900 beats is not measured (Q2).

## 6. One birth

The copy that starts sharing converts the script once, in the handoff's creation operation (plan section 9), into an
empty document, in one `"hydration"` transaction that writes `meta.format = 1` and `births[creationId]`. Every other
copy, and the same device after a restart, loads stored state and never converts. Two merged conversions list the
beat twice and drop one copy's typing (appendix B), so: conversion accepts only an empty document, as main's
`hydrateSharedDocument` does; a retried creation reuses the state it converted, keyed by the plan's persisted creation
id; and a document with two `births` stops editing and publishing and keeps export. A fixed client id that would make
two conversions coincide was rejected: with different content the copies disagree (appendix B).

`meta.format` versions the shared shape, apart from the file's `schema` (`SCHEMA_VERSION` 2) and the wire protocol. A
copy refuses to edit a higher `format` and offers export. A document without it came from main's adapter; shared mode
never shipped, so there is no migration.

## 7. What stays, changes and goes

Built in `src/adapters/collab/native/`, since the dependency gate admits Yjs only under `src/adapters/collab/`
(`tools/dep-report.mjs`). Wiring switches in one slice; old files and the tools loading them (`tools/perf-shared.mjs`,
`tools/perf-ab.mjs`) change in the next.

| Code | Fate |
| --- | --- |
| Adapter: document state, ingress gate, trial replica, read caches; identities, anchors, text units, birth, creation and mark records; undo executors | Go: Yjs items, relative positions, `Y.UndoManager` and the guard replace them |
| Adapter: executors and preparation | Rewritten as four writers: text, formatting, structure, records |
| Adapter: projection, indexes; hydrate, text import | Rewritten: section 5; the one birth |
| Adapter: buffer, painted base, recorded selection | Change with Q1 |
| Adapter: B-roll keying, move refusal | Stay as policy |
| Core: `operations.ts`, `read-operation.ts`, `base-reference.ts` | Change: text by cell, offset and base; kinds for dropped rules go (split and segment retire and restore, status events, `text-restore`, `mark-retract`, `discard`) |
| Core: `undo-record.ts` | Goes; a description keeps label, selection, typing key |
| Core: `recovery.ts`, `removal-state.ts` | Change: discard, deleted people and deleted records go |
| Core: projection, buffer, cell text, comment marks, records, B-roll, refusals | Stay |
| Application: `shared-session.ts` | Stays |
| Application: `shared-undo.ts`, `replayed-steps.ts` | Shrink to admission, hold, grouping policy, used-up notice |
| Application: `buffered-field.ts`; features: Writer and cell buffers | Change with Q1 |
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

## 8. Slices

One pull request each, in order. Each reports, measured as the spike was (spike B): stored bytes per typed character
after the 11,287-character tape with two writers, on a copy without undo history; local keystroke median and p95 at
30, 300 and 900 beats, each the median of 3 rounds of 200 timed keystrokes after 20 untimed, command to change set.
Proposed stop: over 2.0 bytes per typed character (spike 1.84) or a median over 1 ms at 900 beats (spike 0.023 ms;
the app typing limit in `tools/perf-ab.mjs` is 8 ms).

| # | Slice | Exit check |
| --- | --- | --- |
| 1 | Shape, birth, typing, deleting, projection, change sets | Fixtures round-trip; the tape agrees on three copies and a late joiner in every delivery order; birth checks |
| 2 | Formatting keys, identified marks, atoms | Spike marks generator, 1,000 histories per writer count and delivery, nothing missing or misplaced; M-loss and neighbouring bold keep all selected formatting |
| 3 | Split, join, removal, restore, headings, new beats | Stage 1 traces T01 to T12, T20, T21, T08 and T09 headings; structural time at 900 beats |
| 4 | Records, status, comments, replies, stamps | Record and field tests; resolve against reopen |
| 5 | Undo settings, grouping, filter, guard | Spike `undo.test.ts`; rewritten decided rows; main's declared limits rerun |
| 6 | Session and editor wiring, the hold, switch the test hook | Stale-base traces with composition; Writer and Split browser suites |
| 7 | Delete the old adapter and tests | `npm run verify`; nothing imports the old files |

## 9. Departures from standard Yjs

| Departure | Defect that forces it | Cost | Decision |
| --- | --- | --- | --- |
| A formatting key per action; typing continues its left's keys | Name keys lost formatting nobody removed in 110 to 155 of 1,000 histories; undone bold came back on everything after plain text typed inside it (spike D, E) | +0.21 bytes per typed character (36,847 against 34,548); 37 to 38 bytes per stacked act; 0.37 ms to read a cell with 1,000 keys | Decided 2026-11-18 |
| Undo guard for identical changes and status | The winner's plain undo blanks a status (spike F) | Nothing stored; about 100 lines; time not measured | Decided 2026-11-18 |
| Undo takes the top entry only | Plain undo of a used-up step undoes an older one (spike, Surprises) | Part of the guard | Owner rule U13, set earlier |
| A record creation's undo used up once the record changed | Plain undo deletes another copy's field with the record (appendix B) | The fields per entry, in memory; not measured | Needs the owner's decision |
| Beat removal as a flag | Deleting the beat discards typing made in it unseen (inventory R01, R-beat) | Removed text stays stored; not measured alone | Decided 2026-11-18 |
| Join as a flag | Copying the joined visual cell loses typing made there (appendix B) | One map value per join; not measured alone | Needs the owner's decision |
| Reading without writing back | y-prosemirror's deletion on read loses content | None | Plan section 4, set earlier |
| "Later" read for `edited`, resolve and reopen | None; a preference | Not measured; a key per author per beat, two per comment | Decided 2026-11-18 |
| Remote changes wait during composition | Owner rule T04; way A adds nothing, way B a second document | B: memory not measured | T04 set earlier; the way needs the owner's decision after Q1 |

Not departures: the delete filter (y-prosemirror's), relative positions, one transaction per command under the
binding's origin, `stopCapturing` at breaks, selections in stack `meta`. Proposed to drop, for the owner: the
200-entry bound (U10) and waiting for a restore before undoing typing in a removed beat (U14; the undo then happens at
once inside the removed beat, still in recovery). Assumed C and D rules are dropped ([appendix C](#c-rules-dropped)).

## 10. Open questions

| | Question | Settled by |
| --- | --- | --- |
| Q1 | Does way A keep composed text and every remote change, and does the Writer repaint in the task of a remote publication, so no keystroke lands on an unpainted beat? | Stage 1 stale-base and "integrated, unpainted, keystroke lands" traces, across a boundary, with repeated text, in composition and through undo, on the slice 1 layer |
| Q2 | Is regrouping rows after a structural change fast enough at 900 beats? | Slice 3 times against the Stage 0 structural baseline |
| Q3 | Can an undo press and the guard's writes be one transaction, publication and redo item? | A two-copy test running `undo()` inside `doc.transact(..., undoManager)` |
| Q4 | How is a heading that heads a segment removed without moving text, and do heading races keep every letter? | Headings on the spike variant against T08 and T09 header traces, which the spike could not run |
| Q5 | Can "top entry only" still drop a group that deleted all it typed (U11), which plain undo passes over (appendix B)? | Detect it from the stack item's own sets (`Y.iterateDeletedStructs`, `Y.isDeleted`); test both cases |
| Q6 | What does an editing copy's memory do unbounded? After 102 heavy repetitions it encoded 3,318,729 bytes against 642,549 reloaded (spike C) | Heap over the heavy schedule with and without `clear()` at a limit, decided with the local replica design |
| Q7 | What is "later" when device clocks disagree? | The owner accepts wall-clock time or names another order |

## Appendix

### A. Sources

Yjs 13.6.33 `src/utils/UndoManager.js`, `src/types/YText.js`; y-prosemirror 1.3.7 `src/plugins/sync-plugin.js`
(`_prosemirrorChanged`, `_typeChanged`, `createNodeFromYElement` deleting what it cannot render) and
`src/plugins/undo-plugin.js` (`defaultDeleteFilter`, `trackedOrigins`, selection in `meta`); y-codemirror.next 0.3.5
`src/y-sync.js`, `src/y-undomanager.js`; y-quill 1.0.0 `src/y-quill.js`; y-protocols 1.0.6 `sync.js` (`readSyncStep2`
calls `Y.applyUpdate`); y-websocket `src/y-websocket.js` on its default branch, 2026-11-18; Hocuspocus 4.8.0
`packages/provider/src/MessageReceiver.ts` (`readSyncMessage` on the provider's document, origin the provider); Yjs documentation "Y.UndoManager", "Y.Text", "Subdocuments",
"Document Updates".

### B. Two-copy checks added with this note

`prototypes/collab/src/native-design/native-design.test.mjs`, Yjs 13.6.33, Node 24.22.1; all nine pass. Run
`node --test prototypes/collab/src/native-design/native-design.test.mjs` after `npm ci --prefix prototypes/collab`.

| Check | Result |
| --- | --- |
| Two conversions of one file merged | The order lists the beat twice; one copy's typing is gone |
| Two conversions under one fixed client id, different text | The copies disagree |
| Join by copying the second visual cell while another copy types in it | That typing is gone |
| Join as a flag, the same race | That typing stays |
| Delete painted `bc` of `abcd` through relative positions after an unpainted `X` | `aXd` on both copies |
| The same by painted offsets | `acd` |
| Plain undo of a group that deleted all it typed | Passed over; the same press undoes the step before |
| Plain undo of a record's creation after another copy set a field | Record and field gone on both copies |
| Resolve at 2,000 against an unseen reopen at 1,000 | Resolved on both copies |

### C. Rules dropped

Assumed, class C or D, dropped on 2026-11-18 with no reproduced defect found: M02 to M04, M15; S11 to S15, S22; F03
to F05, F35 to F39; U03, U04, U15, U16, U18, U21, U25 to U33, U39; R02, R03, R05, R06, R08 to R10, R13, R17; Q02,
Q04, Q06, Q07. Owner-set and changed on 2026-11-18: F01 (one of two statuses wins), M01 (kept for selected text),
U02 (the guard, with its gaps). Owner-set and kept: F13, F32, R01.
