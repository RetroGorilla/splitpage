A projection that omits an optional scalar loses loaded data (artifact 8 §5, Omitted field).

1. Load R1 ab (s1 s2), lengthSeconds 12.
2. Read both replicas; the correct reader passes the literal oracle.
3. Wrong projection drops lengthSeconds, then JSON serializes and parses the result.

Oracle: rows[0].lengthSeconds = 12, carets and recovery empty.
Observed: rows[0].lengthSeconds missing, on both replicas.
Replay: the Omitted field tests in `test/harness.test.ts` (A and B).
