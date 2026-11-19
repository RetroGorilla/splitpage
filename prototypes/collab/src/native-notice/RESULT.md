# E12 · The offline-merge notice

**Verdict.** A restored beat can come back without an unseen visual edit, status, field value or tag. Both comparisons now flag those losses in the tested histories. With an ideal common base the comparison gave 64 false banners and missed 16 losses across 240 generated histories. With a record of one's own pending edits and no base it gave 46 false banners and missed the same 16. E13 found no dependable stock provider signal for the ideal base. A base that is too old can call someone else's edits yours. A base that is too new can hide your unacknowledged edit. The paired cuts show a narrower limit. Seen and unseen edits **inside deleted containers** can leave identical evidence. The tested narration cuts exposed differences through the reading or the received delete set.

A reading is a list of physical beats in display order, with stable id, scene, joined row, both marked cell readings, status and other record fields. A beat can be a member of a joined row. A run is a span with the same marks, or an inline object. A narration-only row has no beat id. Yjs readings use E9's reader in E10 flat-rank order. The E11 contracts use hand-written readings.

## Detection

An entry is right when the independent command and delivery record shows a loss of that kind for the person. A reverse entry can match the actual receiving row even if its first named source beat was only a candidate. A false banner is a banner for a person with no loss in that stretch. False entries can also appear beside valid ones. The trial shows a banner when its result has at least one entry. Each history counts once per column and kind. Table cells give **hit / false entry / missed**. The online warning is beat-level and receives credit for each loss on that beat even when it cannot name the cause.

| What clashed | With ideal base | Without base, own pending edits | Online delete signal |
| --- | ---: | ---: | ---: |
| Narration from a removed beat or undone creation | 14 / 22 / 0 | 14 / 8 / 0 | 17 / 26 / 0 |
| Visual text | 36 / 14 / 0 | 36 / 14 / 0 | 27 / 10 / 8 |
| Formatting or tags | 30 / 8 / 0 | 30 / 8 / 0 | 10 / 8 / 16 |
| Status or other recorded details | 44 / 8 / 0 | 44 / 8 / 0 | 24 / 16 / 12 |
| Join or separation | 14 / 0 / 0 | 14 / 0 / 0 | 0 / 0 / 10 |
| Split whose new beat lost its suffix | 14 / 0 / 0 | 14 / 0 / 0 | 0 / 0 / 10 |
| Split-off half left behind after a move | 14 / 16 / 16 | 14 / 8 / 16 | 0 / 0 / 18 |
| Double delete and double undo | 24 / 16 / 0 | 24 / 0 / 0 | 0 / 0 / 18 |
| Unseen narration left above a beat I removed | 16 / 0 / 0 | 16 / 0 / 0 | 0 / 0 / 8 |

| Histories | Commands / deliveries | With base banners / false | Without base banners / false | Online banners / false |
| --- | ---: | ---: | ---: | ---: |
| 85 named | 202 / 174 | 35 / 0 | 36 / 0 | 18 / 0 |
| 120 generated, two copies | 6,352 / 544 | 93 / 32 | 87 / 23 | 50 / 26 |
| 120 generated, three copies | 6,376 / 1,504 | 93 / 32 | 87 / 23 | 63 / 26 |
| All 325 | 12,930 / 2,222 | 221 / 64 | 210 / 46 | 131 / 52 |

The new cut-and-undo histories keep B visible. An added visual letter can disappear, an erased visual letter can return, status can return to `todo`, another field can disappear, and a tag can be absent. The paired comparisons found the six named examples and the generated examples on those facets. A live beat qualifies when an added visual letter or mark is absent, an erased visual letter returns, or the field was changed from base and the value in mine is missing. The trial compares copies of visible characters and marks. Repeated characters can obscure which instance survived.

The named runs start with both roles of the 37 E9 histories. In the cut of several rows, the card names the first plausible source, B. The command record puts C's letter in A. The card counts as a hit for the destination A. The scene-name case counts as a hit for the remover because H's unseen letter appears in D, even though the card names the removed scene beat. The heading typist has no beat card. There are six named reverse misses where E9 hides text before the first boundary and the trial only checks the row above. The base comparison also misses a standalone embedded heading cut because it requires a missing beat. The journal knows that the person cut the heading and flags the same visible destination. Both offline comparisons missed three heading typists. The base comparison's former false named banner on the scene name is gone.

The generated histories each have two stretches and 24 background commands per stretch. They cover both columns, marks, fields, headings, splits, joins, moves, removal and undo. An explicit delivery can let the mover or remover see the previous edit. A separate event marks an acknowledgment to the writer in selected cases. The journal is a record of pending commands, represented here by their beat, kind and relevant text, mark, field, parent or neighbour. It folds an explicit type-and-erase and a status change returned to its original value, and drops an undone edit. Those reversals count as no loss. The online session-wide set deliberately retains the touched beat. Redo is outside the scoring ledger. Separate recovery tests exercise ordinary redo.

