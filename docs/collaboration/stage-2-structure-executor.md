# Structural operation execution

`registerSharedSplitHandlers(handle, { cells })` registers split, split-before and
segment creation through the operation entry. `cells` is the app's cell decoder,
called during preparation only. No application caller registers these handlers.
The executor entry and execution guard are unchanged. Preparation exposes a
read-only owner lookup backed by per-handle structural metadata; callers share
the same per-call planned heads, records and order. The metadata is warmed by the
monitored constructor and patches touched records and boundary embeds. Its embed
reader shares one pre-GC observation with the identity reservation index, so an
ordinary edit never repeats the guarded struct traversal.

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
Both ranges use the package entry's `iterateDeletedStructs`, with a `createDeleteSet`
for additions; no store lookup or binary-search helper is used. Yjs 13.6.33 offers
no event carrying removed embed values without reading the full text delta. One
guarded function owns the embed-reader struct representation dependency; its named
contract test pins the version, returned values and observer-before-GC order.
The existing `state.ts` formatting-cleanup classifier is a second representation
site: it reads `Item.content` only to distinguish `ContentFormat` cleanup deletes,
not to extract embed values. Both sites depend on Yjs 13.6.33.
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

A local reservation cannot observe an undelivered native creation. Rule 21
therefore selects the first beat in merged document order for each cleaned id;
later beats with that cleaned id go to recovery without renaming. The pinned
native history shows Reserved, keeps Created in recovery, and a command planned
from the loaded Reserved row edits Reserved. Text, scalar and status preparation
resolve the id shown on the author's copy to that native record. The identity checkpoint
model's literal declared-limit table is now empty; unmatched violations fail.
It compares patched reservations with a fresh encoded-state index at every checkpoint.

