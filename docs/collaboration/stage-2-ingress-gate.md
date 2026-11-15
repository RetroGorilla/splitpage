# Ingress gate

Each shared document handle has one gate, `IngressGate` in `src/adapters/collab/state.ts`.
It makes one promise: a revision is announced with exactly its own change. An observer
that reads the revision and the document during a notification never sees a later write.
There is one notification per transaction; the revision advances only when the transaction
changed the document. Duplicate and dependency-waiting updates can repeat a revision.

The library applies a write nested in a notification at once and announces it afterwards.
Without the gate an observer told about revision 2 could read a document that already
held revision 3.

## When the gate is closed

The gate is closed from the start of a transaction's notifications to the end of the
drain. The outermost adapter write owns that interval: `sharedWriteFrame` runs the write,
then opens the gate and applies the held updates in a `finally`, whatever was thrown.
The library tells the adapter when notifications start; nothing depends on the library
telling it when they end.

| Write | While the gate is closed |
| --- | --- |
| `applySharedUpdate` | Checked at once, appended to the one queue, applied afterwards in arrival order. Arrivals during the drain join the tail |
| `executeSharedOperations`, `transactSharedDocument`, `hydrateSharedDocument`, `createCollabText`, `insertSharedHtml`, `writeSharedMarkRecord` | Refused: `SharedExecutionWriteError`, the same guard that refuses a write during an operation's execution. Never held |
| `destroySharedDocument` | Allowed, except during an operation's execution. Empties the queue and opens the gate |

A received update that arrives inside another adapter write before its notifications
(the body of `transactSharedDocument`, or a library event that runs before the body) is
held too, so it does not join that transaction. During the preparation and application
of `executeSharedOperations` it is refused, as before.

`{ ok: true }` from `applySharedUpdate` says the update is valid. It does not say the
update is applied: a held update is applied when the gate opens. Updates held by a
handle that is destroyed are discarded with it. They were acknowledged as valid, not as
applied.

The gate keeps its reasons for being closed in one set, `holds`, and has one queue.
The set has three members, `delivering`, `buffer` and `capture`. `holdSharedBuffer`
acquires the buffer reason and `holdSharedCapture` the capture reason; each returns an
idempotent release. The drain starts only when the
set is empty, and stops if a callback opens a buffer while draining. A local
buffer commit may write while `buffer` is set; `delivering` still refuses local
writes with `SharedExecutionWriteError`. A commit moment during delivery must
retain its edit for an explicit retry outside that notification.

Preparation and application refuse arrivals and buffer acquisition independently
of those reasons. `notifications` counts the synchronous guarded callbacks, so
an actual notification is distinct from a `delivering` reason left in the set.
Application still takes precedence over notification delivery. The execution
guard matrix pins both phases with no reason, either reason and both reasons,
for received updates and buffer acquisition.

## Bounded buffered arrivals

