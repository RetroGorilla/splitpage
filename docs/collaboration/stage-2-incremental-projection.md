# Incremental document projection

This is package 6c's second cut. `createSharedIncrementalProjector` owns a normalized
replica, cached validated inputs, and an immutable document/recovery/revision pair.
It shares `assembleSharedDocument` with the full reader. The remaining session
integration and precise change report are a separate cut; no application caller
or standalone editing path changes here.

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
UTF-16 surrogate code unit, the projector rebuilds its normalized replica and
input caches from the current encoded state. This also covers valid non-BMP text;
that path deliberately pays a full read. A literal test checks isolated high and
low surrogates, their later merge, deletion and a subsequent ordinary insertion.

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
native text or record reads. Initialization and the surrogate fallback read the
whole state; this PR makes no timing or total-memory claim.

## Evidence and limits

Literal tests cover join partners, status without text changes, mark-only arrivals,
opaque undo markers, normal and prefix splits across a tag, ownership changes,
duplicate and empty cleaned ids, dangling joins, wrong native record shapes,
gallery folding, shared comment anchors, b-roll first occurrence and shot
reservations, and each revision in a held-update drain.

The seeded comparison uses four seeds, two and three writers, normal, reversed
and duplicated delivery, 24 encoded late joiners, 1,140 authored actions and 2,384
checkpoints. Choices use the complete generator output divided by 2^32. It covers
all 19 operation kinds in the committed operation examples. Eleven use installed
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
events, or insert a full read into typing. The first two fail the named literal
behavior tests; the third fails the native read bounds. The earlier stale mark
cache defect remains in the manifest. A defect for an omitted status change-set
entry belongs to the deferred change-report integration.