[Assumed rule 25](https://github.com/RetroGorilla/splitpage/issues/1414#issuecomment-6812501580):
a beat whose stored id cleans to empty has no row or invented id; its text goes
to recovery with reason `invalid-beat-id`. A literal native `[]` case checks this
on three writers and an encoded late joiner, including unchanged-state refusal.

The core `projectSharedBlocks` interpreter owns both projection and write spans.
Preparation assembles only candidate streams for the requested cleaned identity
and the touched segment's boundaries. Its per-call planned heads, records and
text units use the same interpreter. Adjacent boundaries naming the same raw beat
coalesce; later occurrences, invalid records and foreign owners give no write span.
Projected unit positions exclude structural and unreadable embeds. Flow offsets,
painted identities and native anchors therefore address the visible fragment;
an insertion before an adjacent head boundary clamps past it. A fragment already
in recovery on the author's copy is refused through a projected beat address.
A command accepted before a competing beat arrives stays on its original native
beat when that beat later enters recovery. The in-flight literal keeps its text,
duration and status; deleting the winning record reveals all three edits again.

One text-location resolver serves preparation and projected/painted readers. It maps a created
beat's flow-shaped visual address through `beats[id].visual`, and maps a displayed
cleaned beat id to the selected native record and physical segment. Stored mark
anchors remain physical, including in recovery; they never reroute to a competing
beat. Native mark preparation, mark write and typed anchor creation resolve projected
addresses by default. Failure never grants physical access. The closed exceptions are:

- (a) resolving an anchor that is already stored (reading);
- (b) writes made under the hydration origin;
- (c) opaque title labels;
- (d) text staged earlier in the same operation list.

`collabPurposeTextTarget` requires an explicit purpose and checks hydration against
the active outer adapter origin. The deterministic hydration writer remains limited
to the first hydration transaction; a later hydration-origin write uses its native
writer. Declaring the title field selects the opaque title-label exception, without
granting another field access. `collabPreparedOperationTextTarget` accepts only the
entry's applying phase, after preparation has validated its frozen target; it also
addresses text created earlier in that list before observers publish the new row.
Stored-anchor readers explicitly request the reading purpose. Native ranges and
anchor positions stay within the fragment the core interpreter projects, using the
cached boundary spans rather than reading the text delta again. Native nullable
preparation/creation APIs refuse with null; a missing native write target returns
`missing-text`, and a range outside the visible fragment returns `invalid-record`.
Refusal leaves bytes, vector, revision and delivered-update count unchanged.

The three original native-mark fixtures are byte-identical to main. The app's
`titleCommand` changes standalone document fields; no
shared title-address emitter exists yet, so there is no app-side title agreement
proof authorizing rejection of those native labels. `FlowOperationTrace.target`
and `marks` describe beat/heading addresses from the flow document; the text and
mark flow-agreement tests cover those emitted addresses. The title cases in text
and mark operation tests are adapter contract tests, not an app emitter proof.
Literal entry refusals declare both opaque title labels and an unattached segment
invalid projected operation addresses, all with `missing-target`.

Head-only refreshes reuse boundary metadata and still consume the transaction's
added/deleted embeds; a genuinely rescanned text skips that patch. Ownership records
refresh only for identity/segment changes, not duration or other scalar fields.
The mixed head/embed model covers 48 histories, 288 commands, 336 checkpoints and
840 live-versus-encoded index comparisons with no declared limits. Each inspection
consumer is guarded separately, so its error is surfaced after index publication.

The malformed-boundary model compares write spans and projected fragments at each
of 1,368 seeded checkpoints over 19 shapes, on the writers and encoded late joins.
Literal adjacent-head edits cover offsets 0, 1 and 2 with native and flow references.
Measured prepare `get` calls with 0/10,000 unrelated records fall from 3/3 to 0/0
for split, 12/12 to 1/1 for two ordered creations, and 10/10 to 0/0 for rich inline
creation. These counters cover the preparation port, not text facade reads.
Owner lookup separately asserts 0/0 native record reads and zero whole-order reads.
The cost guards trap values, keys, entries, forEach, toArray and iteration wherever
the native collection exposes them; unrelated beats and order entries are populated.
The existing scalar preparation test remains unchanged at 4/4 map reads.

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

Join, heading finalization, movement, complete recovery placement
and structural undo integration remain later cuts. In particular, the heading-name
`cappedText` rule for finalization, imported-layout movement and the remaining structural Stage 1
histories are still open here. Standalone flow results, application, features,
bootstrap, exports and browser behaviour remain unchanged.

## Beat removal and restore

`registerSharedRemovalHandlers(handle)` adds `remove` and `restore` to the same
entry. A remove records its writer, operation, author, original references, target
beats and physical segments, boundary membership, native observed character ids,
derived visual/gallery membership and optional comment observations. Its key uses
the existing identity format with role `removal`; a restore uses role `restore`.
Issued records are immutable. A per-beat `removals` map holds
`{generation, removed}` under the issued removal's native key. Existing `true`
membership means generation zero; malformed values and legacy `false` are inert.

Simultaneous removals of a visible beat have the same generation. One cancellation
in that generation restores their one effect, including an identical removal not
yet delivered. A fresh removal after a cancellation gets the next generation;
restoring an older generation cannot restore that fresh removal. A used-up restore
is an accepted no-op. Generation overflow refuses `removal-generation-limit`.
Restore writes cancellation membership and its own issued record. It inserts no
boundary, text, mark, segment or order entry, so the restored beat cannot be
mistaken for a repeated boundary and original anchors and native ids survive.

The structural interpreter masks removed beats after duplicate-id selection.
Typed anchors, text, marks, scalar and status preparation therefore refuse an
already removed target; a command issued before receiving the removal remains
accepted and its text stays on that beat in recovery. Restore has a named
`restore-membership` lookup for its exact stored target, never a text-writing
fallback. The same-list exception "text staged earlier in the same operation
list" also covers a beat staged earlier in that list: targets, boundaries,
observed flow ranges and later restore references share the creation alias map.

Rule 29 accepts the literal `r17` create/remove command. The two supplied buffer
fields pass `readSharedBufferRecoveryMetadata`: a stable nonempty source owner
and a nonnegative safe integer painted base. They are private creation metadata,
transferred to the removal record when removed, never row extras. Recovery exposes
all validated sources in an optional `buffer` array beside the row. Neither the
visible projection nor a restored row or export receives those fields. The base
is historical provenance, not a replacement for the entry's current painted base.
Full and incremental projection share this assembly. Provenance caches track each
beat's membership and each referenced record through the existing keyed read cache;
metadata-only corruption and membership deletion are compared with fresh snapshots.
Typing with zero or 299 unrelated recovery beats performs zero unrelated native
reads, with seven text and two mark-entry reads in either case.
Visual and gallery membership is derived from validated records, including all
staged gallery records and ordinary record creates or ownership changes earlier in
the list. Accepted record writes add their touched keys to the per-call scratch
plan; removal validates their current overlaid ownership, excluding deleted records
and those reassigned away. It scans neither attachment root. Caller component ids are checked observations, not authority;
empty observations and the flow emitter's logical attachment names are accepted.
The executor creates no undo entry; rule 29 is submitted without one by its caller.

The attachment index is activated while idle by handler registration and patches
changed ownership only; a full snapshot does not warm unused attachment ownership.
Preparation inspects touched beats, segments and attachments, never whole roots or
the order array. The count test measures 57 record reads and four text reads with
both zero and 10,000 unrelated beats and gallery entries, including four required
identity-absence queries. Descriptions are deeply frozen; apply only translates
fixed positions to ids for text created earlier in the transaction and writes the
prepared payload. There is one transaction and update, and no full-state encoding.

The copied T10 oracles check original and concurrent identities through removal
and restore; the test reader supplies removal caret fallback, which is not a new
production caret-placement claim. The seeded model has 72 histories, 900 operations,
144 checkpoints and 504 live/fresh index comparisons, including 36 restores before
peer delivery, with literal declared limits
`[]` for its beat-only cases. Complete app lists execute 42 operations in 18 calls
and skip or defer none: the three lists that remove across a scene boundary run
since heading removal (below). T08 creation (a beat turned into a heading, which is
finalization), the T09 cross-heading selection, T06/T12
join, imported-layout move and complete structural undo await their named cuts.
Split-descendant removal classification and comment/reply recovery placement (T11)
remain recovery work; retained observed ids, boundaries, attachment ids and author
are its inputs. No claim of that classification is made by this beat-only model.

## Heading removal and restore

`heading-remove` runs through the same removal handlers. It resolves the projected
heading and issues a `header` removal record with the beat removal's identity
format, immutability and generation rule (assumed rule 33). The flag
`{generation, removed}` is stored under `removal:<removal key>` on the heading
record itself: hydrated headings have no nested map, and two writers creating one
at once would lose a flag. The record's `at` is 0, since the operation carries no
row index. Observed name characters are kept as native identities.

A demotion (`newBeat`) is a heading split at offset 0 in the same transaction: the
name's characters, with their identities, become the new beat's narration and the
emptied heading is masked. Typing at the end of the name follows it into the new
beat, as in the copied T08 result. Typing at the very start of the name is ordered
against the boundary by writer id: from a writer whose id is lower than the
remover's it stays in the masked heading, and so in recovery. `nextBeat` is not
checked; the app's following scalar sets `paragraphStart`.

The structural interpreter and the projection both mask a removed heading. Typing
and a second removal refuse it with `missing-target` (tested); marks and scalars
resolve owners through the same interpreter. A
removed heading whose name still holds text is listed in recovery as
`removed-heading` with its section record; an empty one is not. Restore cancels
its own generation and unmasks the heading; it does not undo a demotion's split.
Projection and the structure index read each heading record once, for both its
fields and its removal state, so full-assembly read counts are unchanged.

A heading inside a joined row (the first projected beat after it is a later part
of a joined row) refuses the whole list with `joined-heading`, leaving bytes, state
vector and revision unchanged. Evidence: the copied T08 remove result under three
delivery orders and an encoded late joiner; discard and demotion literals against
concurrent typing in the name and in the following narration, with restore and an
incremental-versus-fresh projection comparison; a seeded model of 36 histories,
56 checkpoints and 144 commands with literal declared limits `[]`; and two removal
mutants. Heading finalization, movement and structural undo are not built.

## Heading creation

`registerSharedHeadingHandlers(handle)` adds `heading-create`, the operation the app
emits when pasted text carries scene headers. It accepts only the gap the flow
emits (no left neighbour, the first beat on the right, affinity `before`). The
heading key uses the existing identity format with role `heading`; it survives the
app's scene-id rule. The supplied heading name, and a different supplied segment
name, become aliases for later operations in the list. The heading record holds
`id` and `extra` as hydration writes them.

The heading goes directly before its first beat. When that beat heads its segment,
a new segment with head `{h:id}` and empty text (role `segment`) enters the order
before it. When the beat is inline, an `{h:id}` boundary goes before its boundary in
the same text, and the name lies between the two. The per-call structure plan
knows the planned heading, so the name insertion and scalars that follow resolve it.
A first beat that is a later part of a joined row refuses with `joined-heading`.

The executor entry gained one step: an accepted preparation may name a check that
runs after the whole list is prepared, still before any write. Heading creation
uses it for the name: at the end of the list the created heading's name must keep
some text under `cappedText(name, 200)`, the rule the app's scene loader applies.
A blank or missing name refuses the whole list with `invalid-heading-name`, leaving
bytes, state vector and revision unchanged. A heading removed later in the same
list is not checked. Declared limit: the operation reader turns a name of half a
surrogate pair into U+FFFD before the check, so that name is accepted and every
copy loads a scene the app itself would drop.

Two writers creating a heading before the same beat at once both keep their
headings; the lower writer id comes first. Its scene has no beats, so it appears in
recovery as `scene-with-no-beats`, and the other heading owns the beat. Before an
inline beat, text typed concurrently at the end of the previous beat is ordered
against the new boundary by writer id: from a writer whose id is higher than the
creator's it joins the new name. Text typed in the first beat itself stays there.
A concurrent join of the first beat into the beat before it depends on placement:
when the first beat heads its segment the join wins and the heading goes to recovery
as `scene-with-no-beats`; when it is inline the join has no effect and leaves no
recovery entry, and the heading owns the beat.

Evidence: complete paste lists from the app at seven places and four header shapes,
including selections across a scene boundary, executed under three delivery orders
with an encoded late joiner (84 calls, 588 operations, 105 creations, none skipped or
deferred), compared with the app's loaded rows and scenes and the independent
applier; literals for concurrent typing, split, removal and restore of the first
beat, simultaneous creation, removal and restore of a created heading, and the
refusals; a seeded model of 48 histories and 122 checkpoints with literal declared
limits `[]`; and two structure mutants. The copied T08 creation oracle is a beat
turned into a heading and waits for finalization.