Assumed rule 26 on [#1414](https://github.com/RetroGorilla/splitpage/issues/1414#issuecomment-6814123286)
sets the named constant `SHARED_BUFFER_QUEUE_BYTES` in `sharedBufferQueueBytes()`
to 64 KiB. The accessor keeps the core module's load-time declarations limited to
types and functions. While `buffer` is set the bound counts
the bytes of the entire one queue, including entries held for delivery. An
arrival that would exceed it returns `queue-full`, distinct from `invalid-update`.
Every subsequent arrival is refused until buffer release, including one that
would fit. Held entries and the native edit remain intact. Delivery alone has
no byte refusal because that queue drains within the outer write.

Release records the declined interval for `observeSharedDeclined`. The outermost
write reports it once after the queue drains, inside `guardSharedCallback`, with
the delivery reason set so every listener reads that completed prefix. A nested
release waits for that same outer drain. A callback failure still permits draining
arrivals queued by a reporting callback.
No declined interval means no report. The caller fetches the missing difference
with a state-vector exchange after release; transport is a later stage. Destroy
clears the queue, byte accounting, refusal latch, pending reports and listeners
without reporting. A destroyed handle cannot acquire another buffer reason.

`tests/adapters/collab/buffer-gate.test.ts` covers the exact bound, latched small
arrival, both reasons in both release orders, destroy and throwing callbacks.
`tests/collab/buffer-overflow.test.ts` checks resynchronization after normal,
reversed and duplicated delivery. Dirty intervals also run in the seeded ingress
generator, retaining its prefix oracle for each published revision.

## Trial replica

Every received update is tried before it may touch the live document. Outside a shared
session (a handle with no replica) the trial is the old one: a throwaway document gets a
copy of live, then the update. Inside a shared session the trial runs on one standing
replica, `SharedTrialReplica` in `src/adapters/collab/trial-replica.ts`. `createSharedReplica`
acquires it; ports on one document share it. The last port's `dispose`, or
`destroySharedDocument`, releases it. A trial
normally costs about the size of the update. Stale recovery and checks of clocks held only
in the replica can still copy the whole live history.

### What the replica contains

The live document, plus every accepted update (held or not), plus every local change. Local
changes reach it through the live document's `update` event, one subscription that every
write route shares: commands (buffer commits and recovery commands included), undo and redo,
hydration from a source or from stored state, text creation, HTML import, mark records, plain adapter transactions and the
library's own formatting cleanup. Remote transactions are skipped: they apply only an update
the replica already took at its trial, whether the gate was open or the update was held and
released later. Every hold counts the same: an update accepted under `buffer`, `capture` or a
delivering notification is in the replica from its trial, and each release drains the queue
through the same path. `tests/adapters/collab/trial-replica.test.ts` checks each route and keeps an
inventory of every library write under `src/adapters/collab/` that fails when a new one appears.

Live plus held changes one case, and only towards refusing. Take an update B that depends on
a held update A, and fails to integrate once A is present: for example, a struct cycle behind
a struct whose origin is in A.

- Before: the copy of live alone kept B's structs pending without integrating them, so B was
  accepted and held. At the drain, B threw partway through on the live document: a partial
  live write, reported and skipped.
- After: the replica holds A, so B is refused at receipt and live never changes.

Assumed rule 210: an update is refused at receipt when it cannot be applied together with the
changes this copy is holding, whichever of them is at fault. No case goes the other way:
against live alone, dependent structs only wait as pending, and the decode and zero-length
checks do not depend on state.

The fault can lie with the held update. Copy 7 sends A, whose first struct waits for (9,0)
and whose next two point at each other; A is accepted and held. Copy 9 then sends a valid
(9,0) four times.

| Path | The four (9,0) arrivals | When the hold ends |
| --- | --- | --- |
| Before, held | accepted four times | the drain throws and live is partly written |
| Before, gate open | refused four times (A already waits in live) | nothing |
| After, held | refused three times, then `intake-stopped` | nothing; live stays as it was |

So one person's unusable held change makes another person's valid change refused here, and
after three refusals stops intake. The alternative would be to drop the unusable held change
instead; that is an open question for the owner.

When an incoming struct overlaps clocks present in the replica but absent from live, the
update is also tried on a fresh copy of live. Otherwise the library could skip invalid
structs as duplicates of held clocks. Genuine held duplicates remain accepted. Disjoint
updates keep the incremental path without a whole-document copy.

A local write can reuse a held clock with different content. When the transaction wrote
clocks that the replica already holds beyond what it copied from live, the replica is marked
stale.

Surrogate pairs need one case. Wire encoding turns a lone surrogate half at either end of an
encoded run into U+FFFD. When a local run starts with a low half and the library merges it
into the previous item, whose last unit is the matching high half, live holds a valid pair
while the replica received two replacement characters. Every point where the replica stopped
taking in live content is such an encoding boundary: the end of an earlier transaction, a copy
or a rebuild for an arrival inside the transaction's body or notifications, refused or held
arrivals included. The library merges a transaction's items only at its cleanup, after its
notifications, so the transaction's `update` event checks each of its stops: the first unit
after the stop and the unit before it in the same item. Deleting one
half of a pair, typing inside a pair, or formatting half of it needs nothing: the library
replaces both halves with U+FFFD when it splits the item, on live and on the replica alike.
A low half typed before its high half is never merged with it and encodes the same on both.
The tests pin these schedules: plain typing and deleting beside a valid pair, a split pair
and a low half typed apart rebuild nothing; a high half, then a low half in a second
transaction, rebuilds once, and so does a pair completed after a stop between its halves (a
valid or refused arrival in the body, an arrival in the notifications, a hold).

Both cases rebuild from live plus held before the next trial. A successful stale recovery
spends no budget.

An update can arrive inside a live local transaction's body or its notifications, before
that transaction's `update` event. The replica then first checks the transaction's writes so
far against live's current state vector (the library fills the transaction's after state only
at cleanup), and either marks the replica stale or copies what it lacks
(`encodeStateAsUpdate(live, replicaVector)`). That copy carries the whole delete set; it
happens only on such nested arrivals and is counted. The copy, or a rebuild at that moment,
records the live state vector it reached. When the transaction's `update` event follows, its
clocks below that vector count as copied, not as held, so a nested arrival does not force a
rebuild afterwards: 50 local writes, each with an arrival in its notifications, cost 50 copies
and no rebuild.

### Refusals and the rebuild budget

