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
| `project()` | The whole document as a plain object. It may be frozen and share rows with the one before; the entry must not write to it |
| `changes()` | Which rows and document fields differ between the document `project()` gives and the one it gave before |
| `execute(operations, { base })` | Runs one list of operations as one transaction, or refuses it with a reason |
| `observe(listener)` | Calls the listener after each transaction with its origin, or `null`, and, when the replica could not publish that transaction, `{ error }` |

The other ports are the standalone session's: `entry`, `undo.record`, `effects`,
`capability`, `report`, `timers`. There is no attribution port.

`createSharedReplica(handle)` in `src/adapters/collab/replica.ts` builds the replica
port on the incremental projector: `revision()`, `project()` and `changes()` read one
published projection, and `observe` tells the session once per publication. The
session therefore never projects the whole document; a transaction that changed
nothing is not published and does not reach it. `revision()` is the published
projection's, never the live document's, so an observer called between a transaction
and its publication still reads a matching pair.

When the projector throws, the replica catches it: the call that wrote the document
returns normally, and `observe` passes `{ error }` with the origin. Until a
publication lands, `revision()` names the transaction waiting for it, and `project()`
and `changes()` try the projection again. The session reports the error, reprojects
at once and hands row subscribers the whole document; if that attempt throws as well,
both errors are reported and the session catches up at the next transaction. After
`dispose()`, `execute` refuses with `replica-disposed` and writes nothing.

Nothing in the running app calls it
yet. Tests use it through `adapterReplica` in
`tests/application/session/shared-session-support.ts`.

## The changed-rows port

