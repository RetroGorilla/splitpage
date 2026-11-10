# Refused device feasibility: T18 and T19 (a/b)

The pinned Hocuspocus 4.8.0 server and provider can stop publication after a permanent refusal without losing the local replica or automatically reconnecting. T19 (a) and (b) pass with a normally returning `beforeSync`, read-only refusal, a stateless reason, immediate provider detachment, and cancellation of retries on the dedicated socket. T18 passes its four specified inputs. The additional malformed SyncStep2 case is a bounded library limit: the hook returns normally, then `snapshotContainsUpdate` throws and the library closes the logical connection. The policy still stops publication after its first notice. This does not satisfy a requirement that malformed SyncStep2 leave the logical connection open.

This is prototype evidence, not admission, a local storage adapter, a standalone file exporter, a selected schema, or a Stage 1b exit decision. No app code changes. The existing journal implementation and its accepted commit/status-ordering limit remain as described in [the service report](../README.md). No expected result from artifact 8 was changed.

## Mechanism and shared files

`boundary.ts` is an opt-in server extension. It checks byte size and full decode before journal access. For size validation it applies the candidate to a disposable document, never the live document. It holds a per-document promise queue through `afterHandleMessage`, keeping candidate validation, the existing awaited journal append, and application in order across connections. The scoped rate fixture counts incremental updates per connection in a one-second window. A temporary rate refusal resets read-only in `afterHandleMessage`; permanent refusal keeps it set. An injected revocation predicate lets the admission owner recheck access before an update reaches the journal. Authentication, persistent revocation and denial of a new connection are outside this module.

`policy.ts` listens to supported provider stateless events and socket events. A permanent notice detaches immediately and disables retries. After observing the following status or logical-close frame it disconnects the dedicated transport. This preserves observation of the negative status instead of racing the normally returning hook by closing the transport as soon as the notice arrives. Socket close 1009 also detaches and cancels retries. A socket must be dedicated to this device's provider; a future multiplexed transport needs ownership of the remaining providers before disconnecting it.

Shared `server-process.ts` has five added lines: import the extension, enable it with `REFUSAL_POLICY`, set a 4 MiB socket cap in that mode, and allow an injected frozen clock for the rate fixture. A 3 MiB update therefore reaches `beforeSync`; a 20 MiB frame does not. `MAX_PAYLOAD` still overrides the cap for the existing journal experiments. Shared `receipts.ts` now retains the insertion/deletion ranges of negatively acknowledged messages and requires them to be covered by later positive receipts, instead of permanently latching every negative status. Undecodable sends retain a conservative invalid latch. FIFO matching and connection-lifetime handling are unchanged. `test/service/harness.ts`, the journal files and the original ordering/review/journal tests are unchanged. New source and test modules stay under the refusal folders. No package or lockfile changes.

## Literal client states

The separate local-storage owner is assumed to have committed the replica and required assets. These tests establish retention and binary rehydration, not crash durability of local storage or `.splitpage` export encoding. The production exporter must read this retained replica without first publishing it. Local replicas remain excluded from app-data export; the product action is **Standalone copy**, as required by Product decision 13.

| Step | Person sees | Publication and retained work |
| --- | --- | --- |
| Offline/restarted, hydrated local replica | `Offline, saved on this device` | Existing replica retained |
| Connected, initial durable receipt | `Your changes saved to server` | Prior generation acknowledged |
| New local oversized edit, before response | `Saved on this device, sending` | Whole edit present; previous saved status invalidated |
| Permanent oversized/invalid refusal | `Saved on this device`, reason, `refusal.export-standalone-then-rejoin` | Provider detached; replica stays editable and exportable as `Standalone copy` |
| Access refusal | `Access removed, local work kept`, `refusal.export-standalone-then-rejoin` | Same retained-work policy; this status branch is a policy seam, not an admission implementation |
| Temporary prerequisite refusal | `Saved on this device, sending`, `refusal.retry-after` | Provider stays attached; caller owns satisfying the prerequisite and requesting retry |
| Temporary refused work durably acknowledged | `Your changes saved to server`, no explanation or reason | Retry details clear; provider stays attached; permanent refusals never take this transition |
| Deliberate rejoin | Fresh replica loaded from server | Old replica retained for standalone export and deliberate recovery; it is never automatically reattached or merged wholesale |

The two placeholder explanation keys above are intentional. Product decision 14 and artifact 8's Decisions table leave refusal/rejoin wording unwritten. No new product wording was selected. The reason codes are prototype metadata, not ordinary UI text. The policy forwards receipt/local status while attached and cannot turn a detached replica into `Your changes saved to server`, even if its caller supplies that stale status. The rejoin callback is a wiring seam: the tests use it to create a fresh provider and document and verify the refused replica is unchanged. Invitation validation and the actual standalone-export/rejoin UI belong to production wiring.

`retryAfter` is distinct from `rejected` and does not detach. The images lane owns T19 (c), image uploads and the durable-membership signal. This lane proves the rate refusal uses that seam, clears its temporary read-only flag for subsequent messages, and reaches saved status without a retry explanation when a covering `forceSync()` acknowledgement arrives. An unrelated positive receipt cannot clear refused insertion or deletion coverage. A successful fresh rejoin cannot clear the retained old replica's permanent refusal.

