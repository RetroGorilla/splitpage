# E5 heading races

## Verdict

A removal flag on the heading record keeps the heading and its name recoverable, even when the heading is a
segment's first boundary. Restore clears the flag. This uses one ordinary map write per removal and keeps the
same text in the same container. Every copy agreed and every surviving character was editable or recoverable.

Deleting an embedded boundary also kept the characters. A preceding block in the same segment picked up the
name when one was present. A segment head has no embed to delete. Deleting its `head` key left the name in
an unowned prefix, even when a beat embed followed in the same segment. The reader exposed no editor or
recovery action for that prefix. The flag passed, so E5 stopped after those two representations.

## Numbers

There were 200 seeds per delivery mode and 30 steps per seed. Each run had three writers and an encoded late
joiner. The five modes were forward, reverse, duplicate, shuffled with repeats, and state-vector diff. The same
seeds drove both variants. Commands could differ once the two models showed different things.

| Settled results | Delete boundary | Flag |
| --- | ---: | ---: |
| Generated runs | 1,000 | 1,000 |
| Write commands | 23,785 | 23,665 |
| Split / join / unjoin | 2,770 / 3,620 / 1,425 | 2,595 / 3,565 / 1,255 |
| Beat remove / restore | 1,860 / 565 | 1,730 / 545 |
| Heading create / rename type / rename delete | 2,130 / 1,965 / 1,340 | 2,235 / 1,985 / 1,350 |
| Heading remove / restore | 2,150 / — | 2,100 / 625 |
| Characters lost from storage | 0 | 0 |
| Characters duplicated in storage or display | 0 | 0 |
| Stored characters with no editor or recovery | 790 in 525 runs | 0 |
| Copies that differed at settlement, including late joiners | 0 | 0 |
| Runs showing a row or heading out of stored order | 0 | 0 |
| Crashes | 0 | 0 |

These are counts across all deliveries. For the 200 distinct deletion histories, 158 characters were stranded
in 105 histories. A recovery entry counts as reachable because restore gives it an editor again. E2 reported 135
seam splits under its original reading. E5 used a separate, more heavily weighted unjoin command routed through
the same seam split.

The table follows characters typed into a heading whose removal was concurrent with that keystroke. Each
keystroke counts once per run, even when two people removed its heading. The location is where it finished,
after any subsequent commands. "Another heading" can happen when a new boundary lands at the name's last gap.

| Final location | Delete boundary | Flag |
| --- | ---: | ---: |
| The removed heading's name, in recovery | 0 | 330 |
| The same heading after restore | 0 | 125 |
| Another visible heading | 25 | 30 |
| Another removed heading, in recovery | 0 | 10 |
| Visible narration | 240 | 0 |
| A removed beat's narration | 65 | 0 |
| Uneditable prefix | 195 | 0 |
| Deleted by a later edit | 85 | 70 |
| Total | 610 | 565 |

### Stored bytes

Yjs 13.6.33 on Node 24.22.1. Sizes are the full encoded document after loading a fresh copy with no editing
history. The base was 431 bytes. One-command deltas use the same sequence in each case. Create `H100` with one
ASCII letter, append a letter, backspace it, then remove the heading. The last column uses 1,000 distinct
one-letter creates and removals, starting at the base, with no renames.

| Removal and placement | Create | Type | Backspace | Remove | Added after 1,000 cycles |
| --- | ---: | ---: | ---: | ---: | ---: |
| Delete embed | +46 | +1 | +12 | −10 | 39,917 |
| Delete segment head | +104 | +6 | +4 | −8 | 98,936 |
| Flag embed | +46 | +1 | +12 | +15 | 65,934 |
| Flag segment head | +104 | +6 | +4 | +15 | 122,942 |

The embedded flag case adds about 66 bytes per create and remove. A new segment brings that to about 123 bytes.
Each flag case keeps all 1,000 records, names, boundaries and flags live. The head case also keeps 1,000 segment
records, text containers and order entries. They stay for the life of the document without compaction. Deletion
keeps the 1,000 heading records with no heading that reads them, the 1,000 letters, and deletion markers. It also
keeps the extra segments, text containers and order entries in the head case. Removing and restoring the same
existing heading 1,000 times added 21 bytes total after reload. No live removal flag remained.

### Silent-write controls

Each control replaced one writer method in memory. The recorded steps and model were identical to the clean run.
The test required a mismatch on the first occurrence of the silenced command, before any later command could
fail from a missing target. A throw did not count. Deletion has no heading restore command.

| Silenced command | Delete boundary, used / failed | Flag, used / failed |
| --- | ---: | ---: |
| Create heading | 865 / 865 | 885 / 885 |
| Type in name | 865 / 865 | 860 / 860 |
| Delete from name | 715 / 715 | 755 / 755 |
| Remove heading | 875 / 875 | 875 / 875 |
| Restore heading | — | 470 / 470 |
| Type in beat | 995 / 995 | 995 / 995 |
| Delete from beat | 720 / 720 | 745 / 745 |
| Split beat | 935 / 935 | 950 / 950 |
| Join beat | 995 / 995 | 1,000 / 1,000 |
| Unjoin beat | 760 / 760 | 695 / 695 |
| Remove beat | 880 / 880 | 865 / 865 |
| Restore beat | 450 / 450 | 425 / 425 |

