A single comment attribute overwrites an overlapping independent comment (artifact 8 §5, Lost mark).

1. Seed R1 abcd (s1 through s4).
2. Alice sets cmt=C1 on s2 s3; Bob concurrently sets cmt=C2 on s3 s4.
3. Exchange (D1); interpret each surviving single cmt as its comment identity.

Oracle: s2 has C1, s3 has C1 and C2, s4 has C2; no carets; recovery empty.
Observed: s3 has only C2, on both replicas.
The separate-key positive control uses c:C1 and c:C2 and passes the same literal oracle.
Replay: the Lost mark tests in `test/harness.test.ts` (A and B).
