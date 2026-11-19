# E9 · Real deletion of beats

**Verdict.** Real deletion fails the reachability requirement in this stored shape with the current reader and standard undo. Both tested writes converge. Cutting the observed ranges and keeping the containers is the smallest tested write that lets concurrent splits keep their placement. An unseen letter in a deleted segment head can still sit before the first surviving boundary, where no row can show or edit it. Dropping the whole segment loses that letter and can leave a concurrent split’s visual cell without a row. A separate failure needs only two writers deleting and then undoing the same row. Both copies store two boundaries for that beat and show one empty row with its narration unreachable.

## The write

[`deleteNativeRows`](delete.ts) resolves the visible selection before writing. A row means its head beat and all the joined members shown with it. A run takes the union of the selected rows. A scene takes its heading and the rows up to the next visible heading. A previously flagged heading is still a separate stored name. Deleting the scene’s visible rows leaves that hidden heading and name alone. The selection uses display order. The cuts use physical order within each segment. A focused test deletes a joined row whose members were displayed in reverse storage order.

In one transaction, visit selected segments back to front. Delete each contiguous span back to front with `Y.Text.delete`. The span starts at the first selected beat or heading’s leading embed and stops before the next unselected boundary. A segment head starts at zero. It has no embed, so delete its `head` key after cutting the span. Then delete each selected beat from `beats` and its cell from `visuals`, in that order. Delete the selected heading records from `headings`. A heading-only deletion uses the same write without selecting the rows below it. The flag version sets only `headings[id].removed`.

The range write keeps the segment map, its `Y.Text` and its order entry, even after the last beat in the script is gone. A concurrent split has written its only placement into that text. The keep variant adds no boundary, row, flag or recovery record. Deleting the last embedded beat leaves any unseen narration at the end of the preceding block. For a joined row crossing a segment boundary, cut the spans in both segments and remove every member’s record and cell.

The drop variant replaces the span and head writes with an order-entry deletion followed by a segment-map deletion whenever every observed block in the segment is selected. The parent deletion removes the nested text. It also removes concurrent insertions and boundaries in that text. Writes to independent roots still integrate. Leaving the original head key after removing the record and cell would leave a visible beat with no visual editor. The current reader needs a boundary to route text. Plain deletion cannot put one before a surviving prefix.

## Races and the offline notice

The names below describe two-copy histories. In the main fixture `A:abc | B:def | C:ghi` share one text, with A as segment head. A second segment holds `D:jkl | #H:mno | E:pqr`. `#I:stu` and `F:vwx` each head a segment of their own. The one-beat fixture is `A:abc`. The other writer has yet to see the delete. Each line gives the settled result on both copies. Unaffected text and cells stay where they were. `Ω` is the other writer’s letter.

The last column assumes three readings with narration and visual strings keyed by physical beat id. Those readings are the shared base, the offline copy before merge and the merged copy. A warning can offer the offline text. Proving that a particular character moved requires evidence of identity or intent when the same text could have been typed twice. Fields, formatted runs, headings and row membership require readings that include those values.

