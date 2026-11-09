# Splitpage collaboration implementation plan

This is the plan of record for collaboration, dated 2026-11-09 and revised the same day after two independent reviews of Stages 0 to 3 converged, and again after a third review reconciled it with `main`. Repository baseline: `439df59535d56e68e010938d328d4b2af38e59af`. Provider facts below were checked against the `@hocuspocus/server` and `@hocuspocus/provider` 4.8.0 packages, the published version on that date. Nothing is built or deployed. Collaboration remains separate from the current release until added to its scope. Implementation starts with an audit and a feasibility prototype; the shared document schema becomes a production decision only after the prototype passes.

It supersedes two earlier drafts. The 2026-11-06 plan chose peer-to-peer Yjs over `y-webrtc` with only a signalling server. That was dropped because `y-webrtc` has had no release since 2023, Chromium drops data-channel messages over 256 KiB so large scripts cannot sync through it unmodified, and a guest sees nothing when every other participant is offline. The trade is simpler hosting for availability, and the server now stores readable script content. An earlier 2026-11-09 draft of this server-based plan fixed one narration schema in advance; this version makes the schema a feasibility outcome instead.

## 1 Purpose and decisions

Build collaboration for a trusted group of two to six people. A participant can open a shared script when nobody else is online, edit with others, keep working through a connection outage, and export an independent file. Existing standalone editing and the `.splitpage` format remain supported.

Use Yjs for shared state, a central WebSocket service for synchronization, persistent local replicas, and durable server storage. Start with Hocuspocus as the server candidate. Deploy one server instance on Unraid behind the existing Cloudflare tunnel after the release gates pass. Keep a move to another host possible without making a second deployment platform part of the first release.

The difficult work is the editing model: preserving text identity through beat and scene changes, applying buffered browser edits, selective undo, and recovering concurrent edits to removed content. Server selection must support that work, but cannot solve it.

| Decision | Proposed choice | What remains to prove |
| --- | --- | --- |
| Shared state | Yjs is authoritative; readers use a read-only projection | Complete model coverage and acceptable projection cost |
| Transport | One WebSocket provider, with Hocuspocus evaluated first | Admission, revocation, durability receipts and media ordering through supported interfaces |
| Server storage | SQLite update journal, checkpoints, access metadata and a separate blob directory on one volume | Crash durability, bounded growth and consistent backups |
| Local storage | A completion-aware replica adapter written for this plan; IndexedDB in the browser, a main-process store on desktop | Restart, quota failures and the desktop storage boundary |
| Tabs | One writable tab per instance on a device | Lock handoff, release after a crash and the refusal message |
| Image ordering | Compare upload-before-sync with a pending-image contract | Which one keeps the principle of INV-52 through supported interfaces |
| Browser delivery | The collaboration server serves the built app from one path on its own host | Updates, compatibility with older desktop builds and the connection-policy change |
| Narration schema | Prototype a document-wide sequence first; compare stable text segments if needed | Normal writing, scene changes, deletion recovery and structural undo |
| Access | Owner management access and individually named editor invitations | Credential lifecycle and immediate revocation |
| Desktop entry | Paste Invite Link | Browser-to-desktop handoff can be added later |
| Browser offline behavior | Continue editing while the app is loaded; recover persisted work when the app can load again | No unconditional offline cold-start promise in v1 |
| Presence | Participant names and connection state | Remote cursor and selection decoration follows the editing gates |
| Hosting | One continuously running instance for the limited release | Measured resources, restore drill and deployed smoke checks |

Words follow the [glossary](GLOSSARY.md). A **beat** is a row; a **scene** groups beats under a header. The file model calls those headers `sections`, anchored by `firstSceneId`. A **collaboration instance** has its own identity, CRDT state and access records. A **standalone copy** is an ordinary file with no live instance connection. A **local replica** is the persistent shared state held on one device.

## 2 Product contract

### Participants and ownership

Only the deployment owner can create instances, issue or revoke invitations, and delete server copies in v1. Invited participants can edit and export. Display names and existing attribution fields are not verified identities or an audit trail.

Each invitation is a separately revocable capability, normally labeled for its intended recipient. Forwarding a link also forwards its access. Leaving on one device removes that device's membership; it does not revoke a copied invitation elsewhere.

### Required experience

1. The owner opens a standalone script and chooses Collaborate.
2. Splitpage prepares an instance while preserving the original script and edits made during preparation.
3. The instance becomes joinable only after its initial state and required images are durable on the server and the local handoff is recoverable.
4. A new participant opens an invitation and loads the script without another participant online.
5. Participants edit narration, visuals and existing document fields, and undo their own actions without replaying another person's edits.
6. Connection failures leave the loaded script editable. Status distinguishes local persistence, pending synchronization and refused access.
7. Participants can export independent standalone copies. Recovery content and missing assets are disclosed before an export is represented as complete.

Normal writing is mandatory: typing, formatting, Enter, boundary Backspace, Alt+Backspace, cross-beat selections, ordinary text copy and paste, paste within a beat, and creating or removing scene headers. Keep current limits and refusal rules where they already apply. Collaboration must not disable these operations to work around a schema failure.

IME is a data-safety requirement, not a tuning target. [WRITER-FLOW-PLAN.md](WRITER-FLOW-PLAN.md) section 4 already fixes the rule: nobody on the project uses an IME, IME-only bugs go on the never-do list, and the one promise is that composed text is never discarded. Shared mode keeps exactly that promise, proven with synthetic composition events through the existing harness. No native OS IME sessions and no human IME acceptance task are part of any gate.

Explicit beat or scene reordering and structural cut-and-paste may be unavailable in shared mode until their concurrency gates pass. A refusal happens before changing document content or consuming a cut operation. This is the only proposed editing restriction; any broader restriction changes the product contract.

### Offline guarantees

| Situation | V1 guarantee |
| --- | --- |
| Loaded browser app loses the network | Editing continues; confirmed local writes survive an ordinary restart, subject to browser storage retention |
| Browser restarts without a network | Data remains in local storage, but reopening the hosted app is not guaranteed |
| Browser can load the app again | Hydrate the retained replica before opening it for edits or synchronizing |
| Desktop restarts without a network | Reopen the saved local replica and continue editing |
| Server is unavailable | Existing loaded replicas continue locally; first-time joins and server synchronization wait |
| Access has been revoked | Retained work remains available for export; publishing to that instance stops |

Browser eviction, private browsing and storage clearing are distinct from a failed write. Request persistent storage where supported and explain the retention limitation. Audit existing service-worker behavior before changing it; do not base the contract on incidental HTTP caching.

### One writable tab

V1 allows one writable tab per instance on a device. A second tab or window that opens the same instance is refused with an explanation or opens read-only. The desktop main process already decides which tab owns a document and enforces the rule there. Browsers use a Web Lock, a browser feature that lets one tab hold a named lock, held by the writable tab. This removes concurrent writers from the local replica and removes multi-tab propagation from every gate below.

### Outside v1

Accounts, verified identity, comment-only permissions, shared video uploads, automatic blob reclamation, multiple writable server replicas, more than one writable tab per instance on a device, end-to-end encryption, a new standalone file format, ownership transfer, protocol-handler installation, and an unconditional browser offline-launch guarantee are outside v1. References that follow scenes or beats automatically, which the [glossary](GLOSSARY.md) defers to collaboration work, are also outside v1 and wait for the selected schema. Server storage and backups contain readable script content. Transport uses TLS on the public deployment; TLS ends at the tunnel provider's edge, so that provider can read script content in transit.

