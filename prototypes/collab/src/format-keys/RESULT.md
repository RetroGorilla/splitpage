# E4: formatting keys over a long life

Prototype evidence for Yjs 13.6.33 on Node 24.22.1. The main comparison uses plain
`Y.UndoManager` and action keys without the experimental normalisation rule.

| Measure | One key per kind | One key per action |
| --- | --- | --- |
| Day 250 stored bytes, one writer, baseline workload | 437,985 | 521,823 |
| Mean bytes added per formatting action, one writer, baseline | 57.2 | 80.8 |
| Stored bytes per visible character, one writer, baseline | 19.3 | 23.0 |
| Keys per formatted character, median / p95 / max, one writer, baseline | 3 / 6 / 9, max 1 of one kind | 3 / 7 / 17, max 5 of one kind |
| Median read of the scheme's busiest cell, one writer, baseline | 0.0280 ms | 0.0452 ms |
| Day 250, one writer, heavy workload | 2,234,969 bytes, 58.1 bytes/action, keys 5 / 8 / 15, read 0.0409 ms | 3,398,236 bytes, 85.8 bytes/action, keys 7 / 14 / 25, read 0.5874 ms |
| Missing bold in the 60 unseen-pair trials | 72 letters missing at merge, 290 across all checkpoints | 0 at merge and across all checkpoints |
| Bold left where an undo should have cleared it | 34 letters across the paired trials. In the standalone `bXc` trace it extends from `c` to the end. | 30 letters across the paired trials. In the standalone `bXc` trace it stays on `c`. |
| Undo reaches a different step | 6/120 presses in the paired trials. The subsequent seen-unbold trace also deletes older typing in both client orders. | 0/120 in the paired trials. The subsequent seen-unbold trace deletes older typing in both client orders. |
| Updates per undo | 116 presses sent one update and 4 sent two in the paired trials. | Each of the 120 paired presses sent one. |
| Plain `X` typed while the other format was unseen | Bold on `X` in 11/20 trials after merge. | Bold on `X` in 20/20 trials after merge. |
| Writer and late-joiner agreement | All 66 trials agree at every checkpoint. | All 66 trials agree at every checkpoint. |
| Punch, 100 → 300 rounds | 2,262 → 5,433 bytes, 17.5 → 16.4 bytes/round, max 1 key | 78,797 → 210,118 bytes, 782.8 → 698.7 bytes/round, max 101 → 301 keys |
| Prefix, 100 → 300 rounds | 1,337 → 4,138 bytes, 12.3 → 13.4 bytes/round, max 1 key | 5,054 → 15,455 bytes, 49.5 → 51.2 bytes/round, max 100 → 300 keys |
| Scheme machinery beyond plain library calls | Named attributes (`b: true`, `i: true`, etc.). | Client-and-clock keys, suffix stripping and de-duplication on read, visible-key scans, tail re-keying on unformat, special handling of typed and pasted text. The proposed bounds add a limit check, collapse and a rebuild. |

The paired trials show outcomes conditional on the timing, ranges and undo order below.
E4 did not measure the per-keystroke cost of maintaining action keys or how often any of these situations
occurs in real editing. E4 leaves the choice of key scheme to the owner.

## Synthetic workload

| Input | Chosen values |
| --- | --- |
| Starting script | Demo tape `typingTape(1)`. It types 11,287 characters and leaves 10,424 visible characters and 72 formatted runs, 61 of them tags. |
| Daily revisions | About 1,000 characters of replacement typing, in chunks of 5–40. Delete a nearby-length span clipped at the end, then type the replacement letter by letter with the marks to its left. |
| Formatting and formatted pastes per day | Baseline 20 commands and 2 pastes. Heavy 200 commands and 20 pastes. The generator calls the baseline `realistic`. Counts in the results reflect executed formats and pastes. |
| Range sizes | New selections 3–40 characters. Paste samples 10–60, clipped at the end and excluding atoms. A paste replaces a selection of its own length. |
| Revisiting a run | Baseline 20%, heavy 50%, applied only when the exact kind already has a run in the selected cell. With a revisit, jitter each edge up to 6 characters. A command toggles off if the whole selection already shows the kind. |
| Kind mix | Tags 40%, highlight 15%, bold 15%, italic 10%, direction 5%, cue 5%, comment 10%. A comment command has a 40% chance of resolving one if the cell contains an open comment. |
| Undo | 10% chance of an immediate undo after a completed format or paste through the normal path. Comment resolution returns before this draw. |
| Writers and delivery | 1, 2 or 6 writers. Five sync rounds in the revision phase and five in the formatting phase. Each writer gets a different beat in a round. All writers sync before the next round. |
| Life seed | 7, with the random stream initialised from `7 × 1000 + writers`. |

There are **zero** unseen same-kind format pairs on the same cell in every life workload, with 1, 2 or 6 writers.
These runs therefore say nothing about how often either scheme misbehaves in those situations. The results have
nine checkpoints, on days 1, 5, 10, 25, 50, 100, 150, 200 and 250.

