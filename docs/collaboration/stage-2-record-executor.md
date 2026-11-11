# Record and scalar executor contract

`src/adapters/collab/execute.ts` exports `executeSharedOperations(handle, operations)`.
The list is ordered, staged against a wire-decoded copy, and committed as one
`local-command` transaction. Refusals return the original operation, its index
and a reason; they never modify the live encoded state. Unexpected failures in
live observers remain errors rather than reported refusals.

Other executors call `registerSharedOperationHandlers(handle, handlers)` from
`operation-handlers.ts`. A handler object maps vocabulary kinds to functions
`(stagedHandle, operation) => null | reason`. The handle belongs to the staging
copy; handlers must only mutate that handle, with no external effects. Returning
a reason or throwing refuses the list, including preceding staged changes.
Registration is per live handle and duplicate kinds are refused. Scalar/status
handlers are built in; text and structure handlers register from their own files.
No application caller imports the executor. Typing, undo and save paths are untouched.

## Scalar coverage

| Document field | Operation field / coverage |
| --- | --- |
| `titleOrigin`, `titleVersion` | `fileTitle`: one atomic object, optional fields |
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
refused, as is a parent list differing from the observed frontier. This resolves
the open partial-ancestry authoring question conservatively without inventing an
event. Event ids cannot be reused. Retired-event reads are retained for the future
undo package, which alone will write retirements.

Reader snapshots use public wire encoding/decoding before validation. This gives
raw map keys and stored ids identical normalization, including malformed clients'
colliding strings, without accessing private library structures. Scalar records
use declared output field order; nested opaque JSON keys use UTF-16 order.

## Trace boundaries

The T21 scalar fixture's status/notices portion and the repaired four-event
common-root regression are reproduced. The fixture's text change and undo need
the text and undo executors. T11 comment/reply records belong to the second part
of this package; anchors, fully deleted words and recovery require marks,
structure and recovery. Remaining Stage 1 histories use text, marks, structural
commands, projection, buffering or undo outside this package.
