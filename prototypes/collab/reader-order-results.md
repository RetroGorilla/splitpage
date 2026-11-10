# Stage 1a: full reader convergence check — #1376

First revision: the general check and literal known-failure table, on merged main after #1413. This revision changes tests and result text only. Reader fixes follow by shrinking the table; green tests below mean the check reproduces and classifies the declared failures, not that these readers converge.

`test/reader-convergence.ts` captures actual authored Yjs updates, replays every delivery order a history's row lists, and creates an encoded-state late joiner for each replay. At every existing structure/marks checkpoint it compares the complete public reader output (all fields, character identities, marks, carets, recovery, records and notices), prohibits reader writes and records every exception. Shared Yjs registry values are compared through their public JSON representation, excluding local document/observer internals. State vectors establish complete delivery; encoded bytes can legitimately differ when an UndoManager retains otherwise collected deleted content. The new minimized histories, which have no such retention, additionally require byte-identical encoded state.

The strict `check` fails on every observed difference or throw. `checkKnown` returns failures and accepts only the literal field/exception catalog in `test/reader-order/known-failures.ts`; an unlisted field or exception fails the gate. Existing independent product oracles remain unchanged and still run. Negative controls reject lost rows, a new status difference, an unknown exception, and the old reply comparator in an ordinary history with no replies. Every checkpoint gets a separate forward/reverse concurrent canonical-equivalent reply probe (`é`, `é`) and its encoded late joiner, so this class is checked without a dedicated matrix.

## Known failing readers, reproduced from real commands

| Case / reader | Literal expected result or open choice | Observed failure | State |
| --- | --- | --- | --- |
| Removal attribution, `structure-reader.ts:111` | One removal, attribution `Alice, Bob` in stable order | Alice/Bob/Bob across writer/writer/late join | Failing |
| Visual concatenation, `structure-reader.ts:133` | Beat order, then rank, then component identity | `X<br>Y` / `Y<br>X` / `Y<br>X` | Failing |
| Replies, `marks/projection.ts:79` (also exposed by readStructure) | Equal-time ids ordered by UTF-16 code units: `["é","é"]` | `["é","é"]` on Alice, reversed on Bob/late join | Failing |
| Recovery edited identities, `structure-reader.ts:106` | Open: observed-set union gives `[]`; “after any removal” gives `["a1"]` | `[]` / `["a1"]` / `["a1"]` | Failing; policy options retained |
| Recovery split attribution, same reader | Open: omit after direct removal, or retain Alice for the inherited removal | absent / Alice / Alice | Failing; policy options retained |
| Join target removed, readStructure and readReplica | Joined source stays inside target's removed group | Both readers throw on every replica | Failing |
| Join target moved, B layout, same readers | Joined source follows target: R1 `ab cd`, R3 `ef` | Both readers throw on every replica | Failing |

`readerHistoryRows` is literal data, including required projection summaries authored before running and exact old observations. The tests require each named failure class to be detected, including exceptions even when all replicas throw. Thirteen layout/history rows run six delivery orders with live and encoded-state replicas. Existing records [T21-other-readers-map-order.md](histories/T21-other-readers-map-order.md) and [T21-reply-collation-order.md](histories/T21-reply-collation-order.md) remain unchanged. New records: [recovery](histories/T21-recovery-map-order.md), [join targets](histories/T21-join-target-unavailable.md).

Four retained seeds (1376, 1413, 1592590337, 1592590338), both layouts and swapped clients generate **96 histories, 1,152 real command attempts and 384 convergence checkpoints**, each replayed through all six orders and encoded late joiners. Commands cover insertion, split, removal, restoration, join and supported B moves. All exceptions/differences belong to the table: join-target exceptions, removal attribution and reply collation. No unlisted reader disagreement was found. This is bounded evidence, not a proof over all command histories.

## Evidence and next fixes

No production or timed source changes in this first revision; no counts, timing audits, pinned browser evidence or timing observations need rewriting. No timing, Edge, browser or development server ran. The #1413 status validator and its write/encode/reload properties are inherited unchanged. Other raw-value readers remain as on main; there are no newly converted production readers yet.

The follow-up fixes will use all validated removal records, visual order from converged beat order/rank/component identity, and UTF-16 code-unit comparison in every shared-state ordering. ComponentId remains artifact 8's final visual tie-break because it identifies a component; it does not resolve a status conflict or choose a remover. Every “sorted” row of the inherited audit will name its comparator. Changed timed sources, counts and retained rows will be declared then, without rewriting historical evidence.

Validation on Node 24.22.1: full prototype **1,709/1,709 tests pass, zero skipped**; the focused structure/marks/general set passes **217/217**. The first revision adds 23 tests, including the 13 literal layout/history rows, two checker controls and eight seeded layout runs. Root lint, typecheck, check:comments and check:deps pass. Existing product oracles, defect histories, mutation evidence, browser bundles, timings and count files are unchanged.
