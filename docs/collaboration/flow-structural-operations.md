# Structural flow operation descriptions

Stage 2 package 4a describes structural edits beside the existing `FlowEdit.rows` result. No session caller requests operations yet. Standalone continues committing rows.

## Request and lifetime

Pass `operations: { id, by }` in `FlowPorts`. The caller supplies one command id and author. Each covered entry creates one local trace, calls the existing implementation with recording enabled, and returns `ops` on an edit. Refusals, moves and null outcomes retain their original shape. Operation ids are the command id plus a colon and the operation's zero-based index. Nested calls share the trace; they do not allocate another command.

The manual comparison shows recording-off results equal the pre-change commit's results for the generated calls. By reading, the emission code is behind the request check and optional-call guards; there is no allocation assertion or timing measurement. The ten entry points gain a request branch. Emission guards also occur in `replaceRange` (only recorded when used by a covered structural command), `splitBeat`, `blankAfter`, `blankBefore`, `enterAtCaret`, `removeHeader`, `removeRow` and `withoutMarker`. `removeRow` gains a ports argument. `removeEmptyHeading` moves its pure edit and landing policy from the Writer surface into its own core module, adding that call on its existing surface path. These are typing-path changes.

## Base references

`flowBaseReference(owner, field, from, to = from)` encodes the tuple `["flow-base", owner, field, from, to]` as JSON inside `SharedContentRef`. Offsets are UTF-16 code units in the input text projection, with atoms occupying one unit. A position has equal endpoints; an observed range is half-open. `field` distinguishes narration, visuals and heading names. JSON encoding separates arbitrary ids and delimiters without ambiguity. `readFlowBaseReference` rejects malformed tuples.

Beat, heading and segment identities in these standalone descriptions use their document ids. New beats and headings retain exactly the ids returned by the flow id port; recording consumes no additional ids. Text addresses use that owner id as the initial segment id. Removal component and gallery references identify the removed beat's visual and gallery origins with `:visual` and `:gallery` suffixes. A shared adapter must map these descriptions against the captured base before applying them; these references are not CRDT identities or a wire protocol for arbitrary replicas.

Text gaps put the base position in `right`, with `left: null` and `affinity: "before"`. Deletions and heading name/prefix/separator observations contain base ranges. The trace maps offsets through earlier selection deletions, so a subsequent Enter split still refers to the original base. Insertion precedes deletion of observed content. Paragraph flag changes and surviving heading anchor repairs are scalar operations after the intent operations. Row/heading creation carries initial fields; heading finalization references the retained or reusable first beat, and separately describes any new blank or soft removal.

Heading insertion and deletion retain the raw UTF-16 offsets used by `String.slice`; narration keeps its surrogate-aware clamping. The reference applier reads, inserts and rebuilds heading text as raw UTF-16 units, while narration remains normalized. Finalization retains the existing scene-name acceptance rule: a name made only of a lone surrogate is rejected, while direct heading edits can retain one.

## Coverage and proof

The covered fixture rows are `enterAt`, `startParagraph`, `startBeat`, `lineBreakAt`, `backspaceAt`, `deleteForwardAt`, `joinWithPrevious`, `enterInHeading`, `finalizeHeading` and `removeEmptyHeading`. Their operation-kind lists are unchanged. The scalar branch descriptions now explicitly include surviving heading anchor repairs where applicable.

`tests/core/flow/operation-applier.ts` interprets these descriptions without calling flow functions. It retains base provenance while inserting/deleting characters, splits text, folds join visuals/gallery/status independently, and derives removed comments from range-removal observations and surviving anchors. It uses shared low-level text serialization and gallery normalization policy. The differential test compares complete rows, sections and removed comments, checks wire validation and distinct operation ids, and requires exact agreement with each fixture row's kind set.

Generators are evaluated directly from the unchanged fuzz/reference suite source blocks: fuzz seeds 1–240, reference seeds 1–300 and all six selected ranges, typing's 160-step seed-371 stream, and round-four's 120 gallery cases. Additional heading cases exercise fallback, retained visuals/tails, reused followers, existing headers, UTF-16 edges and explicit finalization offsets. Failures report the seed, function and a reduced input preserving referenced targets.

The differential harness makes 125,143 calls, of which 52,323 produce changing edits; most other calls return early. An edit changes something when its rows or sections differ by deep equality from the input, or its removed-comment list is nonempty. Each function asserts the changing-edit floor below so losing meaningful generator coverage fails. The surrogate matrix places a pair after four prefixes and exercises both selection endpoints, both directions, interior carets, heading edges and finalization offsets for the covered functions. It includes the review's single-beat `A😀B` line-break selection `[2,3)` and heading split at offset 2. Two additional same-id calls remain in a separate regression test.

