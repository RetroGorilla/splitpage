# Structure projection rules

These rules extend the [text projection](stage-2-merged-projection.md). They read
plain validated data in core; adapters read native segment heads, embedded
boundaries, mark records, joins and removal flags. Reading changes no shared
bytes, state vector, revision or transaction count. No executor or cache is added.

Production ordinary/prefix splits and blank creation are covered by the
[split projection rules](stage-2-split-projection.md), including malformed boundary recovery.

## Answers and literal tests

Source lines refer to [Stage 0 answers](stage-0/8-schema-hypotheses.md#projection-answers-for-merged-states-both-candidates).

| Case | Answer | Test family |
| --- | --- | --- |
| Joins (104) | “Joined into the `into` of its smallest joinId”; “chains ... resolve to the first live beat” | `smallest join id wins and chains reach their root` |
| Removed target (104) | “A beat whose join target is removed is projected inside the removed group” | `removed join target recovers the entire group` |
| Group status (105) | “Highest rank ... across the group's beat records, as today” | `join roots keep entered fields and use highest status` |
| Causal status (106) | “two changes to different values, neither having seen the other, leave the status as it was before both” | `existing causal status reader feeds join groups` |
| Removed content (108) | “Shown with that beat in recovery; restored with it” | `removed join group retains marked text, comments, replies and pictures` |
| Empty scene (109) | “Heading kept visible; listed in recovery ... left out of sections export until a beat exists” | `scene without beats remains in recovery`; `native heading without a following beat is recovered` |
| Empty heading (110) | “No scene” | `cleared heading creates no scene`; `empty heading boundaries do not replace a named scene` |
| Empty script (111) | “Empty script shown ... no synthetic row” | `empty script has no invented beat`; `empty script keeps its heading in recovery` |
| Paragraph flags (112) | “Ignored; stored value untouched; exports write it only for visible beats” | `paragraph flags are inert at implicit and joined starts`; `removed joining beat recovers separately` |
| Split tag parts (117) | “Each part is its own extent of the same occurrence key, projected per beat” | `native split boundary cuts one stored tag occurrence per beat` |
| Glue (120) | “Today's joinCells rule, computed from the live last character before and first character after the joined boundary” | `live join glue matches standalone` |
| Boundary marks (121) | “Ignored” | `native split boundary cuts one stored tag occurrence per beat` |

## Coordinator rulings

The duration and per-beat field ruling follows the standalone join's root spread
in `src/core/flow/flow.ts:577`. The surviving identity, duration, stamp and other
beat details stay on the root. Joined values remain in state. Visual text combines
as `joinedVisualText` does at lines 558–562, root first, with a line break between
non-empty cells. The group status still follows line 105 above. The literal root
field test compares each field with a standalone join of the same two plain beats.

For a join cycle, choose its earliest non-removed member in merged row order;
if every member is removed, choose the earliest member and recover the whole
group. Ignore the root's outgoing edge only in projection. Other live cycle
members and their incoming beats follow the root in merged row order, using the
standalone separator from `flow.ts:575`. Removed cycle members recover separately,
including outside beats joined into them. Clearing a removal flag recomputes the
same grouping; it never clears a join. Equal row positions use UTF-16 beat ids.
Native join ids also compare in UTF-16 order. Acyclic join traversal retains the
prototype's ordered child traversal; dangling targets leave their source intact.

Literal cycle tests cover mirrored authors, two/three/four beats, an earlier
outside beat, the three-person removal case, both members removed, a removed
middle member, outside joins into removed members, and raw removal-flag clearing.
All run on two and three copies, reordered/duplicated delivery and encoded late
joiners, comparing complete documents, recovery and canonical saved bytes.

## Assumed, for the product owner

- Joined beats appear as one beat with all their text.
- The joined beat keeps the surviving beat's duration and last-edited details.
- Other beat details stay as they were on the surviving beat.
- Both beats' visual text appears, with the surviving beat's visual first.
- A joined group's status is the highest status of its members.
- A removed beat and its attached content remain in recovery.
- A scene with no beats stays in recovery, and an empty script has no invented beat.
- Paragraph flags on joined or removed beats do not create paragraphs in the script.
- When two people join the same beats into each other at the same moment, the result is one beat with both texts in the order the rows ended up.
- When beats were joined into each other by two people and one of them is removed by a third at the same moment, the removed beat's text goes to recovery and the rest stays as one beat.

## Coverage boundary

States are authored directly through monitored constructors because structure
executors are a separate package. The seeded history shuffles joins, cycles,
moves, removals, retirements, heading clearing, duration/paragraph scalars and
status across writers, with a literal empty declared-limit table. A second
generator checks arbitrary join/removal/retirement values, termination, text
conservation and encoded reload agreement.

Gallery folding/overflow and duplicate b-roll keys remain the record group.
This step assembles distinct gallery items without applying those later limits.
Semantic undo of one side of a cycle is not covered; the undo package decides it.
Raw flag-clearing tests assert projection behavior, not an undo command.