For one writer on the baseline workload, the cumulative action-key mean rose from 65.7 bytes per action on day 25
to 80.8 on day 250. The visible script grew from 10,424 at the start to 22,696 characters, with 12,919 on day 25.
The bytes-per-action calculation counts storage added during the formatting phase and divides by the total
formatting commands and pastes, including the effect of immediate undos. Full stored size includes the typing
phase and Yjs history and excludes the undo stack. Each scheme chooses its own busiest cell by the total live
keys summed over its characters. For example, at day 250 the baseline single-writer cells were `r13/audioText`
for kind keys and `r19/audioText` for action keys. Read time is the median of 21 calls to read its delta and produce runs.

With the same one-writer seed and the baseline revisit chance raised from 20% to 40%, day 250 moved from
3/7/17 to 3/8/14 keys per formatted character (median/p95/max), from 5 to 6 most of one kind, and from 80.8 to
81.2 bytes per action. The 40% run stored 525,452 bytes for 23,306 visible characters. One seed cannot rank
the workload assumptions.

## Two-copy outcomes

The starting cell is `abcdefgh`. In the 30 paired rows A bolds `cdef` and B acts on `a`, `ab`, `efg`, `de`
or `cdef`, respectively. The add/add cases start plain. The add/unbold cases start with B's range already bold
from a shared fixture, so B's unbold acts on formatting it saw. The expectation preserves A's unseen bold.
A and B make the range commands before either receives the other's update. B optionally types a plain `X` after
`d`, either before seeing A's command (unseen) or after both range commands sync (seen). The three standalone
traces at the end use `bc` and type after `b` or unbold after seeing the bold.

Both actors begin with an older typing entry (A's `Q`, B's `R`) except in the marked standalone row. A undoes
first. B then undoes its own last command (typing when it typed). A and B each redo once in that order.
Every row runs twice per scheme, with A assigned the lower and then the higher client ID. At each checkpoint
the two writers sync and a late joiner loads each writer's saved state.

Each result cell has six fields, separated by dots.

1. **Missing letters**, summed across the two client orders at each checkpoint. Order is first merge, after typing
   if it was seen, undo A, undo B, redo A, redo B. Unseen typing is already part of the first merge.
2. **Letters still bold after an undo that should have turned them plain**, summed across client orders, for A/B.
   A letter still covered by another active request is excluded.
3. **Steps taken by undo**, for A/B. Each pair gives lower-ID A first, higher-ID A second. `r` is the intended step,
   `w` an older step, and `e` would mean no step.
4. **Local Yjs updates per undo press**, in the same two-order A/B notation.
5. **Runs with bold on plain `X`** immediately after its merge, out of two when typing occurs.
6. **Writer or late-joiner disagreements** over all checkpoints.

| Range relation or trace | B's range command | Typing | Kind keys | Action keys |
| --- | --- | --- | --- | --- |
| Separated | bold | none | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Separated | bold | unseen | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 |
| Separated | bold | seen | 0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Separated | unbold | none | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Separated | unbold | unseen | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 |
| Separated | unbold | seen | 0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Touching | bold | none | 4/0/0/4/4 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Touching | bold | unseen | 4/0/0/4/4 · 0/0 · r,r/r,r · 1,1/1,1 · 1 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 |
| Touching | bold | seen | 4/4/0/0/4/4 · 2/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Touching | unbold | none | 8/0/0/8/8 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Touching | unbold | unseen | 8/0/0/8/8 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 |
| Touching | unbold | seen | 8/8/0/0/8/8 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Overlapping | bold | none | 2/6/0/0/2 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Overlapping | bold | unseen | 2/6/6/2/2 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 |
| Overlapping | bold | seen | 2/2/0/6/2/2 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Overlapping | unbold | none | 0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/2,2 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Overlapping | unbold | unseen | 0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 2 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 |
| Overlapping | unbold | seen | 0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Nested | bold | none | 2/4/0/0/2 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Nested | bold | unseen | 2/2/4/2/2 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 |
| Nested | bold | seen | 2/2/2/4/2/2 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0/0 · 2/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Nested | unbold | none | 0/0/0/2/0 · 4/0 · r,r/r,r · 1,1/2,2 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Nested | unbold | unseen | 0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 2 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 |
| Nested | unbold | seen | 0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Identical | bold | none | 0/4/0/4/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Identical | bold | unseen | 0/2/4/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 |
| Identical | bold | seen | 0/0/2/4/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Identical | unbold | none | 8/0/0/0/8 · 0/0 · w,w/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Identical | unbold | unseen | 8/0/0/8/8 · 0/0 · w,w/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · r,r/r,r · 1,1/1,1 · 2 · 0 |
| Identical | unbold | seen | 8/8/0/0/8/8 · 0/0 · w,w/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0/0 · 4/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Bold bc, then type X | none | seen | 0/0/0/0/0/0 · 2/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0/0 · 2/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Bold bc, then type X (no older step) | none | seen | 0/0/0/0/0/0 · 2/0 · r,r/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0/0 · 2/0 · r,r/r,r · 1,1/1,1 · 0 · 0 |
| Bold bc, then unbold bc | unbold | none | 0/0/0/0/0 · 0/0 · w,w/r,r · 1,1/1,1 · 0 · 0 | 0/0/0/0/0 · 0/0 · w,w/r,r · 1,1/1,1 · 0 · 0 |

With plain undo in the standalone `bXc` trace without older typing, both client orders show
`abX[cdefgh|b]` with kind keys and `abX[c|b]defgh` with action keys after A undoes. The action-key path
re-keyed the tail to keep `X` plain, and the tail's key survives the author's plain undo. The kind-key result
also bolds the following letters. In the standalone seen-unbold trace, A's undo deletes its older `Q` under
both schemes in both client orders. The stack-item identity and the missing `Q` confirm which edit was undone.

