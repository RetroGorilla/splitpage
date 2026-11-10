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