| Function | Calls | Changing edits | Asserted floor |
| --- | ---: | ---: | ---: |
| enterAt | 11,307 | 11,083 | 11,000 |
| startParagraph | 11,307 | 9,043 | 9,000 |
| startBeat | 11,307 | 5,304 | 5,300 |
| lineBreakAt | 11,308 | 11,208 | 11,100 |
| backspaceAt | 22,602 | 5,139 | 5,100 |
| deleteForwardAt | 11,315 | 2,192 | 2,100 |
| joinWithPrevious | 11,427 | 5,120 | 5,100 |
| enterInHeading | 11,316 | 979 | 950 |
| finalizeHeading | 11,947 | 820 | 800 |
| removeEmptyHeading | 11,307 | 1,435 | 1,400 |

Run `node tests/core/flow/standalone-proof.mjs 0c2f43a4` by hand to compare the generated recording-off calls with the pre-change flow implementation and original surface's empty-heading callback. The named base commit must be present locally; the script is not part of CI. It creates two temporary modules, removes them in `finally`, and must run separately from inventory checks. It edits no existing suite and stores no golden or source snapshot.

## Shared-mode questions retained

These descriptions preserve standalone behavior without deciding its concurrent interpretation: synthetic blank beats for orphan headings/empty scripts; demotion of a heading into a new narration beat; paragraph/header anchor repairs; join gallery deduplication and saved-limit normalization; comment records reported by whole-range removal versus retained records on boundary removals; and formatting loss when narration becomes a plain heading name. An artificial finalization offset inside a surrogate pair can put a lone surrogate in a heading name while retaining the complete pair in narration. The description preserves both observations; choosing a different shared-mode result requires a product decision.

## Package 4b: range operations

The remaining fixture rows are accounted for below. The first commit moves only the pure replacement loop from Writer's flow-find module to core/find-replace; Writer keeps search, ordering and highlighting. Every importer now names the new module directly. The move changes no behavior. Recording is added in the following commit.

| Remaining fixture row | Coverage here |
| --- | --- |
| replaceRange | Covered as its own entry, including removeWholeStart |
| typeWithMarks | Covered, with explicit insertion attributes |
| pasteText | Covered, including line breaks and multiple/empty paragraphs |
| pasteFlowRange | Covered, including supplied identities, rich runs, headers and placeholders |
| replaceFlowMatches | Covered, including visuals and heading removal |
| replaceAll | Covered, including reverse replacement and heading removal |
| setMarkAcross | Covered, including mixed formatting and identity-bearing marks |
| setVisualForRange | Covered; existing visual HTML remains an explicit whole-field observation for package 9 |
| selectionToOwnBeat | Covered, including prefix, interior and suffix isolation |
| insertBeats | Covered, including visual/gallery origins and heading splits |
| moveBeats | Covered for the complete visible rows this API accepts |
| sentenceParagraphs | Covered; its array result gains an ops property only when requested |
| renameHeading | Not covered: its whole-field input has already lost intent; package 9 owns the captured-base seam |
| inlineMarkdown | Not covered: the surface owns the document base, live-cell recheck and pending mark; the cell-only helper has no document address or FlowPorts |

No operation kind is added. Two optional vocabulary fields preserve observations needed by composition: a range removal can carry comments observed as removed during that step, and a b-roll insertion can carry its displayed text beside its identity. Both fields pass the operation reader. A subsequent paste can reintroduce the same anchor without changing the clearing step's removedComments result. These observations do not implement shared recovery policy or registry creation.

The trace now retains owner, field and UTF-16 position per observed unit through insertions, deletions and splits. Consecutive references are compacted; inserted units refer to their producing operation. Heading provenance remains heading provenance when its tail becomes narration. Narration replacement separately clamps the deletion and the insertion into the remaining cell, matching the app. Headings continue to use raw UTF-16 offsets. By reading, recording consumes no additional ids.

Marks carry kind, identity where present, value and observed ranges, emitted per beat in document order. Formatting records the requested on/off intent; identity-bearing changes retain the relevant comment/tag/link ids. A no-effect identity-mark attempt can still canonicalize a touched cell's HTML; a scalar audioText observation preserves that representation change without inventing an unrelated mark intent. Its concurrent interpretation is left to shared integration. The interpreter uses text serialization/normalization but no flow implementation or helper. Its atom formatting exclusions and tag-stack updates reproduce the low-level text policy. Visual creation carries initial HTML; replacing an existing visual uses record-set html. That whole-field value is deliberately not claimed as concurrent text intent.

