# E10 move ranks and placement

## Findings

| Design | Rules added by the prototype | What a person sees when working alone | What can change when moves race other edits |
| --- | --- | --- | --- |
| Flat ranks | A key per block, text order for ties, a copied key on split, a new key for a moved block or a heading, and rekeying to open tied gaps. | A move keeps its destination if the landing beat or the first beat of the moved run is deleted. | An unseen split-off stays at the source. Opposing swaps can satisfy neither requested neighbour. |
| Run ranks | A key per segment, cuts that start stretches of beats with a shared key, fresh keys on moves and headings, and durable cut positions that can outlive a deleted run start. | Rows and scenes go to the drop. A move keeps its destination through the same deletions. | Both halves of an unseen split travel. Competing cuts can put a drop at the top of a scene, leave a scene's beats behind, or shift a different beat on undo. |
| E7 placement | Anchors, stamps, rules for unseen split-offs and loops, and rewrites for dependent placements, splits and headings. | Deleting the landing beat sends the moved row home. Deleting the first beat of a moved run sends the surviving part home. | Both halves of an unseen split travel. A split can overwrite a deliberate second move. Overlapping moves can change a beat's scene. |

The collision tables give the outcome of each kind of race. All move-rule differences observed here left copies in agreement and beats editable. The same 22 histories in every design broke the data rules through real deletion. The choice about the unseen half of a split belongs to the owner.

## Collision outcomes

A beat is a script row before joins. A segment stores the text of several beats in typing order, with an embed marking each beat boundary. A run is a stretch of beats in one segment that the reader shows together. A rank is a sortable text key. A cut starts a run.

Each cell gives **preferred / other editable / broken**. A history counts once, across five deliveries. A history is broken if any delivery loses data or access, disagrees, crashes, or fails a single-writer command check. A history is preferred only if all five match the expectation. Each generated history has one scheduled collision or check from the table. Other edits can also affect its result.

| History | Histories per design | Flat | Run | Placement |
| --- | ---: | ---: | ---: | ---: |
| join moving | 8 | 7 / 1 / 0 | 1 / 7 / 0 | 7 / 1 / 0 |
| join next | 8 | 6 / 2 / 0 | 7 / 1 / 0 | 6 / 2 / 0 |
| split landing | 8 | 6 / 2 / 0 | 1 / 7 / 0 | 6 / 2 / 0 |
| heading at source | 8 | 6 / 2 / 0 | 0 / 8 / 0 | 6 / 2 / 0 |
| scene overlap | 8 | 8 / 0 / 0 | 8 / 0 / 0 | 8 / 0 / 0 |
| split moving | 8 | 0 / 8 / 0 | 1 / 7 / 0 | 6 / 2 / 0 |
| same beat | 8 | 6 / 2 / 0 | 1 / 7 / 0 | 6 / 2 / 0 |
| opposing moves | 8 | 0 / 8 / 0 | 0 / 8 / 0 | 6 / 2 / 0 |
| same run cut | 8 | 7 / 1 / 0 | 0 / 8 / 0 | 7 / 1 / 0 |
| delete moving | 8 | 6 / 2 / 0 | 6 / 2 / 0 | 6 / 2 / 0 |
| delete landing | 8 | 6 / 2 / 0 | 1 / 7 / 0 | 0 / 8 / 0 |
| delete run start | 8 | 6 / 2 / 0 | 1 / 7 / 0 | 0 / 8 / 0 |
| heading at destination | 8 | 7 / 1 / 0 | 1 / 7 / 0 | 7 / 1 / 0 |
| rename moved heading | 8 | 6 / 2 / 0 | 1 / 7 / 0 | 6 / 2 / 0 |
| remove moved heading | 8 | 6 / 2 / 0 | 1 / 7 / 0 | 6 / 2 / 0 |
| undo remote move | 8 | 6 / 2 / 0 | 0 / 8 / 0 | 6 / 2 / 0 |
| undo remote edit | 8 | 7 / 1 / 0 | 1 / 7 / 0 | 7 / 1 / 0 |
| undo ranked split | 8 | 6 / 2 / 0 | 6 / 2 / 0 | 6 / 2 / 0 |
| late joiner | 8 | 6 / 2 / 0 | 1 / 7 / 0 | 6 / 2 / 0 |
| delete while editing | 8 | 0 / 0 / 8 | 0 / 0 / 8 | 0 / 0 / 8 |
| undo real deletion | 8 | 7 / 1 / 0 | 7 / 1 / 0 | 7 / 1 / 0 |
| two splits | 8 | 6 / 2 / 0 | 6 / 2 / 0 | 6 / 2 / 0 |
| move after seen split | 8 | 6 / 2 / 0 | 1 / 7 / 0 | 6 / 2 / 0 |
| split housekeeping vs move | 8 | 7 / 1 / 0 | 6 / 2 / 0 | 0 / 8 / 0 |
| heading above segment head | 8 | 7 / 1 / 0 | 1 / 7 / 0 | 7 / 1 / 0 |
| delete segment head | 8 | 1 / 0 / 7 | 1 / 0 / 7 | 1 / 0 / 7 |
| delete head while typing | 7 | 0 / 0 / 7 | 0 / 0 / 7 | 0 / 0 / 7 |
| drop between tied halves | 7 | 5 / 2 / 0 | 5 / 2 / 0 | 5 / 2 / 0 |
| drop onto heading | 7 | 6 / 1 / 0 | 6 / 1 / 0 | 6 / 1 / 0 |
| **Total** | **229** | **153 / 54 / 22** | **71 / 136 / 22** | **146 / 61 / 22** |

