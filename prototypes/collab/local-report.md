# Local replica and tab ownership feasibility

T24 passes in headless Edge with the completion-aware IndexedDB adapter. All three defective implementations are rejected first. M3's two binary documents and image manifest can commit atomically in one database; separate transactions produce the predicted inconsistency. `y-indexeddb` 9.0.12 cannot supply a truthful per-write saved receipt through its existing completion interface.

This is browser feasibility evidence, not a complete STORE gate. Cross-browser eviction, actual service-worker cold start/takeover and target-platform `safeStorage` remain unrun. STORE 7 exercises the existing startup module with controlled ports; actual shared-session integration still needs checking.

## Reproduction and scope

Recorded runtime: Node **24.22.1**, Windows x64, **Edg/157.0.4341.42**, revision `@7b1486be4607d53d9f93841b7c776bc525ca74b7`. The full browser version object is in [local-evidence.json](local-evidence.json). Packages are pinned: `yjs` 13.6.33 and `y-indexeddb` 9.0.12. The latter is one prototype-only development dependency, used solely for comparison.

From the repository root, install the root dependencies needed by the build/gates and run `node build.mjs --test`. From `prototypes/collab`, run `npm ci`, then:

```powershell
$env:TEMP='C:\Users\Gorbus\AppData\Local\Temp\splitpage-lanes\s1b-local-store'
$env:TMP=$env:TEMP
& D:\vibecoding\Splitpage\tools\with-lock.ps1 -Lock smoke -Owner s1b-local-store -Command 'npm run local'
npm test
```

`npm run local` runs 26 browser experiments under `node --test`; it is outside `npm test`. It regenerates the evidence and six minimized histories. `npm test` checks the retained evidence without starting a browser. The slice's `SliceProtocol` and `withSliceBrowser` are imported unchanged. One Edge process uses a temporary profile, with separate page targets in that profile, and is closed in `finally`. CDP fulfills the fixture HTTPS documents, so there is no HTTP server or collaboration service. STORE 6 loads the unmodified built app and uses its existing test hooks; STORE 7 bundles the unmodified `src/bootstrap/startup.ts` entry separately and invokes its existing ports. Neither adds an app hook or changes app source.

## Oracle and ordering

The harness owns the submitted updates and literal identity oracles: generation 1 is `a=s1`, 2 is `ab=s1 a1`, 3 is `abc=s1 a1 a2`, and 4 deletes `a1`, leaving `ac=s1 a2`. These are storage fixtures, not new editing traces. A harness ledger records the generation the harness submitted when it observes `Saved on this device` in the page's status element; it is not reconstructed from the tab's diagnostic saved-generation list. The refusal explanation is also rendered in the page. Recovered binary documents go through the existing `readReplica` and `checkModel` identity checker. Pure deletion is covered despite its unchanged Yjs state vector.

Before positive cases, a defect writes generation 2 while another tab holds the named Web Lock; the browser's lock query observes that lock and a later transaction observes the unauthorized identity. The generation-1 oracle rejects it. A second defect reports saved with its transaction held open; `Page.crash` then loses that reported generation and the harness ledger rejects recovery. Histories: [unlocked write](histories/T24-local-unlocked-write.md), [premature local save](histories/T24-local-premature-save.md).

The test fixture intercepts real IDB transaction creation and keeps selected transactions active with a chain of read requests until the harness releases them. It can also abort a real transaction. These probes belong to the harness, outside the adapter. A timeout can only reject a missing event. No pause, idle interval or missing notification establishes absence. Fresh-tab reads, completed readonly transactions ordered behind writes, and explicit transaction/request events establish the negative results. Renderer crashes use `Page.crash` and require `Inspector.targetCrashed`, rather than closing the target politely.

## T24 and candidate comparison

T24's first tab acquires the lock named by the JSON tuple `(deployment, instance)`, hydrates, and saves all four generations. A second tab is read-only, explains why, and refuses editing. After the first renderer crashes, the second retries, acquires the released lock, hydrates, and becomes writable. The harness ledger `[1,2,3,4]` is covered by recovered identities, including the deletion. A separate held-hydration test awaits an entry event emitted inside the acquired lock callback before attempting an edit; a harness-held storage transaction keeps hydration incomplete. The edit is refused until that gate is released, then editing succeeds. A defect that enables editing on lock acquisition is rejected by the same checker ([history](histories/T24-local-early-edit.md)). Another test performs an actual `Page.reload`, then recovers both saved generations and reacquires ownership.

