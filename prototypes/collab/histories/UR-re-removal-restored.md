Cancelling a removal without checking the writer's own entry lets Bob's stale undo restore Alice's later re-removal.

Replay: `node --test test/undo-records/cases.test.ts`.

# Removal undo without its own-entry check

Failure: Bob's consumed identical undo reached an older step or wrote state (effective=true, consumed=1, updates=1)

```text
fixture B [{"id":"R1","text":"ab"},{"id":"R2","text":"cd"},{"id":"R3","text":"ef"}], order D1, defect retire-without-own-entry
enqueue A1 A->B 187 bytes
enqueue B2 B->A 185 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
check both removed
enqueue A3 A->B 14 bytes
Alice undo remove effective=true consumed=1
deliver A3 A->B copy 1
check both undone
enqueue A4 A->B 197 bytes
deliver A4 A->B copy 1
check Alice removed again
enqueue B5 B->A 14 bytes
Bob undo remove effective=true consumed=1
FAIL Bob's consumed identical undo reached an older step or wrote state (effective=true, consumed=1, updates=1)
```