An update refused before it reaches the replica costs nothing: an update that does not
decode, a zero-length struct, a full buffer queue. An update whose application to the replica
throws may have written part of itself there. That refusal rebuilds the replica at once from
live plus held, one copy of each, and spends one unit of `SHARED_TRIAL_REBUILD_BUDGET` (3)
for the replica's lifetime. A stale recovery that fails also spends one unit. If a refusal's
rebuild fails, it spends the refusal's unit once, rather than charging twice.

A failed rebuild is latched until the held queue drains. New arrivals do not retry it,
including accepted no-ops appended to the queue. While latched, every incoming update uses
the original copy trial against live alone. Releasing held updates keeps the original live
failure and drain behavior. Once the queue has drained, recovery may be tried again.

Spending the third unit stops intake (assumed rule 211). If a stale recovery fails on a valid
arrival, that arrival still gets its live copy trial and can be accepted; the stop is
announced once, and all later arrivals are refused. Every later received update is
answered `{ ok: false, reason: "intake-stopped" }` with no trial, no rebuild and no write to
live. Local editing and undo go on, held updates already accepted are still released, and
nothing is lost. `observeSharedIntakeStopped` reports the stop once; `sharedIntakeStopped`
reads it. The stop ends only with the replica (leave, replace, destroy); there is no timer.
At the earlier adapter measurement of 142 to 315 ms per refusal and rebuild on heavily
edited states, a whole session pays at most three of those.

### When a hold ends

When a drain has applied held updates and the queue is empty, live's state vector is
compared with the replica's. A mismatch marks the replica stale and adds an error that the
outermost write throws. A state vector does not cover deletions or pending structs, so this
check catches a replica ahead of or behind live in inserted content only. It does not prove
equality; the byte-for-byte comparisons in the tests do.

### What happens when an accepted update fails on the live document

The trial passed, but applying the update to live threw. This is not a refusal, and nothing
about it is new.

- Gate open: the error leaves the outermost write, so `applySharedUpdate` throws to its
  caller. Live keeps whatever part of the update was integrated before the throw: it can be
  partly written.
- Held update: the drain records the error, drops that update from the queue, applies the
  rest, and the write that released the hold throws, as an `AggregateError` if there are
  several. Live can again be partly written by that one update.
- A listener that throws after a full apply is different: live holds the whole update, and
  the error is reported the same way.

The shared session does not end by itself: `forceLeaveSharedSession` runs only when the app
stops and as the fallback of a leave. The projector publishes whatever revision live reached,
and the session takes it as remote. The person sees nothing beyond what that revision shows;
no notice exists for it. The only new part is that the replica is marked stale, including when
the remote transaction never ran, and is rebuilt from live plus held before the next trial.
That rebuild spends budget only if it fails.

### One mirror or two

The incremental projector's mirror and the trial replica are two documents. The mirror takes
updates after live and feeds the projection caches through deep observers. The trial replica
must take an update before live does: a held update may never reach live, and a refused one
leaves the replica partly written until it is rebuilt. Sharing one document would publish
unaccepted or held content into the projection, invalidate its caches on every rebuild, and
clash with the mirror being replaced when text is normalized. Each participant therefore keeps
three copies: live, the mirror and the trial replica.

### Memory

The historical table below is from revision `7e5077d07`; samples not kept.
Measured in Node with `--expose-gc`, adapter level only: heap after two forced collections,
median of five passes, on the growth record's fixtures and its heavily edited states (same
workload, `tests/collab/measure/run.mjs`). Each step is the heap added by that step. Live is
`open(state)`, the mirror is `createSharedIncrementalProjector` (mirror document, projection
and caches), and the trial replica is `startSharedTrialReplica`. The budget lines are from
[Stage 0 audit 7](stage-0/7-performance-baseline.md): standalone after load is 7.13 MiB on long
and 14.96 MiB on large, so the room for everything shared is 10 MiB on long and 14.96 MiB on
large. These are Node adapter heap estimates (`heapUsed`, excluding external backing
storage), not browser figures. `tests/collab/measure/trial-heap.mjs` commits the runner;
`trial-heap.json` records the new run's exact revision, five byte samples per row and medians
in MiB. Run it once, alone, with `node --expose-gc --max-old-space-size=4096
tests/collab/measure/trial-heap.mjs` after committing the code to measure.

| Script / state | Encoded bytes | Live MiB | Mirror MiB | Trial replica MiB | Shared total without / with replica MiB | Room MiB |
| --- | --- | --- | --- | --- | --- | --- |
| short / fresh | 4,189 | 0.14 | 0.38 | 0.08 | 0.52 / 0.60 | none set |
| short / edited | 9,161,362 | 27.61 | 39.48 | 29.53 | 67.09 / 96.62 | none set |
| long / fresh | 73,161 | 0.90 | 4.83 | 0.80 | 5.73 / 6.52 | 10 |
| long / edited | 7,924,346 | 25.79 | 41.66 | 27.62 | 67.44 / 95.06 | 10 |
| large / fresh | 690,502 | 6.96 | 45.31 | 6.10 | 52.27 / 58.37 | 14.96 |
| large / edited | 8,580,233 | 31.97 | 82.25 | 33.04 | 114.22 / 147.26 | 14.96 |

