# Stage 1a feasibility decision

## Result

Stage 1a **exits with the listed carry-overs** on merged evidence through `c498f71991e68ea36387c613726c43b657f39b1f`: M1 is the buffer mechanism, B is the schema, and shared undo uses explicit per-writer command records. The status and reader fixes close the draft's convergence blockers within the retained tests; production acceptance remains subject to the later gates. [Exit condition][exit], [product decisions][product-decisions], [status results][status-results], [reader results][reader-results], [undo results][undo-results].

Split T03, imported-layout movement, the declared undo limits and a timing rerun carry to Stage 2 under the coordinator, tracked in [#1414][stage2]. These are carry-overs, not passing results; the table below names the evidence and remaining work. [Split result][split-stale], [reader bounds][reader-bounds], [undo limits][undo-limits], [status timing bounds][status-timings].

## Exit criteria and deliverable

The criteria below are the Stage 1a row in plan section 11, with the editing-trace clause separated so its bounds remain visible. [Plan section 11][exit].

| Exit criterion | Assessment | Merged evidence |
| --- | --- | --- |
| Checker fails on a lost remote character before endorsement | Met for the named defect | [harness.test.ts][harness], [lost-character history][lost], [#1385][1385] |
| Checker fails on a duplicated identity before endorsement | Met for restoration and join injections | [harness.test.ts][harness], [restore history][restore-copy], [join history][join-copy], [#1385][1385] |
| Checker fails on an omitted field before endorsement | Met for the named serialization injection | [harness.test.ts][harness], [omitted-field history][omitted], [#1385][1385] |
| Editing traces in section 13 pass | Retained feasibility fixtures pass with the explicit carry-overs below; not met on the real Split surface for T03 | [Trace table](#trace-table), [status repair][status-results], [reader repair][reader-results], [command-record undo][undo-results]. Coordinator owns Stage 2 carry-overs under [#1414][stage2] |
| A buffer mechanism is selected | Met: M1 | [Product decision][product-decisions], [buffer][buffer], [B surfaces][b-surfaces], [Split reconciliation][split-reconcile] |
| A schema is selected, or the design returns for revision | Met: B, within recorded capacity bounds | [Product decision][product-decisions], [growth and limits][lifetime], [status repair][status-results], [reader repair][reader-results] |

The deliverable's independent identity model, deterministic queue and encoded late joiner are in the [harness][harness] and [#1385][1385]. The [buffer report][buffer] records the composition-first stale-base experiment; [slice][slice], [app binding][app], [B surfaces][b-surfaces] and [Split reconciliation][split-reconcile] supply the throwaway real-editor evidence without a server. Structural recovery and command undo have separate literal fixtures. [Structure][structure], [undo results][undo-results].

## Checker

The checker compares literal identities, characters, marks, carets, selections, records and recovery against independently written expectations. Its field-declaration inventory is not a substitute for behavioral assertions. [Harness][harness], [projection results][proj], [#1385][1385].

| Deliberate defect | Rejecting test and retained history |
| --- | --- |
| Lost remote character | `checker rejects Lost remote character (T01 D3 M2)` in [harness.test.ts][harness]; whole-beat reconciliation loses X. [History][lost] |
| Stale base | `checker rejects Stale base (T01 D3 M2)` in [harness.test.ts][harness]; newer offsets delete X instead of the observed content. [History][stale] |
| Duplicated identity on restoration | `checker rejects Duplicated identity (T10 D1 late-C)` in [harness.test.ts][harness]; copying retained content produces `cdcXd`. [History][restore-copy] |
| Duplicated identity on join | `checker rejects Duplicated identity (join) (T06 D1 narration probe)` in [harness.test.ts][harness]. [History][join-copy] |
| Omitted field | `checker rejects Omitted field (PROJ serialization)` in [harness.test.ts][harness]; serialization loses literal `lengthSeconds: 12`. [History][omitted] |
| Lost comment mark | `checker rejects Lost mark (T11 step 1 D1)` in [harness.test.ts][harness]; one shared key loses an overlapping comment. [History][lost-comment] |
| Lost tag mark | Single-tag negative probes in [marks.test.ts][mark-tests] reject the missing nested stack. [A history][lost-tag-a], [B history][lost-tag-b] |

The original status reader remains a deliberate defect: the independent literal checker reproduces its 80/96 disagreements, while the repaired original matrix passes 96/96 through five readers. The status fixtures cover retirement, deeper branches, semantic undo, reversed/duplicate delivery and encoded late joiners. [Status results][status-results], [#1413][1413].

The reader checks compare complete outputs strictly, including key order, missing properties, sparse arrays, extra properties, unsupported kinds and accessor indices. The report records 1,708 inspections, 45,080 projections and 35,854 comparisons; these are finite executions, not a proof about arbitrary stored state. [Reader results][reader-results], [strict comparison][strict-comparison].

## Trace table

The original structural and mark rows below retain their report's library-backed undo scope; [command-record results][undo-results] separately re-run the retained families without the library's undo stack. A schema-only pass is not a real-editor pass. D1 is concurrent exchange, D2 delivery before the next writer acts, D3 delivery during the buffered interval, dup duplicate delivery, rev reverse delivery, and late-C an encoded-state third-replica join. [Stage 0 definitions][hypotheses], [buffer][buffer], [structure][structure], [marks][marks].

| Trace | Result under B with M1 | Others, in brief | PR | Result file |
| --- | --- | --- | --- | --- |
| T01 | Simulation, Writer, page and Split PASS 5/5 each: D1, D3, dup, rev, late-C | A/B simulation and Writer/page also pass M2/M3; Split runs M1 only | [#1387][1387], [#1407][1407], [#1410][1410] | [buffer][buffer], [B counts][b-counts], [Split reconciliation][split-reconcile] |
| T01 composition | Simulation, Writer, page and Split PASS 5/5 each: same orders | A/B simulation and Writer/page also pass M2/M3 | [#1387][1387], [#1407][1407], [#1410][1410] | [buffer][buffer], [B counts][b-counts], [Split reconciliation][split-reconcile] |
| T02 | Simulation, Writer, page and Split PASS 3/3 each: D3, dup, late-C; Split keeps X genuinely unpainted at input | A/B simulation and Writer/page also pass M2/M3; parent Split 0/3 is superseded | [#1387][1387], [#1407][1407], [#1412][1412] | [buffer][buffer], [B counts][b-counts], [Split stale base][split-stale] |
| T02 boundary | Simulation, Writer, page and Split PASS 1/1 each: D3 | Writer tests real run-on sentinel; page lacks it; Split uses its own cells | [#1387][1387], [#1407][1407], [#1412][1412] | [buffer][buffer], [B surfaces][b-surfaces], [Split stale base][split-stale] |
| T03 | Simulation, Writer and page PASS 2/2 each: D1, D3; Split FAIL 0/2 before remote formatting | A/B simulation and Writer/page pass M2/M3; all fail the no-target-evidence probe | [#1387][1387], [#1407][1407], [#1412][1412] | [buffer][buffer], [B counts][b-counts], [Split stale base][split-stale] |
| T03 replace | Simulation, Writer and page PASS 3/3 each: D1, D3, dup; Split NOT RUN after T03 stop | A/B simulation and Writer/page pass M2/M3; replacement supplement also passes | [#1390][1390], [#1407][1407], [#1412][1412] | [buffer][buffer], [B counts][b-counts], [Split stale base][split-stale] |
| T04 | Simulation, Writer, page and Split PASS 3/3 each: D3, dup, late-C | A/B simulation and Writer/page pass M2/M3; original Split 0/3 was harness repaint recursion | [#1387][1387], [#1407][1407], [#1410][1410] | [buffer][buffer], [B counts][b-counts], [Split reconciliation][split-reconcile] |
| T04 removed | Simulation, Writer, page and Split PASS 2/2 each: D3, late-C | A/B simulation and Writer/page pass M2/M3; original Split 0/2 was harness repaint recursion | [#1387][1387], [#1407][1407], [#1410][1410] | [buffer][buffer], [B counts][b-counts], [Split reconciliation][split-reconcile] |
| T05 | Not combined; B only PASS 8/8: D1, dup, rev, late-C, both client-id orders | A same; swapping ids changes the split side | [#1385][1385] | [PR result table][1385] |
| T05 two splits | Not combined; B only PASS 4/4: D1, dup, rev, late-C | A same; both breaks remain visible | [#1388][1388] | [structure][structure] |
| T06 | Not combined; B only PASS 4/4: D1, dup, rev, late-C, with semantic join undo | A same; plain per-writer undo fails both | [#1388][1388] | [structure][structure] |
| T07 | Not combined; B only PASS 4/4: D1, D3, dup, late-C | A same; concurrent second-visual edit survives join/undo | [#1388][1388] | [structure][structure] |
| T08 remove | Not combined; B only PASS 4/4: D1, D3, dup, late-C | A same | [#1388][1388] | [structure][structure] |
| T08 create | Not combined; B only PASS 4/4: D1, D3, dup, late-C | A same | [#1388][1388] | [structure][structure] |
| T08 race | Not combined; B only PASS 3/3: D1, dup, late-C | A same; duplicate beat boundary is inert | [#1388][1388] | [structure][structure] |
| T09 | Not combined; B only PASS 4/4: D1, D3, dup, late-C | A same; captured selection and observed identities used | [#1388][1388] | [structure][structure] |
| T09 header | Not combined; B only PASS 2/2: D1, D3 | A same | [#1388][1388] | [structure][structure] |
| T10 | Not combined; B only PASS 4/4: D1, dup, rev, late-C | A same; soft removal retains remote work through restore | [#1388][1388] | [structure][structure] |
| T11 | Not combined; initialized B only PASS 3/3: D1, dup, late-C | Initialized A same; four deliberately lazy A root controls fail | [#1391][1391] | [marks][marks] |
| T12 | Not combined; B only PASS 3/3: D2, dup, late-C | A same; split undo/redo preserves remote work | [#1388][1388] | [structure][structure] |
| T12 join | Not combined; B only PASS 1/1: D2 | A same; semantic undo also handles rewritten glue in separate probes | [#1388][1388] | [structure][structure] |
| T20 nest | Not combined; B only PASS 3/3: D1, dup, late-C | A same | [#1391][1391] | [marks][marks] |
| T20 cross | Not combined; B only PASS 4/4: D1, dup, rev, late-C | A same; rejected crossing occurrence goes to recovery | [#1391][1391] | [marks][marks] |
| T20 mark | Not combined; B only PASS 2/2: D1, D3 | A same; whole-tag comment/link projection, stored membership checked separately | [#1391][1391] | [marks][marks] |
| T21 | Not combined; B only PASS 3/3: D1, D3, late-C | A same in mark lane; A/M2 composed-text bold fails the follow-up requirement | [#1391][1391], [#1399][1399] | [marks][marks], [follow-up][follow] |
| T21 comment | Not combined; B only PASS 2/2: D2, late-C | A same; orphan reply recovery and redo checked | [#1391][1391] | [marks][marks] |
| T21 scalar | Original four-event matrix repaired: PASS 96/96 through five readers | Partial ancestry and status redo remain qualified below; command-record retained fixtures pass | [#1413][1413], [#1418][1418], [#1421][1421] | [status results][status-results], [undo results][undo-results] |
| MOVE concurrent | Not combined; B only PASS 3/3: D1, dup, late-C | A passes refusal oracle, not movement | [#1388][1388] | [structure][structure] |
| MOVE destination | Not combined; B only PASS 4/4: D1, D3, dup, late-C | A refuses movement before mutation | [#1388][1388] | [structure][structure] |
| MOVE delete | Not combined; B only PASS 2/2: D1, late-C | A refuses movement; removal/recovery still checked | [#1388][1388] | [structure][structure] |
| MOVE cut-paste | Not combined; B only PASS refusal, no delivery | A also refuses before content changes or consuming cut | [#1388][1388] | [structure][structure] |
| PROJ | B only: PASS 291/291 outside one exact device-local exclusion; 290/291 exact direct-app-save bytes, all 96 mappings | A same; original-byte 7/291 reflects app rewriting, not projection loss; merged limits remain unresolved | [#1406][1406] | [lossless projection][lossless], [exclusion][exclusions] |
| SLICE | B/M1 Writer/page 24/24 each; Writer follow-up 23 positive composition passes; Split passes T04/T01 in #1410 and T02 in #1412, fails T03 | B Writer/page also run M2/M3 (72/72 each overall); M2 mapper/bold limits recur; re-entry controls separate | [#1407][1407], [#1410][1410], [#1412][1412] | [B surfaces][b-surfaces], [Split reconciliation][split-reconcile], [Split stale base][split-stale] |
| PERF | Growth and capacity recorded; elapsed-time rows are stale for the merged code | One rerun owed as part of the Stage 2 standalone and shared baseline | [#1413][1413], [#1421][1421] | [lifetime][lifetime], [status timing bounds][status-timings], [reader results][reader-results] |

The prototype reports do not combine T05?T12, T20, T21 and MOVE with the real editor buffer, nor full PROJ/PERF with the app. Split replacement stopped after T03; visual/heading input and app annotation rendering remain unbound. [B surfaces][b-surfaces], [Split stale base][split-stale], [structure][structure], [marks][marks], [projection][proj], [performance][perf].

## Decisions

### 1. M1 buffer

The product owner selected M1: hold remote changes while typing or composing, commit the local intent against its painted base, then apply the held changes and reconcile. B/M1 has Writer/page and both-surface T04 evidence; Split T03 remains the binding failure listed above. [Product decisions][product-decisions], [buffer][buffer], [B surfaces][b-surfaces], [Split reconciliation][split-reconcile], [Split stale base][split-stale].

M2's retained mapper misplaces composed text after a preceding split and leaves new text plain under remote bold. M3 passes the named composition cases but adds another document and coordinated persistence, whose extra cost is unmeasured. [Composition follow-up][follow], [B surfaces][b-surfaces], [buffer][buffer].

A direct provider receiver bypasses the M1 hold; production ingress must obey one gate. Overflow retention, cancellation, crash-safe continuation, complete annotation binding and undo-hold integration remain production work. [Provider-bypass history][provider-bypass], [overflow history][overflow], [app binding][app], [B surfaces][b-surfaces].

### 2. B schema and shared readers

The product owner selected stable segments and whole-beat movement, with part-beat movement and cross-scene structural cut/paste refused in shared mode. Growth is recorded for bounded workloads; this does not establish an unlimited writing lifetime. [Product decisions][product-decisions], [structure][structure], [lifetime][lifetime].

The writing-shaped scenario retains 67,095/67,096 bytes after one completed block and 591,971/585,436 after ten blocks for two/six writers. Its first crossing of the 2,097,152-byte cap is in block 36; sensitivity crossings are 36/31/34/26/36 for baseline/double status/double corrections/double removals/double revised beats. These are fixture frequencies, not measured human writing rates. Retention and capacity rules belong to the Stage 2 recovery model and Stage 3 durable limits. [Lifetime][lifetime], [counts][lifetime-counts], [sensitivity][lifetime-sensitivity], [stage definitions][exit].

#1413 replaces the order-dependent status fallback with causal-frontier resolution: agreeing values apply; disagreement resolves the common causal ancestors, falling back to the stored beat status when absent. A retired event contributes its parents' resolution. Status readers, the index, notices and undo consume the same `readStatusEvent` validator; outgoing status commands and redo validate before writing. [Status results][status-results], [undo results][undo-results], [#1413][1413].

#1421 repairs removal attribution, visual order, record validation, identity/key normalization and output key order. Fresh document blocks, the observing index and structural spans use `assembleReaderBlocks`. The valid-command generators cover 352 histories and 2,656 checkpoints; wrong-shape values, identity keys and later fields have separate finite properties. The report records agreement within those cases, including writer-versus-encoded-reload reads. [Reader results][reader-results], [#1421][1421].

The reader result does not prove agreement for arbitrary stored records, complete schema validation, arbitrary serializer cloning or production cost; three review rounds each found a further case. Movement works in the seeded layout, but `moveBeat` expects `seg-<beat>` while import creates `seg-b-<beat>`: imported movement throws `Expected a shared map` before writing. Identity normalization does not fix that naming assumption. [Reader bounds][reader-bounds], [imported-move history][imported-move].

PROJ retains stored U+200B, cue flags, historical capture metadata and unknown JSON. Only the two pinned device-local `location` values in `supplement.splitpage` are excluded; real-editor provenance must distinguish stored characters from presentation-only caret padding. Merged overflow/uniqueness, competing headings/posters and edits within opaque groups remain unresolved. [Lossless projection][lossless], [exclusion code][exclusions], [projection limits][proj].

### 3. Explicit per-writer command undo

Select command records containing character identities and shared record ids, reversed as a new local transaction. This path calls no library undo/redo; the inherited M1 constructor still creates an unused manager that is destroyed, and deliberate library probes remain separate. The report records 53/53 retained families passing in 360/360 runs, 20/20 new case rows and 300 seeded histories. [Undo results][undo-results], [#1418][1418], [reader reconciliation][reader-results].

The bound experiment keeps 200 entries per writer and releases older local records; it does not authorize deleting shared restoration, retirement, removal or status information that retained histories may name. Command recording occurs after the transaction, leaving a crash/re-entry gap. Typing groups, redo parking and save holds are not implemented by this prototype. [Undo results][undo-results].

The report declares seven limits after #1421; the following list retains that scope rather than treating their reproductions as passes. [Undo limits][undo-limits], [reader reconciliation][reader-results].

| Declared limit | Report owner | Evidence |
| --- | --- | --- |
| Concurrent undos of one doubly deleted character restore it twice | Undo | [Undo limits][undo-limits] |
| A format undo overwrites the other writer's later formatting of the same characters | Undo | [Undo limits][undo-limits] |
| Recovery lists a character undone and redone inside a removed beat as edited after the removal | Reader | [Undo limits][undo-limits] |
| A writer's second status undo changes nothing under the retained status rule | Status rule | [Undo limits][undo-limits] |
| Redo of a status change that had not applied because of a conflict makes it apply | Status rule | [Undo limits][undo-limits] |
| A redone tag or comment highlight is lost when the writer's undo and redo updates arrive in reverse | Library formatting | [Undo limits][undo-limits] |
| A replica holding one writer's later update before the earlier one cannot be read until the earlier one arrives | Delivery | [Undo limits][undo-limits] |

The generator accepts a violation only against literal declared-limit predicates; an unmatched violation fails. It does not act on a replica with a pending out-of-order update. Dedicated histories reproduce the limits even when the finite generator matrix does not reach them. The command layer still has direct shared-state accesses outside the malformed-record properties. [Undo results][undo-results], [reader shared-state audit][reader-results].

## Decided and assumed product answers

The Stage 0 product decisions remain the source for decided outcomes: prior status for conflicting concurrent changes, identical changes undoable by either writer, recovery for edits to removed beats, both concurrent breaks visible, author-owned comment text, pending images, M1, B and export-only script revision stamps. Deeper status branches and the recovery rules below remain assumptions, not additional product-owner decisions. [Product decisions][product-decisions], [status results][status-results], [reader assumptions][reader-assumptions].

The undecided rows of the [Stage 0 product table][product-decisions] remain the assumed answers for split-side placement, inherited removal, crossing tags, orphan replies, status notices, empty scenes/scripts, long names, b-roll collisions, missing owners, comment undo steps/drafts, local-replica export, refusal wording and felt limits; its edit-stamp and pending-image rows were subsequently decided there. The additions and qualifications below are **assumed, for the product review**. [Stage 0 answers][product-decisions], [reader assumptions][reader-assumptions], [undo open questions][undo-questions], [partial-ancestry history][partial-ancestry].

| Question | Assumed answer and boundary | Evidence |
| --- | --- | --- |
| Recovery `edited` with several removals | List a character when at least one applicable active removal had not observed it; adding another removal never takes information away | [Reader assumptions][reader-assumptions], [recovery history][recovery-order] |
| Recovery `splitBy` with direct and inherited removals | Keep `splitBy` when at least one applicable removal applies by inheritance; adding another removal never takes information away | [Reader assumptions][reader-assumptions], [recovery history][recovery-order] |
| Recovery remover names | Show each distinct applicable remover, ordered by UTF-16 code units and joined with ", ", for example `Alice, Bob`; coordinator assumption | [Reader assumptions][reader-assumptions] |
| What does "stays as it was" mean on deeper concurrent status branches? | The last status both writers had seen; this reading of common ancestry remains open for product review. Whether authoring/reading waits for complete ancestry also remains open | [Status results][status-results], [partial-ancestry history][partial-ancestry] |
| Two people delete one beat and both undo | Accept a rare duplicate as the coordinator's assumption for product review, not a decided product answer. The cited limit demonstrates a doubly deleted character restored twice; it does not establish duplicate-beat acceptance | [Undo limits][undo-limits] |
| May redo re-apply a status change that originally lost? | Built as yes: redo writes a fresh event and may apply it. This remains open with the product owner | [Undo open questions][undo-questions], [undo limits][undo-limits] |

Service, local-store and image selections have a separate [Stage 1b decision][1b-decision].

## Carry-overs and timing debt

The following carry-overs are assigned to the coordinator for Stage 2 under [#1414][stage2], whose work packages cover projection, recovery, shared undo, adapter execution, Split binding and baseline/exit measurements; durable retention/compaction continues into Stage 3. The cited results retain the failures and proof limits. [Stage definitions][exit], [reader bounds][reader-bounds], [undo limits][undo-limits].

| Carry-over | Required work | Owner and tracking | Evidence |
| --- | --- | --- | --- |
| Split T03: FAIL 0/2 | Reconcile U+0020 becoming U+00A0 outside the captured Backspace range with intended deletion and retained identities; run replacement after repair | Coordinator, Stage 2 binding, [#1414][stage2] | [Split result][split-stale], [whitespace history][split-whitespace] |
| Imported-layout move | Remove the segment-name assumption and prove movement, undo and reload in imported layouts | Coordinator, Stage 2 adapter, [#1414][stage2] | [Reader bounds][reader-bounds], [imported-move history][imported-move] |
| Seven declared undo limits and open product answers | Resolve or explicitly refuse affected behavior in production; retain literal failures and generator predicates | Coordinator, Stage 2 undo/recovery/projection, [#1414][stage2] | [Undo limits][undo-limits], [reader assumptions][reader-assumptions], [partial-ancestry history][partial-ancestry] |
| Stale timing rows | One rerun is owed on the merged code, carried as part of the Stage 2 standalone and shared baseline | Coordinator, Stage 2 baseline/exit gate, [#1414][stage2] | [Status timing bounds][status-timings], [reader evidence][reader-results], [performance][perf], [lifetime][lifetime] |
| Complete app integration and format policy | Bind remaining commands/surfaces, honor holds/grouping, define overflow/uniqueness and capacity, and preserve standalone exports | Coordinator, Stage 2 integration, [#1414][stage2]; durable limits in Stage 3 | [App seams][app], [B surfaces][b-surfaces], [projection][proj], [lifetime][lifetime], [stage definitions][exit] |

The timing rows in the retained reports predate the status and reader fixes and are **stale as measurements of the merged code**. The status report lists affected intervals, and the reader report records 321 numeric work-counter deltas with unchanged measured rows and samples. Count regeneration does not measure elapsed cost. Earlier cap successes and failures describe their archived implementations; they cannot establish current runtime budgets. [Status timing bounds][status-timings], [reader evidence][reader-results], [performance][perf], [lifetime][lifetime].

The rerun must cover affected lifetime structure/component/withIdentity, earlier editing/status/comment/burst/split/join rows, and reader/export/load/heap paths, then the real standalone/shared baseline. Browser message-to-frame, M1 queue/paint, complete join/load, network/blob and app heap costs remain outside the Node component proof. The conflict-notice pairwise scan and partial-ancestry policy also remain Stage 2 work. [Status timing bounds][status-timings], [reader bounds][reader-bounds], [performance][perf], [lifetime][lifetime], [#1414][stage2].

## Requirements this places on Stage 2

These requirements carry the retained prototype contracts into the production stage, whose exit separately requires real-editor concurrency, named deliberate-defect tests and unchanged standalone behavior/exports. [Plan section 11][exit], [#1414][stage2].

- Order string ids and tie-breaks by UTF-16 code units; do not use locale collation to resolve shared content. [Reader ordering audit][reader-results], [status other-reader audit][status-results].
- Use one validator per record kind across readers, indexes, notices and undo; carry `readStatusEvent` into status authoring and redo too. Finite malformed-record coverage is not general command-layer validation. [Status results][status-results], [reader audit][reader-results], [undo results][undo-results].
- Normalize ids the same way as values and as map keys, at the shared command entry and in stored/inverse records. Compare writer and encoded-reload output, including raw keys and values. [Reader identity audit][reader-results], [identity functions][reader-identity].
- Build output field by field in a literal order; order carried-through unknown fields by UTF-16 code units, retaining separate file-order metadata for the byte contract. [Reader results][reader-results].
- Build fresh and incremental results with one assembly function and compare them at checkpoints. Retain repeated/missing-head, suppressed-boundary and cache-invalidation literal cases. [Reader results][reader-results].
- Use strict comparison of complete outputs, including key order, missing fields, holes, extra properties, accessor indices and unsupported kinds; retain deliberate-defect controls and independent literal product expectations. [Reader results][reader-results], [strict comparison][strict-comparison], [harness][harness].
- Keep a seeded generator with a literal table of declared limits and matching predicates; unmatched violations fail, and dedicated histories reproduce limits not reached by sampled seeds. [Undo results][undo-results], [undo limits][undo-limits].
- Keep the painted base, identities and directed selection through native editing and composition; capture targets before mutation, preserve replacement intent and insert before deleting observed identities. Bind Writer and Split at their commit boundary, including Split compositionend capture before `dropEmptySince`. [Buffer][buffer], [app][app], [B surfaces][b-surfaces], [Split reconciliation][split-reconcile].
- Route provider, hydration and recovery ingress through the bounded M1 gate; preserve pending work on overflow and define cancellation/crash-safe recovery. Keep genuinely stale cells unpainted until mapped input; resolve the retained Split whitespace failure. [Buffer][buffer], [provider-bypass history][provider-bypass], [Split stale base][split-stale].
- Publish through the shared session owner with precise affected-beat changes and pure derivations. Migrate or refuse mutable session callers, standalone save/draft/history writers and asynchronous completions that can replace shared state. [App seams][app], [editing contract][editing-contract], [#1414][stage2].
- Integrate command-record undo, selection mapping through restorations, semantic removal cancellation and ineffective-step consumption. Resolve the after-transaction recording gap, typing groups, history bound, redo parking and save holds; retain restoration/retirement state a kept history can name. [Undo results][undo-results], [reader reconciliation][reader-results], [app hold history][undo-hold].
- Initialize typed roots before applying state; integrate annotation marks, recovery and explicit anchor moves. Preserve stored U+200B, cue flags, loaded capture metadata and the exact device-local exclusion. Define merged overflow/uniqueness and the recovery assumptions with the product owner. [Marks][marks], [projection][proj], [lossless projection][lossless], [reader assumptions][reader-assumptions].
- Carry the repaired causal status rule and its independent four-event regression into production; decide incomplete-ancestry authoring/reading and status redo, and measure the conflict-notice scan. [Status results][status-results], [undo open questions][undo-questions].
- Remove the imported-segment move assumption, or refuse that command until proven. Set retained-size and recovery budgets, with durable limits/compaction in Stage 3, and rerun stale timings as part of the standalone/shared baseline. [Reader bounds][reader-bounds], [lifetime][lifetime], [stage definitions][exit], [#1414][stage2].

[exit]: ../../COLLABORATION-PLAN.md#11-implementation-stages
[editing-contract]: ../../COLLABORATION-PLAN.md#4-editing-and-command-contract
[hypotheses]: ../stage-0/8-schema-hypotheses.md
[product-decisions]: ../stage-0/9-stage-1-experiments.md#product-decisions
[buffer]: ../../../prototypes/collab/buffer-results.md
[slice]: ../../../prototypes/collab/slice-results.md
[structure]: ../../../prototypes/collab/structure-results.md
[marks]: ../../../prototypes/collab/mark-results.md
[proj]: ../../../prototypes/collab/projection-results.md
[app]: ../../../prototypes/collab/app-binding-results.md
[follow]: ../../../prototypes/collab/app-binding-2-results.md
[perf]: ../../../prototypes/collab/perf-results.md
[b-surfaces]: ../../../prototypes/collab/b-surfaces-results.md
[b-counts]: ../../../prototypes/collab/b-surfaces-counts.md
[split-reconcile]: ../../../prototypes/collab/split-reconcile-results.md
[split-stale]: ../../../prototypes/collab/split-stale-results.md
[lossless]: ../../../prototypes/collab/src/proj/lossless-results.md
[exclusions]: ../../../prototypes/collab/src/proj/exclusions.ts
[lifetime]: ../../../prototypes/collab/lifetime-results.md
[lifetime-counts]: ../../../prototypes/collab/src/perf/lifetime/counts.json
[lifetime-sensitivity]: ../../../prototypes/collab/src/perf/lifetime/sensitivity.json
[harness]: ../../../prototypes/collab/test/harness.test.ts
[mark-tests]: ../../../prototypes/collab/test/marks/marks.test.ts
[lost]: ../../../prototypes/collab/histories/T01-lost-remote.md
[stale]: ../../../prototypes/collab/histories/T01-stale-base.md
[restore-copy]: ../../../prototypes/collab/histories/T10-copy-on-restore.md
[join-copy]: ../../../prototypes/collab/histories/T06-copy-on-join.md
[omitted]: ../../../prototypes/collab/histories/PROJ-omitted-field.md
[lost-comment]: ../../../prototypes/collab/histories/T11-single-comment-key.md
[lost-tag-a]: ../../../prototypes/collab/histories/T20-nest-single-tag-A.md
[lost-tag-b]: ../../../prototypes/collab/histories/T20-nest-single-tag-B.md
[provider-bypass]: ../../../prototypes/collab/histories/T04-provider-bypass.md
[overflow]: ../../../prototypes/collab/histories/T04-long-composition.md
[undo-hold]: ../../../prototypes/collab/histories/T03-app-undo-hold.md
[split-whitespace]: ../../../prototypes/collab/histories/T03-Split-native-whitespace.md
[1385]: https://github.com/RetroGorilla/splitpage/pull/1385
[1387]: https://github.com/RetroGorilla/splitpage/pull/1387
[1388]: https://github.com/RetroGorilla/splitpage/pull/1388
[1390]: https://github.com/RetroGorilla/splitpage/pull/1390
[1391]: https://github.com/RetroGorilla/splitpage/pull/1391
[1399]: https://github.com/RetroGorilla/splitpage/pull/1399
[1406]: https://github.com/RetroGorilla/splitpage/pull/1406
[1407]: https://github.com/RetroGorilla/splitpage/pull/1407
[1410]: https://github.com/RetroGorilla/splitpage/pull/1410
[1412]: https://github.com/RetroGorilla/splitpage/pull/1412
[status-results]: ../../../prototypes/collab/status-resolution-results.md
[status-timings]: ../../../prototypes/collab/status-resolution-results.md#counts-and-retained-timings
[reader-results]: ../../../prototypes/collab/reader-order-results.md
[reader-bounds]: ../../../prototypes/collab/reader-order-results.md#not-shown
[reader-assumptions]: ../../../prototypes/collab/reader-order-results.md#assumed-for-the-product-review
[reader-identity]: ../../../prototypes/collab/src/readers/identity.ts
[strict-comparison]: ../../../prototypes/collab/test/strict-comparison.ts
[undo-results]: ../../../prototypes/collab/undo-records-results.md
[undo-limits]: ../../../prototypes/collab/undo-records-results.md#declared-limits
[undo-questions]: ../../../prototypes/collab/undo-records-results.md#open-questions
[partial-ancestry]: ../../../prototypes/collab/histories/T21-partial-status-ancestry.md
[recovery-order]: ../../../prototypes/collab/histories/T21-recovery-map-order.md
[imported-move]: ../../../prototypes/collab/histories/UR-move-imported-segment.md
[stage2]: https://github.com/RetroGorilla/splitpage/issues/1414
[1413]: https://github.com/RetroGorilla/splitpage/pull/1413
[1418]: https://github.com/RetroGorilla/splitpage/pull/1418
[1421]: https://github.com/RetroGorilla/splitpage/pull/1421
[1b-decision]: 1b-decision.md
