# Record and scalar executor contract

`src/adapters/collab/execute.ts` exports `executeSharedOperations(handle, operations)`.
The list is ordered and prepared against a read-only live view with a small
path overlay for earlier prepared effects. Preparation performs no document
encoding and writes no shared state. All accepted writes then run as one
`local-command` transaction through the live client's identity. Refusals return
the original operation, its index and a reason, without modifying encoded state.

Other executors call `registerSharedOperationHandlers(handle, handlers)` from
`operation-handlers.ts`. A handler maps a vocabulary kind to
`(operation, view) => {ok:false, reason} | {ok:true, writes, apply}`. The read-only
view has `get(path)`, `kind(path)`, `keys(path)`, `text(path)`, per-call `scratch`
and the live `writer` identity; ordinary read values are frozen. `writes` describes fixed path effects (`set`,
`delete`, `map`, `text`, `array`) which the entry adds to its overlay. A later
prepare sees those effects without a copy of the document. Each `apply(handle)`
executes its already-fixed plan, with no validation or semantic decisions.
`applySharedMapWrites` interprets map creation/set/deletion plans. Text and
structure handlers supply their own apply interpreter and corresponding effects.
An apply exception escapes as a handler defect, never as a refusal: the library
cannot roll back the partly written transaction. Prepare must have no external
effects; returning a refusal or throwing leaves all live state unchanged.

One guard per handle spans preparation, application and synchronous transaction
observer delivery, and is cleared in `finally`. Nested execution and other adapter
writes on that handle throw as caller defects before changing anything; only the
entry's prepared apply phase may use the low-level write interpreter.

Registration is per live handle and duplicate kinds are refused. Scalar/status
handlers are built in; text and structure handlers register from their own files.
No application caller imports the executor. Typing, undo and save paths are untouched.

## Text preparation and mechanical apply

Prepare decides refusal, the units to insert or delete, mark ranges, every record identity
`[writer, operation id]`, and every observed record identity named by a removal or birth.
Records planned earlier in the same call are named by their already-known identity.
Positions are plain UTF-16 indices into the text at that operation's own apply step.
Apply steps run in list order inside one transaction, with no intervening commands.
At step k the text therefore equals the planned text after steps before k.
Apply mechanically translates indices to native anchors and reads the born
`{client, clock, length}` from the insertion it just made. It does no validation or
branching on document content; a failure means the prepared plan or its interpreter is defective.

`view.text(path)` caches a frozen facade for one existing text: UTF-16 units and
their current marks, occupied canonical record keys, validated records with resolved
ranges (including empty ranges and gone anchors), and `resolveAnchor` returning an
index or collapsed gap with its affinity, or gone. Embedded payloads are frozen plain wire values.
No native type leaves the facade. It represents live base text; subsequent text
planning lives in scratch, while other handler families read planned values through
ordinary `text` writes in the overlay. A virtual new text has no live facade.

`view.scratch(key, create)` retains a handler's mutable plan only for this prepare
phase. Text handlers build it once from base units indexed by their live positions,
advance it in list order, and label inserted units with operation id and offset.
This maps original-base references and references to an earlier insertion through
earlier planned edits, including a collapsed gap. Scratch and caches are cleared
when prepare ends, and later access through the view or an anchor resolver throws.

`prepareSharedMarkWrite` validates a fixed mark plan from plain length, occupied
record identities and chosen indices/payload/observations. `applySharedMarkWrite(handle,
{target, plan})` encodes anchors and appends a fixed existing-text record.
`applySharedTextEdit(handle, {target, edit, marks})` performs a fixed insertion,
embedded-atom insertion or deletion, then appends its fixed records; an `inserted`
record plan receives the native birth identity from that insertion.
`applySharedTextAnchor(handle, {target, index, affinity})` mechanically encodes a position.
All three require the entry's applying phase, open no transaction, and refuse idle,
prepare and observer calls. The older idle-only authoring helpers retain validation
and share native mutation primitives with these interpreters. Text creation remains
the structure executor's responsibility; these helpers require an existing text and store.