| The other person’s command | What is stored and what a person sees | What three plain readings can tell |
| --- | --- | --- |
| Type in embedded B as B is deleted | The B embed, observed text, record and visual are gone. `Ω` stays in the segment and appends to A as `abcΩ`. It is editable in A. | B was edited and deleted. A changed. The comparison cannot prove that A’s new letter came from B. |
| Type in A as the segment head is deleted | The A head, observed text, record and visual are gone. `Ω` remains before the B embed. B still shows `def`. No beat reads the prefix. This happened for A’s first, interior and last typing gaps. | A was edited and deleted. The readings cannot distinguish a stranded prefix from erased text. |
| Type in tail C as C is deleted | `Ω` appends to B as `defΩ`, with C’s cell, record and boundary gone. It is editable in B. | The same limits as for embedded B. |
| Type in single-beat F, or in the script’s only beat | Keeping the segment leaves a prefix with no boundary. No beat shows it. Dropping the segment deletes the letter itself. The one-beat outline is empty either way. | The offline edit and deletion are visible. The two outcomes have the same plain readings. |
| Type in B’s visual | B’s separate visual `Y.Text` is deleted. The late letter never lands in a live cell. | B’s visual changed and B disappeared. The offline reading can offer the missing text. |
| Erase text in B’s narration or visual | The erased text is part of what the row delete already removed. B is gone, with no additional loss or stranded letter. | The offline text differs from the base. There is no newly typed text to offer. |
| Bold or tag B’s narration, or tag its visual | There is no target character left to carry the mark. Adjacent text stays visible. The visual’s mark is inside the deleted cell. | Plain strings miss a mark-only edit. A marked reading can show the lost change. |
| Set a field in B | B’s nested record is deleted, including the unseen field write. There is no new text loss. | A field comparison can warn. Text strings alone miss it. |
| Split B or A and type in new N’s visual | The unseen N embed survives in the shared text, with its record and cell. The delete cut the original suffix it saw. N appears at the split gap with empty narration and its new visual letter, which is editable. | N’s offline narration was present and is now empty. A comparison can show that difference without knowing which part of B or A it came from. |
| Split the only beat, then type in N | With the kept segment, N opens at its embed and shows the unseen narration or visual. With the dropped segment N loses its embed. Its narration is gone. Its visual, if typed, survives only in unplaced recovery and is unreachable through a row. | N is missing from the merged outline. Plain readings cannot see its unplaced visual or tell it apart from discarded text. |
| Join B up to A | The join write is inside B’s deleted record. B is gone. A stays as it was. | Explaining the failed join needs row membership. |
| Join C up to B, then type in C | C’s record still names B. The contiguous reader puts C under A instead. C’s narration, including `Ω`, and its visual are stored at C and editable in the A row. | C’s plain content survived. The unintended row needs membership or join-target information. |
| Unjoin C from B while the joined B row is deleted | The deleter had selected both B and C. Both records, boundaries and cells are deleted. The unjoin leaves no separate C. | The delete is visible. An unjoin with no text edit needs membership to explain. |
| Create a heading above the deleted beat | An inline heading before B keeps its new embed, name and record. Above A it keeps its own new segment, order entry and record. The heading stays editable, even with no row directly below it. | No new data was lost. The heading is outside a beat-only comparison. |
| Rename the heading above the deleted beat | Typing in H or erasing one of its letters changes H’s name. It remains editable after E is deleted. | No clash on the edited name. The heading is outside a beat-only comparison. |
| Flag or delete the heading above the deleted beat | E is deleted. A flagged H keeps its name recoverable. A real deletion removes H’s name, embed and record. There is no unseen name text in this case. | Beat readings show E’s removal only. |
| Both delete B, or delete B and a left or right neighbor | Both deletes apply to the observed items once. The selected beats and their cells are gone. No text survives from those beats without a third writer. | Both chose deletion. The plain readings contain no edit to offer. |
| Type in D while the joined B row spans B, C and D and is deleted | Both spans and all three records and cells go. D was a segment head, so `Ω` survives before H with no editor. | D changed and disappeared. The prefix itself is invisible. |
| Type in C or D while the run B–D is deleted | C’s unseen narration appends to A. D’s unseen narration is stranded before H. | The offline edit can be offered. A’s new text and an invisible prefix cannot be attributed from these readings alone. |
| Type in H or E while the scene H is deleted | The H and E ranges and records go. An unseen name letter or E narration letter appends to D and can be edited as D’s narration. | E’s edit can be offered. H’s edit needs a heading reading. Attribution in D is ambiguous either way. |
| Type in F while the scene I is deleted | The kept segment strands F’s unseen narration. The dropped segment erases it. | F was edited and deleted. The two outcomes look the same. |
| Insert a neighboring beat, then type in its visual | The new segment, order entry, record and cell are independent of the B deletion. Both columns are editable. | No new data was lost. |
| Type in H’s or I’s name while that heading is removed | Flag leaves the name and new letter in heading recovery. Real deletion of embedded H puts the unseen letter in D’s narration. For head I it strands the letter in a kept segment or loses it in a dropped segment. | A heading-aware reading can offer the offline name. A beat-only reading misses the name edit and sees at most a changed D. |
| Both delete B and both undo | Each restored B reads `def` before syncing. The merged B reads empty, with `defdef` stored behind its second boundary. | A notice offering the offline text would offer `def`. Typing it back into the visible B would store a third copy. A check for offline text changes alone misses this case because the base and offline text match. |
| Undo a creation while someone writes in the new beat | The new beat disappears. Undo of a split leaves the narration in the original beat. Plain undo loses the new visual and also loses the narration of a standalone insert. Keep-always retains the visual in recovery and the standalone insert’s narration in a segment outside the order list. | The missing beat and its offline edits are visible to the comparison. No plain reading sees the retained narration outside the order list. It cannot tell whether the text was lost, hidden or moved. |
| Redo B’s deletion while an unseen narration letter survives | B disappears again and A shows `abcΩ`, including the letter the typist put in B. | The readings show a missing B and changed A. They cannot prove that the extra letter in A is the one typed in B. |

