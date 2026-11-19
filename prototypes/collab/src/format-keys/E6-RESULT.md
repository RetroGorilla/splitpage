# E6 — Production tag marks

| Result | Plain tag key | Per-application tag key |
| --- | --- | --- |
| Missing tag letters at the first merge, across 42 trials | 28. Of these, 16 were applied and never removed, 4 came from tags ending one letter short, and 8 came from a conflict won by an identical unseen removal. | 0. |
| Missing tag letters after A's undo | 22. B's overlapping or nested tag disappears in both orders. An identical tag disappears in one order. | 0. B's tag stays. |
| Extra tag letters after A's undo | 40. Includes tags that stretch past their original end. | 24 with standard writes, 8 when the prototype gives the tail a new key. |
| Removed tag returns after undo | In both orders, undoing a seen full removal restores all four letters after the author's own undo skipped the tag. | Same. |
| Undo takes older typing | 6 of 84 presses. Older typing returns on redo. | 2 of 84 presses, both after a seen full removal. Older typing returns on redo. |
| Crossing tag display | Both tags are stored. The reader silently hides the later-starting tag's three letters until the first tag is undone. | Same. |
| 250 days, live keys per tagged letter | Median 1, p95 1, max 1. | Median 1, p95 2, max 4. |
| 250 days, tag history bytes per application, including removals | 50.2–50.3. | 70.9–72.2, or 41–44% more tag history. The one-writer difference of 43,845 bytes is roughly 9–10% of a whole script on the E4 basis below. |
| Overlapping bold and tag in one cell | Same result as running the two edits separately. | Same with plain bold and a per-application tag key. |
| Copies disagree or typed text remains missing at the end | 0. | 0. |

## Two-copy table

A tags `cdef` in `abcdefgh`. B's separated, touching, overlapping, nested and identical ranges are `a`, `ab`, `efg`, `de` and `cdef`. In each unseen removal row a third copy seeds only B's range before both edits. In the delete row it seeds `cd`. Both writers start with their own older typing step, A's `Q` and B's `R`. Each row runs with A as the lower client ID and again as the higher one. The two beat cells are separate Y.Texts. The observer reads every text change's delta through `observeDeep`, as in E4. The relay carries all updates, including formatting cleanup. Both writers pull before each checkpoint. Two late joiners load the writers' separate saved states at each checkpoint.

For the **per-action reading**, each active add covers the letters it targeted. A removal clears the additions the remover had seen. Undo retracts only the author's command. Redo reinstates it. Someone who types a plain letter inside an unseen tag picks up the tag. An unseen insertion at either edge stays plain in the model. A seen plain insertion stays plain everywhere. An explicit delete hides its selected letters until that delete is undone. For the **last-visible-change reading**, an undo is also a fresh instruction to clear the added range or restore the removed range. A redo reapplies the original instruction. This makes an undo of an identical simultaneous add clear the visible tag, as in the visible outcome of inventory rule U02. It can also count B's surviving tag in a partial overlap as extra. Both readings assume the intended step is taken.

Each table cell lists five fields.

1. **Missing:extra** tag-letter pairs under the per-action reading, summed over the two client orders. Checkpoints in order are merge, A undo, B undo, A redo, B redo. `0` means both counts are zero throughout. Each tag id counts once per letter even if it has several keys. Counts use stored marks before enforcing strict nesting.
2. The same counts under the last-visible-change reading. `=` means the counts are the same.
3. Steps taken by A undo, B undo, A redo and B redo. Within each pair the low-A result comes first. `r` means the intended step and `o` an older step or its redo. A single `r` means all four presses took the intended step in both orders.
4. Local update events for A's command, B's command, A undo, B undo, A redo and B redo. Pairs use the same order. A single `1` means one update per command and press throughout. Events count cleanup during the press and exclude subsequent delivery.
5. Unexpected text differences by checkpoint. A bare letter is missing. A `+` marks leftover text that should be absent. `–` means neither. Two sequences give the low-A and high-A results. Correctly undone typing and correctly deleted text are excluded.

