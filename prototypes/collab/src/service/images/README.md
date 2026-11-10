# Stage 1b images: T16 and T19 (c)

Both image designs can keep the tested server-save promise truthful. They pay different costs; this report selects neither. M3 passes the literal upload-before-sync row, including keeping gP and later Z out of network document N. A one-document transport gate also keeps both out of every transmitted update and the server through reconnect, but its provider document already contains them. It therefore fails the row's literal separate-N condition. That distinction is retained in [T16-one-document-N.json](../../../histories/T16-one-document-N.json), rather than changing the oracle.

The one-document result matters to M2: a second document is not necessary solely to prevent publication of an image reference before upload, if a configured transport gate is an acceptable integration boundary. It remains necessary if N must itself exclude held edits. The decision about that boundary belongs to the coordinator. Neither design is a production implementation or an approved invariant change. No app code changes.

## Minimal model and integration

`publication.ts` uses `Y.Text("R1")` and a `Y.Map("gallery")` containing one atomic literal item `{id: "gP", beat: "R1", ref: sha256, pending: boolean}`. The initial text is `ab`, identities `7:0`, `7:1`. Adding the item consumes `11:0`; subsequent Z is `11:1`. Bytes stay outside Yjs. The upload-first item has `pending: false`; the pending-image item initially has `pending: true`, then a new map value clears it after the upload acknowledgement. This is the smallest model for these rows, not a selected gallery schema.

`service.ts` is an opt-in Hocuspocus extension plus a second HTTP listener on a free loopback port. `PUT /api/images/fixture/<sha>` accepts PNG bytes; `GET` requires a membership row. The fixed `fixture` instance and unauthenticated loopback endpoint are experiment scope. Invitation admission, HTTP revocation and arbitrary-instance authorization are not implemented.

`store-worker.ts` runs inside the server process. It verifies the supplied SHA-256 and 16 MiB limit before opening a temporary file, checks the PNG signature/IHDR dimensions, writes and fsyncs the file, renames it to its hash, rereads and verifies its bytes, then commits the membership row. Membership lives in the **same SQLite database** as `updates`, through another connection with WAL and `synchronous=FULL`, checked at startup. Only the completed COMMIT produces the normal HTTP 201. File-first ordering can leave an unreferenced file after a crash; a membership row must never precede its file. This tests process-kill recovery, not power-loss durability of directory metadata. PNG header checks are not a full image decoder. Retention budgets, concurrent-upload quotas, orphan collection and production image validation remain unimplemented.

The image extension evaluates a candidate document before the existing journal hook. A nonpending reference without membership gets `{retryAfter: sha, permanent: false}` and read-only for this message. `afterHandleMessage` clears that temporary flag. Pending references can be journaled while their bytes are absent. Candidate decoding/projection copies the document on each update; its memory/CPU cost is not benchmarked here.

## What each design costs

| Concern | Upload-before-sync, one document | Upload-before-sync, M3 | Pending-image |
| --- | --- | --- | --- |
| Editing and provider documents | One Y.Doc; E and provider.document are the same | E contains local work; provider holds separate N | One Y.Doc |
| Hold | Configured `WebSocketPolyfill` drops outbound update and SyncStep2 frames while a required membership is missing. SyncStep1/control traffic and inbound integration continue | E-to-N bridge holds the image and all subsequent local updates. N continues receiving remote updates, forwarded to E | None; item and Z synchronize immediately |
| What is retained | Complete E and local image bytes; discarded frames are regenerated from E | Complete E, N and local image bytes; origin filtering prevents echo and excludes inbound work from local receipt obligations | Complete document with pending flag, local image bytes and retry obligation |
| Resume | After upload, `forceSync()` regenerates the missing state; waits for its receipt | Release E's difference into N, then `forceSync()`; waits for actual transmitted messages | Upload, clear pending in a new shared update, then wait for its covering receipt |
| Literal T16 N clause | Fails: provider.document already contains gP/Z. Wire/server condition passes | Passes | No N hold is required |
| Peer before upload | Old script, with neither picture nor later Z | Same | Z and a picture placeholder |
| If uploader never returns before upload | Held work stays only on that device; peers retain old script | Same; E and N differ on that device | Peers retain Z and the placeholder, even after server restart. Export explicitly lists the missing image |
| Reload during upload | Restore E, local bytes and prior receipt coverage; install gate before provider attach | Restore E and N, local bytes and prior receipt coverage, then rebuild bridge before attach | Restore pending item, text, bytes, prior receipt coverage and retry obligation before attach |
| Extra mechanism code | `allow`, `imageSocket`, resync trigger | Second Y.Doc, `inbound`/`outbound`, origin classification, dual capture, release difference | Pending-flag transition, placeholder and missing-image export projection |

