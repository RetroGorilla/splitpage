# E13 · The standard relay under the chosen design

**The default relay breaks the order rule when a link goes silent.** With the connection still showing connected, undo a tag. After the provider declares the disconnect, redo. The server applies redo first and later receives a state reply covering both commands. Every live copy, the server and a fresh late joiner end with the letter and no tag. A silent link is enough. No stock setting guarantees order across sockets.

**The default 15 MB download failed at 1, 2 and 4 Mbit/s.** A 180 s provider receive timeout completed those downloads. The same setting extended the silent-link window to 234 s in a measured run. A full-size upload to the built-in server at 1 Mbit/s repeatedly failed with either server timeout. The built-in WebSocket heartbeat closed it before the frame could arrive.

Local figures use Yjs 13.6.33, Hocuspocus server and provider 4.8.0, Node 24.22.1, and Windows ARM64 on a 12-core Snapdragon X X1E80100. Independent review figures are marked x64. The review supplied the CPU architecture and no model. The server and Node WebSocket client ran on loopback. The pass-through paces ordered TCP bytes and can blackhole an existing connection without forwarding a close. A separate negative control swaps two WebSocket messages. The harness owns shutdown. Networking and sync use the defaults except in the named trials.

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
| Existing connection goes silent with no close, undo while apparently connected, redo after watchdog disconnect | Redo alone, then a state reply covering both. Redo led by 0.44 ms locally and about 0.3 ms in the x64 review. | The writer only sees `disconnect` at forced 4408. The peer and fresh late joiner agree after recovery. | The tag is gone on all copies. Stock stayed connected for 36.0 s locally and 36.1 and 39.0 s on x64. |
| Same drop with server batching disabled | Same two writes in the same wrong order | Each live copy gets redo, formatting cleanup, then undo as separate broadcasts. The writer also gets its reconnect state reply. | **All five have plain `v`.** Both the server and the receiving copies see the inversion in this run. |
| One offline queue, with two edits made on the other side. Repeated after 70 s offline. | 80 individual writes in order, then one redundant state reply covering all 80. The online writer sends its two updates in order. | Returning writer gets the other side’s two edits in a state reply and one merged broadcast of its own 80 writes. Other live copies get a broadcast for both online writes and a merged broadcast for the 80 pending writes. | `vr` stays tagged. All 78 typed letters and `other side` survive. |
| Two writers return together | The first sends its 80 updates and a state reply covering them. The second sends two updates and a state reply covering them. Each writer’s new updates arrive in order. | Returning writers receive their respective state replies and a merged broadcast carrying both writers’ work. The reader receives that broadcast. | Same text and tags as the one-queue run. The two writers edit separate fields. |
| Graceful server restart through the store and load hooks | A new provider on the rehydrated writer sends one state reply covering undo, redo and `restart`. | A fresh reader first gets the stored baseline, then one merged broadcast. Writer gets a state reply and the same broadcast. | The stored tag is present before the writer returns. It survives with `restart` on every copy. |

The smallest failure needs one tagged letter, one undo sent into the old silent socket, and one redo queued offline. The old undo never returns as its own update. At open the stock provider signs in and sends its sync request and awareness. The first server message drains the queue. The client sends its state reply only after the server asks it for state. The server applies the new tag-on marker from redo while the original is still present. Its formatting cleanup deletes the new marker as redundant and broadcasts that deletion. The state reply then deletes the original marker. The trace checks both marker IDs and both deletions. The cell is a nested `Y.Text`. The server has no text observer.

Every document update sent into the still-open dead socket is lost on the wire and returns through state. The status can continue to say connected after the first watchdog call tries to close the socket. At that point unsent edits can enter the queue. Each of the first two close attempts clears it. An edit queued after the second attempt can survive the forced close and travel ahead of older state again. This distinction follows from the WebSocket ready-state test and the queue clear in the pinned provider.

