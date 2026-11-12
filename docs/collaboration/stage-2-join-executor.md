# Issued joins, glue and retirement

`registerSharedJoinHandlers(handle)` registers `join`, `join-glue` and the explicit
`join-retire` inverse operation. The latter extends the operation vocabulary because
retiring an issued relationship is different from restoring a removed beat or
changing its separator. Structural undo integration remains with its owner; these
handlers execute only through `executeSharedOperations`.

Each issued entry is stored in the source beat's existing `joins` map under a
writer/operation identity with role `join`. Its immutable fields are `into`, original
`glue`, `by`, `operation` and `generation`. Native ids and text never move or copy.
Preparing a join resolves staged creation aliases, validates both targets and the
existing map, and refuses an identity already present anywhere in the join index.
Its operation id passes the same cleaning check as other structural commands.

Glue commands resolve native join ids or aliases staged earlier in the same list.
They write the existing `meta` register returned by `sharedJoinGlueRegisterField`,
mirroring `prepareScalar` in `scalar-executor.ts` through `applySharedMapWrites`.
They change no issued entry, id or target. Causal sets replace earlier sets;
concurrent sets retain the same winner as a conflicting scalar on every copy.
An absent or invalid join refuses `missing-join`; a retired join refuses
`retired-join`. This implements [assumed rule 28](https://github.com/RetroGorilla/splitpage/issues/1414#issuecomment-6815511270)
without another conflict policy. A compensating glue value uses this same handler;
the structural undo owner is not extended in this cut.

`readSharedJoinEntry` is the validator used by preparation and projection. It accepts
a stable nonempty target, an empty string or one space, and a nonnegative safe
integer generation. An older native entry without a generation is generation zero.
Projection selects issued joins using the existing pure join-group interpreter,
including its cycle and removal rules; the executor never rewrites someone else's
choice. `readProjectionBeatStructure` is the only changed projection reader.
Full, recovery and incremental assembly all use it.

Identical joins have the same source, target, original glue and generation. A new
join's generation is one more than the highest matching entry its author has seen,
or zero for the first. This uses the bounded grouping pattern of rule 32 rather than
growing observed-id lists. Retirement records the native join id and the tuple
`["join-retirement", source, target, originalGlue, generation]` as true in the
existing `retiredJoins` map. This cancels an identical join not yet delivered too.
Issued entries remain intact; the reader ignores cancelled entries. A used-up
retirement writes nothing. Generation overflow refuses `join-generation-limit`.

Assumption: joining the same beats again after retiring their join is a new change,
so an older retirement leaves the new join in place. As with the existing tag
grouping rule, a writer who has seen a matching join creates the next generation;
one who has seen none creates generation zero.

The per-handle join index is built while idle and patches changed keys, map
replacements and beat deletion through the structure index's existing guarded
subscription. It adds no subscription or gate exemption. Preparing a command
does not scan a root, encode state, read a text delta or open a transaction. All
decisions live in prepare; the frozen apply payload only writes fixed map paths.
A nonempty list uses one transaction and one delivered update. Refusals leave bytes,
state vector, revision and delivered-update count unchanged.

The unchanged copied T06 narration oracle and T12 join/undo oracles check original
native identities, concurrent typing, marks and caret positions through a test
reader. Retirement inserts no replacement text, boundary, segment or order entry.
Two/three-writer literals cover identical joins, cancellation before delivery,
concurrent register sets, competing targets, joins meeting removal and typing,
duplicates and encoded late joiners. Seeded checkpoints compare full/incremental
projections and live/fresh indexes, including damaged entries and replaced maps;
their literal declared-limit tables are empty for these command histories.

The app agreement test compares complete rows and sections through the app's own
join and Backspace functions, the independent operation applier and the shared
projection. It checks visuals, gallery deduplication, status and surviving duration.
The input matrix also pins Backspace's unchanged cursor-only move from a blank
previous beat with a visual; it emits no operation. Heading and movement commands,
their Stage 1 traces, structural undo UI and production caret placement remain
separate work.

The single-physical-text preparation and painted reader require a following join
routing cut. Its pinned literal declared limit is: "Joined narration paints only
its first physical fragment and refuses whole-row offsets beyond it;
joined-text routing is the next join cut." The reproduction projects `ab cd`,
paints `ab`, and refuses insertion at offset four with `invalid-reference`, leaving
bytes, vector and revision unchanged. `paint-base.ts` has no change in this cut.