The counts combine 29 two-writer named histories and 200 three-writer generated histories per design. Delivery was in command order, reversed within a send, duplicated, shuffled within a send, or a fresh state difference. One late copy saw the first edit and later caught up. A second late copy opened the final saved state. The same commands, clients and deliveries ran for all three designs. One in five generated histories gives the third writer 40 extra offline typing operations plus undo and redo. One in four adds several offline drops. One in three exchanges updates and continues editing before the final merge.

All 22 broken histories per design involved real deletion. Eight lost a concurrent visual edit and record field on B. Seven lost a concurrent record field on the deleted segment head D. Seven stranded concurrent narration at D's old text position. All copies agreed in these cases. No delivery needed placement's old fallback.

The old press check judged every writer against the first writer's requested undo or redo. After putting histories with the third writer's random drops in their own bucket, that check mis-scored 11 generated histories in each design. It now applies only to the first writer. Eleven histories become preferred for flat ranks and placement. All eleven remain other for run ranks for separate reasons. Five reproduce the first writer's undo moving C into Q until redo. Six restore the right order on both presses, then the third writer's heading changes the merged landing spot.

| Design | Other before correction | Third writer's random drops | Unscoped press check | Named histories | Remaining generated histories in the old breakdown | Other after correction |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Flat | 65 | 42 | 11 | 2 | 5 unseen splits, 5 opposing moves | 54 |
| Run | 136 | 42 | 11 | 4 | 79 affected by the third writer's hidden heading | 136 |
| Placement | 72 | 43 | 11 | 3 | 5 deleted landing beats, 5 deleted run starts, 5 split rewrites | 61 |

Flat's two named exceptions are an unseen split and opposing moves. Placement's three are the same three collisions as its remaining generated histories. Its split rewrite can replace the deliberate second move. Run's four named exceptions are a heading at the source, opposing moves, competing cuts and undo after another move. The random drops add separate move intentions to the order that the fixture is scoring.

**One cause was counted 79 times.** The third writer creates and hides a heading above E in every generated history. The heading starts a run with a fresh rank and E takes that new rank by inheritance. The planner proposes a fresh rank for E, but the writer omits the separate cut in this fixture. The raw-copy test checks that distinction. Hiding the heading leaves the cut in place. Concurrent keys chosen in the same gap are ordered by the writer suffix.

