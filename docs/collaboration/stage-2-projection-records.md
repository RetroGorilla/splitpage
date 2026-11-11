# Record projection rules

These extend [structure projection](stage-2-projection-structure.md). Core receives
validated gallery records and text units; it imports no adapter or shared-state
library. Full projection and its recovery variant read the same result without
changing bytes, state vector, revision or transaction/update counts.

## Answers and literal tests

Sources are [Stage 0 merged-state answers](stage-0/8-schema-hypotheses.md#projection-answers-for-merged-states-both-candidates).

| Case | Answer and source line | Status | Literal test |
| --- | --- | --- | --- |
| Picture folding | 107: “items with the same sha256 fold into the first”; “name and annotation are the first non-empty” | Existing standalone rule, assumed for sharing | `gallery folds duplicate pictures, first metadata and URL/file links like standalone` |
| Link folding | 107: “their links fold by videoLinkKey”; “the first link kept and poster and location filled from later ones” | Existing standalone rule, assumed for sharing | Same adapter test; `folded file links keep the first details and fill a missing location` |
| No picture | 107: “items with no picture never fold” | Existing standalone rule, assumed for sharing | `gallery items without pictures never fold` |
| Gallery order | 107: “(beat order, rank, itemId)”; 127: “Ties broken by record id” | Existing total ordering | `gallery uses merged beat order when the join root comes later`; `gallery ranks precede UTF-16 item ids, independent of writer` |
| Overflow | 124: “First 61 by (beat order, rank, itemId) shown; the rest listed in recovery, kept in state” | Assumed proposed policy | `gallery overflow shows the literal first 61 and recovers every later item`; `gallery folds before counting the 61-item limit` |
| Duplicate b-roll | 113: “First key in document order keeps the id; later ones are unanchored in the shot list until an explicit command assigns a new id” | Assumed; product decisions question 9 | `duplicate b-roll keeps the first marker, derives later safe ids and creates no shot records` |

Folding uses the standalone `joinedPictures` algorithm (`flow.ts:536–554`), before
the 61-slot cap. The slot count includes video-only gallery entries, as the
standalone join's `pictures.length` check does at line 573. Neutral null-picture
import placeholders are omitted as `rowSlots` does. An overflow entry retains the
folded slot, source item id and beat, associated with the join root; it also stays
with a removed group in recovery. No stored item is rewritten or removed.
Core sorts each beat's records itself by rank and UTF-16 item id. An annotation
without marks is empty, as the standalone slot reader at `gallery.ts:446–450`
defines; it does not hide a later typed annotation.

Core supports filling a missing link location. The existing adapter validator
intentionally rejects link location fields in shared records, so location
fill has a pure literal test; the adapter tests exercise URL/file keys and poster
fill. The existing privacy exclusion and its reference round-trip exception stay
unchanged. Extra link fields remain on the first link.

## B-roll identity mechanism

Document order is row order, visual text then narration (the existing field order
in `production/tags.ts:23` and `commands/clipboard.ts:148`), and text order inside
each cell. Visual components retain their existing rank/id ordering. Removed
groups do not claim visible keys. The first marker retains its stored id.

A later marker gets `broll_<UTF-16 hex of original id>_<native client>_<native clock>`.
Reserve every real marker id and stored shot id before allocating any derived
id; append underscores until unused. The result survives `normalizeCell`'s
`[A-Za-z0-9_-]` restriction, including a real key that appears later in the script.
Pure callers without native identities use the stable cell key and unit position
instead. Native identities are read from the atom's existing item; none is minted
or written. The marker's words and marks remain unchanged, and projection does
not create, clone or relink a shot record. Later markers therefore have no record
link to the earlier marker's shot. The 291-document corpus has zero doubled ids.

## Seeded histories and limits

| Generator | Asserted coverage | Literal declared limits |
| --- | --- | --- |
| Gallery | 24 seeds, two/three writers, single/joined/removed groups, fold and overflow, create/set/delete/rank/link changes; 576 checkpoints and 9,072 entry commands | None |
| B-roll | 24 seeds, two/three writers, both fields and a same-row column case, insert/delete/mark/scalar/status changes and reserved-id collisions; 432 checkpoints and 2,808 entry commands | None |

Both use normal, reversed and duplicated delivery plus an encoded late joiner.
Expected documents and recovery are literal data; readers compare canonical saves
and strict key presence/order and array holes. Joins and removals are direct
monitored-constructor states because their executors are a separate lane. The
gallery oracle compares the same plain beats with the standalone join. The pure
rules also run on deeply frozen inputs.

## Calling the rules from a per-change projector

`projectSharedJoinedFields(root, members, gallery)` now returns `{row, overflow}`.
Supply the current field-projected root row, current per-beat field projections
in merged row order, and all validated keyed gallery records. It resolves group
status and calls `projectSharedGroupGallery` internally. The gallery-only function
has the same inputs, preserves the supplied status and returns the same shape.
The root's gallery fields must come from the same snapshot as those records;
single-beat galleries without a fold or overflow preserve that field projection.

`projectSharedBrollKeys(cells, shotIds)` needs every visible cell in document
order, with stable cell keys, native atom identities and marks, plus every stored
shot id. It returns rewritten units by cell key. A changed cell alone is not
enough: the first occurrence and reserved ids are document-wide. Keep the native
`identity` supplied by `readProjectionUnits` when caching or splicing units.
Both rules have only local scratch maps/sets and change none of their inputs.

## Assumed, for the product owner

- Duplicate pictures appear once, with the first available name and annotation and their combined links.
- A gallery shows its first 61 entries and keeps later entries in recovery.
- A repeated b-roll marker keeps its words and formatting without reusing the earlier marker's shot assignment.
- If the same marker appears in both columns of a beat, the visual column keeps the original assignment.

Semantic undo, record recovery outside a beat group, the other merged-domain
limits, incremental projection and caching remain separate packages. The rule
does not impose the standalone link/poster limits on a newly merged gallery.
