# Candidate B with M1: retained counts

PASS means the existing scoped checker or complete literal forward/undo check passed. Split failures occur before those checks complete. Deliberate re-entry controls are listed separately. No timing results are reported.

| Trace | Writer B/M1 | Page slice B/M1 | Split narration B/M1 |
| --- | --- | --- | --- |
| T04 | 3/3 PASS | 3/3 PASS | 0/3 PASS |
| T04 removed | 2/2 PASS | 2/2 PASS | 0/2 PASS |
| T01 | 5/5 PASS | 5/5 PASS | Not extended after T04 failure |
| T01 composition | 5/5 PASS | 5/5 PASS | Not extended after T04 failure |
| T02 | 3/3 PASS | 3/3 PASS | Not extended after T04 failure |
| T02 boundary | 1/1 PASS | 1/1 PASS | Not extended after T04 failure |
| T03 | 2/2 PASS | 2/2 PASS | Not extended after T04 failure |
| T03 replace | 3/3 PASS | 3/3 PASS | Not extended after T04 failure |

| Writer follow-up | M1 scoped result |
| --- | --- |
| split-inside | 3/3 PASS |
| split-before | 3/3 PASS |
| split-after | 3/3 PASS |
| join-previous | 3/3 PASS |
| bold | 3/3 PASS |
| comment-tag | 3/3 PASS |
| long | 3/3 PASS |
| removed | 2/2 PASS |

| Deliberate Writer re-entry | No early hold | Early hold | Early hold + native paint gate |
| --- | --- | --- | --- |
| reentry-type | FAIL | PASS | PASS |
| reentry-replace | FAIL | PASS | PASS |
| reentry-paste | FAIL | PASS | PASS |

The 72-case Writer and page matrices each include M1/M2/M3, 24 cases per mechanism. Writer follow-up includes 96 cases, 32 per mechanism; M1 has 29 scoped passes and three deliberate baseline re-entry failures. Split has five isolated M1 cases, all failing final repaint. All app results pin c67139b8806d04231d2f2c5bb89814370bab8ef6.