## Normalisation variants

The experimental rule turns off same-kind keys it saw when their whole run falls inside the new format's range.
The race compares action keys with and without that rule. The fixture is `abcdefgh`, with `bcd` bold and `gh`
italic. Seeds 1–2,000 per cohort drive 20 steps of add, remove, delete, insert (plain, inherited, bold or
italic), undo and peer delivery.

| Writers | Delivery | Histories | Rule fired | Concurrent typing / format / unformat / deletion / undo / own undo | Differed | Still differed without undo | Stopped at first difference | Disagreed without / with rule |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | updates | 2,000 | 1,432 | 958 / 1033 / 697 / 609 / 918 / 427 | 72 | 20 | 43 | 0 / 0 |
| 2 | shuffled | 2,000 | 1,432 | 958 / 1033 / 697 / 609 / 918 / 427 | 72 | 20 | 43 | 0 / 0 |
| 2 | state | 2,000 | 1,433 | 958 / 1033 / 698 / 609 / 918 / 427 | 70 | 21 | 42 | 0 / 0 |
| 3 | updates | 2,000 | 1,335 | 1130 / 1171 / 844 / 740 / 1086 / 347 | 91 | 31 | 51 | 0 / 0 |
| 3 | shuffled | 2,000 | 1,337 | 1131 / 1172 / 844 / 741 / 1088 / 347 | 91 | 31 | 52 | 0 / 0 |
| 3 | state | 2,000 | 1,343 | 1131 / 1171 / 836 / 732 / 1080 / 351 | 68 | 13 | 32 | 0 / 0 |

Every run settles both variants and checks the writers and a late joiner from each writer. Zero of the 12,000
settled runs disagreed within either variant. In 263 runs the first difference arrived before the final sync.
Those rows check convergence of the executed prefix because the variants can show different text for the next
selection. The other 11,737 runs reach the normal end. The local add, remove, delete and insert checks found
zero ineffective commands in the unmuted survey.

Greedy reduction of those 464 runs gives 115 traces with only add and insert commands, 105 with only add, remove
and undo, and 244 others. Delivery steps still participate in each replay and the categories count editing
commands. A difference between variants alone gives no count of lost intent.

| Reduced trace | Without the rule | With the rule | What the commands asked for |
| --- | --- | --- | --- |
| A bolds `b..e`, A undoes, B unbolds `a..d` while unaware of both | `abcdef[gh\|i]` | `a[bcd\|b]ef[gh\|i]` | The rule restores bold that A took back and B unformatted. |
| A italicises `d`, B bolds `a..d` unseen, B types plain `D` after `d` | `[abc\|b][d\|b,i][D\|i]ef[gh\|i]` | `[abc\|b][d\|b,i]Def[gh\|i]` | A selected `d`. B requested plain `D`, which the rule preserves in this trace. |
| B deletes `g..h`, A italicises `f..h` unseen, B undoes, A undoes | `a[bcd\|b]ef[gh\|i]` | `a[bcd\|b]efgh` | The rule drops the original italic on the restored letters. |

## Limit detection and the proposed collapse

To measure the extra scan on one format command, the curve uses one 400-character cell. Each action bolds 200
consecutive characters at a seeded start, up to 256 actions. The scan calls `Y.Text.toDelta()` and counts visible
keys of the requested kind in each delta piece until it finds one with at least 32. The reported median is
101 scans after 21 warmups. It includes delta construction and key inspection. It excludes formatting, collapse,
network delivery and rebuilding.