The notice helps the person who was offline. If the deleter was offline and the typist stayed online, the deleter’s offline reading already shows the row gone. The merged reading also omits the stranded text because it has no beat id to read through. The comparison finds no clash, and the online typist only sees the row vanish. Three readings also miss an edit followed by a reversal to the same value. They need extra evidence to say where an edit went or why it vanished.

### What a different reader could reach

| Case | Cause and what a reader could do with the stored data |
| --- | --- |
| Unseen narration in an embedded beat or scene lands in the preceding block, including after redo. An embedded heading’s name can land in narration. | Yjs preserves the insert in the surviving text. Its old boundary is gone. The stored shape assigns a range by boundary, so plain text in that range carries no former beat or heading id. A reader can show the letter in its current range. Putting it back in the intended beat would require evidence of where it came from. |
| A prefix survives deletion of a segment head, including a heading, a joined member, a run or a scene. A script can end up empty with such a prefix. | The shape has no boundary for the prefix, and the current reader skips text there. A reader could give it to the segment’s first beat, or to the row above when the segment has no beat. If the script has no rows, a reader could show a narration-only row for the stray text. |
| An unseen visual edit or field write disappears. Dropping a segment erases its unseen narration and split embeds. Plain creation undo loses writes inside the containers it removes. | Yjs discards writes into a deleted container. A reader has no surviving text or value to expose. Formatting on deleted characters likewise has no target to display. |
| Dropping a segment leaves a concurrently split beat’s visual in recovery. With keep-always, undo of a creation can leave a visual in recovery and standalone narration outside the order list. | The stored shape separates text, order, records and visuals. The reader can find the unplaced visual but offers no row editor for it. An unlisted narration segment requires a reader that looks beyond the order list. The prefix rules above only examine ordered segments. |
| Two undos leave B empty with `defdef` stored, or undoing a concurrent erase gives `defe`. | Yjs undo re-creates deleted content, so both copies of the restored letters are live. For B, the current reader keeps the first block with that id and skips the text behind the duplicate boundary. Ignoring the repeated boundary while reading text would show `defdef`. It would keep both copies visible. |
| C is joined to a deleted B and appears under A. | C still stores B as the target. The current reader joins it to the visible row above, and the model deliberately copies that rule by ignoring `into` when grouping. The test shows model and reader agreement. It does not establish that A is the row the person meant. A rule requiring the named target to be the beat directly above would keep C separate. |

These reading rules write nothing. They are possibilities from a scratch reader and are outside this experiment’s implementation.

## Undo and redo

One selective `Y.UndoManager` per writer, with the command origin tracked and no creation filter for these runs. A row, run, scene or heading deletion is one step. Without a race, undo brings back the narration, record, visual, heading and original order. Redo removes them again. The other copy gets no undo entry from either press.

