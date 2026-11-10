Whole-beat synchronization deletes Bob's unpainted insertion (artifact 8 §5, Lost remote character).

1. Seed R1 `abcd = s1 s2 s3 s4`; Alice paints it.
2. Alice's native buffer deletes original `bc`, becoming `ad`.
3. Bob inserts `X = b1` after s2; deliver to Alice (D3, M2).
4. Wrong commit reconciles current `abXcd` to `ad`, deleting s2, b1, s3.
5. Deliver Alice's update to Bob.

Oracle: `aXd = s1 b1 s4`, caret `a|Xd`, recovery empty.
Observed: `ad = s1 s4` on both replicas, first difference at character 1's raw identity.
Replay: the Lost remote character tests in `test/harness.test.ts` (A and B).
