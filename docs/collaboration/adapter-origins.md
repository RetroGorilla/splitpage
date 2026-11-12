# Adapter transaction origins

`SharedTransactionOrigin` is the closed vocabulary for transaction observation. `shouldDeliverSharedUpdate(origin)` is the adapter's delivery policy: deliver every origin except `remote`.

| Origin | Meaning | Shared undo | Attribution |
| --- | --- | --- | --- |
| `local-command` | This writer's command | Command history | Command author |
| `local-undo` | This writer's semantic undo | Explicit history operation | Undo policy |
| `hydration` | Initial plain-document import | Excluded | Nobody |
| `remote` | Applied received update | Excluded | Preserve received authorship |
| `cleanup` | This copy's native formatting maintenance | Excluded | Nobody |

Native formatting cleanup creates its own local transaction with no origin. The adapter gives that transaction `cleanup` while a named transaction scope is active, regardless of the triggering origin. Its deletes must reach other copies, including when a received update triggered it. Session and undo owners must treat this as maintenance, never as a user command or an attributed edit. Transaction observation reports a local command and a following cleanup separately.

A received update that arrives while a transaction is being announced is held and applied afterwards as its own `remote` transaction, and a local write in that interval is refused: see [stage-2-ingress-gate.md](stage-2-ingress-gate.md).

The deterministic test queue publishes generated maintenance updates after the received delivery returns, then drains them to quiescence. The existing refusal of a received update reported synchronously as local remains in force. `deliveryReplica` uses the adapter policy rather than duplicating an origin filter.

The earlier anchors generator delivered only updates whose origin was not `remote`. It used one seeded three-writer stream, one-character bold additions, and checkpoints after each local command; D1 flushed after each command while reverse and duplicate runs held delivery until the end. It did not reach the formatting-cleanup disagreement. The expanded cleanup regression uses 48 two-writer histories, every delivery order, and an encoded late joiner per run. The original executor investigation used 24 two-writer and 24 three-writer histories; six two-writer histories disagreed before the origin fix.
