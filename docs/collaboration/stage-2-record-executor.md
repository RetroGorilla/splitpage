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
view has `get(path)`, `kind(path)`, `keys(path)` and the live `writer` identity;
its returned values are frozen. `writes` describes fixed path effects (`set`,
`delete`, `map`, `text`, `array`) which the entry adds to its overlay. A later
prepare sees those effects without a copy of the document. Each `apply(handle)`
executes its already-fixed plan, with no validation or semantic decisions.
`applySharedMapWrites` interprets map creation/set/deletion plans. Text and
structure handlers supply their own apply interpreter and corresponding effects.
An apply exception escapes as a handler defect, never as a refusal: the library
cannot roll back the partly written transaction. Prepare must have no external
effects; returning a refusal or throwing leaves all live state unchanged.
Registration is per live handle and duplicate kinds are refused. Scalar/status
handlers are built in; text and structure handlers register from their own files.
No application caller imports the executor. Typing, undo and save paths are untouched.

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

Public reader snapshots use public wire encoding/decoding before validation. This gives
raw map keys and stored ids identical normalization, including malformed clients'
colliding strings, without accessing private library structures. Scalar records
use declared output field order; nested opaque JSON keys use UTF-16 order.
Command preparation reads and validates individual live values instead of
encoding the document. Concurrent scalar writes use the library's deterministic
client order, with identical results on every copy; this tie-break is assumed.

## Trace boundaries

The T21 scalar fixture's status/notices portion and the repaired four-event
common-root regression are reproduced. The fixture's text change and undo need
the text and undo executors. T11 comment/reply records belong to the second part
of this package; anchors, fully deleted words and recovery require marks,
structure and recovery. Remaining Stage 1 histories use text, marks, structural
commands, projection, buffering or undo outside this package.