`subscribeRows(listener)` on the shared session calls `listener(rows, change)` once
per published change, after the change's ordinary subscribers. `rows` is the
projection's report (`SharedProjectionChanges`, see
[stage-2-incremental-projection.md](stage-2-incremental-projection.md#the-report-of-which-rows-changed)):
added, removed, moved and changed rows, and changed document fields. An adoption,
and the first change after a projection that threw, give the whole document. No
feature paints from it yet. Change and row subscribers added while a change is
delivered are told from the next change on.

Its row ids are the projection's. The change set beside it is still compared between
two held documents, which are the entry's output (see "The entry port"), so the two
can name a row differently until the entry of package 14. With that entry the
comparison of held documents, and the copy the tests' entry makes of every
projection, can go.

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
either side gives the whole document. The owner takes each next document from the
replica port in one function, `projectionStep`; the precise set is the contract.

The held document is what the `entry` port returns for the projection, and the set
is compared between two held documents: see "The entry port" below for what that
means with the entry the tests use.

A `remote` change carries no `derive` names. Whoever needs derivations refreshed
after another person's change subscribes and asks for them.

## The held document and its revision

`readAt(select)` hands the selector the held document and the revision it was
projected at, in one call. A painter records a base only when that revision equals
the one the replica reports at that moment.

The owner takes the projection inside the replica's notification for the transaction, the same
synchronous step that applied it, and sets the document and the revision together
before it publishes. The pair is therefore behind the replica in two places only:
for an observer the replica tells before the session, during that notification; and
after a projection that threw, until the next one succeeds. In both, `readAt` gives
the old document with the old revision, never the old document with the new one.
A subscriber of the session reads the new pair.

A revision's projection holds that revision's change and no later one. That is the
adapter's promise, kept by its ingress gate: see
[stage-2-ingress-gate.md](stage-2-ingress-gate.md). A received update that arrives
during a notification is held. There is one notification per transaction; the revision
advances only when the document changed. The owner publishes one change per
revision-advancing transaction. A command
issued in that interval is rejected by this owner as `reentered` when the owner is the
one running or delivering; issued from an observer the replica tells before the owner,
it fails, because the adapter refuses the write.

## The entry port

The tests use `migrateRows`, the only producer of a `ValidatedDocument`. It was
written for files, and it is not the identity on a projection. What it does today
to a projected document:

- The adapter's writer-scoped structural ids survive unchanged, as pinned by the
  split literal. Legacy beat ids can lose punctuation; missing beat fields get defaults.
- A heading whose id fails scene normalization disappears; a heading anchored to a
  rewritten beat can be orphaned.
- People, comment, reply and shot ids pass through id cleaning; comment references
  are cleaned and owner references can be cleared.
- Invalid tag ids are minted again.
- Gallery fields are normalized, de-duplicated and limited.
- Records are created from text: a received `B-roll:` line in a visual leaves the
  shared shot collection empty but gives the held document a shot with a generated
  `bs-load-...` id, and the change names `brollShots`.

Change sets are keyed by the held ids. A later command aimed at a rewritten id
would not find it in the replica. `shared-session-replicas.test.ts` pins the preserved
split id and the minted shot, the latter as a declared limit; the other entries are
as found in the review of this owner and have no test here.

Prerequisite for package 14: an entry that is safe for shared state. It creates no
record from text and rewrites no id, and it keeps each scene name exactly as
projected, edge spaces included; `migrateRows` trims names, so the tests' entry
puts the projected names back ([Scene headings in the Writer](stage-2-buffer.md#scene-headings-in-the-writer)). This owner is the same whichever entry it is
given; it is not built here.

## Commands

`run(command)` plans against the held projection. A plan without `shared` is rejected
as `not shared`; an empty operation list is a no-op. The default base is the revision
of the projection the plan read, so a projection that fell behind refuses as
`stale-base`. A refused list produces no change and calls no subscriber.

A plan whose `shared` part declares `undo: false` is still one `edit` with its
generation and effect pass, but the undo port is not told. Its one caller is the
buffer's recovery write (assumed rule 29 on #1414): undoing it would throw the
kept typing away.

`beforeCommand(listener)` registers local admission and returns its unsubscriber.
An outer local `run` asks admissions before capability and planning, so a native
buffer can commit and release held arrivals before the next command reads the
document. A flush may itself call `run`; it skips admission recursively, while
ordinary planning/execution/delivery re-entry is still refused before admission.
A false admission returns `buffer-pending`, a thrown admission returns `failed`,
and neither plans the waiting command. Disposing clears these registrations.
The Writer uses this port only when explicitly bound to a shared buffer.

| Replica result | Outcome |
| --- | --- |
| accepted, transaction landed | `applied`, or `committed` with the errors of undo, effects or subscribers |
| accepted, nothing written | `noop` |
| refused | `rejected` with the replica's reason |
| threw before its transaction | `failed` |
| threw after its transaction landed | `committed`, the throw among its errors |
| landed but could not be projected | `failed` with the projection error |

Re-entry: a command issued while the session plans or executes a command, asks for
capability, or delivers a change (from a plan, a subscriber, the undo port, an effect
or a handler) is rejected as `reentered`
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
| `withRecords` reconciles records for `edit` | The owner runs no record reconciliation of its own. The entry the tests use still mints records from text for every kind, a declared limit: see "The entry port" | Package 8 for explicit record operations; package 14 for the entry |
| `settle` and `AbsorbedKind` | Not part of this owner, which implements `CommonDocumentSession` only | Packages 12 and 13 for their callers |
| `pass` in `effects.ts` runs dirty, draft and save for any kind it is given, and `createSessionEffects` then marks the document unsaved, writes a draft and schedules a save | `pass` is called for `edit` and `replay` only | Package 13 decides what the three effects do for a local edit in shared mode |
| `render.ts`: whole or incremental paint by kind, title inputs refreshed on `titleVersion` or `replay`, cells skipped while a local paint is shown | A remote title change names `title` in `docFields`; cells are named one by one | Package 9 (paint-time base, headings, visuals and title) and package 14 |
| `comments.ts` counts by kind and reads `docFields` | A remote change to comments names `comments` in `docFields` | Package 12 |
| `local-files.ts` refreshes the file menu by kind | Nothing | Package 13 |

## Deliberate defects

Package 14 also follows the session-mode and captured-save lifetime obligations
in [Shared sessions and local file saving](stage-2-disabled-file-saving.md#package-14-obligations),
and the entries left to it in
[Shared sessions and local merge, stash and reload](stage-2-disabled-merge-stash.md#limits),
[Shared sessions, drafts and version history](stage-2-disabled-drafts-history.md#limits)
and [Shared sessions, the script's folder and file bundles](stage-2-disabled-folders-bundles.md#limits).

`tests/collab/shared-session-mutants.json` holds twenty-two, each listed in
`tests/collab/mutants.md` with the test that fails.