The journal removes all 16 idle double-undo false entries, including eight with a third, idle offline copy. Those were false banners after an ordinary paste or clear. It removes 14 false entries about starting text another person supplied. The writer did have other losses on those cards. It also removes eight seen split-and-move entries following a recorded acknowledgment. Eight such entries remain when the mover has seen the split but the journal still has it pending. Seen tags, status and narration cuts still produce eight false offline entries each. The seen visual cases produce 14. An acknowledgment to the relay or another peer is distinct from proof of what the remover saw.

| Hand-written E11 rule | What the comparison reports |
| --- | --- |
| A prefix goes to the first beat of its segment, or to the row above if the segment has no beat | The typist gets a missing-beat entry. The remover's append check can flag the suffix above and misses a prefix assigned to a surviving beat below. |
| Stray text in an empty script has its own row | The typist gets the missing-beat entry. The remover has no row above to compare. The new row has no former beat id. |
| Ignore a repeat boundary id | One B says `defdef`. The comparison flags that change. E9 instead shows an empty B. |
| A join counts only if it names the beat directly above | The comparison flags C when it stops displaying under B. The E9 reading instead puts C under A. |

## What seen and unseen reveal

A public beat-map delete event matched the remote before-and-after reading check in every counted history. It gives a beat id. The session test only used ids with a local edit. It has no event for a beat already back by the end of the update. A review payload would need a saved reading from before the cut.

| Change | Evidence in the tested pair |
| --- | --- |
| Visual typing or visual tag, status, another record field | A seen edit and an unseen edit gave identical readings, map events, receiving transaction delete sets, state vectors, both update encodings, and both snapshot encodings after catch-up. A signal based only on that evidence must warn in both or miss one. |
| Narration tag and bold | The public receiving transaction's delete set included both of the writer's original format items only when the deleter had seen them. The test records the ids from the writer's local update, using the exported decoder and membership check. This signal can avoid the seen-cut false entries in those pairs. The counted comparisons do not use it. Coverage across arbitrary ranges and batching remains open. |
| Narration typing | In the embedded-beat pair the merged reading had `abcΩ` after an unseen insert and `abc` after a seen insert. A unique visible letter can avoid the false entry in that pair. E9 can hide a prefix, and ordinary typing elsewhere can produce the same reading. From the remover's side, typing directly in A and typing in deleted B can both leave `abcΩ` in A. |
| Ordinary erase or paste, or someone else's starting text | The journal distinguishes these from the person's own cut and undo or insertion. The base comparison alone can accuse the idle reader. |
| Seen split then intentional move | A journal acknowledgment removes the matched warning when the split was cleared from pending. The replayed move itself gave no tested signal of the desired scope. The mover still has no id for an unseen split half. |

## Tag and undo sweep

Each removal ran with six narration ranges and one visual range, first unseen and then delivered before the removal. All copies and an encoded late copy agreed. The expectations come from the listed ranges and delivery order.

| Removal followed by undo | Unseen trials | Lost / flagged | Seen trials | Lost / flagged |
| --- | ---: | ---: | ---: | ---: |
| Cut B | 7 | 4 / 4 | 7 | 0 / 0 |
| Erase the marked range | 7 | 0 / 0 | 7 | 0 / 0 |
| Erase the whole column | 7 | 3 / 3 | 7 | 0 / 0 |
| Erase the first letter | 7 | 0 / 0 | 7 | 0 / 0 |
| Total | 28 | 7 / 7 | 28 | 0 / 0 |

For a cut or a whole narration erase, the three narration ranges starting after the first letter lost the tag. A visual cut lost its tag as well. A retained tag can extend from `[d]ef` to `[def]`. A separate cut and undo moved an unseen narration letter within B from `dΩef` to `defΩ`. That letter survived. The tag test counts a missing mark, and its range observation records growth separately.

## Base and acknowledgment

The base trial uses an explicit checkpoint when the harness knows every participant has everything. A client cannot observe that moment through the stock provider. In E13 the provider had `synced=true` and a pending count of zero while a download was still held. After reconnect the count could reach zero on the first positive status, so it was also insufficient as a per-edit receipt. See the relay experiment's “Signals for the offline notice.”

The offline reopen test serialized the ideal reading and the editable document separately. Unsent typing survived the reopen, the first merge used the saved checkpoint, and the next acknowledged stretch replaced it. Two more tests advanced the base over an unacknowledged character and left it behind another person's newly created beat. In the first the comparison missed the visual edit, and in the second it reported words the person never wrote.

