Copying narration before linking a join duplicates source characters (artifact 8 §5, Duplicated identity (join)).

1. Seed R1 ab (s1 s2), R2 cd (s3 s4); bold ab and synchronize (D2).
2. Wrong Alice join copies cd as x1 x2 after s2, then writes jA.
3. Bob concurrently writes jB; exchange (D1).

Oracle: R1 `ab cd = s1 s2 [glue] s3 s4`, ab bold, both carets at offset 3, recovery empty.
Observed: `abcd cd = s1 s2 x1 x2 [glue] s3 s4` on both replicas.
This is the narration-only defect probe, not a passing claim for the full visual/gallery T06 fixture.
Replay: the Duplicated identity (join) tests in `test/harness.test.ts` (A and B).
