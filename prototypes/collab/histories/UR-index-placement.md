Restoring at the live index puts each restoration after the whole run of tombstones, so concurrent restorations of b and c land in client-id order: c before b.

Replay: `node --test test/undo-records/cases.test.ts`.

# Restore by index

Failure: restored/client2.rows[0].characters[1].identity.client: expected 2, got 1

```text
fixture B [{"id":"R1","text":"abcd"}], order D1, swapped client ids, defect index-placement
enqueue A1 A->B 29 bytes
enqueue A2 A->B 29 bytes
deliver A1 A->B copy 1
deliver A2 A->B copy 1
fixture R1 "abcd" marks [[1,{"i":true}],[2,{"b":true}]]
enqueue A3 A->B 10 bytes
enqueue B4 B->A 10 bytes
deliver A3 A->B copy 1
deliver B4 B->A copy 1
check deleted
enqueue A5 A->B 75 bytes
Alice undo delete effective=true consumed=1, not yet delivered
enqueue B6 B->A 75 bytes
Bob undo delete effective=true consumed=1, not yet delivered
deliver A5 A->B copy 1
deliver B6 B->A copy 1
restorations named: one per character
check restored
FAIL restored/client2.rows[0].characters[1].identity.client: expected 2, got 1
```
