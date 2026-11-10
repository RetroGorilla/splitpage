# Real Writer follow-up measurements

App 935e618949a2e964198847daa2115d35e1da58ef; bundle 4c7340f81ce191908b519f8773d753ace4e2dfe346af645e3613261de87a81c9.

Machine: <machine>; AMD Ryzen 9 9950X3D2 16-Core Processor; win32 10.0.26300; v24.22.1; Edg/157.0.4341.42.

PASS denotes the declared invariants, or the complete unchanged T04 removed literal oracle. New combined visible scripts and marks are observations, not product oracles. Comment/tag DOM projection is unbound.

| Case | M1 | M2 | M3 |
| --- | --- | --- | --- |
| split-inside | 3/3 PASS | 3/3 PASS | 3/3 PASS |
| split-before | 3/3 PASS | 0/3 PASS | 3/3 PASS |
| split-after | 3/3 PASS | 3/3 PASS | 3/3 PASS |
| join-previous | 3/3 PASS | 3/3 PASS | 3/3 PASS |
| bold | 3/3 PASS | 3/3 PASS | 3/3 PASS |
| comment-tag | 3/3 PASS | 3/3 PASS | 3/3 PASS |
| long | 3/3 PASS | 3/3 PASS | 3/3 PASS |
| removed | 2/2 PASS | 2/2 PASS | 2/2 PASS |

| Native gesture / intervention | M1 | M2 | M3 |
| --- | --- | --- | --- |
| reentry-type / no early hold | FAIL | FAIL | FAIL |
| reentry-type / early hold only | PASS | FAIL | PASS |
| reentry-type / early hold + native DOM gate | PASS | PASS | PASS |
| reentry-replace / no early hold | FAIL | FAIL | FAIL |
| reentry-replace / early hold only | PASS | FAIL | PASS |
| reentry-replace / early hold + native DOM gate | PASS | PASS | PASS |
| reentry-paste / no early hold | FAIL | FAIL | FAIL |
| reentry-paste / early hold only | PASS | PASS | PASS |
| reentry-paste / early hold + native DOM gate | PASS | PASS | PASS |

## Composition-end timings

Each run holds composition across 240 declared B updates: 160 inserts and 80 deletes across R1/R2. Commit includes buffer planning, Yjs transaction, held-update drain and session projection. Paint is the first actual flow-surface.paint DOM reconciliation after that commit, including internally owed paints. These are single samples with instrumentation, not a performance budget, raster timing or controlled A/B benchmark. Zeros are permitted at the browser clock's resolution.

| Mechanism | Delivery | Peak held bytes | Peak held messages | Commit + projection ms | First actual DOM paint ms |
| --- | --- | ---: | ---: | ---: | ---: |
| M1 | D3 | 2318 | 240 | 1.500 | 0.000 |
| M1 | dup | 4636 | 480 | 2.100 | 0.100 |
| M1 | late-C | 2318 | 240 | 1.000 | 0.100 |
| M2 | D3 | 0 | 0 | 0.200 | 0.100 |
| M2 | dup | 0 | 0 | 0.200 | 0.200 |
| M2 | late-C | 0 | 0 | 0.200 | 0.100 |
| M3 | D3 | 2318 | 240 | 1.200 | 0.000 |
| M3 | dup | 2318 | 240 | 1.100 | 0.100 |
| M3 | late-C | 2318 | 240 | 1.100 | 0.100 |

All nine long-composition runs retain 40 live B characters in each beat and exactly one xy insertion. The source records two actual DOM reconciliations by return from compositionend and a third during the driver's explicit final verification paint. M1 queues duplicate bytes; M3's network document filters duplicates before forwarding to E. M2 retains no inbound editor queue.