## Named histories

The 13 histories below ran with two writers, all five deliveries and a late joiner. Three additional restore
histories ran on the flag. These outcomes have literal expectations as well as the model check.

| Race | Result |
| --- | --- |
| Remove embedded heading against typing in its name | Delete gives `DX` to the preceding beat. Flag gives `DX` to the removed heading in recovery. |
| Remove against deleting the only name letter | The observed letter is gone in both. Flag can still restore the empty heading. |
| Remove against a split directly below or above | Both splits keep their two halves. Delete gives the name to the beat immediately before the deleted boundary, including the split-off half when the split is above. Flag keeps it in recovery. |
| Remove against a join directly below or above | Both joins keep both beats in order. Delete adds the name to the preceding beat's narration. Flag keeps it in recovery. |
| Two creates above the same beat with an embed or a segment head | Both headings show in stored order. The lower client id goes first in these two cases. Its heading can be edited even with no beat beneath it. |
| Both writers remove the same embedded heading | The heading disappears once. Its text joins the preceding block with deletion and stays in one recovery entry with the flag. |
| Both writers remove the same segment-head heading | Deletion strands its letter. The flag keeps one recovery heading. |
| Remove the segment head against typing at the start of its first beat | `X` is first in the beat in both. Deletion strands the old name `A`. The flag keeps `A` in recovery. |
| Remove the segment head against typing in its name | Deletion strands `XA`. The flag keeps `XA` in recovery. |
| Create another heading in the last gap of the removed name while someone types `X` there | Both put `X` in the new heading. The old `A` is stranded by deletion and recoverable with the flag. |
| Restore after remote name typing, for an embedded heading and a segment head | The flag exposes the name at the original boundary. The embedded case then deletes the original letter through the heading editor. |
| Restore after seeing only the lower-priority of two concurrent removals | The unseen removal still stands on every copy. This is ordinary map behavior. |

An active heading starts a new group on the reading used here. The contiguous beat join rule resumes when that
heading is removed. A join flag written across an active heading can take effect when the heading disappears.
A hidden heading keeps its own name range. E5 also leaves consecutive headings editable and offers a restore
for empty removed headings. The older rules about empty scenes, joined headings and paragraphs (S16, S21, S35,
S37, S41 and R17) are product choices. E5 measures the results without choosing those policies.

## What the checks read from the implementation

The model imports neither Yjs nor the prototype. The fixture, commands, target offsets, delivery schedule and
client order are inputs. The model replays symbolic characters, boundaries, and finite map histories from the
commands a copy has seen. It predicts the order of competing insertions and the winning flag. It never reads
an actual winner, inserted id, position, or local view to build a later command or expectation.

- Update packets and state vectors drive the five delivery modes. The runner uses the transaction origin to
  attach local packets to recorded commands. It advances the model with the scheduled delivery regardless of
  the packets' contents.
- The public shared types give the actual segment order, each segment's head and text units, heading record ids
  and removal booleans, beat record ids, removal presence and join target, and visual cell ids and text. These
  are compared with the model after each command and delivery, and on all settled copies. The same raw text
  shows whether a missing projected letter was still stored. Beat removal stamps and formatting are outside
  that comparison.
- The reader gives the actual outline, row ids and member order, narration and visual text, and the row parts
  that route edits. It also gives the beat recovery reason, ids, member order and text, and the visible and
  removed heading ids and names. These are actual display results for comparison, counting and location.
  A separate order count compares the actual outline with the actual stored order. The expected outline
  still comes from the commands.
- The focused tests also read the row's HTML text to check a real narration edit, and a hydrated heading map to
  check that its extra field survives removal and restore. They check missing-editor errors for the stranded
  prefix. The harness records command or reader exceptions as failures.
- Full encoded byte lengths after reload give the size results. Public type entries give the counts of retained
  segments, letters, records and live flags. Byte lengths are measurements, never expected characters or flags.

## Limits and least certain result

This covers one fixture with two segment shapes, single-character edits, and short runs. T08 and T09 informed
the boundary cases. Full Writer flows such as heading promotion and demotion, cross-heading selections,
cut and paste, composition, moves, formatting, atoms, undo/redo and browser behavior were outside E5. The study
also omits paragraph updates, the name limit, and permanent discard. Delivery is eventually complete.

The least certain part is how often an end-of-name keystroke changes owners in real scripts. E5 pins a short
example and counts it with both removals. The frequency depends on which gaps people edit, what else is inserted
there, and which changes they have seen. The size deltas also depend on the placement, id length and surrounding
edits. The model's symbolic ordering is specific to the plain text, embeds and flags exercised here.

## Reproduce

```
npm ci --prefix prototypes/collab
cd prototypes/collab
node --test test/native/e5-headings.test.ts
```