| Effect of that heading in the 79 histories | Histories |
| --- | ---: |
| Dropped beat or beats appear at the top of Q | 53 |
| The new destination heading appears at the top of Q, directly after the dropped beat and before E | 6 |
| Q moves to the top while its four beats stay under P, with Q renamed | 5 |
| Q's heading moves while its four beats stay under P, with Q hidden | 5 |
| Opposing moves send E to the end of Q | 5 |
| After deletion of the first beat of the moved run, the surviving beat lands at the top of Q | 5 |

Replaying without the third writer's create-and-hide pair changed the order in all 79. It restored the preferred order in 63. In the other 16, the primary collision still produced a different editable order. Those were six competing cuts, five source headings and five opposing moves. The same replay restored the preferred order in the six run-rank undo-after-edit histories that the old press check had masked.

## Named histories

The two scenes are P with A–D and Q with E–H. Each beat has two unique narration letters and one unique visual letter. D also tests the first beat in a segment. Unless specified, the move is B after F and the second command is concurrent. The six provisional answers and the code landed in one commit. The file history cannot establish when those expectations were written.

| History | Expected | What a person sees |
| --- | --- | --- |
| Join moving beat | B joins the row above its destination | All three show F and B as one row under Q. |
| Join next beat | Move E below H while someone joins F up. F stays at the source. | All three leave F as the first row under Q. |
| Split landing beat | Split F. B can be between the halves or after both. | Placement puts B between. Both ranks put it after both. |
| Heading at source | Create R above B. R stays before C at the source. | Flat and placement show R before C. Run shows C before R. R stays in the source area and D becomes its first row. |
| Scene overlap | Move Q to the top while F moves after A. A mixed order is fine. | Flat leaves G and H under Q. Run shows them after D under P. Placement shows them after F under P. All beats are editable. |
| Split moving beat | Split B into c and d. Both halves travel below F. | Run and placement show c then d below F. Flat shows c below F and d back at the source. |
| Same beat | Also move B after H. One of the drops wins. | Run shows B after F. Flat and placement show B after H. There is one B in each. |
| Opposing moves | Also put F after B. Prefer one requested neighbour. | Placement keeps B after F. With either rank, F goes to P between A and C and B goes to Q after E. |
| Cut the same run | A moves B below F and B's collaborator moves B–C below H. Prefer C below H. | Flat and placement show B–C below H. Run shows B below F and leaves C at the source. The two writers also write the same cut key for C. |
| Delete moving beat | Delete B. The surrounding beats stay put. | B and its visual disappear in all three. |
| Delete landing beat | Delete F. B should stay in the landing gap. | Both ranks show B between E and G. Placement sends B back to P because F is gone. |
| Delete run start | Move B–C below F and delete B. C should still travel. | Both ranks show C after F. Placement sends C back to P. |
| Heading at destination | Create R before G. R should sit between B and G. | All three show that order. |
| Rename moved heading | Move Q to the top and type in its name. | All three show Q at the top with the new name. |
| Remove moved heading | Move Q to the top and hide its heading. | All three show E–H at the top with Q in heading recovery. |
| Undo and redo after another move | The collaborator sees B after F, then puts B after H. The first writer's undo and redo leave that move alone. | Flat and placement leave B after H on both presses. Run leaves B there and moves C after it on undo. C stays in the other scene after copies settle. It returns when the first writer presses redo. |
| Undo and redo after an edit | The collaborator types q in B. Undo takes B home; redo moves it back. | All three preserve cqd through both presses. |
| Undo ranked split | Split B, let the other writer move its new half, then undo the split. | All three show B as editable cd at the source. C stays put. |
| Late joiner | Move B and type W in its visual. | Catch-up and fresh load show B after F with W in the visual. |
| Delete while editing | Delete B while the other writer adds W to the visual and writes a record field. Unseen data should stay reachable. | All three lose W and the field. |
| Undo and redo real deletion | Move B, share the move, then delete B. Undo should restore B at the destination and redo should delete it. | All three restore it at the destination and remove it again. |
| Two splits | Split B before c and between c and d. The new halves should read in typing order. | All three show the empty original beat, then c, then d. |
| Move after seeing split | Split B and share it before moving B. Only the selected half should move. | All three leave the split-off half at the source. |
| Split housekeeping versus move | Share the first drop. The first writer splits F while the other puts B after H. Prefer the deliberate move. | Flat and run show B after H. Placement's split rewrite wins and B stays after both halves of F. |
| Heading above segment head | Move D after F while someone creates R above D. | All three leave R empty at the source. |
| Delete segment head | Move D after F while someone deletes it. | All three show D gone with the other beats in place. |
| Delete segment head while typing | Also type q in D before hearing about deletion. | All three keep q in segment storage with no row that exposes it. |
| Drop between tied halves | Split B, share it, then move D between the halves. | All three show D between c and d. |
| Drop onto heading | Drop B on Q. B should be Q's first beat. | All three start a paragraph at B under Q. |

