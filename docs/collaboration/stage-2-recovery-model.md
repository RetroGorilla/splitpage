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
removed group itself, then removed headings and scenes with no beats, then comments
whose words are gone and replies without their comment.

What puts content there is shared state, written by operations:

| Operation | What it leaves in recovery | Where it is prepared |
| --- | --- | --- |
| `remove` (beat removal, cut, the flow emitter's range removals) | The removed beat and the beats joined into it | `removal-executor.ts` |
| `heading-remove` | The removed heading, when its name holds text | `removal-executor.ts` |
| The rule 29 write: `segment-create` after the source's segment, then `remove`, in one list, `undo: false` | A removed draft beat holding the refused field, with its source, listed beside it | `bufferedRecoveryOperations` in `core/collab/buffer-operations.ts`, called by `BufferedTextEdit.recover` in `adapters/collab/buffer.ts` |
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

- Produced: `assembleSharedDocument`, for a joined group whose root has an active removal (`group.removed`) or is [split off a removed beat](#split-off-beats). Beats joined into a removed beat are members of the same entry (assumed rule 3); a beat removed while someone typed in it keeps that typing (decided: an edit to a removed beat goes to recovery).
- Carries: `row` (the painted row in canonical row order: id, `audioText`, `visualText`, joined fields and gallery), `members` (the beat ids of the group), `removal` (optional, see [Removal provenance](#removal-provenance)), `buffer` (optional: for a rule 29 entry, each source beat's id and its `bufferSourceOwner` and `bufferPaintedBase`, historical provenance never shown in a row or export), `splitBy` (optional: for a root split off a removed beat, the name its split recorded), `comments` (optional: the ids, in UTF-16 order, of the comments whose words are in this group and in no live cell, see [Comments in recovery](#comments-in-recovery)).
- Copies: derivation. Every copy holding the same state lists the same entry; a late joiner reads it from the removal records, per-beat removal flags and the identities of the text.
- Restore today: `restore` with the ids in `removal.ids`. An entry without `removal` has removal flags but no readable removal record (only damaged data), and `restore` refuses it.
- Restore should mean: the group back in the script where its boundaries are, with its text, marks, attachments and comment anchors, nothing copied (already true for a beat removed on its own). A rule 29 draft beat comes back as an ordinary beat after its source's segment ([Rule 29 drafts](#rule-29-drafts)).
- Undo of restore: refused today (every structure command is refused by name in the undo owner). Should be a fresh removal of the same beats by the person who restored, the next generation (assumed A1).

### `removed-heading`

- Produced: `assembleSharedDocument`, for a heading with an active `header` removal whose name still holds text; a removed heading with an empty name has no entry. The entry is cached on the heading, its name and its removal records, so an unrelated step does not rebuild it.
- Carries: `heading` (the section record: id, name and stored extras), `removal` (optional, see [Removal provenance](#removal-provenance)).
- Copies: derivation.
- Restore today: `restore` with the ids in `removal.ids`. It unmasks the heading; it does not undo the split of a demotion.
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
- Carries: `reason`, `owner` (the beat or heading id the stretch names, or null), `segment`, `field` (`audioText`, or `heading` for a heading stretch), `from` and `to` (offsets in the segment), `html` (the painted text), `start` (the first unit's identity, which names it; cut 7).
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

### `comment-without-words`

- Produced: `projectSharedLostComments` in `core/collab/recovery.ts`, for a comment whose anchor is in no shared text the projection reads: no live or removed beat cell, heading or fragment. Only a text comment is a candidate: one with a non-empty stored quote (`quote`, projected as `quotedText`), not a conflict comment and not on the title or the picture (`visualImage`). The app makes a text comment from a non-empty selection and keeps its words as the quote; a picture comment, a comment migration made from inline media (`mediaComments`) and a conflict comment carry an empty quote. Migration gives every comment an `anchorId`, so the anchor alone does not tell them apart. These are never listed (assumed rule 47). The comment stays in the document's `comments`.
- Carries: `comment` (the comment record id), `rowId` and `field` (its stored place, or null).
- Copies: derivation.
- Restore today: none. Its words are gone (decided 2026-11-09).
- Restore should mean: no restore; it can be discarded (A3, A5).
- Undo of restore: not applicable.

### `reply-without-comment`

- Produced: `projectSharedLostComments`, for a reply record whose `commentId` names no comment record. Replies are matched to comments by `commentId` alone, so the entry leaves and the reply shows under its comment again when a comment with that id comes back.
- Carries: `reply` (the stored reply key, `[commentId, id]` as JSON), `commentId`.
- Copies: derivation.
- Restore today: none; re-creating the comment brings it back under it.
- Restore should mean: no restore of its own; it can be discarded (A3, A5).
- Undo of restore: not applicable.

## Removal provenance

A `removed-beat` or `removed-heading` entry carries `removal` when at least one of its active removals has a readable removal record. It is a derivation: every copy holding the same state, and a late joiner, reads the same value.

- `ids`: the keys of the active removal records, in UTF-16 order. Those are the ids `restore` takes. A removal that a restore cancelled is not active; a removal made again after that restore is (assumed rule 33).
- `by`: every distinct remover name, in UTF-16 order, joined by `, ` (A7).
- `edited`: the identity (`client`, `clock`) of each character that at least one applicable removal had not observed, in narration order and then visual cells in row order (A7). For a heading, its name.
- Applicable removals: a beat's own active removals; a beat split off a removed beat has none of its own, so the removals that cover it apply; a beat joined into a removed beat has neither, so the removals of the group's root apply to it.

## Split-off beats

A beat with no removal flag of its own is removed by an active removal when it holds a character that removal observed (cut 3). This is how a split made by someone who had not seen the removal follows it: the split writes a new beat record and a boundary into the removed beat's text, and either side of that boundary still holds characters the remover saw. The beat is listed with `splitBy` from its record and refuses commands like a flagged beat, on every copy: the projection and the preparation index make the same decision from the same stored facts (the flags, the records' `observed` identities and the identities of the text in the removed beat's segment), so delivery order does not matter. Joins treat it exactly as a flagged beat: joined into a live beat it leaves as its own entry; a live beat joined into it goes to recovery with it.

- A split the remover had already seen is not followed: her observation covered only her own part.
- A beat split off that holds nothing the remover observed stays in the script: a split at the end, or an empty prefix of a `split-before` at the start, holds only new content (assumed rule 44 on #1414, which narrows A2).
- Restore writes nothing for it: cancelling the removal ends the cover, and the boundary never moved, so the beat comes back in place.
- An edit open in the split-off beat when the removal arrives is committed before the held removal and ends in that beat's entry as edited text, as for a flagged beat (T01).

## Comments in recovery

A comment goes where its words are (cut 4, assumed rule 47 on #1414). Its words are the characters carrying its anchor mark, and those never move: a removal, a split and a restore write no mark. Every live cell anchors first, in script order and visual column before narration, as before; then each removed group, in script order, claims the comments left whose anchor it holds, lists them in `comments` and places their `rowId` and `field` there.

- Words partly live and partly removed: the comment stays active at its first live cell and is not listed.
- Words only in removed content: the comment is listed with the first removed group in script order that holds them, also when another removed group holds the rest under a different removal, and its `rowId` names that group (T11: `C2` in the split-off `Rb`).
- Inside a removed join group the `rowId` is the group's root beat, as for a live joined row: words in `R2` joined into a removed `R1` move the comment from its stored `R2` to `R1`.
- Replies are never listed apart from a comment that exists: they stay under it, in recovery or not.
- A comment or reply written by someone who had not seen the removal is accepted, travels with the beat and is not in `edited` (marks and replies are not characters). Resolved comments are listed like open ones.
- Restore writes nothing for comments: the restored group's cells anchor them again in place (T11 restored).
- Every comment also stays in the document's `comments` (A3); only the `rowId` and `field` of a comment whose words are only in removed content change, from the stored values to the group holding them.

## Rule 29 drafts

A rule 29 draft is created after its source's segment (cut 5, assumed rule 50 on #1414). The writer reads the segment that holds the source beat when the write is made, through the same restore membership a restore uses, so a removed or split-off source has one too; the draft segment goes after that whole segment, never inside its text.

- The visible effect: the recovery list shows the draft beside its source, and a restore puts it there. A restore of the draft alone puts it after the source's segment whether the source is live or removed.
- A source the document does not hold when the write is made leaves the draft at the end of the order, as before. The typed text is never refused for that.
- A split or join made later does not move the draft: it stays after the segment it was written after.
- Several drafts of one source keep the sync library's insertion order at that gap: the latest written comes first, and of two written at the same moment the one from the copy with the lower client id comes first, the same on every copy and for a late joiner (`draft-placement.test.ts`).
- Draft and source stay separate entries with separate restores. A restored draft carries no link to its source.

## Reading the list

The shared session publishes the list beside the document (cut 8): `SharedDocumentSession.recovery()` returns the `SharedRecoveryEntry` list of the same publication as the held document, at the same revision. The session takes both from the replica in one step, so a failed publication keeps the previous document and list together, and the next one replaces both. A subscriber reads it again after each `subscribe` change; there is no changed-entries signal. A disposed session holds none.

- The rows and headings inside entries are raw projected values, not entry-checked as the document's rows are.
- The standalone session has no such port. Nothing in `src/features` reads it yet: the panel and export disclosure are Stage 4, through `Pick<SharedDocumentSession, "recovery" | "subscribe">`.
- Every copy and a late joiner read the same list (`shared-session-recovery.test.ts`).

## Entry names

An entry is named by its kind and a stored key (assumed rule 51 on #1414, amending A6), so the name is the same on every copy and for a late joiner. The kind is part of the name because a removed heading and a scene with no beats share a heading id. `sharedRecoveryEntryName` builds the name (cut 7).

| Kind | Key | Stable across | Not stable when |
| --- | --- | --- | --- |
| `removed-beat` | the group's root beat id | restore, a split (a split-off beat is its own entry), a join into the removed beat | the group's root changes: the join that made the group is undone, or the root is later joined into an earlier beat |
| `removed-heading` | the heading id | restore; headings are never split or joined | |
| `crossing-tag`, `deleted-tag` | the occurrence id; `rowId` follows joins | restore, split, join | an adjacent piece of the same tag is added or removed: the extent takes the smallest occurrence id of the pieces it merges |
| `gallery-overflow` | the gallery record id; `rowId` follows joins | restore, split, join | |
| `unprojectable-fragment` | its segment and its first unit's identity | typing before it | the fragment's first character is deleted |
| `scene-with-no-beats` | the heading id; not discardable, it follows its beats | | |
| `comment-without-words`, `reply-without-comment` | the comment or reply record id | | |

A removed beat or heading removed again after a restore has the same name, so a discard of it records the removal ids it saw, as a restore does, and a fresh removal shows again.

## Discard

Discard is built (cut 7, assumed rule 52 on #1414). A `discard` operation names an entry and, for a removed beat or heading, the removal ids its writer saw; it writes one record in the `discards` root, keyed by writer and operation id. Undo writes `discard-retire`, which marks that key in the `retiredDiscards` root; redo writes a fresh discard. Neither record is ever deleted.

- An entry is hidden while an active discard has its name and, for the removal kinds, every current removal id was seen by an active discard. A removal the discarder had not seen shows the entry again.
- A discarded entry leaves `session.recovery()` entirely; undo is the way back.
- A restore of a removal that an active discard saw is refused as `discarded`. A restore and a discard made without seeing each other both land; the restore wins and the entry is gone with its removal.
- The discard does not check that the entry is listed when it is written. A discard whose entry is not listed hides nothing until that name is listed.
- A scene with no beats is refused as `not-discardable`.
- The three names that can change fail open: a new root, a merged tag occurrence id or a new first character gives a new name, and the entry shows again. Pinned by `recovery-discard.test.ts`; the deleted first character also by `discard.test.ts`.
- Hiding is a filter over the built entry list, read from the two roots' versions through the projection cache. With both roots empty it returns the same list.

## Declared limits

- Comment placement is not cached: every assembly rescans the units of every removed group, every heading and every unprojectable fragment for anchors, and sorts all comments and replies. This is a cost for the shared-session timings; the pinned cost lists hold no removed content, so they do not measure it.

- Characters brought back by undo of a deletion are new (rule 39), so they count as edited, not observed. A beat split off that holds only such characters stays in the script, although its words are the ones the remover saw. Pinned by `split-removal.test.ts`.

- Discard and retired-discard records are never deleted: about 114 bytes per discard and 150 per undo and redo pair, measured on a removed beat (`discard.test.ts`).
- A tag extent that grows under the same occurrence id keeps its name, so a discard still hides it. A comment whose words come back and are deleted again stays hidden.
- A discard refuses restore by removal id, so it also blocks restoring the other targets of that removal until it is undone.

The removal records, per-beat removal flags and heading removal fields are read through the same per-key caches as the rest of the projection, and every projection unit carries the identity its mark state already read. A removed beat adds no native read; a removed heading reads each of its removal records once, on the first projection, and from the cache after. The provenance of a removed group is cached on its units and removal ids, and a removed heading's entry on its heading, name and removal records.

## What is not an entry

These keep work, but locally, on one copy, and are not in the list:

- A rule 29 write that the document refuses: the typed text stays in the field and the reason is shown (assumed rule 38). A save that fails with an error, not a refusal, also keeps the text in the field.
- Updates held while someone types (assumed rule 26). They are delivered on release; nothing is dropped.
- The standalone recovery paths: drafts, history snapshots and the conflict stash. A shared session neither reads nor clears them (assumed rule 37).

## Gaps against the plan and Stage 1

1. **Closed by cuts 2 and 3.** A removed beat's or heading's entry says who removed it, which removals are active and what was edited after ([Removal provenance](#removal-provenance)); the T10 test reads `by` and `edited` from the entry. A split-off beat's entry carries `splitBy`.
2. **Closed by cut 3** ([Split-off beats](#split-off-beats)). A beat split off a removed beat by someone who had not seen the removal is removed with it, listed with `splitBy`, and restored in place. The copied oracles `commentsRemovedOracle` and `commentsRestoredOracle` run since cut 4 (`comment-recovery.test.ts`).
3. **Closed by cut 4.** A comment whose words are all deleted is listed as `comment-without-words` at its stored row and field (decided 2026-11-09).
4. **Closed by cut 4** ([Comments in recovery](#comments-in-recovery)). A comment whose words are only in removed content is listed with that group, with its replies, and anchored again when the group is restored.
5. **Closed by cut 4.** A reply whose comment is missing is listed as `reply-without-comment` (Stage 0 assumed answer 4).
6. **A removed person still named as a tag owner is not listed** (Stage 0 assumed answer 10). Deleting a person deletes its record, so its name is not kept; a later cut keeps the name at deletion and adds the entry and restore together (assumed rule 47 narrows A8).
7. **Closed by cut 5** ([Rule 29 drafts](#rule-29-drafts)). A rule 29 draft is created after its source's segment and listed beside it.
8. **Closed by cut 7** ([Discard](#discard)). An entry leaves recovery by being restored or discarded (assumed rule 29); discard is an undo step.
9. **Undo of restore is refused**, as is undo of a removal (moved to package 10 by assumed rule 40). The Stage 1 limit "a character undone and redone inside a removed beat is listed as edited" (`redone-recovery`, waiting for removal in `stage-2-shared-undo.md`) is not yet reproduced.
10. **Closed by cut 7** ([Entry names](#entry-names), assumed rule 51). Every entry kind has its name; a fragment carries `start` for it. For removals, `removal.ids` is what a restore and a discard take.
11. **Closed by cut 8** ([Reading the list](#reading-the-list)). The shared session publishes the list beside the document. No panel and no export disclosure yet (plan section 2 item 7, section 6); those are Stage 4 product work.
12. **Closed by cut 2.** Removed headings were rebuilt on every projection step (open item 3 from #1501); the entry is now cached.
13. **Retained recovery content is never compacted.** Removal records and removed text stay for the life of the instance; budgets and limits are Stage 3 (1a decision, carry-overs).
14. **The movement oracles assigned here (`MOVE delete`, `MOVE delete undo`) cannot run**: moving a beat is refused in a shared session (assumed rule 40). They stay pending, declared.
15. **One recovery defect is no longer caught**: `duplicate fragment not recovered` in `tests/collab/projection-mutants.json` survives (open item from #1498, package 15).

## Assumed rules

Product rules the plan and the decided rows did not settle. All nine were accepted as
written (assumed rule 43 on #1414), with two riders: A5 discard only hides, and deleting
data stays Stage 3; A3 keeps the 2026-11-09 decision exactly (a comment whose words are
all deleted is listed, with no restore).

- **A1. Undo of restore is a new removal.** Undoing a restore removes the same beats or heading again as a fresh removal by the person who restored (the next generation). Redo restores that removal. Two people who restored the same removal without seeing each other made one change (decided: identical changes are one); either one's undo removes the beat again and the other's undo is used up. Undo of a removal is a restore of that removal (package 10).
- **A2. A split-off beat follows its source.** A beat split off a removed beat by someone who had not seen the removal is removed with it and listed split by that person. One restore brings both back, in place, the split-off part directly after the part it was split from. A split made after seeing the removal cannot happen: a removed beat refuses commands. Narrowed by assumed rule 44: a split-off beat that holds nothing the remover observed stays in the script.
- **A3. Comments and replies come back with their words.** A comment whose words are in removed content is listed with its beat's entry and anchored again when that beat is restored; its replies go with it. A comment whose words are all deleted is listed on its own, keeps its last row and field, and has no restore (its words are gone); it can be discarded. A reply whose comment is missing is listed on its own and shows under its comment again if the comment comes back. All of them also stay in the document's `comments` as today, so exports do not change. Settled by assumed rule 47 on #1414: words partly live keep the comment active at its first live cell; words only in removed content move its `rowId` and `field` to the first removed group holding them, in script order; a comment with no text anchor is never listed as without words; a comment or reply from someone who had not seen the removal travels with the beat and is not edited; resolved comments are listed like open ones; a reply without a comment is named by its stored key.
- **A4. A rule 29 draft is created beside its source.** Settled by assumed rule 50: the draft beat's segment is placed after the source beat's segment when the write is made, so a restore puts the kept text after the beat it came from. Visible effect: the recovery list shows the draft beside its source.
- **A5. Discard hides, it does not delete.** Discarding an entry writes a record that hides it on every copy; the content stays in shared state; actually deleting data is Stage 3. Discard is an undo step; undo shows the entry again. A discarded removed beat can no longer be restored until the discard is undone. Settled by assumed rule 52: [Discard](#discard).
- **A6. An entry is named by what it lists.** A removed beat by its group's root beat id, a removed heading by its heading id, a tag rejection by its occurrence id, a gallery overflow by its record id, a fragment by its segment and its first unit's identity (amended by assumed rule 51: a start offset shifts with typing before it), a scene with no beats by its heading id, a comment or reply by its record id. Stability per kind: [Entry names](#entry-names).
- **A7. Remover names, `edited` and `splitBy`** follow the Stage 1 assumptions in the [1a decision](stage-1/1a-decision.md#decided-and-assumed-product-answers): every distinct applicable remover in UTF-16 order, a character is edited when at least one applicable removal had not observed it, and more removals never take information away.
- **A8. A removed person named as an owner** is listed, with the owners naming them; the assignment shows as text (Stage 0 assumed answer 10). Restore re-creates the person record with its id; undo of that restore removes it again. Narrowed by assumed rule 47: not built with the comment entries, because a deleted person's name is not kept; a later cut keeps it at deletion and adds the entry and its restore together.
- **A9. Entries for merged states have no restore.** Scenes with no beats, crossing or deleted tags, gallery overflow and damaged fragments are resolved with ordinary commands offered beside the entry, each with its ordinary undo.

## Cut list

Each cut is one pull request of at most about 600 lines with its tests, in this
order. Each stops at its stop line.

1. **Inventory and union** (this pull request). The note, `SharedRecoveryEntry`, the pinning test. Stop: no value, operation or reading changes.
2. **Removal provenance on entries** (gaps 1, 10 for removals, 12). `removed-beat` and `removed-heading` carry their active removal ids, remover names and `edited` identities as derivations; removed headings use the read cache. T10 `removedOracle` is checked against the entry instead of a test reader. Needs A6, A7. Stop: no new operation; restore unchanged.
3. **Split-off beats follow the removal** (gap 2, done). A beat that holds a character an active removal observed is removed with it and listed with `splitBy`; restore brings both back in place. Literals for the T11 rows and recovery, joins, an open edit and undo-restored characters, and a seeded generator. Needs A2 as narrowed by assumed rule 44. Stop: comment flags not yet.
4. **Comments and replies in recovery** (gaps 3 to 5, done). Entries for comments in removed content, comments whose words are all deleted and replies without a comment; the T11 comment records of both oracles. Needs A3 as settled by assumed rule 47. Stop: no restore for them beyond the beat restore of cut 3; removed people moved to a later cut (A8 as narrowed).
5. **Rule 29 placement** (gap 7, done). The draft segment is created after its source's segment; the literal rule 29 list and its tests change by that placement only. Needs A4 as settled by assumed rule 50. Stop: no new operation.
6. **Undo of restore** (gap 9). The undo owner records a restore and reverses it as a fresh removal; redo restores again. Literal cases for two restorers, a late restore after a new removal, and undo before delivery; restore and its undo join the seeded removal generator with a literal table of declared limits. Depends on package 10's structure undo entry. Needs A1. Stop: discard not yet.
7. **Discard** (gaps 8 and 10, done). A discard operation with its record, its reader and its undo, in its own seeded generator. Needs A5 as settled by assumed rule 52. Stop: no panel.
8. **The read port** (gap 11, done). The shared session publishes the recovery list beside the document through a named port, with a test that every copy and a late joiner read the same list. Stop: no UI and no export change; the panel and export disclosure are Stage 4.

Gaps 13 to 15 stay with Stage 3 and packages 15 and 5c as listed.
