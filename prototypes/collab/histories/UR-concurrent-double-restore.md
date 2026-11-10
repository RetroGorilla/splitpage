With one last-writer-wins restoration entry per original and no losing restoration deleted, both concurrent undos keep their copy of c.

Replay: `node --test test/undo-records/cases.test.ts`.

# #1418's restorations

Failure: restored/client1.rows[0].characters[3].identity.client: expected 10, got 2

```text
fixture B [{"id":"R1","text":"abcd"}], order D1, defect restore-twice
enqueue A1 A->B 29 bytes
deliver A1 A->B copy 1
fixture R1 "abcd" marks [[2,{"b":true}]]
enqueue A2 A->B 10 bytes
enqueue B3 B->A 10 bytes
deliver A2 A->B copy 1
deliver B3 B->A copy 1
check deleted
enqueue A4 A->B 82 bytes
Alice undo delete effective=true consumed=1, not yet delivered
enqueue B5 B->A 82 bytes
Bob undo delete effective=true consumed=1, not yet delivered
deliver A4 A->B copy 1
deliver B5 B->A copy 1
restorations named: s3* is Alice's
check restored
FAIL restored/client1.rows[0].characters[3].identity.client: expected 10, got 2
```
