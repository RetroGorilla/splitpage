# Stage 2 stored growth and update admission

Draft: fresh storage meets both limits on all three fixtures. Edited storage, admission latency and heap conclusions remain unmeasured in this record. No admission number is inferred from preparation time.

Measured on 2026-11-13 at the adapter level in Node, with no browser, application wiring, transport or server. The source commit measured is `d49fd51fbf5d7819143d4e263ecc33e2f8226bd2`; its `src/adapters/collab` tree is `138889c20c2952880862f3e9ab0a1b1bcee81cb7`. Machine description: ARM64, Node v24.22.1. Other work was running throughout. These conditions differ from the Stage 0 browser baseline; its numbers are budget references, not a same-machine latency comparison.

## Reproduction and scope

After installing Node 24.22.1 and running `npm ci`, run:

```sh
node tools/measure-shared-admission.mjs shared-admission-results.json
```

The command internally runs all five rounds, prints Markdown tables and optionally retains the per-round samples in the named JSON file. Omitting the filename prints the tables alone. It refuses uncommitted changes to measured source, dependencies or fixtures. The thin launcher spawns a foreground Node process with `--expose-gc` and waits for it. The implementation and prototypes are in `tests/adapters/collab/measure/run.mjs`, where the existing dependency rule permits the sync library; no rule or baseline exception is added. That filename is not selected as a test by the normal runner. Focused checks: `node --test tests/adapters/collab/measure/measurement.test.mjs`.

