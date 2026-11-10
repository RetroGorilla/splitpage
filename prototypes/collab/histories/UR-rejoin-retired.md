Retiring every matching join without checking the writer's own entry lets Bob's stale undo split Alice's later rejoin.

Replay: `node --test test/undo-records/cases.test.ts`.

# Join undo without its own-entry check

Failure: Bob's consumed identical undo reached an older step or wrote state (effective=true, consumed=1, updates=1)

```text
fixture B [{"id":"R1","text":"ab"},{"id":"R2","text":"cd"}], order D1, defect retire-without-own-entry
enqueue A1 A->B 32 bytes
enqueue B2 B->A 32 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
check both joined
enqueue A3 A->B 45 bytes
Alice undo join effective=true consumed=1
deliver A3 A->B copy 1
check both retired
enqueue A4 A->B 33 bytes
deliver A4 A->B copy 1
check Alice rejoined
enqueue B5 B->A 26 bytes
Bob undo join effective=true consumed=1
FAIL Bob's consumed identical undo reached an older step or wrote state (effective=true, consumed=1, updates=1)
```
