Owner: reader.

Replay: `node --test test/undo-records/generator.test.ts`.

# Removing or moving the target of a join leaves the joined beat unreadable (Structural join target unavailable)

Failure: Structural join target unavailable

```text
fixture B [{"id":"R1","text":"ab"},{"id":"R2","text":"cd"}], order D1
enqueue A1 A->B 32 bytes
deliver A1 A->B copy 1
enqueue B2 B->A 185 bytes
deliver B2 B->A copy 1
compare replicas join target removed
FAIL Structural join target unavailable
```

Fixed by this pull request (#1421): the original failure above is retained; the literal reader regression now passes in test/undo-records/cases.test.ts and generator.test.ts.