Scene membership follows visible headings. The checks include every visible row's scene, join members, and paragraph starts in single-writer views. Paragraph starts come from the first row in a scene or the stored paragraph flag. The prototype exercises those starts. Product commands can also reassign stored paragraph flags. The move accepts the inputs used by `src/application/commands/rows.ts` and `scenes.ts`. It takes row or scene ids, the target id and side, or a target scene heading. A run supplies its first and last row ids. The keyboard command resolves an adjacent id and side before it moves.

Single-writer checks reproduce placement's deletion behavior. Move B below F, then delete F. B returns to P. Move B–C below F, then delete B. C returns to P. Both rank designs keep the surviving beat in Q, and all three keep its narration editable.

## Three run-rank heading variants

The short raw-copy tests create R in one copy and move beats in another. They test the existing fresh cut, the same cut using the run's old rank, and an absent cut. The six destination cases create R above E while someone moves B below F or H, B–C below F or H, D below F, or all of Q to the top.

| Heading cut | Preferred in six destination cases | Move Q to the top | Create R above C and move B–C | Create R above C and move only B |
| --- | ---: | --- | --- | --- |
| Fresh rank | 0 | Q moves with its name alone. E–H stay below P and the inserted heading. | C stays at the source with R. | C ends up above R at the source. |
| Run's old rank | 5 | Q still moves with its name alone. | C still stays at the source with R. | R stays before C at the source. |
| Absent cut | 6 | Q travels with its beats and R. | R travels between B and C. | R rides with B below F and puts G and H under the new scene. |

Every variant tried has a heading-against-move problem in at least one of these cases. The variants are isolated tests of the reader and stored changes.

## Rules each design adds

All three use ordinary Yjs map writes for ordering. Text stays in its original segment and visual cell on moves. The E3 undo layer scopes the whole command, including headings. The history generator gives each typing command its own undo entry. The timing run uses E3's keystroke path. Real beat deletion deletes the observed text range, the boundary or segment head, the beat record, and the visual cell in one transaction. The E9 branch was unavailable when this experiment needed the writer, so this uses a local plain delete. Heading removal still uses the E5 flag.

- **Flat ranks.** Give every block a key. Sort keys, using natural text order for ties. A split copies its parent's key. A move rekeys each selected block and opens any tied gap by rekeying the right side. A new heading gets its own key.
- **Run ranks.** Give each segment an initial key, and scan its blocks in typing order. Each explicit cut starts a run. Sort by run key, with text order for ties. A move cuts the pieces it separates at the source and destination, then rekeys the moved pieces. A new heading starts a run. A cut is stored on the segment and uses a Yjs relative position, a reference that stays near the same text through edits. After the first beat is deleted, the cut applies at the next boundary unless that boundary already has its own cut. When several deleted starts meet at one position, the last cut by id wins. Every copy resolves the position from shared state alone.
- **E7 placement.** Use natural order for unplaced blocks, and place changed blocks after their named anchors. Sort several children of an anchor by stamp and id. Keep a moved block's unseen split-offs with it up to the recorded end or next unplaced heading. Drop the older placement in an anchor loop. Rewrite dependents that should stay behind, and recheck the requested order while planning. A split may rewrite existing anchors, and a heading created above a moved beat may get a placement of its own. A deleted anchor invalidates its placement. E10 stops and reports a planner failure if the old write-every-block fallback would run.