The older 4.8.0 [service traces T23 and H4/H11](../service/README.md#library-observations) already showed which close paths retain the queue, which discard it, and that queued updates can precede the reconnect state reply. E13 tests the consequence for the chosen tag after both a cut and a silent link. The [E3b raw replay](../native-undo/RESULTS.md#follow-up-with-the-chosen-keys) also shows that reading `event.delta` during integration can change which tag marker is cleared. The two-update press here uses such a reader on the writer. The E9 deleted-row cases concern which editing target still exists after a merge and use hand delivery. [E9](../native-delete/RESULT.md)

### Width of the order break

The first command after any listed preparation was sent to the old socket and lost. The second was queued. Each pair ran five times stock and five times with the experimental wrapper, against an in-order relay run. A difference here means a settled text, mark, cell, field, or boundary differs. The literal command checks and a fresh late joiner check run alongside that comparison. In all 110 stock runs and 110 wrapper runs the copies agreed, and no text, record, cell or boundary was missing relative to ordered delivery. The stock differences were all in marks.

| First change lost, then second queued | Stock differences / 5 | Wrapper differences / 5 |
| --- | ---: | ---: |
| Tag online, then undo → redo | 5 | 0 |
| Bold online, then undo → redo | 5 | 0 |
| Bold then italic online, then undo → redo. Only italic disappeared. | 5 | 0 |
| Bold the first two letters of `word` online, then undo → redo | 5 | 0 |
| Chosen production tag on `NativeReplica` narration online, then undo → redo | 5 | 0 |
| Bold → italic | 0 | 0 |
| Red → blue | 0 | 0 |
| Bold [0,1] → bold [0,2] | 0 | 0 |
| Type → bold over it | 0 | 0 |
| Tag → untag | 0 | 0 |
| Untag → tag again | 0 | 0 |
| Split → type in new visual cell | 0 | 0 |
| Split → set a field on the new beat | 0 | 0 |
| Split → type in new narration | 0 | 0 |
| Split → tag new narration | 0 | 0 |
| Split a tagged row → type | 0 | 0 |
| Split → undo split | 0 | 0 |
| Split online, then undo → redo, plain row | 0 | 0 |
| Split online, then undo → redo, tagged row | 0 | 0 |
| Tag and undo online, then redo → undo | 0 | 0 |
| Tag and untag online, then undo → redo | 0 | 0 |
| Type online, then undo → redo | 0 | 0 |

The review’s 5/5 partial-bold result repeats for the prefix. In a separate one-run-per-range sweep of the nine proper ranges of `word`, the three prefixes lost bold. The six ranges beginning after the first letter kept it. These are finite histories of one writer’s command pairs.

### Experimental provider wrapper, awaiting the owner’s decision

There is no stock option to suppress both queued updates and direct document sends during the opening handshake in Hocuspocus 4.8.0, the latest stable release. Yjs 13.6.33 and the Yjs 14 prereleases do not own this provider’s queue or send order. [Provider options](https://tiptap.dev/docs/hocuspocus/provider/configuration) · [Hocuspocus releases](https://github.com/ueberdosis/hocuspocus/releases) · [Yjs releases](https://github.com/yjs/yjs/releases)

The 38-line subclass in [state-first.ts](state-first.ts) keeps edits in the document until the stock provider has sent its own state reply. It suppresses independent document sends while disconnected and from open through that reply. It counts the pending state reply once. After that reply, direct sends and their status count resume. It forwards any synchronous edits made while preparing the reply after that reply, so an edit made inside a callback cannot fall between the snapshot and the send gate. Authentication, awareness and the handshake remain stock.

| Reconnect trial, five repeats each | Stock or probe | Full wrapper |
| --- | --- | --- |
| Queued redo after lost undo | Tag lost 5/5. Redo update then state reply. 553 upstream TCP bytes per run. | Tag kept 5/5. One state reply. 503 bytes. |
| A. Discard the offline document queue before opening | Tag kept 5/5. One state reply. 503 bytes. | Tag kept 5/5. Same frame and bytes. |
| B. Empty queue, redo at open before the first server reply | Tag lost 5/5. Direct redo then state reply. 521 bytes. | Tag kept 5/5. One state reply. 503 bytes. |
| Independent typing at open, first server reply held for 25 ms | Peer got the edit in 0.54 ms median. 499 bytes. | Peer got the edit in 29.77 ms median, about 29 ms later. 481 bytes. |
| 1 MB offline queue at 50 Mbit/s | 16 updates and one state reply. 2,001,048 bytes. | One state reply. 1,000,485 bytes. |
| 5 MB offline queue at 50 Mbit/s | 79 updates and one state reply. 10,003,346 bytes. | One state reply. 5,000,488 bytes. |

The normal Section A outcomes repeated with the wrapper under the default provider batching setting. The unchanged fixtures covered steady delivery, the two-part press, bursts, the late join and graceful restart. The new wrapper fixture covered one and two returning writers. Each sends one state reply instead of an offline queue and a redundant reply. The deliberately bad raw and swapped-frame controls still detected the fault. Both the cut and silent-link cases now preserve the tag. Local editing stays immediate. A remote reader waits for the server’s first sync request before seeing a first-trip edit. A large combined state reply is subject to the upload limit below.

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

The 30 s provider timer is a gap between complete messages. It begins after the first complete message and checks every 3 s. Bytes of an unfinished reply do not reset it. The first socket close attempt can precede the app’s disconnect event. At 1 and 2 Mbit/s the provider reported the forced close after repeat checks. At 4 Mbit/s even the raw transfer takes just over 30 s. In the repeat at 4 Mbit/s the person received 45,023,685 TCP bytes in three attempts and saw no script. The server loaded the document three times and sent about 15 MB per attempt. The default retry policy has no attempt limit. A second 2 Mbit/s run with both timeouts raised synced in 68.2 s. The provider-only run overlapped the full check batch.

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

### Full-size upload to an empty server

The built-in Hocuspocus server 4.8.0 uses `crossws` 0.4.17. Its Node adapter uses a 30 s ping sweep (`idleTimeout ?? 30`). Hocuspocus passes WebSocket server options and has no setting for this adapter timer. A pong queued behind a large upload cannot arrive while the server is still receiving that single frame. An incomplete frame also does not count as a message. If neither arrives by the next sweep, the adapter terminates the connection. The sweep phase sets the time budget. The earlier 5 MB frame fitted inside it in its sample.

| Empty server and upload | Server applied / writer acknowledged | Disconnects |
| --- | --- | --- |
| Built-in, E8 at 1 Mbit/s, provider 180 s, server 60 s | Neither in three attempts | Local 60.0, 120.0, 180.0 s. x64 59.1, 119.1, 179.1 s. |
| Built-in, E8 at 1 Mbit/s, provider 180 s, server 180 s | Neither in three attempts | Local 60.0, 120.0, 180.0 s. x64 59.2, 119.2, 179.2 s. |
| Built-in, E8 at 4 Mbit/s, both at 180 s | Applied at 33.58 s, acknowledged at 66.55 s | None. |
| Own `ws` server, E8 at 1 Mbit/s both ways, provider 300 s, server 60 s | No complete apply or acknowledgement | One observed 4408 disconnect at 125.94 s. |
| Own `ws` server, E8 at 1 Mbit/s both ways, both at 180 s | Applied at 129.59 s. The writer was still receiving the echo at disconnect. | Provider forced 4408 at 234.13 s. |
| Own `ws` server, E8 at 1 Mbit/s both ways, provider 300 s, server 180 s | Applied at 127.34 s, acknowledged at 254.24 s | None. |

To bracket the built-in limit, the writer opened just after server start with one synthetic ASCII state reply. The upload was capped and the echo was uncapped. Both Hocuspocus timers were 180 s. These are the largest tested successes and smallest tested failures in each bracket. A later connection in the sweep cycle may fail at a smaller size. Sizes above the 15 MB product limit are transport probes.

| Upload cap | Largest tested success, server apply | Smallest tested failure |
| --- | --- | --- |
| 1 Mbit/s | 7,150,022 B at 59.75 s | 7,500,022 B. Closed near 60 s. |
| 2 Mbit/s | 14,000,022 B at 59.71 s | 14,250,022 B. Closed near 60 s. |
| 4 Mbit/s | 28,000,022 B at 59.14 s | 28,500,022 B. Closed near 60 s. |

The [documented `handleConnection` route](https://tiptap.dev/docs/hocuspocus/server/usage) ran the same Hocuspocus core on a plain `ws` listener. This trial had no WebSocket ping sweep. The original Section A results, including the order break, and Section C signals repeated. The default 4 Mbit/s download still failed three times, transferring the same 45,023,685 bytes and doing three loads. Section D gave comparable results in one sample. This route gives the host responsibility for connection lifetime and any heartbeat it chooses. The host’s `onUpgrade` and HTTP hooks are outside this direct `ws` fixture.

The **15 s HTTP timeout** appears in the older instance and image clients. The current plan requires the initial state to be durable before joining opens, and leaves its upload route open. Reusing the old instance HTTP client and endpoint would bring back the 15 s timeout and 3 MiB JSON request cap. The image client has its own HTTP path and size limit. Neither path is used by these WebSocket trials. [Instance client](../service/instance/client.ts) · [Instance endpoint](../service/instance/extension.ts) · [Image service](../service/images/service.ts) · [Plan](../../../../docs/COLLABORATION-PLAN.md)

## C · Signals for the offline notice

There is **no dependable provider event for “everything of mine is acknowledged and everything of theirs is applied.”** The provider’s two directions can each still have work in flight. Acknowledgement here means a positive server status for an update. Writing the document through the store hook is a separate step.

| App question | Standard signal | What the traces show |
| --- | --- | --- |
| Is the connection open? | `open`, `status` with `connected`, socket `status`. `connect` follows the first complete server message. `authenticated` applies to the document. | All first joins and reconnects went through socket open, then `connect` and `authenticated`. The connected status appeared twice. An open socket can still be waiting for the document. |
| Did the socket disconnect? | Use `status` with `disconnected` or `disconnect` for socket state. | On ordinary close `synced` could be true in `disconnect` and reset in `close`. Forced 4408 calls the disconnect handler directly. It emits no `close`, and `synced` stays true through the disconnect and can stay true throughout the next handshake. |
| What does the inbound handshake establish? | After applying the server’s state reply, the copy has what the server had when it answered this connection’s sync request. A positive status that takes the pending count to zero can also emit `synced`. | Ordinary joins emitted `synced` after applying the reply. One early direct edit on reconnect elicited a positive status first, so `synced` fired while the copy still lacked the server’s `r`. The state reply brought `r` later. This qualifies a guarantee based on `synced` alone. |
| Are there unsent local edits? | `unsyncedChanges` event and number, and `hasUnsyncedChanges`. | These count pending work, including the handshake, and cannot distinguish an unsent write from an unacknowledged send. Held typing raised the count to 1 while `synced` stayed true. After the cut, the typing remained locally and the count stayed 1. The reconnect state reply recovered the text. |
| Have all local edits been acknowledged? | After the handshake on an unbroken connection, with every send counted and no intervening edit or counter reset, pending zero means the relay has applied the valid updates this copy sent. Store completion is separate. | The steady press and burst ran `+1` per local update, then one decrement per positive status. On reconnect an offline queue of 80 reset to 1. The first positive status reached zero early. Further positive statuses each reported zero. [Earlier T23/H3 evidence](../service/README.md#library-observations) |
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

The own-`ws` sample retained 306.9 MiB. Load read and apply took 9.5 ms and 2,030 ms. Cold and late joins took 4.31 s and 1.93 s. The 18-byte key took 0.79 ms through handling and reached the peer and writer count zero in 15.13 ms. Store encoded in 407 ms and wrote in 28 ms. These single runs support the same scale of cost. They cannot separate transport effects from machine load.

## Settings to put to the owner

| Setting | Change and cost |
| --- | --- |
| Provider `messageReconnectTimeout: 180_000` | Completes 15 MB downloads down to 1 Mbit/s and the 5 MB combined return in one connection. The same setting stretches the undetected silent-link window from about 36–39 s to 216–234 s. The local run measured 234.0 s and still lost the tag. Checks run every 18 s. There is no per-character storage cost. |
| Server `timeout`, and the separate built-in WebSocket heartbeat | Changing 60 s to 180 s did not move the built-in full-upload failure. The 30 s `crossws` sweep is separate. The successful own-`ws` run used server 180 s and provider 300 s to allow the full upload and echo. On that route, longer timers retain dead connections and their resources longer. |
| WebSocket message limits | The default receive limit accepts these frames by size. An upload path also needs to fit a complete frame into its connection lifetime. A smaller configured size limit can cause repeated close 1009. A larger allowance can retain more bytes per connection. [Service review](../service/README.md#trace-results) |
| Server `flushDelay: 0` and provider `flushDelay: false` | Default fanout coalesces without a timer delay. Server `flushDelay: false` changed one broadcast into three in the failing history and kept the order break. A provider batching window adds send latency and can group writes on one socket. No stock queue-order option was found. |
| Normal store debounce | Default `debounce` is 2 s and `maxDebounce` is 10 s. A shorter wait raises how often the whole document can be encoded and written. A longer wait increases the possible gap between positive status and store. |

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
| Server-side applied update bytes, decoded original and redone marker identities, deletion ranges | Shows which marker the server cleanup deletes and which one the state reply removes. This depends on the nested-text fixture and both marker writes actually occurring. |
| Pair snapshots of text units and mark kinds, boundaries, record maps, visual cells and segment order | Compare with command literals and the actual in-order run. They do not compare every deleted historical item or infer a person’s intended placement for other command histories. |
| Complete state reply handling, an `afterTransaction` read on the peer, and ingress byte counts around reconnect | Separates arrival from apply and measures the first visible peer edit and total upstream bytes, including handshake bytes. The 25 ms first-reply gate is an injected delay, and these latencies do not predict a deployed network. |

## Questions for the owner

1. **How should reconnect behave after the reproduced tag loss?**
   - **A.** Keep stock automatic reconnect. The document comes back without intervention, and a tag can disappear even when all copies agree.
   - **B.** Choose the experimental wrapper for further work. Drop queued document sends and hold new sends from open until the client sends its state reply. Local editing continues and a remote person sees the earliest edits after the first exchange. The measured pair trials keep their tags and send fewer bytes. The owner has made no choice to adopt it.
2. **How long should someone wait on a slow first sync?**
   - **A.** Use the measured 180 s provider timeout. At 1 Mbit/s the script can appear after about two minutes. A dead link can keep showing connected for about four minutes.
   - **B.** Keep 30 s. Fast links finish as before. At the tested slow rates the connection can repeatedly restart without showing the script.
3. **What should E12 say when the two-way completion point is unavailable?**
   - **A.** Describe the changes received so far. A person can see a preliminary notice followed by more incoming edits.
   - **B.** Show that a merge is underway and defer the summary until there is a justified completion rule. A person sees the incoming edits and knows the merge is still in progress.
4. **How should a new instance receive a full starting state?**
   - **A.** Use the built-in WebSocket server and accept its upload envelope. A person at 1 Mbit/s cannot publish the full document through one state reply.
   - **B.** Evaluate a host-owned WebSocket listener with its own heartbeat policy. The measured 1 Mbit/s upload made the initial state visible to the server after about two minutes and acknowledged it after about four. The host must own connection lifetime.
   - **C.** Design a separate initial upload path. A person would see a distinct publishing step before anyone can join. The old HTTP path would carry its 15 s and 3 MiB limits if reused as-is.

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
node src/native-relay/review-measure.ts silent
node src/native-relay/review-measure.ts silent 180
node src/native-relay/review-measure.ts pairs
node src/native-relay/review-measure.ts ranges
node src/native-relay/review-measure.ts wrapper
node src/native-relay/review-measure.ts full-upload $e13State 1 60 3
node src/native-relay/review-measure.ts full-upload $e13State 1 180 3
node src/native-relay/review-measure.ts full-upload $e13State 4 180 1
foreach ($e13Bracket in @(@(1, 7.15, 7.5), @(2, 14, 14.25), @(4, 28, 28.5))) {
  node src/native-relay/review-measure.ts full-upload $e13Bracket[1] $e13Bracket[0] 180 1 uncapped
  node src/native-relay/review-measure.ts full-upload $e13Bracket[2] $e13Bracket[0] 180 1 uncapped
}
$env:SPLITPAGE_E13_WS = '1'
node --test test/native-relay/order.test.ts
node src/native-relay/measure.ts download $e13State 4
node --expose-gc src/native-relay/measure.ts cost $e13State
node src/native-relay/review-measure.ts full-upload $e13State 1 60 1 1 300
node src/native-relay/review-measure.ts full-upload $e13State 1 180 1 1 180
node src/native-relay/review-measure.ts full-upload $e13State 1 180 1 1 300
Remove-Item Env:SPLITPAGE_E13_WS
$env:SPLITPAGE_E13_STATE_FIRST = '1'
node --test --test-name-pattern 'steady undo|restart stores|synced remains true|a single press|control:' test/native-relay/order.test.ts
node src/native-relay/measure.ts upload 1 50
node src/native-relay/measure.ts upload 5 50
Remove-Item Env:SPLITPAGE_E13_STATE_FIRST
```

The least certain numbers are the upload brackets and the download boundary near 4 Mbit/s. The two clocks have independent phases. Congestion, multiplexed traffic, client close behavior and a deployment’s heartbeat all change the budget. The local cap is a controlled stream, and the test does not model a browser, TLS or variable network speed. A silent link reproduces the order break without a timed cut. The 22 pairs do not establish which other histories lose marks, or a completion point for changes still coming from other writers. Graceful reload does not measure abrupt power loss.
