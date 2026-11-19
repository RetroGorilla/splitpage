# Design: the shared-document layer on standard Yjs

Round 4, 2026-11-18. Nothing is built.

When several people open one script together, each copy holds a shared document that the library Yjs keeps in
step. This note designs that layer: storage, commands, reading, undo, the relay and the offline notice. It
replaces `src/adapters/collab/` under rule 12 of `AGENTS.md`: a library's standard behaviour is the default, and
anything on top needs a reproduced defect, its measured cost and the owner's decision. Every figure names its result file ([appendix A](#a-sources)). Accounts,
invitations, disk storage, pictures and screen design are out of scope.

## Decisions made

All decided by the owner on 2026-11-18.

| # | Decision | What a person will notice | Source |
| --- | --- | --- | --- |
| 1 | Standard Yjs. Several beats share one segment's text, separated by boundary markers; a record per beat; a visual cell per beat; headings in their own map | Nothing directly | Spike, E2, E5 |
| 2 | Formatting: a plain key per kind (bold, italic, highlight and the like); a key per application for production tags only. No clean-up rule. Standard writes only; every insert names its formatting | Now and then, when two people format touching or overlapping words at once, some letters lose bold, or bold stays after an undo. Tags kept every letter in the two-copy trials | E4, E6 |
| 3 | Removing a beat is a real deletion of its text and boundary, record and visual cell; the segment stays | The row is gone for everyone, with any change others made to it without seeing the removal | E9, E10 |
| 4 | Four reading rules (section 3) show stray narration, writing nothing | Letters typed into a beat as it was removed appear in a neighbouring row, editable | E9; E11 pending |
| 5 | Undo is the library's own `Y.UndoManager` everywhere, default delete behaviour; no keep-always setting | Undo takes back only your own changes. Undoing a new beat removes it with what others typed in it. Snapshots and autosave give earlier states | E3, E9 |
| 6 | Headings keep their small `removed` mark | A removed heading can be restored with its name | E5 |
| 7 | Moves are in the first version, with flat ranks: one sortable position per block | Rows and scenes can be moved. A beat split while you move it leaves its second half behind | E10 |
| 8 | A comment or reply body is a whole value only its author edits; anyone may resolve or remove. Resolve, reopen and the "last edited" stamp are plain values | Two different choices at once: one wins, the same on every copy | Appendix B |
| 9 | The size limit is 15 MB | Years of editing fit; a full-size script opened in about 1.6 s | E8 |
| 10 | Offline merges get a notice listing clashed beats, each with "put it back", reusing the file-merge banner and review list | One banner after reconnecting | E9; E12 pending |
| 11 | Presence (seeing where others edit) is late and optional | Not in the first version | — |

**The guide for same-spot, same-moment conflicts** (owner): it is enough if they merge without losing data about
nine times in ten. It is a guide, not a hard rule, and stricter where a defect must never happen (section 6). The
experiments built their histories to hit bad cases, so their counts are rates within a race, not in real use (E9,
E10).

## Open for the owner

| # | Question | Options and what a person would notice |
| --- | --- | --- |
| Q1 | Does a shared room outlive the live session? | **(a)** No (the earlier proposal): the host converts the file once; at the end the result is saved as the ordinary JSON file and the room discarded. Each session starts a fresh history, so 15 MB bounds one session; offline work that misses it would return through the existing file merge. **(b)** Yes: the room stays on the relay, offline copies merge whenever they return, and the history grows toward 15 MB over years |
| Q2 | Who hosts the relay? | **(a)** The owner's own server: no running cost, reachable only while it is up. **(b)** A rented server: a monthly cost, always on |
| Q3 | What happens at 15 MB? | **(a)** Edits that would pass it are refused with a message and an export button; the host starts a fresh shared copy. **(b)** The same, with a warning from 12 MB |
| Q4 | How are two production tags shown when they cross after a merge? Both are stored; today's reader hides the second (E6) | **(a)** The second shows only on its letters outside the first. **(b)** The first shows; the second is flagged in the tag panel as overlapping |
| Q5 | E3b lost a requested production tag in 4 of 600 generated histories, where another copy deleted and restored those letters at that moment or undid typing next to the tag. Its writer re-keyed tag tails, which the decided design does not | **(a)** Accept under the guide. **(b)** Treat a lost tag as never acceptable: an experiment, then a departure under rule 12 if needed |

