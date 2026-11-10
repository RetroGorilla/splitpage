# Instance-scoped image handoff and recovery

T13 and T17 pass with picture P under **pending-image** and **upload-before-sync with two documents**. Their literal artifact 8 results are unchanged. Default image behavior and its recorded one-document separate-N failure remain unchanged. No app code changes, journal/refusal changes, new dependency or change to the selected image design.

## Configuration and the closed surface

The authorized configuration is an optional fifth constructor input:

```typescript
new ImagePublication(seed, design, mechanism, capture, { instance, token })
```

The module immediately copies both strings into private fields. Caller mutations to the input object do not change initial authentication or reconnect authentication. No getter, own property, return value or captured state exposes the token or a provider/socket. Defaults remain `{instance: "fixture", token: ""}`. The returned publication/ports/transport member lists are exactly the existing literal lists.

Canonical Step1, authentication, close and the one-use fence are encoded for the configured instance. Authentication permits exactly the configured token and version `4.8.0`, with no trailing payload. Single-byte heartbeat controls remain unchanged. A different token, version, instance or extra byte is refused during an upload hold. A token longer than 127 bytes is exercised through the real provider and admission path, including its variable-length encoding. Existing restrictions on opaque controls, awareness, raw sync frames and second publishers remain in force.

`images-configured.test.ts` invokes the same `observeCapabilityInventory`, `observeNetworkWrites` and `observeImageReview` functions as the original suite. Optional target setup provides generated ids and recognized invitations; the expected capability lists, native-object lists, text identities and refusal assertions are unchanged. The default `images.test.ts` is unchanged. Both mechanisms pass the complete inventory, and both default and configured paths run the read-only N, stateless, awareness, second-attach/provider, reply-generation fence and W-before/Z-after-picture assertions.

The unchanged one-document separate-N failure remains in `histories/T16-one-document-N.json`. This follow-up does not reinterpret it as a pass.

## Blob admission and initial commitment

Blob URLs now address `/api/images/<instance>/<sha>`. `imageService` takes an admission callback; default standalone fixtures still admit only `fixture` with an empty token. Instance wiring delegates to the same record/hash authority as document admission. Committed instances admit their owner or recognized invitation. A pending instance permits only its owner to upload/download initialization assets; pending guest invitations and document joins remain refused. This exception lets initialization finish before the instance becomes joinable.

Wrong, missing and another instance's valid invitation are refused before storing bytes. Membership is keyed by the configured instance even when identical hash bytes are already present for another instance. Upload admission is checked again after receiving the body and before submitting it to the existing blob worker. Durable-file/member ordering in that worker is unchanged. This does not add invitation revocation or production HTTP authentication beyond the prototype's existing instance records.

Initial document upload may stage g0 while P is uploading. The commit route obtains that operation's staged state and instance id, then reads every gallery reference through the authorized blob GET route and verifies its SHA-256 before the initialization transaction runs. A pending marker does not waive the initial-handoff requirement. Attempting commit while the harness holds P's membership fails and leaves the instance pending. No image or invitation is represented as complete from staging alone.

## Workflow and independent evidence

The Node workflow uses only owned image editing ports, copied snapshots/captures, the owned transport and public HTTP routes. It does not read private fields, replace a provider or rewrite addresses on the wire. It stores k before the creation request. Captured E/N bytes, g0 and incremental edits, required P bytes, manifest and creation/membership metadata share an in-process completion-aware local record. Its `save`/`hydrate` contract mirrors the browser store's capture/completion semantics; this is not a browser or desktop storage experiment.

For upload-before-sync, the handoff starts with a distinct empty N and E containing g0/P. X and Y remain in E while P's membership is held. After upload acknowledgement, `durable(p)` releases through the existing M3 bridge. Pending-image keeps g0/X/Y in its one document and clears the pending flag through the existing durable transition. Both are permitted by T13: it fixes the resulting script, asset durability and handoff ordering rather than a particular pre-initialization N value.

An initial HTTP commit already covers g0, while the owned image client registers its full initial state as local receipt work. The test therefore submits a real duplicate full snapshot through the owned transport after membership is durable. Its observed positive receipt supplies that coverage; no HTTP response or fabricated receipt history is passed to `restoreAcknowledged`. A separately held g2-containing document message proves that blob completion alone cannot produce `Your changes saved to server`.

The harness declares all fixture document transmissions accepted, observes their actual sends and statuses, and passes their acknowledged bytes to the independent checkpoint/tail coverage checker. Server diagnostics only schedule probes. SQLite, the hash file and SHA-256 are read independently to prove P's membership, presence and bytes. Invitation publication invokes a harness-owned observer that rejects publication while its local-commit gate is closed, then checks the committed local membership, server lifecycle row and P storage.

## Result matrix

| Row / delivery | Pending-image | Upload-before-sync, two documents |
| --- | --- | --- |
| T13 normal, duplicate snapshot, late replica | PASS | PASS |
| T13 hard kill during P upload, resume persisted k/g0/g1/g2 | PASS | PASS |
| T13 committed initial state, lost response, restart/retry k | PASS | PASS |
| T17 all previous clients offline, whole-journal recovery | PASS | PASS |
| T17 checkpoint after c plus journal-tail d, restart, invited C | PASS | PASS |

