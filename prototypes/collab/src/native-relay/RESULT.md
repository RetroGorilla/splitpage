# E13 · The standard relay under the chosen design

**The default relay breaks the order rule across reconnects.** Tag `v`, let everyone receive it, then sever the writer’s connection after the writer sends undo and before the server receives it. Redo while disconnected. The server receives redo first and an update covering both commands later. Every live copy, the server and a fresh late joiner end with plain `v`. The steady and ordered-burst cases kept the tag. No stock setting found guarantees order across sockets.

**The default 15 MB first sync failed at 1, 2 and 4 Mbit/s.** Each rate made three attempts and disconnected on all three without delivering the document. It finished at 10 and 50 Mbit/s. A 180 s provider receive timeout finished the slow cases. The default server settings were sufficient in the provider-only runs.

Measured with Yjs 13.6.33, Hocuspocus server and provider 4.8.0, Node 24.22.1, and Windows ARM64 on a 12-core Snapdragon X X1E80100. The Node WebSocket client and plain Node Hocuspocus server ran on loopback. The pass-through only paced ordered TCP bytes in each direction. A separate negative control deliberately swapped two WebSocket messages. The harness suppresses the server banner and owns shutdown. Networking and sync use the defaults except in the named settings trials.

## A · Order

An **update** carries a change to the document. A **state reply** is the standard Yjs handshake message (SyncStep2) containing what the other side appears to lack. The table counts document-bearing WebSocket messages, including empty state replies where shown. The server broadcasts its updates back to their writer as well as to the other copies. The server can combine several changes into one broadcast. Counts are from a sample run. The number of broadcasts in a burst can vary with how the event loop groups the work.

| Commands and delivery | Server receives | Copies receive | Final text and marks |
| --- | --- | --- | --- |
| Raw Yjs control, tag `vr`, undo then redo | No server | Third copy gets redo then undo and sends its cleanup to the first copy. Full exchange settles all three. Forward and merged runs are paired controls. | All three have plain `vr` in reverse, tagged `vr` in forward and merged. This held for all three E3b key forms. |
| Steady undo, then steady redo | Two updates, undo then redo | Writer and each of two readers get both, in order. | Plain `vr` at the undo checkpoint, tagged `vr` after redo. |
| One press with two updates | Two updates, undo then formatting cleanup | Writer and reader each get one merged broadcast covering both updates. | `mosxl` plain, `mouo` bold, `y` plain. An independent tag on `vr` survives everywhere. |
| Immediate undo and redo, then six keystrokes with formatting | Eight individual updates in command order | Writer and each of two readers get one merged broadcast in the sample. | `vr` stays tagged. `for` is plain and `mat` is bold. |
| Empty copy joins after those edits | No new writer update for the join | One state reply covers all ten writes from the steady and burst rows. | Same text and marks as the live copies. |
| Drop before undo reaches server, redo offline, automatic reconnect | Redo alone, then one state reply covering undo and redo. The recorder flags redo before undo. | Writer gets one empty state reply and one merged broadcast. The other two live copies each get one merged broadcast. An empty late joiner gets one state reply. | **All five stored or live views have plain `v`.** The merge on the way out cannot repair the server’s earlier apply. |
| Same drop with server batching disabled | Same two writes in the same wrong order | Each live copy gets redo, formatting cleanup, then undo as separate broadcasts. The writer also gets its reconnect state reply. | **All five have plain `v`.** Both the server and the receiving copies see the inversion in this run. |
| One offline queue, with two edits made on the other side. Repeated after 70 s offline. | 80 individual writes in order, then one redundant state reply covering all 80. The online writer sends its two updates in order. | Returning writer gets the other side’s two edits in a state reply and one merged broadcast of its own 80 writes. Other live copies get a broadcast for both online writes and a merged broadcast for the 80 pending writes. | `vr` stays tagged. All 78 typed letters and `other side` survive. |
| Two writers return together | The first sends its 80 updates and a state reply covering them. The second sends two updates and a state reply covering them. Each writer’s new updates arrive in order. | Returning writers receive their respective state replies and a merged broadcast carrying both writers’ work. The reader receives that broadcast. | Same text and tags as the one-queue run. The two writers edit separate fields. |
| Graceful server restart through the store and load hooks | A new provider on the rehydrated writer sends one state reply covering undo, redo and `restart`. | A fresh reader first gets the stored baseline, then one merged broadcast. Writer gets a state reply and the same broadcast. | The stored tag is present before the writer returns. It survives with `restart` on every copy. |