All three paths use the same blob service, HTTP upload and `ConnectionReceipts`. The provider counter still counts attempted updates that the socket gate suppresses; it cannot determine saved status. Receipt tracking observes **actual** WebSocket sends, registers local E edits, and leaves held/refused ranges uncovered until a real covering receipt. M3 excludes N-to-E bridge updates from those local obligations. A reload must restore previously acknowledged coverage as well: the server's new SyncStep2 response contains only the missing difference and does not reacknowledge all older local clocks. Removing `restoreAcknowledged` makes both upload-first reload tests and the pending reload test fail. Its input here is the persisted set of actual positive receipts from this same instance; it is not permission to reuse receipts after instance replacement.

Local byte storage is a Map and the reload fixture writes/reads a combined JSON capture. The tests prove capture/restoration requirements and hash verification, not browser/desktop transaction completion or local crash durability. The separate local-storage owner must commit bytes before a document reference and persist the capture plus receipt bookkeeping atomically. M3's real two-store crash window belongs to STORE; it is not closed by this JSON test. Existing local-save wording is exercised under that explicit completion precondition.

## Independent evidence

All deciding tests are in `test/service/images/images.test.ts`, with the independent harness in `harness.ts`. The enforcing outer test awaits and requires rejection of all three deliberate defects before registering honest traces. Each actual transmitted document frame consumes a literal harness-declared disposition. The harness records **every** outgoing frame as bytes with socket lifetime, and independently reads SQLite membership at each document send. A server notice cannot choose acceptance/refusal for the checker.

For upload holds, the harness closes the pre-membership upload gate, independently confirms that membership is absent, reconnects the real provider, observes its attempted SyncStep2, then sends a stateless fence on that same socket. The synchronous fence echo follows the preceding awaited sync work. At that fence, the harness's full outgoing-frame record and its own journal read contain no client-11 struct, including dependency-buffered data that a text-only projection could miss. M3's N is independently checked too. Upload release, observed HTTP 201 and a fresh membership read precede releasing document synchronization. A separately held covering journal message proves saved status does not advance merely because upload finished. There is no silence interval or elapsed wait that can grant a pass.

Text is checked by the existing `IdentityBook`/`checkModel` checker against handwritten `ab` / `abZ`, identities, empty marks and empty recovery. Expected text never comes from the production decoder. The additional inbound experiment checks literal `abZX` and identities `7:0`, `7:1`, `11:1`, `22:0` on the editor and independently replayed journal.

| Trace / test | Result and delivery |
| --- | --- |
| Deliberate premature gallery save, each design | Rejected. Disable the outgoing hold/server missing-blob guard and substitute receipt-only saved status; a real positive gallery receipt cannot satisfy independently absent membership. Histories: [upload-first](../../../histories/T16-upload-before-sync-premature.json), [pending](../../../histories/T16-pending-image-premature.json) |
| Deliberate upload acknowledgement before COMMIT | Rejected. HTTP 201 arrives while the harness leaves the membership gate closed; hard kill leaves the hash file but no membership. The same recovered-membership checker used for honest acknowledgements rejects it. [History](../../../histories/T16-upload-before-membership.json) |
| `blob upload: hash/size/header refusal before storage, duplicate and 2 MiB upload survive immediate hard kill` | Pass. Wrong hash, invalid PNG header and 16 MiB + 1 refuse with no file/row. Duplicate upload is idempotent. Acknowledged tiny and 2 MiB payloads have recovered membership, exact size and independently recomputed SHA-256; a new child serves the original bytes without a client supplying them |
| `T16 upload-before-sync`, each mechanism | Wire/server condition passes with offline queued updates and with reload. Literal statuses in order: `Offline, saved on this device`, `Saved on this device, waiting for images to upload`, `Your changes saved to server`. Covering-receipt gate additionally requires `Saved on this device, sending` after upload. M3 also passes the N clause; one-document N failure is retained. Hard kill and empty late join recover exact item/text and bytes; late peer waits for download before saved status |
| `T16 pending-image`, uploader uploads | Pass. Offline queue, reconnect SyncStep2 and duplicate `forceSync`; server has pending gP and Z before bytes, late peer has placeholder. Sender waits for membership and the pending-clear receipt; peer waits for bytes. Sender export includes its local image; peer export lists it missing |
| `T16 pending-image`, uploader never returns | Pass. Drop A without upload, kill/restart server, join C. Literal abZ and pending gP remain, picture stays placeholder, export has `missingImages: [sha]`, status never says saved |
| `upload hold with concurrent inbound text`, each mechanism | Pass. B's X reaches A while A's image and Z remain absent from the journal. After release, journal and A have exact abZX identities; receipt tracker settles without falsely treating inbound X as A's obligation |
| `pending-image reload restores pending flag, local bytes and receipt coverage before upload retry` | Pass. Persisted capture restores abZ, original identities, pending item and exact local PNG. Reconnect remains waiting, then upload and the flag's receipt reach saved |
| `T19 (c)` | Pass. Incremental nonpending item without membership receives one negative status and literal retry-after notice; no new journal row or peer state. Upload then public `forceSync()` generates real subtype-1 SyncStep2 carrying the item. Status stays sending while that receipt is held, then saved. A subsequent Z commits on the same socket lifetime, proving message-only reset; policy stays attached, zero outstanding receipts, no reconnect loop |

