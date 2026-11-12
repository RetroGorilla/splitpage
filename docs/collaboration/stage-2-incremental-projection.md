# Incremental document projection

This is package 6c's second cut. `createSharedIncrementalProjector` owns a normalized
replica, cached validated inputs, and an immutable document/recovery/revision pair.
It shares `assembleSharedDocument` with the full reader. Each publication also
carries the report of which rows changed (see "The report of which rows changed").
The session integration is a separate cut; no application caller or standalone
editing path changes here.

## One assembly

`SharedProjectionSource` supplies document and heading fields, ranked validated
records, native text units, status readings and beat structures. Its per-entry
versions come from public deep change events. Replacing a native container,
changing its text, or changing any mark-store key invalidates that entry. This
includes an opaque undo marker changed alongside a retraction. No native item
representation is read by the projector.

Both readers run the same block, join, field, gallery, text, comment, b-roll and
section rules. Optional memo callbacks on the pure block collector and canonical
builder reuse their results; they contain no alternative projection rules.
Unchanged segment parts retain their unit arrays, and unchanged join groups and
cells retain their projection results. Record membership buckets avoid repeatedly
searching the cached record list merely to decide a group's dependencies. The
gallery rule still receives all validated gallery records and members in merged
row order. The join reader remains the single place for issued joins and their
separator register; the incremental reader does not decode separators itself.
An index of the group fields reported by `readProjectionBeatStructure` maps register
fields back to their beat readers. A `joinGlue:<group>` change invalidates those structures, leaving document
fields, the title, texts and unrelated groups cached. Register validation and
fallback to the issued separator stay in `readProjectionBeatStructure`, with
`roots.meta` passed by the shared source. The literal probe changes only metadata,
checks the new separator before its counts, and checks zero unrelated native reads.

Statuses reuse the existing target index. Target versions change on event
replacement, retargeting, deletion and retirement. A change to block ownership
invalidates beat status resolution through the existing projected-owner resolver.
Ordinary text edits retain the ownership signature: only heads, ordered native
segments, beat ownership fields and boundary adjacency participate in it.

## Publication and lifetime

A new projector makes one wire copy. Subsequent guarded update callbacks apply
the library's update to that replica, refresh dirty inputs from its deep events,
and publish the shared assembly's result at the source revision. Earlier source
transaction observers can still see the previous immutable pair. The projector's
own observers see the new pair, with held incoming updates still behind the
per-handle gate. Each update drained by the gate gets its own publication.
Duplicate deliveries that change no state need no new pair.

If the assembly throws and an observer registered a failure listener, the projector
calls those listeners instead and keeps the revision as `pending()`; `retry()`
assembles it again from the last published document. With no failure listener the
error propagates as before. No new library subscription is involved.

The extra library subscription sites are the replica roots' `observeDeep`, the
source roots' `observeDeep`, and source document `destroy`, all in
`incremental-project.ts`. Each callback runs through `guardSharedCallback`; the
source update uses `observeSharedUpdates`. Disposal removes the subscriptions and
destroys the replica. Destroying the source disposes its projector too.

There is one conservative normalization fallback. Wire encoding normalizes
surrogate fragments per native string item. Later native item merging can make
two originally malformed fragments into a valid pair, so replaying their earlier
encoded updates alone can disagree with a fresh full snapshot. The source deep
observer checks changed texts through `toDelta`. If a changed text contains a
UTF-16 surrogate code unit, the projector supplies a current wire snapshot as its
native input on that and later transactions until disposal. This also covers
valid non-BMP text. It retains the input versions and pure caches, so only dirty
entries and groups are read and projected again. The original replica retains
the change, ownership and status indexes; string normalization preserves their
native UTF-16 positions. Input snapshots do not initialize another ownership
index. The production snapshot hook counts this wider whole-state wire copy.
Literal tests check isolated high and low surrogates, their later merge, deletion,
mark-only arrivals and an unrelated edit that retains the marked row by identity.

## The report of which rows changed

`assembleSharedDocument(source, previous)` returns `changes` beside the document
and the recovery list. It is `compareSharedProjections(previous, next)` in
`src/core/collab/projection/changes.ts`, a function of the two documents and
nothing else, so two copies that hold the same two documents give the same report.
The full reader reaches it through `projectSharedDocumentStep(handle, previous)`;
the incremental projector passes the document it last published.

| Field | Meaning |
| --- | --- |
| `whole` | No previous document, or a repeated or missing row id on either side. The lists are then empty |
| `added` | Ids in the next document only, in its order |
| `removed` | Ids in the previous document only, in its order |
| `moved` | Kept rows that are not on the longest run of kept rows that held its order. Of equally long runs, the one whose rows come earliest in the next order stays. In the next order |
| `changed` | Kept rows with a differing field: `{ id, fields }`, fields in the next row's key order, then fields only the previous row had |
| `fields` | Document fields other than `rows` that differ, in the same key order |

A painter that takes out the removed and moved rows and puts the added and moved
rows at their places in the next order has the next order; `moved` is the fewest
rows for which that holds. Values are equal when they have the same kind, the same
keys in the same order, the same list length and holes, and `Object.is` leaves.
The order of a row's own keys is not a change: the canonical form fixes it from
the key set.