| Situation | Completion-aware adapter | `y-indexeddb` 9.0.12 |
| --- | --- | --- |
| Truthful meaning of saved | The captured E/N bytes, sequence, manifest and required asset records completed a strict IDB transaction. A later in-memory edit remains pending. | `synced`/`whenSynced` describe initial loading, not later write coverage. Even initial `whenSynced` and the custom `set()` promise can resolve while their transaction remains uncommitted. No per-write saved claim follows from these APIs. |
| Aborted transaction | Promise rejects; no new receipt; status becomes `Could not save on this device`; newer in-memory identities remain; a fresh hydration reads the previous committed generation. | A real aborted update loses the new identity on recovery while `synced` remains true. Its internal request rejection does not become an application write receipt. |
| Quota exhaustion | CDP reports an active 1 MiB quota override; a 16 MiB required asset fails with `QuotaExceededError`; generation 2 remains in memory, generation 1 remains on disk. Tested both without requesting persistence and after requesting it. | A 16 MiB CRDT value produces a real `QuotaExceededError` transaction abort. `synced` stays true; after crash the value is absent and prior identities remain. |
| Another tab upgrades the database | `versionchange` closes the old connection, invalidates writable ownership and releases the lock. An old version-1 opener receives `VersionError` against version 2. | Its lib0 helper closes the connection, allowing the upgrade. A later update on that connection throws `InvalidStateError`; `synced` remains true. The library itself does not invalidate the enclosing writable session. |
| Renderer crash mid-write | A held, uncompleted write is absent on fresh hydration; all earlier reported saved generations remain. | A held later update is absent after crash while the pre-crash `synced` flag was true. Initial `whenSynced` can likewise precede loss of its initial state. |
| Successful restart/compaction | Saving replaces the complete binary checkpoint and metadata atomically. The delete checkpoint reloads with the original surviving identities. | A readonly commit fence establishes actual completion; explicit `storeState` compaction reduces journal count and recovers the delete and surviving identities after crash. That fence is harness instrumentation, not an existing library receipt. |

Named browser cases in [run.ts](src/local/run.ts) assert each row. The retained-evidence tests repeat their identity and status assertions. The adapter captures both documents, sequence, manifest and copies of supplied asset bytes synchronously before queuing its first asynchronous operation. The `minimal: transaction gate...` case mutates the live documents, manifest and asset bytes before release, then proves that only the earlier capture was committed. Missing required assets abort the whole transaction.

The guarantee tested is renderer-crash recovery after IDB completion, subject to origin/profile retention. Strict durability is requested and read back on the transaction. This is not a physical power-loss, disk-loss, browser-process-restart, storage-clearing or eviction experiment. Neither candidate can turn a browser storage grant into protection from those events.

## M3 atomicity

`M3 capture` deliberately persists distinct E and N states and recovers each unchanged. Equality between the two is not a store requirement.

The split-write control starts with E/N/metadata at generation 1, commits only N at generation 2, then crashes. Fresh hydration has N at 2 and E/metadata at 1; the checker rejects it. [Minimized history](histories/STORE-M3-split.md).

The atomic control shares one strict transaction across both document records, metadata/image manifest and asset records. It waits for the new N `put` request to succeed, holds that transaction active before issuing the other records, and crashes. The fresh tab observes the complete old generation and old manifest; the new asset is absent. A subsequent completed adapter save recovers both new documents and the expanded manifest. This supplies the causal crash-between-writes control as well as the successful commit case.

The successful atomic cases use one-byte assets. A successful large-asset transaction is unmeasured; the 16 MiB case establishes only quota failure.

The prototype co-locates these records to test IDB atomicity. IndexedDB does not offer one transaction spanning the app's existing separate blob and replica databases. Production can keep its existing blob store and await blob durability before the replica transaction; E, N, sequence and the manifest must still share the replica transaction. This prototype does not replace or modify the app's blob store.

## STORE questions 3 to 7

