A record holding beat and offset deletes the wrong characters once the other writer inserts before them.

Replay: `node --test test/undo-records/cases.test.ts`.

# Record stores positions

Failure: undone/client1.rows[0].characters[2].identity.client: expected 10, got 1

```text
fixture B [{"id":"R1","text":"ab"}], order D1, defect positions
enqueue A1 A->B 11 bytes
enqueue B2 B->A 10 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
enqueue A3 A->B 10 bytes
Alice undo insert effective=true consumed=1
deliver A3 A->B copy 1
check undone
FAIL undone/client1.rows[0].characters[2].identity.client: expected 10, got 1
```
