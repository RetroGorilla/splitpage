# Stale-base experiment results

The simulated editable beat retains paint-time identities, runs, epoch and beat version. Native edits change a string; commit finds its difference from that paint and maps only observed identities. Synthetic composition start/update/end events keep the native buffer unchanged by remote integration. Both candidate layouts run; no DOM or real editor is used.

Main traces: 144/144 pass, including each row's undo outcome, carets, selections, marks and recovery list. Counts include both candidates and all listed orders. M3 checks every E and N document separately, plus late-C where listed.

| Trace | M1 | M2 | M3 | Delivery orders |
| --- | --- | --- | --- | --- |
| T04 | PASS (6/6) | PASS (6/6) | PASS (6/6) | D3, dup, late-C |
| T04 removed | PASS (4/4) | PASS (4/4) | PASS (4/4) | D3, late-C |
| T01 | PASS (10/10) | PASS (10/10) | PASS (10/10) | D1, D3, dup, rev, late-C |
| T01 composition | PASS (10/10) | PASS (10/10) | PASS (10/10) | D1, D3, dup, rev, late-C |
| T02 | PASS (6/6) | PASS (6/6) | PASS (6/6) | D3, dup, late-C |
| T02 boundary | PASS (2/2) | PASS (2/2) | PASS (2/2) | D3 |
| T03 | PASS (4/4) | PASS (4/4) | PASS (4/4) | D1, D3 |
| T03 replace | PASS (6/6) | PASS (6/6) | PASS (6/6) | D1, D3, dup |

Main runs use target-range evidence and insert replacements at the painted gap before deleting the selected identities. T01's composition variant is additional to the seven requested rows. T01 undo selects the restored bXc; T03 replace undo selects the restored second word. The older harness's T01 undo oracle now checks that selection too; it failed with `carets.A.selection … got <missing>` before reanchoring it.

## Failure probes and predictions

PASS below means the probe met the literal content oracle; FAIL means it hit the stated missing requirement or oracle difference. These failures are asserted by tests; they are not skipped or substituted for the main trace oracles.

| Probe | M1 | M2 | M3 | History |
| --- | --- | --- | --- | --- |
| T02, base recaptured from the replica | FAIL | FAIL | FAIL | [history](histories/T02-recaptured-base.md) |
| T04, base recaptured at composition commit | E frozen by tested gate | FAIL | E frozen by tested gate | [history](histories/T04-recaptured-base.md) |
| T03, strings without native target ranges | FAIL | FAIL | FAIL | [history](histories/T03-no-target-ranges.md) |
| T04, composition held past byte bound | FAIL | no deferral queue | FAIL | [history](histories/T04-long-composition.md) |
| T04 removed, active-only mapping | not probed | FAIL | not probed | [history](histories/T04-removed-no-recovery-mapping.md) |
| T04, actual provider bypasses gate | FAIL deferral; content PASS | not probed | not probed | [history](histories/T04-provider-bypass.md) |
| T01 composition, delete before insert | FAIL D1/D3 | FAIL D1; PASS D3 | FAIL D1/D3 | [history](histories/T01-composition-delete-first.md) |

Artifact 8 §4's repeated-text failure does not occur in the main M2 run with synthetic target ranges; without those ranges the diff has four equally minimal deletions and cannot know the selected identities. This is conditional evidence for the proposed binding contract, not proof that a browser supplies those ranges reliably. The same ambiguity affects M1 and M3 if target evidence is removed.

The removed-target prediction is confirmed as a recovery requirement. Soft removal retains R1's text; M2 deliberately inserts into that retained recovery context, never the neighbouring active beat. M1 and M3 integrate removal after local commit; the removal's observed identities still classify a1/a2 as Alice's unobserved edit. Undo removes only her insertion and leaves Bob's removal intact.

The pinned provider's public `onMessage` path really changes M1's E during composition without entering its queue. The deferral prediction is confirmed, while a stronger claim that this necessarily corrupts T04's text is not observed: identity-mapped commit still passes. The probe disables socket connection, supplies framed inbound messages directly, and destroys provider and socket timers in finally.

M1/M3 fail the deliberately tiny byte bound without dropping the overflow transport message. M3 has already integrated it into N, so the trace stops and retains N as well as the native buffer; recovery, cancellation, quotas and persistence need a separate design. The queue limit here is an injectable stress bound, not a proposed product limit. M3's main runs prove distinct N/E documents and origin-filtered forwarding with no echo messages; they do not prove crash-safe persistence or heap budgets.

No schema or mechanism is selected. The real editor still needs reliable paint snapshots, beforeinput target ranges or equivalent selection evidence, synchronous stale-paint cancellation/repaint, composition binding, selection restoration and recovery routing. Provider/hydration/recovery ingress must share a gate for M1; M3 requires durable coordination of E and N. Candidate A identity scans and the exhaustive small-string splice enumerator are unmeasured and make no production performance claim. PERF, STORE, images and app/browser suites are outside this lane.

Reproduce: `npm test`; `npm run experiments`; `node src/buffer-report.ts --check` checks the retained result table and histories. Expected results are unchanged literal data from artifact 8. No product status policy is exercised or selected.
