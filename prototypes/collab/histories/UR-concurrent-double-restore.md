Alice and Bob both deleted c and undo without seeing each other's undo: c comes back twice.

Replay: `node --test test/undo-records/cases.test.ts`.

# Concurrent undos of a doubly deleted character

Failure: both undone/client1.rows[0].characters[3].identity.client: expected 10, got 2

```text
fixture B [{"id":"R1","text":"abcd"}], order D1
enqueue A1 A->B 6 bytes
enqueue B2 B->A 6 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
check deleted
enqueue A3 A->B 111 bytes
Alice undo delete effective=true consumed=1
after Alice's undo R1 = not delivered
enqueue B4 B->A 58 bytes
Bob undo delete effective=true consumed=1
Bob's undo effective=true
deliver A3 A->B copy 1
deliver B4 B->A copy 1
check both undone
FAIL both undone/client1.rows[0].characters[3].identity.client: expected 10, got 2
```