## Trace evidence

All tests are in `test/service/refusal/refusal.test.ts`, including the subtests registered by `dependencies.ts` and `revocation.ts`. The deliberate defect is awaited first. If it is not rejected, the outer test fails. Every transmitted document update consumes a harness-owned literal disposition; receiving a server notice never selects its expected disposition. Protocol/control sends carry the harness's fixed `protocol` classification. Receipts come from actual socket frames, not provider counters or diagnostics. Journal assertions independently read SQLite.

| Trace | Result and delivery | Deciding test / history |
| --- | --- | --- |
| Deliberate reconnecting policy | Rejected before honest traces count: the harness-owned TCP proxy observes a second accepted connection | `deliberate defect: reconnect after the first permanent refusal`; `histories/T19-reconnecting-policy.json` |
| T18 (a), 20 MiB | Close 1009 before `beforeSync`; no journal entry or positive receipt; policy detaches and peer remains writable | `T18 20 MiB socket frame` |
| T18 (b), `u1` cut by three bytes | Full decode fails before journal access; normally returning hook sends stateless reason and negative status, keeps connection open; peer resync has literal original identities, then its edit commits | `T18 truncated delete-set tail, sync subtype 2` |
| T18 (c) / T19 (a), 3 MiB incremental insert | First refusal gives negative status; no journal row, apply or fanout; provider detaches, local work remains, deliberate fresh rejoin contains only `abcd` | `T19 incremental` |
| T18 aggregate-state boundary | Two different clients send individually small 1,100,011-byte updates. The first candidate is held before commit; after its apply the second would exceed the state cap and is refused. A late join contains only the first insertion. Removing the admission await fails the independently read journal prefix before gate release | `T18 state size`; `histories/T18-stale-candidate.json` |
| T18 (d), 200 incremental updates inside one frozen one-second window | 50 accepted, 150 temporary negative statuses and notices, 51 rows including initial sync; stays attached and sending until retry. After `forceSync()`: all 200 identities on the server and a late joiner, zero outstanding receipts, saved status, no explanation or reason | `T18 rate limit`; `histories/T18-temporary-refusal-stuck.json` retains the original failure |
| T19 (b), restart | Hydrate a new document from bytes containing the 3 MiB edit; actual provider SyncStep2 is refused once; detach, no new journal row, local edit remains exportable | `T19 restart-syncstep2` |
| Malformed SyncStep2, without policy | Refusal reason sent, no journal entry or positive receipt; normally returning hook is followed by library exception and logical close; another client still resyncs and commits | `T18 truncated delete-set tail, sync subtype 1`; `histories/T18-malformed-syncstep2.json` |
| Malformed SyncStep2, with policy | First notice detaches; logical close shuts down dedicated socket; no retry or later local publication | `T18 malformed SyncStep2 with policy` |

The proxy independently parses server WebSocket frames before forwarding them, marking the first permanent stateless refusal (or close 1009). Its own ordered accept callback counts only connections accepted after that observation. T19 requires zero such accepts, checks `shouldConnect=false`, no scheduled reconnect, and absence from the socket's provider map after the completed close event. It then performs a real local edit and calls the real provider's `forceSync()`, requiring no outgoing frame on any socket. These causal assertions also run after deliberate rejoin. An honest transport retry before the first refusal passes with two total accepts and zero accepts after refusal. The defective policy reattaches and reconnects on close; the same checker rejects its accept after refusal. No interval of silence grants a pass.

The retained binary export is reapplied to an independent document and checked against literal `abcd` plus 3,145,728 `Z` characters, including terminal identity `11:3145727` and the complete decoded insertion intervals. The fresh rejoin checks all original identities `7:0..3`. The independent checker requires exact journal bytes for every accepted send and forbids exact rows and positive statuses for each refused send. For malformed and oversized inputs it independently checks decode failure or the declared byte bound. Rate dispositions are the fixture's literal first-50/next-150 declaration, using an injected clock rather than wall-clock scheduling. The aggregate-state case asserts the two distinct literal client/clock intervals and sizes independently; its matching pong and event-loop checkpoint place the second message's runnable hook work before release of the first commit gate.

## Library predictions

