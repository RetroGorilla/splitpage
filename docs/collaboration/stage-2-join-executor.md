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
They write the existing `meta` register returned by `sharedJoinGlueRegisterField`
for the identical-join retirement group, rather than the individual native id,
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
decisions live in prepare; the frozen apply payload writes fixed map paths and translates fixed text positions.
A nonempty list uses one transaction and one delivered update. Refusals leave bytes,
state vector, revision and delivered-update count unchanged.

The join index also keeps both directions of validated candidate relationships for
joined-text routing. `neighbors(beat)` is a frozen, sorted metadata lookup with no
native reads; it retains a reverse edge until its last duplicate entry disappears.
Missing destinations remain candidates, self-links add no neighboring beat, and
invalid entries still reserve their native keys but add no edge. These candidates
do not select joins or interpret retirement: the core interpreter owns those rules.
Map replacements and source deletion patch the same index through its existing
guarded callback. The same index caches validated issued entries, so preparation
reads neither unrelated records nor their join maps.

## Joined narration routing

Assumed rule 36: a join follows the text it was joined to, not the beat id. Both a
seen join and a join made apart from splitting `ab` at one produce `a` / `b cd`.
The byte-copied Stage 1 oracles contain no contradictory combined split/join result;
the 49 oracle-copy checks remain unchanged. The old first-fragment painting and
seen-Enter refusals are positive tests now.

Each new join also writes its own `meta` cell `joinEnd:<native join id>`. Its
validated `{end, start, stop}` holds native relative positions: the destination's
logical end and the source's physical start and end at issue. Positions contain
only the segment, native type/item identities and association; no text is copied.
The source start stays left of new units, and the two ends follow new units. The
single `readSharedJoinEndpoint` validator rejects malformed or unresolved bindings
without selecting a later competing join. Native entries with no binding use their
issued destination and current source fragment. Issued entries remain immutable.

`projectSharedJoinForest` retains the existing selection, cycle and removal policy.
`projectSharedJoinedLayout` then follows native ends and retains boundaries inside
the source's issued interval. Full, recovery, incremental and write-side geometry
share that layout. Field membership remains attached to the retained destination,
so splitting its narration does not move its visuals, gallery, status or duration
to the new row. The existing root-first visual order of a cycle is unchanged.

The native reading of the additionally requested cases is pinned literally:

- Splitting exactly after `ab` gives `ab` / ` cd`, seen or made apart; the separator
  stays immediately before its joined source on the new row.
- Deleting the final `b` apart from the join and split gives `a` / ` cd`; deleting
  both destination characters gives an empty first row / ` cd`.
- Splitting seen `ab c|d` gives `ab c` / `d`. The issued relationship still covers
  the source interval, with its new internal boundary retained; retirement unfolds
  the source rather than rewriting that relationship.
- Removing R1 apart from the split keeps `b cd` visible and R1's `a` in recovery.
  Retiring the join apart from the split gives `a` / `b` / `cd`.

Typed whole-row anchors, painted character identities and captured ranges resolve
to their actual physical fragment. The separator has one canonical virtual identity
for its identical-join group; deleting it sets the existing glue register. Insert,
delete and ordinary Enter prepare all physical positions before apply, including
units and beats staged earlier in the list. All creation/boundary points still pass
the shared surrogate policy. Painted reads use compressed native identity runs,
without building a preparation or an object for each character.

Preparation reads the connected join neighborhood and its touched physical texts.
Joined insertion costs 15 native record reads with zero and 10,000 unrelated beats,
with every root iteration method trapped. The existing four-read join and split
cost assertions keep their original meaning. The native binding writer requires
the entry's apply phase, opens no transaction, and receives a deeply frozen payload.
Late refusal tests include a staged join and edits in both physical fragments and
leave bytes, vector, revision and delivered-update count unchanged.

The seeded joined-row model has 72 histories, 324 accepted commands, 360 emitted
operations, 396 checkpoints, 612 encoded comparisons and 828 incremental change
reports compared with the slow checker. It executes complete app typing,
replacement and Enter lists after two/three writers split and join apart, compares
complete rows and sections with the independent applier, skips zero and defers zero.
Its literal declared-limit table is `[]` for those commands. Prefix extraction
inside a joined source remains a whole-list `partial-joined-prefix` refusal: it
requires moving the logical retained id across physical fragments, unlike Enter.
Range-mark routing across the virtual separator is not part of this typing/Enter cut.
The separate seeded malformed-binding model compares 192 checkpoints with three
writers, reordered/duplicate delivery and encoded state; its declared-limit table
is also `[]`. Rich typing literals retain the inserted birth marks and both native
mark stores through Enter.

The unchanged copied T06 narration oracle and T12 join/undo oracles check original
native identities, concurrent typing, marks and caret positions through a test
reader. Retirement inserts no replacement text, boundary, segment or order entry.
Two/three-writer literals cover identical joins, cancellation before delivery,
concurrent register sets, competing targets, joins meeting removal and typing,
duplicates and encoded late joiners. Seeded checkpoints compare full/incremental
projections and live/fresh indexes, including damaged entries and replaced maps;
their literal declared-limit tables are empty for these command histories.
The identical-separator model explicitly creates joins apart, changes the separator
through different native entries before delivery, then makes causal changes through
either entry. Literals also compare conflicting group sets with the scalar winner;
encoded late joiners and incremental projection use the same group field.

The app agreement test compares complete rows and sections through the app's own
join and Backspace functions, the independent operation applier and the shared
projection. It checks visuals, gallery deduplication, status and surviving duration.
The input matrix also pins Backspace's unchanged cursor-only move from a blank
previous beat with a visual; it emits no operation. Heading and movement commands,
their Stage 1 traces, structural undo UI and production caret placement remain
separate work.