- In inline B, bold, tag and comment marks received before the deletion return on the restored characters in both cells. Marks written during the deletion did not return in either cell. The separate comment record stayed throughout. A relative position aimed at the original `e` resolved back to `e` for the deleter and to `f` on the other copy. A position into the original visual cell resolved on the deleter and returned null on the other copy. The visible comment anchor here is its mark. The pointer probe is a separate check.
- When B’s narration typing reaches the deleter before undo, it first reads in A. Undo puts it back inside B at the original gap as `dΩef`. If the delete and undo both happen before the typing arrives, the unseen letter lands at the end of the restored beat as `defΩ`. The typist can still undo their own letter. Redoing the row deletion leaves the unseen letter in A again in either delivery order.
- When B’s visual typing crosses the delete, the letter stays gone after the deleter’s undo. The typist’s next undo skips that step and removes their earlier letter in F. The same skip happens for earlier narration or visual typing which the deleter had seen and restored. In those two cases the restored letter stays visible. The typist’s stack still names the original item.
- Another writer’s prior narration erase can still be undone after restoration. If the erase crossed the row delete, the deleter’s undo already brought that letter back. Undoing the erase then adds it a second time, as `defe`. Seen and unseen visual erase steps both skip to the earlier F edit. A seen bold or status edit is restored, but its own undo also skips. An unseen status write can leave the restored field absent when it arrived before undo.
- When both delete B and only one undoes, B returns in place with its record and visual. If both undo, the shared text has `abc | B | B | defdef | C | ghi`. Everyone sees an empty B narration and one visual cell, with six live but unreachable letters behind the second boundary. This happened after crossed undos, after the second writer saw the first undo, and when both writers deleted and undid entirely offline. The offline route is likelier than two online writers both pressing undo in the same exchange.
- The bare `Y.Text` test starts with `abcdefghi`. Each copy deletes `def` and undoes before syncing. Both finish with `abcdefdefghi`. Yjs undo re-creates deleted items as new content, so the two restores coexist. That accounts for the doubled text and boundary when the row is restored. The delete transaction only removed the original items.

## Undoing a creation

Forty histories per cell below, with different client ids, typing gaps and packet delivery orders. The creator’s undo always happens before the other writer’s updates arrive. The other writer puts one narration letter, one visual letter and a status into the new beat. Loss rates are conditional on this race.

| Creation undone | Plain undo | Keep-always |
| --- | --- | --- |
| Split | 40 of 40 lose the visual letter and field. All 40 narration letters merge into the original beat and remain editable. | All narration letters still merge into the original beat. The created record and visual stay. The visual letter appears only in unplaced recovery until redo. |
| Insert a beat with its own segment | 40 of 40 lose both letters and the field. | The record and visual stay. The visual appears in unplaced recovery. The narration letter is in a segment with no head and no order entry. It has no editor until redo. |

Redo with keep-always restores placement, the other person’s letters and their status. Plain redo restores placement with an empty visual and no status field when the unseen field write had replaced the original status. Redo of a split puts the surviving narration letter back in the new beat. Redo of an insertion cannot bring back the two lost letters.

Compared with plain undo, keep-always added 7 bytes for the split and 11 for the insertion in the writer’s encoded state with redo still available. After loading into a fresh GC-on doc, the differences were 24 and 55 bytes. For the fixture’s 30 starting narration and visual characters, that is 0.80 and 1.83 bytes per original character after one undone creation. The library calls the filter during undo or redo. It adds zero filter calls per ordinary keystroke. [E3’s typing measurement](../native-undo/RESULTS.md) covers the filter. The kept insertion segment has no recovery entry for its narration.

## Heading removal

The flag keeps name typing in a recoverable heading at its old location. Clearing the flag by undo reveals it. The real delete removes the name range and heading record. E5’s boundary-only delete left the whole observed name behind. With the E9 real delete, only unseen name letters remain in a kept text container. An embedded heading leaks those letters into the preceding block. Deleting a segment-head heading leaves the letters without a heading to edit, or drops them with the segment.

## Numbers

There were 37 named two-copy races per variant. Each variant ran 2,220 generated three-copy histories with a late joiner. Each delivery mode ran 12 seeds for each named shape. The third writer types two dependent letters. One copy receives that writer’s batch first and is checked before the full exchange. Modes are forward, reversed, repeated, shuffled and full state. The generated forks showed no disagreements, crashes or duplicate blocks. The double undo defect has separate named tests.

| Typed letters in generated histories | Keep segment | Drop segment when all observed blocks are selected |
| --- | ---: | ---: |
| Shown in intended block and row | 4,200 | 4,080 |
| Shown in a different beat or heading | 570 | 450 |
| Shown in the same beat under a different row | 60 | 60 |
| In heading recovery | 120 | 120 |
| Stored without a live editing route | 750 | 210 |
| Gone from live shared storage | 60 | 840 |
| Histories with more than one order allowed by the model | 120 | 0 |

These histories deliberately include the bad positions. The counts cannot estimate how often writers meet them in normal use or test the nine-in-ten guide.

### Silent-write controls

The checks mute each command and each individual public write once per occurrence. They count uses, cases where the write has an effect, and immediate assertions that reject the result. A throw or lost call coverage fails the control run. There were zero of either. The tests print each sub-write count. The undo and redo controls suppress the whole press. There is no public hook for its individual replay writes.