The smallest failing relay history is one tagged letter, one undelivered undo, and one offline redo. The already-open socket loses its write. The provider still owns the document, so it recovers that write through a state reply. The socket sends its retained offline queue on the first response to reconnect. The newer redo is in that queue. The older undo is only in the later state reply. In this sample the server generates the formatting cleanup that removes the redone tag. The cell is a nested `Y.Text`, as in the proposed design. The server has no text observer in the failing run.

The older 4.8.0 [service traces T23 and H4/H11](../service/README.md#library-observations) already showed which close paths retain the queue, which discard it, and that queued updates can precede the reconnect state reply. E13 uses an ordinary close to test the consequence for the chosen tag. The [E3b raw replay](../native-undo/RESULTS.md#follow-up-with-the-chosen-keys) also shows that reading `event.delta` during integration can change which tag marker is cleared. The two-update press here uses such a reader on the writer. The E9 deleted-row cases concern which editing target still exists after a merge and use hand delivery. [E9](../native-delete/RESULT.md)

## B · First sync at the limit

The [E8 fixture](../native-size/RESULT.md#measurements) is 15,036,020 bytes, with 300 beats and 20 headings. Each download starts from a cold server and a fresh reader. Rates are configured ceilings in decimal Mbit/s. TCP framing and local scheduling add time. `Synced` times start at connect. The failed runs stopped after three observed disconnects. The stock provider was still retrying, and each attempt started the whole state reply again.

| Downlink cap | Stock provider `synced` | Stock disconnects | `synced` with provider receive timeout at 180 s |
| --- | ---: | --- | ---: |
| 1 Mbit/s | No first sync in 117.3 s | 39.1, 78.2, 117.3 s, code 4408 (`forced`) | 129.3 s |
| 2 Mbit/s | No first sync in 117.5 s | 39.3, 78.4, 117.5 s, code 4408 (`forced`) | 80.0 s |
| 4 Mbit/s | No first sync in 104.0 s | 34.9, 69.5, 104.0 s, code 1006 (abnormal close) | 35.9 s |
| 10 Mbit/s | 16.1 s | None | Stock finishes |
| 50 Mbit/s | 6.3 s | None | Stock finishes |
| Uncapped pass-through | 3.7 s | None | Stock finishes |

The 30 s provider timer is a gap between complete messages. It begins after the first complete message and checks every 3 s. Bytes of an unfinished reply do not reset it. The first socket close attempt can precede the app’s disconnect event. At 1 and 2 Mbit/s the provider reported the forced close after repeat checks. At 4 Mbit/s even the raw transfer takes just over 30 s. A person can see the connection status cycle without ever getting their document. The runs show repeated restarts under a stable cap. The default retry policy has no attempt limit. A second 2 Mbit/s run with both timeouts raised synced in 68.2 s. The provider-only run overlapped the full check batch.

For uploads, the writer started with a small, already-shared document and made 16 edits for 1 MB or 79 for 5 MB while offline. The same provider returned through the cap. The server received each edit in order, followed by a roughly equal-sized redundant state reply. The first time below is when the peer had the whole edit. The second is when the server got the redundant reply. Both directions were capped equally.

| Cap | 1 MB, all edits / redundant reply | 5 MB, all edits / redundant reply | Stock disconnects |
| --- | ---: | ---: | --- |
| 1 Mbit/s | 8.42 / 16.70 s | 41.77 / 83.45 s | None |
| 2 Mbit/s | 4.31 / 8.56 s | 21.29 / 42.63 s | None |
| 4 Mbit/s | 2.14 / 4.26 s | 10.53 / 21.05 s | None |
| 10 Mbit/s | 0.90 / 1.74 s | 4.23 / 8.40 s | None |
| 50 Mbit/s | 0.23 / 0.39 s | 0.90 / 1.98 s | None |
| Uncapped | 0.04 / 0.04 s | 0.20 / 0.21 s | None |

The 1 Mbit/s runs emitted `synced` at 0.07 s. Their first zero pending count was about 0.62 s, while most edits were in transit. The 1 MB run’s redundant reply was 1,000,018 bytes and the 5 MB run’s reply was 5,000,019 bytes. The individual replies from the server kept the stock connection alive through the first stream of edits.

| Returning from saved local state at 1 Mbit/s, one combined upload | Server gets the work | Writer sees |
| --- | ---: | --- |
| 1 MB, stock | 8.37 s | `synced` at 0.04 s, pending zero at 8.38 s, no disconnect. |
| 5 MB, stock | 41.80 s | `synced` at 0.08 s. Forced disconnect at 66.13 s, then pending zero on the next connection at 67.23 s. The second upload reply is just 2 bytes because the server already has the work. |
| 5 MB, provider receive timeout 180 s | 41.75 s | `synced` at 0.08 s. Pending zero at 83.40 s, with no disconnect. The large broadcast to the writer goes ahead of its status reply. |

The **15 s upload limit** belongs to the older instance-management HTTP client’s `AbortSignal.timeout(15000)`. Its image and instance upload tests use separate HTTP paths. These WebSocket syncs do not use that client. [E8 limits](../native-size/RESULT.md) · [Instance HTTP client](../service/instance/client.ts)

## C · Signals for the offline notice

There is **no dependable provider event for “everything of mine is acknowledged and everything of theirs is applied.”** The provider’s two directions can each still have work in flight. Acknowledgement here means a positive server status for an update. Writing the document through the store hook is a separate step.

| App question | Standard signal | What the traces show |
| --- | --- | --- |
| Is the connection open? | `open`, `status` with `connected`, socket `status`. `connect` follows the first complete server message. `authenticated` applies to the document. | All first joins and reconnects went through socket open, then `connect` and `authenticated`. The connected status appeared twice. An open socket can still be waiting for the document. |
| Did the socket disconnect? | `status` with `disconnected`, `disconnect`. `close` also resets the document handshake. | In the two drop traces, `disconnected` and `disconnect` callbacks could read `synced=true` inline. By the subsequent `close` callback it was false. Use the disconnect event for socket state. |
| Did the first handshake finish? | `synced` event and field. The server’s state reply sets it after apply. A positive status that brings the pending counter to zero can also set it. | On ordinary joins and state-only restart, `synced` fired while pending was still 1. The counter then went to zero. On queued reconnect, `synced` can fire while uploads are still on the wire. Subsequent remote updates do not clear it. |
| Are there unsent local edits? | `unsyncedChanges` event and number, and `hasUnsyncedChanges`. | These count pending work, including the handshake, and cannot distinguish an unsent write from an unacknowledged send. Held typing raised the count to 1 while `synced` stayed true. After the cut, the typing remained locally and the count stayed 1. The reconnect state reply recovered the text. |
| Have all local edits been acknowledged? | A zero pending count is useful on a steady connection with a known send sequence. There is no per-edit receipt exposed by these fields. | The steady press and burst ran `+1` per local update, then one decrement per positive status. In the long queue, the reconnect reset 80 to 1 and the first positive status reached zero. Further positive statuses each reported zero. This matches the [earlier T23/H3 evidence](../service/README.md#library-observations). |
| Is the copy caught up both ways? | No stock field or event establishes this. | The writer had `synced=true` and pending zero while its download was held and a remote edit was already on the server. That edit appeared when the stream was released. During the order defect the writer also reached `synced=true` and pending zero, yet the tag was lost. |

## D · The server at 15 MB

The store and load hooks used a local temporary file. Heap is the increase in live JavaScript heap after garbage collection, sampled after the server applied the stored state and before the client got it. The hook timings include decoding on load and full encoding on store. The write waits for the file operation to return. It makes no disk-flush guarantee.

| Measure | Observed |
| --- | ---: |
| Retained server heap increase | 306.9 MiB |
| Read file in load hook / apply through `afterLoadDocument` | 7.7 ms / 2,624 ms |
| First join on cold server / late join on warm server, unlimited link | 4.99 s / 1.98 s |
| One plain character in the middle narration cell | 18-byte Yjs update. 0.93 ms from server sync hook to apply notification, 0.94 ms through message handling, 15.27 ms to peer content and writer pending zero. |
| Store scheduling and work after the key | 2.01 s before the hook started, then 438 ms to encode and 27 ms for the file write. The resulting snapshot was 15,036,036 bytes, 16 above the original. |

The store path rewrote the whole snapshot for that one key. The server can coalesce nearby changes into one store call. A positive status can arrive before that call. The earlier [H6 and T22 tests](../service/README.md#library-observations) also distinguish scheduling, hook completion and a durable write.

## Settings to put to the owner

| Setting | Change and cost |
| --- | --- |
| Provider `messageReconnectTimeout: 180_000` | Allows the five tested rate bands to finish at the chosen document size. The slow 5 MB rehydrated send finishes in one connection. Here the no-retry run took longer to reach pending zero because it received the full echo. The timer checks every 18 s. A dead link that stays open without complete messages takes longer to detect. There is no per-character storage cost. |
| Keep server `timeout` at its 60 s default | A provider-only increase completed the slowest download and the 5 MB combined upload. Raising the server timeout to 180 s also worked in the tested downloads. It lets silent connections and their resources stay around longer. |
| Keep stock WebSocket message limits for this experiment | The default receive limit accepts these frames. If deployment sets a limit, allow the full document plus the sync envelope on any path that can upload one. A smaller limit can cause repeated close 1009, already reproduced with 4.8.0 in the [service review](../service/README.md#trace-results). The larger receive allowance can retain more bytes per connection. |
| Keep server `flushDelay: 0` and provider `flushDelay: false` | The server’s default can combine fanout without a timer delay. Server `flushDelay: false` changed one broadcast into three in the failing history and left the inversion and loss intact. A provider batching window adds send latency and groups writes inside that window. It cannot enforce delivery order when old and new writes fall on different sockets. No queue-order option was found. |
| Keep the normal debounce for these measurements | Default `debounce` is 2 s and `maxDebounce` is 10 s. A shorter wait raises how often the whole document can be encoded and written. A longer wait can make the store lag further behind the positive status. |

## Controls

Used counts interventions applied, effective counts interventions that actually changed delivery or timing, and failed counts the intended assertion detecting the change. The tests require complete coverage. A throw or an unfinished run fails the control.

| Intervention | Used | Effective | Failed | Observed |
| --- | ---: | ---: | ---: | --- |
| Raw reverse delivery | 3 | 3 | 3 | Tag assertion rejected every key form on every copy. All six forward and merged comparison runs retained the tag. |
| Swap two WebSocket messages in transit | 1 | 1 | 1 | Server receives both messages, `redo` then `undo`. The relay’s order recorder rejects that order. |
| Remove the rate cap, same 15 MB fixture and timeout | 1 | 1 | 1 | Capped at 4 Mbit/s synced in 35.90 s, cap removed in 4.70 s, direct connection in 4.37 s. Removing the cap fails the slow-time check and returns within 1 s of the direct connection. |

## Values read from the implementation

Expected first appearances are the written command order. Expected final text and marks for the small histories are literals. The recorder checks the number of writes attached to each command before matching any received messages. A packet may cover multiple commands. A repeated packet adds no new first appearance.

| Value read | Claim it checks or prevents |
| --- | --- |
| `Y.Doc` update bytes and origin, and the return value from `undo()`/`redo()` | Binds a real write to its command label and detects the two-part press. This does not predict a Yjs update’s byte layout or extend the check to every possible undo. |
| Decoded Yjs client ids, clock ranges, skip ranges and deleted ranges | Matches source writes in merged or re-encoded packets. This detects missing recorded writes and out-of-order first appearances. Coverage of a write’s ranges cannot prove that write’s original intent survived. |
| The server’s `beforeSync` request name, protocol type and payload | Separates writers and distinguishes received updates from state replies. Arrival at this hook does not prove successful apply. |
| Provider `message` bytes, protocol type and payload | Counts arrivals before the provider applies them. An empty state reply or a duplicate can count as a frame without changing the document. Frame counts exclude control and awareness traffic. |
| `Y.Text.toDelta()`, text length and text content on the live copies, late copies and server | Checks actual characters and attributes against the command literals, including the missing tag on every copy. A pair of equal state vectors or complete packets could miss that failure. |
| Provider status, `synced`, authentication, close codes, pending events and fields | Shows what an app can see and when those values are stale. A zero field does not prove every edit was acknowledged after reconnect. The tests use independent content and arrival checks. |
| Store and load callbacks, saved bytes, and state encoding and segment count on the E8 reader | Checks a genuine store and reload and confirms the full fixture arrived. This cannot establish crash durability or an editor’s first paint. The one-key benchmark reads the starting cell length and checks growth plus the inserted letter. |
| Connection count, bytes forwarded or paced, process heap and elapsed times | Checks that the cap was used, bounds retry observations and measures observed costs. Local processing, timer precision and scheduling affect the wall times. Heap sampling excludes native buffers, total process memory and browser rendering. |

## Questions for the owner

1. **How should reconnect behave after the reproduced tag loss?**
   - **A.** Keep stock automatic reconnect. The document comes back without intervention, and a tag can disappear even when all copies agree.
   - **B.** Keep this design out of product use while evaluating a state-only rejoin. A person may see a separate reconnect step or wait longer before editing resumes. The passing rehydration case establishes one schedule. An owner decision and more evidence would be needed before building on it.
2. **How long should someone wait on a slow first sync?**
   - **A.** Use the measured 180 s provider timeout. At 1 Mbit/s the script can appear after about two minutes. A stalled open link takes longer to be declared dead.
   - **B.** Keep 30 s. Fast links finish as before. At the tested slow rates the connection can repeatedly restart without showing the script.
3. **What should E12 say when the two-way completion point is unavailable?**
   - **A.** Describe the changes received so far. A person can see a preliminary notice followed by more incoming edits.
   - **B.** Show that a merge is underway and defer the summary until there is a justified completion rule. A person sees the incoming edits and knows the merge is still in progress.

## Reproduce and remaining uncertainty

From `prototypes/collab`, using Node 24.22.1:

```powershell
node --test test/native-relay/*.test.ts
$env:SPLITPAGE_E13_LONG_OFFLINE = '1'
node --test --test-name-pattern 'a long offline queue' test/native-relay/order.test.ts
Remove-Item Env:SPLITPAGE_E13_LONG_OFFLINE
$e13Fixture = Join-Path ([System.IO.Path]::GetTempPath()) 'splitpage-e13-fixture'
node src/native-size/run.ts build 15 $e13Fixture
$e13State = Join-Path $e13Fixture 'state.yjs'
foreach ($e13Rate in @(1, 2, 4, 10, 50, 'uncapped')) { node src/native-relay/measure.ts download $e13State $e13Rate }
foreach ($e13Rate in @(1, 2, 4)) { node src/native-relay/measure.ts download $e13State $e13Rate provider }
foreach ($e13Mb in @(1, 5)) {
  foreach ($e13Rate in @(1, 2, 4, 10, 50, 'uncapped')) { node src/native-relay/measure.ts upload $e13Mb $e13Rate }
}
node src/native-relay/measure.ts upload 1 1 state
node src/native-relay/measure.ts upload 5 1 state
node src/native-relay/measure.ts upload 5 1 state-extended
node src/native-relay/measure.ts control $e13State
node --expose-gc src/native-relay/measure.ts cost $e13State
```

The least certain number is the failure boundary near 4 Mbit/s. The disconnect depends on when the first short message arrives, timer phase, competing traffic and how the client closes a connection while receiving a large frame. Timing runs were small samples, some concurrent. The fixed rate cap does not model loss, round-trip delay, compression, TLS, browser differences or uneven real links. The route to tag loss is repeatable with a deliberate cut. These tests cannot say how often a person cuts a live write at that point, or which other histories are sensitive. Graceful reload through the stock hooks does not measure abrupt power loss.
