# Stage 3 plan: access, pictures and local copies

This plan splits Stage 3 of the [collaboration plan](../COLLABORATION-PLAN.md#11-implementation-stages) into parts that each merge on their own. The owner approved it on 2026-11-22. Where it and the collaboration plan disagree about Stage 3, this plan wins; the [native layer note](native-adapter-design.md) still wins about the shared document itself.

Stage 3 builds the service and storage under the shared session. It adds no screens: the Collaborate command, the join screen and save-status wording are Stage 4.

## Starting point

On `main` at `36d156095`:

- The relay (`collab-server/`) is stock Hocuspocus 4.8.0 with one SQLite table of snapshots, size admission at 15 MB, verified backup and restore commands, and an exact-origin check. One access token from the environment opens every script name, and connecting with a new name creates a script.
- The client has the reconnect wrapper and local stores with an update log, checkpoints and write receipts. The browser store holds a Web Lock for one writable tab. The desktop store is reached only through the test-only channel `splitpage:test-native-replica`.
- Picture bytes do not travel. A shared script carries picture references only.
- A copy of the relay runs on the owner's server and holds test scripts only.

## Decisions

Made by the owner on 2026-11-22:

1. Until Stage 4 adds screens, the owner manages scripts and invitations with a command-line tool.
2. A picture whose bytes never reach the server keeps its placeholder until someone replaces or removes it. Export warns that the picture is missing. Nothing removes it automatically.
3. Browser joining is in the first version: the relay serves the built app.

Carried over:

- Pictures use the pending-picture design approved on 2026-11-09: a reference may synchronize before its bytes are on the server.
- The update journal, durability receipts and any "saved to server" wording stay deferred (decision 19 in the note). Stage 3's exit condition therefore drops the receipt-history checker.
- The first version rejects at the server only what can be decided before an update is applied: admission, sizes, rate, and whether the update decodes.
- The relay's existing data is test data. The new storage starts empty; nothing converts the old database.

## Parts

Each part is one or more pull requests with one purpose each. "Done" lists what must be true on `main`.

### 1 Shared scripts and invitations

The relay records each shared script and its invitations, and admits a connection only with a valid invitation for that script.

- Storage: a script has an identity and a lifecycle state (pending, active, deleted). An invitation belongs to one script and has a label, a hash of its random token, and a revoked flag. Both live in the relay's SQLite database, written by the same single writer. The database records its storage version, and the relay refuses to start on one it does not know.
- Admission: the token must match an unrevoked invitation of the named script, and the script must be active. A name the relay does not know is refused and creates nothing. The environment-wide access token is removed.
- Versions: the client states its wire and schema versions when it connects. A client the relay cannot serve gets a refusal it can tell apart from removed access.
- Revocation closes every connection opened with that invitation and refuses later document and presence traffic from it.
- A deleted script keeps a record that blocks reconnecting clients from recreating it.

Done:
- Tests pin each refusal: another script's invitation, a revoked invitation (open connections close, later ones are refused), a deleted script, an unknown name, a pending script, an unsupported version.
- The size admission and merge-limit tests pass unchanged.
- A test reads the relay's log output across these cases and finds no token and no script content.

### 2 Owner commands

HTTP endpoints under `/api/` on the relay, guarded by a management secret from the environment. The secret is compared in constant time, never logged, and appears in no bundle or link.

- Commands: create a script, issue an invitation, list invitations, revoke an invitation, delete a script.
- Create takes a creation id and the initial state as bytes from the owner's client. Repeating a creation id returns the same script. The script becomes active only after its initial state is stored; until then invitations to it are refused.
- Issue returns the token once. List returns labels and states, never tokens.
- The command-line tool lives in `collab-server/` and covers issue, list, revoke and delete. It prints an invitation as `https://<host>/?join=<script-id>#<token>`. Creating a script from an open file is Stage 4; until then the shared test hook does it.

Done:
- Tests cover each command, a wrong or missing secret, a repeated creation id, and an invitation issued for a pending or deleted script.
- The runbook says where the secret is kept, how to rotate it and how to recover from losing it.

### 3 Pictures

**3a Server.** Upload and download under `/api/`, authorized by an invitation to that script.

- Upload streams to bounded temporary storage, checks size, hash, type and dimensions by the rules in `shared/blob-policy.ts`, and finishes with an atomic move. Limits: 16 MiB per picture, 200 MiB per script. Abandoned uploads count against a bounded temporary budget.
- The relay records which script holds which picture. Download needs both a valid invitation and that record; knowing a hash grants nothing.
- `collab-server` may not import other layers today. If it needs `shared/blob-policy.ts`, the pull request changes the layer rule in the open and says why; it does not copy the rules.

**3b Client.** The existing local picture stores keep the bytes; no second store.

- Inserting a picture in a shared script stores the bytes locally, synchronizes the reference at once, and uploads in the background with retry.
- A copy that lacks the bytes shows a placeholder that says the picture is not uploaded yet, and fetches the bytes when they are available. Joining fetches the pictures the script references before the join counts as complete on this device.
- Bytes that do not match their hash are discarded and fetched again.
- Export lists pictures it could not include before it is presented as complete.
- How a copy learns that bytes are available uses plain values in the shared script or the HTTP endpoints. It adds no second synchronization protocol. The lane writes this mechanism as a short section in the note before building, and the coordinator reads it first.
- The wording of INV-52 changes in this pull request.

Done:
- Server tests: over-limit, wrong hash, wrong type, interrupted upload, a hash requested by another script's invitation, a revoked invitation.
- Client tests with two copies: bytes arrive late, the uploading copy never returns, damaged bytes, export with a missing picture.
- One browser suite shows the placeholder and its replacement by the real picture.

### 4 Local copy in the real app

- Desktop: the replica store moves from the test-only channel to a production channel owned by the main process. Storage is scoped by the deployment's identity and the script's identity, and a replacement script never reuses an older script's storage.
- Invitation tokens are stored apart from the replica and never enter script content, exports or logs. Desktop keeps them in a main-process file encrypted with the operating system's key store; the browser keeps them in their own IndexedDB store. Revive or replace INV-62 and extend the export scan of INV-48; add no parallel invariant.
- One writable tab on desktop: the main process refuses a second window on the same shared script with an explanation, as the browser lock already does.
- Leave, as a command without a screen: closes the connection and removes the token, the membership and the replica on this device.

The gated shared app entry accepts `enterRetained({ deployment, script, invitation?, connect? })`. Both identities use 1–64 ASCII letters, digits, underscores or hyphens. Deployment is the stable identity of the service and script is its immutable server-assigned identity. An invitation carries the token and already authenticated native state bytes. A new local replica applies those bytes before joining; an existing replica reopens its stored state. The optional connection factory receives the open replica and token, connects the same session the editor binds, and returns its disconnect function. Offline reopen supplies only the two identities. The existing gated `leave()` command awaits erasure for a retained session. A failed erase ends that writer's command; a later command must originate from a newly opened copy.

Done:
- Tests: reopen offline after a restart, a full disk or quota failure keeps the in-memory script, an interrupted write, a second tab, two scripts open together without mixing, leave removes all three things.
- The test-only channel is gone, with no re-export left behind.

### 5 Browser app served by the relay

- The relay serves the built app (`index.html`, the service worker, the manifest and their files) from one path, with the WebSocket on the same host. The container image carries the app built from the same commit.
- The app reads `?join=` and the token in the fragment, removes the fragment from the address before anything can log it, and hands the token to the store from part 4. The screen that follows is Stage 4.
- The build's connection policy allows the WebSocket connection. Check that the same-origin rule covers it in each supported browser before adding anything broader.
- Allowed origins are the relay's own host and the packaged app's origin.

Done:
- A test loads the app from a local relay, joins through a link, and finds no token in the address, the history entry or the log.
- The service worker leaves `/api/` and the WebSocket alone.

### 6 Limits and container

- Limits applied before expensive work, for admitted clients too: connections in total and per invitation, messages per connection per second, uploads in flight (configurable `1`–`4`, preserving the 64 MiB staging maximum). Use the options Hocuspocus and its WebSocket library provide before writing any.
- Approved transport decisions: authenticated message rate limiting uses stock `@hocuspocus/server` 4.8.0's processing-time `beforeHandleMessage` hook alongside the configured pre-auth queue and WebSocket frame bounds (queued messages may accumulate during processing stalls). Total connection capacity is refused before WebSocket upgrade (`503` with `Retry-After`); a browser treats the opaque upgrade failure as temporary and retries with backoff without a relay-full reason, while permanent access refusals stay distinct after upgrade and never cause a reconnect loop.
- The container runs with a read-only root filesystem, bounded temporary storage and memory and CPU limits. It already runs as a non-root user.
- A status endpoint behind the management secret reports connection counts, stored bytes, picture bytes, the last storage failure and the last backup time (published only after a verified backup is durably published, syncing parent directories on POSIX; Windows does not support directory-descriptor fsync). It reports no script content, token or path.

Done:
- Tests reach each limit and see the stated refusal, including normal-client recovery after capacity frees and sibling continuity on multiplexed transports.
- The image starts and passes the relay tests with a read-only root filesystem.

### 7 Backup and restore

- A backup contains the scripts, their lifecycle records, the invitation records and the picture files, taken consistently. It verifies that every recorded picture is present and matches its hash.
- Set Part 6's `lastBackupAt` only after `backupRelay` returns successfully. A directory can appear under its final name before publication has been synced, so its presence alone is insufficient evidence of completion.
- Restore goes into an isolated directory. A restored relay starts with every invitation revoked and deleted scripts still deleted; the owner issues new invitations.
- The runbook in the note is updated.

Done:
- Tests: a backup missing a picture fails verification; a restored relay refuses an invitation that was valid at backup time.

### 8 Evidence and redeploy

- The evidence rows of the collaboration plan's [production and release evidence](../COLLABORATION-PLAN.md#production-and-release-evidence) that belong to Stage 3 have tests in CI: local storage, access, isolation, lifecycle, media, validation. Server durability keeps the server-stop tests the note already records; receipts are out.
- The relay on the owner's server is replaced with the new image and an empty database; the old data directory is kept aside. The management secret goes into the server's secret storage and is never printed. The daily backup and its off-machine copy include pictures.
- Smoke on the deployed relay: create a script, issue an invitation, join from a second device, revoke it, run the restore drill.
- Documentation: Build status in the note, the Stage 3 row of the collaboration plan, the invariants, and the Full review tier in [review.md](../architecture/review.md) naming relay admission, relay storage and pictures.

## Order

Part 1 first. Parts 2, 3a, 5 and 6 start when part 1 has merged; part 4 does not depend on part 1 and can start at once. Part 3b follows 3a and 4. Part 7 follows 1 and 3a. Part 8 closes the stage.

## Rules for every part

- A library's standard behaviour is the default ([AGENTS.md](../../AGENTS.md) rule 12): Hocuspocus hooks and Yjs through their public interfaces, no fork and no second wire protocol.
- Access, storage, pictures and backup are Full-tier reviews. Every source change gets one review by someone other than its author.
- Standalone editing and the `.splitpage` format do not change. No part enables shared mode in a release build.
- The repository is public: no host name, user name, absolute path, token or secret in anything committed.

## Outside Stage 3

- The update journal, durability receipts and "saved to server".
- Screens and wording for sharing, joining, leaving, status and the picture placeholder beyond one plain label (Stage 4).
- Presence (Stage 5).
- The public hostname, the release entry point for shared mode and the hands-on IME check, which are the owner's.
- Issues [#1748](https://github.com/RetroGorilla/splitpage/issues/1748) and [#1749](https://github.com/RetroGorilla/splitpage/issues/1749).

## Part 3a picture HTTP API

Use `PUT` and `GET` on `/api/scripts/<encoded-script-id>/pictures/<lowercase-sha256>` with the script invitation in the `Authorization: Bearer` header. A PUT sends raw image bytes and the detected image MIME type as `Content-Type`. It returns 201 for a new picture association or 204 for a retry. Invalid access returns 403. GET returns 404 when the authenticated script has no record for the hash. PUT returns 413 for either size limit, 415 for invalid type or dimensions, and 422 for a hash mismatch.

The relay reserves four 16 MiB upload slots for a 64 MiB staging budget. A full staging area returns 503, and an upload that takes more than 60 seconds is disconnected. The relay removes abandoned staging files at startup while it holds the writer lock. SQLite accounts for each script's pictures even when multiple scripts share the same validated bytes.

Relay startup creates storage version 3 or upgrades the Part 1 and Part 2 schemas in one transaction. The upgrade preserves existing scripts, invitations, document bytes and creation IDs.

Before Part 7, the database-only backup command refused snapshots containing picture associations.

Build the relay image from the repository root with `docker build -f collab-server/Dockerfile .`. The build context includes the shared picture policy.