Both rank designs use a base-62 string and a writer and write number after an open digit. Different writers choosing the same gap get distinct sortable keys. Equal stored keys from splits keep text order. Opening a gap between equal keys rekeys the right edge to make room. The narrow-gap test repeatedly inserts between keys originally created in the same gap. After 1,000 insertions the longest key across the three tested schedules was 222 ASCII characters. The two other schedules reached 188. The allocation can keep extending the key as the gap tightens.

## Cost

Node 24.22.1, x64. The script has 300 beats for bytes, with 63 narration and 21 visual characters per beat. The same 1,000 row moves ran in each design. Every final order was checked against a list splice. The scene layout stores ten beats together. The own layout starts each beat in its own segment. Move packets below are for one row, five rows, and a scene, in that order. Kept bytes are measured from a fresh load after 1,000 moves. Added bytes per character include the initial rank keys and count the narration and visual characters.

| Layout | Design | Example update bytes (row / run / scene) | Mean over first 300 row moves | Mean over all 1,000 row moves | Starting bytes | Kept bytes per move | Added bytes per character |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| scene | flat | 38 / 149 / 314 | 37.52 | 37.87 | 54,647 | 9.19 | 0.684 |
| scene | run | 187 / 187 / 65 | 96.37 | 69.69 | 47,332 | 23.35 | 0.956 |
| scene | placement | 43 / 199 / 425 | 53.69 | 65.08 | 46,599 | 18.50 | 0.734 |
| own | flat | 38 / 149 / 314 | 37.52 | 37.87 | 72,092 | 9.19 | 0.684 |
| own | run | 67 / 314 / 682 | 63.24 | 59.66 | 72,090 | 21.75 | 1.183 |
| own | placement | 36 / 164 / 355 | 45.83 | 55.03 | 64,037 | 16.77 | 0.665 |

The 187-byte run-rank row example drops a middle beat and writes three cuts. The means count bytes sent by the same random sequence of row moves. For the first 300 moves, run ranks averaged 96.37 bytes in the shared-segment script and 63.24 with separate segments. The independent sample averaged about 102 and 65 bytes respectively. The mean falls over the longer sequence as shared segments gain cuts that later moves can reuse.

Times are milliseconds, median / p95 after 12 warm-up runs. Order and move measurements use 60 samples. Keystrokes use 120 per beat. Order reading uses the block order reader. Move includes the command and projected row rebuild. Keystrokes include the E3 layer and row refresh. Before timing, one third as many moves as beats were applied. A moved and a never-moved beat were used for typing.