The no-base trial takes only mine, merged and the local pending record. The history runner supplies ideal acknowledgment events for that record and no peer delivery clears it by itself. These tests do not establish how to obtain or persist per-edit receipts after reconnect. A short positive server status also does not prove what a peer had seen at the moment of the cut.

## Put it back

The prototype makes a standalone beat with the saved narration, inline objects, visual, status and content fields. Its rank and join placement are new. It uses the old surviving left neighbour in the saved scene, then the old right neighbour, then the end of the scene. If the scene is missing or hidden, the new beat goes before the first visible heading. The action is one ordinary undo step. Put-back mints a fresh writer-and-clock key for each contiguous production tag application in each cell. Adjacent runs with different formatting share the key for the same ongoing tag. Disjoint runs, other cells and different copies have distinct keys.

The caller's new beat id has to be unique across copies. Two restores using the same id would write the same segment and record keys and could replace each other's work. The tested independent restores use separate ids. Ordinary undo removes only the local put-back.

| Case | What the person sees |
| --- | --- |
| The deleter undoes after the merge | The narration card closes if B returns with the saved wording. The visual card stays open if B returns as `2` and the saved visual is `2Ω`. |
| Put-back is undone | The new row disappears and the card can reopen if the original still lacks the work. A card can remain stale if the text comes back with other changes or under another id. |
| Both undo the same delete | Before exchange both see one ordinary B. After exchange E9 shows B empty with two narrations stored. The hand-written E11 reading shows `defdef`. A put-back would add a third copy. |
| Narration already moved above | A says `abcΩ` and the fresh B says `dΩef`. The letter appears twice. |
| Both people put it back | Both rows survive. The trial retains one with `2Ω` and one with `2Ψ`. |
| A heading or the original beat is gone | The missing scene falls back to the unheaded part. A reverse-only card has no saved beat to copy. |

## Reusing file-merge review

| Existing piece | Result |
| --- | --- |
| `mergeListEntries` | Formats grouped pairs. Equal summaries are skipped and outcomes are always “both”. It has no uncertainty or put-back action. Marks, fields and placement need descriptive input. |
| `mergeRowFate` | Its file-merge wording can say the user's version stays when the shared beat was deleted. It returns no fate for a surviving doubled or displaced beat. |
| `mergeDiffPairHtml` | The existing formatter works for paired texts and escapes them. Tags, formatting and placement are described by the adapter. |
| File-merge review | Its grouped two-side layout can hold a post-merge reading. Its present labels refer to an open copy and a file on disk. Its confirm action applies a file merge. |
| File-merge banner | The container and buttons are available. The sentence is computed inside `mergeSummary`, so collaboration wording is a banner change. “Review” currently opens comments. Removed beats have no row to highlight. |
| History panel | Its snapshot restore covers the whole document and has backup and confirmation handling. The collaboration meaning of “Undo merge” remains an owner question. |

## Cost

Uncompressed bytes and milliseconds on Node 24.22.1 and Yjs 13.6.33. Five isolated runs each measured 101 comparisons and 20 cold captures after warmup. Comparison used separately cloned readings with one visual clash. Capture excluded document loading and persistence. Each timing cell is the range across the five runs.

| Beats | Plain bytes | Full update bytes | Snapshot bytes | Compare median / p95, ms | Capture median / p95, ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 30 | 7,775 | 8,059 | 15 | 0.095–0.103 / 0.177–0.199 | 0.422–0.477 / 1.459–1.997 |
| 300 | 78,303 | 82,387 | 17 | 0.749–0.762 / 0.873–0.964 | 3.509–4.276 / 8.022–17.030 |
| 900 | 235,503 | 249,088 | 17 | 1.650–1.684 / 1.836–2.111 | 10.159–11.604 / 17.944–21.446 |

The review's 900-beat sample on the earlier comparator was 0.81–0.97 ms for comparison and 7.1–11.1 ms for capture. The initial experiment's single run during other work was slower. These figures are sample ranges. The comparison has no shared bytes or per-keystroke write. The pending record is local and its storage and persistence are outside these timings. A full update reloads independently. The tiny snapshot only stores a state vector and deletion set and needs document history with garbage collection disabled.

## Controls

The named and generated groups pin exact hit, false-entry, miss and banner counts. Each muted detector must lose an independently predicted entry while preserving unrelated kinds. The two narrow controls isolate loss of visual marks and disregard of non-status fields on existing beats. A throw, unexpected coverage, or surviving assertion counts as a failed control.