The limits are those of [Stage 0 audit 7, section 7](stage-0/7-performance-baseline.md#7-provisional-limits-where-no-standalone-baseline-can-exist): fresh state at most 3x the plain `.splitpage` bytes; edited state at most 10x the plain size at that point and never above 2 MiB; input p50 at most standalone + 3 ms and never above 8 ms; p95 at most 25 ms on short/long and 40 ms on large; no typing task above 50 ms; after-load heap at most standalone + 10 MiB on long and 2x standalone on large. The coordinator's stated numbers agree. The record also specifies the after-edit denominator and the 50 ms task limit.

The short and long inputs are the saved, migrated seed and long demo in `tests/collab/fixtures/projection-reference.json`, selected by their original source names. Their saved bytes are asserted to be 1,734 and 38,432. Large repeats the long demo ten times with exactly the id/reference rewrite in `tools/perf-record.mjs`'s `SCALE.grow`: beats, comments and shots are copied, people and tags are kept once. Its saved size is asserted to be 334,208 bytes. The three inputs have 2/30/300 beats and 1/4/40 comments. No replacement script is generated.

`hydrateSharedDocument` imports the migrated fixture into a real adapter document; `projectSharedDocument` and `enterSharedDocument` then perform shared entry. The core entry function checks the projection shape and returns it; it does not itself create or encode a shared state. Stored bytes below are the real `encodeSharedState` result, with default Yjs garbage collection, deterministic 32-bit client ids and operation ids `m1`, `m2`, and so on. Identifier lengths are therefore fixed by the script, not sampled from app users. The edited plain denominator is the projected document serialized with the file codec's image inlining and indented JSON; the fixtures have no image payloads. No plain-object mutation stands in for a shared command.

Stage 0 defines workload counts, not a replay file, transaction grain or exact scheduling. This tool fixes the schedule: 100 blocks of 100 distinct single-character insertion operations followed by an observed deletion of those 100 characters, its undo and redo (10,000 inserted characters and 10,000 explicit character deletions); 50 split commands with undo, 50 joins with undo, and 100 beat removals with undo (200 structural commands); then 100 bold-range commands with undo. The same schedule runs on all three fixtures. Commands whose inverse is used run through `executeSharedCommand`; reversals use `reverseSharedUndoRecord` and must report effective success. Text operations use that command's real `executeSharedOperations` write path. Text is inserted at the advancing end of the first beat's audio cell. The structural and formatting edits are undone, and corrected text is deleted, before the edited checkpoint. The script also probes 100 undo/redo pairs on one typed character, independently of the checkpoint. Every requested family has a merged shared form and is exercised; none is silently substituted or omitted.

Preparation submits each block's 100 distinct insertion operations in one executor call. It does not combine them into one 100-character insertion: that would lose 99 birth records. The tool test pins three operations retaining three birth records and the same projection as three separate transactions; their encoded state is 12 bytes larger because the batched operations retain different Yjs origin links. The complete 10,000-key, one-transaction-per-key variant was not completed: preparation becomes very slow as retained records accumulate in one cell. Thus the edited checkpoint is a stated transaction-grain realization of Stage 0's counts, not a claim that transaction grouping is storage-neutral. The separate admission and typing-only growth probes use individual keystroke transactions.

The corrected-character rate is the correction phase's net encoded growth divided by ten. Typing-only growth is the exact increase from the next 1,000 individual keystrokes at each checkpoint. The undo/redo rate is the exact increase from 100 pairs on one one-character entry after the workload; it is not a universal rate for every command family.

For admission, a separate sender runs 1,000 real single-character commands and captures each update. Each timed receiver starts from the same encoded checkpoint. Each of five rounds measures 500 individual admissions (p50, p95 and maximum), plus synchronous drains of 100 and 1,000 distinct causal updates. No idle delay, browser frame, buffer hold or network is included: queued means an already available list drained in order. Whole-state cloning used to prepare a receiver is outside the timed region. The real per-update trial is inside it. Methods rotate order between rounds. Within-run quantiles use nearest rank. Results are medians of the five per-round statistics with the full min–max spread; no outlier is removed or pooled into another run. The maximum column summarizes per-run maxima, so its range's upper end is the overall observed maximum.

The direct control applies the same updates through the same adapter transaction and live observers to a scratch receiver, bypassing admission. The decode-only prototype retains `decodeUpdate` and the positive struct-length check, then uses that direct path. The one-trial prototype makes one `CollabDocumentState`, copies the checkpoint into it, decodes/checks/applies the entire burst there, destroys it, then applies each update to the live scratch receiver. The script asserts identical final encoded states for all four methods. The overhead fractions are paired round estimates: `1 - direct/current` includes trial and validation; `1 - decode/current` more closely isolates trial creation, full-state encode/copy, trial application and destruction. They are differences between controls, not profiler attribution.

Heap sampling is a separate pass, so sampling does not inflate the timing tables. Peak is the largest `heapUsed` sampled after an admission minus the pre-burst heap after two forced collections; it may miss an intra-admission peak. Retained is the after-burst delta after two collections. External buffers and resident process memory are not included in `heapUsed`. After-load footprint compares the incremental retained size of a cloned plain fixture and an adapter receiver, excluding imported code and fixture data already present in the process. It includes the receiver's normal observers and caches, but no projection, DOM, app owners or in-memory undo stack. It cannot certify Stage 0's whole-application heap limit. After-edit footprint uses the original plain fixture as its control because the workload restores the script content.

## Results

| Script | Plain bytes | Fresh shared bytes | Fresh / plain | Fresh / 2 MiB | 3x limit | 2 MiB limit | Edited bytes / 10x limit | Growth per 1,000 typed / 100 undo-redo pairs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| short | 1,734 | 4,189 | 2.42x | 0.20% | holds | holds | unmeasured | unmeasured |
| long | 38,432 | 73,161 | 1.90x | 3.49% | holds | holds | unmeasured | unmeasured |
| large | 334,208 | 690,502 | 2.07x | 32.93% | holds | holds | unmeasured | unmeasured |

| Script / start state | Admission p50 / p95 / max | Burst 100 / 1,000 | Trial share | Burst heap | Prototype costs |
| --- | --- | --- | --- | --- | --- |
| short / fresh | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |
| short / edited | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |
| long / fresh | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |
| long / edited | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |
| large / fresh | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |
| large / edited | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |

The long-running command completed all three edited workloads and the separate undo/redo probes. It also completed five short/fresh timing rounds, but their numerical results had not been emitted when this draft was published. The process was paused to publish and validate the draft. Remaining rows will be added from completed, uninterrupted timing sets; the paused timing span will not be reported as workload cost.

Draft validation: dependency and comment gates pass, the three focused tests pass, and lint passes on the three new scripts. Full lint and type checking were run but are blocked by missing Electron and prototype-service dependency declarations in this checkout; core and web type checking pass. No source or gate is changed to bypass those failures. The full verification command was not run.

## Admission alternatives and safety

The direct path is a cost control, not a proposed admission policy: it removes decoding checks and isolation from mutations made before an application error. Decode-only validation avoids the full-document trial but gives up checking integration against the current document before mutation; successful decoding and positive struct lengths do not prove safe integration or a valid application schema. One trial per burst retains all-before-live integration preflight for that fixed list of updates and rejects the whole list if any member fails. It gives up per-update acceptance/refusal and does not implement the live ingress gate's reentrant holds, capacity or callback behavior. Valid-state equivalence and the malformed-batch tool test do not establish safety against arbitrary updates. The owner must choose a policy before any source change.

Decode-only timing does not establish that a complete validator without copying exists. Browser paint, end-to-end typing, real buffer admission/drain, concurrent writers, app undo grouping, server limits, persistence, reconnect, receipts and a 2 MiB input fixture were not run. No standalone performance A/B or full verification suite was run: this change contains only measurement tooling and this record, and the task leaves the full gate to CI.
