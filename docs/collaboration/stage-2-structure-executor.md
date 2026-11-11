# Structural operation execution

`registerSharedSplitHandlers(handle)` registers split, split-before and blank
segment creation through the operation entry. No application caller registers it.
The executor entry, preparation view and execution guard are unchanged.

New beat and segment keys are JSON arrays containing `structure`, the live writer,
the command id and the role. Supplied beat, segment and boundary names never become
new shared text keys. A per-call alias table translates later operations in the
same list, including scalar repairs. Reusing an occupied identity refuses the
whole list. Stable-identity validation does not normalize identifiers.

A segment creation currently accepts empty narration and visual cells. Nonempty
initial cells or media fields return `unsupported-beat-field`; they are never
dropped from an accepted command. Full initial-content creation is a further cut
before the other structural handlers. This extra cut is needed because the flow
vocabulary also uses segment-create for rich inserted rows, beyond blank Enter.
Logical neighbours split across a physical segment return `partial-segment-gap`;
heading-bound gaps return `heading-placement-required` until heading placement is
implemented. Prefix splits accept narration; a heading prefix returns
`invalid-split-target`. No flow emitter produces that heading-prefix operation.

Splitting inserts one boundary into the existing text and keeps the original
character identities and anchored mark records. The ordinary boundary is `{b:id}`.
A prefix split stores `{b:id,before:sourceBeat}` instead of overwriting the shared
segment head. Thus concurrent commands retain their boundaries and writer-scoped
beat records. The new beat records its segment and split author.

The text plan recognizes inline beat boundaries as well as segment heads. Its
native position map follows the whole segment, while flow references retain
their original owner, field and local offset. This also supports a heading tail
becoming narration without changing the original character identities. A wrong
owner or field still refuses. Membership across joined segments comes with join.

Assumption: concurrent typing before the first existing character of a prefix
stays at that original character gap, so multiple writers' text can appear in the
first isolated prefix while every prefix boundary remains visible.

The order index reads the array once at registration, then consumes array-change
deltas. Preparing an insertion reads cached positions for its named neighbours;
the per-call order plan advances only those positions and prior planned insertions.
It makes zero whole-order reads during execution. Its observer updates only local
index data. The changing command still has one transaction and one delivered update.

Text creation prepares absence checks for both text and mark store. Its guarded
apply writer attaches both inside the entry's existing transaction, sharing the
attachment primitive with idle-only creation. New virtual empty texts can accept
later text operations in the same list. Every apply closure retains only its
deeply frozen description, including positions, payloads, map writes and placement.

The structure tests use an independent reader, the strict replica comparison and
the copied T05 two-splits oracle with original character identities and both caret
anchors. The seeded flow test compares complete emitted lists with the independent
flow applier. Production structural projection is not used for these comparisons;
its interpretation belongs to the projection lane.

Join, removal, restoration, heading creation/removal/finalization, movement,
recovery placement and undo remain later cuts. In particular, the heading-name
`cappedText` rule, imported-layout movement and the remaining structural Stage 1
histories are still open here. Nothing in this change edits standalone flow,
application, features, bootstrap, exports or browser behaviour.
