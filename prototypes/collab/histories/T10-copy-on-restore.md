Restoring a soft removal by copying observed text duplicates it (artifact 8 §5, Duplicated identity).

1. Seed R1 ab (s1 s2), R2 cd (s3 s4), R3 ef (s5 s6).
2. Alice soft-removes R2 with rA; Bob concurrently inserts b1 X after s3.
3. Exchange (D1); Carol joins from Bob's full state only. All three pass the removed-content oracle.
4. Wrong restore inserts x1 c, x2 d at R2 offset 0, then removes rA.
5. Exchange to Bob and Carol.

Oracle: R2 `cXd = s3 b1 s4`, A caret at R2 start, recovery empty.
Observed: R2 `cdcXd = x1 x2 s3 b1 s4` on A, B and late-C.
Replay: the Duplicated identity tests in `test/harness.test.ts` (A and B).
