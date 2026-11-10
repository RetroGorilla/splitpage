# T21: identity keys, delta caches and strict output comparison

These are the whole-PR review's minimized failures at 2085cfc4; original evidence commit 8efcff79 remains unchanged.

## A key and its stored reference used different strings

Seed R1 with `a`. Call `addComment(writer, "\ud800", "R1", 0, 1, "Alice")`, then add a reply referencing that comment. Load a new replica from the writer's encoded state. The writer's comment key was the lone surrogate, while its projected anchor was U+FFFD: its comment read `recovery: true`. The loaded copy's key was U+FFFD and its comment read `recovery: false`; the reply inherited this split. The encoded state was identical.

Literal corrected result: comment key U+FFFD, `recovery: false`, and its reply attached on every copy. Commands normalize identity keys and references before writing. Readers also normalize keys from already stored records. The key property covers comments/replies, tags/people/shots, beats/segments/headings, visuals/gallery, removal records/flags, joins/retirements and status events/retirements. It includes two different lone surrogates and an explicit U+FFFD colliding as one wire key in either insertion order; native decoded Yjs conflict resolution selects the record, without inventing a product tie-break. Original Y.Text pointers are retained for character identities and caret resolution.

The expanded key property also exposed an empty-container difference: create comments keyed by `"\ud800"`, `"\ud801"`, `"\ufffd"`, then delete the first key. Encoded reload removes the colliding comments; the writer still has raw entries. Its normalized view must therefore consult native collision/deletion resolution, including tombstones, and omit `records` when both normalized comment and reply collections are empty. Written, deleted and recreated checkpoints now agree through the same strict comparison.

## Fresh and observing block deltas differed

Seed R1 `abcd`, attach incremental projections on two writers. Alice deletes b while Bob formats b bold. Synchronize and load a fresh copy. Observing block deltas were `[{insert:"acd",attributes:{}}]`; a fresh index held `[{insert:"a",attributes:{}},{insert:"cd",attributes:{}}]`.

Literal corrected result is `[{insert:"acd",attributes:{}}]` in both layouts, through all listed delivery variants and encoded reload. Fresh loads, patches and projected blocks share compaction: adjacent string runs merge only with equal own attributes, whose keys use UTF-16 order. The general generated histories also compare observing document/block caches with fresh ones. Status index fresh/observing comparisons and malformed-value block-cache comparisons use the strict checker too. Cache equality now distinguishes array lengths, holes, missing properties and property order.

## The checker silently discarded differences

Wrap `readStructure` so every copy returns `records.probe={}`, except one returns `{absent:undefined}`. Both `check` and `checkKnown` incorrectly passed. The same happened for `[]` versus `new Array(1)`. Additional controls cover a hole versus an explicit undefined item, an array's extra own property, different object-key order and an unsupported Date.

The prototype now copies the comparison from `tests/collab/agreement.ts`, without importing production-repository tests. It compares ordered own-key lists, array lengths and hole presence, array own properties, map/set entries and prototypes; unsupported output kinds fail. No generic JSON-shaped conversion runs before comparison. The old `isDeepStrictEqual` shortcut plus property-value walk and the generic conversion were inadequate: the earlier green result established the covered values and exceptions, not strict equality of complete JavaScript output shapes.

Strict reload testing additionally rejected a binary reply author (`Uint8Array([0,1])`, retained seed 1376, step 248), previously flattened to an ordinary object by the test conversion. A binary comment resolution had the same cause. These are unsupported record values, now absent under the common record validator; literal controls cover both. The strict pre-fix structure/marks/general rerun found no additional replica difference in those histories.

Checking other caches exposed a further strict difference. Import R1 `ab`, R2 `cd`, and section `{name:"Scene",firstSceneId:"R1",id:"H1"}` with that literal property order. Attach the incremental projection and insert x into R2. The observing section used keys `["id","name","firstSceneId"]`; a fresh projection retained `["name","firstSceneId","id"]`. Both had identical field values, so the old checker accepted them. Literal corrected keys are `["name","firstSceneId","id"]`, with first scene R1. Fresh and partial projections now share section assembly; partial projection receives all block positions for section placement while still rendering only dirty rows. Both layouts and the heading-key reload cases pass.
