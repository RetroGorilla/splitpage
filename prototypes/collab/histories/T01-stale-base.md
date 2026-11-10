Offset deletion uses the updated replica as its base (artifact 8 §5, Stale base).

1. Seed R1 `abcd = s1 s2 s3 s4`; paint; Alice selects original bc.
2. Bob inserts `X = b1` after s2; deliver to Alice (D3, M2).
3. Wrong commit deletes current offsets 1 and 2, which now name s2 and b1.
4. Deliver Alice's update to Bob.

Oracle: `aXd = s1 b1 s4`, caret `a|Xd`, recovery empty.
Observed: `acd = s1 s3 s4` on both replicas, first difference at character 1's raw identity.
Replay: the Stale base tests in `test/harness.test.ts` (A and B).