| Detection or write silenced | Used | Effective | Failed |
| --- | ---: | ---: | ---: |
| Narration | 25 | 25 | 0 |
| Visual | 41 | 41 | 0 |
| Marks | 35 | 35 | 0 |
| Record | 49 | 49 | 0 |
| Join | 17 | 17 | 0 |
| Split suffix | 18 | 18 | 0 |
| Split and move | 14 | 14 | 0 |
| Double undo | 25 | 25 | 0 |
| Displaced narration | 21 | 21 | 0 |
| Visual marks only | 24 | 24 | 0 |
| Non-status fields only | 9 | 9 | 0 |
| Each individual put-back call | 16 | 16 | 0 |

The put-back controls omit one Yjs call at a time. A literal stored-state assertion catches the omission at that command. The checks include segment, head, cell and row links, rank, status, fields, text runs and inline objects. The tag-key check separately pins raw identity for contiguous runs, disjoint runs, both cells and two authors.

## What the checks read from the implementation

| Read or assumed | What it limits |
| --- | --- |
| E9 seed encoding, native block offsets, row members, join helpers, and E10 ranks | These are the actual edit routes. The named effects hard-code that the cross-segment selection includes C and D, the unjoin selection includes C, a scene cut includes E or F, and a join targets A or B. Those choices reflect E9's known membership. The independent model cannot serve as a new oracle for different membership. |
| Named landing rows and generated command effects | The run and scene destination checks name A and D from the fixtures. The model predicts the selected cut-and-undo tag loss from the seeded range and cell. The separate sweep checks that rule. It does not predict arbitrary formatting interleavings. |
| Packet bytes, vectors, snapshots, delete sets, decoded ids and transaction flags | These drive delivery or test the public evidence. The model advances from recorded deliveries. The paired equalities hold for the specified catch-up order and the recorded local format items. |
| E9 blocks, rows, fields, marks and visible strings | These are observations passed to the comparisons. Converged readings do not prove an E11 rule. Raw segment content separates a hidden letter from a lost one. The selected tag and visual checks compare presence with command-based expectations. |
| Standard undo return values and stack sizes | These assert the actual presses and one-step recovery. The model uses a script-level stack and cancellation of the explicit reversals. It has no scored redo or general prediction of skipped undo steps. |
| Write-hook calls, stored values and fresh id, comparison outputs and review helper strings | These are assertions on actual output. They check specified placements, raw tag keys and formatter results before rendering. No output decides what the model considers a loss. |
| Timings and bytes | These are wall-clock samples and lengths of one fixture. They exclude live provider and UI costs, long journal growth and the retained document history needed for snapshot restoration. |

## Questions for the owner

1. **What should a clash notice claim?**
   - **A.** Show possible clashes for visual and record edits. Some people see a card even when the remover saw their edit.
   - **B.** Use the available evidence for narration and withhold ambiguous container cards. A person could lose an unseen visual edit without a card.
   - **C.** Carry evidence of what the deleter had seen. A stronger card would depend on that evidence surviving disconnect and delivery.
2. **What can define the pending work?**
   - **A.** Use the stock provider's approximate checkpoint. A late acknowledgment or inbound edit can make cards wrong.
   - **B.** Keep a journal of the person's own pending commands and use explicit receipts if available. Idle users avoid the measured double-undo warnings, while some seen deletes remain ambiguous.
   - **C.** Show a manual review entry after reconnect and let the person request the comparison. They choose when to inspect it.
3. **What happens when A already shows part of B?**
   - **A.** Put back the whole beat. Both rows show the letter.
   - **B.** Show both rows and let the person move it.
   - **C.** Move the fragment only with source proof. Otherwise show a review prompt.
4. **What happens when both restore, the old row returns, or the old scene is gone?**
   - **A.** Keep independent copies and use the fallback placement when needed.
   - **B.** Ask the person where to put the copy or how to reconcile two visible rows.
   - **C.** Give recoveries a shared identity or show side-by-side review for a live row. Competing content still needs a choice.
5. **What does “Undo merge” mean once others have the changes?**
   - **A.** Hide it and let standard undo take back a put-back.
   - **B.** Open the earlier reading as a separate copy for reference.
   - **C.** Preview ordinary edits that would reverse selected changes for everyone.
6. **What wording should the banner and review use?**
   - **A.** Give a count of possible clashes and label the sides “Your copy” and “Shared script.”
   - **B.** Say what disappeared or moved only when the evidence supports it. Uncertain changes appear separately in review.

## Least sure

The largest unknown is how to clear a local pending record accurately across a dropped connection. E13's standard signals do not tie a receipt to each edit on reconnect. The paired narration checks use short text with a distinguishable letter or recorded format ids. The frequencies and boundaries of those signals under longer edits, E11's actual reader and relay batching remain open.

Run `node --test test/native-notice/*.test.ts` from the collaboration prototype. It prints the counted histories, controls, tag sweep and costs.
