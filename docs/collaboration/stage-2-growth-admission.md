# Stage 2 stored growth and update admission

Draft: fresh storage holds the 3x and 2 MiB limits on all three fixtures. Edited storage fails both the 10x and 2 MiB limits on all three: the largest multiple is short at 5,266.13x plain bytes, and the largest state is 9,131,462 bytes. Admission alone exceeds the 8 ms p50 limit on short/edited and the p95 limits on short/edited. The table also screens the added-input allowance against the Stage 0 reference. Repetition counts below identify interim figures; the timing requirement is not yet complete. The whole-application heap limit cannot be certified by this Node adapter measurement.

Measurements began on 2026-11-13 and continued on 2026-11-14 at the adapter level in Node, with no browser, application wiring, transport or server. The source commit measured is `d49fd51fbf5d7819143d4e263ecc33e2f8226bd2`; its `src/adapters/collab` tree is `138889c20c2952880862f3e9ab0a1b1bcee81cb7`. Machine description: ARM64, Node v24.22.1. Other work was running throughout. These conditions differ from the Stage 0 browser baseline; its numbers are budget references, not a same-machine latency comparison.

## Reproduction and scope

After installing Node 24.22.1 and running `npm ci`, run:

```sh
node tools/measure-shared-admission.mjs shared-admission-results.json
```

The command internally runs all five rounds and prints Markdown tables. With a JSON filename, it writes completed preparation and rounds incrementally, plus a `.checkpoint.json` sidecar, and resumes that checkpoint on the same command. The checkpoint rejects changed source, dependencies, fixtures, Node version or CPU architecture. Omitting the filename prints the tables alone. Checkpoints are local run data and are not committed. It refuses uncommitted changes to measured source, dependencies or fixtures. The thin launcher spawns a foreground Node process with `--expose-gc` and waits for it. The implementation and prototypes are in `tests/collab/measure/run.mjs`, beside the collaboration integration tests, where existing rules permit the sync library and raw document construction. The focused adapter test uses the required formatting-monitor factory. CI exposed that every file under `tests/adapters/collab/`, including a manual script, must use that monitor; the manual measurement was moved so instrumentation does not change its adapter timings. No rule or baseline exception is added. That filename is not selected as a test by the normal runner. Focused checks: `node --test tests/adapters/collab/measure/measurement.test.mjs`.