The per-application column uses the inherited E4 writer, including its tail re-keying. A standard-write comparison for the two rows that split a seen tag follows below.

| B's command | Plain tag key | Per-application tag key |
| --- | --- | --- |
| B adds T · Separated | 0 · = · r · 1 · – | 0 · = · r · 1 · – |
| B removes T · Separated | 0 · = · r · 1 · – | 0 · = · r · 1 · – |
| B adds T · Touching | 4:0/0:0/0:0/4:0/4:0 · = · r · 1 · – | 0 · = · r · 1 · – |
| B removes T · Touching | 8:0/0:0/0:0/8:0/8:0 · = · r · 1 · – | 0 · = · r · 1 · – |
| B adds T · Overlapping | 2:0/6:0/0:0/0:0/2:0 · 2:0/2:0/0:0/0:0/2:0 · r · 1 · – | 0 · 0:0/0:4/0:0/0:0/0:0 · r · 1 · – |
| B removes T · Overlapping | 0:8/0:12/0:0/0:0/0:8 · 0:8/0:12/0:0/0:0/0:12 · r · 1,1/1,1/1,1/2,2/1,1/1,1 · – | 0 · 0:0/0:0/0:0/0:0/0:4 · r · 1 · – |
| B adds T · Nested | 2:0/4:0/0:0/0:0/2:0 · 2:0/0:0/0:0/0:0/2:0 · r · 1 · – | 0 · 0:0/0:4/0:0/0:0/0:0 · r · 1 · – |
| B removes T · Nested | 0:0/0:4/0:0/2:0/0:0 · 0:0/0:4/0:0/2:0/0:4 · r · 1,1/1,1/1,1/2,2/1,1/1,1 · – | 0 · 0:0/0:0/0:0/0:0/0:4 · r · 1 · – |
| B adds T · Identical | 0:0/4:0/0:0/4:0/0:0 · 0:0/0:4/0:0/4:0/0:0 · r · 1 · – | 0 · 0:0/0:8/0:0/0:0/0:0 · r · 1 · – |
| B removes T · Identical | 8:0/0:0/0:0/0:0/8:0 · 8:0/0:0/0:0/0:0/0:0 · o,o/r,r/o,o/r,r · 0,0/1,1/1,1/1,1/1,1/1,1 · –/Q/Q/–/–;–/Q/Q/–/– | 0 · 0:0/0:0/0:0/0:0/0:8 · r · 1 · – |
| B adds crossing U | 0 · = · r · 1 · – | 0 · = · r · 1 · – |
| B types inside | 0 · = · r · 1 · – | 0 · = · r · 1 · – |
| B types at left edge | 0:1/0:0/0:0/0:0/0:1 · = · r · 1 · – | 0:1/0:0/0:0/0:0/0:1 · = · r · 1 · – |
| B types at right edge | 0:1/0:0/0:0/0:0/0:1 · = · r · 1 · – | 0:1/0:0/0:0/0:0/0:1 · = · r · 1 · – |
| B bolds overlapping | 0 · = · r · 1 · – | 0 · = · r · 1 · – |
| B adds same word in beat two | 0 · = · r · 1 · – | 0 · = · r · 1 · – |
| B deletes cd while A extends cd to cdef | 4:0/0:0/0:0/4:0/4:0 · 4:0/0:0/0:4/4:0/4:0 · r · 1 · – | 0 · 0:0/0:0/0:4/0:0/0:0 · r · 1 · – |
| B sees T, then types plain X inside | 0:0/0:14/0:0/0:0/0:0 · = · r · 1 · – | 0:0/0:6/0:0/0:0/0:0 · = · r · 1 · – |
| B sees T, then removes it all | 0:0/0:0/0:8/0:0/0:0 · 0:0/0:0/0:0/0:0/0:0 · o,o/r,r/o,o/r,r · 1 · –/Q/Q/–/–;–/Q/Q/–/– | 0:0/0:0/0:8/0:0/0:0 · 0:0/0:0/0:0/0:0/0:0 · o,o/r,r/o,o/r,r · 1 · –/Q/Q/–/–;–/Q/Q/–/– |
| B sees T, then removes its middle | 0:0/0:10/0:0/0:0/0:0 · 0:0/0:10/4:0/0:0/0:0 · r · 1 · – | 0:0/0:2/0:0/0:0/0:0 · 0:0/0:2/4:0/0:0/0:0 · r · 1 · – |
| B sees T, then applies T again | 0:0/8:0/0:0/0:0/0:0 · 0:0/0:0/0:0/0:0/0:0 · r,r/o,o/r,r/o,o · 1,1/0,0/1,1/1,1/1,1/1,1 · –/–/R/R/–;–/–/R/R/– | 0 · 0:0/0:8/0:0/0:0/0:0 · r · 1 · – |

