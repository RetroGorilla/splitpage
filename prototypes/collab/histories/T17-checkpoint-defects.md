# T17 deliberate checkpoint defects

Shows that acknowledged identities must survive recovery even when checkpoint metadata or pruning lies.

1. Initial journal sequence 1 contains `R1 "abcd"`, identities `a:7:0 b:7:1 c:7:2 d:7:3`.
2. A durable checkpoint covers sequence 1.
3. Sequence 2 inserts `X:11:0`; the harness records that exact submitted update.
4. Defective checkpoint stores the old payload but claims sequence 2, with a matching integrity checksum.
5. Independent SQLite recovery skips the row it falsely claims to cover and fails: `Acknowledged insertion missing`.
6. Restore checkpoint 1. Defective pruning removes sequence 2 beyond its coverage.
7. The same independent coverage oracle fails: `Acknowledged insertion missing`.

Executable control: the first subtest in `test/service/instance/instance.test.ts`. An additional normal-path test submits old bytes with a later sequence through the worker gateway and requires rejection before any checkpoint is installed. Integrity checks alone cannot prove semantic coverage.