The limits are those of [Stage 0 audit 7, section 7](stage-0/7-performance-baseline.md#7-provisional-limits-where-no-standalone-baseline-can-exist): fresh state at most 3x the plain `.splitpage` bytes; edited state at most 10x the plain size at that point and never above 2 MiB; input p50 at most standalone + 3 ms and never above 8 ms; p95 at most 25 ms on short/long and 40 ms on large; no typing task above 50 ms; after-load heap at most standalone + 10 MiB on long and 2x standalone on large. The coordinator's stated numbers agree. The record also specifies the after-edit denominator and the 50 ms task limit.

The short and long inputs are the saved, migrated seed and long demo in `tests/collab/fixtures/projection-reference.json`, selected by their original source names. Their saved bytes are asserted to be 1,734 and 38,432. Large repeats the long demo ten times with exactly the id/reference rewrite in `tools/perf-record.mjs`'s `SCALE.grow`: beats, comments and shots are copied, people and tags are kept once. Its saved size is asserted to be 334,208 bytes. The three inputs have 2/30/300 beats and 1/4/40 comments. No replacement script is generated.

`hydrateSharedDocument` imports the migrated fixture into a real adapter document; `projectSharedDocument` and `enterSharedDocument` then perform shared entry. The core entry function checks the projection shape and returns it; it does not itself create or encode a shared state. Stored bytes below are the real `encodeSharedState` result, with default Yjs garbage collection, deterministic 32-bit client ids and operation ids `m1`, `m2`, and so on. Identifier lengths are therefore fixed by the script, not sampled from app users. The edited plain denominator is the projected document serialized with the file codec's image inlining and indented JSON; the fixtures have no image payloads. No plain-object mutation stands in for a shared command.

Stage 0 defines workload counts, not a replay file, transaction grain or exact scheduling. This tool fixes the schedule: 100 blocks of 100 distinct single-character insertion operations followed by an observed deletion of those 100 characters, its undo and redo (10,000 inserted characters and 10,000 explicit character deletions); 50 split commands with undo, 50 joins with undo, and 100 beat removals with undo (200 structural commands); then 100 bold-range commands with undo. The same schedule runs on all three fixtures. Commands whose inverse is used run through `executeSharedCommand`; reversals use `reverseSharedUndoRecord` and must report effective success. Text operations use that command's real `executeSharedOperations` write path. Text is inserted at the advancing end of the first beat's audio cell. The structural and formatting edits are undone, and corrected text is deleted, before the edited checkpoint. The script also probes 100 undo/redo pairs on one typed character, independently of the checkpoint. Every requested family has a merged shared form and is exercised; none is silently substituted or omitted.

Preparation submits each block's 100 distinct insertion operations in one executor call. It does not combine them into one 100-character insertion: that would lose 99 birth records. The tool test pins three operations retaining three birth records and the same projection as three separate transactions; their encoded state is 12 bytes larger because the batched operations retain different Yjs origin links. The complete 10,000-key, one-transaction-per-key variant was not completed: preparation becomes very slow as retained records accumulate in one cell. Thus the edited checkpoint is a stated transaction-grain realization of Stage 0's counts, not a claim that transaction grouping is storage-neutral. The separate admission and typing-only growth probes use individual keystroke transactions.

The corrected-character rate is the correction phase's net encoded growth divided by ten. Typing-only growth is the exact increase from the next 1,000 individual keystrokes at each checkpoint. The undo/redo rate is the exact increase from 100 pairs on one one-character entry after the workload; it is not a universal rate for every command family.

For admission, a separate sender starts from the fresh checkpoint, runs 1,000 real single-character commands and captures each update. The same causal stream is admitted against fresh and edited receivers: this models a peer that has not received the workload. Every checkpoint must gain exactly 1,000 visible characters under the direct control. Each timed receiver starts from its encoded checkpoint. The 500 single-admission samples are sequential: each receiver retains preceding keys, so a fresh row begins at the fresh checkpoint and grows during that window. Each of five rounds measures 500 individual admissions (p50, p95 and maximum), plus synchronous drains of 100 and 1,000 distinct causal updates. No idle delay, browser frame, buffer hold or network is included: queued means an already available list drained in order. Whole-state cloning used to prepare a receiver is outside the timed region. The real per-update trial is inside it. Methods rotate order between rounds. Within-run quantiles use nearest rank. Results are medians of the five per-round statistics with the full min–max spread; no outlier is removed or pooled into another run. The maximum column summarizes per-run maxima, so its range's upper end is the overall observed maximum.

The direct control applies the same updates through the same adapter transaction and live observers to a scratch receiver, bypassing admission. The decode-only prototype retains `decodeUpdate` and the positive struct-length check, then uses that direct path. The one-trial prototype makes one `CollabDocumentState`, copies the checkpoint into it, decodes/checks/applies the entire burst there, destroys it, then applies each update to the live scratch receiver. Each 1,000-update timing asserts its final encoded state against the direct control after stopping the timer. The overhead fractions are paired round estimates: `1 - direct/current` includes trial and validation; `1 - decode/current` more closely isolates trial creation, full-state encode/copy, trial application and destruction. They are differences between controls, not profiler attribution.

Heap sampling is a separate untimed pass for each burst size, so sampling does not inflate the timing tables. Timing and after-load-footprint statistics have five repetitions; heap-only replays run once per case. The retained short/fresh data already has five heap passes from the initial protocol; the table states each count. Peak is the largest `heapUsed` sampled after an admission minus the pre-burst heap after two forced collections; it may miss an intra-admission peak. Retained is the after-burst delta after two collections. External buffers and resident process memory are not included in `heapUsed`. After-load footprint compares the incremental retained size of a cloned plain fixture and an adapter receiver, excluding imported code and fixture data already present in the process. It includes the receiver's normal observers and caches, but no projection, DOM, app owners or in-memory undo stack. A negative small plain delta reflects collection noise, not negative object size; those ratios are unreliable when the plain delta is near zero. It cannot certify Stage 0's whole-application heap limit. After-edit footprint uses the original plain fixture as its control because the workload restores the script content.

## Results

Rows with fewer than five repetitions are interim and do not yet meet the timing repeat-count requirement.

| Script / state | Completed timing rounds |
| --- | --- |
| short / fresh | 5 / 5 |
| short / edited | 5 / 5 |
| long / fresh | unmeasured |
| long / edited | unmeasured |
| large / fresh | unmeasured |
| large / edited | unmeasured |

Values are medians [min–max] of per-round statistics, not pooled updates.

| Script | Fresh plain bytes | Fresh bytes / plain / cap % | Edited bytes / fresh plain / cap % | Edited plain bytes / edited multiple | Bytes per 1,000 corrected characters | Bytes per 100 undo/redo pairs |
| --- | --- | --- | --- | --- | --- | --- |
| short | 1734 | 4189 / 2.42x / 0.20% | 9131462 / 5266.13x / 435.42% | 1734 / 5266.13x | 725627.8 | 524274 |
| long | 38432 | 73161 / 1.90x / 3.49% | 7894446 / 205.41x / 376.44% | 38432 / 205.41x | 733618.7 | 524374 |
| large | 334208 | 690502 / 2.07x / 32.93% | 8550333 / 25.58x / 407.71% | 334208 / 25.58x | 737353.3 | 524374 |

| Script / state | Bytes added by 1,000 typed characters without deletion |
| --- | --- |
| short / fresh | 324052 |
| short / edited | 324052 |

| Script / state | Admission p50 ms | p95 ms | max ms | Direct p50 ms | Decode-only p50 / p95 ms | Trial + validation % / trial estimate % (500 total) |
| --- | --- | --- | --- | --- | --- | --- |
| short / fresh | 3.51 [3.18–4.07] | 14.43 [5.72–19.55] | 30.78 [8.48–37.03] | 0.03 [0.02–0.03] | 0.04 [0.03–0.04] / 0.06 [0.06–0.08] | 99.11 [98.50–99.42] / 98.81 [98.07–99.19] |
| short / edited | 202.67 [193.24–254.00] | 317.41 [214.29–563.55] | 507.09 [249.42–902.76] | 0.02 [0.02–0.03] | 0.02 [0.02–0.04] / 0.04 [0.03–0.06] | 99.98 [99.96–99.98] / 99.97 [99.96–99.98] |

Input budget screen only; passing admission alone does not establish end-to-end input latency.

| Script / state | Available added p50 ms (Stage 0 reference) | Added p50 budget | Admission p50 alone vs 8 ms | Admission p95 alone vs 25/40 ms | Any admission above 50 ms |
| --- | --- | --- | --- | --- | --- |
| short / fresh | 3.0 | EXCEEDS | within alone | within alone | no |
| short / edited | 3.0 | EXCEEDS | EXCEEDS | EXCEEDS | yes |

| Script / state / burst | Current ms | Direct ms | Decode-only ms | One trial ms | Current / direct | Peak heap delta MiB | Retained heap delta MiB | Heap passes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| short / fresh / 100 | 172.44 [108.42–215.38] | 4.36 [4.09–4.55] | 5.20 [5.13–13.86] | 7.51 [6.42–9.74] | 40.00 [23.82–52.67]x | 44.93 [44.84–45.43] | 0.16 [0.04–0.21] | 5 |
| short / fresh / 1000 | 9491.26 [5823.66–10494.96] | 32.16 [27.73–36.23] | 42.37 [36.54–63.80] | 95.96 [53.79–108.68] | 290.38 [209.99–326.38]x | 65.77 [65.26–161.01] | 1.11 [1.04–1.13] | 5 |
| short / edited / 100 | 21318.66 [19103.14–29996.84] | 17.74 [15.12–26.26] | 16.95 [14.90–24.06] | 262.20 [236.18–286.08] | 1237.04 [727.37–1519.80]x | 266.05 [266.05–266.05] | 0.12 [0.12–0.12] | 1 |
| short / edited / 1000 | 245457.95 [195951.60–296163.71] | 32.32 [29.50–66.89] | 37.96 [34.31–60.17] | 285.79 [261.18–304.73] | 6236.48 [4427.47–7991.79]x | 265.18 [265.18–265.18] | 29.41 [29.41–29.41] | 1 |

| Script / state | Plain retained MiB | Shared retained MiB | Shared minus plain MiB | Shared / plain |
| --- | --- | --- | --- | --- |
| short / fresh | 0.004 [-0.880–0.004] | 0.133 [0.119–0.152] | 0.129 [0.115–1.022] | 30.44 [-0.16–35.76]x |
| short / edited | 0.004 [-0.348–0.004] | 27.301 [27.288–27.328] | 27.300 [27.295–27.676] | 6447.12 [-128.37–6895.59]x |

Full lint and type checking, dependency and comment gates, and all four focused tests pass after installing the existing desktop and prototype dependencies. No dependency rule or baseline changed. The full verification command was not run.

## Admission alternatives and safety

On short/edited (5 of 5 timing rounds), the one-trial prototype admits 1,000 updates in 285.79 [261.18–304.73] ms, versus 245457.95 [195951.60–296163.71] ms for current admission. Decode-only p50 is 0.02 [0.02–0.04] ms. These are measured costs, not validated replacement policies. A one-update batch still copies the whole document: the burst prototype amortizes that copy only when multiple updates are already queued.

The direct path is a cost control, not a proposed admission policy: it removes decoding checks and isolation from mutations made before an application error. Decode-only validation avoids the full-document trial but gives up checking integration against the current document before mutation; successful decoding and positive struct lengths do not prove safe integration or a valid application schema. One trial per burst retains all-before-live integration preflight for that fixed list of updates and rejects the whole list if any member fails. It gives up per-update acceptance/refusal and does not implement the live ingress gate's reentrant holds, capacity or callback behavior. Valid-state equivalence and the malformed-batch tool test do not establish safety against arbitrary updates. The owner must choose a policy before any source change.

Decode-only timing does not establish that a complete validator without copying exists. Browser paint, end-to-end typing, real buffer admission/drain, concurrent writers, app undo grouping, server limits, persistence, reconnect, receipts and a 2 MiB input fixture were not run. No standalone performance A/B or full verification suite was run: this change contains only measurement tooling and this record, and the task leaves the full gate to CI.
