# Structural operation execution

`registerSharedSplitHandlers(handle, { cells })` registers split, split-before and
segment creation through the operation entry. `cells` is the app's cell decoder,
called during preparation only. No application caller registers these handlers.
The executor entry, preparation view and execution guard are unchanged.

New beat, segment, visual and gallery keys use
`structure_<writer>_<operation-as-four-digit-UTF-16-hex>_<role>_<slot>`.
The writer is canonical decimal, the role is fixed and the slot is a nonnegative
integer (zero except for later gallery slots). Encoding the raw operation preserves
its identity while escaping separators. The approach matches b-roll projection:
derive from raw identity, reserve and compare on the app's `cleanId` result.
An operation id that `cleanId` would change refuses with
`invalid-structure-operation-id`; it is never rewritten. Structural operations
emitted by flow use `_o_` before their ordinal. Native text and mark operation ids,
mark-record keys and mark-occurrence ids retain their existing forms.
Supplied beat, segment and boundary names never become
new shared text keys. A per-call alias table translates later operations in the
same list, including scalar repairs. Reusing an occupied identity refuses the
whole list. No compatibility translation or second generated-id parser is added.

An idle registration indexes cleaned keys and record ids in the beat, segment,
heading, visual, gallery and registry roots, plus stored order names and inline
b-roll ids. Native updates refresh only changed records. Text events patch added
and deleted embeds from the transaction's before/after clocks and deletion ranges.
They inspect neither the existing text item chain nor a text delta. Ordinary string
insertions do not rebuild reservations. Reference counts remove deleted reservations, so
an encoded late joiner has the same index. Prepare uses only cached lookups and a
per-call reservation set. Record creation and b-roll insertion also contribute to
that set, in either order around structural creation. A cleaned collision refuses
the complete list with `existing-identity`.

| App load path | Identity rule |
| --- | --- |
| rows, comments, replies, people and b-roll records | `migrateRows` applies `cleanId`; the new format is unchanged |
| comment row/anchor references and HTML comment/b-roll attributes | `cleanId` or `safeId`, with the same result |
| scene ids and first-beat anchors | scene ids accept the same ASCII alphabet; anchors remain exact row ids |
| gallery picture and link data | hashes and URL/file keys are retained by their existing codecs; visual/gallery container keys stay native |
| tag registry and b-roll prop tag references | the narrower `t_` grammar stays with the tag owner; this executor mints no tag ids |
| document id | its separate document-id policy is unchanged; this executor mints no document id |

Literal tests run every created key through ordinary record, reference, HTML and
scene load paths. They check segment ids in block projection and visual/gallery
keys in native record projection; these container keys are not plain-document id
fields today. All four structural forms also pass through `projectSharedDocument`
and the real `migrateRows` pipeline on every copy. A seeded tuple test checks
unambiguous components and unchanged ids after load, including escaped separators,
ambiguous decimal concatenations and refused stripped characters.

The identity history model has this literal declared limit:

| Declared limit | Replacement rule in the span/address cut |
| --- | --- |
| same cleaned beat id created at the same moment: the load renames the later beat and a command addressed to the id reaches the other one | The first beat in merged document order keeps the cleaned id and is the row; later beats with that cleaned id go to recovery without renaming. Address resolution reaches the beat shown. |

A local reservation cannot observe an undelivered native creation. This case is
not emitted by the app: each writer's generated ids carry its own writer component.
The pinned native history currently loads Reserved under the shared Created id,
renames Created, and a command planned for Reserved edits Created instead. The next
cut must replace that literal outcome with the decided projection/address rule.
The seeded checkpoint model collects violations and compares them with this table;
it compares patched reservations with a fresh encoded-state index at every checkpoint.

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

The creation emitter records scene intent: `before` joins the right neighbour's
scene, while `after` stays on the left side of any intervening heading. With no
left neighbour yet, `after` falls back before the right neighbour's preceding
heading-only segments; it does not cross a segment containing narration. When the
right beat is inline under a heading, that heading's whole segment is the outer
insertion point. The order cache supplies that position without rereading the
whole order. This also covers reverse-emitted groups and insertion before the
first heading. Scene repairs are supplied to the emitter before describing a
creation; the executor does not infer intent from later scalar operations.

| Emitter | Affinity and scene intent |
| --- | --- |
| replaceRange repair | before when the repaired row joins its right neighbour's repaired scene, otherwise after |
| startParagraph end, startBeat end, blankAfter | before within the same scene; after at a scene or script end |
| startParagraph beginning, blankBefore | before, using the repaired scene anchor to join the right beat |
| enterInHeading at zero | after, placing narration before that heading |
| finalizeHeading empty retained beat | before within the right scene, otherwise after; heading-finalize subsequently claims the retained beat |
| finalizeHeading existing-scene repair | before within the repaired scene, otherwise after |
| insertBeats | before when the right neighbour belongs to the insertion scene, otherwise after; heading offset zero stays before the heading |
| pasteFlowRange empty/header placeholders | before within the repaired scene, otherwise after; heading-create subsequently claims new heading placeholders |
| splitBeat, selectionToOwnBeat, insertBeats narration split | before a right text unit, after the last left unit; the text address stays inside the source beat's scene |
| enterInHeading and insertBeats heading-tail split | before a right heading unit, after the last left unit; the resulting beat remains under that heading |

These are emitted-list changes only: standalone rows and sections are unchanged.
The independent flow applier honours the same affinity when choosing a row gap.
Literal tests compare the heading preceding every shared row at scene and script
edges, including concurrent creation and encoded late joins. The app agreement
helper also compares shared scene anchors with the app and independent applier.

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
the whole list; duplicate gallery links also refuse `invalid-initial-gallery`.
Ingesting local bytes remains a caller responsibility. Prefix
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
histories are still open here. Standalone flow results, application, features,
bootstrap, exports and browser behaviour remain unchanged.