## 3 Repository integration

Follow [AGENTS.md](../AGENTS.md), [dependencies](architecture/dependencies.md), [feature ports](architecture/feature-ports.md), [saving](architecture/saving.md), [session](architecture/session.md), [invariants](architecture/invariants.md), and the [review policy](architecture/review.md). Reconcile historical architecture descriptions with current code before acting on them.

The existing editor does not already expose a complete CRDT operation stream. `FlowEdit` in `src/core/flow/flow.ts` describes resulting rows and sections. `flowCommand` in `src/application/commands/flow.ts` applies those results to the plain document. Both the flow surface and Split view have paths that reconcile DOM content back into runs, and that includes ordinary typing: input inside one beat goes native and then `syncBeatEl` in `src/features/writer/flow-surface.ts` decodes the whole beat back into runs. Only cross-beat and structural edits arrive as explicit flow outcomes. The integration must preserve edit intent before those paths lose it.

| Responsibility | Placement and rule |
| --- | --- |
| Operation descriptions and domain policy | Pure modules in core, with existing types reused where they fit |
| Session lifecycle, capabilities and user-visible save state | Application owners using named interfaces |
| Yjs types, transactions, relative positions and UndoManager | Adapters; do not import the package or its types into application, core or features |
| Network, credentials, replica storage and blob transfer | Adapters exposed through narrow application contracts |
| Collaboration UI and editor interaction | Features using named ports |
| Construction and composition | Bootstrap wiring; no application-module initialization side effects |
| Collaboration service | Its own top-level folder with its own package manifest and lockfile, an entry in the dependency gate's layer table, message types shared through `shared/`, and its own CI job. `server/` stays the static file server |

Yjs and the provider would be the app's first runtime dependencies. The build emits one inline script, the connection policy is compiled into it, and Standalone HTML export embeds the whole app. Stage 0 measures the added size and records one decision: ship the collaboration code in every build and export, or load it as a second script for shared sessions only, which changes the one-output build and the script hash rule.

The build's `connect-src 'self' https: http:` blocks a `wss://` connection to another host; this was tested in Chromium. The desktop app runs at `splitpage://app` and reuses that policy, so it cannot reach any collaboration server until the rule changes. The proposed change adds `wss:`, which is no wider than the `https:` the rule already allows. A fixed host cannot be compiled in, because the invitation decides the host.

Do not require every method of today's `DocumentSession` to have a shared equivalent. Classify its callers first. Common operations should cover reads, command dispatch, change notifications, capabilities and disposal. Mutable `held()` access, whole-document adoption, disk merge, legacy replay and unknown-extent edits need explicit standalone ownership or a deliberately supported shared operation. No compatibility re-exports or silent shared-session no-ops.

Remote updates enter through the session as well. A transaction kind for remote changes, beside `edit`, `disk`, `reload`, `recovery` and `adopt`, publishes the same change set that features already consume. The session stays the only writer of the projection and the only publisher of change, and one-row repaints keep working (INV-06, INV-07). A remote change records no undo entry, stamps no attribution and triggers no save.

In shared mode, disable the local three-way merge, conflict-stash application and independent drafts of the live document. The replica is the live recovery source. Existing history snapshots can remain explicit recovery checkpoints; restoring one must not overwrite the authoritative replica. Keep these paths unchanged in standalone mode.

Audit the save-time disk conflict check, autosave destinations, recent documents, app-data export, tab restoration, close/quit, and every whole-document replacement entry. There is no file watcher: a disk change is found at save time or by an explicit reload or merge. A shared instance must not remain attached to an automatic file writer. Saving a standalone copy does not switch the live instance's authority or make that file a synchronization target. Desktop tabs know only `file` and `blank` sources, so a shared instance needs its own tab source for restore, duplicate detection, close and quit.

An instance carries its own `docId`, minted when the instance is created. The source file keeps its `docId` and its history. Each standalone export gets a new `docId`, as Standalone HTML export already drops it, so copies exported by several people never share history or trigger the duplicate-id reassignment between open scripts.

Reuse what exists before adding a parallel mechanism:

- The operation context (`capture` and `stillOwns` in `src/application/session/operation.ts`) already makes a completion belong to the operation that started it. The sharing handoff in section 9 needs exactly that.
- The save destinations registry (`src/application/save/destinations.ts`) is where a shared instance is detached from automatic file writers.
- `flowSaveStatus` and INV-20 own save wording. Section 8 extends them and adds no second status surface.
- The session's capability port (`edit()`) is where an edit is refused after access is removed.
- `desktop/prompter-share.ts` already passes a token in a URL fragment.

## 4 Editing and command contract

### Preserve intent and the editor base

The command boundary must distinguish text insertion, deletion of observed content, marking, boundary changes, record changes and explicit movement. Each buffered edit retains the document epoch, editor base version, affected identities, selection and the intended operation.

Reuse existing pure policy, validation and normalization. Do not infer all structural intent from a before/after array of rows. Where browser input supplies only a resulting DOM value, compare it with that editor buffer's own base, then map the resulting operations onto the current shared state.

Carry intent beside the result. Add an ordered list of operations to `FlowEdit` and keep `rows`. A differential test asserts that the operations applied to the base equal `rows`, so the existing flow fuzz suites cover the new path and standalone typing does not change.

The adapter must preserve which characters a deletion selected. Two endpoints translated onto a newer document are insufficient if they would include intervening remote insertions; the mapping needs the identities of the selected observed content. Repeated text, insertion affinity, UTF-16 offsets, grapheme boundaries, embeds and deleted anchors need explicit tests. The chosen mapping must work through supported APIs; reliance on private CRDT internals is a feasibility risk to resolve before production.

### The stale-base hazard and the first experiment

Within one keystroke the native DOM mutation and the input handler run in the same task, so a network message cannot interleave between them. The hazard for ordinary typing is a remote update that the replica has integrated but that is not yet painted into the focused beat: a whole-beat reconciliation then deletes the remote text.

The standalone app already paints into a focused beat. `repaint()` in `src/features/writer/flow-surface.ts` rewrites it and restores the caret after undo, merge and reload, and the surface keeps each beat's last painted HTML, which is already an editor base. That code is the starting point for mechanism 2 below and is measured first. During composition the hazard is unavoidable, because the writer forbids repaint while composing. It exists today: the owed repaint waits, and composition end then syncs the whole beat over whatever arrived. Composition is the open case, and the experiment starts there.

The first Stage 1 experiment, run before the schema candidates: Alice's buffer records the deletion of the original `bc` from `abcd`; her replica integrates Bob's `X` between `b` and `c`; only then does the binding commit Alice's edit. Expected `aXd`. Compare three mechanisms:

1. Defer applying remote updates to the replica while a local buffer is dirty, apply them after it commits. Test every inbound update path, prolonged buffers, cancellation, queue bounds and removed-target recovery. Pausing repaint does not freeze the replica; this option changes the next section's rule that the replica accepts remote updates during composition.
2. Apply remote updates at once and keep enough base identity to map the buffered edit, projecting the remote change into the focused beat synchronously with the caret restored before the next native input.
3. Defer as in 1, through two Yjs documents. The provider holds a network document and the editor binds to its own. Inbound updates are forwarded to the editor document only while no buffer is dirty, and outbound updates only when section 7 allows. Both holds then use public APIs and the provider never holds an unreleased update. Measure the doubled memory and test the forwarding path.