| Layout | Design | Beats | Read order | Move one row | Type in moved beat | Type in unmoved beat |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| scene | flat | 30 | 0.018 / 0.026 | 0.201 / 0.267 | 0.076 / 0.109 | 0.078 / 0.093 |
| scene | flat | 300 | 0.165 / 0.192 | 1.945 / 3.206 | 0.060 / 0.087 | 0.059 / 0.090 |
| scene | flat | 900 | 0.478 / 0.574 | 6.443 / 8.228 | 0.077 / 0.103 | 0.069 / 0.082 |
| scene | run | 30 | 0.027 / 0.030 | 0.213 / 0.303 | 0.071 / 0.084 | 0.059 / 0.090 |
| scene | run | 300 | 0.274 / 0.305 | 2.217 / 2.836 | 0.061 / 0.069 | 0.057 / 0.080 |
| scene | run | 900 | 0.877 / 1.008 | 7.048 / 8.582 | 0.061 / 0.083 | 0.058 / 0.083 |
| scene | placement | 30 | 0.025 / 0.028 | 0.255 / 0.291 | 0.062 / 0.071 | 0.062 / 0.070 |
| scene | placement | 300 | 0.248 / 0.309 | 2.402 / 3.526 | 0.058 / 0.092 | 0.060 / 0.070 |
| scene | placement | 900 | 0.743 / 0.816 | 7.633 / 9.148 | 0.066 / 0.084 | 0.063 / 0.072 |
| own | flat | 30 | 0.020 / 0.023 | 0.214 / 0.284 | 0.018 / 0.028 | 0.018 / 0.025 |
| own | flat | 300 | 0.194 / 0.228 | 2.066 / 2.999 | 0.018 / 0.022 | 0.018 / 0.058 |
| own | flat | 900 | 0.593 / 1.161 | 6.500 / 7.688 | 0.018 / 0.022 | 0.017 / 0.022 |
| own | run | 30 | 0.048 / 0.049 | 0.254 / 0.443 | 0.019 / 0.022 | 0.019 / 0.024 |
| own | run | 300 | 0.503 / 0.719 | 2.706 / 3.283 | 0.016 / 0.023 | 0.017 / 0.023 |
| own | run | 900 | 1.614 / 2.565 | 9.958 / 13.398 | 0.023 / 0.058 | 0.021 / 0.033 |
| own | placement | 30 | 0.028 / 0.029 | 0.267 / 0.295 | 0.016 / 0.022 | 0.017 / 0.021 |
| own | placement | 300 | 0.279 / 0.347 | 2.509 / 3.636 | 0.016 / 0.019 | 0.016 / 0.021 |
| own | placement | 900 | 0.806 / 1.060 | 7.771 / 9.540 | 0.016 / 0.020 | 0.016 / 0.019 |

At 900 beats the rebuild accounted for 74–85% of a move. The timed transaction includes the rank writes and transaction cleanup. Planning includes finding the selection and the drop. Rebuild measures the call that reprojects every row. Each number below is a median in milliseconds, with the two runs shown in order.

| Layout | Design | Move median, two runs | Planning | Transaction | Rebuild | Rebuild share |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| scene | flat | 6.443 / 6.447 | 0.958 / 0.975 | 0.028 / 0.033 | 5.450 / 5.429 | 84.8 / 84.3% |
| scene | run | 7.048 / 6.969 | 1.319 / 1.306 | 0.035 / 0.039 | 5.647 / 5.531 | 80.8 / 80.4% |
| scene | placement | 7.633 / 7.537 | 1.735 / 1.829 | 0.032 / 0.041 | 5.746 / 5.566 | 76.2 / 75.2% |
| own | flat | 6.500 / 6.483 | 1.055 / 1.034 | 0.022 / 0.030 | 5.408 / 5.349 | 83.5 / 83.4% |
| own | run | 9.958 / 9.317 | 2.399 / 2.217 | 0.066 / 0.060 | 7.403 / 6.892 | 74.6 / 74.7% |
| own | placement | 7.771 / 8.039 | 1.989 / 2.047 | 0.034 / 0.032 | 5.712 / 5.805 | 73.8 / 73.8% |

The earlier 9.248 ms observation for run ranks with one segment per beat falls within the timings seen across runs. The independent rerun measured shared / own medians of 6.98 / 7.71 ms for flat, 7.87 / 8.41 ms for run and 7.49 / 6.93 ms for placement. Across the recorded runs, the spread in totals is comparable to or larger than the gaps between designs. Treat these differences, including crossing the proposed 8 ms budget, as run-to-run noise. The run-rank reader in this implementation scans every key in each segment it visits on every read to look for cuts whose start has been deleted.

## Silent-write controls

Each named history and the first 20 generated histories were re-run to the same command prefix. The test mutes each encountered public Yjs write once, and also mutes the whole command where it contains multiple writes. A press is muted at the public undo or redo call. Yjs owns the writes inside a press. A throw or changed call coverage is a failed control run. An effective mute changes the stored state on a run that completes. A detected mute fails a command check at that step. The test prints each call family within each command, with separate checks for the cuts in a multi-write move.

| Design | Used | Effective | Detected at command | Throws | Coverage failures | Effective mutes missed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| flat | 1,054 | 1,025 | 1,025 | 25 | 0 | 0 |
| run | 1,148 | 1,147 | 1,147 | 1 | 0 | 0 |
| placement | 1,001 | 997 | 997 | 0 | 0 | 0 |