`readSharedRevision(handle)` is a replica-local monotonic number, never stored or
encoded. A transaction changing the document increments it once, regardless of origin;
empty transactions and duplicate deliveries leave it unchanged. The optional third
entry argument `{base}` is checked before preparing any operation. A mismatch returns
`{ok:false, reason:"stale-base"}` without writing. Package 9b will capture this token
when painting. Refused and empty calls deliver no update; a changing accepted call
uses one transaction and delivers one update under the live client identity.
The view's readonly `base` is that checked token, or null for an unversioned call;
text handlers can therefore refuse base references when the precondition was not supplied.

## Scalar coverage

| Document field | Operation field / coverage |
| --- | --- |
| `titleOrigin`, `titleVersion` | `fileTitle`: one atomic object in hydration, execution and reading; optional fields |
| `wordsPerMinute`, `targetSeconds`, `paragraphsDecided` | Same field name; target length can be cleared |
| `docId`, `schema` | Hydration only, immutable instance identity/version |
| `title` | Text executor |
| `rev`, `lastEditedBy`, `lastEditedAt`, `personColors` | Capture metadata retained by hydration; export stamps belong to projection/export |
| Unknown document fields | Atomic JSON object encoded in `extra`, matching hydration |
| Beat `lengthSeconds`, `paragraphStart` | Same field names, including clear |
| Beat `updatedAt`, `updatedBy` | Atomic `stamp: {at, by}`; grouping is the caller's responsibility |
| Beat `status`, tag `status`, shot `status` | Causal `status` operation only |
| Beat `id`, heading `id` | Immutable; structure executor creates them |
| Beat cells, heading `name`, heading `firstSceneId` | Text/structure packages |
| Unknown beat and heading fields | Atomic `extra` JSON object |

## Status decisions and assumptions

The [Stage 0 product decisions](stage-0/9-stage-1-experiments.md#product-decisions)
decide different concurrent values keep the prior status, identical values apply,
and a causally later command applies. Stored events use the vocabulary validator
`readSharedStatusEvent` for both authoring and reading. Their `prior` records the
writer's observed result, but resolution never uses it to break a tie.

Assumed, following the Stage 1 prototype: deeper conflicts resolve recursively
against common causal ancestors; absent ancestors do not participate in reading;
cycles return the stored status. Authoring with incomplete known ancestry is
refused, as is a parent list differing from the observed frontier. If missing
ancestry never arrives, authoring stays refused: the caller receives
`incomplete-status-ancestry`, the displayed status stays unchanged and a future
UI must explain why the requested change did not apply. This is an assumption.
Stored event identity is `[live writer id, operation id]`, so concurrent writers
using the same operation id keep both events. Reusing an id on the same writer
is refused. Parents use stored identities; an unscoped operation-id alias is
accepted only when unambiguous. Retired-event reads are retained for the future
undo package, which alone will write retirements.

Every stored adapter identity must be well formed UTF-16 and contain no U+FFFD;
`isStableSharedIdentity` checks this without normalizing.
A status event with an unstable key, id, parent, target or string writer (`by`) is
absent to readers and preparation, and unstable authored identities are refused
without rewriting or deleting anything.
Mark and other record stores adopt this shared helper in their own pull requests.

Scalar preparation reads target fields; its fixed-count test covers unrelated
records. A status command enumerates the document's flat status-event root once,
so collection and validation work is linear in the document's status-event count,
followed by target ancestry resolution. Status commands are outside the typing
path; a replica-local per-beat index arrives with incremental projection in package 6c.
Scalar output uses declared field order and opaque JSON keys use UTF-16 order.
Concurrent scalar writes use the library's deterministic client order, with
identical results on every copy; this tie-break is assumed.

## Trace boundaries

The T21 scalar fixture's status/notices portion and the repaired four-event
common-root regression are reproduced. The fixture's text change and undo need
the text and undo executors. T11 comment/reply records run through the
[record handlers](stage-2-record-handlers.md); anchors, fully deleted words and recovery require marks,
structure and recovery. Remaining Stage 1 histories use text, marks, structural
commands, projection, buffering or undo outside this package.