## 1. Stored shape

One `Y.Doc` per script. Records are `Y.Map`s with a key per field; text is `Y.Text`; a boundary or other atom is a
one-unit embed no edit can split. A segment's text holds several beats and headings, each running from its
boundary to the next; a segment's first block is named by its `head` key instead. Each beat and heading record holds
its `rank`; a joined beat holds `joined = {into, glue}`; a removed heading holds `removed`. Everything that is not
text is a plain value: of two writes at once Yjs keeps one, the same everywhere. Rows, scenes, durations, tag extents
and comment anchors are worked out when reading. The roots are in [appendix G](#g-roots).

**Formatting.** Attributes take `true`. Plain keys: `b`, `i`, `u`, `s`, `hl`, `dir`, `cue`, `c:<commentId>`,
`l:<url>`. A production tag is `t:<tagId>`, U+001F, then the writer's client id and clock, stripped on reading; each
application gets a fresh key (E3b). Keys build up where a tag is reapplied: 301 on one letter after 300 rounds of
clearing one letter and re-tagging (E6). That growth is accepted.

## 2. What each command writes

Each command is one transaction.

| Command | Writes |
| --- | --- |
| Type, paste | `insert` with an explicit attributes object, before any delete; never splitting a surrogate pair |
| Bold and other plain kinds | `format` with the plain key, `true` or `null` |
| Tag, untag | A fresh application key; untag sets `null` on the keys seen in the range. No re-keying of a tail |
| Split | Boundary embed, beat record copying the parent's rank, visual cell |
| Join, unjoin | Set or delete `joined` on the lower beat; a split at the seam deletes it |
| Remove beats | The observed text with its boundary (or `head` key), the records, the visual cells; the segment stays (E9) |
| Remove, restore heading | Set or delete `removed` |
| Create heading | Embed or new segment, record, own rank |
| Move | A new rank per moved block; a tie at the drop re-ranks the right side (E10) |
| Fields, status, resolve, stamp, body | `Y.Map.set`, only if the value differs: a same-value write still sends an update (appendix B) |

Rules for every writer:

- **Targets by id.** A write looks up its target when it runs. Yjs drops writes into a deleted container, and a held
  reference to a replaced cell writes where nobody sees it (E1; appendix B). A missing target refuses the command and
  never throws; E10's controls caught a writer that threw.
- **Compounds** check every part first: a throw after the first write still commits it (appendix B).
- **Composition** (input methods): the commit folds in remote changes made meanwhile (E1: 40,000 histories, nothing
  lost or doubled). If the cell was replaced the text goes at its end; if deleted, to local recovery.
- **One birth.** Two conversions of one file merge badly (appendix B), so one create-or-load, keyed by a creation id,
  stores the first and every copy adopts it before editing.
- **Incoming updates** are applied by the stock provider; the reader writes nothing back.

## 3. Reading rules

Blocks show in rank order; ties follow stored order (E10). A joined beat shares the row above (E2). Four rules make
every surviving letter reachable without writing anything:

| Rule | What a person sees |
| --- | --- |
| (a) Text before a segment's first boundary belongs to that segment's first beat, or to the row above if the segment has no beat | A letter typed into a beat heading its segment, as someone removed it, shows at the start of the next beat. Before, it was stored and shown nowhere (E9) |
| (b) An empty script holding stray letters shows them as a narration-only row | Removing every row while someone types leaves their letters on screen |
| (c) A boundary repeating a beat id is ignored | Two people remove one row and both undo: it returns once, its narration twice (`defdef`), nothing hidden (E9) |
| (d) A join counts only if its target is the beat directly above | A beat whose join target was removed or moved shows as its own row, not merged into a row nobody chose (E9) |

Rule (d) needs the target, so `joined` stores `into` again. Unseen typing in any other removed beat ends at the end
of the beat above, editable (E9). A removed heading waits in heading recovery (E5). E11 checks the rules.

## 4. Undo

One `Y.UndoManager` per session over every root a command writes, headings included, not `births` or `edited`. Only
the local command origin is tracked. Grouping follows the app's word rule with `stopCapturing()` (8.33 against
8.07 µs per key, overlapping; E3). The delete filter is the default; depth has no cap, as Yjs offers none (E3).

