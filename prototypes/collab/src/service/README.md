# Journal and receipt feasibility

This lane supports the write-ahead journal for the scoped update and receipt traces. It does not select the rest of Stage 1b. No schema, editor, admission, blob storage, local persistence, checkpoint, compaction, barrier or deployment code is included. The service commits each accepted raw update in one SQLite transaction inside `beforeSync`, before Hocuspocus applies or broadcasts it. One worker owns the service's sole writable SQLite connection; the hook awaits that worker's commit. The worker reads back WAL and FULL before creating the journal table or accepting a write. Its prototype busy timeout is 15,000 ms, so an independently held write lock blocks the commit without blocking the server's transport event loop. Recovery reads raw rows through the same worker and replays them in sequence on the server.

The receipt tracker observes actual socket sends and incoming statuses through the provider's supported `WebSocketPolyfill` option. The provider's `outgoingMessage` event fires before its socket queue, so it cannot establish actual transmission. The tracker matches statuses FIFO within a socket lifetime, retains durable insertion and deletion ranges across reconnect, and treats a newer unsent local update as pending. It ignores receipts from old lifetimes. It never uses `unsyncedChanges` or `synced` as durability evidence. The three status strings here assume that a separate local-storage owner has already confirmed local persistence; this prototype does not establish local durability.

The required property is that a positive acknowledgement covers every insertion and deletion in its message in journal rows committed before the server acknowledges. The tests establish recovered-byte coverage and the bounded write-lock observation described below; receiving a receipt does not reveal when it was sent. The history checker requires exact recovered bytes for messages declared accepted by the fixture. Refused messages carry literal reasons: over the configured size, or undecodable. The harness verifies that reason against the sent bytes using its own size/decode check. For a refused positive receipt it independently decodes insertion/deletion intervals and requires coverage already present in its own pre-transmission journal baseline; later rows cannot supply that fixture's coverage. It never uses `snapshotContainsUpdate`. Server notices are recorded only as observations to check against the declared disposition; a contradictory notice fails history and never selects a weaker rule. Saved promises are checked against independently decoded acknowledged messages. Empty late joins verify literal expected character identities after recovery.

The ordering experiment holds `BEGIN IMMEDIATE` on the harness's own database connection and verifies that a competing writer gets `database is locked`. It sends the accepted update and waits for the hook-entry scheduling event, then sends a WebSocket control ping on that same socket. The harness freezes the preceding status-frame prefix at the matching pong. For the executions tested, an empty prefix establishes no acknowledgement through that pong while the harness holds the write lock. Unlock is followed by an acknowledgement and a hard kill; recovered histories establish that the exact bytes are present after that kill. The original premature receipt and the acknowledge/wait-20-ms/commit mutation are rejected. The reviewer also confirmed rejection of the zero-wait early-ack mutation. Application receipt handling is delayed 250 ms in the probe, but that delay does not decide its verdict. Hook diagnostics schedule the probe, not its commit or disposition evidence.

**Accepted limit:** neither the frozen pong prefix nor recovered histories proves status/commit ordering inside the window between the writer acquiring its lock and `COMMIT` returning. A worker that waits for unlock, signals the server to send a positive status, and then commits is **not detected by this harness**: the early status falls after the frozen prefix, and the exact row exists after recovery. This mutation is retained in `histories/ordering-after-unlock-ack.json`; the limit is stated rather than closed by another gate.

