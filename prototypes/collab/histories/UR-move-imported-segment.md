# Movement expects the seeded segment naming convention

The command identity matrix first used an imported document for every command. In layout B, moveBeat fails on that imported document before writing because it expects `seg-<beat>` but fromDocument creates `seg-b-<beat>`. Input normalization does not fix that existing naming assumption.

History: fromDocument with rows `R\uD800` (audio `# A`), `S\uD800` (`bc`), `T\uD800` (`de`), all status todo, and a section before R; then moveBeat(history, `R\uD800`, `T\uD800`). Observed after shared command normalization: `Expected a shared map`. No move or undo is applied.

The identity matrix uses SchemaReplica's seeded layout for moveBeat, as the existing move histories do. It checks the same surrogate-containing command arguments, undo and redo against encoded reloads there. Movement of imported segments remains unproven; no movement implementation or expectation changed for this limitation.