Every wait has a throwing deadline. The upload-stage and journal-hook events schedule the next probe; disposition, durable membership, outgoing data and recovered bytes come from harness-owned declarations/reads. No `onChange`, provider count, server timestamp or server journal diagnostic supplies those facts. Children, workers, HTTP listeners, sockets and documents are stopped in `finally`; no browser or app suite runs.

## Library facts and limits

| Row | Confirmed / refuted and deciding evidence |
| --- | --- |
| H11, stock provider | Confirmed by `H11: outgoingMessage listener cannot cancel incremental or reconnect SyncStep2`: returning false from the outgoing listener does not stop either actual frame or its acknowledgement. Existing reconnect ordering/count facts are already established by [#1386](https://github.com/RetroGorilla/splitpage/pull/1386) and [#1393](https://github.com/RetroGorilla/splitpage/pull/1393), not repeated as new findings |
| H11, hold through N | M3's reconnect/reload cases confirm the separate-N hold. The configured `WebSocketPolyfill` also permits a one-document **wire** hold, without replacing provider methods or introducing another sync protocol. The tests reject removing that gate. This does not refute the source fact that there is no cancellable provider update hook, and it does not make one document satisfy the literal N clause |
| H9 / H10, temporary refusal | T19 (c) confirms a normally returning missing-blob refusal gets a negative status, keeps the socket, resets read-only and accepts later SyncStep2/Z. Permanent-detach and malformed-message limits remain those of [#1393](../refusal/README.md#library-predictions) |
| H3, receipt coverage | Existing FIFO/count-reset findings and refused-range retention are cited from [#1386](../README.md#library-observations) and [#1393](../refusal/README.md#library-predictions). This lane adds asset-aware status and same-instance acknowledged-range restoration; it does not replace the tracker |
| H1 / H7, awaited journal | Already confirmed in [#1386](../README.md#library-observations). This lane uses its hook unchanged. Its accepted status/COMMIT-window proof limit still applies; image tests do not claim to repair or repeat it |

No library-source prediction is newly refuted, and no handwritten expected result was changed. The claim that a second Y.Doc is unavoidable solely for the **server** image durability property is not supported by these traces: the transport boundary works for that narrower property. The literal N expectation is preserved and explicitly fails for the one-document alternative.

## Files and production hooks

Source additions are `publication.ts` (client mechanisms/status/export capture), `service.ts` (HTTP and opt-in refusal extension), and `store-worker.ts` (file and membership durability). Tests add the image harness and one enforcing trace file. No new dependency, package or lockfile change.

The three source modules add 277 physical lines: 108 client-mechanism lines, 110 HTTP/extension lines and 59 worker lines. Shared blob and status machinery serves both designs; the per-design method costs are listed above rather than counting that common code twice. No runtime performance advantage is claimed.

Shared-file changes, listed in full:

- `src/service/server-process.ts`: import/start the opt-in image service after journal readiness; compose its extension with refusal; route `image-*` fixture commands; expose the free image port in readiness; close it during explicit stop.
- `src/service/receipts.ts`: four added lines for `restoreAcknowledged`, decoding persisted positive-receipt coverage without opening a connection or clearing local/refused obligations.

`test/service/harness.ts`, journal files and refusal files are unchanged. New histories are only the four small T16 files linked above.

Real-editor wiring would need a completion-aware local blob/replica transaction before gallery insertion, enumeration of every required asset (including recovery and supported undo), the gate installed before provider attachment/reconnect if using one document, or E/N bridge ownership plus atomic captures for M3, same-instance receipt restoration, upload retry and durable-membership notification, verified downloads before local saved status, pending placeholder/export disclosure, and stale-callback ownership checks for delayed picture add, thumbnail replacement and annotation. Bundle copy remains outside shared mode as the plan requires. No editor hook was added. This experiment does not validate a complete production manifest or automatic writers.

## Reproduce and validation

Node 24.22.1, pinned package versions, base `eb765ac0` (#1393), Windows on this PC:

```powershell
$env:TEMP='C:\Users\Gorbus\AppData\Local\Temp\splitpage-lanes\s1b-images'
$env:TMP=$env:TEMP
npm ci
node --test --test-concurrency=1 test/service/images/images.test.ts
npm test -- --test-concurrency=1
```

Run these from `prototypes/collab/`. Root validation uses `npm run lint`, `npm run typecheck`, `npm run check:comments` and `npm run check:deps`, serially. No `verify`, app, browser, desktop or performance suite is run, per the lane brief. Validation counts are recorded in the PR body after the final gate run.

Final local validation: **16/16** image test records (15 subtests and the enforcing outer gate); **996/996** prototype package tests. Root lint and typecheck passed, including 89 prototype TypeScript files. Comment gate passed over 1,814 files; dependency gate passed over 1,516 modules with zero runtime cycles and zero new exceptions. `node tools/code-map.mjs` and `git diff --check` passed. Root dependencies and desktop type dependencies were installed for these gates; desktop install used `--ignore-scripts`, and no app or desktop executable was started.