That window instead rests on the normal code chain: Hocuspocus 4.8.0 [awaits `beforeSync`](https://github.com/ueberdosis/hocuspocus/blob/74c12e670324f7659f7d905df28736a82be0ec9d/packages/server/src/MessageReceiver.ts#L207) before its [positive update status](https://github.com/ueberdosis/hocuspocus/blob/74c12e670324f7659f7d905df28736a82be0ec9d/packages/server/src/MessageReceiver.ts#L295); the server [awaits the worker append](server-process.ts#L80); the worker's [normal append call](journal-worker.ts#L25) runs [BEGIN, inserts and COMMIT synchronously](journal.ts#L27), and [posts its reply](journal-worker.ts#L29) only after [`COMMIT` returns](journal.ts#L32). That is a code property a review must keep, not a tested one. The explicit early-ack mutation path breaks that chain for the retained experiment.

The worker client retains its terminal error after exit. Later requests reject before the next event-loop turn; the integration test requires a negative status, no journal write, no apply and no peer fanout for an update sent after that exit.

New prototype-only development dependencies: `ws` 8.22.2 supplies the public client `ping`/`pong` API, which Node's native browser-compatible WebSocket lacks; `@types/ws` 8.18.2 supplies its strict types. The existing native-WebSocket provider traces and socket-limit observations remain on their original transport. SQLite remains Node's built-in module.

## Reproduce

From `prototypes/collab/`, with Node 24.22.1:

```powershell
$env:TEMP='<temp>/splitpage-lanes/s1b-journal'
$env:TMP=$env:TEMP
npm ci
npm test
node --test --test-concurrency=1 test/service/journal.test.ts
node --test --test-concurrency=1 test/service/ordering.test.ts
node test/service/measure-ack-kill.ts 200
node src/service/measure-commit.ts $env:TEMP test/service/commit-cost.local.json
```

The service binds `127.0.0.1` on port 0 and reports its assigned port. Each fixture owns a temporary database and child-process handles; `finally` kills remaining children by PID and removes their folder. A failed startup is also cleaned. The deliberate defect runs first within the service trace group, and the group proceeds only after its checker has rejected the premature acknowledgement.

To rerun the disk measurement on the deployment server, run the same Node version and `npm ci` in this package, then `node src/service/measure-commit.ts /direct/pool/path /path/to/server-result.json "DEPLOYMENT DISK: describe volume and mount"`. The first argument must be an existing directory on the actual target volume. The optional third argument labels the report's `scope`; omitting it preserves the original `LOCAL PC DISK ONLY; deployment disk has not been measured` default. No network or server process participates in this SQLite commit-cost microbenchmark.

## Trace results

| Trace | Result and delivery | History / evidence |
| --- | --- | --- |
| Deliberate Premature receipt / T22 | FAIL as required: acknowledgement sent while `beforeSync` is held before commit; hard kill loses `u1`; checker rejects | `histories/T22-premature-receipt.json` |
| T22 journal | PASS: `u1` acknowledged, duplicate delivery acknowledged, hard kill before any 2 s store hook; fresh process and empty client recover `abcde` with identities `7:0..3`, `11:0` | — |
| T23 (i) ordinary close | PASS: `u1` acknowledged, `u2` held unacknowledged, `u3` queued offline, `u4` typed on open; queued updates and initial SyncStep2 each require their own FIFO acknowledgement | — |
| T23 (ii) disconnect while connecting | PASS: queued `u3` discarded, initial SyncStep2 carries `u2/u3`; acknowledge it before typing `u4`, then acknowledge `u4` | — |
| T23 (ii) socket replacement | PASS under the same discarded-queue order | — |
| T23 (ii) early connection-check close | PASS: queue made while the socket is closing is discarded; initial SyncStep2 recovers it | — |
| T23 (ii) disconnect-null control | PASS: disconnect after ordinary close retains the queue; same three acknowledgements as T23 (i) | — |
| Pure delete from T14 / Y14 | PASS: `ud` removes original `b` without advancing the state vector; one new journal sequence and receipt; fresh process recovers `acde` with identities `7:0,2,3`, `11:0` | — |
| Review: covered oversized SyncStep2 | PASS after the original checker's recorded failure: 2,200,025-byte snapshot refused, positive status, journal remains at three rows, all insertion coverage already durable; accepted-message classification still requires exact bytes | `histories/review-covered-syncstep2.json` retains the original failure |
| Review: uncovered oversized SyncStep2 | PASS for insertion and pure deletion: no positive receipt or new row; checker rejects forged positive receipts even if a later row would supply coverage | — |
| Review: socket size limit, covered state | PASS: close 1009 before `beforeSync`; automatic reconnect sends a small difference and returns to saved status | — |
| Review: socket size limit, uncovered state | Reconnect loop observed: three automatic closes with code 1009, no new row or receipt; offline local status after each close; read-only default retained | `histories/review-socket-limit-loop.json` |
| Review: acknowledgement before IPC refusal | PASS: hold IPC refusal delivery until after the WebSocket acknowledgement; await both channels explicitly while preserving all assertions and literal outcomes | `histories/review-ipc-order.json` retains the reproduced race |
| Independent write-lock gate | PASS: own write lock and competing-writer check, same-socket pong with no preceding update status, unlock, acknowledgement and exact recovered row | `histories/ordering-journal.json` |
| Write-lock gate: original premature receipt | FAIL as required: positive status precedes pong while commit is impossible; kill leaves only the seed row | `histories/ordering-premature.json` |
| Write-lock gate: acknowledge, wait, commit | FAIL as required: positive status precedes pong while locked, although the later commit survives recovery; delayed receipt handling cannot conceal it | `histories/ordering-ack-wait-commit.json` |
| Write-lock gate: acknowledgement after unlock, before COMMIT | NOT DETECTED BY THIS HARNESS: empty frozen prefix, later exact recovered row; accepted limit, not a passing ordering proof | `histories/ordering-after-unlock-ack.json` |
| False refusal notice for accepted combined snapshot | FAIL as required: literal acceptance stays accepted; contradictory notice fails, missing exact bytes also fail without the notice, and a false oversize declaration fails independent size validation | `histories/review-false-refusal.json` |
| Post-exit append | PASS: immediate rejected promise and negative status without applying, broadcasting or journal writing | `test/service/worker-exit.test.ts` |
| Probabilistic acknowledgement/kill, honest | 200/200 exact rows recovered; no loss observed in this sample; cannot establish commit/status ordering | `test/service/ack-kill.local.json` |
| Probabilistic acknowledgement/kill, after-unlock mutation | 97/200 missing exact rows: measured detection 48.5%; 103/200 escaped this probabilistic check | `histories/probabilistic-ack-kill-after-unlock-ack.json` and the same result file |

T23's final literal is `abcdefgh`, identities `7:0..3`, `11:0..3`. Tests retain the prescribed offline, sending and saved wording. Every recovery has an empty late-joining client. There is no invented reordering of statuses: Hocuspocus's per-connection ordered message path supplies their order. T22 adds duplicate delivery explicitly. All expected fixture text and identities remain the hand-written artifact 8 values.

Ubuntu CI at `4795eff` exposed a test synchronization race: the covered-snapshot test immediately asserted the child-process IPC refusal event after receiving the WebSocket acknowledgement. The two channels have no shared delivery order, so the acknowledgement could be observed first. The test now awaits the IPC event separately, with the original refusal assertion unchanged. The same fixture runs under normal delivery and a controlled acknowledgement-before-IPC delivery; the latter reproduced the original assertion failure on Windows before the wait was added. This is a cross-channel timing assumption, not different receipt semantics on Linux. The CI gate failure was downstream of this single test failure.

## Wait audit

All condition polls have throwing deadlines: server ready/exit, IPC replies and hook/store scheduling, socket open/close/reconnect, acknowledgement arrival, saved status and peer content. Reaching a deadline never establishes absence or success. Every negative observation follows an explicit gate, completed event or the ordered pong. The pong/open promises reject if their deadline is missed. A late busy timeout can cause a negative status or missed pong and fail the gate test; it cannot count as a successful commit.

The 50 ms reconnect setting only accelerates the existing socket-limit experiment. Its poll must observe three real closes; a missed deadline throws. If stopping late records an extra close, the literal three-close assertion fails. The 400 ms hook delay, 20 ms mutation delay and 250 ms application-handler delay inject scheduling or faulty behavior, not success criteria. The benchmark's 100 ms intervals generate the workload. No sleep or deadline grants a passing no-acknowledgement result; the write-lock test requires an actual matching same-socket pong. The probabilistic loop's receipt timeout only fails an iteration; success requires recovered exact bytes in every honest iteration.

## Probabilistic kill check

One local run performed 200 honest iterations and 200 after-unlock mutation iterations in 78.6 seconds on Windows, Node 24.22.1. Each iteration starts a fresh child process and database, sends one full accepted `abcde` update, requests `SIGKILL` directly in the first positive WebSocket status-frame callback, waits for exit, then independently reads the recovered SQLite journal. Every honest iteration must contain the exact sent bytes; any miss fails the command. There is no honest-path timing window that can grant a pass. Kill latency and scheduling make this a **probabilistic check**, not an ordering proof. The mutation sends its status after obtaining the writer lock and inserting, but before being told to commit; no extra delay is inserted into that window. It was detected 97/200 times (48.5%), and not detected 103/200 times. Those are the measured counts, not a required mutation detection threshold. Raw results and rerun method are in `test/service/ack-kill.local.json` and `test/service/measure-ack-kill.ts`; the hundreds-iteration loop is manual, outside the default test suite.

## Library observations

All rows below are confirmed by `test/service/journal.test.ts`, its `observations.ts` helper, and `test/service/review.test.ts`. No prediction was refuted and no hand-written expected result was changed. The review tests correct the earlier overstatement of H2 and the checker's exact-byte requirement for refused messages.

| Row | Observed result |
| --- | --- |
| H1 | Raw bytes arrive in `beforeSync` while server and peer still show `abcd`; holding the hook prevents commit, apply, receipt and peer fanout. |
| H2 | Stock path acknowledges a swallowed corrupt-update error and an update waiting on a missing same-client clock. Read-only incremental refusal returns not-applied with the connection open. Read-only SyncStep2 returns applied when its content is already present, including oversized snapshots refused by our hook; snapshots with an uncovered insertion or deletion return not-applied. A malformed read-only SyncStep2 throws inside Hocuspocus's snapshot check and closes the logical connection. |
| H3 | Sync starts reset the provider counter to 1. With 400 ms hook delay, the ordinary-close and control traces observe count 0 with a message still unacknowledged; the application status stays sending. |
| H4 | Ordinary close and disconnect with a null socket keep queued updates. Disconnect with a connecting socket, replacement and the connection checker's early close discard them. Reconnect's SyncStep2 recovers the lost queue contents. |
| H5 | Store failures are logged and swallowed; an empty late-joining client independently receives literal `abcd` from the retained document after failure. The journal receipt remains durable independently of that store. |
| H6 | The normal store promise resolves after scheduling, before the store starts. `flushPendingStores()` returns undefined before a held store finishes. The immediate store promise waits, then resolves even after a logged store failure. |
| H7 | A held asynchronous `onChange` does not prevent receipt or peer fanout. The awaited `beforeSync` gate does. |
| H10 | An injected hook exception closes the connection and sends no positive receipt. Validation refusals return normally from our hook; the malformed SyncStep2 closure originates in the library. |
| H11 | Each reconnect sends its own initial SyncStep2 containing `u2/u3`, including after discarded queues; queued incremental messages can precede it. No application filter was invoked. |
| Y14 | A pure delete leaves the state vector unchanged; journal sequence and deletion-range receipt coverage still advance. |
| Y15 | The stock incremental path logs and swallows the truncated update's apply error, then Hocuspocus acknowledges it. |

The tested invalid or oversized incremental updates, injected writer refusal, hook exceptions and malformed SyncStep2 produce no journal row or positive receipt. Oversized SyncStep2 is refused before the journal write, but the library still decodes and compares it: already-covered content gets a positive receipt; the counter-cases with an uncovered insertion or deletion get a negative one. A transaction-level SQLite trigger also proves that a failed multi-update transaction rolls back its earlier insert.

The socket-limit experiment sets `websocketOptions.maxPayload` to 2,097,152 bytes, measured over the entire frame. Oversized frames never reach `beforeSync`; the native Node client observes close 1009 with an empty reason and `Offline, saved on this device`. For already-committed content, automatic reconnect exchanges a small difference and reaches `Your changes saved to server`. For an uncommitted 2.2 MB local insertion, initial SyncStep2 resubmits the oversized update on every reconnect: three consecutive connections close with 1009, with no new journal row or positive receipt. The experiment compresses retry delay/minimum to 50 ms and stops after the third close; it does not repair the loop. `MAX_PAYLOAD` is an opt-in test setting; the service keeps the read-only path by default. The refusal/rejoin lane must account for this loop and the malformed SyncStep2 logical close. These checks do not implement permanent-rejection/rejoin policy.

## Local commit cost

Measured on this PC's **C: NTFS disk**, not the deployment disk, on 2026-11-10 UTC, Node 24.22.1, SQLite 3.53.4, Windows x64. Raw results: `test/service/commit-cost.local.json`. The Node SQLite API is [stability 1.2, release candidate](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html).

| Workload | Updates / transaction | Updates measured | Transaction ms p50 / p95 / max | Amortized commit ms / update p50 / p95 / max |
| --- | --- | --- | --- | --- |
| Typing, one update each 100 ms | 1 | 150 | 0.8851 / 1.0767 / 2.7717 | 0.8851 / 1.0767 / 2.7717 |
| Burst, no deliberate interval | 1 | 3000 | 0.5428 / 0.6787 / 4.9420 | 0.5428 / 0.6787 / 4.9420 |
| Typing, one update each 100 ms | 5 | 150 | 1.0191 / 4.8282 / 4.8459 | 0.2038 / 0.9656 / 0.9692 |
| Burst, no deliberate interval | 5 | 3000 | 0.5709 / 0.7018 / 5.0754 | 0.1142 / 0.1404 / 1.0151 |

Separate reviewer-measured worker overhead: **about 0.040 ms median and 0.073 ms at the 95th percentile over 300 updates**. Source: the coordinator's second re-check message for PR #1386 at head `e5bc47c`, supplied from the reviewer's measurement. This lane did not rerun that measurement. It is distinct from the transaction commit costs above.

Each row pools three fresh databases. Each repetition has 50 single-character Yjs updates for typing, or 1000 for burst; updates are 10–12 bytes. Fixed batches store five distinct raw updates in one transaction without merging their bytes. Timing covers BEGIN IMMEDIATE, inserts and FULL COMMIT, excluding encoding and batch wait. Auto-checkpointing is disabled for the microbenchmark and databases are removed after closing; no checkpoint runs within a timed region. Typing batches add up to 400 ms nominal waiting before commit, in addition to the numbers above. These retained measurements exercise the unchanged synchronous transaction body directly; they exclude the subsequently added worker message round trip. They are commit costs, not end-to-end receipt latency or a power-loss experiment.

The service selects **one update per transaction**. A single Hocuspocus connection awaits each `beforeSync`, so a hook cannot wait for five subsequent messages on that same connection to form a batch. The five-update rows measure writer cost only; they do not prove a batching integration. The deployment disk has now been measured below; other deployment volumes still need their own measurements. No real-editor hooks were needed for this lane; integration needs local-storage completion, local-update registration and socket lifetime/send/status observation.

## Deployment disk commit cost

The coordinator ran the unchanged measurement script from `origin/main` at `d4eb17bd` on the Unraid server, back to back in the order cache-1, user-1, cache-2, user-2, on 2026-11-10 approximately 04:06–04:12 UTC. These are supplied measurements, not a remote run by this lane. The environment was one Crucial MX500 1 TB SATA SSD, btrfs single profile with `noatime,ssd,discard=async`; kernel `6.18.58-Unraid`, x64, 12 threads and 30 GB RAM. A one-off Ubuntu noble Docker container had 2 CPUs and a 2 GB memory limit, Node 24.22.1 from nodejs.org with its checksum verified, `npm ci --omit=dev`, and SQLite 3.53.4. The live home server had other containers and was not isolated; load average was 0.21 before and 0.66 after.

The direct cache path `/mnt/cache/appdata/...` was mounted at `/data-cache`. The same folder through Unraid's `/mnt/user/appdata/...` FUSE (`shfs`) path was mounted at `/data-user`; that is the path a default Unraid container template would mount. The four raw files under `test/service/` are byte-for-byte copies of the supplied results. Their `scope` field still says `LOCAL PC DISK ONLY; deployment disk has not been measured`: that was the script's then-fixed label, not the scope of these runs. Their `directory`, `platform` (`linux`) and `osRelease` (`6.18.58-Unraid`) identify the run, with the container-to-host path mapping supplied above.

The workload and timing boundaries are those in the local measurement method above: each row pools three fresh databases within that run, with 150 typing updates or 3000 burst updates, 10–12 bytes each. Rounds remain separate. All table values are milliseconds, shown as **p50 / p95 / max**; batch size is the number of distinct raw updates stored in one transaction. Typing emits one update after each 100 ms delay; bursts have no deliberate interval. Timing includes BEGIN IMMEDIATE, inserts and FULL COMMIT, excludes encoding, batch waiting and worker IPC, and disables automatic WAL checkpointing. Closing and cleanup happen outside the timed regions.

### Direct cache pool path

Raw results: [round 1](../../test/service/commit-cost.unraid-cache.round-1.json) (report completed 04:08:01.741 UTC) and [round 2](../../test/service/commit-cost.unraid-cache.round-2.json) (04:10:57.688 UTC).

| Round | Workload | Updates / transaction | Transaction ms p50 / p95 / max | Amortized commit ms / update p50 / p95 / max |
| --- | --- | --- | --- | --- |
| 1 | Typing | 1 | 8.8208 / 10.1829 / 12.4284 | 8.8208 / 10.1829 / 12.4284 |
| 1 | Burst | 1 | 8.0509 / 10.4187 / 217.9055 | 8.0509 / 10.4187 / 217.9055 |
| 1 | Typing | 5 | 10.2767 / 11.9339 / 44.4500 | 2.0553 / 2.3868 / 8.8900 |
| 1 | Burst | 5 | 68.2134 / 92.7027 / 772.9672 | 13.6427 / 18.5405 / 154.5934 |
| 2 | Typing | 1 | 8.3322 / 9.2634 / 10.0971 | 8.3322 / 9.2634 / 10.0971 |
| 2 | Burst | 1 | 8.6437 / 44.0999 / 715.8849 | 8.6437 / 44.0999 / 715.8849 |
| 2 | Typing | 5 | 10.5312 / 11.3289 / 12.2711 | 2.1062 / 2.2658 / 2.4542 |
| 2 | Burst | 5 | 7.3998 / 8.3641 / 9.2935 | 1.4800 / 1.6728 / 1.8587 |

### Unraid user share path (FUSE)

Raw results: [round 1](../../test/service/commit-cost.unraid-user.round-1.json) (report completed 04:09:37.344 UTC) and [round 2](../../test/service/commit-cost.unraid-user.round-2.json) (04:12:19.599 UTC).

| Round | Workload | Updates / transaction | Transaction ms p50 / p95 / max | Amortized commit ms / update p50 / p95 / max |
| --- | --- | --- | --- | --- |
| 1 | Typing | 1 | 8.5619 / 9.7468 / 14.4358 | 8.5619 / 9.7468 / 14.4358 |
| 1 | Burst | 1 | 8.9944 / 44.8379 / 442.4210 | 8.9944 / 44.8379 / 442.4210 |
| 1 | Typing | 5 | 13.2255 / 50.4934 / 125.4468 | 2.6451 / 10.0987 / 25.0894 |
| 1 | Burst | 5 | 9.2561 / 12.2472 / 18.6125 | 1.8512 / 2.4494 / 3.7225 |
| 2 | Typing | 1 | 9.7169 / 12.2895 / 14.8783 | 9.7169 / 12.2895 / 14.8783 |
| 2 | Burst | 1 | 8.7603 / 43.7443 / 893.1075 | 8.7603 / 43.7443 / 893.1075 |
| 2 | Typing | 5 | 10.2259 / 11.7921 / 18.6649 | 2.0452 / 2.3584 / 3.7330 |
| 2 | Burst | 5 | 8.5674 / 10.8879 / 397.6295 | 1.7135 / 2.1776 / 79.5259 |

One-update FULL commits have medians of about 8–10 ms on both paths, versus 0.5–0.9 ms in the retained PC measurement. One-update typing p95 is 9.2634–12.2895 ms. The one-update burst p95 is about 44 ms in three runs and 10.4187 ms in cache round 1; maxima span 217.9055–893.1075 ms. The cause of this tail was not measured. These runs do not distinguish storage, filesystem, FUSE, container scheduling or other server activity as causes, and do not establish a performance difference between the two paths.

Serial one-update commits consume the single writer's time and bound burst throughput. The reciprocal of the observed burst median costs corresponds to roughly 111–124 updates/s at median cost alone, not a measured sustained throughput; the long tail consumes additional time. The reports retain percentiles rather than elapsed totals, so they cannot establish a sustained updates/s rate. Fixed batches of five amortize the commit across five updates: median costs are 1.4800–2.6451 ms/update in seven of eight rows. The exception is cache round 1's burst at 68.2134 ms/transaction (13.6427 ms/update), not reproduced in round 2. Batching did not consistently improve this sample. At the nominal typing rate, forming five-update batches also adds up to 400 ms of waiting before commit. These measurements do not implement batching or alter the service's one-update receipt design.

This is commit cost on one deployment disk, not end-to-end receipt latency, a test isolated from other server load, or evidence of persistence after power loss. Similar timings through FUSE do not validate its SQLite WAL correctness or durability. The receipt still depends on the reviewed commit-before-status code property and its stated test limits above; the benchmark adds no ordering or durability proof.