All 210 checkpoints per scheme agreed across the two writers and both late readers. The table sums repeated checkpoints, so one absent letter can count again after a later press. Plain keys recorded 100 missing and 68 extra pairs across the five checkpoints. Per-application keys recorded 0 missing and 20 extra. Under the last-visible-change reading those totals were 76 missing and 76 extra for plain keys, and 4 missing and 56 extra for per-application keys. Four plain-key B undo presses emitted two updates. Each per-application press emitted one.

The plain-key first-merge total of 28 breaks down as follows.

| First-merge outcome | Letters |
| --- | ---: |
| A's applied tag lost letters nobody removed | 16. Touching add 4, touching unseen removal 8, delete against extension 4. |
| A tag ended one letter short in each order | 4. B's `g` in the overlap and A's `f` in the nested case. |
| B's unseen removal won the conflict when A re-tagged the already tagged range | 8. Identical unseen removal, four letters per order. |

**What a person sees with a plain key**

- Two adds. A with the lower ID loses all of `cdef` when B adds touching `ab`. In both orders, overlapping adds omit B's `g` and nested adds omit A's `f`. A's undo then clears all of B's surviving overlap or nested tag. For identical adds, A's undo clears B's tag only when A has the lower ID. When A has the higher ID, A's redo still leaves the word plain after B's undo.
- Add against unseen removal. Removing touching or identical seed tags clears A's unseen `cdef` in both orders. Removing overlapping `efg` makes `cdefghQR` show T. It includes `g`, which B cleared, and `hQR`, which nobody tagged. After A's undo, `efghQR` still shows T. When B removes nested `de`, A's undo makes `de` reappear before B undoes the removal. A's redo after the nested removal leaves `f` plain.
- Deletion against extension. Deleting the seed `cd` leaves the surviving `ef` plain in both orders even though A applied T to it. A's redo after B restores `cd` still leaves `ef` plain. Redoing the deletion makes `ef` plain again.
- Seen changes. Plain typing inside `cdef` splits T locally. A's undo leaves T from `d` through the end. A seen removal of `de` leaves T from `f` through the end after A's undo. A seen reapplication creates no plain-key step. A's undo makes the word plain and B's undo takes B's older `R`.

**What changes with a key per application**

- The unseen add/add, add/remove and delete/extend rows preserve all expected marks. Undoing A's identical add leaves B's contribution visible in both orders. Under the reading that one undo clears the identical gesture, those are four extra tagged letters per order.
- After B sees T and clears the whole range, A's undo takes the older `Q` in both schemes and both orders. B's subsequent undo restores `cdef` even though A already pressed undo. The per-action reading counts these four returned letters per order as extra. The last-visible-change reading expects them. B's redo clears the tag again in both schemes. In the plain-key unseen identical-removal row, A's add starts as a no-op and A's undo also takes `Q`. A's redo only restores `Q`.
- An unseen `X` typed inside T picks it up in both orders and both schemes. At the left edge it picks up T only when A has the lower ID. At the right edge it picks up T only when A has the higher ID. Neither scheme drops `X`. Both beat cells keep their own tag through the other beat's undo. The tag id can therefore be reused across the beats without sharing an undo target.

**Crossing U.** When two people apply crossing tags at the same moment, both are stored. T covers `cdef` and U covers `efg`. The nesting reader shows T and hides all three letters of U's mark. The words stay visible, and `g` looks plain. Nothing tells the person that U was hidden. The probe records its rejected extent only in memory. U shows again on `efg` when A undoes T. Both key forms and all four readers behave the same way.

