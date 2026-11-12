# Join glue registers

[Assumed rule 28](https://github.com/RetroGorilla/splitpage/issues/1414#issuecomment-6815511270)
keeps issued join ids, targets and original glue immutable. A separator change never
changes which join is selected. A person sees the same winning separator on every
copy when two people set it without seeing each other's set, using the scalar winner.
Undo follows the scalar rows of rule 23; a replaced choice's undo is used up.

The register is one cell in the existing meta map, keyed by the same tuple as
retirement: `["join-retirement", source, target, originalGlue, generation]`, with
the fixed `joinGlue:` prefix. `sharedJoinGlueRegisterField` is the field-name mapping.
Identical joins issued apart share that cell: changing either one's separator before
delivery survives the other entry arriving, regardless of which entry is selected.
Different source groups remain independent even when damaged maps reuse a native id.
There is no new root or concurrently created nested container, no old-key reader,
and no register scan. The vocabulary permits exactly an empty string or one space.

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

The command handler is described in [the join executor](stage-2-join-executor.md).
Its compensating value uses the same register path; structural undo integration
remains with its owner. No standalone flow result changes.
