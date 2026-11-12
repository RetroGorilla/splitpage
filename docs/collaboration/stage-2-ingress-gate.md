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
The set has two members, `delivering` and `buffer`. `holdSharedBuffer` acquires the
buffer reason and returns an idempotent release. The drain starts only when the
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

## Tests

`tests/adapters/collab/ingress-gate.test.ts` holds the literal cases;
`ingress-gate-generator.test.ts` places arrivals at random at the top, inside
notifications and inside the drain, with callbacks that throw, and checks each announced
revision against the same arrivals applied one by one. `tests/collab/ingress-gate-mutants.json`
holds nine deliberate defects, listed in `tests/collab/mutants.md`.