Then repeat with the case "remote update integrated, focused beat unpainted, keystroke lands", across a beat boundary, with repeated text, during composition and through undo. No mechanism is proved safe by adopting its rule; the binding tests prove it.

### Apply one user action

1. Verify the session epoch and edit capability.
2. Plan and validate the complete action against its captured base and current shared state.
3. Apply validated operations in a Yjs transaction with the appropriate local origin.
4. Turn the resulting Yjs events into one session transaction that updates the projection and affected derivations once and publishes its change set. Local and remote changes take this same path.
5. Track undo grouping, local persistence and synchronization separately.

A Yjs transaction is not a rollback mechanism. A planning or conversion failure leaves the previous authoritative state intact and preserves any uncommitted editor buffer for recovery. An unexpected failure after mutation must surface and enter a defined recovery path; it must not be reported as an ordinary rejected command.

### Composition and remote changes

During IME composition, preserve the DOM buffer and its exact base while the replica accepts remote updates, unless the first Stage 1 experiment selects deferral, in which case this sentence changes with it. At composition end, map local intent onto current shared state, then reconcile the DOM. No timeout may replace shared content with stale HTML. If the target was structurally removed, preserve the buffered edit as recoverable content instead of silently dropping it or attaching it to a neighboring beat.

Capture selection anchors against the matching editor version before projecting remote changes. Use adapter-owned relative positions and test affinity and missing anchors. Cover narration, visual text and headings in both editing surfaces.

### Undo and rendering

Shared sessions use selective undo scoped to their local action origins. Standalone sessions retain the existing undo owner. Preserve current typing groups and compound-action boundaries; remote updates, hydration, projection and derived bookkeeping do not enter local undo. Undo may reset on restart in v1.

Undo of joins, splits and deletions must preserve concurrent edits and avoid duplicate restored content. Cursor restoration is part of the gate. Comment/reply draft editors retain their existing independent undo behavior.

List which behaviours of the standalone undo owner shared undo keeps: one-second typing groups, the 200-entry limit, redo parking, composition marks and its behaviour while a save is stuck. Each one not kept is a recorded shared-mode difference.

Projection and derivations never write repairs back into Yjs. Resolve display defaults deterministically, or perform an explicit validated command when shared state must change. A remote update followed by a local no-op must emit no new document update. Preserve targeted rendering and measure invalidation cost.

Today every commit runs three steps that write into the document: attribution stamps, tag and shot records minted from the text, and comment anchor repair. INV-54 also relies on a pass that gives a duplicate b-roll key a new id. In shared mode each of these becomes a pure derivation in the projection or an explicit validated command.

## 5 Shared document schema feasibility

### Candidate representations

Prototype these bounded alternatives; do not start production integration with an assumed winner.

**Candidate A: one document-wide narration and heading sequence.** Stable structural atoms identify beats and scene boundaries, while text identity survives ordinary boundary changes. Investigate representing heading text in that sequence so promoting narration to a heading or removing a heading does not require a silent text copy. Explicit reordering remains a separate problem. Measure projection and update cost on long scripts.

**Candidate B: stable text segments with explicit structural membership.** Scenes and beats reference retained text segments whose identities survive changes in grouping. This may localize updates and support structural recovery, but requires more complex ordering, range mapping and undo.

One independent `Y.Text` per scene is not sufficient by itself: creating or removing a header changes which scene owns following text. Reconsider it only with a demonstrated way to preserve that text's identity or recover concurrent changes under the required writing contract.

For either candidate, specify how visual text and other beat data survive a join. Copying the current visual into the surviving beat is insufficient while another replica can still edit the original. Evaluate retained visual components with an explicit join relationship, or another mechanism that passes the same traces. Do not describe narration-only success as a complete join solution.

### Schema requirements

Every field has one authoritative representation. Boundary atoms carry stable identity; mutable fields need a declared update policy. Do not independently store the same status, paragraph flag or membership in an atom and a map. Metadata changes must not accidentally replace structural identity.

| Data | Required behavior |
| --- | --- |
| Narration, visuals, editable headings and title | Character-level collaboration where people type; no implicit whole-field replacement for concurrent typing |
| Beat and scene identity | Stable across supported edits; no duplicate visible identities after concurrent structure changes |
| Structural order | Explicit deterministic semantics for concurrent insertion, movement, deletion and undo |
| Scalars | Deterministic conflict policy appropriate to the field; atomic values for genuinely coupled fields |
| Status and other monotonic values | Define the merge rule and any explicit reset operation; local maximum calculations alone are not a merge policy |
| Comments | Independent comment records and recoverable anchors; prototype one text attribute per comment id before considering anchored-range alternatives |
| Replies | Independent records with deterministic display order |
| People, tags, shots and gallery entries | Stable record identities; ordered sequence, set or atomic value chosen by meaning |
| Images | Existing sha256 references and metadata; binary data stays outside CRDT updates |
| Video and file links | Descriptive fields synchronize; a link's local `location` does not (section 7) |
| Edit stamps and counters (`updatedAt`, `updatedBy`, `rev`, `lastEditedBy`, `lastEditedAt`, `personColors`) | Derived from shared state, written rarely, or absent in shared mode; never a second shared write on every keystroke. `rev` and `lastEdited*` are written when a save is confirmed, and a shared script has no such moment. Decide before the schema is selected |
| Presence | Ephemeral awareness data outside saved document history |

Specify mark behavior at boundaries for formatting, comments, links, tags and cues. Tags nest: each character carries a stack of tags, a tag sits wholly inside or wholly outside another, and INV-03 also requires a comment or link to cover all of a tag or none of it. Yjs resolves each text attribute on its own, and concurrent writes to one attribute leave a single winner per character. Every mark with an identity (comment, tag, link) therefore needs its own representation, and the projection needs one deterministic reading of merged states that INV-03 forbids, such as crossing tags. Keep the intent of INV-18: comment marks travel with their words. Derive export marks and plain-document anchors without introducing a second shared authority. Removed or detached comments remain accessible through recovery; retain standalone behavior separately where it intentionally differs.

The projection derives the existing `rows`, `sections`, `firstSceneId`, paragraph flags and export structures. Valid canonical fixtures must round-trip without content or metadata loss. Preserve existing serializer goldens where byte stability is part of the contract; list intentional shared-mode differences explicitly.

Two locally valid operations may merge into a domain-limit violation. Define deterministic handling for gallery overflow, missing owners, deleted tags and conflicting membership. The same holds for structural rules: a scene left with no beat, a script left with no beats, paragraph flags, duplicate b-roll key ids, and a mark that would span two beats. [sections.md](architecture/sections.md) forbids synthetic beats and empty scenes, so name the projection's answer for each case. Preserve recoverable content; never silently truncate it to make the projection valid.

### Schema decision gate

Select a production schema only after the mandatory traces in section 13 pass, including scene changes, visual joins, buffered input, recovery and undo. Record rejected alternatives, supported APIs, growth behavior and remaining optional command restrictions. If neither candidate passes, revise the representation or product scope before production work. Do not weaken required writing behavior to declare success.

## 6 Structural conflicts and recovery

Each structural operation needs enough retained identity to explain its result after delayed, reordered and duplicated updates. A removed beat's metadata alone does not retain narration that lives elsewhere. A snapshot at deletion alone does not identify later concurrent edits.

The selected schema must define a durable record of structural removal or movement, its source identities and observed content, the relevant causal information, and how surviving edits are classified. The exact representation is a prototype output. Recovery cannot depend on which update happened to arrive first or on reconstructing identity from repeated strings.

Required behavior:

- Intentionally removed content stays out of the active script until explicitly restored.
- Concurrent edits to removed content remain discoverable with their context.
- Joined content is not shown again as a second removed copy merely because its original beat record remains.
- Restoring or undoing a structural action neither duplicates text nor discards remote edits.
- An edit to a surviving source is distinguished from an edit to text that was relocated.
- A late-joining replica obtains the recovery information needed to reach the same result.

Implement a recovery panel that explains which content is active, removed, or awaiting a decision. Restoration is a visible local action with an undo policy. Standalone export offers recovery material separately in ordinary files; it must not claim to include unresolved material that it omitted.

Specify garbage collection, retained recovery content, log compaction and quotas together. Do not rely on an in-memory undo stack for persistent recovery, and do not assume CRDT tombstones retain all deleted text. Measure growth with repeated editing and recovery operations. Automatic destructive reclamation is outside v1; limits must remain visible and prevent unbounded server consumption.

Restore selected content into a healthy instance as new visible edits. For corruption or rollback to an older server backup, recover into new instance identities with new invitations. Old replicas remain exportable and cannot synchronize wholesale into replacements.

## 7 Images and local files

Preserve the durability principle of INV-52: a committed document record must not depend on image bytes absent from the storage boundary that owns that record. A locally saved replica has its required local blobs; a server-saved replica has its required server blobs.

Compare two designs in Stage 1 and select one. The first is upload-before-sync ordering:

1. Persist and verify an inserted image locally before committing a local document record that references it.
2. When online, authorize the upload for the instance, verify bytes and metadata, and durably record its blob membership.
3. Release document synchronization only when all required local references are available on the server.
4. On receiving state, download and verify required images before acknowledging local persistence of the corresponding replica state.

An offline image insertion can be locally durable while its script's synchronization waits. The user may keep editing locally and export. State this delay honestly; presence or a connected control channel does not mean document synchronization is caught up.

The gate must cover the provider's initial full-state exchange, reconnection and retries. Holding only the application's outbound edit queue is insufficient, because the 4.8.0 provider sends every local update at once and offers its full state again after a reconnect. The hold needs the two-document mechanism of section 4 or an equivalent through supported interfaces. Yjs also applies one device's updates in order, so text typed after a held image waits behind it.

The second design is a pending-image contract. A reference may synchronize before its bytes reach the server, marked pending until the upload is confirmed, and other clients show a placeholder. Document synchronization needs no hold, so an image never delays text. It changes the server half of INV-52, so the invariant change is approved before implementation, and the design must say what an instance shows and exports when the uploading device never returns.

If supported interfaces cannot enforce upload-before-sync, select the pending-image contract with its invariant change or revise the provider integration. Do not quietly permit durable missing references.

A joining client may render placeholders while downloads are pending, but must not label that state saved on the device. Do not allow edits until the initial local replica and its required assets are hydrated. For subsequent remote updates, retain uncommitted work safely in memory while assets arrive and report local save status accurately.

Use the existing image references and validation policy in `shared/blob-policy.ts`. The browser image store in IndexedDB and the desktop blob store already hold images by hash; shared images use them and add no second store. Authorize reads through both instance access and blob membership; a known hash grants no access by itself. The collaboration blob manifest must cover live content, retained recovery content and anything needed by supported undo or checkpoints. Reuse `refsIn()` for ordinary document captures and extend enumeration deliberately for collaboration-only records.

Stream uploads with bounded temporary storage, validate size, hash, MIME and image dimensions, and finalize atomically. Abandoned uploads count against a bounded temporary-storage budget. Proposed starting limits are 16 MiB per image and 200 MiB of retained image data per instance; validate them against representative scripts. 16 MiB is the existing local limit, so every image a standalone script accepts can be shared. Set separate limits for CRDT bytes, decoded structures, recovery data and queued work.

Videos and attached files remain local references with an explicit unavailable-on-this-device state. Do not synchronize local paths. A link's name, size and other descriptive fields synchronize; its `location`, an absolute path or a file name in the script's folder, does not. Each device keeps its own locations in a local table keyed by instance and link, following `withoutVideoLocations`, which Standalone HTML export already uses. A shared instance has no script folder, so copying or moving a file beside the script and Create bundle are unavailable there and work again on an exported standalone copy. Export captures one consistent document revision and its asset manifest, excludes credentials and live instance linkage, and preserves current standalone-format behavior.

## 8 Persistence and truthful save status

### Local replica storage

Persist the binary shared state, accepted incremental updates, required blobs, membership catalogue and synchronization bookkeeping. Store credentials separately. Scope storage by deployment identity and instance identity, and prevent old instances from reusing replacement storage.

Hydrate before editing or starting document synchronization. The storage adapter reports transaction completion and failure. A provider's initial-load event is not a later write receipt. Coalesce writes if needed, but advance the locally saved generation only after the transaction containing that state and its required blob references commits.

Build on the stores that exist. The browser keeps images and history in IndexedDB, with damage tests, under `src/adapters/storage/`. Desktop keeps history, images and drafts as files owned by the main process and reached over IPC. The replica adapter is written for this plan: `y-indexeddb` has had no release since November 2023, the reason `y-webrtc` was dropped, and it reports no write completion.

Test quota exhaustion, interrupted writes, compaction, the second-tab refusal, restart and app-data export boundaries. A failed local write does not erase the in-memory buffer. Show whether server durability has been confirmed and offer export. Browser storage retention and process-crash durability remain separate promises from protection against device destruction.

### Server storage

Use one server process with one writable SQLite database on a local persistent filesystem. The first persistence design journals accepted binary Yjs updates in sequence; periodic binary checkpoints bound replay cost. Persist capability metadata, instance lifecycle state and blob membership alongside it. Node 24 ships a built-in SQLite module with a backup function. Evaluate it before adding a native add-on, and check its stability label first.

Serialize admission, application and persistence bookkeeping for each instance. Retain all accepted state necessary for replay, including deletion information and any allowed unresolved dependencies. Checkpoint compaction may remove journal entries only after the checkpoint that covers them is committed and verified. Never rebuild an existing instance from its plain projection during restart or compaction.

Configure and verify SQLite durability explicitly. WAL with `synchronous=FULL` is the initial choice, subject to filesystem and deployment validation. Read the journal mode and synchronous setting back on every writer connection before accepting writes, and fail writable startup on a mismatch. Blob finalization must meet the corresponding filesystem durability contract. A process-kill test does not substitute for reasoning about host crash or power loss, and no physical power-loss experiment is planned: the evidence is the configuration check, the process-crash, write-failure, checkpoint and blob-ordering tests, and the documented backup loss window. Physical destruction of the volume remains a backup-recovery event.

### Durability receipts

Use the provider's supported ordered message path. Do not introduce a second document synchronization protocol.

Test write-ahead journaling first. In 4.8.0 `beforeSync` receives the raw bytes of an update or a second-step sync message and is awaited before they are applied. The server then sends that connection a status message, and the provider counts updates not yet acknowledged, lowering the count only on an "applied" status. If the journal commit happens inside `beforeSync`, the built-in acknowledgement means the update was journaled and then applied, and nothing is broadcast before it is durable. A receipt is then one acknowledged update, and the barrier design below is not needed. Required blob membership stays part of the receipt under either design.

Stage 1 proves three things before selecting it:

- The commit cost per update on the deployment disk under continuous typing, with any batching stated.
- Undecodable or oversized input is refused before the journal write, so replay never meets a bad entry.
- The provider's count stays truthful across a reconnect. It restarts at 1 each time a sync starts, and unsent buffered updates are dropped when the socket closes.

