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
| `remote`, `cleanup` | `remote` | kept | none | none | compared |

The table is `ORIGIN_KINDS`, literal data keyed by `ReplicaOrigin`, which a test holds
equal to a table keyed by the adapter's `SharedTransactionOrigin`: a new adapter
origin fails the typecheck until it is given a kind. An origin outside the table
(the adapter reports `null` for a transaction it cannot name) still changed the
document, so it is published as `remote`, the kind that records and saves nothing,
and reported through `report` as an unrecognised origin.

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

## Where standalone code would take `remote` for a local commit

The standalone session and the features were written when every change was the
local person's. This owner answers for itself; the rest is named for its package.

| Place | In this owner | Still to do, and where |
| --- | --- | --- |
| `commit` in `document-session.ts` advances the generation | The generation advances for `edit` and `replay` only; `commit` is not widened | Nothing |
| Undo is told of `edit` only, and has no counterpart of `absorbDisk` for a change from elsewhere | The undo port hears `record` once per local edit and nothing else. It is not told of `remote`, `replay` or `adopt` | Package 10: the shared undo owner. Until then no undo owner that keeps its own copy of the document may be wired to this session, since it would replay over remote changes |
| `transact` signs every transaction through the attribution port | There is no attribution port; a received change issues no operation and leaves the stamps as received | Package 8 |
| `withRecords` reconciles records for `edit` | No record reconciliation for any kind; records change by explicit operations | Package 8 |
| `settle` and `AbsorbedKind` | Not part of this owner, which implements `CommonDocumentSession` only | Packages 12 and 13 for their callers |
| `pass` in `effects.ts` runs dirty, draft and save for any kind it is given, and `createSessionEffects` then marks the document unsaved, writes a draft and schedules a save | `pass` is called for `edit` and `replay` only | Package 13 decides what the three effects do for a local edit in shared mode |
| `render.ts`: whole or incremental paint by kind, title inputs refreshed on `titleVersion` or `replay`, cells skipped while a local paint is shown | A remote title change names `title` in `docFields`; cells are named one by one | Package 9 (paint-time base, headings, visuals and title) and package 14 |
| `comments.ts` counts by kind and reads `docFields` | A remote change to comments names `comments` in `docFields` | Package 12 |
| `local-files.ts` refreshes the file menu by kind | Nothing | Package 13 |

## Deliberate defects

`tests/collab/shared-session-mutants.json` holds eight, each listed in
`tests/collab/mutants.md` with the test that fails.
