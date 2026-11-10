# Journal and receipt feasibility

This lane supports the write-ahead journal for the scoped update and receipt traces. It does not select the rest of Stage 1b. No schema, editor, admission, blob storage, local persistence, checkpoint, compaction, barrier or deployment code is included. The service commits each accepted raw update in one SQLite transaction inside `beforeSync`, before Hocuspocus applies or broadcasts it. Every writer reads back WAL and FULL before creating the journal table or accepting a write. Recovery replays raw rows in sequence.

The receipt tracker observes actual socket sends and incoming statuses through the provider's supported `WebSocketPolyfill` option. The provider's `outgoingMessage` event fires before its socket queue, so it cannot establish actual transmission. The tracker matches statuses FIFO within a socket lifetime, retains durable insertion and deletion ranges across reconnect, and treats a newer unsent local update as pending. It ignores receipts from old lifetimes. It never uses `unsyncedChanges` or `synced` as durability evidence. The three status strings here assume that a separate local-storage owner has already confirmed local persistence; this prototype does not establish local durability.

The harness independently records raw transmissions, statuses, local updates and every observed saved promise. After killing the exact child PID, it starts a new process against the same database, reads rows through its own read-only SQLite connection, and verifies acknowledged bytes and saved-promise coverage. A new client with an empty document verifies literal expected character identities. Its oracle uses Yjs snapshot coverage, separately from the receipt tracker's range coverage. Neither uses server diagnostic events to establish durability. Gates and hook events only control or inspect scheduling.

## Reproduce

From `prototypes/collab/`, with Node 24.22.1:

```powershell
$env:TEMP='C:\Users\Gorbus\AppData\Local\Temp\splitpage-lanes\s1b-journal'
$env:TMP=$env:TEMP
npm ci
npm test
node --test --test-concurrency=1 test/service/journal.test.ts
node src/service/measure-commit.ts $env:TEMP test/service/commit-cost.local.json
```

The service binds `127.0.0.1` on port 0 and reports its assigned port. Each fixture owns a temporary database and child-process handles; `finally` kills remaining children by PID and removes their folder. A failed startup is also cleaned. The deliberate defect runs first within the service trace group, and the group proceeds only after its checker has rejected the premature acknowledgement.

To rerun the disk measurement on the deployment server, run the same Node version and `npm ci` in this package, then `node src/service/measure-commit.ts /direct/pool/path /path/to/server-result.json`. The first argument must be an existing directory on the actual target volume. No network or server process participates in this SQLite commit-cost microbenchmark.

## Trace results

| Trace | Result and delivery | Failing history |
| --- | --- | --- |
| Deliberate Premature receipt / T22 | FAIL as required: acknowledgement sent while `beforeSync` is held before commit; hard kill loses `u1`; checker rejects | `histories/T22-premature-receipt.json` |
| T22 journal | PASS: `u1` acknowledged, duplicate delivery acknowledged, hard kill before any 2 s store hook; fresh process and empty client recover `abcde` with identities `7:0..3`, `11:0` | — |
| T23 (i) ordinary close | PASS: `u1` acknowledged, `u2` held unacknowledged, `u3` queued offline, `u4` typed on open; queued updates and initial SyncStep2 each require their own FIFO acknowledgement | — |
| T23 (ii) disconnect while connecting | PASS: queued `u3` discarded, initial SyncStep2 carries `u2/u3`; acknowledge it before typing `u4`, then acknowledge `u4` | — |
| T23 (ii) socket replacement | PASS under the same discarded-queue order | — |
| T23 (ii) early connection-check close | PASS: queue made while the socket is closing is discarded; initial SyncStep2 recovers it | — |
| T23 (ii) disconnect-null control | PASS: disconnect after ordinary close retains the queue; same three acknowledgements as T23 (i) | — |
| Pure delete from T14 / Y14 | PASS: `ud` removes original `b` without advancing the state vector; one new journal sequence and receipt; fresh process recovers `acde` with identities `7:0,2,3`, `11:0` | — |

T23's final literal is `abcdefgh`, identities `7:0..3`, `11:0..3`. Tests retain the prescribed offline, sending and saved wording. Every recovery has an empty late-joining client. There is no invented reordering of statuses: Hocuspocus's per-connection ordered message path supplies their order. T22 adds duplicate delivery explicitly. All expected fixture text and identities remain the hand-written artifact 8 values.

## Library observations