| Actions | Keys per formatted character (median / max) | Delta pieces | Stored bytes | Read (ms) | Limit scan (ms) | Collapsed bytes / read (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 4 | 4/4 | 9 | 690 | 0.0178 | 0.0061 | 644 / 0.0041 |
| 8 | 7/8 | 17 | 872 | 0.0349 | 0.0164 | 738 / 0.0025 |
| 16 | 11/16 | 31 | 1,233 | 0.0377 | 0.0492 | 923 / 0.0017 |
| 32 | 19/32 | 59 | 1,945 | 0.3209 | 0.1874 | 1,283 / 0.0022 |
| 64 | 33/64 | 109 | 3,357 | 1.5781 | 0.5135 | 1,992 / 0.0031 |
| 128 | 65/128 | 189 | 6,097 | 5.6354 | 1.5919 | 3,324 / 0.005 |
| 256 | 129/256 | 280 | 11,273 | 14.5043 | 3.9928 | 5,684 / 0.0077 |

A scan at the 32-key threshold took about 0.19 ms on this cell. The maximum across life checkpoints was 5 for
the baseline and 10 for the heavy workload. On the 300-round patterns collapse decreased the prefix file from
15,455 to 8,910 bytes and punch from 210,118 to 150,383. Rebuilding those patterns from visible content produced
444 and 552 bytes. The proposed **4× rebuilt-size** trigger was chosen without measuring a full-year rebuild.
The rebuilt files here are fresh single-cell snapshots. A live rebuild protocol and preservation of offline
edits or undo across it are outside this evidence.

The proposed collapse is not ready to adopt. It retires keys that still matter to an undo or an unseen copy.
Each case below has a named test. The copies converge in all six examples.

| Case | Observable result |
| --- | --- |
| A collapses after B's bold of `cde`, B presses undo | `cde` stays bold. The press changes nothing. With collapse disabled it goes plain. |
| B has older typed `X` under the previous bold in its history | B's single undo deletes `X` and leaves the bold. |
| Two unseen collapses of the same range | Display agrees and both replacement keys remain. |
| An unseen copy unbolds all of `bcd` | It sees plain text locally. Both copies show bold `bcd` after sync. |
| An unseen copy unbolds just `c` | It sees `c` plain locally. Sync brings its bold back and leaves two keys on `d`. |
| A direct write uses the retired key on another range | The retired key becomes visible on that range again. |

## Checks and implementation inputs

| Control | Histories reaching the call | Used with a visible effect | Failed the check |
| --- | ---: | ---: | ---: |
| Race `Y.Text.format` with a value | 1,182 | 1,167 | 1,167 |
| Race `Y.Text.format` with null | 699 | 699 | 699 |
| Race `Y.Text.insert` | 1,179 | 1,179 | 1,179 |
| Punch `Y.Text.format` with null | 1 | 1 | 1 |
| Race seed 31 `Y.Text.insert` after duplicate restore, across the three deliveries | 3 | 3 | 3 |

The call-level sweep uses seeds 1–400, 20 steps, two writers and all three deliveries. It observes the public
call from each relevant add, remove or insert command on the baseline run. It replays the history and mutes
that call type on both variants at the first reached command with a visible effect, preserving the prior
history. The 15 other reached value-format histories asked for no newly visible formatting. Each used race
control fails at the muted command. Punch fails during its unbold before re-bold can hide the failure. Seed 31
also runs separately with every insert muted, and the assertion confirms the actor already has duplicate
restored letters. The insertion oracle checks the new letter and its marks at the exact gap, plus the full
letter order, even when an existing letter occurs twice. Command-level controls and one-copy mark tampering
also remain covered.

- **Life and patterns.** The pure model starts from the source and records explicit commands. It supplies
  selections, toggles, paste contents, inherited marks and expected undo. The driver reads the implementation's
  cell bounds for its length check, the local and stored deltas for actual text and marks, and the Yjs undo return
  value for the immediate-undo check. Counts, sizes and read times come from the implementation. The collapse and
  rebuild checks compare their readings with the model. The original delta still supplies collapse's list of kinds
  and the rebuild's source runs and embeds, and the probes read the resulting deltas, stored bytes and read times.
- **Race.** Native hydration makes the plain structure. The fixed seed marks are written through `Y.Text.format`
  using the action-key constructor. The unnormalised copy supplies the visible letter order and marks for
  selection and inheritance. For a duplicated target the command takes the first matching occurrence and the
  check uses that occurrence's position. The two variants compare visible deltas at each reached step and after
  settling, including late joiners. The harness reads `turnedOff` for rule activity and estimates concurrent
  activity from its issued-command and delivery logs. Its command-effect oracle covers add, remove, delete and
  insert. Undo and delivery enter the comparison and agreement checks without an independent intent check.
- **Two-copy table.** Commands and the shared fixture establish expected bold. The harness reads displayed deltas,
  correlates the stack item added by a command with the item returned by undo, and counts public update events
  during each press. The stack check can distinguish a successful press that produces the wrong visible outcome
  from a press that reaches an older entry.

E4 also leaves out splits and joins, headings, new atoms during the life, links, the guarded undo path, memory,
browser and server behavior, and long offline lives. The two-copy and collapse probes cover only their stated
timing and edits.

## Checkpoint data

The life observations below are from the original year runs. All 162 checkpoint comparisons matched the
model across the writers and stored copy. Each scheme entry gives stored bytes · that day's bytes/action and
cumulative bytes/action · median/p95/max keys per formatted character and maximum keys of one kind on a
character · median read ms. Character and action counts are shared across schemes within a workload and writer count.

### realistic

| Writers | Day | Visible characters / actions so far | Kind keys | Action keys | Action keys + rule |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 10,678 / 22 | 36,535 · 43.3/43.3 · 1/1/3/1 · 0.0028 | 39,101 · 55.1/55.1 · 1/1/3/2 · 0.0039 | 39,101 · 55.1/55.1 · 1/1/3/2 · 0.0062 |
| 1 | 5 | 11,078 / 110 | 42,683 · 50/44.6 · 1/2/4/1 · 0.0016 | 46,107 · 58.8/55.6 · 1/2/5/2 · 0.0021 | 46,087 · 59.9/55.5 · 1/2/4/2 · 0.003 |
| 1 | 10 | 11,783 / 220 | 51,471 · 50.8/47.8 · 1/2/5/1 · 0.0084 | 55,995 · 63.9/60.2 · 1/2/5/2 · 0.0091 | 55,907 · 62.9/59.7 · 1/2/5/2 · 0.031 |
| 1 | 25 | 12,919 / 550 | 78,882 · 52.3/50.5 · 1/3/5/1 · 0.0026 | 88,636 · 81.5/65.7 · 1/4/7/3 · 0.0033 | 88,272 · 81.5/65 · 1/4/6/3 · 0.0063 |
| 1 | 50 | 14,733 / 1,101 | 123,652 · 61.4/53.8 · 2/4/8/1 · 0.0095 | 141,144 · 85.1/71.8 · 2/4/10/4 · 0.0128 | 140,153 · 86.2/70.7 · 2/4/9/3 · 0.0402 |
| 1 | 100 | 16,976 / 2,203 | 206,158 · 57.9/55.1 · 2/4/7/1 · 0.0132 | 240,404 · 71.4/75.6 · 2/6/11/4 · 0.0205 | 238,223 · 72.7/73.8 · 2/5/8/4 · 0.0423 |
| 1 | 150 | 19,314 / 3,303 | 281,893 · 40.3/55.9 · 2/5/7/1 · 0.0102 | 332,873 · 61.7/78 · 2/7/12/5 · 0.0138 | 328,940 · 55.3/75.6 · 2/6/9/3 · 0.0131 |
| 1 | 200 | 21,444 / 4,407 | 362,290 · 66.9/56.4 · 2/6/8/1 · 0.0173 | 431,512 · 90.8/79.8 · 3/7/14/5 · 0.021 | 426,371 · 88.6/77.2 · 3/6/9/3 · 0.0377 |
| 1 | 250 | 22,696 / 5,507 | 437,985 · 67.8/57.2 · 3/6/9/1 · 0.028 | 521,823 · 77.8/80.8 · 3/7/17/5 · 0.0452 | 515,483 · 77.1/78 · 3/6/11/4 · 0.0475 |
| 2 | 1 | 10,613 / 22 | 36,560 · 40.7/40.7 · 1/1/2/1 · 0.001 | 39,031 · 48/48 · 1/1/2/1 · 0.0016 | 39,031 · 48/48 · 1/1/2/1 · under 0.001 |
| 2 | 5 | 11,163 / 110 | 42,990 · 46.3/42.7 · 1/2/3/1 · 0.0017 | 46,408 · 59/53.5 · 1/2/3/2 · 0.0026 | 46,387 · 58/53.3 · 1/2/3/2 · 0.0027 |
| 2 | 10 | 11,721 / 220 | 51,331 · 50.1/45.7 · 1/2/4/1 · 0.0036 | 55,980 · 60.7/58.3 · 1/3/4/2 · 0.005 | 55,980 · 60.7/57.8 · 1/3/4/2 · 0.0072 |
| 2 | 25 | 13,076 / 550 | 74,902 · 43.8/47.9 · 1/4/8/1 · 0.0047 | 82,531 · 57.9/61 · 1/4/9/2 · 0.0013 | 82,396 · 56.3/60.3 · 1/4/8/2 · 0.0137 |
| 2 | 50 | 14,865 / 1,100 | 118,478 · 52.6/50.9 · 1/4/6/1 · 0.0068 | 132,978 · 66.4/66 · 2/4/7/3 · 0.0107 | 132,271 · 65.3/65.1 · 1/4/7/2 · 0.0175 |
| 2 | 100 | 17,785 / 2,203 | 201,095 · 56.5/55 · 2/5/9/1 · 0.01 | 231,960 · 88.3/73.9 · 2/5/9/4 · 0.0135 | 230,078 · 84/72.4 · 2/5/9/4 · 0.0198 |
| 2 | 150 | 19,781 / 3,304 | 280,284 · 50.9/56.3 · 2/5/9/1 · 0.0128 | 328,319 · 72.5/77 · 3/7/10/4 · 0.0213 | 325,321 · 69.8/75.1 · 2/6/10/4 · 0.0136 |
| 2 | 200 | 21,092 / 4,409 | 355,979 · 54.4/57 · 2/5/8/1 · 0.0375 | 423,199 · 73.5/79.4 · 3/7/11/4 · 0.0618 | 417,750 · 61.9/77.1 · 3/6/11/4 · 0.1076 |
| 2 | 250 | 22,476 / 5,516 | 429,525 · 49.5/57.5 · 3/6/10/1 · 0.0317 | 514,336 · 66.8/81.1 · 3/8/12/4 · 0.04 | 507,266 · 65.5/78.4 · 3/7/12/3 · 0.0244 |
| 6 | 1 | 10,519 / 22 | 36,296 · 42.3/42.3 · 1/1/2/1 · under 0.001 | 38,825 · 52.3/52.3 · 1/1/2/1 · 0.0014 | 38,825 · 52.3/52.3 · 1/1/2/1 · 0.0032 |
| 6 | 5 | 11,124 / 110 | 43,005 · 48.7/43.8 · 1/2/4/1 · 0.0019 | 46,216 · 58.7/53.2 · 1/2/4/2 · 0.0014 | 46,195 · 58.7/53 · 1/2/4/1 · 0.0038 |
| 6 | 10 | 11,726 / 220 | 51,011 · 46.6/46.2 · 1/2/4/1 · 0.0021 | 55,130 · 57.7/56.8 · 1/2/4/2 · 0.0021 | 55,063 · 57.7/56.4 · 1/2/4/2 · 0.0075 |
| 6 | 25 | 12,845 / 550 | 73,042 · 46.9/44.8 · 1/3/5/1 · 0.0035 | 80,468 · 58.2/57.6 · 1/3/6/3 · 0.0039 | 80,190 · 58.2/56.8 · 1/3/6/3 · 0.0089 |
| 6 | 50 | 14,786 / 1,100 | 110,486 · 46.7/47.3 · 1/4/7/1 · 0.0083 | 125,397 · 85.1/62.8 · 2/5/9/4 · 0.0137 | 124,517 · 80.9/61.7 · 2/5/8/3 · 0.0127 |
| 6 | 100 | 17,047 / 2,205 | 183,654 · 47/50 · 2/4/7/1 · 0.0115 | 212,638 · 66.1/67.9 · 2/5/10/4 · 0.0182 | 210,777 · 66.1/66.2 · 2/5/10/3 · 0.0183 |
| 6 | 150 | 18,934 / 3,306 | 263,979 · 57.9/52.7 · 2/5/8/1 · 0.018 | 307,961 · 76.7/71.6 · 3/6/9/4 · 0.0288 | 304,791 · 72/69.7 · 2/6/8/3 · 0.043 |
| 6 | 200 | 20,793 / 4,410 | 338,617 · 59.2/53.6 · 2/5/8/1 · 0.0373 | 399,093 · 83.9/73.8 · 3/7/12/4 · 0.0207 | 393,238 · 73.3/71.3 · 3/6/10/3 · 0.0371 |
| 6 | 250 | 22,802 / 5,515 | 415,341 · 54.7/55.5 · 3/5/8/1 · 0.0306 | 495,136 · 86.5/77.1 · 3/7/12/5 · 0.0363 | 486,655 · 86.3/74 · 3/6/9/3 · 0.0317 |

### heavy

| Writers | Day | Visible characters / actions so far | Kind keys | Action keys | Action keys + rule |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 10,614 / 220 | 45,448 · 44.8/44.8 · 1/3/5/1 · 0.0101 | 51,389 · 61.4/61.4 · 1/4/7/5 · 0.015 | 50,606 · 57.8/57.8 · 1/4/5/4 · 0.0136 |
| 1 | 5 | 10,961 / 1,103 | 88,411 · 57.6/48.5 · 2/5/9/1 · 0.0186 | 109,489 · 72.9/66.6 · 2/6/12/5 · 0.0201 | 106,241 · 71.6/63 · 2/5/10/4 · 0.0159 |
| 1 | 10 | 11,411 / 2,209 | 141,661 · 67.9/50.2 · 2/7/11/1 · 0.0058 | 187,646 · 90.7/71.3 · 2/9/20/6 · 0.0085 | 179,931 · 85.6/66.7 · 2/7/14/4 · 0.0085 |
| 1 | 25 | 11,746 / 5,543 | 288,639 · 54/52.6 · 3/7/12/1 · 0.0441 | 407,659 · 87.1/76.1 · 3/11/17/7 · 0.0353 | 388,603 · 77.6/70.8 · 3/8/14/4 · 0.047 |
| 1 | 50 | 12,479 / 11,153 | 547,026 · 43.5/56.1 · 4/8/13/1 · 0.0775 | 789,496 · 89.9/81.7 · 5/12/19/8 · 0.508 | 747,782 · 71.6/74.9 · 4/9/16/4 · 0.256 |
| 1 | 100 | 12,771 / 22,326 | 980,773 · 53.4/58 · 5/8/11/1 · 0.1858 | 1,455,349 · 89/84.3 · 6/12/22/8 · 0.3526 | 1,389,775 · 81.1/76.8 · 5/9/15/5 · 0.1754 |
| 1 | 150 | 13,000 / 33,484 | 1,391,859 · 72/58.6 · 5/8/12/1 · 0.0987 | 2,102,069 · 97.1/85.7 · 7/13/22/9 · 0.528 | 2,013,679 · 89.8/77.8 · 5/10/16/4 · 0.2018 |
| 1 | 200 | 13,118 / 44,657 | 1,808,942 · 42.4/58.1 · 5/9/13/1 · 0.0564 | 2,760,029 · 69.9/85.8 · 7/14/25/8 · 0.7481 | 2,641,799 · 59.7/77.4 · 6/11/17/5 · 0.0831 |
| 1 | 250 | 13,677 / 55,851 | 2,234,969 · 55.9/58.1 · 5/8/15/1 · 0.0409 | 3,398,236 · 90.8/85.8 · 7/14/25/9 · 0.5874 | 3,263,488 · 76.2/77.4 · 6/10/16/5 · 0.0613 |
| 2 | 1 | 10,561 / 220 | 44,819 · 41.6/41.6 · 1/3/6/1 · 0.0099 | 50,785 · 58.2/58.2 · 1/4/8/4 · 0.0154 | 50,080 · 55/55 · 1/3/6/2 · 0.0078 |
| 2 | 5 | 10,890 / 1,102 | 83,788 · 45.3/44.8 · 1/5/9/1 · 0.0102 | 103,405 · 65.6/62.2 · 2/6/11/5 · 0.0227 | 100,373 · 63/58.8 · 2/5/9/3 · 0.0217 |
| 2 | 10 | 11,190 / 2,211 | 139,598 · 56.9/48.8 · 2/6/10/1 · 0.0113 | 181,239 · 82.3/68.2 · 2/7/17/5 · 0.0579 | 173,226 · 77.5/63.8 · 2/6/12/4 · 0.053 |
| 2 | 25 | 11,805 / 5,538 | 286,338 · 60.4/52 · 3/7/10/1 · 0.021 | 398,008 · 83.4/74.3 · 4/9/18/8 · 0.1273 | 376,242 · 77.1/68.3 · 3/8/14/4 · 0.0633 |
| 2 | 50 | 12,636 / 11,087 | 508,791 · 45.8/55.3 · 4/7/12/1 · 0.1479 | 736,977 · 70.9/79.8 · 5/12/21/8 · 0.2946 | 698,628 · 66.5/72.9 · 4/9/16/5 · 0.1237 |
| 2 | 100 | 13,328 / 22,217 | 940,254 · 67.7/57 · 4/7/11/1 · 0.0742 | 1,414,215 · 101.8/83.8 · 6/12/25/7 · 0.1187 | 1,338,170 · 88.6/75.7 · 5/9/15/4 · 0.3794 |
| 2 | 150 | 14,140 / 33,413 | 1,362,532 · 63.2/57.8 · 5/8/13/1 · 0.1168 | 2,073,156 · 98.3/85 · 7/15/26/9 · 0.43 | 1,961,576 · 84.2/76.3 · 6/10/16/5 · 0.2824 |
| 2 | 200 | 14,501 / 44,623 | 1,776,636 · 54.7/58.4 · 5/8/11/1 · 0.2252 | 2,717,615 · 87.3/86.4 · 7/15/26/10 · 0.3244 | 2,576,953 · 77.4/77.1 · 6/10/15/5 · 0.571 |
| 2 | 250 | 14,536 / 55,790 | 2,182,087 · 46/58.6 · 5/8/11/1 · 0.0962 | 3,340,783 · 71.9/86.4 · 7/14/23/9 · 0.442 | 3,180,549 · 72/77.3 · 6/10/15/4 · 0.3478 |
| 6 | 1 | 10,506 / 220 | 45,379 · 45.5/45.5 · 1/2/6/1 · 0.0049 | 50,279 · 57.3/57.3 · 1/3/6/3 · 0.0068 | 50,048 · 56.2/56.2 · 1/2/6/2 · 0.0056 |
| 6 | 5 | 10,831 / 1,090 | 83,482 · 46.4/44.2 · 1/4/9/1 · 0.0047 | 101,069 · 65/59.7 · 2/6/9/4 · 0.0141 | 99,018 · 61.9/57.3 · 2/5/9/3 · 0.013 |
| 6 | 10 | 10,997 / 2,194 | 127,976 · 40.2/44.9 · 2/5/10/1 · 0.0181 | 167,485 · 61.8/63.9 · 2/7/17/5 · 0.0415 | 159,882 · 57.8/59.8 · 2/6/11/3 · 0.0322 |
| 6 | 25 | 12,077 / 5,516 | 261,481 · 47.6/48.9 · 3/6/11/1 · 0.0258 | 364,450 · 75.1/70.4 · 4/9/17/6 · 0.0652 | 342,270 · 63.2/64.4 · 3/7/12/4 · 0.1101 |
| 6 | 50 | 12,560 / 11,095 | 457,316 · 44.9/49.8 · 4/7/12/1 · 0.1046 | 665,072 · 68.3/73.3 · 5/11/22/8 · 0.3445 | 627,783 · 61/66.5 · 4/9/16/4 · 0.263 |
| 6 | 100 | 13,838 / 22,284 | 881,105 · 64.4/54.5 · 4/8/11/1 · 0.0976 | 1,313,697 · 93.4/79.6 · 6/13/21/8 · 0.2485 | 1,246,343 · 81/71.8 · 5/10/15/4 · 0.2837 |
| 6 | 150 | 14,375 / 33,467 | 1,284,673 · 36.1/56 · 5/8/11/1 · 0.1823 | 1,966,405 · 77.4/82.6 · 7/15/25/9 · 0.7538 | 1,861,753 · 56.5/73.9 · 5/10/17/5 · 0.5274 |
| 6 | 200 | 14,924 / 44,668 | 1,710,310 · 61.6/57.8 · 5/9/12/1 · 0.2105 | 2,609,646 · 82/84.9 · 7/14/28/9 · 0.5112 | 2,485,290 · 76/75.8 · 5/10/15/4 · 0.2786 |
| 6 | 250 | 14,639 / 55,853 | 2,103,973 · 43.6/58.3 · 5/8/13/1 · 0.1566 | 3,236,672 · 80.9/86 · 7/14/22/10 · 0.7675 | 3,084,617 · 66.4/76.6 · 6/10/19/5 · 0.4437 |


## Pattern data

A round is one iteration of the named pattern. Punch unbolds a single letter and re-bolds the whole span in
each round. Prefix adds one letter and bolds a prefix that grows by one per round. Other patterns are fixed-range
toggle, random overlapping toggles, two writers alternating on shifted ranges after syncing, a sliding range,
plain typing into bold before re-bolding, and a formatted paste. Pattern and curve timings are from the follow-up
runs. Each scheme entry gives stored bytes · bytes added per round · median/p95/max keys per formatted
character · median read ms. All 48 runs matched the model, including every immediate punch check.

| Pattern | Rounds | Kind keys | Action keys | Action keys + rule | Action keys after all marks removed / collapse / rebuild |
| --- | ---: | --- | --- | --- | --- |
| prefix | 100 | 1,337 · 12.3 · 1/1/1 · 0.0024 | 5,054 · 49.5 · 50/95/100 · 2.4475 | 2,897 · 27.9 · 1/1/1 · 0.0046 | 2,875 / 2,909 / 243 |
| prefix | 300 | 4,138 · 13.4 · 1/1/1 · 0.0066 | 15,455 · 51.2 · 150/285/300 · 18.2075 | 8,898 · 29.3 · 1/1/1 · 0.0105 | 8,876 / 8,910 / 444 |
| toggle | 100 | 1,233 · 7.2 · 0/0/0 · 0.0008 | 1,233 · 7.2 · 0/0/0 · 0.0008 | 1,233 · 7.2 · 0/0/0 · 0.0008 | 1,233 / 1,233 / 510 |
| toggle | 300 | 2,805 · 7.6 · 0/0/0 · 0.0018 | 2,805 · 7.6 · 0/0/0 · 0.0018 | 2,805 · 7.6 · 0/0/0 · 0.0018 | 2,805 / 2,805 / 510 |
| overlapping | 100 | 2,305 · 17.9 · 1/1/1 · 0.0037 | 5,108 · 45.9 · 2/5/8 · 0.0275 | 3,983 · 34.7 · 2/2/3 · 0.0094 | 3,777 / 3,963 / 720 |
| overlapping | 300 | 5,169 · 15.5 · 1/1/1 · 0.0074 | 12,223 · 39 · 2/5/12 · 0.0376 | 9,578 · 30.2 · 1/2/2 · 0.0151 | 10,527 / 10,710 / 727 |
| alternate | 100 | 1,503 · 9.9 · 1/1/1 · 0.0014 | 2,659 · 21.5 · 1/3/3 · 0.0046 | 2,458 · 19.4 · 1/1/1 · 0.0025 | 2,486 / 2,562 / 600 |
| alternate | 300 | 3,077 · 8.5 · 1/1/1 · 0.0035 | 6,806 · 21 · 2/2/3 · 0.0108 | 6,425 · 19.7 · 2/2/2 · 0.0095 | 6,579 / 6,655 / 588 |
| sliding | 100 | 1,557 · 13.2 · 1/1/1 · 0.0019 | 4,529 · 43 · 20/20/20 · 0.6266 | 4,529 · 43 · 20/20/20 · 0.6242 | 2,370 / 2,408 / 267 |
| sliding | 300 | 4,943 · 15 · 1/1/1 · 0.005 | 14,088 · 45.5 · 20/20/20 · 2.1108 | 14,088 · 45.5 · 20/20/20 · 2.0973 | 7,529 / 7,568 / 468 |
| type-inside | 100 | 3,071 · 25.6 · 1/1/1 · 0.0027 | 13,496 · 129.8 · 75/101/101 · 2.02 | 5,563 · 50.5 · 1/1/1 · 0.0054 | 6,427 / 6,465 / 653 |
| type-inside | 300 | 8,672 · 27.2 · 1/1/1 · 0.008 | 42,718 · 140.7 · 175/301/301 · 20.1311 | 15,966 · 51.5 · 1/1/1 · 0.0161 | 20,015 / 20,054 / 853 |
| punch | 100 | 2,262 · 17.5 · 1/1/1 · 0.0021 | 78,797 · 782.8 · 36/101/101 · 1.6034 | 4,686 · 41.7 · 1/1/1 · 0.0057 | 39,061 / 39,099 / 552 |
| punch | 300 | 5,433 · 16.4 · 1/1/1 · 0.0056 | 210,118 · 698.7 · 37/165/301 · 1.9448 | 12,690 · 40.6 · 1/1/1 · 0.0141 | 150,344 / 150,383 / 552 |
| paste | 100 | 30,291 · 297.2 · 1/2/2 · 0.1836 | 42,695 · 420.8 · 1/2/2 · 0.7871 | 42,695 · 420.8 · 1/2/2 · 0.2519 | 23,206 / 47,388 / 38,228 |
| paste | 300 | 99,551 · 329.9 · 1/2/2 · 0.6011 | 147,883 · 490.9 · 1/2/2 · 1.5807 | 147,883 · 490.9 · 1/2/2 · 1.1055 | 78,796 / 164,334 / 132,138 |

## Regenerate

Install the pinned Node version, then run `npm ci` and `npm ci --prefix prototypes/collab` from the repository
root. Run the following from `prototypes/collab`. The JSON outputs are scratch inputs to `report.ts`. The tests
use no recorded JSON fixtures.

```sh
node src/format-keys/life.ts --part=life --days=250 --rates=realistic --writers=1 --schemes=name --seed=7 --write=life-name.json
node src/format-keys/life.ts --part=life --days=250 --rates=realistic --writers=1 --schemes=act --seed=7 --overlap=0.4 --write=sensitivity.json
node src/format-keys/life.ts --part=patterns --actions=100,300 --write=patterns.json
node src/format-keys/life.ts --part=curve --curve=4,8,16,32,64,128,256 --write=curve.json
node src/format-keys/race.ts --seeds=2000 --length=20 --write=race.json
node src/format-keys/report.ts life-name.json patterns.json curve.json race.json
E4_TABLE=1 node --test test/format-keys/schemes.test.ts
node --test test/format-keys/controls.test.ts test/format-keys/collapse.test.ts test/format-keys/e4.test.ts
```

For complete life tables run the first line separately for each workload (`realistic`, `heavy`), writer count
(1, 2, 6) and scheme (`name`, `act`, `act+norm`), with distinct scratch filenames. Pass those files to
`report.ts`. The pattern seed is 3 and the curve seed is 11. The race and call controls start at seed 1.