Previously confirmed facts are cited from [merged #1386](https://github.com/RetroGorilla/splitpage/pull/1386) and [its service evidence](../README.md#library-observations), rather than copied as new experiments.

| Row | Evidence and result |
| --- | --- |
| Y13 | New: `Y13 / H2: same-client gap`, `cross-client origin`, `delete before insertion`. Each sends the dependency-bearing update first, duplicates it, then supplies its prerequisite and observes a fresh late join. `inspectUpdateDependencies` exposes literal missing same-client clock, cross-client origin, and delete interval respectively using only exported decode APIs. Intermediate joins show `abcd`; final identities are explicit. This is evidence for these three cases, not a complete validator for every dependency topology. Pending updates remain journaled and replayable, not rejected as malformed. |
| Y15 | Existing #1386 `H2 / Y15: stock path acknowledges swallowed decode errors and pending dependencies`. New truncated-update refusal keeps that malformed payload away from live apply. No repeated stock-path experiment. |
| H2 | Existing covered/uncovered oversized SyncStep2 and swallowed-error evidence remains valid. New T18/T19 tests observe negative incremental and uncovered full-state statuses, and the malformed SyncStep2 closure. The policy does not interpret a positive status for already-covered content as acceptance of new refused work. |
| H3 | Existing #1386 T23 reset/early-zero tests. New T19 tests use actual FIFO statuses and override stale saved status after detachment; no provider count drives the policy. |
| H7 | Existing #1386 `H1 / H7: raw beforeSync blocks apply, receipt and peer fanout; onChange does not block them`. New malformed peer resync and fresh T19 rejoin verify unchanged live contents after refusal, followed by a valid peer commit. |
| H8 | New T19 first notices and 150 rate notices arrive through actual stateless events, with literal payload assertions. Async stateless-request ordering/barrier behavior is not claimed. |
| H9 | New malformed incremental test stays open with a negative status. Rate test receives 150 separate notices, proving read-only is reset between temporary refusals; otherwise only the first reaches the refusing hook. |
| H10 | Existing #1386 hook-exception test. New malformed incremental and oversize hooks return normally without exception; malformed SyncStep2 still closes in the library after that return. The prediction that every read-only refusal stays open needs this exception. |
| H11 | Existing #1386 T23 automatic initial-exchange facts. New restart test asserts that the refused actual outgoing message is subtype 1; post-detachment edit and `forceSync()` produce no frame. |
| H12 | New `H12: close leaves queued updates`: harness holds the first update before `beforeSync`, sends the second, and awaits a same-socket matching pong before marking the connection revoked and calling public `connection.close()`. Both queued updates still run and receive negative statuses; the injected revocation check prevents journal access. Another connection commits normally. This tests the public per-connection close and pre-sync recheck, not authentication or durable token revocation. A previously admitted journal transaction is not cancelled by this predicate. |
| H13 | New 20 MiB test observes close 1009, no hook entry for that frame, unchanged independently read rows, and a subsequent valid peer commit under a 4 MiB transport cap. Unauthenticated queue-count defaults are not separately tested. |

No prediction about the library is newly refuted. The malformed SyncStep2 exception was already recorded in #1386; this lane bounds it with a working detach policy and retains the failure. A supported reject-this-message result that skips both live application and `snapshotContainsUpdate` would be required to refuse arbitrary malformed SyncStep2 while leaving its logical connection open. No private library method is patched or replaced.

## Bounds and production hooks

The rate test freezes the injected clock to make every message fall inside the same one-second window; deadlines can only fail it. It proves a per-connection incremental rate boundary, not a deployment-wide byte/work quota. No image, awareness, authorization, origin, upload or pending-dependency quota is selected here. Y13's decoder inspection is diagnostic evidence and is not used to declare complete dependency validation. The disposable-state check and queue are prototype admission cost, with no performance claim.

Production needs: confirmed local-storage completion and hydration, current-device receipt coverage, ownership of a dedicated or multiplexed transport, a visible refusal reason and rejoin affordance, a standalone exporter over the retained local replica, invitation/version checks for a fresh rejoin, and a persistent revocation owner supplying the predicate. No hook in the real editor was added. Physical device durability, local storage failures, and recovery assets remain with their lanes.

## Reproduce

With Node 24.22.1 from `prototypes/collab/`:

```powershell
$env:TEMP='C:\Users\Gorbus\AppData\Local\Temp\splitpage-lanes\s1b-refusal'
$env:TMP=$env:TEMP
npm ci
node --test --test-concurrency=1 test/service/refusal/refusal.test.ts
npm test -- --test-concurrency=1
```

The refusal tests use free loopback ports, harness-owned proxies and temporary databases. Children, the in-process revocation server, writer workers, providers, documents, sockets, and folders are cleaned in `finally`. The full package tests only read retained browser evidence; no browser, app suite, or desktop suite is run. All polling deadlines throw. The revocation ping uses an aborting deadline; an elapsed timeout cannot prove queue arrival.

Validated on main base `e5b3306a`, Node 24.22.1: **893/893** package tests passed, including **17** refusal test records (16 subtests and the enforcing outer gate). The unchanged journal, ordering and review suites were also run explicitly with the refusal suite: **48/48** passed. Root lint, typecheck, comment and dependency gates passed: 80 prototype TypeScript files, 1,799 scanned comment-gate files, 1,507 dependency modules, zero runtime cycles and zero new exceptions. No baseline grew. The manual stale-candidate mutation was rejected and restored before these gates. No app, browser, desktop or performance suite was run, as required by the lane brief.

The review regression oracle first reproduced the completed rate retry stuck at sending despite all 200 inserted identities on the server and late joiner with zero outstanding receipts. Fixing receipt coverage alone then exposed the stale retry explanation; both causes are retained in `histories/T18-temporary-refusal-stuck.json`. The honest retry-before-refusal test also reproduced the original total-connection-count rejection before the proxy-ordering fix. No hand-written artifact 8 expectation changed.
