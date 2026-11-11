# Structural operation execution

`registerSharedSplitHandlers(handle, { cells })` registers split, split-before and
segment creation through the operation entry. `cells` is the app's cell decoder,
called during preparation only. No application caller registers these handlers.
The executor entry, preparation view and execution guard are unchanged.

New beat, segment, visual and gallery keys are JSON arrays containing `structure`,
the live writer, the command id and the role (and the gallery slot index).
Supplied beat, segment and boundary names never become
new shared text keys. A per-call alias table translates later operations in the
same list, including scalar repairs. Reusing an occupied identity refuses the
whole list. Stable-identity validation does not normalize identifiers.

A creation resolves logical neighbours to their current spans. Within a physical
segment it inserts a beat boundary and reuses the existing text and mark store;
between containers it creates a segment and inserts it in the outer order. This
lets Enter create a blank beat between the halves of an earlier split. Inserting
before a scene's first beat stays after its existing heading; the app's following
scalar operation repairs firstSceneId. Creation does not copy existing characters.

The app emits a pasted group from last row to first. A forward neighbour can still
be absent during preparation; the available neighbour determines placement, or a
null right neighbour means document end, matching the independent flow applier.
Two existing neighbours in reversed order refuse the entire list.

Initial narration and visual runs use the existing text and mark preparation.
Every created beat gets an independent visual text/store; `beats[id].visual` names
that component, whose own `beat` remains its origin. Gallery records retain slot
order, picture metadata and keyed links. Complete stamps use `stamp`; other row
fields, including incomplete stamp fields, retain their presence in `extra`.
The app also emits visual/gallery record-create observations for pasted rows. The
record executor checks these against the same call's prepared content and aliases
their supplied names; it does not create a second text or attachment. A conflicting
observation refuses the whole list. Later calls use native identities from paint.

Legacy image data URLs and gallery links containing device-local locations refuse
the whole list; ingesting those bytes remains a caller responsibility. Prefix
splits accept narration; a heading prefix returns
`invalid-split-target`. No flow emitter produces that heading-prefix operation.

Splitting inserts one boundary into the existing text and keeps the original
character identities and anchored mark records. The ordinary boundary is `{b:id}`.
Boundary and text insertion points share a prepare-time surrogate clamp against
the current text plan, after resolving native, flow-base or same-list references.
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
later narration and visual edits in the same list. Every apply closure retains only its
deeply frozen description, including positions, payloads, map writes and placement.

The structure tests use an independent reader, the strict replica comparison and
the copied T05 two-splits oracle with original character identities and both caret
anchors. The creation model covers the three creation forms with two and three
writers, reordered/duplicate delivery and an encoded late joiner. It also checks
gallery payloads and the original character identities. Its complete emitted lists
are compared with the independent flow applier; a separate rich batch matrix covers
marks, atoms, metadata and multiple rows at the start, middle and end of narration.
Production structural projection is not used for these comparisons;
its interpretation belongs to the projection lane.

Join, removal, restoration, heading creation/removal/finalization, movement,
recovery placement and undo remain later cuts. In particular, the heading-name
`cappedText` rule, imported-layout movement and the remaining structural Stage 1
histories are still open here. Nothing in this change edits standalone flow,
application, features, bootstrap, exports or browser behaviour.