Without the journal commit in `beforeSync`, the built-in acknowledgement means only "applied in memory". It must never drive save status.

If write-ahead journaling fails a proof, use barriers through flush requests on the same ordered path:

1. Each fully processed accepted update advances a server sequence for that instance. A barrier is not processed ahead of earlier update handlers.
2. A client flush request captures all its preceding transmitted edits on that connection. Associate the request with the instance, connection lifetime and request id.
3. The server records the required sequence when it processes the barrier.
4. A store captures `{binary state, accepted sequence, required blob manifest}` synchronously, before its first await, and writes only the captured bytes, never the live document. Each durable batch or checkpoint records the captured sequence as the coverage it actually provides. Later edits may advance the live sequence while the write waits; the store's completion reports the captured sequence, not the sequence current when the callback fires.
5. Acknowledge only when durable coverage reaches the barrier's required sequence and required blob membership is durable.

An older snapshot finishing after a barrier must not satisfy it unless it contains the required updates. Failed writes cannot advance durable coverage. A no-change flush can acknowledge already durable coverage. Duplicate requests are harmless; reconnect establishes a new barrier after synchronization. Persist enough revision metadata to diagnose recovery without logging content.

Pure deletes need coverage even when a state vector does not advance. Update coverage, not a comparison of state vectors, establishes the receipt. Prove this with the chosen server through supported hooks before production integration.

Facts from the 4.8.0 source that shape the barrier: sync messages are awaited one at a time per connection, so updates sent before a barrier on the same connection are applied before it is handled. The stateless message callback is invoked without await, so a barrier's own asynchronous work is detached from that queue and two barriers can complete out of order. The store hook is debounced per document (defaults 2 s, at most 10 s under continuous updates), the debounced call resolves when the timer is scheduled rather than when the store finishes, and `flushPendingStores()` starts pending stores without returning their completion. Receipts therefore attach to a request id and generation within one deployment, instance and connection, tolerate duplicates and reordering, and never let an old connection's receipt mark newer unsent work saved. Bare sequence values are never compared across instance replacements. Whether a barrier triggers a store itself or waits for the debounce is a measured decision; save status stays pending until a covering receipt arrives.

Two more facts from the same source apply to both designs. An error thrown by the store hook is caught and logged and the document stays in memory, so a failed store reaches save status only through Splitpage's own store code. A connection marked read-only is answered "not applied" for an update that carries new changes, and it stays connected.

Handle normal container termination and configured stop signals, drain pending work within a documented grace period, and report failure. Graceful shutdown is not part of the guarantee for updates already acknowledged as durable.

### User-visible status

Track local document persistence, local asset availability, outbound synchronization, server receipts and connection state separately. A newer local edit invalidates the saved status for the previous generation.

| Wording | Meaning |
| --- | --- |
| Saving on this device | Local document or required asset writes are pending |
| Saved on this device | This replica revision and required assets have committed locally |
| Saved on this device, waiting for images to upload | Local work is safe; image ordering blocks document synchronization |
| Saved on this device, sending | Document synchronization or a server receipt is pending |
| Your changes saved to server | All edits from this device through the indicated internal generation, and their required assets, have a durability receipt |
| Offline, saved on this device | Local persistence succeeded; server synchronization is unavailable |
| Could not save on this device | Local persistence failed; separately show whether the server has acknowledged the changes |
| Access removed, local work kept | The server refuses access; local work remains available for export |

Server status describes this device's submitted edits; it is not a claim that every edit currently being made by every participant has committed. Keep generation numbers and protocol details out of ordinary UI text.

Close/quit may proceed with pending server synchronization when the local replica and required assets are confirmed saved and can be reopened. If neither local nor server storage covers recent edits, retain the existing unsaved-work protection and export path. Do not rely on unload handlers for persistence.

## 9 Access and instance lifecycle

### Admission and invitations

Authenticate and check protocol compatibility before exchanging document state. Keep a second schema-version check in the document. A compatible network protocol does not imply that an old client can edit a newer schema.

Invitations use cryptographically random editor tokens, scoped to one instance and stored as hashes on the server. Public links use `https://<host>/?join=<instance-id>#<token>`. The app is served from one path: it loads `sw.js` and its manifest by relative path, which a `/join/<id>` route would break, and `desktop/prompter-share.ts` already uses this query-and-fragment shape. HTTP endpoints live under `/api/`, which the service worker already leaves alone. Parse and remove the fragment before application logging or analytics, then store the token in the credential adapter. Redact authentication payloads and errors throughout the connection path.

Use individually named invitations with no expiry in v1. Show the token-bearing link when issued. Server management lists invitation labels and state, not recoverable token values. If the owner needs another link later, issue a new invitation and make revocation of the old one explicit. Re-copy across devices would require a separate credential-retention design and is deferred.

Keep the management secret outside shared state and distribute it only through an explicit owner setup path. It is never embedded in the app bundle or an invitation. Management-secret rotation and recovery are part of the runbook. Do not infer owner authority from a display name.

Revocation closes all connections authenticated with that token and rejects subsequent document, awareness and blob operations. Recheck authorization when committing queued privileged work. A revoked offline client can export its work but cannot publish it to the old instance. Revocation cannot retract downloaded content.

### Initial sharing handoff

Use a persisted creation-operation id to make retries return the same pending instance. Record whether initialization is pending, committed or abandoned; a lost response cannot create a second active instance. Pending instances reject guest joins.

Capture the initiating document epoch and generation and retain edits made while initial content and images upload. Choose and prove one handoff mechanism during feasibility: a durable operation journal from the captured generation, or another explicit mechanism that preserves every intervening edit. Do not silently switch from a newer standalone document to an older uploaded snapshot.

Before switching authority, verify the initiating epoch, prepare the complete current local shared replica, and make the handoff recoverable across restart. A brief serialized final commit may be needed; network upload must not freeze normal writing. Later edits remain locally durable and join the shared synchronization pipeline. Show an invitation only after the initialized server state and local transition meet their persistence contracts.

If the user changes documents, completion belongs to the original operation and never attaches to the current document. Cancellation, restart and retry must leave either the original local script or a recoverable completed shared membership. Do not delete the original file as part of sharing.

### Joining and leaving

Joining validates the invite and versions, loads existing CRDT state, downloads required assets, and establishes local persistence before enabling edits. It never initializes a second CRDT from a projection of an existing instance.

Desktop v1 accepts a pasted invitation through its UI. Validate the endpoint and credentials before connecting and apply the same redaction rules as the browser. Browser joining uses the app served by the collaboration server at the invitation's host. No hosted copy of Splitpage exists today: it ships as an installer, a portable zip or a self-built `index.html`. Serving the built app, updating it and keeping it compatible with older desktop builds are therefore part of Stage 3 and the runbook. Serving the app and the WebSocket from one host lets the page's same-origin rule cover the browser connection; verify that in each supported browser.

Leaving disconnects the device. Under the one-tab rule no second writable tab exists, and a read-only second tab closes its view. Offer a standalone copy for retained work before removing membership, credentials and replica storage. Cancellation preserves the work. Other tabs cannot reopen the deleted membership behind the user's action. A new explicit join with a still-valid invitation remains possible.

Owner deletion closes access, removes the instance from active use and leaves a durable lifecycle tombstone that blocks recreation through reconnect. Live backups have their own retention policy. Deletion of the server copy does not claim to erase other devices' files or retained backup media.

### Versions and upgrades

