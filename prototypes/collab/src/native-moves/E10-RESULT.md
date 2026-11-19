# E10 move ranks and placement

Take run ranks forward as the move design to test once deletion is resolved. They carry an unseen split and keep a moved run at its destination when its first beat is deleted, with a reader that sorts keys and scans cuts. Adoption should wait for a deletion rule that keeps concurrent edits reachable, a decision on what undo may move, and timing within the move budget.

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
| undo remote move | 8 | 1 / 7 / 0 | 0 / 8 / 0 | 1 / 7 / 0 |
| undo remote edit | 8 | 1 / 7 / 0 | 1 / 7 / 0 | 1 / 7 / 0 |
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
| **Total** | **229** | **142 / 65 / 22** | **71 / 136 / 22** | **135 / 72 / 22** |

The counts combine 29 two-writer named histories and 200 three-writer generated histories per design. Delivery was in command order, reversed within a send, duplicated, shuffled within a send, or a fresh state difference. One late copy saw the first edit and later caught up. A second late copy opened the final saved state. The same commands, clients and deliveries ran for all three designs. One in five generated histories gives the third writer 40 extra offline typing operations plus undo and redo. One in four adds several offline drops. One in three exchanges updates and continues editing before the final merge.

All 22 broken histories per design involved real deletion. Eight lost a concurrent visual edit and record field on B. Seven lost a concurrent record field on the deleted segment head D. Seven stranded concurrent narration at D's old text position. All copies agreed in these cases. No delivery needed placement's old fallback.

Run ranks had fewer preferred outcomes. In generated history 1, a third writer creates and hides a heading before E while B is moved after F and joined up. The heading cuts the destination run even when its label is hidden. With run ranks, B becomes the first row in Q and the join has no row above it. Flat and placement join B to F. In generated history 6, the same third-writer cut changes the landing spot for B and its unseen split. They still travel together, and appear at the start of Q.

## Named histories

The two scenes are P with A–D and Q with E–H. Each beat has two unique narration letters and one unique visual letter. D also tests the first beat in a segment. Unless specified, the move is B after F and the second command is concurrent. These expectations are declared in `test/native-moves/e10-model.ts` before replay.

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
| Undo and redo after another move | The collaborator sees B after F, then puts B after H. The first writer's undo and redo leave that move alone. | Flat and placement leave B after H on both presses. Run leaves B there but drags C after it on undo. Redo puts C back. |
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

## Rules each design adds

All three use ordinary Yjs map writes for ordering. Text stays in its original segment and visual cell on moves. The E3 undo layer scopes the whole command, including headings. The history generator gives each typing command its own undo entry. The timing run uses E3's keystroke path. Real beat deletion deletes the observed text range, the boundary or segment head, the beat record, and the visual cell in one transaction. The E9 branch was unavailable when this experiment needed the writer, so this uses a local plain delete. Heading removal still uses the E5 flag.

- **Flat ranks.** Give every block a key. Sort keys, using natural text order for ties. A split copies its parent's key. A move rekeys each selected block and opens any tied gap by rekeying the right side. A new heading gets its own key.
- **Run ranks.** Give each segment an initial key, and scan its blocks in typing order. Each explicit cut starts a run. Sort by run key, with text order for ties. A move cuts the pieces it separates at the source and destination, then rekeys the moved pieces. A new heading starts a run. A cut is stored on the segment and uses a Yjs relative position, a reference that stays near the same text through edits. After the first beat is deleted, the cut applies at the next boundary unless that boundary already has its own cut. When several deleted starts meet at one position, the last cut by id wins. Every copy resolves the position from shared state alone.
- **E7 placement.** Use natural order for unplaced blocks, and place changed blocks after their named anchors. Sort several children of an anchor by stamp and id. Keep a moved block's unseen split-offs with it up to the recorded end or next unplaced heading. Drop the older placement in an anchor loop. Rewrite dependents that should stay behind, and recheck the requested order while planning. A split may rewrite existing anchors, and a heading created above a moved beat may get a placement of its own. A deleted anchor invalidates its placement. E10 stops and reports a planner failure if the old write-every-block fallback would run.

Both rank designs use a base-62 string and a writer and write number after an open digit. Different writers choosing the same gap get distinct sortable keys. Equal stored keys from splits keep text order. Opening a gap between equal keys rekeys the right edge to make room. The narrow-gap test repeatedly inserts between keys originally created in the same gap. After 1,000 insertions the longest key across the three tested schedules was 222 ASCII characters. The two other schedules reached 188. The allocation can keep extending the key as the gap tightens.

## Cost

Node 24.22.1, x64. The script has 300 beats for bytes, with 63 narration and 21 visual characters per beat. The same 1,000 row moves ran in each design. Every final order was checked against a list splice. The scene layout stores ten beats together. The own layout starts each beat in its own segment. Move packets below are for one row, five rows, and a scene, in that order. Kept bytes are measured from a fresh load after 1,000 moves. Added bytes per character include the initial rank keys and count the narration and visual characters.

| Layout | Design | Move update bytes (row / run / scene) | Starting bytes | Kept bytes per move | Added bytes per character |
| --- | --- | ---: | ---: | ---: | ---: |
| scene | flat | 38 / 149 / 314 | 54,647 | 9.19 | 0.684 |
| scene | run | 187 / 187 / 65 | 47,332 | 23.35 | 0.956 |
| scene | placement | 43 / 199 / 425 | 46,599 | 18.50 | 0.734 |
| own | flat | 38 / 149 / 314 | 72,092 | 9.19 | 0.684 |
| own | run | 67 / 314 / 682 | 72,090 | 21.75 | 1.183 |
| own | placement | 36 / 164 / 355 | 64,037 | 16.77 | 0.665 |

