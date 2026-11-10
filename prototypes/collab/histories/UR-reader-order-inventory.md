# Retained-source inventory does not include the new reader-order undo tests

Class 3, retained unchanged: this is an inventory integration failure, not a changed reader result or an undo behaviour failure.

Reproduce from the rebased tree:

```text
node --test --test-name-pattern="every retained test file" test/undo-records/fixtures.test.ts
```

The independent scan finds two paths missing from retainedUndoSources:

```text
test/reader-order/readers.test.ts
test/reader-order/review.test.ts
```

The inventory assertion compares those source lists before running any command history. One missing path is sufficient to fail; either path can be the sole reproducer. The reader-order tests exercise library-backed coalesced removal and join undo; the retained command-record table has no mapping for them. No Yjs delivery or undo is required to reproduce this failure.

Per the reconciliation instruction for class 3, neither the assertion nor the table was adjusted. The 50 existing retained families still pass their 257 runs. Adding coverage for these two sources is separate work; merely deleting the scan results or excluding the files would weaken the test.