Flat's 25 throws come from muting the heading record write. The next rank write encounters a missing record. Run's one throw comes from muting the standalone heading segment write. The cut writer then encounters a missing segment. These remain failed control runs because the writer threw before an assertion could detect the missing change. The first writer's contested presses now have explicit order witnesses. The order check detects all four previously missed mutes in the named later-move history and generated history 16.

## What the checks read from the implementation

| Read | What it limits |
| --- | --- |
| Shown order, rows, beat parts, fields, scene headings and recovery entries | These are the observed view. The command model supplies exact single-writer views and unchanged data. Named expectations cover selected merged orders. |
| Raw segment deltas, visual deltas, record fields and editor ranges | These inspect where characters are stored and whether each visible beat's cell can address them. The expected ledger comes from the fixture and commands, with a unique character for each insertion. It compares merged narration and visual letters as inventories. Exact ownership after a contested split is checked in the named witnesses. |
| Public delta formatting keys | The observer uses the native mark-name decoder to compare per-character bold and tag marks. The model supplies the expected mark names and characters. This leaves key decoding shared with the implementation. |
| Join flag and heading recovery flag | The model checks whether the flag exists and checks the named joined rows. The unused join target field is outside the contiguous join check. |
| Public raw rank and placement metadata | Used to verify a required cut at a new heading, a flat rank on a new block, and the re-pointed E7 anchor after a split. The checks do not infer expected contents or order from those values. |
| Which API calls ran; normal and muted raw state | Used to aim each mute and decide if it had a stored effect. That limits the controls to exercised paths and effects visible in the chosen fixture. The independent command checks decide detection. |
| Encoded updates, loaded bytes and wall-clock timings | These are cost observations from one synthetic script on one machine. Alternating writers, network latency and browser painting are outside the timing. |

The model imports neither Yjs nor the prototype. It applies commands to plain records for each writer and tracks content changes separately from order. At a contested merge it keeps the letter, mark, field and id ledger and uses invariants and the named outcome criteria. The writer chosen by Yjs is taken from the observed result. Generated counts describe these histories, with a deliberately repeated set of collisions. They do not estimate the rate in real shared editing.

## Owner questions

1. What should a deletion do with edits it could not have seen?
   - **A.** Preserve access to them. A person can recover the remote visual edit and record field and can reach q typed into the old segment head. The plain delete in this comparison would need a different design.
   - **B.** Treat the whole beat and its in-flight edits as deleted. The person sees the row disappear, and a remote editor can lose a keystroke or field edit. This would change the current data rule.
2. When one person undoes an earlier move after another person moves the same beat again, may a source cut shift a different beat?
   - **A.** Keep standard undo for all the cut writes. B stays after H, but C may follow it until redo.
   - **B.** Keep the other person's move and C's scene intact. This needs a narrower undo design and another measured comparison.
3. Should the unseen half of a split stay behind or travel with the other half?
   - **A.** Let the unseen half stay behind with flat ranks. Most row moves write one simple key.
   - **B.** Have both halves travel with run ranks. Cuts survive deletion of the first beat. Heading races and undo can change which scene contains another beat.
   - **C.** Have both halves travel with placement. A landing beat's deletion can send a move home, and split bookkeeping can override a second move.

## Least sure

The tests put local undo under more pressure than E7, but they still use small generated scripts and one shared undo manager per person. Deleted run cuts are durable metadata. The findings leave open how much they accumulate in a long-lived script, and whether an old cut changes a later drop near several deleted boundaries. The tied-gap stress tests only three repeated insertion schedules. The ledger can detect missing and doubled data while allowing a letter to change owners in a contested merge. The named histories give exact ownership in the cases where that should determine the decision.

Run `npm test` in `prototypes/collab` for the comparison. The `E10_SEEDS` environment variable controls the generated count. Run `node src/native-moves/e10-measure.ts` from the same directory for the costs.
