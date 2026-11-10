# Stage 1b feasibility decision

## Result

Stage 1b does **not yet exit** on the merged evidence at `c3b655b24860ab2a127beaf0c0d244ee31bd7a79`. The coordinator selects Hocuspocus 4.8.0, write-ahead journaling with per-connection receipts, pending images, and a completion-true local store with one writable tab per instance. These selections have scoped passing evidence, but T13 and T17 have not run with image P. A lane is closing that seam; it remains open in this record. The plan requires those media traces to pass before exit. STORE also retains the platform and integration limits below. ([Plan §11 and §13][plan], [#1377][issue], [instance report][instance], [image report][images])

## Trace table

Results retain the mechanisms and limits of the merged reports. A rejected defective implementation remains a FAIL; it is evidence that the checker detects that defect. STORE numbers follow the questions in the local report. ([Experiment index][experiments], [journal report][journal], [local report][local])

| Trace | Result | Under what | PR | The result file |
| --- | --- | --- | --- | --- |
| T13 | PASS, text/lifecycle only; image P NOT RUN | Same creation key, edits during upload, duplicate, late C, creation/upload kills, resumed local envelope and invalidated ownership | [#1398][pr1398] | [instance/README.md][instance] |
| T14 | NOT RUN | Barrier fallback not selected; the delete-only receipt subcase ran under the journal, not as a barrier trace | [#1386][pr1386] | [service/README.md][journal] |
| T15 | NOT RUN | Barrier fallback not selected | [#1386][pr1386] | [service/README.md][journal] |
| T16, upload-before-sync, two documents | PASS | Private E/N bridge, read-only external N, reconnect, queued edits, reload, duplicate coverage, hard kill and late peer | [#1397][pr1397] | [images/README.md][images] |
| T16, upload-before-sync, one document | **FAIL**, literal separate-N condition | Transport holds wire publication through reconnect/reload, but provider document N already contains gP and Z | [#1397][pr1397] | [T16-one-document-N.json][one-n] |
| T16, pending-image | PASS | Offline insertion, reconnect SyncStep2, duplicate forceSync, late peer, reload/retry and uploader never returns after server restart | [#1397][pr1397] | [images/README.md][images] |
| T17 | PASS, text/recovery only; image P NOT RUN | A/B offline, fresh C, journal-only and checkpoint/tail recovery, interrupted checkpoint/prune, deletion and reversed dependency with duplicates | [#1398][pr1398] | [instance/README.md][instance] |
| T18 | PASS, scoped inputs | 20 MiB frame, truncated incremental update, 3 MiB insertion, aggregate state cap and 200-update rate fixture; no unsafe journal write/fanout | [#1393][pr1393] | [refusal/README.md][refusal] |
| T18, malformed SyncStep2 extension | BOUNDED REJECTION; logical connection closes | Normally returning refusal precedes library snapshot-check exception; detach policy prevents republication | [#1393][pr1393] | [T18-malformed-syncstep2.json][malformed] |
| T19 (a/b) | PASS | Incremental and restart full-state permanent refusal; retained exportable replica, no post-refusal retry, deliberate fresh rejoin | [#1393][pr1393] | [refusal/README.md][refusal] |
| T19 (c) | PASS | Missing membership gives temporary refusal; upload, covering SyncStep2 receipt and subsequent Z use the same socket | [#1397][pr1397] | [images/README.md][images] |
| T22 | PASS | Journal commit in beforeSync, duplicate update, kill before debounced store, fresh process and empty late client | [#1386][pr1386] | [service/README.md][journal] |
| T22 premature receipt | **FAIL**, required defect | Positive receipt before commit; kill loses acknowledged update | [#1386][pr1386] | [T22-premature-receipt.json][premature] |
| T23 (i/ii) | PASS | Ordinary close and null-disconnect retain queue; connecting disconnect, socket replacement and early checker close discard it; reconnect difference recovers work; FIFO receipts cover later edits | [#1386][pr1386] | [service/README.md][journal] |
| T24 | PASS in Edge | Second tab read-only; renderer crash releases Web Lock; successor hydrates before editing; reload recovers deletions too | [#1395][pr1395] | [local-report.md][local], [local-evidence.json][local-data] |
| STORE, completion and M3 atomicity | PASS for own adapter; split-write control **FAIL** | Strict IDB completion, abort, quota, versionchange, renderer crash and compaction; E/N/manifest in one transaction | [#1395][pr1395] | [local-report.md][local], [STORE-M3-split.md][split-store] |
| STORE, unadapted library receipts | **FAIL** as a truthful saved signal | Initial whenSynced precedes commit; later abort leaves synced true while new identities are lost | [#1395][pr1395] | [STORE-library-initial.md][library-initial], [STORE-library-abort.md][library-abort] |
| STORE 3 | PARTIAL | Edge persistence request and actual quota failure, with/without requesting persistence; real eviction not tested | [#1395][pr1395] | [local-report.md][local], [local-evidence.json][local-data] |
| STORE 4 | PARTIAL | Offline storage hydration with harness-supplied shell; actual service-worker cold start/takeover NOT RUN | [#1395][pr1395] | [local-report.md][local] |
| STORE 5 | NOT RUN | Electron main-process credential encryption excluded | [#1395][pr1395] | [local-report.md][local] |
| STORE 6 | OBSERVED, integration still open | Real app export excludes replica/assets/credential sentinels, but standalone entry exports one history snapshot under the intended shared docId | [#1395][pr1395] | [local-report.md][local], [local-evidence.json][local-data] |
| STORE 7 | PARTIAL | Real startup module, controlled ports; last-project/draft callbacks can replace adopted state; actual shared wiring absent | [#1395][pr1395] | [local-report.md][local] |

## Decisions

### 1. Provider integration

**Selected:** keep Hocuspocus server/provider 4.8.0. No fallback provider is needed for the demonstrated integration. Validate before journal access, then await the journal worker's commit inside `beforeSync`, before live apply, positive status and fanout. Serialize candidate validation through application across connections. Permanent refusal returns normally with read-only plus a reason, then the client detaches and stops retries. Temporary refusal clears read-only after the message and retries only after its prerequisite. Malformed SyncStep2 remains a logical-close exception. ([Journal][journal], [refusal][refusal], [images][images])

If an outgoing hold is used, it must operate in the configured WebSocket transport: returning false from `outgoingMessage` cancels neither incremental sends nor reconnect SyncStep2. M3 also keeps held edits out of its private network document. The one-document transport hold proves the narrower wire property. The owned publication surface, exact frame allowlist and attach-before-sync ordering are part of that proof. ([Images, integration and H11][images])

Every replica must declare its typed roots before applying remote state, including hydration, reload and late join. The marks lane proves why: lazily promoting a formatted root to `Y.Text` loses its formatting flag and leaves a comment mark on surviving text. Eager initialization passes. This evidence comes from the schema/marks fixtures, not a full editor/server integration. ([Root-initialization result][roots], [retained failure][root-history], [root tests][root-tests])

**Rejected:** stock acknowledgements or provider counts as save evidence, asynchronous `onChange` or debounced stores as durability gates, hook exceptions as normal refusal, and a cancellable outgoing event as the hold. The observed failures below require the selected application mechanisms; they do not require a provider replacement. ([Journal][journal], [refusal][refusal], [images][images])

The lanes report no newly refuted library-source prediction. The qualified results, including corrections to broader readings, are: ([Journal observations][journal], [refusal predictions][refusal], [image facts][images], [instance facts][instance], [local P1][local])

| Row id | Confirmed result and limit | Evidence |
| --- | --- | --- |
| H1, H7 | Awaited raw beforeSync blocks apply, receipt and fanout; held onChange does not | [journal][journal] |
| H2, Y15 | Stock path acknowledges swallowed apply errors and pending dependencies. Read-only increments get negative status; covered SyncStep2 can get positive status without a new row. Malformed SyncStep2 can close | [journal][journal], [refusal][refusal] |
| H3 | Counter resets to 1 and can reach 0 with an outstanding receipt; synced is not durability | [journal][journal] |
| H4 | Ordinary close/null disconnect keep the queue; connecting disconnect, replacement and early checker close drop it | [journal][journal] |
| H5, H6 | Store errors are swallowed; scheduling/flush completion is not successful durable completion | [journal][journal] |
| H8 | Stateless refusal notices arrive; asynchronous barrier-request ordering was not tested | [refusal][refusal] |
| H9, H10 | Read-only and normally returning hooks support temporary/permanent refusal; throwing hooks close. The claim that every read-only refusal stays open needs the malformed-SyncStep2 exception | [refusal][refusal], [images][images] |
| H11 | Reconnect regenerates SyncStep2 from provider state; outgoing listener cannot cancel; transport hold works for wire publication, M3 for separate N too | [journal][journal], [images][images] |
| H12 | Public connection close leaves queued updates; a pre-sync revocation predicate stops the tested queued writes. Already admitted transactions are not cancelled | [refusal][refusal] |
| H13 | Frame cap rejects before hook entry. Unauthenticated queue-count defaults were not separately tested | [refusal][refusal] |
| H14 | Load enters broadcast batching with zero connections, but triggers no onChange/store hook | [instance][instance] |
| Y8 | Hard deletion loses payload under GC; soft-removed text survives binary reload | [instance][instance] |
| Y13 | Exported decode APIs expose the tested same-client gap, cross-client origin and delete dependency; no complete dependency validator is proved | [refusal][refusal] |
| Y14 | Pure delete leaves insertion state vector unchanged; receipt/checkpoint deletion coverage must still advance | [journal][journal], [instance][instance] |
| P1 | Existing y-indexeddb completion signals do not report per-write commit; even initial whenSynced can precede commit | [local][local] |

**Proof limits:** these are pinned-version, scoped fixtures. Authentication, durable revocation, complete quotas and production transport ownership remain integration work. Retest protocol assumptions on upgrades. ([Refusal bounds][refusal], [image limits][images])

**Disagreement:** “the worker owns the only writable connection” is true of the journal/instance lane, but false of the combined service. The image store opens another writable connection to the same SQLite database for membership. The merged evidence does not prove a single-writer-connection service including images. Stages 2/3 must reconcile that ownership requirement. ([Journal][journal], [image store description][images], [store-worker.ts][image-worker])

### 2. Receipt design

**Selected:** write-ahead journaling, one update per transaction, with receipts tracked FIFO per socket lifetime from actual sends/statuses through `WebSocketPolyfill`. Track insertion and deletion coverage, pending local edits and refused ranges; ignore old-lifetime statuses. Persist only observed positive coverage after arrival, atomically with replica bookkeeping, bound to deployment and immutable instance identity. ([Journal][journal], [refusal receipt changes][refusal], [image receipt restoration][images])

**Evidence:** T22 recovers accepted bytes after kill, including duplicate delivery. T23 recovers acknowledged, unacknowledged and queued work under each tested reconnect path. Pure deletion advances receipt coverage without advancing the state vector. Refused already-covered snapshots need no new journal row; an uncovered insertion/deletion cannot use that exception. ([Journal][journal], [covered snapshot history][covered])

**Rejected:** provider counters, state-vector-only coverage and store-hook promises do not carry the save promise. The barrier fallback is not needed for this selection; T14 and T15 were not run. Their absence is not a passing barrier result. ([Journal][journal], [plan §8][plan], [experiment index][experiments])

**Proof limits:** no acknowledgement precedes the matching pong while the harness holds the write lock, and exact bytes survive the tested kills. Neither observation proves ordering inside the window between acquiring the writer lock and `COMMIT` returning. An after-unlock, before-COMMIT acknowledgement escapes the deterministic harness. That window rests on code structure: Hocuspocus awaits `beforeSync`; the hook awaits append; the worker replies only after synchronous COMMIT returns. This is a property review must preserve, not a tested ordering proof. ([Journal accepted limit][journal], [undetected mutation][unlock], [#1386][pr1386])

Restored receipts are bound to a server instance. Restoring an older server backup under the same identifier can still make them stale. Identifier matching does not detect rollback. The plan's isolated restore with fresh instance identities remains necessary; same-identifier rollback recovery is unproved. ([Image receipt limit][images], [plan §10][plan])

### 3. Image design

**Confirmed by the product owner on 2026-11-09.** Use the pending-image contract: reference and later text may synchronize while bytes are absent; the pending flag clears only after durable membership, and saved status still waits for required bytes and the covering receipt. Reconnect, duplicates, late peers, reload/retry and uploader-never-returns cases pass. In the last case, text and placeholder survive server restart and export lists the missing image. ([#1405, Product decisions][pr1405], [Images][images], [plan §7][plan])

**Rejected:** upload-before-sync passes the complete literal T16 row with two documents and a private bridge/read-only N. With one document it passes the wire/server condition but **fails separate-N isolation**. Thus evidence does not say two documents are unavoidable solely for server image durability. Both upload-first variants hold text after the picture; one document also holds previously queued text. The editing lane is expected to select a one-document buffer; its selection belongs in the separate 1a record. This record selects no editing mechanism. ([Image comparison and retained N failure][images], [T16-one-document-N.json][one-n], [stage separation in §11][plan])

**Proof limits:** the product owner approved the change to the server half of INV-52 on 2026-11-09. The wording in `docs/architecture/invariants.md` changes with the implementation. ([#1405, Product decisions][pr1405]) Placeholder appearance, never-returning-uploader handling and incomplete-export presentation remain product questions. The blob fixture uses fixed-instance loopback access, PNG header checks and modeled local completion. It does not prove production authorization, full decoding, complete manifests or local crash durability. T13/T17 image P remains open; a lane is connecting it now. ([Images][images], [instance image seam][instance], [plan §7][plan])

### 4. Local storage

**Selected:** the project's own completion-true replica store, with one writable tab per deployment/instance through a Web Lock. Capture bytes, sequence, manifest and asset inputs synchronously; report saved only after strict IDB transaction completion. Hydrate before editing or synchronization. Failures preserve newer in-memory work and the previous committed generation. ([Local report][local])

**Evidence:** Edge exercises lock refusal/crash handoff, held hydration, reload, pure deletion, transaction abort, actual quota exhaustion, versionchange and compaction. Deliberate unlocked-write, premature-save and early-edit defects are rejected. E/N and metadata can commit atomically; separate writes fail the crash-between-writes control. ([Local report][local], [local evidence][local-data], [split-write history][split-store])

**Rejected:** unadapted y-indexeddb 9.0.12 cannot supply a truthful saved receipt. Its initial whenSynced and custom set promise can precede commit, and synced remains true after a failed later write. A harness commit fence makes recovery testable but is not a library receipt interface. ([Local comparison][local], [initial history][library-initial], [abort history][library-abort])

**Proof limits:** renderer-crash recovery in one Edge profile is not browser-process restart, physical power loss, eviction or desktop durability. Successful atomic assets were one byte. IDB cannot transact across the existing separate blob and replica databases; production may await blob completion first, then atomically commit replica state and manifest. The handoff lane assumes an atomic membership/creation envelope that the browser store does not yet implement. ([Local report][local], [instance local-interface assumption][instance])

## Measured numbers

All commit rows below are milliseconds, copied without pooling rounds or recalculating. Timing covers BEGIN, inserts and FULL COMMIT, excluding encoding, batch wait and worker IPC; automatic WAL checkpointing is disabled. Three fresh databases per row supply 150 typing updates at 100 ms intervals or 3000 burst updates, each 10–12 bytes. Five-update batches are writer-cost experiments, not integrated batching; nominal typing batch wait can add 400 ms. ([Measurement method][journal], [#1401][pr1401])

| Disk / round | Workload | Updates per transaction | Transaction p50 / p95 / max | Amortized per update p50 / p95 / max |
| --- | --- | --- | --- | --- |
| PC NTFS | Typing | 1 | 0.8851 / 1.0767 / 2.7717 | 0.8851 / 1.0767 / 2.7717 |
| PC NTFS | Burst | 1 | 0.5428 / 0.6787 / 4.9420 | 0.5428 / 0.6787 / 4.9420 |
| PC NTFS | Typing | 5 | 1.0191 / 4.8282 / 4.8459 | 0.2038 / 0.9656 / 0.9692 |
| PC NTFS | Burst | 5 | 0.5709 / 0.7018 / 5.0754 | 0.1142 / 0.1404 / 1.0151 |
| Unraid direct cache / 1 | Typing | 1 | 8.8208 / 10.1829 / 12.4284 | 8.8208 / 10.1829 / 12.4284 |
| Unraid direct cache / 1 | Burst | 1 | 8.0509 / 10.4187 / 217.9055 | 8.0509 / 10.4187 / 217.9055 |
| Unraid direct cache / 1 | Typing | 5 | 10.2767 / 11.9339 / 44.4500 | 2.0553 / 2.3868 / 8.8900 |
| Unraid direct cache / 1 | Burst | 5 | 68.2134 / 92.7027 / 772.9672 | 13.6427 / 18.5405 / 154.5934 |
| Unraid direct cache / 2 | Typing | 1 | 8.3322 / 9.2634 / 10.0971 | 8.3322 / 9.2634 / 10.0971 |
| Unraid direct cache / 2 | Burst | 1 | 8.6437 / 44.0999 / 715.8849 | 8.6437 / 44.0999 / 715.8849 |
| Unraid direct cache / 2 | Typing | 5 | 10.5312 / 11.3289 / 12.2711 | 2.1062 / 2.2658 / 2.4542 |
| Unraid direct cache / 2 | Burst | 5 | 7.3998 / 8.3641 / 9.2935 | 1.4800 / 1.6728 / 1.8587 |
| Unraid FUSE user share / 1 | Typing | 1 | 8.5619 / 9.7468 / 14.4358 | 8.5619 / 9.7468 / 14.4358 |
| Unraid FUSE user share / 1 | Burst | 1 | 8.9944 / 44.8379 / 442.4210 | 8.9944 / 44.8379 / 442.4210 |
| Unraid FUSE user share / 1 | Typing | 5 | 13.2255 / 50.4934 / 125.4468 | 2.6451 / 10.0987 / 25.0894 |
| Unraid FUSE user share / 1 | Burst | 5 | 9.2561 / 12.2472 / 18.6125 | 1.8512 / 2.4494 / 3.7225 |
| Unraid FUSE user share / 2 | Typing | 1 | 9.7169 / 12.2895 / 14.8783 | 9.7169 / 12.2895 / 14.8783 |
| Unraid FUSE user share / 2 | Burst | 1 | 8.7603 / 43.7443 / 893.1075 | 8.7603 / 43.7443 / 893.1075 |
| Unraid FUSE user share / 2 | Typing | 5 | 10.2259 / 11.7921 / 18.6649 | 2.0452 / 2.3584 / 3.7330 |
| Unraid FUSE user share / 2 | Burst | 5 | 8.5674 / 10.8879 / 397.6295 | 1.7135 / 2.1776 / 79.5259 |

Sources: [PC raw data][pc-cost]; Unraid direct cache [round 1][cache1], [round 2][cache2]; the same disk/folder through FUSE [round 1][user1], [round 2][user2]; [method and interpretation][journal]. Both use Node 24.22.1 and SQLite 3.53.4. PC: Windows x64, NTFS. Unraid: one Crucial MX500 1 TB SATA SSD, btrfs, kernel 6.18.58-Unraid; a measurement-only container with 2 CPUs/2 GB on a live server, load average 0.21 before and 0.66 after. The raw Unraid scope labels are obsolete; the report identifies their actual scope. ([Journal report][journal])

The one-update burst tail reaches 893.1075 ms and is unexplained. The 68.2134 ms/transaction cache round-1 batch-five burst row was not reproduced in round 2. The runs neither isolate tail causes nor establish a performance difference between paths; similar FUSE timing proves no WAL safety. The report's roughly 111–124 updates/s from reciprocal median commit costs is not measured sustained throughput. ([Journal interpretation][journal], [#1401][pr1401])

Worker overhead is **about 0.040 ms median, 0.073 ms p95 over 300 updates**. This is a supplied reviewer measurement reported by the journal lane, not a retained standalone raw run or a measurement repeated here. The process-kill sample recovered exact rows in **200/200** honest runs; the after-unlock mutation lost rows in **97/200 (48.5%)**, escaping **103/200**, over **78.6 seconds** for both sets. It is probabilistic, not an ordering proof. ([Journal][journal], [ack-kill data][kill-data])

Recovery used five fresh 3000-update histories per case on the PC NTFS volume, Windows 10.0.26300, Ryzen 9 9950X3D2, Node 24.22.1. Checkpoint at 2500 edits, 500-row tail; caches were not flushed. Replay includes worker RPC/validation/encoding; restart/join includes child startup and completed local-model hydration. ([Instance method][instance], [raw samples][recovery-data])

| Case | Replay ms median (range) | Restart/hydrated join ms median (range) | Journal rows / payload bytes | Checkpoint bytes | Allocated database bytes |
| --- | --- | --- | --- | --- | --- |
| Whole journal | 27.593 (23.103–32.129) | 350.414 (322.470–377.765) | 3,001 / 35,818 | 0 | 212,992 |
| Checkpoint plus tail | 11.766 (10.327–12.601) | 337.299 (315.274–382.694) | 500 / 6,000 | 2,582–2,583 | 188,416 |

Child startup dominates restart/join and ranges overlap. Soft-retaining 10/100 independent 100-character removed texts measured about **1.3/12.9 KiB**, varying with client-id encoding. These are fixture measurements, not capacity budgets. ([Instance report][instance])

Other recorded bounds: Edge **157.0.4341.42** passed **26/26** browser storage cases; a **1 MiB** quota override caused a **16 MiB** asset write to fail. The image lane recovered acknowledged tiny and **2 MiB** uploads after kill and refused **16 MiB + 1**. Refusal's **200** updates in a frozen one-second window produced **50** accepts and **150** temporary refusals before successful retry. Combined prototype validation in #1397 recorded **1,179/1,179**, including **106/106** service records and **30** image records. These are prior lane results; this record runs no experiments. ([Local][local], [images][images], [refusal][refusal], [#1397][pr1397])

## What the plan's deliverable asked for and did not get

| Deliverable noun | What exists and what is missing | Evidence |
| --- | --- | --- |
| Hocuspocus 4.8.0 container | Feasibility server ran as a Node child process, **not a container**. The separate disk benchmark used a container; it is not the service container deliverable | [journal][journal], [service harness][service-harness], [#1401][pr1401] |
| Journal and receipts | Worker journal, WAL/FULL readback, replay, FIFO insertion/deletion receipts, scoped checkpoint/prune recovery; accepted ordering limit and same-identifier rollback gap remain | [journal][journal], [instance][instance], [images][images] |
| Local storage | Browser completion-aware adapter and comparison exist; desktop store and atomic handoff catalogue extension do not | [local][local], [instance][instance] |
| Image ordering | Both candidates tested; pending selected here. T13/T17 image connection and production assets remain | [images][images], [instance][instance], [plan §7][plan] |
| One-tab lock | Browser Web Lock crash/handoff and hydration gate exist; desktop source/key registry and its lifecycle tests remain | [local][local] |
| Harness support for two clients | Node service harnesses run multiple real providers/sockets with a late third client, independent journal reads and kill gates. Browser local harness creates separate page targets in one Edge profile for same-origin second-tab tests. No browser/editor-to-service or packaged-desktop two-client workflow is established | [service harness][service-harness], [image harness][image-harness], [instance tests][instance-tests], [browser helper][browser-helper], [local scope][local] |

## Not measured or not run, carried forward

- Desktop/Electron replica storage, filesystem/IPC completion, credential safeStorage on target systems, tab ownership/restore/close and delayed IPC. ([Local][local])
- Actual service-worker cold start and skipWaiting takeover, other supported browsers, storage eviction and browser-process restart. Offline storage hydration used a supplied shell. ([Local][local])
- Successful large assets in one local transaction: atomic success used one-byte assets; the 16 MiB test proves quota failure only. ([Local][local])
- Image P in T13/T17 is open; a lane is closing it now. Neither text-only trace nor separate T16 establishes that connection. ([Instance][instance], [images][images], [#1377][issue])
- Integrated burst batching, end-to-end receipt latency, sustained writer throughput, admission/projection CPU and memory cost, and recovery timing on the deployment disk. ([Journal][journal], [images][images], [instance][instance])
- Power loss, directory-metadata durability and disk/device loss. Process kills and WAL/FULL configuration checks do not prove these. No physical power-loss experiment is planned. ([Journal][journal], [images][images], [local][local], [plan §8][plan])
- Production invitation/HTTP authorization and revocation, complete work/asset quotas, full image decoding, backup rollback under the same identifier, and actual shared startup/export/history wiring. ([Refusal][refusal], [images][images], [local][local], [instance][instance])

## Requirements this places on Stages 2 and 3

- Declare all typed roots before remote hydration/replay, late join and reload; retain the root-initialization regression controls. Source: [mark-results.md][roots].
- Preserve the reviewed commit-before-status chain; register local update obligations and observe actual socket lifetime/sends/statuses. Restore only observed positive, instance-bound coverage with matching replica bookkeeping; cover deletes and refused ranges separately from state vectors. Sources: [service/README.md][journal], [refusal/README.md][refusal], [images/README.md][images].
- Serialize pre-journal validation through live application; implement persistent admission/revocation, recheck queued work, own the dedicated or multiplexed transport, retain permanent refusal without retries, and clear temporary refusal only after covering success. Expose reason/rejoin and standalone export over retained local state without publishing it. Sources: [refusal/README.md][refusal], [images/README.md][images].
- Gate edits and sync on completed hydration and ownership. Capture binary state, sequence, manifest/assets synchronously; report transaction completion/failure, invalidate on versionchange, retain unsaved memory and enforce deployment/instance isolation. If E/N exist, persist both with metadata atomically. Extend that transaction with membership/creation/transition state; keep credentials separate. Sources: [local-report.md][local], [instance/README.md][instance].
- Supply real Operations capture/stillOwns ownership, persisted creation key/g0 and intervening-update journal; check ownership around the final local commit, make catch-up/handover atomic, and publish invitations only after both persistence contracts. Preserve the source file/id/history; exports get independent ids. Source: [instance/README.md][instance].
- Disable/drain standalone automatic writers and invalidate accepted save/open/carry callbacks before authority changes. Guard First Save/Save As, late Open adoption, Copy/Move, bundle inspection/relink and Save As carry; exclude live-instance revision/id/undo changes from standalone completion. Source: [instance/README.md][instance].
- Add a shared hydration/source path that excludes standalone whole-document adoption, draft/stash/last-project replacement and history/app-data export capture. Desktop needs a deployment/instance routing key, restore metadata and crash/duplicate-open/close/quit/IPC checks. Sources: [instance/README.md][instance], [local-report.md][local].
- Complete local blob storage before referenced local saves; enumerate assets in live, recovery, undo and checkpoint state, verify downloads before local saved status, and connect durable-membership checks into handoff/checkpoints. Implement durable pending/upload-retry/flag transitions, placeholder and missing-image export disclosure; check ownership of delayed picture/thumbnail/annotation callbacks. Bundle copy remains outside shared mode. Sources: [images/README.md][images], [instance/README.md][instance], [local-report.md][local].
- Capture checkpoint bytes and covered sequence together, verify before installation/pruning, reject stale completions/write failures, preserve pending dependencies/deletions and refuse incomplete recovery. Select a periodic policy; keep real membership/asset coverage in that contract. Source: [instance/README.md][instance].
- If any publication hold remains, install it before provider attachment/reconnect and own every publication path; use the pinned transport controls and private bridge/read-only N where applicable. Reevaluate framing/ownership on provider upgrades. Sources: [images/README.md][images], [service/README.md][journal].

## Open questions for the product owner

- What should the permanent-refusal/export-and-rejoin message and temporary-refusal/retry message say? ([Refusal placeholder wording][refusal])
- What does a pending picture show to other people, and how does it explain that its bytes have not arrived? ([Image selection boundary][images], [plan §7][plan])
- What should people be able to do with a picture whose uploader never returns? ([Never-returns fixture][images])
- How should export disclose missing pictures before a person accepts an incomplete standalone copy? ([Image export boundary][images], [plan §7][plan])

[plan]: ../../COLLABORATION-PLAN.md
[experiments]: ../stage-0/9-stage-1-experiments.md
[issue]: https://github.com/RetroGorilla/splitpage/issues/1377
[pr1386]: https://github.com/RetroGorilla/splitpage/pull/1386
[pr1393]: https://github.com/RetroGorilla/splitpage/pull/1393
[pr1395]: https://github.com/RetroGorilla/splitpage/pull/1395
[pr1397]: https://github.com/RetroGorilla/splitpage/pull/1397
[pr1398]: https://github.com/RetroGorilla/splitpage/pull/1398
[pr1401]: https://github.com/RetroGorilla/splitpage/pull/1401
[pr1405]: https://github.com/RetroGorilla/splitpage/pull/1405
[journal]: ../../../prototypes/collab/src/service/README.md
[refusal]: ../../../prototypes/collab/src/service/refusal/README.md
[instance]: ../../../prototypes/collab/src/service/instance/README.md
[images]: ../../../prototypes/collab/src/service/images/README.md
[local]: ../../../prototypes/collab/local-report.md
[local-data]: ../../../prototypes/collab/local-evidence.json
[one-n]: ../../../prototypes/collab/histories/T16-one-document-N.json
[malformed]: ../../../prototypes/collab/histories/T18-malformed-syncstep2.json
[premature]: ../../../prototypes/collab/histories/T22-premature-receipt.json
[split-store]: ../../../prototypes/collab/histories/STORE-M3-split.md
[library-initial]: ../../../prototypes/collab/histories/STORE-library-initial.md
[library-abort]: ../../../prototypes/collab/histories/STORE-library-abort.md
[roots]: ../../../prototypes/collab/mark-results.md#corrected-root-initialization-result
[root-history]: ../../../prototypes/collab/histories/T11-fully-deleted-A.md
[root-tests]: ../../../prototypes/collab/test/marks/root-initialization.test.ts
[image-worker]: ../../../prototypes/collab/src/service/images/store-worker.ts
[covered]: ../../../prototypes/collab/histories/review-covered-syncstep2.json
[unlock]: ../../../prototypes/collab/histories/ordering-after-unlock-ack.json
[pc-cost]: ../../../prototypes/collab/test/service/commit-cost.local.json
[cache1]: ../../../prototypes/collab/test/service/commit-cost.unraid-cache.round-1.json
[cache2]: ../../../prototypes/collab/test/service/commit-cost.unraid-cache.round-2.json
[user1]: ../../../prototypes/collab/test/service/commit-cost.unraid-user.round-1.json
[user2]: ../../../prototypes/collab/test/service/commit-cost.unraid-user.round-2.json
[kill-data]: ../../../prototypes/collab/test/service/ack-kill.local.json
[recovery-data]: ../../../prototypes/collab/test/service/instance/recovery.local.json
[service-harness]: ../../../prototypes/collab/test/service/harness.ts
[image-harness]: ../../../prototypes/collab/test/service/images/harness.ts
[instance-tests]: ../../../prototypes/collab/test/service/instance/instance.test.ts
[browser-helper]: ../../../prototypes/collab/src/local/browser.ts