| Command | Whole command, used/effective/failed | Individual public calls, used/effective/failed |
| --- | ---: | ---: |
| Rows | 4,026 / 4,026 / 4,026 | 14,762 / 14,762 / 14,762 |
| Scene | 366 / 366 / 366 | 1,830 / 1,830 / 1,830 |
| Heading removal | 732 / 732 / 732 | 1,220 / 1,220 / 1,220 |
| Type | 11,564 / 11,564 / 11,564 | 11,564 / 11,564 / 11,564 |
| Erase | 244 / 244 / 244 | 244 / 244 / 244 |
| Format, tag | 366 / 366 / 366 | 366 / 366 / 366 |
| Field | 122 / 122 / 122 | 122 / 122 / 122 |
| Split | 488 / 488 / 488 | 1,952 / 1,952 / 1,952 |
| Join | 244 / 244 / 244 | 244 / 244 / 244 |
| Unjoin | 122 / 122 / 122 | 122 / 122 / 122 |
| Create heading | 244 / 244 / 244 | 1,098 / 1,098 / 1,098 |
| Insert beat | 122 / 122 / 122 | 976 / 976 / 976 |
| Undo and redo of deletion, each | 74 / 74 / 74 | — |
| Undo and redo of creation, each | 160 / 160 / 160 | — |

### Bytes and time

GC on, stock encoded updates, ASCII fixture with 120 narration and 48 visual characters per beat and one status field. The size comparison encodes a fresh copy with no undo history. Values are bytes saved **against the mark**. With 30 beats per segment, the sampled cuts are embedded and the two real-delete variants write the same thing.

| Beats | Beats/segment | Starting bytes | Mark after one / after 10% | Range saves one / 10% | Drop saves one / 10% |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 300 | 30 | 74,732 | 74,776 / 76,071 | 247 / 7,456 | 247 / 7,456 |
| 900 | 30 | 225,652 | 225,696 / 229,717 | 247 / 22,482 | 247 / 22,482 |
| 300 | 1 | 87,691 | 87,735 / 89,030 | 235 / 7,116 | 272 / 8,175 |
| 900 | 1 | 265,291 | 265,335 / 269,356 | 235 / 21,421 | 272 / 24,701 |

An encoded copy of the active writer still carries what its undo step holds. After one cut its encoded update was 7 bytes above the initial state for an embedded beat, or 11 bytes for a single-beat segment kept in place. The one mark added 44 bytes. The fresh copy keeps deletion metadata.

Milliseconds on Windows ARM64, Node 24.22.1. Each variant has 40 samples after eight warmups. The delete timer measures planning, the outer write transaction including observers, and the following `replica.changes()` rebuild. The undo timer measures the library press and its rebuild separately. Loading, editor rendering and encoding to disk are outside the timer.

At 900 beats, the write transaction took 0.046–0.056 ms at the median and the undo press took 0.029–0.049 ms. The rebuild took 5.63–6.29 ms at the median. Mark and range both paid it. At 30 beats per segment the delete rebuild took 6.16 ms for the mark and 5.96 ms for the range. Crossings of the 8 ms budget came from the shared full-row rebuild. They say nothing about the real-delete write versus the mark. The range and drop writes are identical at 30 beats per segment. The difference between those timings shows run noise.

