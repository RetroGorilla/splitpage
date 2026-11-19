# Design: the shared-document layer on standard Yjs

Round 8, 2026-11-19. Nothing is built.

When several people open one script together, each copy holds a shared document that the library Yjs keeps in
step. This note designs that layer. It replaces `src/adapters/collab/` under rule 12 of `AGENTS.md`: a library's
standard behaviour is the default. Every figure names its result file ([appendix A](#a-sources)). "Generated" marks
counts from generated test histories, built to hit bad cases, so not rates in real use. Accounts, invitations,
pictures and screen design are out of scope.

## Decisions made

Decided by the owner: rows 1 to 13 on 2026-11-18; row 4's new form and rows 14 to 19 on 2026-11-19.

| # | Decision | What a person will notice | Source |
| --- | --- | --- | --- |
| 1 | Standard Yjs. Beats share a segment's text, cut by boundary markers; each beat has a record and a visual cell | Nothing directly | Spike, E2 |
| 2 | A shared script stays on the server between sessions. The design's reading: 15 MB bounds its whole shared life and server storage is in the first version; backups are not designed (appendix I) | Reopen any time; an offline copy can return days later | Owner |
| 3 | A plain formatting key per kind; a key per application for production tags only; standard writes; explicit attributes on every insert | Two people formatting touching words at once can lose some bold. Tags: section 5 | E4, E6, E11 |
| 4 | Removing a row deletes its narration and boundary; its record and visual cell stay, hidden (replacing deletion of them) | If the remover undoes, others' unseen changes come back with the row, except a narration tag (section 4) | Owner, E14 |
| 5 | A heading's name has its own text cell; the heading keeps its boundary, record, rank and `removed` mark | A removed heading restores with its name; narration never ends up in a title | E5, E11 |
| 6 | Reading rules (a) to (g) show stray narration, writing nothing | Letters typed into a removed beat appear in a nearby row, editable | E9, E11, E17 |
| 7 | No command copies narration | A split inside recovered text breaks at the nearest point needing no copy | E11 |
| 8 | Undo is `Y.UndoManager` with core Yjs's default delete filter | Undo takes back only your own changes; snapshots and autosave go further back | E3, E11, E15 |
| 9 | Moves with flat ranks: one sortable position per block | A beat split while you move it leaves its second half behind | E10, E11 |
| 10 | Comment and reply bodies are whole values only their author edits; anyone may resolve or remove | Two choices at once: one wins everywhere | Appendix B |
| 11 | The size limit is 15 MB | A full-size script opened in about 1.6 s | E8 |
| 12 | Offline merges get a notice listing clashed beats with "put it back", reusing the file-merge banner and review list. When unsure whether the remover had seen your edit, it shows the possible clash: "a beat you changed was removed", with what you had | One banner after reconnecting; sometimes a card the remover had seen | Owner, E12 |
| 13 | The relay runs on the owner's own server (plan of record); presence is late and optional | — | Plan |
| 14 | Reconnect goes through a 38-line wrapper around the stock provider that holds document sends until the client's own state reply has gone out | Formatting changed across a dropped connection is kept in the measured pairs; first edits after a reconnect arrive about 29 ms later | Owner, E13 |
| 15 | Two same-moment moves of one row, then the winner's undo: placed as built, with plain undo (E15's option A). Every command checks each part it will touch before writing, or refuses | The row follows its narration neighbour, later perhaps into another scene (section 10) | Owner, E15 |
| 16 | A first load keeps the stock 30 s wait, with the script sizes that fit at each speed, a limit on restarts, and a clear message when a script is too large for the line | Worked out from E13: about 3.5 MB loads at 1 Mbit/s, 7 MB at 2, 14 MB at 4. A larger script gets the message instead of restarting forever | Owner, E13 |
| 17 | The offline notice flags a production tag lost through someone's unseen delete and undo | The person returning is told; one who stayed online is not | Owner, E12, E16 |
| 18 | A marker whose record or visual cell is missing is not a row: its narration reads into the row above, and nothing is written (rule (g), E17's option R) | Section 10 | Owner, E17 |
| 19 | The first version uses stock snapshot storage, the whole state rewritten 2 to 10 s after an edit: a departure from `docs/COLLABORATION-PLAN.md`. Tests stop the server inside that window, show what is lost and whether reconnecting copies restore it, and decide whether the plan's update journal and durable receipts come before others use it | A server stop can lose the last seconds of edits on the server; that reconnecting copies re-send them is an untested assumption | Owner, E13 |

**The guide for same-spot, same-moment conflicts** (owner): it is enough if they merge without losing data about
nine times in ten; a guide, not a hard rule, and stricter where a defect must never happen (section 6).

**E11's verdict:** with the reader and writer corrections and name cells the combination holds, except a beat with
no rank (rule (e)). Kept records close one route to it (E14); decision 15 accepts the other, a move race.

## Open for the owner

Nothing. Every question put to the owner is answered above. The smaller points in
[appendix I](#i-smaller-open-points) proceed on their defaults unless the owner objects. Building starts on the
owner's go.

## 1. Stored shape

One `Y.Doc` per script. Segment text (`Y.Text`) holds narration and one-unit boundary embeds, `{b}` for beats and
`{h}` for headings; a segment's first block is named by its `head` key. Visual cells and heading names are separate
`Y.Text`s. Records are `Y.Map`s: each beat and heading has a `rank`, a joined beat `joined = {into, glue}`. Every
other field is a plain value; of two writes at once Yjs keeps one. A removed beat's record and visual cell stay
with no boundary; the outline ignores them. Roots: [appendix G](#g-roots).

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
| Remove beats | The observed text with its boundary (or `head`); the records, visual cells and segment stay |
| Create, rename, remove heading | Boundary or segment, record, rank, name cell; rename edits the name cell; remove sets `removed` |
| Move | A new rank per moved block, and the shown rank of a rankless neighbour (rule (e)); a tie at the drop re-ranks the right side |
| Fields, status, resolve, body | `Y.Map.set`, only if the value differs (appendix B) |

**Check before writing** (decision 15). Every command finds each part it will touch by id: its rows' records,
cells and boundaries, and the ranks of neighbours a move will write. If one is missing, it refuses without writing.
A command aimed at a removed or hidden row returns that refusal; it never reports success, or nothing, through a
stale target (E1). On section 10's four-step row 5 of 16 commands wrote and then threw as built, none under rule
(g); the prototype skips some silently and its join throws (E16, E17). Commands on the row above work on the
narration it shows.

Composition folds in remote changes made meanwhile (E1). The reader writes nothing back. The file is converted
once, and every copy adopts that conversion (appendix B). Conversion writes each heading's name into its name cell,
not the segment text: the prototype import does the latter, so its headings read blank (E15).

## 3. Reading rules

Blocks show in rank order; ties follow stored order (E10). A joined beat shares the row above (E2). Seven rules make
every surviving letter reachable without writing anything.

| Rule | What a person sees | Known limit |
| --- | --- | --- |
| (a) Text before a segment's first boundary belongs to that segment's first beat, or to the row above if the segment has no beat | Letters typed in a removed beat that headed its segment show at the start of the next beat | — |
| (b) An empty script holding stray letters shows them as a narration-only row | Stray letters stay on screen | — |
| (c) A boundary repeating a beat id is ignored | Two people remove a row and both undo: it returns once, narration twice (`xx`) | — |
| (d) A join counts only if its target is the beat directly above | A beat whose target was removed or moved shows as its own row | A later move can make an old join count again (11 in 600 generated histories, E11) |
| (e) A beat whose record has no rank is read after the block before it in the narration | After two people move the same row at once and the winner undoes, the row shows after its narration neighbour | No fixed place: when that neighbour moves or goes, the row follows the next one, possibly into another scene (E14, E15) |
| (f) Text between a heading's boundary and the next boundary is narration without a beat, shown in the first of: the beat directly after the heading, the nearest beat above, the next beat further down, the narration-only row | Letters typed in a deleted scene's beat show in a neighbouring beat, editable | The third step can show it under a different scene, and it moves with that beat (E11) |
| (g) A beat marker whose record or visual cell is missing is not a row; its narration reads as if the marker were absent, in a neighbouring row ([appendix N](#n-a-row-without-its-record)) | After section 10's four steps, N's narration shows in B, editable, as before the split | The restoring undo brings back the narration, not the row. Text typed inside or after the hidden text moves into N on a redo; a split inside it lands right after the beat's own marker (E17) |

A beat loses its rank through a same-moment move race (section 10): 3 of 600 generated histories (E14).

## 4. Undo

One `Y.UndoManager` per person over every root a command writes, headings and names included, not `births` or
`edited`. Only the local command origin is tracked. Grouping follows the app's word rule with `stopCapturing()`
(E3). Default delete filter; no depth cap.

- Undo takes back only the presser's changes. A press can pass over spent steps (E11) or change only a removed
  row's hidden record (E14).
- An older redo that would replace someone else's later change returns false: the press is used up and nothing
  changes (E15 histories 9 and 10).
- Undoing a removal brings back others' unseen visual text, status, fields, visual tags (40 of 40 generated
  histories each) and a single unseen move (80 of 80), but not an unseen narration tag (0 of 80). An unseen join or
  unjoin takes effect (E14).
- After two writes at once to one field, the winner's undo leaves it empty: rank, status, join (E15).
- Undoing a creation removes everything written into it, seen or unseen (E11, E14); see section 10 for a row cut
  and restored meanwhile.

## 5. Accepted losses

E16 recounted E11's 600 generated histories with kept records ([appendix M](#m-accepted-losses-counted)). Unseen
record changes lost with a removed beat fall from 131 (in 110 of 600 histories) to 1 (1 of 600); unseen visual
changes from 106 (94 of 600) to 0, stored with the hidden row and shown if the removal is undone. The rest are
unchanged and small: typing in a creation its creator undoes unseen (4 of 600), a split beside a move, a deletion
missing a restored row, doubled narration (also after E17's histories), tags, and decision 15's rankless row.

**5a. Tags.** Of 845 requested tags, 800 were kept, 40 undone by their author and 5 lost (E11); the same 5 with
kept records (E16). Plain Yjs causes both: an undo the tagger had not seen restored deleted letters as new ones
(4), and a doubled letter kept the tag on one copy (1). Decision 17 flags such a loss. Outcomes that lose nothing:
[appendix H](#h-outcomes-that-lose-nothing).

## 6. Never acceptable

Evidence: E11, and E14 and E16 with kept records, names in cells, five deliveries each: E9's 2,257 runs, E10's
histories, 600 mixed and 200 double-split generated histories.

| Defect | Evidence |
| --- | --- |
| Narration stored but in no row, or shown but not editable | 0 in every set. With names inline it was 27 letters in 19 of 600 |
| A beat shown twice, or its surviving narration nowhere | 0 in every set. Narration shown twice by a command of ours: 0 |
| Copies disagreeing after everything is delivered | 0 in every set, and in E1 to E11, E14 and E15 |
| A thrown error in a reader or writer | 0 in every set. Writers threw under controls (39) and on section 10's four-step row; section 2 makes these refusals |
| A shown row without its record or visual cell | 0 of 4,000 generated runs, which seldom make the sequence (E16). Section 10's four steps do it as built in 5 of 5 deliveries; across E17's named histories, 30 of 90 runs as built and 0 of 90 under rule (g) |
| An existing beat changing scene with one person working | 0 in every set, **except rule (e)'s case**: after two same-moment moves and the winner's undo, deleting the neighbour moves the rankless row out of its scene in every delivery (E14, E15). Decision 15 accepts it |

## 7. Requirements on the product code

- **No copying** (E11): a split that copied text doubled it when two people split at once.
- **Explicit attributes** on every insert, standard tag writes (E6); crossing tags need a read-side fix (appendix I).
- **Check before writing** and **name cells on conversion** (E15): section 2.
- **Recovery skips removed rows** (E14): the inherited recovery list shows removed beats with visual text as
  unplaced.
- **One reading everywhere** (E16, E17): rules (a) to (g) apply the same way in the outline, command lookup, the
  offline notice and its put-back, the recovery list, and export, autosave and snapshots. As built, the outline
  showed E16's row and the notice did not.
- **Incremental reading** (E8, E11): a full rebuild is 84 to 99% of a 900-beat command. Keep the parsed narration
  of unchanged segments and recompute which rows own the affected text (rule (g); appendix N). Relay order, memory,
  storage and signals: appendix J.

## 8. Relay and size

The relay is stock Hocuspocus 4.8.0. It kept order in every condition E13 tried, a restart included. Its one
break, an undo sent into a dead socket overtaken by a redo queued for the reconnect, lost formatting only; decision
14's wrapper prevented it in every measured pair.

At 15 MB a keystroke took 0.201 ms (E8); a first download at 1 to 4 Mbit/s never finished in 30 s (decision 16).
Kept records add about 100 bytes per removed row, 160 to 174 for edited ones (E14). Detail:
[appendix J](#j-relay-size-and-the-reconnect-wrapper).

## 9. Offline notice

On reconnecting, a copy compares its own state with the merged result, per beat, and lists beats it changed that
someone else changed or removed. "Put it back" makes a fresh beat from what the person had, as one undo step (E12).

- **Counts** (E16, kept records, 85 named and 240 generated histories), with the person's own journal of pending
  edits: 46 false banners of 325, 26 misses of 238 losses (appendix I).
- **Seen and unseen** edits to visual text, visual tags, status and fields still leave identical evidence (4 of 4
  pairs, E16), hence decision 12's possible clash.
- **Tags** (decision 17): E16's sweep lost 6 of 28 unseen tags and flagged all 6.
- **Journal clearing:** an entry clears on the server's "applied" status, which under decision 19's storage means
  applied in memory, not stored. An edit a server stop then loses is not listed (appendix I).
- **Who is told:** only the returning person. Someone online sees a removed row they edited go with no message;
  their edits return if the remover undoes, and a tag lost that way goes untold (E16; appendix I).

## 10. Races on one row under undo

The experiments, all merged, found four histories where an undo meets someone else's change to one row.

- **An undone creation after a cut and its undo** (E16). Alice splits B, making N; Bob cuts N; Alice undoes; Bob
  undoes. No race is needed: Alice's undo deletes N's record and visual cell, which the cut had kept, and Bob's
  brings back only N's marker and narration. As built every copy shows N with neither (5 of 5 deliveries). Under
  rule (g) (decision 18), after Alice's undo B is empty; Bob's undo brings the narration back, shown in B, but not
  N as a row. Bob's status and visual text on N return only if Alice redoes her split
  ([appendix N](#n-a-row-without-its-record)).
- **Rank** (E15). Two same-moment moves and the winner's undo leave a row without a rank; rule (e) places it
  (decision 15; [appendix L](#l-a-rows-place-after-competing-moves-and-undo)).
- **Record** (E15). Two people remove a row offline, both undo, one redoes: kept records keep its record and cell.
- **A segment's first row** (E15, E16). The same race loses the `head` key: the row's narration shows, editable, at
  the start of the next beat (appendix I).

The last three follow from one Yjs rule: of two writes to one key the higher client's stays, and plain undo never
overwrites another person's write.

## 11. Build order

Each slice is one pull request in `src/adapters/collab/native/`, the only place the dependency gate admits Yjs.
Where each experiment's histories enter as tests is this note's reading of the slices; the cases in appendix O are
requirements from the outside review.

| # | Slice | Gate |
| --- | --- | --- |
| 1 | Shape, conversion with name cells, typing, deleting text, incremental reader | The spike's tape on three copies and a late joiner; headings named in cells; a 900-beat structural change within 8 ms |
| 2 | Formatting and tags | E4, E6 and E11's tag counts on the adapter; crossing display |
| 3 | Split, join, removal with kept records, headings, reading rules (a) to (g) | E9, E10, E11 and E14 sets; rule (g) on a marker without its record; E17's command table and the split timing with a parse counter (appendix O); section 6 at zero but decision 15's case; recovery lists no removed row |
| 4 | Moves | E10's collision table; a move including a row without its record refused unwritten |
| 5 | Records, status, comments | Exact row changes; author-only bodies |
| 6 | Undo | E3, E11, E14 and E16 tests; E15's histories under option A; E17's histories under rule (g); creation undo and redo timing (appendix O); one change per press |
| 7 | Session, editor, relay with the wrapper, server storage, offline notice | E13's pair table; E16's notice counts; every reader agrees on E17's histories; first loads per decision 16; a large offline return under stock timers; two writers past the size limit; server stops per decision 19; stale-target editor cases (appendix O); store and reload |
| 8 | Delete the old adapter | Every deleted test mapped; `npm run verify` |

## 12. What changed in round 8

An outside review found the design sound to build. Its corrections are in sections 2, 3, 7, 9 and 10 and
appendices I and N; its acceptance cases are appendix O. Decisions 16 and 19 are the owner's answers to its two
questions. Earlier rounds: [appendix K](#k-earlier-rounds).

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
| E11, the chosen combination, with its 2026-11-19 correction | [`native-chosen/RESULT.md`](../../prototypes/collab/src/native-chosen/RESULT.md) |
| E12, the offline notice | [`native-notice/RESULT.md`](../../prototypes/collab/src/native-notice/RESULT.md) |
| E13, the stock relay | [`native-relay/RESULT.md`](../../prototypes/collab/src/native-relay/RESULT.md) |
| E14, kept record and visual cell | [`native-kept/RESULT.md`](../../prototypes/collab/src/native-kept/RESULT.md) |
| E15, a row's place after competing moves and undo | [`native-rank-undo/RESULT.md`](../../prototypes/collab/src/native-rank-undo/RESULT.md) |
| E16, the recount with kept records | [`native-kept-recount/RESULT.md`](../../prototypes/collab/src/native-kept-recount/RESULT.md) |
| E17, a shown row always has its record | [`native-row-record/RESULT.md`](../../prototypes/collab/src/native-row-record/RESULT.md) |

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

The throw-in-transaction check is why every command checks before its first write (section 2). The cleared-undo
check backs the rebuild in appendix C. The rebuilt-history check is why a stored room is never rebuilt from its
visible text. The paste check is why size is counted in encoded bytes: a command that would pass 15 MB is refused
before writing.

### C. Costs and rebuild

| Cost kept for the document's life | Bytes | Source |
| --- | --- | --- |
| Split | 54.51 | E2 |
| Live join | about 40 | E2 |
| Heading name in its own cell, per heading | 13 to 15 | E11 |
| Flat-rank row move, kept / sent | 9.19 / about 38 | E10 |
| Kept record and visual cell per removed row, plain / edited | 97.8 to 101.4 / 159.7 to 174.2 | E14 |
| Production tag history per application, plain key / per-application key | 50.2 / 70.9 to 72.2 | E6 |
| Tag keys over a script's life | about 9 to 10% more | E6 |

E14's kept-record bytes come from a fixture that cuts every beat in one transaction; they are a low estimate for
cells edited over many sessions. With 9,000 removed rows a full read took 13.23 to 14.15 ms against 12.26 to 12.73
with records deleted, and a keystroke 0.274 to 0.291 ms against 0.271 to 0.276; neither reads the record or visual
maps in full (E14).

Rule (g) stores nothing. Its read and keystroke times stayed within the spread between passes, and a split with
its undo took about 0.6 ms more than as built (E17). The prototype clears every cached segment view whenever a
record or visual cell is added or removed; that re-reading cost during editing, including when many records change
at once, was not measured.

An editing copy keeps every letter its own undo history deleted, and `clear()` frees none (appendix B): pasting and
deleting a 10,000-letter block 100 times gave 1,003,678 encoded bytes against 3,678 in a fresh copy (E3). A copy
loads fresh on entry and rebuilds from its stored state at an idle moment once its own deleted letters pass a
threshold (E3 proposes 1,000,000), telling the person undo history was cleared.

The notice's comparison took 1.65 to 1.68 ms median at 900 beats, and capturing a reading 10.2 to 11.6 ms (E12).

### D. Rules decided or dropped

Decided 2026-11-18: R01 (removal is a real deletion; unseen changes go with the beat), changed on 2026-11-19 to
deleting narration and boundary while keeping the record and visual cell (decision 4); F40 (whole bodies, author
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
| Core: `recovery.ts`, `removal-state.ts` | Change: removed beats, and their kept records, are not listed; removed headings and local refused text stay |
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
| `beats` | Per beat: `rank`, `status`, `lengthSeconds`, `paragraphStart`, `extra`; `joined = {into, glue}` when set. Kept after the beat is removed |
| `visuals` | One visual cell (`Y.Text`) per beat, kept after the beat is removed |
| `headings` | Per heading: `rank`, other fields; `removed` when set |
| `names` | One name cell (`Y.Text`) per heading, written at conversion |
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
| A restored row without a rank read at its stored place (rule (e)) | 5 histories; 3 with kept records (E14, E17) |

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
| Undoing a heading's creation after an unseen rename | Plain undo; the rename is lost (1 in 600, E11) | The heading and the rename disappear |
| An old join counting again after a move | As built (11 in 600, E11) | Rarely, a moved row merges with the row it was once joined to |
| An unseen join or unjoin on a removed row | As built: it takes effect when the row returns (E14) | An undone removal brings the row back joined to the row above, or separate |
| An undo press spent on a removed row's hidden record | Library behaviour (E14) | A press changes nothing visible |
| What a removed row leaves in the stored script | Kept for the script's life; no clean-up in the first version (E14 lists what one would need) | Its visual text, fields, rank and tags stay readable to anyone holding the script, in every later copy; its narration does not |
| A segment's first row lost in a remove, undo and redo race | As built (E15, E16); rule (g) does not change it, since the record is not what is missing (E17) | The row's narration joins the start of the next row (5 of 5 deliveries); its visual text and fields stay stored, not shown. The inherited recovery list showed a non-empty visual as unplaced (E16); the product reader leaves kept records out (section 7) |
| Formatting that differs by delivery order | Accept: library behaviour (E11) | A mark's exact edge can differ; copies agree once everything is delivered |
| What happens at 15 MB | Refuse the edit with a message and an export; warn from 12 MB | A warning, then a refusal with a way out |
| Two crossing tags | The second shows on its letters outside the first (E6) | Part of the second tag looks absent |
| What counts as pending work for the notice | The person's own journal (E12); no client can observe a "last state both had" moment (E13). Under decision 19 an entry is cleared by the server's built-in "applied" status, which means applied in memory only, and not reliably: it is also sent when applying threw or the update waits on missing dependencies (plan, "Durability receipts"). An edit lost by a server stop after that status leaves no entry, so the notice cannot list it. Only a journal commit in `beforeSync`, as the plan requires, would make the status mean stored | Fewer false cards for someone who was idle. With kept records: journal 46 false banners of 325 and 26 misses of 238; ideal base 64 and 25 of 238; both miss 16 of 30 generated split-and-move losses; counting an edit stored on a hidden row as kept, false banners rise to 87 and 103 (E16) |
| Words already shown in the row above when a beat is put back | As built: both show (E12) | The words appear twice; the person deletes one. After a double delete and double undo, a third copy |
| Two people putting the same beat back | Two rows (E12) | Both rows show; someone deletes one |
| "Undo merge" | Hidden; ordinary undo takes back a put-back (E12) | No "Undo merge" button in shared mode |
| The first upload of a large script | Accept the built-in server's ceiling. Measured with both Hocuspocus timers raised to 180 s, not decision 16's stock settings: largest single uploads about 7.15 MB at 1 Mbit/s and 14 MB at 2; the full 15 MB script passed at 4 (E13). Under stock timers, a 5 MB offline return at 1 Mbit/s reached the server at 41.8 s; the provider then forced a disconnect at 66.1 s, and on the next connection the pending count reached zero at 67.2 s, the re-sent reply being 2 bytes because the server already had the work (E13). The documented `handleConnection` route on a host-owned listener has no such sweep, but the host then owns connection lifetime and heartbeat | Sharing a large script over a slow upload fails, and the host retries on a faster link |
| Backups of scripts stored on the server | Not designed; proposed with slice 7 | Nothing, unless the server's store is lost |
| Undo passing over spent steps | Library behaviour (16 in 600, E11) | A press occasionally undoes something older |
| A person who stays online while a beat they edited is removed | Not told; no online signal is used. With kept records the beat-map signal fell from 131 to 12 banners of 325, all from undone creations, and the row-reading observer misses 92 of 192 losses (E16) | The row disappears with no message; their edits return only if the remover undoes. A tag lost that way is not flagged for them (decision 17) |
| Hidden edits on a removed row | No route to them other than the remover's undo (E16 did not measure one) | Status, fields and visual text on a row that stays removed are stored but not reachable |

### J. Relay, size and the reconnect wrapper

| At 15 MB | Result |
| --- | --- |
| Keystroke median (E8) | 0.201 ms |
| First join, cold server / late join, warm (E13) | 4.99 s / 1.98 s |
| First download at 1, 2, 4 Mbit/s: stock / 180 s timeout (E13) | Restarted at 35 to 39 s, never finished / 129.3, 80.0, 35.9 s |
| Years that fill it, one writer (E8) | About 37 realistic or 6.8 heavy |
| Memory per open script (E8, E13) | 344 MiB in a Node copy; 306.9 MiB on the server |

**First upload.** The built-in server's 30 s heartbeat sweep ends a connection still receiving one large message,
with no setting for it; 15 MB passed at 4 Mbit/s (E13). **Storage** (E13): each store rewrites the whole snapshot
(438 ms encode at 15 MB), 2 to 10 s after an edit; a positive status does not mean saved. **Reading** (E8, E11):
the Yjs write is 0.02 to 0.07 ms; walk a cell once per key.

What the stock provider's signals promise (E13). No stock event means "caught up both ways": `synced` and a zero
pending count both held while a download was still held back.

| Signal | Promises | Does not promise |
| --- | --- | --- |
| `status` connected, `connect` | The socket is open | That the document has arrived; a silently dead link stays "connected" 36 to 39 s, or 216 to 234 s with a 180 s timeout |
| `synced` | After the server's state reply is applied, the copy has what the server had when it answered | Caught up both ways: it fired once before the reply on a reconnect, and stayed true through a forced disconnect |
| Pending count at zero | On an unbroken connection, every update this copy sent was applied by the relay | Saved to storage; after a reconnect an offline queue reset to 1 and reached zero early |

The wrapper (decision 14) is a 38-line subclass of the stock provider. It holds document sends while disconnected
and from open until its own state reply is sent; authentication, awareness and the handshake stay stock. Measured:
the tag kept in 5 of 5 runs where stock lost it; the first edit after reconnect reached a peer about 29 ms later; a
1 MB offline return sent 1,000,485 bytes against 2,001,048. A large combined reply is subject to the upload ceiling
in appendix I (E13).

### K. Earlier rounds

**Round 7.** Decisions 16 to 18 (owner); rule (g) answered E16's row without its record. Losses and the notice moved
to E16's recount with kept records, and the online case was stated. Every reader applies the same reading. E16's
history replaced E15's 17 and 18 as the check-first evidence.

**Round 6.** Decisions 4, 12, 14 and 15 (owner): kept records, the possible-clash card, the reconnect wrapper, and
the move race accepted with plain undo plus check-before-writing. Rule (e)'s cause became a move race, not a removal
(E11's correction, E14, E15). Undo stated what an undone removal brings back, its side effects and the blocked redo.
Section 10 listed the three races; E15's options went to appendix L. Conversion fills name cells (E15).

**Round 5.** Rooms stay on the server (owner); the session-only proposal was dropped and the relay host settled.
Heading names moved into their own cells: inline, narration typed in a deleted scene ended up inside a removed
title, in no row (E11). Rules (e) and (f) were added with their limits, and no command copies narration, after a
copying split doubled text (E11). What undo does not bring back was stated (E11, E12). E11's tag counts and E12's
flag rule replaced the lost-tag question. Relay, loads and the notice came to rest on E13 and E12.

**Round 4.** The removed mark on beats, the keep-always undo setting, the refusal of moves, the 2 MiB budget and the
U14 row were dropped; plain keys replaced per-action keys except for production tags; the join target is stored
again for rule (d).

### L. A row's place after competing moves and undo

E15 compared five options. The structural cause it names: a beat's place is one rank, one plain value under one key
of its record. Of two same-moment writes Yjs keeps the higher client's, and plain undo never overwrites another
person's write, so the winner's undo leaves the key empty. A second cause runs through every option: a move also
writes ranks of rows it did not select, and undoing the move takes those back (histories 15 and 16).

In the named histories (five deliveries each) and the generated sets (600 mixed, 200 double-split, E10's 229), no
option lost narration, showed a beat twice or left copies disagreeing. With records deleted, every option lost a
row's record in history 12 and a segment's first row in the same race.

| Option | After the race and the winner's undo | Presses against a later change someone else made and had seen | Cost over A (bytes kept per move; read, move at 900 beats) | Against it |
| --- | --- | --- | --- | --- |
| **A, as built (chosen)** | The row follows its narration neighbour, and can later change scene (histories 1 and 5) | Never; a conflicting older redo returns false and is used up (histories 9 and 10) | Baseline: 9.42 bytes; 3.80 to 3.98 ms; 4.15 to 4.30 ms | The open case in section 6 |
| B, `ignoreRemoteMapChanges` | Back where it was before the race | Any undo or redo can replace one: histories 2, 6, 9, 10, 21; 6 of 1,104 generated presses changed 8 values | Same bytes; read about 9%, move about 4% slower | Applies to every map key, status included; Yjs marks it experimental |
| C, one map key per rank write | Where the other person put it | A redo can (histories 9 and 10) | 22.89 bytes; read about 46%, move about 70% slower; about 42 lines | Slowest, and a reader order to keep |
| D, a list of ranks per record | Where the other person put it | A redo did in one three-person history (10) | 10.53 bytes; read about 9%, move about 7% slower; about 39 lines | Stored entries double with each round of racing moves and undos: 256 after 8 rounds |
| E, a fixed place written with each boundary | Where the row was created: 0 to 4 rows from where it stood, in another scene for 3 of 5 rows (mixed) and 2 of 3 (double split) | Never, as A | About 15 more bytes per row; read about 8%, move about 18% slower; about 62 lines plus hooks | Undoing a move can relocate a row it did not select (histories 15 and 16); one boundary without its fixed place turns the whole reading back to A's, and the import writes none |

B, C and D, like E, can also relocate a row an undone move did not select (histories 15 and 16); A left it in place
there, by where the narration happened to put it.

### M. Accepted losses, counted

E16's recount of E11's 600 generated histories, names in cells, forward delivery: occurrences, and the histories
they fall in. Tags use E11's five-delivery rule.

| Loss | Records deleted | Kept records |
| --- | ---: | ---: |
| Unseen record change discarded with a removed beat | 131 in 110 of 600 | 1 in 1 of 600 |
| Unseen visual change discarded with a removed beat (kept: stored, not necessarily shown) | 106 in 94 of 600 | 0 in 0 of 600 |
| Typing lost when an unseen creation undo removes a new beat | 3 in 3 of 600 | 3 in 3 of 600 |
| Typing lost when an unseen creation undo removes a new heading | 1 in 1 of 600 | 1 in 1 of 600 |
| A split half stays behind after an offline move | 1 in 1 of 600 | 1 in 1 of 600 |
| A deletion misses a row restored by an unseen undo | 3 in 3 of 600 | 3 in 3 of 600 |
| A double delete and double undo doubles the narration | 3 in 1 of 600 | 3 in 1 of 600. The same shape after E17's histories 4c and 5c: both people cut N unseen and each undoes; four N markers and `bb` are stored and one row `N: bb` shows, in every option and delivery. Histories 4c and 5c themselves end with two N markers stored and one N and one `b` shown; no continuation showed N twice (E17) |
| Production tag lost | 5 of 845 | 5 of 845 |

The one kept record loss is a field on a beat whose creating split was undone; it is absent with or without the cut
(E16). Following each latest value through every cut, a different denominator:

| Latest value | Records deleted | Kept records |
| --- | ---: | ---: |
| Field still stored on a row that stays removed | 0 of 123 | 120 of 121 |
| Visual character still stored on a row that stays removed | 0 of 103 | 103 of 103 |
| Field shown on a row that returns | 2 of 6 | 6 of 6 |
| Visual character shown on a row that returns | 1 of 8 | 8 of 8 |

Also accepted, not in E16's ledger: two people dropping into each other's spot meet neither request (E10, all 8
histories); a rankless row placed by rule (e), 3 of 600 histories with kept records (E14), decision 15.

### N. A row without its record

E17 compared what to do when a beat's marker comes back without its record and visual cell (section 10's four
steps and their variants, on kept records). Each option ran 18 named histories in five deliveries, 90 runs, plus
E15's 21 histories, the segment-head race, 16 commands on the four-step state, and E14's and E16's generated sets.
In all of them, no option lost narration, showed a row twice, left copies disagreeing or failed a reader.

| Option | What happens | Cost | Against it |
| --- | --- | --- | --- |
| K, as built | The row shows without its record or cell in 30 of 90 runs (480 of 3,000 copy-steps). 5 of 16 commands throw after writing: a heading above N or above B, and three moves that leave `B, N, A` stored. The row list shows N; the notice reader leaves it out. Restoring a cut neighbour from the notice throws before writing | — | The defect |
| **R, rule (g) (chosen)** | 0 of 90. Alice's undo wins: the document reads as before the split, and Bob's undo brings back the narration, not the row; Alice's redo brings N back with its record, cell, rank and Bob's status. No command throws after writing; joining the hidden row throws before writing. Outline and notice agree, and restoring from the notice works | Stores nothing. Read and keystroke times within the spread between passes; a split and its undo about 0.6 ms slower; the re-reading cost during editing not measured. About 20 lines and a 4-line hook | The hidden marker stays in the text: later typing after it moves into N on Alice's redo, and cutting B takes it. A split inside that text lands right after the beat's own marker. It moves no generated figure |
| U, an undo filter that keeps created records and cells | 0 of 90. Bob's undo wins: N comes back whole with his status and visual text, and all 16 commands work. It also removes E16's one remaining record loss | About 31 bytes kept per undone creation (30.6 per split, 30.8 per insert), for good. About 7 lines | N has no rank and follows rule (e): an unrelated move gives it one, cutting B can carry it across a scene line, and restoring from the notice throws until it has one. The filter refuses to delete any record or visual cell in the root maps, on undo and redo, whichever command made it, so a redo no longer deletes containers a command deleted directly. A remote creation undo no longer reaches the beat-map observer |

**Where rule (g) shows the narration.** As if the marker were absent: into the row above; at a segment's start,
into that segment's first beat, else the beat before, else the next; after a heading, into the beat after it, the
name unchanged; with no beat, the narration-only row. **The seam:** B shows its own text, then the hidden text.
Typing at the seam (offset 0 when B has none of its own) lands before the hidden marker and stays in B on a redo
(outside review; to be pinned by a test); typing inside or after the hidden text moves into N on a redo, and
cutting B takes it (E17). **Refreshing** keeps the parsed narration of unchanged segments and recomputes which rows
own the affected text. The marker's own segment alone is too narrow: a hidden marker at a segment's start moves its
narration to a beat in another segment.

**Other routes.** Creating the record and cell in an untracked transaction nested inside the command does not work:
Yjs keeps the outer origin. A separate, outer, untracked transaction run before the tracked one does work (E17's
review): undo removes the marker and rank and keeps the record. Its cost is a second transaction, with its own
moment when other copies can see it and its own way to fail half-done. It was not wired into the commands, and R
and U together were not tried.

None of the options changes the segment-head race, the doubled narration of a double delete and double undo, or
rule (e)'s placement. The owner chose R. Per E17, it writes and stores nothing, it is the one option under which
outline, notice and restore-from-notice all work on the four-step state. Its cost: Bob's undo brings back N's
narration, shown in B, but not N as a row.

The outside review of this note measured remote apply through the prototype's reader on the 900-beat fixture: a
split 4.6 to 5.2 ms as built against 5.0 to 5.35 ms with the rule; a creation undo or redo 4.6 to 5.0 against 4.9 to
5.3; a keystroke about 0.75 ms in both. These are the reviewer's own uncommitted measurements, not an experiment
result, and they include a full reparse: the prototype's hook clears every segment's parsed text. The design keeps
parsed narration for unchanged segments instead (section 7). Open: whether the older `views` cache in
`src/native/variant.ts` reads records and needs the same split.

### O. Acceptance cases from the outside review

Requirements from the outside review of this note, added to the build order (section 11).

**Slice 3.**
- E17's 16-command table on the four-step state: every command aimed at the hidden row returns a refusal and leaves
  the document snapshot unchanged. Commands on the row above succeed on the shown narration: typing at the seam and at
  the end, cut, move, join and unjoin, a heading above. "Move the run B through N" refuses or moves B alone.
- A split's timing through the reader on the 900-beat script with warm caches, including one case at a segment's
  start, with a parse counter showing no unrelated segment was reparsed, so a full rebuild that happens to meet the
  time does not pass.

**Slice 6.** The same timing for a creation's undo and redo, and the outline before and after Bob's undo in section
10's four-step history.

**Slice 7.**
- **First loads** (decision 16): the sizes that fit at each supported speed, a limit on restarts and the message;
  and a large offline return under stock timers.
- **Two writers past the size limit:** two offline copies, each under 15 MB, whose merge exceeds it. The test shows
  where the refusal happens, what each person sees, how refused work is exported, and that retries stop. The note
  has only a per-command refusal on the client (appendix I, "What happens at 15 MB"). The plan also requires bounds on
  total document state checked before an update reaches other clients, explicit handling of legitimate concurrent
  limit conflicts, never discarding an update while claiming synchronization succeeded, preserving recoverable data,
  and a test where individually valid edits merge past the limit ("Validation and resource limits"). That gap is
  open.
- **Server stops** (decision 19): stop the server inside the 2 to 10 s store window; show what is lost and whether
  reconnecting copies restore it. The plan's receipt checker and kill-before-and-after-receipt tests apply only if
  these tests call for the update journal.
- **Stale targets in the editor** (E1's four commit outcomes: written, unchanged, moved to the beat's live cell, or
  handed to a recovery list): IME composition and plain buffered typing, in narration and in visual cells, with the
  target removed, replaced, restored, or hidden under rule (g). Each ends as a visible write or a recovery entry,
  never silently. One case starts a composition in N while N is shown and commits it after N is hidden.