Pin the complete compatible dependency set after feasibility. Version the shared schema independently from the standalone file format and the wire protocol. Test an offline client returning after an upgrade.

Choose either a supported migration preserving CRDT identities or a deliberate new-instance transition with recovery of old work. Do not reset an instance from exported JSON and resume old replicas against it. An unsupported client gets an upgrade explanation and retains a way to export its local work without sending it first.

## 10 Server boundaries and operations

### Server selection and packaging

Evaluate Hocuspocus first because the planned Node service already needs custom admission, management, receipts and blob endpoints. Prove the hooks against the pinned version. Do not assume a stock persistence extension satisfies Splitpage's durability contract.

Evaluate y-sweet only if Hocuspocus fails a required gate or y-sweet demonstrably removes substantial work. Its documented local-directory and object-storage model would require a revised persistence design. Include maintenance, documentation, revocation, receipt support, deployment complexity and total memory in that decision. Avoid provider forks or a custom wire protocol unless a separate design decision establishes that maintained supported interfaces cannot meet the need.

Package one image with environment configuration and one persistent data volume. Run as a non-root user with a read-only root filesystem, bounded writable temporary storage, resource limits and restricted networking. Configuration names the data path, port, deployment identity, allowed origins, trusted ingress and resource limits; secret values stay in deployment secret storage. Use the repository's Node version for the Node implementation.

### Validation and resource limits

Apply connection, rate, byte and queue limits before expensive processing. Set separate bounds for frame size, total document state, decoded object counts, nesting, pending dependencies, awareness data, uploads and retained recovery data. Bound work for authenticated clients too.

The server must define when an update is validated relative to applying, persisting and broadcasting it. Validate untrusted candidate state before allowing it to affect other clients where rejection is required. Handle unresolved dependencies and legitimate concurrent limit conflicts explicitly. Quarantine broken instances and preserve recoverable data; never silently discard an update and claim synchronization succeeded. The prototype must show that the chosen hooks can enforce this boundary.

For a trusted group of two to six, v1 limits server rejection to what can be decided before an update is applied: admission, frame and document size, rate, and whether the update decodes. Script rules are not enforced at the server. Two valid edits can merge into a state that breaks them, so the projection must already read such states (section 5), and a server check would add a rejection path without removing that work.

In 4.8.0 an exception thrown from a message hook, including `beforeSync`, closes that connection with a reset code and drops its queued messages. Rejecting an update that way means disconnecting the client, and the provider's next initial sync will offer the same update again. A connection marked read-only is answered "not applied" and stays connected, so use that for a permanent refusal: the client stops publishing without a reconnect loop. Distinguish a temporary refusal, such as a blob prerequisite that is not durable yet and is retried once it is, from a permanent rejection of invalid or oversized state. A permanent rejection stops automatic re-publication of that replica, preserves the local work for recovery and export, and tells the user what action allows a safe rejoin. Never delete CRDT content silently and never loop through disconnect and reconnect.

Treat Origin checking as an additional boundary, not authentication. Allow only intended browser and packaged-app origins. The packaged app's origin is `splitpage://app`; confirm what it sends on a WebSocket upgrade. Trust forwarded addresses only from the configured ingress. Do not log scripts, tokens, paths or raw frames. Diagnostics should expose connection counts, queue sizes, write failures, receipt delay, storage usage and backup health without content.

### First deployment

Use a public hostname through the existing Cloudflare tunnel. Editor links do not require Cloudflare accounts. Owner administration can use a separately restricted route while document and invitation endpoints remain reachable. Keep heartbeats and reconnect backoff enabled and verify their behavior through the actual tunnel.

Keep the database and blob directory on a direct pool path, not Unraid's merged `/mnt/user` share. SQLite's write-ahead log needs shared-memory files and is widely reported to corrupt on that layer; this plan has not tested it, so confirm it on the real volume as part of the durability configuration check.

Use an always-running instance for the limited release. Home power and internet remain availability dependencies. Measure memory, CPU, disk growth and backup time using representative scripts before choosing limits; do not size the server from encoded document bytes alone.

### Backups and restore

Back up the database consistently with its blob manifest, instance metadata and access records. Use a documented database backup mechanism, not a casual copy of a live SQLite file. Verify that every referenced blob exists in the backup. Keep at least one backup outside the primary machine's failure domain. A second share on the same machine is not sufficient for that requirement.

Start with daily backups and document the resulting maximum backup-age loss window. Monitor backup failures. Keep the management secret and any backup-encryption keys in separately recoverable secret storage.

An older backup restores first into an isolated deployment with public writes disabled. The owner selects which scripts to recover; create new instance identities and invitations before reopening them. Old invitation hashes and deleted-instance state from that backup never silently become active again. Preserve old clients' work as exportable copies for deliberate recovery. Do not merge potentially corrupt or unauthorized old CRDT state wholesale into replacements.

Run a restore drill before the limited release and after changing backup or storage behavior. Verify content, images, access removal, old-client rejection and the documented loss window.

### Moving to another host

Treat migration as a controlled cutover: stop new writes, drain and verify durability, take a final consistent transfer, stop the old writer, restore and verify the destination, then switch routing. Preserve deployment and instance identities for an exact healthy migration. Never run two independent writable copies of the same instances.

Keep the public hostname stable where possible. If it changes, define credential and local-membership migration instead of assuming origin-scoped storage follows it. A future Fly.io deployment needs its own volume, shutdown, network, cost and smoke verification. Auto-stop follows demonstrated idle-connection and reconnect behavior; it is not required for v1.

## 11 Implementation stages

| Stage | Deliverable | Exit condition |
| --- | --- | --- |
| 0 Audit and baseline | The eight bounded artifacts of section 12, each entry tagged with the Stage 1 trace it serves, plus the standalone performance baseline, tolerances and provisional limits | Every Stage 1 experiment has its inputs, expected user-visible outcome and the entry paths it touches named; budgets, tolerances and noise treatment are fixed before prototype results |
| 1a Editing feasibility | Independent character-identity model with a deterministic delivery queue and a third late-joining replica; the stale-base experiment first, starting with composition; then a throwaway real-editor slice bound to two replicas joined by that queue, with no server; structural recovery and undo | The checker fails on deliberate defects (a lost remote character, a duplicated identity, an omitted field) before it endorses anything; the editing traces in section 13 pass; a buffer mechanism and a schema are selected, or the design returns for revision |
| 1b Service feasibility | Hocuspocus 4.8.0 container, journal and receipts, local storage, image ordering, the one-tab lock and harness support for two clients | The durability, media and provider traces in section 13 pass; a supported provider integration, a receipt design and an image design are selected, or the design returns for revision |
| 2 Shared session foundation | Production operation contract, projection, adapter boundary, undo and recovery model behind a flag; the session-caller migration and the disable list implemented | In-memory concurrency and real-editor tests pass; deliberate production defects (lost mark, duplicated identity, omitted field, stale base) each fail a named test; standalone behavior and exports remain unchanged |
| 3 Durable service and replicas | Admission, update journal, checkpoints, local persistence, blobs, admin API, limits, backup and restore | Crash, quota, revocation, media-ordering, compaction and rollback-recovery tests pass locally and in CI; the harness-owned receipt-history checker passes and a deliberately premature receipt fails it |
| 4 Product workflow | Share handoff, browser and desktop join, restart, leave, revoke, delete, export and save status | Browser and packaged-desktop scenarios pass, including delayed initialization and owner-offline joins |
| 5 Presence and release preparation | Participants, optional cursor decoration, diagnostics, help and operational runbooks | Presence is ephemeral; deployment smoke, recovery drill and performance gates pass |
| 6 Limited release | Trusted-group deployment on Unraid with recorded limits and support procedure | Representative workflows succeed; failures are diagnosable; rollback preserves accessible user work |