| Beats | Beats/segment | Variant | Delete plan / write / rebuild medians | Undo press / rebuild medians | Total delete / undo median [p95] |
| ---: | ---: | --- | --- | --- | --- |
| 300 | 30 | Mark | 0.007 / 0.033 / 1.842 | 0.021 / 1.765 | 1.878 [4.481] / 1.791 [3.206] |
| 300 | 30 | Range | 0.114 / 0.044 / 1.964 | 0.036 / 1.945 | 2.146 [3.017] / 1.979 [5.911] |
| 300 | 30 | Drop | 0.098 / 0.038 / 1.792 | 0.029 / 1.735 | 1.925 [5.581] / 1.770 [2.298] |
| 900 | 30 | Mark | 0.023 / 0.046 / 6.158 | 0.030 / 5.667 | 6.232 [10.616] / 5.694 [9.413] |
| 900 | 30 | Range | 0.265 / 0.054 / 5.962 | 0.048 / 5.633 | 6.287 [9.780] / 5.674 [10.762] |
| 900 | 30 | Drop | 0.260 / 0.047 / 5.763 | 0.046 / 5.880 | 6.097 [9.887] / 5.976 [9.570] |
| 300 | 1 | Mark | 0.007 / 0.020 / 1.844 | 0.014 / 1.767 | 1.872 [2.922] / 1.780 [2.538] |
| 300 | 1 | Range | 0.205 / 0.031 / 1.875 | 0.025 / 1.803 | 2.129 [6.551] / 1.841 [6.257] |
| 300 | 1 | Drop | 0.207 / 0.037 / 1.861 | 0.025 / 1.765 | 2.120 [2.955] / 1.790 [5.753] |
| 900 | 1 | Mark | 0.023 / 0.048 / 6.292 | 0.029 / 6.050 | 6.384 [10.819] / 6.138 [10.032] |
| 900 | 1 | Range | 0.625 / 0.056 / 6.003 | 0.049 / 5.865 | 6.694 [11.844] / 5.924 [10.149] |
| 900 | 1 | Drop | 0.621 / 0.052 / 6.289 | 0.045 / 5.883 | 7.000 [11.624] / 5.932 [10.591] |

### Values read from the implementation

The fixtures and commands feed a model with no Yjs or prototype imports. It advances from those commands and checks the state after every local command. Each original unit cut by any writer is gone. Each inserted unit survives unless its parent container was deleted. Sequence constraints come from the offline branches without using the actual merge. In 120 cases that allowed more than one order at an unseen gap. The test checks an allowed order, exact membership and uniqueness, and demands that all copies pick the same order. The model has no rule for choosing a winner for competing assignments. The field races here are assignment against deletion of the parent, which has one expected outcome.

| Value read | Claim it checks or limits |
| --- | --- |
| Public order, `segments` keys, `head`, `Y.Text.toDelta()`, `beats` and `headings` maps, and every visual’s live text | Compare with the model’s live storage. This finds extra boundaries and invisible text. It cannot tell which tombstone payloads remain in the editing copy. |
| Outline, displayed deltas, members, status, heading recovery and unplaced visual recovery | Compare with the expected display for the matched allowed order. An order ambiguity cannot prove which beat ought to win the contested gap. |
| Actual cell and heading locations | Check that displayed text has the expected edit range. A named edit deletes the relocated letter through A. The generated checks examine the routes without driving a browser editor. |
| Text delta attributes | Check local mark writes, selected undo results and agreement on the settled copies. Formatting across every possible concurrent insert is outside the model. |
| Updates and full encoded states | Deliver what the library sends and reload it. Expected contents come from the commands. The experiment covers these packet schedules with eventual delivery. |
| Intercepted public calls and call order | Cover each observed sub-write separately. These labels select the fault. They supply no expected values and give no coverage inside library internals. |
| Stack length, press return value, transaction origin and relative-position resolution | Check one effective local step, skipped steps and the anchor probe. They do not forecast the internal undo stack or prove pointer identity on every client. |
| Encoded byte length and elapsed time | Measure the fixtures, GC reload and prototype projection. These figures cannot predict production rendering or transport cost. |

## Questions for the owner

- **Can the stored shape or reader change to give a surviving prefix or a twice-restored boundary an editor?** Keeping the current reader leaves head edits invisible and can show an empty row after two undos. A different placement or reading rule could give the text an editor and would need its own routing and cost evidence. There is no passing delete write to adopt yet.
- **Should undo of a creation keep its containers?** Plain undo can lose unseen writing. Keep-always preserves the bytes and brings them back on redo. In the meantime the visual appears only in recovery, and an inserted beat’s narration has no visible home.
- **Should a heading removal keep its flag?** With the flag, its name can be recovered in place. With real deletion, the observed name is cut and an unseen letter can land in the previous beat or have no editor.

The least certain result is placement around a same-gap insert when there are several splits or heading changes before the copies see one another. The model bounds the short fork histories here. Concurrent moves, long mixed histories, position drift after many restores, rich atoms, composition and the editor’s real input path are outside its coverage. Nothing here measures how often the targeted races happen in a live session.

From `prototypes/collab`, run `node --test test/native-delete/races.test.ts test/native/e9-delete-undo.test.ts` and `node src/native-delete/cost.ts`.
