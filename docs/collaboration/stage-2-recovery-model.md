# Recovery model

Recovery is where a shared script keeps content that is not in the script but
must not be lost: a beat someone removed, text typed into it by someone who had not
seen the removal, typing the document refused, and the pieces a merged state cannot
show. This note is the inventory for package 11 of Stage 2: what exists, what each
entry means, the gaps against the [plan](../COLLABORATION-PLAN.md#6-structural-conflicts-and-recovery)
and the Stage 1 records, and the cut list that closes them.

`SharedRecoveryEntry` in `src/core/collab/recovery.ts` names the list as one union.
`tests/core/collab/recovery-entries.test.ts` reads that union with the type checker
and pins its kinds, each kind's fields and the fragment reasons, and checks that
[Entry kinds](#entry-kinds) below has one section per kind listing exactly those
fields. A new kind or field fails the test until it is classified here.

## Where recovery comes from

The projection returns recovery beside the document:
`projectSharedDocumentWithRecovery` and `projectSharedDocumentStep` in
`src/adapters/collab/project.ts`, both through `assembleSharedDocument`. It reads and
writes nothing else. Full and incremental projection share that one assembly, and
the incremental tests compare document and recovery with a fresh full projection at
every checkpoint. The list is in assembly order: unprojectable fragments, then per
joined group in script order its cells' tag rejections, gallery overflow and the
removed group itself, then removed headings and scenes with no beats.

What puts content there is shared state, written by operations:

| Operation | What it leaves in recovery | Where it is prepared |
| --- | --- | --- |
| `remove` (beat removal, cut, the flow emitter's range removals) | The removed beat and the beats joined into it | `removal-executor.ts` |
| `heading-remove` | The removed heading, when its name holds text | `removal-executor.ts` |
| The rule 29 write: `segment-create` then `remove` in one list, `undo: false` | A removed draft beat holding the refused field, with its source | `bufferedRecoveryOperations` in `core/collab/buffer-operations.ts`, called by `BufferedTextEdit.recover` in `adapters/collab/buffer.ts` |
| Any merge of concurrent changes | Crossing or deleted tags, gallery overflow, a scene with no beats, damaged fragments | Projection rules under `core/collab/projection/` |

`restore` is the only operation that takes anything out. It names removal records,
cancels the generation they belong to on each target beat or heading, and writes its
own record (assumed rule 33 on #1414). It inserts no boundary, text, mark, segment or
order entry, so the restored content comes back in place with its original
identities, marks and comment anchors, and a restore aimed at an older generation
leaves a newer removal alone. A used-up restore is accepted and changes nothing. No
application code issues it yet: there is no recovery panel.

## Entry kinds

### `removed-beat`

- Produced: `assembleSharedDocument`, for a joined group whose root has an active removal (`group.removed`). Beats joined into a removed beat are members of the same entry (assumed rule 3); a beat removed while someone typed in it keeps that typing (decided: an edit to a removed beat goes to recovery).
- Carries: `row` (the painted row in canonical row order: id, `audioText`, `visualText`, joined fields and gallery), `members` (the beat ids of the group), `buffer` (optional: for a rule 29 entry, each source beat's id and its `bufferSourceOwner` and `bufferPaintedBase`, historical provenance never shown in a row or export).
- Copies: derivation. Every copy holding the same state lists the same entry; a late joiner reads it from the removal records and per-beat removal flags.
- Restore today: `restore` with the ids of the removal records whose generation is active. The entry does not carry those ids; a caller reads them from the beat's `removals` map.
- Restore should mean: the group back in the script where its boundaries are, with its text, marks, attachments and comment anchors, nothing copied (already true for a beat removed on its own). A rule 29 draft beat comes back as an ordinary beat directly after its source (assumed A4).
- Undo of restore: refused today (every structure command is refused by name in the undo owner). Should be a fresh removal of the same beats by the person who restored, the next generation (assumed A1).

### `removed-heading`

- Produced: `assembleSharedDocument`, for a heading with an active `header` removal whose name still holds text; a removed heading with an empty name has no entry. It is rebuilt on every projection step instead of being cached (open item 3 from #1501).
- Carries: `heading` (the section record: id, name and stored extras).
- Copies: derivation.
- Restore today: `restore` of the `header` removal. It unmasks the heading; it does not undo the split of a demotion.
- Restore should mean: the heading back at its boundary, starting a scene again with the beats after it.
- Undo of restore: refused today; should be a fresh `heading-remove` by the person who restored (assumed A1).

### `scene-with-no-beats`

- Produced: `projectSharedSections`, for a visible heading followed by no visible beat before the next heading or the end (Stage 0 assumed answer 7, assumed rule 6). The heading is not in the document's `sections`.
- Carries: `heading` (the section record), `beforeRowId` (the visible row the heading stands before, or null at the end).
- Copies: derivation.
- Restore today: none. Nothing was removed; the entry leaves when a beat is created after the heading or the heading is removed.
- Restore should mean: no restore. The panel offers the two ordinary commands, add a beat under the heading or remove the heading, each with its ordinary undo (assumed A9).
- Undo of restore: not applicable.

### `crossing-tag` and `deleted-tag`

- Produced: `projectSharedTagExtents` in `core/collab/projection/tag-extents.ts`, through every cell `assembleSharedDocument` paints: visible rows, removed groups and unprojectable fragments. `crossing-tag` is the later of two tags that overlap without nesting (assumed rule 4); `deleted-tag` is a tag whose registry entry is gone. Either is shown untagged there.
- Carries: `occurrence` (the stored mark id), `tag` (the registry id), `from` and `to` (offsets in the cell's units), `words`, `rowId` (for a fragment its owner, or its segment when it has none), `field`.
- Copies: derivation.
- Restore today: none.
- Restore should mean: no restore; the words are in the script, untagged at that place. The panel offers remove-this-tag (the ordinary tag clear over the listed words) and, for a deleted tag, re-create the tag (an ordinary record create with that id, after which the mark shows again) (assumed A9).
- Undo of restore: not applicable; the offered commands have their ordinary undo.

### `gallery-overflow`

- Produced: `projectSharedGroupGallery` in `core/collab/projection/gallery.ts`: a joined group's gallery after equal pictures are folded together (assumed rule 12) keeps its first 61 entries; the later ones are listed (assumed rule 13). The records stay in shared state.
- Carries: `itemId` (the gallery record id), `beat` (the beat that owns it), `slot` (the projected slot), `rowId` (the group's row).
- Copies: derivation.
- Restore today: none.
- Restore should mean: no restore; an entry shows again by itself once an earlier picture is removed. The panel offers delete-this-picture (record delete), whose undo is refused today like every gallery undo (assumed A9).
- Undo of restore: not applicable.

### `unprojectable-fragment`

- Produced: `projectSharedBlocks` in `core/collab/projection/blocks.ts`, for a stretch of stored text that cannot be shown as a row or heading. Only damaged data from another program reaches it, never the app's own commands (assumed rules 8, 9, 21 and 25).
- Carries: `reason`, `owner` (the beat or heading id the stretch names, or null), `segment`, `field` (`audioText`, or `heading` for a heading stretch), `from` and `to` (offsets in the segment), `html` (the painted text).
- Copies: derivation.
- Restore today: none.
- Restore should mean: no restore in a shared session. Bringing it back would copy its text under new identities, and a later repair of the damage would then show it twice. It stays listed, and a standalone export offers it as recovery material (assumed A9).
- Undo of restore: not applicable.

| Reason | Stored state that causes it |
| --- | --- |
| `missing-boundary` | Text at the start of a segment with no beat or heading boundary before it |
| `invalid-prefix` | A split-before boundary whose source beat is not earlier in the same segment |
| `missing-beat` | A beat boundary with no beat record |
| `wrong-shape-beat` | A beat record that fails its validator |
| `unowned-beat` | A beat record that names no segment holding its boundary |
| `foreign-segment` | A beat boundary inside a segment its record does not name |
| `duplicate-boundary` | A beat or heading boundary seen a second time, or a beat id equal to an earlier one after id cleaning (assumed rules 8 and 21) |
| `invalid-beat-id` | A beat id that is empty after the app's id cleaning (assumed rule 25) |

## What is not an entry

These keep work, but locally, on one copy, and are not in the list:

- A rule 29 write that the document refuses: the typed text stays in the field and the reason is shown (assumed rule 38). A save that fails with an error, not a refusal, also keeps the text in the field.
- Updates held while someone types (assumed rule 26). They are delivered on release; nothing is dropped.
- The standalone recovery paths: drafts, history snapshots and the conflict stash. A shared session neither reads nor clears them (assumed rule 37).

## Gaps against the plan and Stage 1

1. **A removed beat's entry does not say who removed it, which removal it is, or what was edited after.** Stage 1 lists remover names (`Alice, Bob`, UTF-16 order), `edited` (characters an applicable removal had not observed) and `splitBy`; the T10 test computes `by` and `edited` in its own reader (`removal-stage1.test.ts`). The entry also lacks the removal record ids its restore needs. A removed heading has the same gap.
2. **A split-off beat stays visible.** Alice removes `R1 "abcd"` while Bob, who has not seen it, splits it after `b`: every copy shows the new beat `cd` and lists only `R1 "ab"`. T11, Stage 0 assumed answer 2 and assumed rule 40 want both parts removed, `cd` marked split by Bob, and both back in place on restore. The copied oracles `commentsRemovedOracle` and `commentsRestoredOracle` are pending on package 11.
3. **A comment whose words are all deleted is not listed** (decided 2026-11-09). It stays in `comments` at its last known row and field.
4. **A comment anchored only in removed content is not marked.** It stays in `comments` like an active comment; T11 wants it in recovery with its replies until the beat is restored, then anchored again.
5. **A reply whose comment is missing is shown nowhere.** `projectSharedCommentFields` keeps only replies whose parent exists. Stage 0 assumed answer 4 keeps it in recovery.
6. **A removed person still named as a tag owner is not listed** (Stage 0 assumed answer 10).
7. **A restored rule 29 draft lands at the end of the script.** Its segment is created at a gap with no neighbours, which is the end of the order, not beside `bufferSourceOwner`.
8. **There is no discard.** Assumed rule 29 says an entry leaves recovery by being restored or discarded.
9. **Undo of restore is refused**, as is undo of a removal (moved to package 10 by assumed rule 40). The Stage 1 limit "a character undone and redone inside a removed beat is listed as edited" (`redone-recovery`, waiting for removal in `stage-2-shared-undo.md`) is not yet reproduced.
10. **Entries have no identity of their own.** A panel, a restore and a discard need one that is the same on every copy.
11. **Nothing outside the adapter reads the list.** No session port, no panel, and no export disclosure (plan section 2 item 7, section 6). The panel and export are Stage 4 product work; the read port is not.
12. **Removed headings are rebuilt on every projection step** (open item 3 from #1501).
13. **Retained recovery content is never compacted.** Removal records and removed text stay for the life of the instance; budgets and limits are Stage 3 (1a decision, carry-overs).
14. **The movement oracles assigned here (`MOVE delete`, `MOVE delete undo`) cannot run**: moving a beat is refused in a shared session (assumed rule 40). They stay pending, declared.
15. **One recovery defect is no longer caught**: `duplicate fragment not recovered` in `tests/collab/projection-mutants.json` survives (open item from #1498, package 15).

## Assumed rules

Product rules the plan and the decided rows do not settle. Each is the recommended
reading; each needs a ruling before the cut that builds it.

- **A1. Undo of restore is a new removal.** Undoing a restore removes the same beats or heading again as a fresh removal by the person who restored (the next generation). Redo restores that removal. Two people who restored the same removal without seeing each other made one change (decided: identical changes are one); either one's undo removes the beat again and the other's undo is used up. Undo of a removal is a restore of that removal (package 10).
- **A2. A split-off beat follows its source.** A beat split off a removed beat by someone who had not seen the removal is removed with it and listed split by that person. One restore brings both back, in place, the split-off part directly after the part it was split from. A split made after seeing the removal cannot happen: a removed beat refuses commands.
- **A3. Comments and replies come back with their words.** A comment whose words are in removed content is listed with its beat's entry and anchored again when that beat is restored; its replies go with it. A comment whose words are all deleted is listed on its own, keeps its last row and field, and has no restore (its words are gone); it can be discarded. A reply whose comment is missing is listed on its own and shows under its comment again if the comment comes back. All of them also stay in the document's `comments` as today, so exports do not change.
- **A4. A rule 29 draft is created beside its source.** The draft beat's segment is placed directly after the source beat's segment when the write is made, so a restore puts the kept text right after the beat it came from. This changes where the removed draft is stored, not what anyone sees, and rule 29 allows it.
- **A5. Discard hides, it does not delete.** Discarding an entry writes a record that hides it on every copy; the content stays in shared state, since destructive reclamation is outside v1 (plan section 6). Discard is an undo step; undo shows the entry again. A discarded removed beat can no longer be restored until the discard is undone.
- **A6. An entry is named by what it lists.** A removed beat by its group's root beat id, a removed heading by its heading id, a tag rejection by its occurrence id, a gallery overflow by its record id, a fragment by its segment and start, a comment or reply by its record id.
- **A7. Remover names, `edited` and `splitBy`** follow the Stage 1 assumptions in the [1a decision](stage-1/1a-decision.md#decided-and-assumed-product-answers): every distinct applicable remover in UTF-16 order, a character is edited when at least one applicable removal had not observed it, and more removals never take information away.
- **A8. A removed person named as an owner** is listed, with the owners naming them; the assignment shows as text (Stage 0 assumed answer 10). Restore re-creates the person record with its id; undo of that restore removes it again.
- **A9. Entries for merged states have no restore.** Scenes with no beats, crossing or deleted tags, gallery overflow and damaged fragments are resolved with ordinary commands offered beside the entry, each with its ordinary undo.

## Cut list

Each cut is one pull request of at most about 600 lines with its tests, in this
order. Each stops at its stop line.

1. **Inventory and union** (this pull request). The note, `SharedRecoveryEntry`, the pinning test. Stop: no value, operation or reading changes.
2. **Removal provenance on entries** (gaps 1, 10 for removals, 12). `removed-beat` and `removed-heading` carry their active removal ids, remover names and `edited` identities as derivations; removed headings use the read cache. T10 `removedOracle` is checked against the entry instead of a test reader. Needs A6, A7. Stop: no new operation; restore unchanged.
3. **Split-off beats follow the removal** (gap 2). A beat whose boundary sits in a removed beat's text, written by someone who had not observed the removal, is masked with it and listed with `splitBy`; restore brings both back in place. T11 rows and recovery of `commentsRemovedOracle` and the rows of `commentsRestoredOracle`, across the six delivery orders and a late joiner, in the removal generator. Needs A2. Stop: comment flags not yet.
4. **Comments, replies and people in recovery** (gaps 3 to 6). Entries for comments in removed content, comments whose words are all deleted, replies without a comment and removed people named as owners; the T11 comment records of both oracles. Needs A3, A8. Stop: no restore for them beyond the beat restore of cut 3.
5. **Rule 29 placement** (gap 7). The draft segment is created after its source; the literal rule 29 list and its tests change by that placement only. Needs A4. Stop: no new operation.
6. **Undo of restore** (gap 9). The undo owner records a restore and reverses it as a fresh removal; redo restores again. Literal cases for two restorers, a late restore after a new removal, and undo before delivery; restore and its undo join the seeded removal generator with a literal table of declared limits. Depends on package 10's structure undo entry. Needs A1. Stop: discard not yet.
7. **Discard** (gap 8). A discard operation with its record, its reader and its undo, in the generator. Needs A5. Stop: no panel.
8. **The read port** (gap 11). The shared session publishes the recovery list beside the document through a named port, with a test that every copy and a late joiner read the same list. Stop: no UI and no export change; the panel and export disclosure are Stage 4.

Gaps 13 to 15 stay with Stage 3 and packages 15 and 5c as listed.
