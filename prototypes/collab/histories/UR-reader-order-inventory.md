# Retained-source inventory does not include the new reader-order undo tests

Historical class-3 finding at 04253f24: an inventory integration failure, separate from reader output and undo behaviour.

Reproduce from the rebased tree:

```text
node --test --test-name-pattern="every retained test file" test/undo-records/fixtures.test.ts
```

The independent scan originally found two paths missing from retainedUndoSources:

```text
test/reader-order/readers.test.ts
test/reader-order/review.test.ts
```

The inventory assertion compares those source lists before running any command history. One missing path was sufficient to fail; either path could be the sole reproducer. The reader-order tests exercise library-backed coalesced removal and status undo; the retained command-record table had no mapping for them. No delivery or undo was required to reproduce the inventory failure.

Resolved by listing both sources and porting their undo histories with unchanged literals into three command-record families: 96 removal runs, six consumed-removal runs and one status/identity run. The total is now 53 families / 360 passing runs. The independent inventory assertion remains unchanged; no source was excluded from its scan.