All rows below are confirmed by `test/service/journal.test.ts` and its `observations.ts` helper. No prediction was refuted and no expected result was changed.

| Row | Observed result |
| --- | --- |
| H1 | Raw bytes arrive in `beforeSync` while server and peer still show `abcd`; holding the hook prevents commit, apply, receipt and peer fanout. |
| H2 | Stock path acknowledges a swallowed corrupt-update error and an update waiting on a missing same-client clock. Read-only incremental refusal returns not-applied with the connection open. A malformed read-only SyncStep2 throws inside Hocuspocus's snapshot check and closes the logical connection. |
| H3 | Sync starts reset the provider counter to 1. With 400 ms hook delay, the ordinary-close and control traces observe count 0 with a message still unacknowledged; the application status stays sending. |
| H4 | Ordinary close and disconnect with a null socket keep queued updates. Disconnect with a connecting socket, replacement and the connection checker's early close discard them. Reconnect's SyncStep2 recovers the lost queue contents. |
| H5 | Store failures are logged and swallowed; the document remains in memory. The journal receipt remains durable independently of that store. |
| H6 | The normal store promise resolves after scheduling, before the store starts. `flushPendingStores()` returns undefined before a held store finishes. The immediate store promise waits, then resolves even after a logged store failure. |
| H7 | A held asynchronous `onChange` does not prevent receipt or peer fanout. The awaited `beforeSync` gate does. |
| H10 | An injected hook exception closes the connection and sends no positive receipt. Validation refusals return normally from our hook; the malformed SyncStep2 closure originates in the library. |
| H11 | Each reconnect sends its own initial SyncStep2 containing `u2/u3`, including after discarded queues; queued incremental messages can precede it. No application filter was invoked. |
| Y14 | A pure delete leaves the state vector unchanged; journal sequence and deletion-range receipt coverage still advance. |
| Y15 | The stock incremental path logs and swallows the truncated update's apply error, then Hocuspocus acknowledges it. |

Invalid and oversized updates, injected writer refusal, hook exceptions and malformed SyncStep2 all produce no journal row or positive receipt. A transaction-level SQLite trigger also proves that a failed multi-update transaction rolls back its earlier insert. These checks do not implement the next lane's permanent-rejection/rejoin policy. In particular, that lane must account for the library's malformed SyncStep2 close behavior; these observations do not claim a reconnect-loop solution.

## Local commit cost

Measured on this PC's **C: NTFS disk**, not the deployment disk, on 2026-11-10 UTC, Node 24.22.1, SQLite 3.53.4, Windows x64. Raw results: `test/service/commit-cost.local.json`. The Node SQLite API is [stability 1.2, release candidate](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html).

| Workload | Updates / transaction | Updates measured | Transaction ms p50 / p95 / max | Amortized commit ms / update p50 / p95 / max |
| --- | --- | --- | --- | --- |
| Typing, one update each 100 ms | 1 | 150 | 0.8851 / 1.0767 / 2.7717 | 0.8851 / 1.0767 / 2.7717 |
| Burst, no deliberate interval | 1 | 3000 | 0.5428 / 0.6787 / 4.9420 | 0.5428 / 0.6787 / 4.9420 |
| Typing, one update each 100 ms | 5 | 150 | 1.0191 / 4.8282 / 4.8459 | 0.2038 / 0.9656 / 0.9692 |
| Burst, no deliberate interval | 5 | 3000 | 0.5709 / 0.7018 / 5.0754 | 0.1142 / 0.1404 / 1.0151 |

Each row pools three fresh databases. Each repetition has 50 single-character Yjs updates for typing, or 1000 for burst; updates are 10–12 bytes. Fixed batches store five distinct raw updates in one transaction without merging their bytes. Timing covers BEGIN IMMEDIATE, inserts and FULL COMMIT, excluding encoding and batch wait. Auto-checkpointing is disabled for the microbenchmark and databases are removed after closing; no checkpoint runs within a timed region. Typing batches add up to 400 ms nominal waiting before commit, in addition to the numbers above. These are commit costs, not end-to-end receipt latency or a power-loss experiment.

The service selects **one update per transaction**. A single Hocuspocus connection awaits each `beforeSync`, so a hook cannot wait for five subsequent messages on that same connection to form a batch. The five-update rows measure writer cost only; they do not prove a batching integration. A deployment-volume rerun remains required. No real-editor hooks were needed for this lane; integration needs local-storage completion, local-update registration and socket lifetime/send/status observation.
