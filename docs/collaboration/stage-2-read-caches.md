# Shared reader caches

This is the first cut of package 6c. It caches existing readers and preparation;
it does not replace the full-document projector or the shared session's comparison.
Those follow as separate PRs so reader invalidation can be reviewed independently
of segment invalidation and change reporting. The next cut shares the full
projector's assembly and chooses which segments to read; the final cut replaces
the session's `projectionStep` and reports its precise change set.

## Ownership and invalidation

Each handle owns `CollabReadCaches` in `state.ts`. The new library subscription is
`CollabDocumentState.constructor`'s guarded `beforeTransaction` listener. It marks
the cache unsettled. The existing guarded `beforeObserverCalls` listener consumes
the transaction's public `changed` map before subscribers can read that revision.
No library item representation, linked list or internal store is read.

An unsettled read bypasses both memoized results and validated-record entries.
This covers reads between writes in one transaction, including a body that throws.
The gate's held updates retain their separate transactions: each invalidates the
cache before its own notification. Duplicate deliveries may notify without changing
any cached source. Weak maps retain results by their native text or map identity.

Text and mark-store versions jointly own a frozen mark reading. Its canonical
occupied-key list includes invalid records whose keys still reserve an identity.
Validation of an unchanged record is reused after other records or text change;
anchor offsets are resolved again when their text changes. Replacing the text or
store changes the memo's source identity. A sweep visits only records whose
resolved ranges cover the current unit, preserving the previous UTF-16 key order.
The preparation facade reuses frozen units, keys and resolved records, with a new
resolver closure bound to that preparation's lifetime.

Status preparation indexes validated event keys by `(scope, record)`. Initialization
reads the event root once; subsequent reads visit only pending changed keys and
the requested target's events. Replacement, retargeting, invalidation and deletion
remove the earlier index entry. Prepared writes are overlaid before the existing
status validator and causal resolver run. Reads inside an unsettled transaction
use the original whole-root path. Empty target buckets are removed.

## Counted work

`tests/collab/benchmark-document.ts` builds a deterministic script with 300 beats,
30 headings, narration and visuals, two editing writers, eight fragmentation and
marking rounds, and 5,100 commands. It uses each seeded generator output divided
by 2^32 before selecting a choice. Run its count probe with
`node tests/collab/benchmark-read-caches.ts`; the script reads no clock.

The same builder supplies bounds tests with 0, 299 and 10,000 unrelated beats.
The larger bound edits only the measured beat, keeping its history identical.
The standalone application is not wired to these readers.

Counts below compare `origin/main` at `c3100ea0` with this cache implementation,
using the same committed builder and library instrumentation. The baseline source
was extracted into a scratch directory, with the current builder and measurement
helper copied into it. No timing was measured.

| Production operation | Before | After |
| --- | --- | --- |
| Read the measured text after building the 300-beat history | 1 text read, 34 mark-store entry visits | 1 text read, 20 mark-store entry visits |
| Repeat that read | 1 text read, 34 mark-store entry visits | 0 text reads, 0 mark-store entry visits |
| Prepare and apply one typed character after warming preparation | 2 text reads, 51 mark-store entry visits, 1 beat-record read | 0 text reads, 0 mark-store entry visits, 1 beat-record read |
| Refresh that text after typing | 1 text read, 36 mark-store entry visits | 1 text read, 19 mark-store entry visits |
| Type and refresh together | 3 text reads, 87 mark-store entry visits, 1 beat-record read | 1 text read, 19 mark-store entry visits, 1 beat-record read |
| Prepare and apply a mark after warming preparation | Whole touched text and key list read again | 0 text reads, 0 mark-store entry visits, 1 beat-record read |
| Second status command, with 10,000 unrelated events | 20,003 status-entry visits, including 20,000 unrelated visits | 4 status-entry visits, 0 unrelated visits |
| Second status command, with no unrelated events | 3 status-entry visits | 4 status-entry visits |
| Read 1,000 units with 200 disjoint one-unit marks | 200,000 range-predicate visits | 200 covering-record predicate visits; repeat read: 0 |

Entry visits count `get` and `has` as well as yielded keys, values, entries,
iterators, `forEach`, `map`, `toArray`, slices and JSON readings where supplied
by the public type. Nested public calls can contribute more than one visit.
The last row's baseline counter was inserted immediately before the old production
`located.filter`; it counts the filter's actual input length on each unit.
The new production `measureSharedReads` hook counts validation, resolved anchors,
units and covering-record predicates only while a caller supplies a measurement.
The library instrumentation wraps the production calls, including reads on fresh
snapshot copies, rather than making a second read to infer their cost.
Its own literal test covers all enumerations it instruments. The unrelated-registry
mutant proves that adding a whole registry read to preparation fails the bound.

The first text reading above already has validated-record cache entries from the
editing history: 17 keys plus 3 newly read record values. After typing it has 18
keys plus 1 new birth record. The new range sweep tests 68 covering records over
69 units in the fully edited fixture, then 69 over 70 units after typing.
The status index's extra constant visit is its pending-key existence check.

## Remaining costs and evidence

A text change still enumerates that text's record keys and resolves its anchors;
overlapping ranges can still require units times covering records. Mark planning
still traverses cached plain units and additions. Status initialization and changed
events belonging to other targets still require reading those events once; the
zero-unrelated bound applies after initialization with no pending unrelated changes.
Neither mark compaction nor causal-status ancestry costs are changed here.

The full projector still makes wire snapshots and reads the document. The future
incremental assembly must also account for gallery grouping's member-beats times
gallery-record scan and b-roll's two whole-visible-unit scans, described in
[record projection](stage-2-projection-records.md#cost-for-a-per-change-projector).
The typing counts above cover execution and refresh of the changed mark reading,
not a claim about a full session projection or paint.

Literal tests cover mark-only arrivals, deletion/replacement/wrong-shape records,
store replacement, preparation overlays, transaction-body reads and each revision
in a held-update drain. The seeded cache test uses two and three writers, normal,
reversed and duplicated delivery, and 24 encoded late joiners. It compares frozen
cached readings and full document/recovery projections with fresh encoded copies
using the strict agreement helper at 2,620 transaction checkpoints, over 840
commands and 24 histories. It covers every formatting kind, insertion, deletion,
status, scalars, record edits and invalid mark records. Broader structural histories
and the 291-reference byte contract remain the existing projection gates.

| New cache-history declared limits |
| --- |
| None; the asserted literal table is empty |

The projection mutant manifest adds stale text after a mark-only arrival, an
unrefreshed status index and an extra unrelated registry read during preparation.
The first two fail named behavior tests. Join-partner invalidation and omitted
status change sets belong to the later incremental and session cuts.