The trial replica costs about as much as live itself. It fits on fresh long (0.80 of 10 MiB,
6.52 in total). On fresh large it alone fits (6.10 of 14.96 MiB), but the session was already
over without it (52.27 MiB, mostly the mirror's projection). On every heavily edited state the
replica alone breaks the budget: 27.62 MiB on long and 33.04 MiB on large. The session already
broke it there before this change (67.44 and 114.22 MiB).

## Errors

A callback that throws inside the library's cleanup would abort it. Every listener the
adapter registers on the document, and every callback it calls for a subscriber
(`observeSharedTransactions`, `observeSharedUpdates`), runs inside `guardSharedCallback`.
The error is kept, the other callbacks and the drain go on, and the outermost adapter
write throws after the drain: the error itself when there is one, an `AggregateError`
holding them in order when there are several. This is the path a throwing observer
already had: the write that caused the notification throws.

A held update whose application throws is reported the same way and skipped. The rest of
the queue is applied. It is not retried; it applies when it is delivered again.

`observeSharedUpdates` is the adapter's subscription to the library's `update` event. A
transport uses it instead of listening on the library, because that event is announced
where a throw aborts the cleanup.

## Declared limits

- Subscriptions go through the adapter (`observeSharedTransactions`, `observeSharedUpdates`).
  A listener set directly on the library object is outside the contract.
  `tests/adapters/collab/guarded-subscriptions.test.ts` holds this rule for `src/`:
  library subscriptions stay inside the adapter and their callbacks use `guardSharedCallback`.
- The scan cannot see computed calls such as `doc["on"](...)`, bound or destructured
  subscription methods, receivers typed `any` or `Pick<Y.Doc, "on">`, or an untyped nested
  `.get(...).observe(...)`. It does not read JSX or TSX files. Its guard check matches
  the name `guardSharedCallback`, not its binding.
- A transaction started on the library itself, outside every adapter write, is not
  gated. Nothing in `src` starts one. A raw write from an observer stays visible as a
  transaction with no origin: see [adapter-origins.md](adapter-origins.md).

## Cost

With nothing held, a received update costs one check of the gate before it is applied
and one at the end of its write. No transaction is added and nothing is queued.

The trial is counted in bytes through the optional `count` hook of `applySharedUpdate` and
`startSharedTrialReplica`. For one received 26-byte update (a scalar change), the copy trial
encodes and applies the whole document again: 1,938 bytes on the two-beat test document
(943 copied) and 286,880 bytes on a 300-beat one (143,414 copied). The standing replica
applies 52 bytes on both: the update once on the replica and once on live. These are bytes
moved by the adapter for those exact fixtures. A stale recovery copies the whole live
document plus held updates, and a nested arrival can encode the complete delete set.

With timing marks on, the trial on the replica and a copy-trial fallback are both inside the
`trial` span (validation), and the live apply is inside `live-apply` (apply). Every rebuild of
the replica, after a refusal, as a stale recovery, or as the copy for a nested arrival, is
inside a `rebuild` pair. `tests/collab/measure/mark-parts.mjs` counts it in validation and also
publishes it as its own `rebuild` figure. A refused update on the replica path marks one
`rebuild` inside its `trial` and `receive`; an ordinary arrival marks none.

Each local transaction in a shared session adds this work, which the composed-editor
measurement still has to time: a set insert and a set clear for the transaction; one pass over
its before and after state vectors (one entry per client that has written to the document); for
each client it wrote, one binary search into that client's structs and a two-unit read per
stop (one stop, plus one for each arrival inside the transaction); and
one apply of the transaction's own update on the replica. The library encodes that update
anyway, because the session already listens for updates to send. No text is read whole.

## Tests

`tests/adapters/collab/ingress-gate.test.ts` holds the literal cases;
`ingress-gate-generator.test.ts` places arrivals at random at the top, inside
notifications and inside the drain, with callbacks that throw, and checks each announced
revision against the same arrivals applied one by one. `tests/collab/ingress-gate-mutants.json`
holds nine deliberate defects, listed in `tests/collab/mutants.md`. The trial replica's cases
are in `tests/adapters/collab/trial-replica.test.ts`, with its session lifetime in
`tests/bootstrap/shared-switch.test.ts`. `tests/collab/trial-replica-mutants.json` holds its
twenty-two deliberate defects.