- Undo takes back only the presser's changes. A step whose effect is already gone is passed over and the press
  undoes the one before (appendix B).
- A field gets back the value its own write replaced. If two people set the same status and the presser's stood,
  undo leaves it absent, read as `todo` (appendix B).
- Undoing a creation deletes the record or cell with everything in it, including what others wrote (appendix B).
- One press can send two updates, the manager's and a formatting clean-up (E3b, seed 254). The editor shows one
  change per press; the transport sends both.
- `undo()` is called directly: inside an outer transaction it left no redo (appendix B).
- The caret is a relative position taken before each step (E3).

Going further back is the job of snapshots and autosave.

## 5. Accepted losses

| Loss (accepted by the owner) | How often, within the race | Source |
| --- | --- | --- |
| A change to a beat's visual cell, status, tags or fields the deleter had not seen goes with the beat. Unseen narration stays (section 3) | Every time. E10: 15 of 229 histories per design (8 a visual edit and field, 7 a field on a removed segment head) | E9, E10 |
| Typing or a field in a new beat or record goes when its creator undoes the creation | Undone split: 40 of 40 lost the visual letter and field; the narration letter joined the original beat. Undone inserted beat: 40 of 40 lost everything. E3: 38 in 600 histories under a filter that keeps a cell holding text; the default loses at least those, and seen writes too | E9, E3, appendix B |
| A split during a move leaves the second half behind as its own row | 8 of 8 histories, flat ranks | E10 |
| Two people dropping into each other's spot: neither request met | 8 of 8; nothing lost | E10 |
| Undoing a move after someone else moved that beat does nothing visible | 6 of 8 so; 2 in another editable order | E10 |
| A double delete and double undo doubles the narration | Every ordering tried, including fully offline | E9 |