Stage 1 is a feasibility decision, not an obligation to ship the prototype. Scope it to the two schema candidates and one primary server. Stages 1a and 1b have separate exit decisions: 1a can end the design before any server work, and 1b does not depend on the schema, so the two may run side by side. Set an effort budget for each at kickoff and review at the first complete vertical slice. If a mandatory trace remains unresolved at that checkpoint, record the failure and revise the design before extending production work. Do not estimate the whole implementation as routine adapter work before this gate.

Stages can use several small PRs with one coherent purpose each. Production implementation must reproduce the prototype's retained fixtures. No collaboration UI is enabled in a release build before both durable infrastructure and end-to-end workflows pass; a hidden feature flag alone is not an acceptance result.

## 12 Audit deliverables

Stage 0 produces the following concrete artifacts as implementation evidence, with execution tracked in GitHub issues rather than a second status queue. Each is only as deep as Stage 1 needs: every entry names the Stage 1 trace or experiment it serves, and an entry that serves none is deferred to Stage 2 at review time rather than argued about. The field inventory is the exception and is complete regardless, because a missing field is the cheapest gap to close now and the most expensive to find later. No exhaustive runtime tracing and no refactor happen in Stage 0; targeted tracing is justified only to identify an entry path.

1. A command inventory with broad coverage (flow input, Split view, headings, panels, clipboard, import, find/replace, galleries and bulk operations) and shallow mapping. Input intent, base retention, mutation path, effects and undo grouping are detailed only for commands a Stage 1 trace exercises. `src/application/commands/` holds about 50 command builders and the flow about 25 operations, all writing the plain object through `Plan.apply`. Sort them by what they change: field and record commands can be translated from the fields they declare, while text and structure commands need explicit intent. The sorted list sizes Stage 2.
2. A complete inventory of persisted fields, marks, atoms, arrays, defaults, normalization and export behavior, each with an owner and a provisional concurrency policy. An unresolved policy becomes a named experiment. Start from `STATE_FIELDS` in `src/core/document/fields.ts`, whose 18 fields each name a merge strategy, the merge rules in `src/core/merge/` and `src/core/document/gallery.ts`, and [sections.md](architecture/sections.md). Include edit stamps and counters, and the records each commit mints from text.
3. A compact session-method and caller classification: the mutable access, adoption or replacement, replay and lifecycle paths the prototype reaches. `held()` has three call sites outside the wiring and `noteEdit` has one app caller. The caller-by-caller production migration design is Stage 2.
4. The live automatic writers, merge, conflict-stash and draft paths by entry point, and how the prototype isolates its shared session from each. The production disable or replacement implementation is Stage 2.
5. A short invariant matrix for comments, tag nesting (INV-03), work per keystroke (INV-06, INV-07), b-roll key ids (INV-54), blob completeness, edit recording, document identity, credential exclusion and recovery: preserved, intentionally different in shared mode, or left to an experiment. These set the pass criteria for feasibility and cannot wait for schema selection.
6. A minimal browser and desktop boundary map: local replica and credential stores and their origins, the hydration entry, every other-tab and inbound update source, the desktop tab source, app-data export exclusion and restart assumptions. The one-tab lock, leave and credential-race implementation and tests follow later. All inbound update paths feed the deferral and reconnect experiments directly.
7. A performance baseline for input latency, structural edits, projection, initial load, memory and storage growth, measured on representative scripts and specified hardware with `tools/perf-record.mjs`, plus the tolerated regression and the noise treatment fixed before any prototype result exists. Reconnect, receipt delay and retained-state growth have no standalone baseline and get provisional numeric limits instead. Refining either is an explicit decision, never a retroactive acceptance of what was observed.
8. The schema candidate hypotheses, the expected failure traces and the supported-API questions for the prototype. Selection remains a Stage 1 output. Record the connection-policy change and the bundle decision with measured sizes (section 3), existing service-worker behavior, and how the browser app is served, as part of the environment boundary.

Run `node tools/code-map.mjs` to identify feature files, wiring and tests. Use Node 24.22.1 and `npm ci` for implementation and test work. Reconcile the baseline with current `main` before each stage.

## 13 Acceptance evidence

For each concurrency trace, write the expected visible script, recovery contents and undo outcome before implementation. Run updates in different orders with duplicates and interruptions. Eventual equality alone is insufficient: equally wrong replicas fail.

Expected results for small fixtures are written by hand as explicit characters, marks and identities. They never pass through the production decoder to become "expected", because the existing flow reference model in `tests/core/flow/reference.ts` decodes through the production `cells` port and normalizes minted ids to `$new`, which is right for its purpose and cannot establish identity guarantees. The Stage 1 checker is an independent character-identity model in TypeScript under `node:test`, with a deterministic delivery queue that delays, duplicates and reorders updates, a third late-joining replica, and minimized failing histories kept as decision evidence. Before the checker endorses a schema it must fail on deliberate defects: a lost remote character, a duplicated identity, an omitted field.

### Mandatory feasibility traces

| Trace | Required result |
| --- | --- |
| Buffered deletion of observed content with a concurrent remote insertion inside it (`abcd`, delete original `bc`, remote `X` between them) | `aXd` under every candidate buffer mechanism; a deliberately stale base makes the test fail |
| Ordinary keystroke while a remote update is integrated but the focused beat is unpainted | Remote text survives; caret and base stay aligned |
| Same-word edits and repeated text | Intended insertions/deletions survive without replacing remote text |
| Held IME input with remote insertion and deletion, driven by synthetic composition events | Both editing surfaces apply the local intent against its captured base; a removed target leaves the buffered work in recovery |
| Concurrent split and edit, and two splits at the same point | Deterministic boundaries, usable selection and preserved text; define whether concurrent breaks are both visible |
| Two clients join the same pair of beats | No duplicate visual text, pictures, joining whitespace or metadata contributions |
| Join while another client edits the second visual | The edit remains active in the joined content or accurately recoverable according to the specified rule |
| Create/remove a scene header while another client edits following narration | No silent copying, loss or unexplained movement of text |
| Cross-beat or cross-header selection replacement with concurrent input | Only the selected observed content is removed; structural and mark policies hold |
| Delete a beat, offline edit it, late join, then undo deletion | The edit stays discoverable and restoration produces no duplicate content |
| Overlapping comments, replies and structural edits | Independent comments/replies survive with correct active or recovery anchors |
| Concurrent tag edits on overlapping text, and a comment or link applied across part of a tag another client is adding | Every replica projects the same well-formed nesting; no crossing tags; nothing is dropped silently |
| Structural undo after intervening remote edits | Remote work survives; grouping and selection remain sensible |
| Undo of a mark or comment change after intervening remote edits | Only the local change is reverted; remote marks and text survive |
| Initial upload while the owner continues typing | Handoff preserves every accepted edit and can restart or retry without another active instance |
| Update acknowledged, then the server is killed before any debounced store | The update is in the recovered journal; an acknowledgement sent before the journal commit fails the checker |
| Reconnect with acknowledged, unacknowledged and never-sent updates on the device | Saved status covers exactly the acknowledged updates; the rest stay pending until the new sync acknowledges them |
| With barriers: older server write finishes after a newer flush request | No premature receipt; pure deletes receive correct durability coverage; the receipt reports the captured sequence, not the live one |
| With barriers: two barriers whose completions arrive out of order, and a receipt from a closed connection | Durable coverage stays monotonic; newer unsent work is never marked saved |
| A second tab opens an instance that a writable tab holds, then the holder crashes | The second tab is refused or read-only; after the crash the lock is released and one tab becomes writable; no replica write is lost |
| Offline image insertion followed by automatic reconnect | Under upload-before-sync, no provider path publishes a reference before its server blob membership is durable. Under the pending-image contract, the reference arrives marked pending, other clients show a placeholder, and no client reports the image saved before its bytes are durable |
| Server restart and join with all previous clients offline | Complete state and images load without a client supplying them |
| Invalid and oversized input at the chosen hooks | Bounded rejection or quarantine before unsafe fanout; no false saved status |
| Reconnect with a rejected update still in the local replica, through incremental and full-state sync | Temporary refusals retry after their prerequisite; permanent rejection stops automatic re-publication, keeps the work exportable and explains the rejoin path; no disconnect loop |

