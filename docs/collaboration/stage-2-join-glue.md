# Join glue registers

[Assumed rule 28](https://github.com/RetroGorilla/splitpage/issues/1414#issuecomment-6815511270)
keeps issued join ids, targets and original glue immutable. A separator change never
changes which join is selected. A person sees the same winning separator on every
copy when two people set it without seeing each other's set, using the scalar winner.
Undo follows the scalar rows of rule 23; a replaced choice's undo is used up.

The register is one cell in the existing meta map, keyed by the native join id with
the fixed joinGlue: prefix. sharedJoinGlueRegisterField is the one field-name mapping.
There is no new root or concurrently created nested container. Even damaged beat maps
that reuse one native join id refer to the same register cell. Other register cells
are not scanned. The current vocabulary permits exactly an empty string or one space.

This mirrors prepareScalar in scalar-executor.ts: its frozen set write goes through
applySharedMapWrites in prepare.ts, which calls Y.Map.set on an existing map. A causal
later set replaces an earlier one; concurrent sets have that same native register
winner. No event folding, observed-set bookkeeping or second tie-breaker is added.

readProjectionBeatStructure in projection-reader.ts is the one changed reader.
Its fourth argument is the register map, roots.meta, supplied by project.ts. It keeps
the issued id and into fields and uses projectSharedJoinGlue for the effective glue.
That pure helper is the sole register-value validator. A missing or wrong-shaped
value falls back to issued glue. Cells without an existing valid active join are
ignored. The join-group selector remains unchanged; an unselected join's register
cannot affect the selected relationship. Full and recovery projection use this reader.

The literals cover absent and sequential registers, a causal lower-writer replacement,
two and three concurrent writers in normal, reversed and duplicated delivery, encoded
late joins, invalid values, dangling and retired joins, unselected joins and the
R1/R2/R3 competing-target counterexample. Projection reads preserve bytes, vector,
revision and update count. The seeded checkpoint model compares literal outcomes,
scalar outcomes and encoded copies with a literal empty declared-limit table.

This cut reads stored registers. The join-glue command handler and its scalar-style
reversal belong to the following join cut. No standalone flow result changes.