### Standard writes and re-keying a split tail

The comparison repeats the same two seen rows in both client-ID orders. With standard writes, B inserts with explicit `{}` or clears the middle with `format(..., { [key]: null })`. The E4 writer adds a step in [`retire`](../native/variant.ts#L246). It clears the old key through the end of the tag and gives the retained tail a fresh key. For typing, it inserts with the left-hand keys first, then retires the marks the new letter should drop. A's undo cannot remove a tail with B's new key. This is an addition on top of standard Yjs writes. [AGENTS.md rule 12](../../../../AGENTS.md#hard-rules) requires its own reproduced defect, cost measurement and owner decision.

| After A's undo | Plain key | Per-application key, standard writes | Per-application key, tail re-keyed |
| --- | --- | --- | --- |
| B types plain `X` after `c` | `defghQR` (14 extra across both orders) | `defghQR` (14) | `def` (6) |
| B removes middle `de` | `fghQR` (10) | `fghQR` (10) | `f` (2) |
| Extra tag letters across all rows after A's undo | 40 | 24, substituting the two standard-write runs | 8 |

In today's app, normal typing cannot put the caret inside a finished tag. The HTML marks it `contenteditable="false"` and caret placement moves outside it. **Edit tag** explicitly opens the selected occurrence and **Done** closes it again. This is a different path from ordinary typing. There is also a model-backed pending-format insertion path that strips tag marks, so the protection of a closed tag cannot establish the result of every edit on a reopened tag. This was a source check. [Tag HTML](../../../../src/core/text/html.ts#L57), [caret placement](../../../../src/features/common/cell-dom.ts#L189), [occurrence editor](../../../../src/features/tags/occurrence-editor.ts#L40), [pending-format typing](../../../../src/features/rows/render.ts#L1019), [typing marks](../../../../src/core/text/edits.ts#L76).

The app's `removeTag` rewrites every matching mention in both script columns. It does not clear only the middle of an occurrence. The text model also refuses to clear part of an outer tag. The seen middle-removal row therefore probes the library's range write outside the app's tag-removal command. [Remove tag](../../../../src/application/commands/production-actions.ts#L43), [rewrites](../../../../src/application/commands/tag-rewrites.ts#L31), [range guard](../../../../src/core/text/edits.ts#L162).

### Writing contract for plain inserts

A one-writer raw Yjs 13.6.33 probe seeds `abcdefgh` with `insert(0, "abcdefgh", {})`, tags `cd` with `format(2, 2, { [key]: true })`, inserts `R` at each offset from 4 through 8, then calls `delete(2, 2)`. Each call uses its own transaction, with no observer. The test compares the live text and a copy loaded from the encoded state under both key forms.

With no attributes argument, `R` at offset 4 inherits T and keeps it after the deletion and reload. The result is `ab[R|T]efgh`. An explicit `{}` keeps that `R` plain. At offsets 5–8 the entire suffix stays plain with either insert. In particular, offset 8 gives `abefghR`. The reported spread to `ab[efghR|T]` did not reproduce. The E6 writer always passes an explicit attributes object. [Insert paths](../native/variant.ts#L117).

## 250-day tag life

| Input | Tape used for every key form and writer count |
| --- | --- |
| Text and slots | 192 beats, each with one 192-character cell. Eight spaced slots per cell. 36,864 starting characters. |
| Tag registry | Six fixed ids, one per category. One id per slot, drawn uniformly. |
| Length | 4, 8, 12 or 20 characters, drawn uniformly per slot. |
| Each day | Six first applications in fresh slots, one application to a live slot, one removal followed by a reapplication, and one removal left off. |
| Repeat rate | 1 of 8 applications (12.5%) repeats a live tag. Another 1 of 8 follows a removal. Revised slots are drawn uniformly from the current live list. |
| Writers and delivery | 1, 2 or 6. Commands rotate through writers. Each pulls the relay's current state before writing. |
| Totals and seed | 2,000 application commands and 500 removals over 250 days. Seed 604. No typing, undo or crossing in this tape. |

All runs ended with 13,856 tagged characters. Counts include only live keys on tagged characters. Tag-history bytes are the relay's final encoded state minus the same untagged seed, including its starting text. Bytes per application divide this net size by 2,000 and include the stored cost of removals. Bytes per text character divide it by 36,864.

The increase of **41–44%** measures only this tag history. For one writer, 144,364 − 100,519 = **43,845 extra bytes** after 2,000 applications and 500 removals. E4's one-writer, 250-day plain-key script is **437,985 bytes**. E4 scheduled 20 format commands per day with tags at 40% of the mix, or about 2,000 tag commands. The E6 difference is **10.0%** of that E4 baseline or **9.1%** of the illustrative 481,830-byte total after adding it. That is roughly **9–10% of a whole script** on this cross-workload estimate. E6 does not measure that exact script. [E4 workload and stored size](RESULT.md#synthetic-workload).

The busiest cell is the one with the most live key-character pairs. Read time is the median of 51 reads through `toDelta()`, tag decoding and the nesting reader. Type time is the median of 21 local `X` insertions into a plain gap of that cell, each in a fresh loaded copy with the observer and undo manager attached. It excludes transfer and rendering. Each 250-day run took under one second in the recorded sample.

| Writers | Tag keys | Live median / p95 / max | Net bytes | Bytes / application | Bytes / text character | Busiest cell / live pairs | Read ms | Type ms |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | Plain | 1 / 1 / 1 | 100,519 | 50.26 | 2.73 | beat-89 / 128 | 0.045 | 0.064 |
| 1 | Per application | 1 / 2 / 4 | 144,364 | 72.18 | 3.92 | beat-4 / 148 | 0.046 | 0.066 |
| 2 | Plain | 1 / 1 / 1 | 100,488 | 50.24 | 2.73 | beat-89 / 128 | 0.042 | 0.043 |
| 2 | Per application | 1 / 2 / 4 | 143,264 | 71.63 | 3.89 | beat-4 / 148 | 0.065 | 0.074 |
| 6 | Plain | 1 / 1 / 1 | 100,375 | 50.19 | 2.72 | beat-89 / 128 | 0.042 | 0.040 |
| 6 | Per application | 1 / 2 / 4 | 141,754 | 70.88 | 3.85 | beat-4 / 148 | 0.045 | 0.088 |

Read times in the table are the original samples. Five local replays gave median reads in the range 0.042–0.044 ms for plain keys and 0.021–0.069 ms for per-application keys across the three writer counts. The independent rerun measured 0.030–0.036 ms under both forms. The earlier gap is treated as timing noise.

### Repeated removal and reapplication

One writer tags the same 50 letters once. Each round removes the whole tag or removes only its middle letter, then applies T to the original 50 again. A complete removal clears all live keys. Removing just the middle lets the two sides accumulate applications. Maxima below are per character, measured after the removal and again after reapplication. The net byte count includes all prior rounds and the initial application.

| Pattern | Rounds | Plain max after removal → after reapply | Per-application max after removal → after reapply | Plain net bytes | Per-application net bytes |
| --- | ---: | --- | --- | ---: | ---: |
| Clear all 50 | 100 | 0 → 1 | 0 → 1 | 2,346 | 2,366 |
| Clear all 50 | 300 | 0 → 1 | 0 → 1 | 7,146 | 7,166 |
| Clear middle letter | 100 | 1 → 1 | 100 → 101 | 2,350 | 18,593 |
| Clear middle letter | 300 | 1 → 1 | 300 → 301 | 7,150 | 56,238 |

## Mixed forms in one cell

T on `cdef` and plain bold on `efg` both showed at merge. A's undo cleared T and kept bold. B's undo cleared bold, then each redo restored its own mark. The five checkpoints, returned steps and update counts matched the separate tag-only and bold-only runs in both client orders. The mixed row adds no loss, extra mark or update. It covers one bold operation alongside a tag operation.

## Values read from the implementation

| Reading | Claim it limits |
| --- | --- |
| Starting cells written by `NativeReplica.hydrate` | The model starts from the literal fixture. The first command check checks hydration indirectly, including only the starting content that survives that command. |
| Local and merged `Y.Text.toDelta()` text and attributes | These are actual readings. The command models take only fixture text, commands, seen command lists and intended undo targets. The local check compares application counts as well as text and names, but ignores key identity when two keys carry the same tag. |
| `Y.YTextEvent.delta` and Yjs state vectors and updates | The observer can trigger cleanup. Results apply to this delta-reading, relay and delivery schedule. The E4 writer uses the state vector to form the action suffix, reads local attribute extents to find keys to clear and uses native bounds to target the selected cell. None feeds the expected model. |
| The per-application writer's choice of inherited typing keys and tail re-keying | These are implementation choices that shape the main table and the stress run. The standard-write control isolates the two split rows. |
| Raw key names and value flags in the stored delta | These supply convergence, live key counts, and the cell chosen for timing. Agreement is about text, live keys and the strict reader's result. It does not compare internal history or prove convergence at every intermediate delivery. |
| `Y.UndoManager` stack entries before and after a command, then the returned entry | They link a press to the step it actually took. The expected command also stays in the model when the library creates no entry. Presses use standard `UndoManager.undo()` and `redo()`. They bypass the native variant's own undo step. |
| Public `update` events, encoded state length and the clock | These supply updates per press, stored bytes and timing. Encoded size includes Yjs history under default collection and excludes local undo stacks. Timing is a local sample. |
| Local before-and-after replay of a single muted call | The unmuted output is used only to classify whether muting changes text or live application counts. The independent command model decides pass or fail. A write that changes only internal history would be outside this control. |

Each call below was muted in isolation, on the recorded forward edits of the two-copy rows, including fixture formatting and the older typing. The same command check runs immediately after the muted call's command. Four value calls had no effect on the plain key because the whole selection already carried T. A redundant add with a per-application key is effective by the local application count even though it looks the same.

| Muted call | Reached | Effective | Failed the immediate check |
| --- | ---: | ---: | ---: |
| `Y.Text.format(value)` | 148 | 144 | 144 |
| `Y.Text.format(null)` | 30 | 30 | 30 |
| `Y.Text.insert` | 184 | 184 | 184 |
| `Y.Text.delete` | 4 | 4 | 4 |

## What was not measured

The tape has no simultaneous writes. The two-copy trials cover two client orders and one delivery schedule with two writers. They leave out larger races, different observer schedules, long offline periods, app binding and caret behavior, recovery persistence, registry rename or deletion, and text containing atoms or multiple tag categories on the same stretch over a long life. The typing traces test storage behavior, including a seen edit inside a tag that the standalone editor protects. There are no browser measurements, live server measurements, memory measurements, or undo guards. No undo repair, collapse or key-normalization rule is tested.

The review's skipped-press control found 12 document changes that the original tag and missing-text counters missed. Eight were in the bold row because the counters only read tag marks. The separate-runs test checks bold itself. Four were in the edge-typing rows because the missing-text counter ignored leftover typing. The text field now reports unexpected letters that remain as well as ones that disappear. No leftover letters appeared in the unmuted table.

## What is least certain

The number of repeats and partial removals in production scripts is unknown. The fresh, spaced slots make the long-life tape useful for sizing this history. They leave the real upper tail of key counts open. The short read and typing samples vary with the runtime and the cell. The 301-key stress case demonstrates growth under a specific repeat pattern.

## Replay

Run from `prototypes/collab` on Node 24.22.1 with the locked Yjs 13.6.33.

```sh
E6_TABLE=1 node --test test/format-keys/tag-races.test.ts test/format-keys/tag-life.test.ts
E6_TRACE=1 node --test test/format-keys/tag-races.test.ts
```

In PowerShell set `$env:E6_TABLE = '1'` or `$env:E6_TRACE = '1'` before running the corresponding `node --test` command. The race rows are fixed. The life tape uses seed 604. The stress rounds are fixed.
