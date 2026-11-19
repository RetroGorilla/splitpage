# Design: the shared-document layer on standard Yjs

Round 5, 2026-11-19. Nothing is built.

When several people open one script together, each copy holds a shared document that the library Yjs keeps in
step. This note designs that layer: storage, commands, reading, undo, the relay and the offline notice. It
replaces `src/adapters/collab/` under rule 12 of `AGENTS.md`: a library's standard behaviour is the default, and
anything on top needs a reproduced defect, its measured cost and the owner's decision. Every figure names its result
file ([appendix A](#a-sources)). Accounts, invitations, pictures and screen design are out of scope.

## Decisions made

All decided by the owner on 2026-11-18.

| # | Decision | What a person will notice | Source |
| --- | --- | --- | --- |
| 1 | Standard Yjs. Beats share a segment's text, cut by boundary markers; each beat has a record and a visual cell | Nothing directly | Spike, E2 |
| 2 | A shared script stays on the server between sessions; 15 MB bounds its whole shared life; server storage and backups are in the first version | Reopen any time; an offline copy can return days later | Owner |
| 3 | A plain formatting key per kind; a key per application for production tags only; standard writes; explicit attributes on every insert | Two people formatting touching words at once can lose some bold. Tags: section 5 | E4, E6, E11 |
| 4 | Removing a beat really deletes its text, boundary, record and visual cell | Others' unseen changes to it go with it | E9, E11 |
| 5 | A heading's name has its own text cell; the heading keeps its boundary, record, rank and `removed` mark | A removed heading restores with its name; narration never ends up in a title | E5, E11 |
| 6 | Reading rules (a) to (f) show stray narration, writing nothing | Letters typed into a removed beat appear in a nearby row, editable | E9, E11 |
| 7 | No command copies narration | A split inside recovered text breaks at the nearest point needing no copy | E11 |
| 8 | Undo is `Y.UndoManager` with core Yjs's default delete filter | Undo takes back only your own changes; snapshots and autosave go further back | E3, E11 |
| 9 | Moves with flat ranks: one sortable position per block | A beat split while you move it leaves its second half behind | E10, E11 |
| 10 | Comment and reply bodies are whole values only their author edits; anyone may resolve or remove | Two choices at once: one wins everywhere | Appendix B |
| 11 | The size limit is 15 MB | A full-size script opened in about 1.6 s | E8 |
| 12 | Offline merges get a notice listing clashed beats with "put it back", reusing the file-merge banner and review list | One banner after reconnecting | E12 |
| 13 | The relay runs on the owner's own server (plan of record); presence is late and optional | — | Plan |

**The guide for same-spot, same-moment conflicts** (owner): it is enough if they merge without losing data about
nine times in ten; a guide, not a hard rule, and stricter where a defect must never happen (section 6). The
experiments built their histories to hit bad cases, so their counts are not rates in real use.

**E11's verdict:** "With both parts, the combination holds, except for one thing that rule (e) leaves open." The
parts are the corrections to the reader and writers, and names in their own cells.

## Open for the owner

| # | Question | Options, and what a person would notice | Coordinator's recommendation |
| --- | --- | --- | --- |
| 1 | How should reconnect behave? | **(a)** Stock. After a dropped or silently dead connection, formatting you changed, undid and redid across the drop can disappear on every copy (5 of 22 pair kinds, every run); text is never lost. **(b)** A 38-line wrapper around the stock provider holds document sends until the client's own state reply has gone out. That loss did not occur in any measured pair; edits in the first moment after a reconnect reach others one round trip later (about 29 ms in the test); an offline stretch uploads half the bytes. A departure under rule 12, with a reproduced defect and a measured cost (E13) | (b) |
| 2 | How long may a first load wait? | **(a)** Keep the stock 30 s. A script loads if its whole state arrives within about 30 s: roughly 3.5 MB at 1 Mbit/s, 7 MB at 2 Mbit/s, 14 MB at 4 Mbit/s (worked out from E13; 15 MB failed at 4). A larger script on a slower link restarts forever. **(b)** 180 s. Those loads finish (129 s at 1 Mbit/s); a silently dead connection shows "connected" for about four minutes instead of 36 to 39 s (E13) | (a) for now: it is the library's default and only bites on large scripts over slow links; revisit when a script nears that size |
| 3 | What does the offline notice claim when it cannot tell whether the other person had seen your change? | E12's options. **(a)** Show possible clashes for visual and record edits; some people see a card even when the remover saw their edit. **(b)** Use the evidence available for narration and withhold ambiguous cards; a person could lose an unseen visual edit with no card. **(c)** Carry evidence of what the deleter had seen; a stronger card that depends on that evidence surviving disconnects | Show possible clashes, worded as "a beat you changed was removed" with what you had, never as "they had not seen it" |
| 4 | A production tag lost through someone's unseen delete-and-undo (5 of 845 in E11) | **(a)** Accept it silently, as library behaviour. **(b)** The notice flags it with E12's rule (7 of 7 losses flagged in its sweep). The person returning is told; one who stayed online is not | (b) |

Smaller points, with the design's defaults, are in [appendix I](#i-smaller-open-points).

## 1. Stored shape

One `Y.Doc` per script. Segment text (`Y.Text`) holds narration and one-unit boundary embeds, `{b}` for beats and
`{h}` for headings; a segment's first block is named by its `head` key. Visual cells and heading names are separate
`Y.Text`s. Records are `Y.Map`s: each beat and heading has a `rank`, a joined beat `joined = {into, glue}`. Every
other field is a plain value; of two writes at once Yjs keeps one. Roots: [appendix G](#g-roots).

**Formatting.** Plain keys `b`, `i`, `u`, `s`, `hl`, `dir`, `cue`, `c:<commentId>`, `l:<url>`. A production tag is
`t:<tagId>`, U+001F, then the writer's client id and clock, fresh per application (E3b). Keys build up where a tag
is reapplied, 301 on one letter after 300 rounds (E6); that growth is accepted.

## 2. What each command writes

Each command is one transaction.

| Command | Writes |
| --- | --- |
| Type, paste | `insert` with an explicit attributes object, before any delete |
| Bold and other plain kinds | `format` with the plain key, `true` or `null` |
| Tag, untag | A fresh application key; untag sets `null` on the keys seen. No re-keying |
| Split | Boundary, record copying the parent's rank, visual cell. Never narration |
| Join, unjoin | Set or delete `joined` on the lower beat |
| Remove beats | The observed text with its boundary (or `head`), the records, the visual cells; the segment stays |
| Create, rename, remove heading | Boundary or segment, record, rank, name cell; rename edits the name cell; remove sets `removed` |
| Move | A new rank per moved block, and the shown rank of a rankless neighbour (rule (e)); a tie at the drop re-ranks the right side |
| Fields, status, resolve, body | `Y.Map.set`, only if the value differs (appendix B) |

Every writer finds its target by id when it runs and refuses a missing one rather than throw (E1). A compound checks
every part before writing (appendix B). Composition folds in remote changes made meanwhile (E1). The reader writes
nothing back. The file is converted once, and every copy adopts that conversion (appendix B).

## 3. Reading rules

Blocks show in rank order; ties follow stored order (E10). A joined beat shares the row above (E2). Six rules make
every surviving letter reachable without writing anything.

| Rule | What a person sees | Known limit (E11) |
| --- | --- | --- |
| (a) Text before a segment's first boundary belongs to that segment's first beat, or to the row above if the segment has no beat | Letters typed in a removed beat that headed its segment show at the start of the next beat | — |
| (b) An empty script holding stray letters shows them as a narration-only row | Stray letters stay on screen | — |
| (c) A boundary repeating a beat id is ignored | Two people remove a row and both undo: it returns once, narration twice (`xx`) | — |
| (d) A join counts only if its target is the beat directly above | A beat whose target was removed or moved shows as its own row | A later move can make an old join count again (11 in 600) |
| (e) A beat whose record has no rank is read at its stored place | An undone deletion of a beat someone moved unseen brings it back where it was stored | No fixed place: a later unrelated command can move it, even across a scene line. 0 of 1,600 generated histories; a six-step hand-built case |
| (f) Text between a heading's boundary and the next boundary is narration without a beat, shown in the first of: the beat directly after the heading, the nearest beat above, the next beat further down, the narration-only row | Letters typed in a deleted scene's beat show in a neighbouring beat, editable | The third step can show it under a different scene, and it moves with that beat |

Rule (e) exists because Yjs does not redo a map entry a newer write replaced; without it the reader threw in 5 of
600 histories (E11).

## 4. Undo

One `Y.UndoManager` per person over every root a command writes, headings and names included, not `births` or
`edited`. Only the local command origin is tracked. Grouping follows the app's word rule with `stopCapturing()`
(E3). Default delete filter; no depth cap.

- Undo takes back only the presser's changes; a press can pass over spent steps to an older one (E11).
- Undoing a deletion does not bring back fields overwritten unseen: rank (rule (e)), status, join (E11). A beat cut
  and restored by its deleter's undo comes back without others' unseen visual text, status, fields and tags (E12).
- Undoing a creation removes everything written into it, seen or unseen; the creator's redo brings back only what
  the creator had seen (E11).
- One press can send two updates; the editor shows one change, the transport sends both (E3b). `undo()` is called
  directly (appendix B).

## 5. Accepted losses

E11, 600 generated histories, names in cells. Counts are occurrences within those built-to-clash sets.

| Loss | Count | Notes |
| --- | ---: | --- |
| Unseen record change discarded with a deleted beat | 131 | 14 at the same moment, 117 offline (3-step window) |
| Unseen visual change discarded with a deleted beat | 106 | 19 at the same moment, 87 offline |
| Typing in a new beat lost when its creator undoes the creation unseen | 3 | Seen writes go too (appendix B) |
| Typing in a new heading's name lost when its creator undoes the creation unseen | 1 | The one loss names in cells add |
| A split next to a move left the second half at the old place | 1 | E10: all 8 histories of that collision |
| A deletion missed a row that someone's unseen undo had restored | 3 | |
| A double delete and double undo doubles the narration | 3 | |
| Production tag lost | 5 of 845 | Section 5a |
| Two people dropping into each other's spot: neither request met | — | E10: all 8 histories |

**5a. Tags.** Of 845 requested tags, 800 were kept, 40 undone by their author and 5 lost (E11). Both causes are
plain Yjs, the same for bold: an undo the tagger had not seen restored deleted letters as new ones, leaving the tag
on the originals (4); a letter shown twice after a double delete and double undo carries the tag on one copy (1).

Outcomes that lose nothing are in [appendix H](#h-outcomes-that-lose-nothing).

## 6. Never acceptable

| Defect | Evidence (E11, names in cells: E9's 2,257 runs; E10's 229, 600 new and 200 double-split histories in five deliveries) |
| --- | --- |
| Narration stored but in no row, or shown but not editable | 0 in every set. With names inline it was 27 letters in 19 of 600 |
| A beat shown twice, or its surviving narration nowhere | 0 in every set. Narration shown twice by a command of ours: 0 |
| Copies disagreeing after everything is delivered | 0 in every set, and in E1 to E10 |
| A thrown error in a reader or writer | 0 in every set. Writers still threw under controls when a muted write left a new heading's record missing (39); section 2 makes that a refusal |
| An existing beat changing scene with one person working | 0 in every set, **except rule (e)'s open case**: a six-step hand-built history moves a rankless beat out of its scene on its own copy. E14 asks whether a different removal closes it |

## 7. Requirements on the product code

- **No copying** (E11): a first version whose split copied text doubled it when two people split at once.
- **Explicit attributes** on every insert, standard tag writes (E6).
- **Relay order** (E3b, E13): each writer's updates arrive in order or merged; question 1 decides reconnect.
- **Crossing tags** need a read-side fix (E6; appendix I).
- **Incremental reading** (E8, E11): the Yjs write is 0.02 to 0.07 ms; rebuilding every row is 84 to 99% of a
  900-beat command. Rebuild only touched rows and walk a cell once per key.
- **Memory** at 15 MB: 344 MiB in a Node copy (E8), 306.9 MiB on the server per open script (E13).
- **Storage** (E13): each store rewrites the whole snapshot (438 ms encode at 15 MB), 2 to 10 s after an edit; a
  positive status does not mean saved.
- **Signals** (E13): no stock event means "caught up both ways"; `synced` and a zero pending count both held while a
  download was still held back.

## 8. Relay and size

The relay is stock Hocuspocus 4.8.0. It kept order on steady connections, bursts, late joins, long offline
stretches and a restart (E13). The one break: an undo sent into a dead socket and a redo queued for the reconnect
reach the server redo first. Only formatting was lost; no stock setting prevents it (question 1).

| At 15 MB | Result |
| --- | --- |
| Keystroke median (E8) | 0.201 ms |
| First join, cold server / late join, warm (E13) | 4.99 s / 1.98 s |
| First download at 1, 2, 4 Mbit/s: stock / 180 s timeout (E13) | Restarted at 35 to 39 s, never finished / 129.3, 80.0, 35.9 s |
| Years that fill it, one writer (E8) | About 37 realistic or 6.8 heavy |

**First upload.** The built-in server's 30 s heartbeat sweep ends a connection still receiving one large message,
with no setting for it. Its largest tested uploads were about 7 MB at 1 Mbit/s and 14 MB at 2 Mbit/s; 15 MB passed
at 4 Mbit/s (E13). The design accepts that ceiling (appendix I).

## 9. Offline notice

On reconnecting, a copy compares its own state with the merged result, per beat, and lists beats it changed that
someone else changed or removed. "Put it back" makes a fresh beat from what the person had, as one undo step (E12).

- **Counts** (E12, 325 histories): with an ideal base, 64 false banners and 16 misses (all a split-off half left
  behind after a move); with the person's own journal of pending edits and no base, 46 and the same 16. The design
  uses the journal, because no client can observe a "last state both had" moment (E13).
- **Seen against unseen.** For visual text, visual tags, status and fields, a seen and an unseen edit left identical
  evidence: a card warns in both or misses one. Narration was told apart in the tested pairs.
- **Who is told.** Only the returning person. A deleter offline while the typist stayed online leaves nobody told
  (E11).
- **Put it back** shows words twice if a reading rule already shows them above, would add a third copy after a
  double delete and double undo, and gives two rows when two people do it.
- **Reuse:** the banner, the paired-text formatter and the two-side review layout carry over; wording, "Review" and
  the confirm action change.

## 10. Experiment still running: E14

A variant where removing a beat deletes only its narration and boundary, keeping its record and visual cell. Does
that remove rule (e)'s open case, the cut-and-undone loss and the unseen record and visual losses, and at what cost?
Result pending.

## 11. Build order

Each slice is one pull request in `src/adapters/collab/native/`, the only place the dependency gate admits Yjs.

| # | Slice | Gate |
| --- | --- | --- |
| 1 | Shape, conversion, typing, deleting text, incremental reader | The spike's tape on three copies and a late joiner; a 900-beat structural change within 8 ms |
| 2 | Formatting and tags | E4, E6 and E11's tag counts on the adapter; crossing display |
| 3 | Split, join, removal, headings with name cells, reading rules (a) to (f) | E9, E10 and E11 sets on the adapter; section 6 at zero apart from rule (e)'s case, or E14's answer |
| 4 | Moves | E10's collision table, flat column or better |
| 5 | Records, status, comments | Exact row changes; author-only bodies |
| 6 | Undo | E3 and E11 undo tests; one change per press |
| 7 | Session, editor, relay, server storage, offline notice | The reconnect decision (question 1) with E13's pair table; E12's counts; a 15 MB first load on a slow link; store and reload |
| 8 | Delete the old adapter | Every deleted test mapped; `npm run verify` |

## 12. What changed in round 5

- **Rooms stay on the server** (owner); the session-only proposal is dropped and the relay host settled.
- **Heading names in their own cells:** inline, narration typed in a deleted scene ended up inside a removed title,
  in no row, and no rule could tell a title from stray letters (E11).
- **Rules (e) and (f)** added, with their limits; **no command copies narration**, after a copying split doubled
  text (E11).
- **Undo:** what it does not bring back is stated (E11, E12).
- **Tags:** E11's counts and E12's flag rule replace the lost-tag question.
- **Relay, loads and the notice** rest on E13 and E12; only E14 is pending.

Round 4's list is in [appendix K](#k-round-4-changes).

## Appendix

### A. Sources

Result files, under `prototypes/collab/src/`:

| Name | File |
| --- | --- |
| Spike | [`native/REPORT.md`](../../prototypes/collab/src/native/REPORT.md) |
| E1, composition | [`native-e1/RESULT.md`](../../prototypes/collab/src/native-e1/RESULT.md) |
| E2, split and join races | [`native/E2-RESULT.md`](../../prototypes/collab/src/native/E2-RESULT.md) |
| E3 and E3b (its follow-up with the chosen keys), undo | [`native-undo/RESULTS.md`](../../prototypes/collab/src/native-undo/RESULTS.md) |
| E4, formatting keys | [`format-keys/RESULT.md`](../../prototypes/collab/src/format-keys/RESULT.md) |
| E5, headings | [`native/E5-RESULT.md`](../../prototypes/collab/src/native/E5-RESULT.md) |
| E6, production tags | [`format-keys/E6-RESULT.md`](../../prototypes/collab/src/format-keys/E6-RESULT.md) |
| E7, moves by placement | [`native-moves/RESULT.md`](../../prototypes/collab/src/native-moves/RESULT.md) |
| E8, size | [`native-size/RESULT.md`](../../prototypes/collab/src/native-size/RESULT.md) |
| E9, real deletion | [`native-delete/RESULT.md`](../../prototypes/collab/src/native-delete/RESULT.md) |
| E10, move ranks | [`native-moves/E10-RESULT.md`](../../prototypes/collab/src/native-moves/E10-RESULT.md) |
| E11, the chosen combination | [`native-chosen/RESULT.md`](../../prototypes/collab/src/native-chosen/RESULT.md) |
| E12, the offline notice | [`native-notice/RESULT.md`](../../prototypes/collab/src/native-notice/RESULT.md) |
| E13, the stock relay | [`native-relay/RESULT.md`](../../prototypes/collab/src/native-relay/RESULT.md) |

Library sources read: Yjs 13.6.33 `src/utils/UndoManager.js`, `src/types/YText.js`; y-prosemirror 1.3.7
`sync-plugin.js`, `undo-plugin.js`; y-codemirror.next 0.3.5 `y-sync.js`, `y-undomanager.js`; y-protocols 1.0.6
`sync.js`; Hocuspocus 4.8.0 server and provider; the Yjs documentation on `Y.UndoManager`, `Y.Text`, `Y.Doc`,
document updates and relative positions. Rule ids such as U14 are from
[`native-rule-inventory.md`](native-rule-inventory.md).

### B. Checks

`prototypes/collab/test/native-design/native-design.test.mjs`, Yjs 13.6.33, Node 24.22.1; all 19 pass. Run
`npm ci --prefix prototypes/collab`, then `node --test test/native-design/native-design.test.mjs` in
`prototypes/collab`.

| Check | Result |
| --- | --- |
| Two independent conversions of one file, merged | The beat listed twice; one copy's typing gone |
| Two conversions under one fixed client id, different text | The copies disagree |
| A retried conversion under one creation id, both copies typing | One `births` entry, the segment listed twice, one copy's typing gone |
| Join by copying the second visual cell while another copy types in it / join as a flag | That typing gone / kept |
| A throw after the first write in `doc.transact` | The first write committed and sent |
| A map key set to its current value | One update sent; the remote observer called |
| A visual cell replaced after a position was taken in it | The position resolves to `null`; a write through the old cell is not shown |
| Plain undo of a group that deleted all it typed | Passed over; the same press undoes the step before |
| Plain undo of a record's creation after another copy set a field, seen by the undoer | Record and field gone on both copies |
| `undo()` inside `doc.transact(..., undoManager)` | 1 undo entry, 0 redo entries |
| Two identical statuses, the winner undoes / a fallback written after | Absent on both, redo restores / the next redo does nothing |
| Both copies delete the same `b` of `abc` and undo before seeing each other's undo | `abbc` on both |
| 10,000 letters inserted and deleted under undo, then `clear()` | Over 10,000 bytes encoded; under 100 in a fresh copy |
| 100 growing prefixes, each formatted under its own application key | 100 live keys on the first letter; 3,610 bytes; 1,739 in a fresh copy after removing them all; 113 plain |
| A 1,000-letter paste | 1,014 bytes plain; 37,809 with one key per letter; 145,593 with four |
| A new history built from the visible text, synced with the old | The text doubled |
| A comment body as a whole string, two people adding at once | One addition kept, the same on both copies |

The cleared-undo check backs the rebuild in appendix C. The rebuilt-history check is why a stored room is never
rebuilt from its visible text. The paste check is why size is counted in encoded bytes: a command that would pass
15 MB is refused before writing.

### C. Costs and rebuild

| Cost kept for the document's life | Bytes | Source |
| --- | --- | --- |
| Split | 54.51 | E2 |
| Live join | about 40 | E2 |
| Heading name in its own cell, per heading | 13 to 15 | E11 |
| Flat-rank row move, kept / sent | 9.19 / about 38 | E10 |
| Production tag history per application, plain key / per-application key | 50.2 / 70.9 to 72.2 | E6 |
| Tag keys over a script's life | about 9 to 10% more | E6 |

An editing copy keeps every letter its own undo history deleted, and `clear()` frees none (appendix B): pasting and
deleting a 10,000-letter block 100 times gave 1,003,678 encoded bytes against 3,678 in a fresh copy (E3). A copy
loads fresh on entry and rebuilds from its stored state at an idle moment once its own deleted letters pass a
threshold (E3 proposes 1,000,000), telling the person undo history was cleared.

The notice's comparison took 1.65 to 1.68 ms median at 900 beats, and capturing a reading 10.2 to 11.6 ms (E12).

### D. Rules decided or dropped

Decided 2026-11-18: R01 (removal is a real deletion; unseen changes go with the beat), F40 (whole bodies, author
only), U14 (moot), and, as in round 3, F01, M01, U02, U13, F13, F32. Dropped with no reproduced defect: M02 to M04,
M15; S11 to S15, S22; F03 to F05, F35 to F39; U03, U04, U15, U16, U18, U21, U25 to U33, U39; R02, R03, R05, R06, R08
to R10, R13, R17; Q02, Q04, Q06, Q07. Dropped after E3: U10.

### E. What stays, changes and goes

| Code | Fate |
| --- | --- |
| Adapter: document state, ingress gate, trial replica, read caches, identities, anchors, text units, birth, creation and mark records, undo executors | Go: Yjs items, relative positions and `Y.UndoManager` replace them |
| Adapter: executors and preparation | Rewritten as four writers: text, formatting, structure, records |
| Adapter: projection, indexes, hydration, text import | Rewritten: the incremental reader and one conversion |
| Adapter: buffer, painted base, recorded selection | Replaced by the composition fold |
| Adapter: move refusal | Goes: moves are in |
| Core: `operations.ts`, `read-operation.ts`, `base-reference.ts` | Change: text by cell, offset and base; operations for dropped rules go |
| Core: `undo-record.ts` | Goes; a description keeps label, selection, typing key |
| Core: `recovery.ts`, `removal-state.ts` | Change: removed beats go; removed headings and local refused text stay |
| Core: `merge/review.ts`; feature: `merge/banner.ts` | Reused by the offline notice, with new wording |
| Application: `shared-session.ts` | Stays |
| Application: `shared-undo.ts`, `replayed-steps.ts` | Shrink to admission and the grouping rule |
| Tests: `tests/collab/` delivery, agreement, checker, fixtures | Carry over; dropped rules marked |
| Tests: `tests/adapters/collab/` (173 files), `tests/collab/*-mutants.json` (41 lists) | Deleted once slice 8 maps each behaviour to its replacement |
| Tests: `src/test/shared-*-app.test.mjs` (41 files) | Kept; outcomes change only for dropped rules |

### F. Evidence rule for generated tests

The model imports neither Yjs nor the code under test. A clean baseline passes, then each effective write is muted
once; each mute must be caught at the command that made it, before a later command fails for a missing target. A
throw or lost coverage fails the control. Every value read from the implementation is listed with what it limits.
E5's checks are the template.

### G. Roots

| Root | Holds |
| --- | --- |
| `meta` | Format version, `docId`, timing settings, the file's schema, unknown file fields as one JSON string; `title` as `Y.Text` |
| `births` | Creation id to `{at, by}`: the one conversion of the file |
| `order` | Segment keys in stored order |
| `segments` | Per segment: `head` (`{b: beatId}` or `{h: headingId}`) and `text` (narration and boundaries) |
| `beats` | Per beat: `rank`, `status`, `lengthSeconds`, `paragraphStart`, `extra`; `joined = {into, glue}` when set |
| `visuals` | One visual cell (`Y.Text`) per beat |
| `headings` | Per heading: `rank`, other fields; `removed` when set |
| `names` | One name cell (`Y.Text`) per heading |
| `comments`, `replies`, `people`, `tags`, `shots` | The file's fields; bodies are whole strings |
| `edited` | Per beat, `{by, at}` of the last typing |

### H. Outcomes that lose nothing

E11, 600 generated histories, names in cells, unless marked:

| Outcome | Count |
| --- | ---: |
| A split inside rule-read text placed at the nearest point | 8 |
| An undo press passed over items that no longer changed anything | 16 |
| A move made an old join count again (rule (d)) | 11 |
| An undo of a move did nothing visible | 8 |
| Letters whose fate Yjs decides, all absent at the end | 10 |
| Formatting differing by delivery order, marks only | 8 histories |
| An undo press changed only formatting on letters someone else had erased | 2 |
| A restored row without a rank read at its stored place (rule (e)) | 5 histories |

Also, with no text lost: plain bold in E4's 60 two-copy trials, 72 letters missing bold at merge and 34 left bold
after an undo; text composed beside a deleted letter landing across a same-moment insertion, 25 of 20,000 (E1); two
people deleting the same `b` of `abc` and both undoing give `abbc` (appendix B); a letter at a tag's edge takes the
tag by client order (E6).

### I. Smaller open points

Each is the design's default unless the owner objects.

| Point | Default | What a person notices |
| --- | --- | --- |
| A split whose caret is inside recovered text | Nearest point that needs no copy, as built (E11) | With recovered `X` before the beat's own `b`, asking for a break before `X` gives `B: X` / `N: b`; with `X` after `b`, a break at the end gives `B: b` / `N: X`. The break moves by the whole recovered text |
| Where rule (f) places narration with no beat in its scene | As built (E11) | Rarely, a few letters from a deleted scene start a row in the next scene and move with it |
| A beat with no rank | Rule (e), as built; E14 pending | The row returns where it was stored and, rarely, a later command moves it |
| Undoing a heading's creation after an unseen rename | Plain undo; the rename is lost (1 in 600, E11) | The heading and the rename disappear |
| An old join counting again after a move | As built (11 in 600, E11) | Rarely, a moved row merges with the row it was once joined to |
| Formatting that differs by delivery order | Accept: library behaviour (E11) | A mark's exact edge can differ; copies agree once everything is delivered |
| What happens at 15 MB | Refuse the edit with a message and an export; warn from 12 MB | A warning, then a refusal with a way out |
| Two crossing tags | The second shows on its letters outside the first (E6) | Part of the second tag looks absent |
| What counts as pending work for the notice | The person's own journal, cleared by acknowledgments (E12) | Fewer false cards for someone who was idle |
| Words already shown in the row above when a beat is put back | As built: both show (E12) | The words appear twice; the person deletes one |
| Two people putting the same beat back | Two rows (E12) | Both rows show; someone deletes one |
| "Undo merge" | Hidden; ordinary undo takes back a put-back (E12) | No "Undo merge" button in shared mode |
| The first upload of a large script | Accept the built-in server's ceiling: about 7 MB at 1 Mbit/s, 14 MB at 2 Mbit/s, 15 MB passed at 4 Mbit/s (E13). The documented `handleConnection` route on a host-owned listener has no such sweep, but the host then owns connection lifetime and heartbeat | Sharing a large script over a slow upload fails, and the host retries on a faster link |
| Undo passing over spent steps | Library behaviour (16 in 600, E11) | A press occasionally undoes something older |
| A person who stayed online while their beat was removed | Not told (E11); E12's online signal is not used | Visual text or fields can vanish with no message for them |

### J. Relay signals and the reconnect wrapper

What the stock provider's signals promise (E13):

| Signal | Promises | Does not promise |
| --- | --- | --- |
| `status` connected, `connect` | The socket is open | That the document has arrived; a silently dead link stays "connected" 36 to 39 s, or 216 to 234 s with a 180 s timeout |
| `synced` | After the server's state reply is applied, the copy has what the server had when it answered | Caught up both ways: it fired once before the reply on a reconnect, and stayed true through a forced disconnect |
| Pending count at zero | On an unbroken connection, every update this copy sent was applied by the relay | Saved to storage; after a reconnect an offline queue reset to 1 and reached zero early |

The wrapper (question 1) is a 38-line subclass of the stock provider. It holds document sends while disconnected and
from open until its own state reply is sent; authentication, awareness and the handshake stay stock. Measured: the
tag kept in 5 of 5 runs where stock lost it; the first edit after reconnect reached a peer about 29 ms later; a 1 MB
offline return sent 1,000,485 bytes against 2,001,048. A large combined reply is subject to the upload ceiling in
appendix I (E13).

### K. Round 4 changes

The removed mark on beats, the keep-always undo setting, the refusal of moves, the 2 MiB budget and the U14 row were
dropped; plain keys replaced per-action keys except for production tags; the join target is stored again for rule
(d).
