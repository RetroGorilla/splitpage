# Other-reader audit: removal attribution and visual ordering

Shows two unchanged readers producing different projections from byte-identical encoded state. Neither is repaired by the status change.

Seed: candidate B, client 100, one empty R1 beat with stored status `todo`. Writers have client ids 1 and 2; readers have ids 10, 11 and 12. Reader 10 receives Alice then Bob; reader 11 receives Bob then Alice; reader 12 joins from reader 10's encoded state. Readers 10 and 11 encode to identical bytes in both cases.

| Case | Alice | Bob | Reader 10 | Reader 11 | Late reader 12 |
| --- | --- | --- | --- | --- | --- |
| Removal | `remove(R1, rA, Alice)` | `remove(R1, rB, Bob)` | recovery author Alice | recovery author Bob | recovery author Bob |
| Visuals | new visual `vA`, beat R1, text X | new visual `vB`, beat R1, text Y | `X<br>Y` | `Y<br>X` | `Y<br>X` |

Removal: `structure-reader.ts` enumerates the beat's removal map into `activeRemovals`, then takes the first matching removal with `.find()`. With an empty beat there are no observed-character differences to obscure the author difference.

Visuals: start with an empty visuals map. Each writer adds a fresh Y.Map with `beat: R1` and a Y.Text containing its one character. `structure-reader.ts` appends components in the map's enumeration order; there is no rank or sort on this path. The full-document layout has a separate ranked visual reader; this finding concerns the structural reader.

Reproduce: `node --test test/marks/status-index.test.ts` from `prototypes/collab`. The two `other-reader finding` tests assert these exact observations and encoded-state equality. No server or browser is involved.

## What the reader-order fix shows

The original observations above remain executable through the archived structural reader. The repaired reader returns removal attribution `Alice, Bob` on every replica and orders visuals by converged beat position, rank and component identity. `test/reader-order/readers.test.ts` checks the literal values through both layouts, swapped clients, renamed ids, all 24 visual delivery permutations, both undo writers, early/late cancellation and encoded-state late joins. The old algorithms remain controls that the complete-output checker rejects.