An object that both documents hold is not walked. The projector's documents are
frozen and share every row and field the assembly retained, so a typed character
compares one row by value among 300 (`compare-row` in the work counter) and the
comments list (`compare-field:comments`), which every assembly builds again. The
report builds one id index per document per publication and reads no native state.

Each report is relative to the document published before it, whether or not a
subscriber of that publication threw.

Measured, and open: a change of structure (a reorder, a new beat, a join) makes the
assembly build every row again, because the block memo is keyed by position. The
report still names only the rows that differ, after comparing each rebuilt row by
value: 300 of 300 for one row moved to the front.

## Counted work

The committed `benchmark-document.ts` supplies 300 beats, 30 headings, fragmented
text, many marks, two writers and 5,100 editing commands. No timing is taken. The
cost test instruments the native methods actually called, including iteration
and snapshot copies, and supplies production hooks for segment, record, field,
group and cell recomputation. Injecting an additional full assembly into the
update callback fails that test.

| One character after warming preparation | Fresh full assembly | Incremental execution and publication |
| --- | --- | --- |
| Native text method calls | 2,251 | 5, on the changed text only |
| Mark-store entry visits | 10,202 | 19: 18 keys and one new birth record |
| Native record visits | 18,308 | 0 |
| Status-event visits | 1,200 | 0 |
| Order-entry visits | 660 | 0 |

The incremental bound is identical with 0, 299 and 10,000 unrelated beats: zero
unrelated text, mark, record, status or order reads. The mark reader processes
one 70-unit text, validates one record, resolves 36 anchors and tests 69 covering
records in the fully edited 300-beat history. With only the measured beat edited
the last count is 53. Exactly one segment, one group and one narration cell are
rebuilt. The five text calls include the source's normalization check and the
field-stream, unit and marked-text readings on the replica. The table's full
column measures the same shared assembly without persistent inputs, rather than
estimating its cost from another reader.

The earlier mark and status caches retain their bounds: warm mark preparation
reads no text or mark records; after a change the touched text's mark keys and
anchors are revisited. Status commands still visit their target events plus
pending changed keys, without a scan of unrelated events after initialization.

Global pure work remains explicit. The block interpreter revisits cached boundary
metadata to decide ownership and recovery. The b-roll rule scans all visible units
twice, using every stored shot id and visual-before-narration document order;
marker, order, removal or shot-id changes can rewrite an otherwise unchanged cell.
Comment first-occurrence anchoring also uses rendered order. Tag registry changes
invalidate text interpretation. A dirty gallery group still costs member beats
times supplied gallery records. These are cached-input scans, not unrelated
native text or record reads. Initialization reads the whole state; the surrogate
fallback copies the whole encoded state but retains unrelated projection inputs.
This PR makes no timing or total-memory claim.

## Evidence and limits

Literal tests cover join partners, status without text changes, mark-only arrivals,
opaque undo markers, normal and prefix splits across a tag, ownership changes,
duplicate and empty cleaned ids, dangling joins, wrong native record shapes,
gallery folding, shared comment anchors, b-roll first occurrence and shot
reservations, and each revision in a held-update drain.
After merging the undo executor, the mark-only arrival test also receives a real
provenance marker and retraction together from another writer, and checks the
literal unmarked result from its already warm incremental reader.

The seeded comparison uses four seeds, two and three writers, normal, reversed
and duplicated delivery, 24 encoded late joiners, 1,320 authored actions and 2,756
checkpoints. Choices use the complete generator output divided by 2^32. It covers
all 22 operation kinds in the committed operation examples. Fourteen use installed
command handlers; join, glue, removal, restore, move and heading shapes whose
handlers have not landed use direct authored transactions. A separate test checks
all 291 fixture references after hydration and scripted edits at 1,455 publication
checkpoints. Every checkpoint compares document and recovery with a fresh full
projection through the strict agreement helper, including key order and presence.
The existing fixture save-byte contract is unchanged.

| Declared correctness limits |
| --- |
| None; the asserted literal violation table is empty |

New deliberate defects omit a join partner dependency, ignore mark-only deep
events, omit the join-register index, or insert a full read into typing. The first
three fail the named literal behavior tests; the last fails the native read bounds. The earlier stale mark
cache defect remains in the manifest.

The report is compared at every checkpoint above with a fresh full comparison and
with a slow comparison written for the tests (`tests/collab/projection-changes-oracle.ts`):
2,720 reports in the seeded history test and 1,455 in the fixture test. A second
seeded test (`incremental-changes-generator.test.ts`: three seeds, two and three
writers, normal, reversed and duplicated delivery, 18 late joiners, 630 commands
of 18 kinds, seven of them wrong-shape writes) compares 1,360 reports and, per
history, the report from the common start to the settled document on every copy.
Its declared limits are empty. Five report defects are in the manifest: an omitted
status, ignored moves, a rebuilt row trusted by id, no previous document, and
retained rows compared by value while typing.