Fixture corrections, demonstrated by the exact kind checks:

- setMarkAcross includes scalar for a no-effect identity-mark attempt that canonicalizes the stored HTML.
- pasteFlowRange does not create registries/comments, restore cut records or move source segments; those are clipboard-caller responsibilities. Its row now lists only the kinds this flow entry emits.
- setVisualForRange includes record-set for existing visual HTML and text-insert for overlapping surrogate slices; its package 9 handoff remains explicit.
- selectionToOwnBeat includes text-insert for overlapping surrogate slices.
- moveBeats includes heading-remove when detaching the last source-scene anchor, and describes moved-row normalization under scalar.

The two-sided kind assertion compares emitted kinds with the fixture's operation-kind union. The literal package 9 handoff and partial-segment-move refusal are policy markers, not operation kinds, and are excluded from that comparison. The separate vocabulary coverage suite still checks the complete branch union, including those markers.

### Package 4b evidence

The added differential test evaluates the unchanged source generators: fuzz seeds 1-240, reference seeds 1-300 with their six ranges, typing's 160-step seed-371 stream and round-four's 120 gallery cases. It adds a bidirectional surrogate matrix for beat/heading range endpoints, rich pasted text with comments, nested tags, links, line breaks, direction/cue marks and atoms, ten mark-name cases, three all-on identity clears, two supplied-original-id cases, two raw-surrogate pasted headings and empty-heading replacement. Each edit compares complete rows, sections and removedComments, checks recording-off equality, source immutability, wire validity and distinct operation ids. A mismatch reports the seed and a row-reduced input. Counts and changing-edit floors are asserted.

| Function | Calls | Changing edits | Asserted floor |
| --- | ---: | ---: | ---: |
| replaceRange | 2,402 | 2,364 | 2,360 |
| typeWithMarks | 2,402 | 1,563 | 1,560 |
| pasteText | 2,402 | 2,364 | 2,360 |
| pasteFlowRange | 2,405 | 2,403 | 2,400 |
| replaceFlowMatches | 2,482 | 1,121 | 1,120 |
| replaceAll | 2,402 | 931 | 930 |
| setMarkAcross | 2,415 | 1,596 | 1,590 |
| setVisualForRange | 2,402 | 508 | 500 |
| selectionToOwnBeat | 2,402 | 230 | 230 |
| insertBeats | 2,403 | 1,603 | 1,600 |
| moveBeats | 2,402 | 1,635 | 1,630 |
| sentenceParagraphs | 2,402 | 401 | 400 |

This is 28,921 added calls and 16,719 changing edits, with zero mismatches. The unchanged 4a test retains its 125,143 calls and 52,323 changing edits. Run node tests/core/flow/standalone-proof.mjs c2e6c55c by hand to compare the recording-off results with the package 4a starting commit, including the original feature-owned replacement loop. The proof runs the same asserted call inventory and removes its temporary modules in finally. Run it separately from inventory checks.

By reading, the added request branches are in replaceRange, typeWithMarks, pasteText, pasteFlowRange, replaceMatch, replaceAll, replaceFlowMatches, setMarkAcross, setVisualForRange, selectionToOwnBeat, insertBeats, moveBeats and sentenceParagraphs. The keystroke path gains branches in replaceRange/typeWithMarks and optional trace calls in their text edits; the existing splitBeat and enterInHeading recording calls now use the provenance-aware split method. The pure find replacement call moves into core. No allocation or performance claim is made; the coordinator owns timings. Undo and save owners are untouched.

### Package 4b cases left to shared integration

The tests preserve the standalone duplication of a surrogate pair when independently clamped isolation slices overlap. They preserve removal reports from the clearing phase even if paste reintroduces an anchor, and preserve the loss of a heading when its last source beat moves. Existing visual replacement still supplies whole HTML, moving a row can normalize its fields, and a no-effect mark attempt can canonicalize HTML; these descriptions expose those facts without selecting new concurrent behavior.

By reading, moveBeats takes row ids, never a source text range: every emitted move covers complete visible rows. A visible row may represent only part of an underlying stable segment after projection. FlowPorts has no segment-membership map, so only the shared adapter can classify that source as a whole segment or a refused partial-segment move. This package does not turn a partial segment into a legal shared move. Similarly, pasteFlowRange receives prepared rows, not structural-cut provenance or a cut-consumption port; cross-scene structural cut/paste remains a caller/adapter refusal. No such refusal is claimed as exercised by this flow test.