Other outcomes under the guide, with no text lost and copies agreeing, are in [appendix H](#h-other-outcomes).

## 6. Never acceptable

| Defect | Evidence so far |
| --- | --- |
| Narration stored but in no row, or shown but not editable | Not yet zero: the old reader left 750 typed letters without an editing route in E9 and stranded narration in 7 of 229 E10 histories. Rules (a) to (c) target them. **E11 pending** |
| A beat shown twice, or its surviving narration nowhere | E7: 0. E9: no duplicate blocks in 2,220 histories per variant; its double undo hid `defdef`, which rule (c) shows. **E11 pending** |
| Copies disagreeing after everything is delivered | 0 in E1 to E7, E9 and E10 |
| A thrown error in a reader or writer | 0 crashes in E5, E7, E9; none of E10's broken histories was a crash. E10's writer threw under controls when a muted write left a target missing; section 2 makes that a refusal |
| An existing beat changing scene with one person working | Flat ranks: 0 single-writer failures in E10's 229 histories (placement failed it). **E11 reruns it** |

## 7. Requirements on the product code

- **Relay order** (E3b): each writer's updates arrive in order, or merged. A redo applied before its undo on one
  copy and relayed on left a tag removed everywhere, under every key form. E13 checks the stock relay.
- **Explicit attributes** on every insert (E6): without them a letter inherits a neighbour's tag and keeps it after
  the tag's text is deleted. Tags use standard writes only.
- **Crossing tags** need a read-side fix (E6; Q4).
- **Incremental reading** (E8, E9, E10): rebuild only the rows a change touched and cache cell contents. The Yjs
  write took 0.02 to 0.07 ms for a move or removal at 900 beats and 0.25 ms (0.5 to 1.1 in review) for a split at
  15 MB; the prototype's full rebuild was 74 to 85% of a move and 47 of 49 ms for that split.
- **One walk per key** (E8): the prototype read a cell's whole history twice per key, slow in long-history cells.
- **Memory at the limit** (E8): 344 MiB retained after loading 15 MB in Node; browsers unmeasured.
- **Slow first sync** (E8): the provider's 30 s `messageReconnectTimeout`; 15 MB takes about 30 s at 4 Mbit/s and
  can loop. The relay must accept the whole state as one message (14,990,327 bytes). E13 checks both.
- **The offline notice's gaps** (section 9, E9).

## 8. Relay and size

The relay is the stock Hocuspocus 4.8.0 server as shipped (plan of record). It passes updates and holds the state
for late joiners. Who runs it is Q2; whether it keeps rooms is Q1.

| At 15 MB (E8, 15,036,020 bytes) | Result |
| --- | --- |
| Load through first full read | 1.59 s |
| Heap after loading | 344 MiB |
| Keystroke median (first key) | 0.201 ms (0.734 ms) |
| Split, with full rebuild | 49.10 ms |
| Catch-up after 1 day / 30 days / whole history | 20 KB in 30 ms / 74 KB in 166 ms / 15.0 MB in 1.81 s |
| Years that fill it, one writer (six writers) | About 37 realistic or 6.8 heavy (6 or 1.1) |

The weak spot is one cell with a long history: keys stayed under 1 ms to about 4,000 old entries and under 8 ms to
about 96,000; at 140,001 the median was 22.06 ms, 3.23 ms in a replay (E8). Tag keys add about 9 to 10% (E6). A
command that would pass the limit, counted in encoded bytes (appendix B), is refused before writing (Q3).

## 9. Offline notice

On reconnecting, a copy that worked offline compares three readings per beat: the shared state when it went
offline, its own state, and the merged result. Beats it changed that someone else changed or removed are listed in
the banner (`src/features/merge/banner.ts`) and the review list (`src/core/merge/review.ts`, which already compares
base, mine and theirs). "Put it back" writes the offline text again as an ordinary edit. Version one is only that.

Known gaps (E9): a deleter offline while the typist stayed online sees no clash; after a double delete and double
undo nothing is flagged, and offering `def` would store a third copy; plain text misses mark-only and field-only
changes; after a redone removal, a letter in the beat above cannot be traced to the removed beat.

## 10. Experiments still running

### E11: the whole combination in the real reader and writers

Will settle whether the reading rules leave every surviving narration character shown exactly once in an editable
row, with all decisions together, and reruns the 22 E10 histories per design that broke through deletion. Result
pending.

### E12: the offline notice

Will settle what the three-reading comparison detects, whether "put it back" restores the text, and how much of the
review list carries over. Result pending.

### E13: the stock Hocuspocus 4.8.0 relay

Will settle whether it keeps each writer's updates in order, how a 15 MB first sync behaves on a slow link, and
which signal marks a copy as in sync. Result pending.

## 11. Build order

Each slice is one pull request in `src/adapters/collab/native/`, the only place the dependency gate admits Yjs.

| # | Slice | Gate |
| --- | --- | --- |
| 1 | Shape, birth, typing, deleting text, incremental reader | Fixture round-trip; birth retries and racing loads; the spike's tape on three copies and a late joiner in every order; a 900-beat structural change within 8 ms |
| 2 | Formatting and tags | E4 and E6 rows on the adapter; crossing display (Q4) |
| 3 | Split, join, removal, headings, new beats, reading rules | E2, E5, E9 and E11 histories; section 6 at zero |
| 4 | Moves | E10's collision table, flat column or better |
| 5 | Records, status, comments | Exact row changes; author-only bodies |
| 6 | Undo | E3's tests with the chosen keys; one change per press |
| 7 | Session, editor, relay, offline notice | E1 on the Writer; E12 and E13 cases; a 15 MB first sync on a slow link |
| 8 | Delete the old adapter | Every deleted test mapped; `npm run verify` |

## 12. What changed since round 3

- **Removed mark on beats:** gone; removal is a real deletion and the reading rules show stray narration (E9).
- **Keep-always undo setting:** gone; snapshots and autosave cover going back (decision 5).
- **Refusal of moves:** gone; flat ranks held with standard undo (E10).
- **2 MiB budget:** gone; E8 ran every operation at 15 MB and the owner set that limit.
- **U14 row:** gone; there are no removed beats to type into.
- Also: plain keys except for tags (E4, E6); the join target stored again for rule (d).

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

Library sources read: Yjs 13.6.33 `src/utils/UndoManager.js`, `src/types/YText.js`; y-prosemirror 1.3.7
`sync-plugin.js`, `undo-plugin.js`; y-codemirror.next 0.3.5 `y-sync.js`, `y-undomanager.js`; y-protocols 1.0.6
`sync.js`; the Hocuspocus 4.8.0 provider; the Yjs documentation on `Y.UndoManager`, `Y.Text`, `Y.Doc`, document
updates and relative positions. Rule ids such as U14 are from [`native-rule-inventory.md`](native-rule-inventory.md).

### B. Checks

`prototypes/collab/test/native-design/native-design.test.mjs`, Yjs 13.6.33, Node 24.22.1; all 19 pass. Run
`npm ci --prefix prototypes/collab`, then `node --test test/native-design/native-design.test.mjs` in
`prototypes/collab`.

| Check | Result |
| --- | --- |
| Two independent conversions of one file, merged | The beat listed twice; one copy's typing gone |
| Two conversions under one fixed client id, different text | The copies disagree |
| A retried birth under one creation id, both copies typing | One `births` entry, the segment listed twice, one copy's typing gone |
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

The cleared-undo check backs the rebuild in appendix C. The rebuilt-history check is why a room is never rebuilt
from its visible text (Q1).

### C. Costs and rebuild

| Cost kept for the document's life | Bytes | Source |
| --- | --- | --- |
| Split | 54.51 | E2 |
| Live join | about 40 | E2 |
| Heading create-and-remove cycle, embed / segment head | 66 / 123 | E5 |
| Flat-rank row move, kept / sent | 9.19 / about 38 | E10 |
| Production tag history per application, plain key / per-application key | 50.2 / 70.9 to 72.2 | E6 |
| One embedded beat removed, against the old mark, at 300 beats | 247 saved | E9 |

An editing copy keeps every letter its own undo history deleted, and `clear()` frees none (appendix B): pasting and
deleting a 10,000-letter block 100 times gave 1,003,678 encoded bytes against 3,678 in a fresh copy (E3). A copy
therefore loads fresh on entry and rebuilds from its stored state at an idle moment once its own deleted letters
pass a threshold (E3 proposes 1,000,000), telling the person undo history was cleared.

Flat ranks are base-62 strings with a writer suffix; after 1,000 insertions into one ever-narrower gap the longest
was 222 characters (E10).

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
| Adapter: projection, indexes, hydration, text import | Rewritten: the incremental reader and one birth |
| Adapter: buffer, painted base, recorded selection | Replaced by the composition fold |
| Adapter: move refusal | Goes: moves are in (decision 7) |
| Core: `operations.ts`, `read-operation.ts`, `base-reference.ts` | Change: text by cell, offset and base; operations for dropped rules go |
| Core: `undo-record.ts` | Goes; a description keeps label, selection, typing key |
| Core: `recovery.ts`, `removal-state.ts` | Change: removed beats go; removed headings and local refused text stay |
| Core: `merge/review.ts`; feature: `merge/banner.ts` | Reused by the offline notice |
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
| `segments` | Per segment: `head` (`{b: beatId}` or `{h: headingId}`) and `text` (narration, heading names, boundary embeds, atoms) |
| `beats` | Per beat: `rank`, `status`, `lengthSeconds`, `paragraphStart`, `extra`; `joined = {into, glue}` when set |
| `visuals` | One visual cell (`Y.Text`) per beat |
| `headings` | Per heading: `rank`, other fields; `removed` when set |
| `comments`, `replies`, `people`, `tags`, `shots` | The file's fields; bodies are whole strings |
| `edited` | Per beat, `{by, at}` of the last typing |

### H. Other outcomes

Under the guide, with no text lost and copies agreeing:

- **Plain formatting** (E4, 60 two-copy trials with unseen same-kind changes): 72 letters missing bold at merge, 48
  without the trials that re-bolded bold text; 34 letters left bold after an undo.
- **Tags:** E6 found 0 letters missing over 42 trials and 24 extra after undo with standard writes. E3b: Q5.
- **Rule (d):** a join stops counting when its target is removed, moved or split from it. E11 counts how often.
- **Composition:** text composed beside a deleted letter can land on the far side of an insertion made there at the
  same moment: 25 of 20,000 histories with undo (E1).
- **Double restore:** both delete the `b` of `abc` and both undo: `abbc` (appendix B).
- **Edges:** a letter typed at a heading's end can land in a heading created there at that moment (E5); an unseen
  letter typed at a tag's edge takes the tag or not by client order (E6).