| Question | Run and observation | Remaining boundary |
| --- | --- | --- |
| 3: persistent storage and pressure | `STORE 3` records `persisted()` before the request and `persist()` afterward. The quota case uses fresh origins with and without that request, checks CDP's override readback and proves a failed write by a later hydration. | Edge on Windows only. A grant and a quota failure do not establish which data is evicted under real storage pressure. Other supported browsers and eviction remain unresolved. |
| 4: offline cold start and takeover | `STORE 4` closes the saved tab, enables CDP offline mode in a fresh tab, and hydrates retained identities with the shell supplied by the harness. | This proves offline access to storage once code is available. It does not install the actual service worker, prove shell availability at cold start or exercise `skipWaiting`. Those need a hosted app experiment, outside this no-server run. |
| 5: desktop credential encryption | Not run: this lane is browser-only and explicitly excludes Electron. | `safeStorage.isEncryptionAvailable()` must run in the actual main process on the target Windows, macOS and Linux installations. A browser surrogate would not answer it. |
| 6: history and app-data export | `STORE 6` opens a literal intended shared docId through today's standalone entry, triggers a genuine before-opening capture, waits for history idle, and reads the real export bundle. Exactly one snapshot under that id is exported. Committed same-origin replica/asset and separate credential sentinels are excluded from that bundle. | No shared session/source exists yet. Its integration must prevent the observed standalone snapshot capture from exporting live shared content. The separate replica is excluded by today's allow-list. |
| 7: asynchronous hydration ordering | `STORE 7` runs the real `beginStartup` with a harness-held `load` promise and logs the ports it calls. Browser: hydrate, boot open, first draw, `resumeLastProject`, identity/history setup. Desktop-shaped ports: desktop mounts before hydration; an early delivered open-file callback runs before boot adoption; `applyTakenDraft` runs after boot/first draw. The supplied replacement callbacks leave the last project or draft current. | These are real startup scheduling results with controlled boundary callbacks, not real file handles, IPC or draft backends. Shared wiring must prevent those replacement paths from replacing a shared instance. Repeat through actual shared-session wiring when it exists. |

STORE 5 has no claimed passing surrogate. The unresolved rows also appear explicitly in the generated evidence. Neither the partial STORE 4 observation nor the controlled STORE 7 callbacks are represented as an end-to-end desktop/offline-shell success.

## Desktop carryover and integration requirements

The synchronous binary capture, per-operation sequence coverage, manifest requirement and independent receipt/identity checker can be reused as contracts. Their storage completion must be implemented and tested against the main-process filesystem/IPC boundary. The Web Lock crash/handoff, IndexedDB quota and versionchange, browser persistence grant, and service-worker results do not establish desktop filesystem behavior.

Artifact 6's desktop ownership rows still apply: only file-backed tabs have a path routing key; `blank` has none; unknown shared source kinds are normalized away; duplicate docIds are reassigned rather than refused. Shared desktop tabs need a distinct source/key for `(deployment, instance)` in the main-process registry and restore metadata. They require their own crash, duplicate-open, restore, close/quit and delayed-IPC experiments. No Electron behavior was built or inferred from the browser result.

Real integration must also gate editing and synchronization on hydration, invalidate the session on versionchange, suppress standalone history/draft/file-resume replacement for shared sources, keep credentials outside the replica and export, and preserve deployment/instance lifecycle isolation. Replacing an instance must use a fresh identity; this browser-only prototype does not implement the service's lifecycle tombstones. Server replay behavior H14 and GC/recovery policy Y8 are not newly established by these local-store experiments.

P1 is confirmed, with a stronger initial-sync counterexample: [whenSynced history](histories/STORE-library-initial.md). No library prediction or literal expected result was changed. The library abort history is [retained here](histories/STORE-library-abort.md).

## Validation

The browser script passes 26/26 cases, including the deliberate defects, actual renderer crashes, real quota aborts, version upgrades, a reload, the M3 controls and the real-app export experiment. The prototype suite passes 895/895 tests, including 19 added identity, receipt and retained-history checks that do not open Edge. Lint, typecheck, dependency and comment gates pass. No app unit/browser/desktop suites or servers are part of this lane. The Edge instance and its temporary profile are disposed in `finally`.