Times are milliseconds, median / p95 after 12 warm-up runs. Order and move measurements use 60 samples. Keystrokes use 120 per beat. Order reading uses the block order reader. Move includes the command and projected row rebuild. Keystrokes include the E3 layer and row refresh. Before timing, one third as many moves as beats were applied. A moved and a never-moved beat were used for typing.

| Layout | Design | Beats | Read order | Move one row | Type in moved beat | Type in unmoved beat |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| scene | flat | 30 | 0.017 / 0.038 | 0.209 / 0.260 | 0.083 / 0.108 | 0.076 / 0.146 |
| scene | flat | 300 | 0.192 / 0.225 | 1.962 / 2.722 | 0.072 / 0.080 | 0.061 / 0.118 |
| scene | flat | 900 | 0.516 / 0.726 | 6.372 / 8.134 | 0.086 / 0.173 | 0.067 / 0.110 |
| scene | run | 30 | 0.026 / 0.028 | 0.206 / 0.241 | 0.066 / 0.076 | 0.062 / 0.075 |
| scene | run | 300 | 0.268 / 0.331 | 2.214 / 3.011 | 0.061 / 0.075 | 0.060 / 0.082 |
| scene | run | 900 | 0.867 / 0.929 | 7.023 / 8.353 | 0.072 / 0.123 | 0.070 / 0.086 |
| scene | placement | 30 | 0.025 / 0.038 | 0.265 / 0.393 | 0.062 / 0.073 | 0.067 / 0.074 |
| scene | placement | 300 | 0.260 / 0.281 | 2.444 / 3.177 | 0.067 / 0.095 | 0.071 / 0.078 |
| scene | placement | 900 | 0.750 / 0.889 | 7.517 / 8.845 | 0.066 / 0.073 | 0.062 / 0.112 |
| own | flat | 30 | 0.019 / 0.020 | 0.199 / 0.341 | 0.018 / 0.021 | 0.019 / 0.023 |
| own | flat | 300 | 0.197 / 0.356 | 2.102 / 3.071 | 0.024 / 0.042 | 0.023 / 0.037 |
| own | flat | 900 | 0.588 / 0.844 | 6.918 / 8.602 | 0.019 / 0.026 | 0.020 / 0.026 |
| own | run | 30 | 0.047 / 0.055 | 0.254 / 0.309 | 0.017 / 0.020 | 0.017 / 0.022 |
| own | run | 300 | 0.524 / 0.671 | 2.833 / 3.327 | 0.017 / 0.021 | 0.020 / 0.030 |
| own | run | 900 | 1.793 / 2.641 | 9.248 / 11.471 | 0.018 / 0.024 | 0.018 / 0.022 |
| own | placement | 30 | 0.028 / 0.033 | 0.271 / 0.348 | 0.022 / 0.029 | 0.020 / 0.027 |
| own | placement | 300 | 0.300 / 0.442 | 2.633 / 3.513 | 0.019 / 0.024 | 0.019 / 0.030 |
| own | placement | 900 | 0.837 / 0.921 | 7.979 / 9.366 | 0.017 / 0.023 | 0.018 / 0.024 |

All three medians at 900 beats were below 8 ms in the shared-segment layout in the final run. Run ranks took 9.248 ms when each beat had its own segment. Earlier runs put all three over 8 ms. In the shared-segment layout, run ranks had the biggest row packet and the smallest whole-scene packet. Typing times in moved and unmoved beats were close within each layout. A move also rebuilds the rows.

## Silent-write controls

Each named history and the first 20 generated histories were re-run to the same command prefix. The test mutes each encountered public Yjs write once, and also mutes the whole command where it contains multiple writes. A press is muted at the public undo or redo call. Yjs owns the writes inside a press. A throw or changed call coverage is a failed control run. An effective mute changes the stored state on a run that completes. A detected mute fails a command check at that step. The test prints each call family within each command, with separate checks for the cuts in a multi-write move.

| Design | Used | Effective | Detected at command | Throws | Coverage failures | Effective mutes missed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| flat | 1,054 | 1,025 | 1,025 | 25 | 0 | 0 |
| run | 1,148 | 1,147 | 1,143 | 1 | 0 | 4 |
| placement | 1,001 | 997 | 997 | 0 | 0 | 0 |

Flat's 25 thrown controls suppress the creation of a heading record that the rank writer then needs. Run's one throw suppresses the creation of a standalone heading segment that the cut writer then needs. Run missed four effective undo or redo mutes in the later-move history. The independent content checks agreed while the full order expectation was contested. Those mutes and the throws leave the control requirement incomplete for both rank designs. Placement detected every completed effective mute.

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
3. Is carrying an unseen split worth the extra cuts and stored positions?
   - **A.** Continue with run ranks. Both halves follow the move, and a moved run can survive losing its first beat. Same-spot cuts can sometimes change which scene contains another beat.
   - **B.** Use flat ranks if the split rule can change. A concurrent split-off can stay at the source. Most moves write one simple key.

## Least sure

The tests put local undo under more pressure than E7, but they still use small generated scripts and one shared undo manager per person. Deleted run cuts are durable metadata. The findings leave open how much they accumulate in a long-lived script, and whether an old cut changes a later drop near several deleted boundaries. The tied-gap stress tests only three repeated insertion schedules. The ledger can detect missing and doubled data while allowing a letter to change owners in a contested merge. The named histories give exact ownership in the cases where that should determine the decision.

Run `npm test` in `prototypes/collab` for the comparison. The `E10_SEEDS` environment variable controls the generated count. Run `node src/native-moves/e10-measure.ts` from the same directory for the costs.