The optional structural-movement gate covers concurrent moves of the same object, move versus delete, edits to source and destination, cross-scene cut-and-paste, and undo. Refuse unproven movement commands in shared mode; this does not excuse failure of mandatory writing traces.

### Production and release evidence

| Area | Evidence |
| --- | --- |
| Document coverage | Canonical golden fixtures, existing serializers and complete field inventory |
| Local storage | Offline restart after receipt, quota errors, interrupted writes, compaction and the second-tab refusal |
| Server durability | Kill before/after receipts, delayed and failed writes, shutdown, last-client-leaves, replay and checkpoint failures; a harness-owned history checker that matches every receipt against recovered journal, checkpoint and blob coverage from the test harness's own records of what was sent, never from application logs; a deliberately premature receipt fails it |
| Access | Immediate socket and HTTP revocation, deleted-instance reconnect, old-backup restore and credential rotation |
| Isolation | Two instances of related content open together; imported standalone files; old and replacement instances; schema mismatch |
| Lifecycle | Rapid switches, cancelled joins, repeated invites, closed tabs, leave races and stale async completions |
| Media | Failed/delayed uploads and downloads, damaged bytes, unauthorized hashes, recovery assets and incomplete export |
| Capacity | At least a 2 MiB encoded-state fixture and 2 MiB image, plus near-limit, many-object and heavily edited fixtures |
| Validation | Malformed frames and individually valid edits whose merged state exceeds application limits |
| Performance | Standalone A/B comparison and shared-session measurements against the budgets fixed in Stage 0 |
| Deployment | Public TLS/join route, tunnel reconnect, owner-offline join, restart, revoke, backup health and isolated restore |

Keep seeded randomized multi-replica traces, failing seeds and deterministic replay. Measure input latency, projection work, propagation, initial load, reconnect, memory and storage growth with exact runtime, browser, package and fixture versions. Long-running edit/delete/undo workloads must remain within the documented resource policy.

Most correctness tests run in-process or against the local container. Browser tests use the existing harness. Its driver starts one Chrome profile and drives one page, so two-client and second-tab cases need harness work first, either two driver processes or new commands. That work belongs to Stage 1b. Run supported browser and packaged Electron paths. Hosted smoke verifies deployment-specific behavior; it does not replace deterministic local tests.

Add collaboration unit and service contract tests to required CI, and a bounded real-editor integration suite for app-affecting changes. Keep longer randomized and endurance runs in scheduled or stage gates without skipping required product assertions. Record any CI changes explicitly.

While working, run focused tests and the relevant type, dependency and comment gates. Before pushing, run `npm run verify` once. Select browser and desktop suites under [testing.md](architecture/testing.md) and the [browser harness skill](../.claude/skills/run-splitpage-app/SKILL.md). Typing, editing and undo changes require the comparison in [performance-record.md](architecture/performance-record.md). Follow the review tier for every changed responsibility; persistence and recovery require the full review process. Add the shared replica, synchronization and server storage to the Full tier in [review.md](architecture/review.md) before Stage 2 code is reviewed.

## 14 Documentation and decisions before release

Update the document model, session, saving, dependencies, glossary, invariants and roadmap to reflect the chosen implementation. Record the schema and provider decision with evidence. Follow repository policy for user-help and release-note changes.

Add explicit invariants for receipts covering the edits they acknowledge, recovery preserving removed concurrent work, and instance isolation. For credentials never entering document content, revive or replace INV-62 and the app-side part of INV-29, which covered connection secrets and were retired with the old server on 2026-10-28, and extend the app-data export scan of INV-48; do not add parallel invariants. Correct INV-28 and the server half of INV-52, which still describe the removed server. Record intentional shared-mode differences without weakening standalone product tests.

Product help explains local versus server saving, browser reopening limits, image-related sync delays, disabled structural commands if any, forwarded invitations, revocation, recovery, and independent exports using ordinary language.

The proposed defaults are owner-only administration, individually named invitations, Paste Invite Link on desktop, the offline contract in section 2, and the initial image limits in section 7. The third review added these, each open to change before Stage 0 closes:

- One writable tab per instance on a device (section 2).
- References that follow scenes or beats automatically stay outside v1 (section 2).
- A new `docId` for each instance and for each standalone export (section 3).
- `wss:` added to the build's connection policy (section 3).
- Server rejection limited to what can be decided before an update is applied (section 10).
- The browser app served by the collaboration server, with links shaped `/?join=<instance-id>#<token>` (section 9).
- Per-device locations for video and file links, with folder operations unavailable in a shared instance (section 7).

Image ordering and the receipt design are Stage 1 selections, not defaults. Confirm the public hostname, off-machine backup destination and actual storage budgets before deployment. Any change to required writing behavior returns to the product contract before implementation.

The next implementation task is Stage 0. Its output must make the Stage 1 experiments executable and give each experiment an expected user-visible result.

## 15 Primary technical references

- [Yjs document API](https://docs.yjs.dev/api/y.doc) describes transactions, update events and garbage-collection controls. Recovery policy remains an application responsibility.
- [Yjs relative positions](https://docs.yjs.dev/api/relative-positions) describes stable positions and missing anchors. Preserving the exact contents of an earlier selection needs additional binding logic.
- [Yjs UndoManager](https://docs.yjs.dev/api/undo-manager) describes local-origin filtering, capture boundaries and selection metadata.
- [Yjs document updates](https://docs.yjs.dev/api/document-updates) describes binary update persistence and synchronization. Keep CRDT state across restart rather than recreating it from the projected document.
- [Yjs offline support](https://docs.yjs.dev/getting-started/allowing-offline-editing) distinguishes local document storage from loading the application without a network.
- [Hocuspocus hooks](https://tiptap.dev/docs/hocuspocus/server/hooks) documents admission, message and persistence integration. The page is stale in at least one place: it calls `beforeSync` non-async, while the 4.8.0 source types it as returning a promise and awaits it before applying the sync message. Verify ordering and completion behavior against the pinned tag, not the docs. The built-in acknowledgement of each update and the provider's count of unacknowledged updates are not described there; read them in the server and provider package source.
- [Y-sweet self-hosting](https://github.com/jamsocket/y-sweet/blob/main/docs/running.md) documents directory and object-storage persistence; it is an alternative requiring its own storage decision.
- [SQLite synchronous settings](https://sqlite.org/pragma.html#pragma_synchronous) explains the difference between process-crash and power-loss durability.
- [Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/) documents connection interruption and keepalive considerations; deployed smoke checks remain necessary.