T13 uploads g0 `R1 "abcd"` with P while the owner types X and Y. Server and local state end at literal `abcdXY`, identities `7:0..3, 11:0..1`, and exactly one `gP` with the literal PNG hash. Pending guests are refused. An invitation is published only after the initialized server state/P and complete local membership/P record hold. Server-saved waits for a receipt covering g2. Normal, upload-restart and lost-response variants return the same instance for k. After the owner leaves and a further server kill/restart, an empty late replica downloads verified P, displays `picture`, exports it with no missing asset and retains the same character identities and instance docId.

T17 has A insert c (`11:0`) and B, after receiving it, insert d (`12:0`), leaving literal `abcd` with initial `7:0,1`. P is durable before the last receipt. Both clients leave and are destroyed before the server kill. C joins with its recognized invitation, receives checkpoint/tail or journal state, and remains uneditable while picture hydration is held. C initially reports a placeholder; after verified download and local completion it displays P, exports `images:[p]` and `missingImages:[]`, enables editing, and reports exactly `Saved on this device`. The restarted server serves P without any earlier client providing it. After that complete row is asserted, a separate literal `E:13:0` edit produces `abcdE`, proving editing is actually enabled.

A second harness-held gate pauses C's local write after P has been verified. Even though its picture projection can then display P, the local store still has no completed record, status stays `Saving on this device`, and editing remains refused until that gate is released.

No row requires bending either ordering. The pending-image design's permission to synchronize pending references does not remove T13's initial-invitation durability contract. No expected result or library-source prediction was changed or refuted.

## Defects and retained history

Before registering honest image-bearing traces, the enforcing parent requires the existing duplicate-allocation, early server/local invitation, overstated checkpoint and over-pruning checkers to reject their unchanged fixtures. The fixture body is extracted to `test/service/instance/defects.ts` and reused by the original test without changing its assertions.

The additional deliberate defect kills after checkpoint/prune and removes P's file while retaining its reference and membership. Under each ordering the independent checker must fail with `Recovered picture bytes missing`. The same checker then validates honest recoveries. History: `histories/T13-T17-picture-loss.md`. The initial fixed-scope/empty-token failure and authorized resolution are retained in `histories/T13-T17-image-instance-boundary.md`.

## Changed responsibilities

| Files | Responsibility |
| --- | --- |
| `images/publication.ts`, `images/configuration.ts` | Private immutable configuration; exact instance/token control encoding; default behavior preserved. |
| `images/service.ts` | Instance-addressed and admitted blob route; initial-state asset verification through that route. Blob worker unchanged. |
| `instance/storage.ts`, `instance/gateway.ts` | Blob-admission lookup, owner-only pending-asset initialization, and authorized staged-state lookup needed by route wiring. Existing journal/checkpoint algorithms unchanged. |
| `instance/extension.ts`, `server-process.ts` | Wire blob admission and initial-commit asset checks; document staging remains possible before asset completion. |
| `test/service/images/` | Parameterize target/reads so existing assertion bodies and literal inventories also run against generated instances. |
| `test/service/instance/` | Node workflow/local model, scoped admission/control tests, full T13/T17 image traces and reused defect gate. |

Journal files, receipts, refusal files, blob-worker logic, app sources, dependency manifests, original instance reports/measurements and the separate-N failure history are untouched. Existing real-editor handoff requirements still apply: operation ownership, detaching automatic file writers, full required-asset accounting, local transaction completion and hydration before editing, verified downloads, pending/export disclosure, and identity/credential separation. This follow-up adds no app integration hook.

## Reproduction and validation

From `prototypes/collab`, Node 24.22.1, set `TEMP` and `TMP` to a lane-specific `<temp>` directory, then:

```text
npm ci
node --test --test-concurrency=1 test/service/images/images.test.ts
node --test --test-concurrency=1 test/service/instance/images-configured.test.ts test/service/instance/images-lifecycle.test.ts test/service/instance/instance.test.ts
npm test -- --test-concurrency=1
```

Final serial package run: **1,250/1,250 passed** on Node **24.22.1**, based on `2d375ea6`. This includes **30** unchanged default image records, **17** generated-instance configuration/inventory/hold records, **14** image-bearing lifecycle records, and **26** original instance records. The original and generated paths use the same literal capability inventory and native-object member lists; both list blocks were also compared directly against main and are unchanged.

Root lint, typecheck, comment and dependency gates pass; typecheck covers **158** prototype TypeScript files, the comment gate scans **1,905** files, and the dependency gate scans **1,585** modules with zero runtime cycles or new exceptions. Code-map and diff checks pass. Changed-file privacy scanning rejects the local host/user names and absolute local paths; no such metadata is committed. Existing measurement reports were left to the separate cleanup on main.

All child servers use free loopback ports and are killed in `finally`; no browser, app, desktop or performance suite is run. Every wait has a throwing deadline, and no elapsed interval establishes an ordering or missing event.
