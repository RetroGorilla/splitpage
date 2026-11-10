When an ineffective identical undo pops the next entry, Bob's consumed undo removes his older insertion.

Replay: `node --test test/undo-records/cases.test.ts`.

# Ineffective undo falls through

Failure: Bob's consumed identical undo reached an older step or wrote state (effective=true, consumed=2, updates=1)

```text
fixture B [{"id":"R1","text":"ab"},{"id":"R2","text":"cd"},{"id":"R3","text":"ef"}], order D1, defect fall-through
enqueue A1 A->B 10 bytes
enqueue B2 B->A 10 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
enqueue A3 A->B 187 bytes
enqueue B4 B->A 185 bytes
deliver A3 A->B copy 1
deliver B4 B->A copy 1
check removed
recovery names client1: Alice, Bob, client2: Alice, Bob
enqueue A5 A->B 14 bytes
Alice undo remove effective=true consumed=1
deliver A5 A->B copy 1
check restored
enqueue B6 B->A 6 bytes
Bob undo insert effective=true consumed=2
FAIL Bob's consumed identical undo reached an older step or wrote state (effective=true, consumed=2, updates=1)
```
