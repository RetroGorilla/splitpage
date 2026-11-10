# Stage 1a feasibility decision

## Result

Stage 1a does **not yet meet its exit condition** on merged evidence through `c22701c5050052607c84652f33f0d491afd6025f`. The checker clause is met; M1 and B are confirmed by the product owner, with semantic command undo; B/M1 passes the Writer and page matrices and both surfaces' T04; PROJ passes all 291 fixtures outside its one declared device-local exclusion. [Checker][1385], [product decisions][product-decisions], [B surfaces][b-surfaces], [Split reconciliation][split-reconcile], [lossless projection][lossless], [undo][structure]. Open [#1409][1409] still serves the schema-selection-or-revision clause: writing-lifetime retained size and remote-character cost must be assessed against the PERF caps, with growth recorded under section 5. The editing-trace clause has a retained Split T03 failure and unrun Split replacement; [#1412][1412] has merged, closes Split T02 and boundary, and records that whitespace failure without a pass. The coordinator carries it to Stage 2 below. These bounded results do not make every editing path pass. [Stage 1a exit][exit], [schema gate][schema-gate], [PERF gate][experiments], [Split stale-base results][split-stale].

## Checker

The checker compares literal character identities, marks, carets, selections, records and recovery, using a creation ledger independent of the schema reader. It rejects the following injected defects for both candidates before endorsing their positive controls. These are retained negative tests, not skipped product outcomes. [#1385][1385], [#1391][1391].

| Deliberate defect | Rejecting test and retained history |
| --- | --- |
| Lost remote character | `checker rejects Lost remote character (T01 D3 M2)` in [harness.test.ts][harness]; whole-beat reconciliation loses X. [History][lost] |
| Stale base | `checker rejects Stale base (T01 D3 M2)` in [harness.test.ts][harness]; newer offsets delete X instead of the observed content. [History][stale] |
| Duplicated identity on restoration | `checker rejects Duplicated identity (T10 D1 late-C)` in [harness.test.ts][harness]; copying retained content produces `cdcXd`. [History][restore-copy] |
| Duplicated identity on join | `checker rejects Duplicated identity (join) (T06 D1 narration probe)` in [harness.test.ts][harness]. [History][join-copy] |
| Omitted field | `checker rejects Omitted field (PROJ serialization)` in [harness.test.ts][harness]; serialization loses literal `lengthSeconds: 12`. [History][omitted] |
| Lost comment mark | `checker rejects Lost mark (T11 step 1 D1)` in [harness.test.ts][harness]; one shared key loses an overlapping comment. [History][lost-comment] |
| Lost tag mark | Single-tag negative probes in [marks.test.ts][mark-tests] reject the missing nested stack. [A history][lost-tag-a], [B history][lost-tag-b] |

The 96 checks per candidate against the field inventory are declaration checks. The exact fixture comparisons, explicit transport tests and omitted-field injection provide behavioral evidence; the declaration count alone does not. [Projection results][proj].

The repaired PROJ gate also rejects deletion of one stored U+200B or stored cue attributes after encoded transfer to a fresh receiving replica. It uses the unchanged independent app-save bytes. [Lossless projection][lossless], [#1406][1406].

## Trace table

“B only” means the candidate was tested directly, without a buffer mechanism. It is not a B-with-M1 pass. The original page/app reports use A; #1407 adds B on Writer/page, #1410 closes Split T04/T01, and #1412 closes Split T02 before stopping at T03. Counts below include complete literal forward/undo checks where marked PASS; the Split results come from separate reviewed runs. Ordinary app typing commits synchronously; ordinary D3 cases deliberately delay sync. Composition spans tasks and commits in compositionend. Delivery labels retain the [Stage 0 definitions][hypotheses]: D1 concurrent exchange, D2 delivery before the next writer acts, D3 delivery during the buffered interval, dup duplicate delivery, rev reverse delivery, late-C full-state third-replica join. [Buffer][buffer], [app][app], [B counts][b-counts], [Split reconciliation][split-reconcile], [Split stale base][split-stale].

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
| T21 scalar | Not combined; B only PASS 1/1: D1 | A same; causal events pass, one LWW key fails | [#1391][1391] | [marks][marks] |
| MOVE concurrent | Not combined; B only PASS 3/3: D1, dup, late-C | A passes refusal oracle, not movement | [#1388][1388] | [structure][structure] |
| MOVE destination | Not combined; B only PASS 4/4: D1, D3, dup, late-C | A refuses movement before mutation | [#1388][1388] | [structure][structure] |
| MOVE delete | Not combined; B only PASS 2/2: D1, late-C | A refuses movement; removal/recovery still checked | [#1388][1388] | [structure][structure] |
| MOVE cut-paste | Not combined; B only PASS refusal, no delivery | A also refuses before content changes or consuming cut | [#1388][1388] | [structure][structure] |
| PROJ | B only: PASS 291/291 outside one exact device-local exclusion; 290/291 exact direct-app-save bytes, all 96 mappings | A same; original-byte 7/291 reflects app rewriting, not projection loss; merged limits remain unresolved | [#1406][1406] | [lossless projection][lossless], [exclusion][exclusions] |
| SLICE | B/M1 Writer/page 24/24 each; Writer follow-up 23 positive composition passes; Split passes T04/T01 in #1410 and T02 in #1412, fails T03 | B Writer/page also run M2/M3 (72/72 each overall); M2 mapper/bold limits recur; re-entry controls separate | [#1407][1407], [#1410][1410], [#1412][1412] | [B surfaces][b-surfaces], [Split reconciliation][split-reconcile], [Split stale base][split-stale] |
| PERF | B Node components, no editor buffer; old synthetic-history cap failures retained; realistic-history assessment still owed in open #1409 | A comparison is historical; #1406 changed export after timing; no accepted browser PERF result | [#1400][1400], [#1406][1406], [#1409 (open)][1409] | [performance][perf], [lossless limits][lossless] |

Still not combined under B with M1: T05–T12, T20, T21 and MOVE with an editor buffer, and full PROJ/PERF with the real editor. Split T03 replacement is unrun; visual and editable-heading input remain unbound. Writer's structural/mark/load composition follow-up now has B/M1 evidence, but app comment/tag rendering remains unbound. No standalone A/B performance run was made because shipping code did not change. [B surfaces][b-surfaces], [Split stale base][split-stale], [structure][structure], [marks][marks], [projection][proj], [performance][perf].

#1407's Split T04/T04-removed 0/3 and 0/2 results stopped before complete all-replica/undo checks. #1410 localizes the second render to the prototype focusout bubble listener recursively replacing/removing the same Node. A harness-only in-flight paint guard closes all five; removing it reproduces all five throws. The real app suppresses blur sync while painting in the recorded standalone and guarded controls; no new production blur hook is established. [Original Split history][split-repaint], [runtime localization][split-localization], [Split reconciliation][split-reconcile].

#1410 then stops at Split T02 0/3: DOM/caret advance to Xab/3 while the retained base stays ab. #1412 attributes that repaint to the adapter and withholds it while `paintHeld`; genuinely stale DOM ab/2 remains over replica Xab until mapped input and undo pass. Split T03 instead fails both orders when the third Backspace converts a trailing space outside its captured deletion range to U+00A0. The failure precedes remote formatting and commits no local edit. [Parent stale-cell history][split-stale-parent], [stale-contract history][split-stale-history], [native-whitespace history][split-whitespace].

## Decision 1: M1 buffer mechanism

**Confirmed by the product owner on 2026-11-09, standing unless the evidence still owed contradicts them.** The qualification remains while PERF is owed in open #1409. [Product decisions][product-decisions], [#1409][1409]. M1 holds remote updates outside one Yjs document while a buffered edit or composition is open, commits the local intent, drains the hold, then reconciles the editor. All three mechanisms pass T01–T04 in A/B simulation and the Writer/page matrices. B/M1 now passes T04 and removed-target on both app surfaces; Split T03 remains a binding failure. [Buffer][buffer], [B surfaces][b-surfaces], [Split reconciliation][split-reconcile], [Split stale base][split-stale].

M1 and M3 satisfy every new composition case's scoped checks in #1399. M2 puts composed text in old R1 after a preceding split instead of following the painted neighbor into Rb. This is a limit of its mapper's `painted.id` filter; a cross-beat search/destination/caret fix is proposed but untested. M2 also leaves new xy plain under remote bold, contrary to T21. Those three cases pass the narrower checker because it checks bold only on the original characters. M1/M3 make xy bold. The comment/tag replica checks pass, but their app rendering remains unbound under all three. [Follow-up][follow], [structural history][composition-structure], [mark history][composition-marks].

B reproduces that comparison without a mechanism-specific mapper. M1 passes all 23 positive Writer composition cases, plus six re-entry interventions; three baseline re-entry controls deliberately fail. B's split remains an inner boundary in its source segment, and the binding observes those bounds and identities directly. M2's split-before and new-xy bold mismatches recur. These are counts and correctness results, not timings. [B surfaces][b-surfaces], [B counts][b-counts].

M2 is rejected in its measured form for these mapping and T21 failures, not as an inherently unsafe mechanism. The earlier M2 recommendation applies only to the first Writer matrix. M3 remains feasible on the tested cases but adds a second document, origin-filtered forwarding and coordinated persistence; its extra memory and persistence cost is unmeasured. [App][app], [follow-up][follow], [buffer][buffer].

M1 has obligations, not just an event-handler choice. Every provider, hydration and recovery ingress that applies a remote update must obey the same hold. The pinned provider receiver demonstrably bypasses an application queue when attached directly; deferral fails even though the identity-mapped T04 content still passes. While held, the Writer sees its retained composing DOM and the pre-remote editor/session state; remote changes are delayed across that document. In the app example DOM is `abxcd`, E/session is `abcd`, and 18 bytes wait until commit produces `Zabxyc`. [Provider-bypass history][provider-bypass], [app comparison][app].

Proof limits: the bounded queue needs overflow, cancellation and recovery handling. The tiny-bound probe retains the overflow message and stops; it does not prove a production overflow policy. The 240-update app runs stay below their bound. The `retainBeforeInput` early hold exists only in the prototype. Its synchronous re-entry controls fail without intervention under M1/M3 too; they demonstrate protection against deliberate harness re-entry, not a demonstrated production network arrival or a new production requirement. B/M1 real-editor evidence is now present, but no crash-safe editing hold or complete annotation binding is established. [Buffer][buffer], [overflow history][overflow], [follow-up][follow], [B surfaces][b-surfaces].

## Decision 2: candidate B schema

**Confirmed by the product owner on 2026-11-09, standing unless the evidence still owed contradicts them.** The qualification remains while PERF is owed in open #1409. [Product decisions][product-decisions], [#1409][1409]. Stable segments retain text identity while heads and inner boundary embeds describe structure; one order array orders segments. Both candidates pass every required isolated structural and mark trace and map all 96 fields. B supports tested whole-segment beat moves. Most historical editing comparisons were within the fixed noise tolerance; B's near-limit identity capture was 0.062 ms against A's 18.908 ms with those public lookup calls. A retained slightly fewer encoded bytes. #1406 changed export after those timings; its source audit identifies the affected rows. [Structure][structure], [marks][marks], [projection][proj], [performance][perf], [#1406][1406].

### Rejected alternatives

A is rejected for this selection because it refuses beat movement and its implemented identity pass repeatedly traverses preceding document-wide items. An identity index or batched traversal could reduce that cost; it is not a lower bound on A. One independent text per scene was not a tested third candidate: the plan requires an identity-preserving answer to header ownership changes first. [Structure][structure], [performance][perf], [candidate definitions][candidates].

### Supported APIs

The prototypes use public typed-root getters before hydration, Y.Text inserts/deletes/formatting/embeds and `toDelta`, maps/arrays, encoded updates, and relative-position capture/resolution. Live identity is verified rather than treating a deleted relative position as a live character. Stored anchors resolve with `followUndoneDeletions=false`; undo-restored characters get new raw identities. The top-item `undoStack` wrapper uses a public field in an undocumented way and is a remaining production API risk. Diagnostic private formatting flags and instrumented library loops explain failures/count visits; the selected projector does not require private item/store access. [Marks][marks], [structure][structure], [performance][perf], [API questions][api-questions].

### Growth behavior

Both candidates exceed the 2 MiB retained-state cap by the 25,050-operation checkpoint of the old synthetic writing history. At 50,100 operations A/B retain 3,338,732/3,356,090 bytes, despite default GC and no active undo stack. Soft removals, removal records, joins, retirement flags and status history remain retained. Those retention rules are insufficient for that cap on that workload; the encoded sizes reproduce unchanged after #1406. This is neither a general growth bound nor a measured compaction solution; undo retention would add cost. Open #1409 owes the writing-lifetime growth and remote-character assessment for B; no result from it is credited here. [Performance history and source audit][perf], [#1409][1409].

### Remaining optional command restrictions

B admits whole-segment movement only. Moving part of a segment and cross-scene structural cut/paste remain refused before mutation and before consuming a cut. A refuses all moves. These optional restrictions cannot excuse failure of mandatory writing. [Structure][structure], [acceptance traces][acceptance].

### Proof limits and Disagreement

**Disagreement:** an unconditional Stage 1a exit is still unsupported: the old synthetic history exceeds the caps, writing-lifetime PERF evidence is not yet merged, and Split T03 has no passing binding. This is not evidence against the product owner's B selection. The earlier PROJ text/cue losses and absent B/M1 Writer/page/two-surface-T04 evidence are closed. Full production integration of the structural/mark/status readers remains outside these fixture passes. [Schema gate][schema-gate], [performance][perf], [#1409][1409], [Split stale base][split-stale], [lossless projection][lossless], [B surfaces][b-surfaces], [Split reconciliation][split-reconcile].

PROJ now matches 290/291 direct app saves exactly under each candidate and 291/291 outside one declared exclusion. Only `supplement.splitpage` excludes the complete values at `$.rows.0.imageLinks.0.location` (the fictional fixture path-location object for take.mp4) and `$.rows.0.imageLinks.1.location` (the bundled-location object for notes.pdf). Their exact literal values are pinned in the [exclusion code][exclusions]. Link locations are device-local and do not enter shared state. The gate removes only those two properties from the expected app-save bytes, checks their original values and formatting, and compares the actual output unchanged; no other fixture, field or byte is excluded. The unchanged 7/291 original-byte count reflects rewriting by the app's own save, not projection loss. [Lossless projection][lossless], [#1406][1406].

Stored characters and `cue:true` already existed in Y.Text under both layouts. Export now renders stored runs without stripping U+200B or recalculating cue membership; no source-HTML shadow was added. Stored cue flags pass; line-only derivation remains refuted. Presentation-only caret sentinels require explicit provenance, distinct from stored U+200B. The mixed-beat control proves that adapter contract, not that the real Writer already supplies it. [Lossless projection][lossless].

Historical capture stamps/colors and comment `updatedAt` must survive import/export even though Stage 0 proposed derivation or regeneration. The edit-stamp rule was decided on 2026-11-09: a beat's "last edited" updates once per typing group; the script's revision and last editor are written only on export. It is no longer a missing schema-gate decision. [Product decisions][product-decisions]. Atomic picture/annotation groups, bodies, resolution groups, extras and other coupled values round-trip; that does not prove concurrent edits inside them. B is segment-local, not necessarily beat-local: splits retain inner beats in their source segment. [Schema requirements][schema-requirements], [projection departures and opaque values][proj], [incremental mechanism][perf].

## Decision 3: semantic command undo

Select semantic command undo with the per-writer join records and durable retirement that the traces required. Plain Yjs UndoManager is not the shared undo policy, and browser-native undo is not the source of shared intent. Text inverse operations may still use library primitives; command identity, grouping, no-effect consumption, structural recovery and selection restoration belong to the shared command contract. [Structure][structure], [marks][marks], [native-undo history][native-undo].

Plain per-writer undo fails **T06 under both client-id orders and both candidates**: deleting Alice's join leaves Bob's join live, so the required unjoin does not occur. Semantic undo retires every matching join known at undo time, consumes that command, and leaves Bob's later ineffective undo unable to reach an older step. Separately, a remotely overwritten map item causes plain undo to skip backward and remove earlier Z; top-item isolation preserves Z. Causal status events and frontier retirement satisfy T21 scalar, where one LWW key yields shot instead of todo. [Structure][structure], [T06 A][native-join-a], [T06 B][native-join-b], [U-H1 history][top-item], [marks][marks].

The native browser `historyUndo` range reports the current caret, not the identities being reversed. The real app intercepts Ctrl+Z at keydown; the slice intercepts `historyUndo` in beforeinput. Both need selective command history rather than reconstructing undo from that range. [Slice][slice], [app][app], [native-undo history][native-undo].

Proof limits: the prototype manager sets 1000 ms capture, but does not implement/test the standalone owner's complete typing groups, 200-entry bound, redo parking or save-hold semantics. Its stack has no imposed entry bound. Durable retirement/removal/status records also accumulate without a compactor; the finite growth history measures that accumulation, not indefinite growth. Rejoin after retired identical joins, identical simultaneous removal/tag undo and general status graphs remain unproved. [Structure][structure], [marks][marks], [app][app], [performance][perf].

The actual `Undo.hold()` blocks standalone undo in the positive control, while the selective callback still changes `the an` to `the then` with hold=1 under all mechanisms. Shared undo must deliberately honor or replace that gate; the bypass is an integration gap, not accepted behavior. Writer composition calls neither generic `compositionMark` nor `dropEmptySince` on this route. Split now exercises both lifecycle calls, final composition sync in capture before bubble `dropEmptySince`, and complete selective undo for the passing T04/T01/T02 cases; complete grouping/hold/redo policy is still unproved. [App undo observations][app], [hold history][undo-hold], [B surface seams][b-surfaces], [Split reconciliation][split-reconcile], [Split stale base][split-stale].

## Predictions

Each line reports only the named lane's proof scope; a hypothesis is not confirmed merely because its representation exists. [Hypothesis rows][hypotheses].

- A-H1: confirmed for tested split/join/header identity preservation, including visual identity. [Structure][structure].
- A-H2: soft-removal recovery/restore confirmed for T10; sufficiency for the 2 MiB cap refuted on the synthetic history. [Structure][structure], [performance][perf].
- A-H3: full T11 confirms split-descendant removal classification; T09/T10 alone had established only observed-edit attribution. [Marks][marks], [structure][structure].
- A-H4: concurrent joins project one glue; semantic retirement is additionally needed for undo. [Structure][structure].
- A-H5: remote edits to the second visual survive the join and undo. [Structure][structure].
- A-H6: deterministic same-gap ordering confirmed; swapping client ids changes which split side receives X. [#1385][1385], [structure][structure].
- A-H7: beat-local identity capture refuted for these calls; repeated document-wide scans and near-limit CPU cost measured. [Performance][perf].
- A-H8: supplied nesting, crossing recovery and whole-tag projection confirmed in T20; independent necessity of either nesting sort was withdrawn after surviving mutations. [Marks][marks].
- A-H9: local-origin isolation and explicit command boundaries confirmed; the claim of today's complete grouping is unproved. Plain-manager sufficiency fails T06. [Structure][structure], [app][app].
- A-H10: initially failed; repaired projection passes this corpus under both candidates with the exact two-field device-local exclusion, not an unconditional all-data byte claim. [Lossless projection][lossless].
- A-H11: duplicate row-boundary suppression confirmed in T08 race. [Structure][structure].
- A-H12: causal status events pass tested frontiers/undo; one LWW key fails. Arbitrary graphs and tag/shot status are unproved. [Marks][marks].
- A-H13: collision-safe projected duplicate b-roll ids remain unproved; no pass is claimed. [Projection][proj].
- B-H1: segment head conversion plus inner embeds match the required structural traces. The predicted T08 create/race failure is refuted by a single transaction. [Structure][structure].
- B-H2: whole-segment movement preserves identity and tested concurrent edits/undo. [Structure][structure].
- B-H3: one order authority suffices for the tested MOVE/T08 cases. [Structure][structure].
- B-H4: cross-segment observed deletions in one transaction pass T09. [Structure][structure].
- B-H5: segment-local identity traversal supported; global projection/structural work remains, so no complete per-keystroke locality or latency pass follows. [Performance][perf].
- B-H6: shared trace successes carry over within the named tests; repaired A-H10 passes for B with the declared exclusion; A-H13 remains open. [Marks][marks], [lossless projection][lossless], [structure][structure].
- U-H1: top-item isolation stops the tested older-step skip; semantic join/status undo is separately required. General redo safety is not established. [Structure][structure], [marks][marks], [app][app].
- PROJ-cue: repaired stored flags pass all six cue-bearing inputs under both candidates; deriving them still loses the mid-line cue and invents a flag on an intentionally unmarked SFX line. [Lossless projection][lossless].
- PROJ-detached: specified delete-versus-explicit-mark-move passes both candidates, four orders and swapped ids; media null/load fields retained. Multiple movers remain open. [Projection][proj].
- PROJ-unknown: encoded transfer and concurrent known-field edits preserve extras on all seven record kinds, including special keys; edits inside opaque extras unproved. [Projection][proj].
- Y1: public relative-position identity capture works; document-wide versus segment traversal and cost measured for the implemented calls. [Buffer][buffer], [performance][perf].
- Y2: fresh identity checks support tested live/deleted mapping; active-only removed-target mapping fails and requires recovery. No general null-reason discriminator is proved. [Buffer][buffer], [performance][perf].
- Y3: relative positions with explicit affinity and `followUndoneDeletions=false` pass structural selection restoration; necessity of reanchoring unchanged identities for mark-only undo was withdrawn. [Structure][structure], [marks][marks].
- Y4: client-id-dependent same-origin insertion order confirmed by swapped-id T05. [#1385][1385].
- Y5: local origins and stop-capture boundaries confirmed; timeout/capacity and production grouping remain outside the proof. [Structure][structure], [marks][marks].
- Y6: undo-deleted characters restore with new raw identities and need reanchoring; soft removal avoids copying retained characters. [Structure][structure].
- Y7: ineffective/overwritten undo can reach older steps; top-item isolation stops the tested skip but uses an undocumented field pattern. [Structure][structure].
- Y8: default-GC soft removal retains recovery content in the tested histories; tombstone retention is not the recovery design. [Structure][structure], [performance][perf].
- Y9: tested recovery uses neither snapshots nor subdocuments; this does not measure alternative designs. [Structure][structure].
- Y10: public embeds/deltas work for tested boundaries; undo/redo recreate boundary identity. Full content-atom coverage is separate PROJ evidence. [Structure][structure], [projection][proj].
- Y11: per-comment/per-tag keys preserve overlapping marks; mutations detect their removal. Many-key performance is unproved. [Marks][marks].
- Y12: explicit attributes prevent inheritance of observed comment/tag keys, but do not exclude a concurrent insertion from remote bold; M2's composed-text mismatch is not a new oracle. [Marks][marks], [follow-up][follow].
- M1 / artifact 8 section 4: actual provider bypass confirmed as a deferral failure, not inevitable T04 content loss. [Buffer][buffer], [provider history][provider-bypass].
- M1/M3 / section 4: tiny queue overflow confirmed without dropping the pending transport message; crash-safe continuation unproved. [Buffer][buffer], [overflow history][overflow].
- M2 / section 4 T03: unconditional repeated-text failure refuted with retained targets; without targets all mechanisms remain ambiguous. [Buffer][buffer], [slice][slice], [#1390][1390].
- M2 / section 4 T04 removed: recovery routing requirement confirmed. [Buffer][buffer], [app][app].
- Buffer replacement ordering: insert-before-delete is required for the tested `aβXd` oracle; delete-first fails under the recorded orders. [History][insert-first].
- Root initialization: early public typed-root declaration fixes lazy A formatting loss; the earlier undo-retention explanation is withdrawn, not an intrinsic A defect. [Marks][marks].
- Split reconciliation: attributing #1407's throw to a required new app blur hook was too broad; browser stacks locate the recursive writer in the harness, and a harness-only guard passes the five original cases. [Split reconciliation][split-reconcile], [runtime localization][split-localization].
- Split stale cell: #1410's T02 failure came from the adapter's forbidden repaint; withholding it preserves the actual stale condition and passes all four T02 cases. Other render/input paths remain unproved. [Split stale base][split-stale].

Y13–Y15, H1–H14 and P1's service/storage predictions are not adjudicated by these editing results. The inbound receiver probe above does not establish the outbound H11 hold or any durable provider contract. Their selections and evidence, including the later picture work, belong to the [Stage 1b decision][1b-decision]. [Buffer scope][buffer], [experiment ownership][experiments].

## Measured numbers

These are existing measurements, not new runs. #1400 used Node 24.22.1, Yjs 13.6.33, an AMD Ryzen 9 9950X3D2, Windows 10.0.26300 x64 and 30.91 GiB RAM. A game and other background work were running. Accepted CPU readings were 9.7–34.6%, with at least 8.71 GiB free RAM. Five alternating paired runs used three warmups and eleven samples per case; tables report the median of per-run p50s and the recorded ranges. The fixed noise rule does not excuse absolute cap failures. Thirty runs were accepted, one CPU attempt voided and two starts refused. The optional Edge attempt was voided, so **there is no accepted browser PERF timing**. [Method and load readings][perf], [#1400][1400].

These timing rows describe the recorded implementation, not the repaired exporter. #1406 changed export without retiming. The affected historical cases are local/remote character, bursts, split/join, first full projection and projection-bearing checkpoint/heap/history measurements; none was rerun against the changed exporter. Identity capture/resolve, status/comment and applyUpdate-only load do not call export inside their timed intervals; structural counts and encoded sizes reproduce unchanged. The current source audit declares this difference rather than claiming unchanged implementation. Open #1409 owes the replacement PERF assessment; no numbers from it are used. #1407/#1410/#1412 report correctness counts only. [Performance source audit][perf], [#1406][1406], [#1409][1409], [B surfaces][b-surfaces], [Split reconciliation][split-reconcile], [Split stale base][split-stale].

Selected component rows below are milliseconds, exactly as reported. They exclude rendering, app publication/derivations, network, persistence, blobs and the real editor buffer. Most candidate editing comparisons remain within noise. [Full timing tables][perf].

| Node case | A p50 [range] | B p50 [range] | A / B p95 |
| --- | --- | --- | --- |
| Largest canonical, local character | 1.030 [0.812–1.208] | 0.976 [0.759–1.105] | 1.486 / 1.218 |
| Large, local character | 5.275 [4.255–6.593] | 4.811 [4.318–5.318] | 7.686 / 6.235 |
| Large, remote character | 5.127 [4.139–5.294] | 4.536 [4.181–4.703] | 5.813 / 5.168 |
| Near 2 MiB, capture identities | 18.908 [17.584–24.694] | 0.062 [0.052–0.112] | 21.125 / 0.148 |
| Large after 50,100 operations, local character | 45.287 [38.789–50.306] | 42.949 [42.117–49.154] | 52.037 / 51.096 |
| Large after 50,100 operations, remote character | 42.677 [36.841–45.227] | 40.819 [39.732–46.006] | 44.755 / 45.678 |

**Both candidates exceed the 30 ms remote-character component cap after the old long history.** Both also exceed the 8 ms local-input component comparison and 40 ms local p95. Near-limit first full projection is A 3356.876 [3105.123–4497.318] ms and B 3347.141 [2958.892–3549.837] ms, exceeding the 1000 ms single-task comparison. These recorded failures remain failures; they do not measure the changed exporter, and Node is not a browser message-to-frame pass. [Performance][perf], [#1406][1406].

Exact retained sizes on the 300-beat synthetic workload, with no active undo manager, are below. At 50,100 operations the active-file proxy is 401,522 bytes and state/proxy ratios are 8.315x/8.358x; the 10x proxy cap holds but the independent 2,097,152-byte cap fails. Fresh near-limit state is A/B 2,001,642/2,087,457 bytes over a 1,552,544-byte plain file; fresh ratios are 1.289x/1.345x. [Performance][perf].

| Operations | A state bytes | B state bytes | Soft-removed beats | Removal records | Joins / retired ids | Status events |
| ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 0 | 427695 | 445329 | 0 | 0 | 0 / 0 | 0 |
| 10020 | 1220382 | 1237973 | 20 | 120 | 100 / 100 | 200 |
| 25050 | 2398278 | 2415709 | 50 | 300 | 250 / 250 | 500 |
| 50100 | 3338732 | 3356090 | 100 | 600 | 500 / 500 | 1000 |

The earlier #1396 full-projection Node set used five measurements and one warmup per candidate/fixture while other lanes ran: CPU 14.4%, free RAM 5.15/5.06 GiB before/after. Large full projection medians were A 63.230 [59.666–66.018] ms and B 64.139 [61.233–65.460] ms; after one character, A 60.660 [59.553–63.193] and B 59.980 [59.565–65.721] ms. Both were full scans of the old renderer. These are a different method from #1400, not a controlled before/after comparison or timings of the lossless repair. [Projection cost][proj], [#1396][1396], [lossless limits][lossless].

#1399 does retain browser-clock observations, distinct from PERF: A only, Edge 157.0.4341.42, pinned throwaway app, 240 remote updates (160 inserts, 80 deletes). Every long-composition run retains forty remote characters in each beat and one xy. Commit includes planning, mutation, held-update drain and projection; paint measures first DOM reconciliation, not raster/frame time. Each row is one instrumented sample, with zeros allowed by clock resolution, not a controlled performance comparison. [Measurements][measurements].

| Mechanism / delivery | Peak bytes / messages | Commit + projection ms | First actual DOM paint ms |
| --- | --- | ---: | ---: |
| M1 / D3 | 2318 / 240 | 1.500 | 0.000 |
| M1 / dup | 4636 / 480 | 2.100 | 0.100 |
| M1 / late-C | 2318 / 240 | 1.000 | 0.100 |
| M2 / D3 | 0 / 0 | 0.200 | 0.100 |
| M2 / dup | 0 / 0 | 0.200 | 0.200 |
| M2 / late-C | 0 / 0 | 0.200 | 0.100 |
| M3 / D3 | 2318 / 240 | 1.200 | 0.000 |
| M3 / dup | 2318 / 240 | 1.100 | 0.100 |
| M3 / late-C | 2318 / 240 | 1.100 | 0.100 |

## Merged states that break format limits, and findings with no policy yet

The 520 seeded merged-limit runs converge and resave stably, but do not establish valid merged documents. Each writer was within its named limit before delivery. The unresolved results are: [Projection limits][proj], [#1396][1396].

- Duplicate person names remain duplicated after projection and app load/save. [History][limit-people].
- Distinct tag records concurrently renamed to one category/name retain duplicate keys. [History][limit-tags].
- At 62 pictures the projection retains all 62, with no overflow recovery entry; plain export keeps 61 and drops the last. [History][limit-gallery].
- At 41 shot props the projection retains all members; plain export keeps 40. [History][limit-props].
- Two posters remain true in projection; app save clears the later flag. [History][limit-poster].
- Two headings before one beat retain both objects/text in shared state, but projection omits the earlier heading without recovery. [History][limit-heading].
- Content-key tag ids collapse deliberately separate same-kind/name tags even sequentially; a lone surrogate collides with U+FFFD. Renaming, migration and identical-tagging undo have no established general identity solution. [Marks][marks].
- Join retirement is proved for concurrent identical joins and remote glue rewrites, not a later intentional rejoin. Identical simultaneous removal undo remains unproved. [Structure][structure].
- Beat status frontiers do not establish arbitrary graph or tag/shot status handling. Detached-comment fallback has only the specified explicit-move proof; multiple movers and different-field arbitration remain open. [Marks][marks], [projection][proj].
- Historical capture metadata needs retention for round trips; overflow/recovery presentation and coupled-value concurrency remain unresolved. Missing-owner, deleted-registry, empty-scene/script, overlong-name and duplicate b-roll-key policies are proposed in Stage 0 but not comprehensively established here. [Projection][proj], [marks][marks], [structure][structure], [Stage 0 projection rules][hypotheses].

## Not measured or not run, carried forward

### Still owed for the Stage 1a exit

- **Open #1409:** writing-lifetime growth and remote-character cost for B. This serves section 11's schema-selection-or-revision clause, with section 5's requirement to record growth and the experiment index's PERF caps. The old synthetic failure does not answer that workload; no result from the open PR is credited. [#1409][1409], [exit][exit], [schema gate][schema-gate], [experiments][experiments], [performance][perf].
- **#1412 is merged, not open:** it serves the editing-trace clause by closing Split T02/boundary and retaining the next result, Split T03 FAIL 0/2 with replacement unrun. It does not establish a passing Split repeated-text binding. Writer/page T03 and both-surface T04 passes remain as bounded evidence, not proof of every Split native edit. [#1412][1412], [Split stale base][split-stale], [B counts][b-counts], [Split reconciliation][split-reconcile], [acceptance][acceptance].

**Coordinator decision, 2026-11-10:** the Split prototype series stops at the retained T03 native-whitespace failure. Reconciling browser-generated whitespace with captured intent and identities is a Stage 2 requirement. This records the scope decision; it is not evidence that T03 passed. The observed failure and unrun replacement are retained in [the merged report][split-stale] and [history][split-whitespace].

### What an eventual Stage 1a exit leaves to later stages

These are limits of a feasibility exit, not production acceptance or a waiver of the owed evidence above. Production integration remains behind its own gates. [Stage definitions][exit], [schema gate][schema-gate].

- Full shared command integration, visual/heading input and app-level comment/tag rendering. Enter, clipboard structure, Find replacement and local marks/status/media were isolated or unbound; the follow-up paste seam translates only one plain-text beat. Split T03 whitespace mapping and replacement remain outside a passing binding. [App][app], [B surfaces][b-surfaces], [Split stale base][split-stale].
- Autocorrect, drag/drop, protected atoms and grapheme/surrogate editing in the binding. Composition used protocol-driven events, not an OS input method; the plan requires synthetic data-safety evidence, not human IME acceptance. [App][app], [follow-up][follow], [product contract][product-contract].
- Production session publication, coalesced derivations, complete gallery/recovery/mark projection and the full production defect tests. The incremental projector equals its full prototype projector; that projector is not the complete structural/mark reader. [App][app], [projection][proj], [performance][perf].
- Browser input/message-to-frame, structural UI latency, complete join/load, standalone A/B, real-app heap, network, reconnect and receipt budgets. Node load/heap components do not establish them. M3's additional document memory/persistence cost remains unmeasured. [Performance][perf], [follow-up][follow].
- Crash-safe M1 editing queues, prolonged/cancelled buffers, overflow continuation, and durable recovery/compaction combined with the real editor and bounded undo. The full-document projection's available-blob resolution remains unproved here; service/storage/image selections and their separate evidence belong to the [Stage 1b decision][1b-decision]. [Buffer][buffer], [projection][proj], [performance][perf].
- General semantic redo, standalone grouping/parking/hold parity, identical tag/removal undo, later rejoin, arbitrary status graphs, multiple comment movers, duplicate b-roll-id assignment, gallery replacement/reorder concurrency and concurrent edits within opaque values. [Structure][structure], [marks][marks], [projection][proj], [app][app].
- Real-Writer provenance separating stored U+200B from presentation-only caret sentinels; merged overflow/uniqueness and the device-local-link experience. Passing canonical bytes does not settle these integration and product rules. [Lossless projection][lossless], [projection limits][proj].

## Requirements this places on Stage 2

These are the collected integration requirements, not permission to bypass the unresolved feasibility gate. Each source names the seam or missing contract. [Stage 2 definition][exit].

- Retain a paint snapshot with epoch, beat/segment version, runs, character identities and directed identity-relative selection. Capture native targets before mutation, retain initial composition selection separately from provisional ranges, and preserve identical/nonminimal replacement intent. [Buffer][buffer], [slice][slice], [#1390][1390].
- Intercept before whole-field `cellTextCommand`/`syncBeat`; commit intent against the retained base, insert before deleting observed identities, and route blur/leave/transition sync through the same boundary. Bind Enter, paste/cut, cross-beat/header and mark commands as semantic operations. [App seam inventory][app], [buffer][buffer], [follow-up paste seam][follow].
- On Split, intercept generic cell sync before whole-field replacement, retain the initial composition base, withhold provisional publication and commit the final buffer through `cellEditing.sync` in compositionend capture before the owner's bubble `dropEmptySince`. Retain the checked lifecycle/sync counts and real-cell selection mapping. The passing cases do not establish full shared undo grouping. [B surface seams][b-surfaces], [Split reconciliation][split-reconcile], [Split stale base][split-stale].
- Use one bounded M1 gate for every remote apply path, including provider sync, hydration and recovery. Preserve the native buffer and pending message at overflow, and define safe cancellation/recovery. The actual provider bypass must be closed. [Buffer][buffer], [provider history][provider-bypass].
- Preserve composing DOM nodes and its base across every repaint source. Outside composition, cancel known-stale native input, map intent, repaint synchronously and restore selection through the real DOM mapper, including sentinels. Composition-aware selection validation must use painted content when the live projection removes or joins its beat. [Slice][slice], [app][app], [follow-up][follow].
- Preserve genuinely unpainted focused cells when the binding declares a stale base; do not discharge T02 by repainting/rebasing before native input. #1410's nested render was a harness listener defect, not evidence requiring a new app blur guard. Keep both repair-removal controls; investigate other production publication/render paths separately. [Split reconciliation][split-reconcile], [Split stale base][split-stale].
- Reconcile browser-generated U+0020-to-U+00A0 changes outside the captured deletion range with target-evidenced intent and retained identities. Split T03 establishes the failure; a canonical whitespace rule and repair remain untested. Do not confuse it with remote formatting or a failed B/M1 schema. [Split stale base][split-stale], [native-whitespace history][split-whitespace].
- Carry stored U+200B and cue flags losslessly, and supply explicit node provenance for presentation-only caret padding. Flattened character values alone cannot distinguish those origins. Preserve the declared two-location exclusion and every other export byte. [Lossless projection][lossless], [exclusion][exclusions].
- Treat early-hold/native-paint-gate re-entry interventions as prototype evidence to evaluate against real call paths; they are not demonstrated extra production guards. [Follow-up][follow].
- Translate CRDT comment/tag/link marks, occurrence ids and registries into app marks; project anchors/recovery and use validated explicit mark-move commands to maintain detached fallback. Declare all typed roots before any apply/hydration. [Marks][marks], [projection][proj], [follow-up][follow].
- Publish local and remote changes through the session owner with precise affected-beat changes and pure derivations, preserving unchanged row objects. Replace the experiment's privileged stamp and bypassed generation/publication; remote projection must not stamp attribution, add undo or emit repairs. [App][app], [marks][marks], [performance][perf].
- Keep the session as the only projection writer. Migrate or refuse mutable readers, `held()` access, adoption/replay/amend/stamp, capability-bypassing comment commands and whole-document replacements. Replace automatic file/draft/stash/merge/save writers for a live shared instance, with epochs/capability checks for asynchronous completions. [App isolation/seam inventory][app], [editing contract][editing-contract].
- Implement semantic command history with per-writer joins/retirement, causal status undo, no-effect consumption and identity-based selection restoration. Resolve undo holds, typing groups, entry bounds, redo parking and composition ownership explicitly; do not copy the selective hold bypass. [Structure][structure], [marks][marks], [app][app].
- Integrate soft-removal observed identities, split-descendant classification, visual/gallery origin ownership and durable recovery into the full projection/export path. Resolve format overflow and uniqueness without silently discarding retained work; retain the lossless canonical text/cue and import-metadata controls. [Structure][structure], [marks][marks], [projection][proj], [lossless projection][lossless].
- Add affected-beat incremental projection/identity capture and measure it with the real session and renderer. Ownership transfers must invalidate old and new beats; tag-registry/comment-anchor changes may invalidate broadly. Retention, queue and undo budgets need an enforceable solution and measured growth. [Performance][perf], [#1400][1400].

## Open questions for the product owner

- What should a writer see and be able to do when a held edit or retained recovery reaches its limit? [Overflow evidence][overflow], [performance][perf].
- How should overflow pictures/props, competing posters/headings, duplicate people/tag names and retained but unexported work be shown and resolved? [Projection limits][proj].
- Keep the assumed crossing-tag recovery display, removed-comment reply recovery and concurrent-status notices? [Marks][marks], [assumed product decisions][experiments].
- How should a scene with no beats, an empty script, an overlong merged scene name, missing owner or duplicate b-roll key appear and export? [Assumed projection rules][hypotheses].
- Which visible undo differences, if any, are acceptable for typing groups, the history limit, redo parking, composition and a stuck save? [App undo gaps][app], [undo contract][editing-contract].
- Keep comments as two undo steps and let saving the same author's open draft replace its concurrently changed body? [Assumed decisions 11–12][experiments].
- What does another person see for a link whose location exists only on the first person's device? Name/size/poster survive, but that experience is not established by byte exclusion. [Lossless projection][lossless].

## Corrections owed to the Stage 0 files

These are corrections/qualification owed to the audit, not edits made by this record. Proposed oracles stay fixed unless the product owner changes them. [Experiment rules][experiments].

- [9-stage-1-experiments.md:66](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/9-stage-1-experiments.md#L66): the 93-to-96 correction is completed on main by [#1405][1405]. [Checked inventory][proj].
- [2-fields.md:289](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/2-fields.md#L289): reconcile “60 pictures” with 60 additional/61 total at line 64; merged overflow is 62. [Projection limits][proj].
- [2-fields.md:110](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/2-fields.md#L110) and [line 175](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/2-fields.md#L175): qualify comment `updatedAt` derivation; reply times alone cannot reproduce assignment/reopening history, so round trips retain the loaded value. [Projection departures][proj].
- [8-schema-hypotheses.md:128](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/8-schema-hypotheses.md#L128) and [line 336](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/8-schema-hypotheses.md#L336): qualify absence/regeneration of `rev`/`lastEdited*` and derivation of colors; historical capture values must be retained for round trips. The shared edit-stamp rule is decided in [#1405][1405]. [Projection][proj].
- [8-schema-hypotheses.md:140](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/8-schema-hypotheses.md#L140): mark A-H7 refuted for these public capture calls, with indexing/batching as an untested alternative. [Performance][perf].
- [8-schema-hypotheses.md:142](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/8-schema-hypotheses.md#L142): qualify A-H9; local-origin isolation is established, complete standalone grouping is not, and native per-writer T06 undo fails. [Structure][structure], [app][app].
- [8-schema-hypotheses.md:143](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/8-schema-hypotheses.md#L143), [line 148](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/8-schema-hypotheses.md#L148) and [2-fields.md:286](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/2-fields.md#L286): record that A-H10 now passes the corpus with the exact device-local exclusion and PROJ-cue requires stored flags; line-only derivation remains refuted. Retain the initial failed histories as superseded evidence. [Lossless projection][lossless], [#1406][1406].
- [8-schema-hypotheses.md:243](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/8-schema-hypotheses.md#L243): qualify the expected B T08 failure: create/race pass with head conversion and embed insertion in one transaction. [Structure][structure].
- [8-schema-hypotheses.md:253](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/8-schema-hypotheses.md#L253): repeated-text failure is conditional on missing target evidence and affects all mechanisms; retained targets disambiguate the tested M2 edits. [Buffer][buffer], [slice][slice], [#1390][1390].
- [8-schema-hypotheses.md:249](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/8-schema-hypotheses.md#L249): distinguish the library's 500 ms default from the prototype's explicit 1000 ms setting; neither proves complete product grouping or a 200-entry bound. [App correction][app].
- [8-schema-hypotheses.md:124](https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/stage-0/8-schema-hypotheses.md#L124): label overflow recovery as an unmet proposed policy; the full projector returns 62 pictures with no recovery entry and app export drops one. [Projection][proj].

[issue]: https://github.com/RetroGorilla/splitpage/issues/1376
[exit]: ../../COLLABORATION-PLAN.md#11-implementation-stages
[schema-gate]: ../../COLLABORATION-PLAN.md#schema-decision-gate
[schema-requirements]: ../../COLLABORATION-PLAN.md#schema-requirements
[acceptance]: ../../COLLABORATION-PLAN.md#13-acceptance-evidence
[candidates]: ../../COLLABORATION-PLAN.md#candidate-representations
[product-contract]: ../../COLLABORATION-PLAN.md#2-product-contract
[editing-contract]: ../../COLLABORATION-PLAN.md#4-editing-and-command-contract
[hypotheses]: ../stage-0/8-schema-hypotheses.md
[api-questions]: ../stage-0/8-schema-hypotheses.md#6-supported-api-questions
[experiments]: ../stage-0/9-stage-1-experiments.md
[product-decisions]: ../stage-0/9-stage-1-experiments.md#product-decisions
[1b-decision]: 1b-decision.md
[buffer]: ../../../prototypes/collab/buffer-results.md
[slice]: ../../../prototypes/collab/slice-results.md
[structure]: ../../../prototypes/collab/structure-results.md
[marks]: ../../../prototypes/collab/mark-results.md
[proj]: ../../../prototypes/collab/projection-results.md
[app]: ../../../prototypes/collab/app-binding-results.md
[follow]: ../../../prototypes/collab/app-binding-2-results.md
[measurements]: ../../../prototypes/collab/app-binding-2-measurements.md
[perf]: ../../../prototypes/collab/perf-results.md
[b-surfaces]: ../../../prototypes/collab/b-surfaces-results.md
[b-counts]: ../../../prototypes/collab/b-surfaces-counts.md
[split-reconcile]: ../../../prototypes/collab/split-reconcile-results.md
[split-stale]: ../../../prototypes/collab/split-stale-results.md
[lossless]: ../../../prototypes/collab/src/proj/lossless-results.md
[exclusions]: ../../../prototypes/collab/src/proj/exclusions.ts
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
[composition-structure]: ../../../prototypes/collab/histories/T04-app-structural-composition.md
[composition-marks]: ../../../prototypes/collab/histories/T04-app-remote-marks.md
[provider-bypass]: ../../../prototypes/collab/histories/T04-provider-bypass.md
[overflow]: ../../../prototypes/collab/histories/T04-long-composition.md
[reentry]: ../../../prototypes/collab/histories/T02-app-sync-reentry.md
[roundtrip-b]: ../../../prototypes/collab/histories/PROJ-roundtrip-B.md
[native-join-a]: ../../../prototypes/collab/histories/T06-native-undo-A.md
[native-join-b]: ../../../prototypes/collab/histories/T06-native-undo-B.md
[top-item]: ../../../prototypes/collab/histories/U-H1-top-item-B.md
[native-undo]: ../../../prototypes/collab/histories/T03-browser-native-undo.md
[undo-hold]: ../../../prototypes/collab/histories/T03-app-undo-hold.md
[insert-first]: ../../../prototypes/collab/histories/T01-composition-delete-first.md
[limit-people]: ../../../prototypes/collab/histories/PROJ-limit-people-B.md
[limit-tags]: ../../../prototypes/collab/histories/PROJ-limit-tags-B.md
[limit-gallery]: ../../../prototypes/collab/histories/PROJ-limit-gallery-B.md
[limit-props]: ../../../prototypes/collab/histories/PROJ-limit-props-B.md
[limit-poster]: ../../../prototypes/collab/histories/PROJ-limit-poster-B.md
[limit-heading]: ../../../prototypes/collab/histories/PROJ-limit-heading-B.md
[split-repaint]: ../../../prototypes/collab/histories/T04-B-split-repaint.md
[split-localization]: ../../../prototypes/collab/histories/T04-Split-repaint-localization.md
[split-stale-parent]: ../../../prototypes/collab/histories/T02-Split-stale-cell.md
[split-stale-history]: ../../../prototypes/collab/histories/T02-Split-stale-contract.md
[split-whitespace]: ../../../prototypes/collab/histories/T03-Split-native-whitespace.md
[1385]: https://github.com/RetroGorilla/splitpage/pull/1385
[1387]: https://github.com/RetroGorilla/splitpage/pull/1387
[1388]: https://github.com/RetroGorilla/splitpage/pull/1388
[1389]: https://github.com/RetroGorilla/splitpage/pull/1389
[1390]: https://github.com/RetroGorilla/splitpage/pull/1390
[1391]: https://github.com/RetroGorilla/splitpage/pull/1391
[1392]: https://github.com/RetroGorilla/splitpage/pull/1392
[1394]: https://github.com/RetroGorilla/splitpage/pull/1394
[1396]: https://github.com/RetroGorilla/splitpage/pull/1396
[1399]: https://github.com/RetroGorilla/splitpage/pull/1399
[1400]: https://github.com/RetroGorilla/splitpage/pull/1400
[1405]: https://github.com/RetroGorilla/splitpage/pull/1405
[1406]: https://github.com/RetroGorilla/splitpage/pull/1406
[1407]: https://github.com/RetroGorilla/splitpage/pull/1407
[1409]: https://github.com/RetroGorilla/splitpage/pull/1409
[1410]: https://github.com/RetroGorilla/splitpage/pull/1410
[1412]: https://github.com/RetroGorilla/splitpage/pull/1412
