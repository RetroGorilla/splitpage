# Shared session owner

`createSharedSession(ports)` in `src/application/session/shared-session.ts` is the
session owner for a shared document. It implements `CommonDocumentSession` and adds
`revision()`. Nothing in the running app constructs it yet: wiring, the flag and the
real replica port are packages 9, 12, 13 and 14.

## Ports

`ReplicaPort` is the only way to the shared document, in plain types:

| Field | Meaning |
| --- | --- |
| `revision()` | A number that advances once for each transaction that changed the document |
| `project()` | The whole document as a plain object |
| `execute(operations, { base })` | Runs one list of operations as one transaction, or refuses it with a reason |
| `observe(listener)` | Calls the listener after each transaction with its origin, or `null` |

The other ports are the standalone session's: `entry`, `undo.record`, `effects`,
`capability`, `report`, `timers`. There is no attribution port. Tests build the
replica port from the adapter in `tests/application/session/shared-session-support.ts`.

## One transaction, one change

A transaction that advanced the revision becomes exactly one `SessionChange`, even
when its compared set is empty. A transaction that did not advance it (a duplicate
delivery, an update still waiting for its dependency) becomes none and is not projected.

| Origin | Kind | Generation | Undo entry | Effect pass | Change set |
| --- | --- | --- | --- | --- | --- |
| the first document to arrive, or `hydration` | `adopt` | kept, epoch opens | none | none | whole document |
| `local-command` | `edit` | advances | one | one | compared, with the plan's `derive` and `saveNow` |
| `local-undo` | `replay` | advances | none | one | compared |
| `remote`, `cleanup`, none | `remote` | kept | none | none | compared |

"Compared" is `changesBetween(before, after)` in `projection-changes.ts`: the cells of
kept beats whose value differs, inserted and removed beat ids, whether kept beats
changed order, and the document fields whose value differs. A repeated beat id on
either side gives the whole document. The owner projects the whole document per
transaction in one function, `projectionStep`, which the incremental projector (6c)
replaces; the precise set is the contract.

The held document is what the `entry` port returns for the projection, and the set
is compared between two held documents. The tests use `migrateRows`, the only
producer of a `ValidatedDocument`. It is not the identity on a projection: for a
beat made by a split it fills the default fields and rewrites the writer-scoped id
(`["structure","1","enter","beat"]` is held as `structure1enterbeat`), so a held beat
id is not always the shared one. `shared-session-replicas.test.ts` pins this. Which
entry the wiring supplies, and how a command names such a beat, is open for package 14.

A `remote` change carries no `derive` names. Whoever needs derivations refreshed
after another person's change subscribes and asks for them.

## Commands

`run(command)` plans against the held projection. A plan without `shared` is rejected
as `not shared`; an empty operation list is a no-op. The default base is the revision
of the projection the plan read, so a projection that fell behind refuses as
`stale-base`. A refused list produces no change and calls no subscriber.

| Replica result | Outcome |
| --- | --- |
| accepted, transaction landed | `applied`, or `committed` with the errors of undo, effects or subscribers |
| accepted, nothing written | `noop` |
| refused | `rejected` with the replica's reason |
| threw before its transaction | `failed` |
| threw after its transaction landed | `committed`, the throw among its errors |
| landed but could not be projected | `failed` with the projection error |

Re-entry: a command issued while the session executes a command or delivers a change
(from a subscriber, the undo port, an effect or a handler) is rejected as `reentered`
for every origin and never reaches the replica.

A projection that throws is reported, publishes nothing and keeps the held document
and revision. The next transaction that projects reports everything since.

## Deliberate defects

`tests/collab/shared-session-mutants.json` holds six, each listed in
`tests/collab/mutants.md` with the test that fails.
