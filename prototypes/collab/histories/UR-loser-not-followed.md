If a record naming the deleted losing restoration does not resolve to the kept one, Bob's redo finds nothing to delete.

Replay: `node --test test/undo-records/cases.test.ts`.

# Losing restoration not followed

Failure: Bob's redo changed nothing

false !== true


```text
fixture B [{"id":"R1","text":"abcd"}], order D1, defect loser-not-followed
enqueue A1 A->B 29 bytes
deliver A1 A->B copy 1
fixture R1 "abcd" marks [[2,{"b":true}]]
enqueue A2 A->B 10 bytes
enqueue B3 B->A 10 bytes
deliver A2 A->B copy 1
deliver B3 B->A copy 1
check deleted
enqueue B4 B->A 75 bytes
Bob undo delete effective=true consumed=1, not yet delivered
enqueue A5 A->B 75 bytes
Alice undo delete effective=true consumed=1, not yet delivered
deliver B4 B->A copy 1
deliver A5 A->B copy 1
enqueue A6 A->B 10 bytes
client1 deleted losing restorations 2:1
enqueue B7 B->A 10 bytes
client2 deleted losing restorations 2:1
deliver A6 A->B copy 1
deliver B7 B->A copy 1
restorations named: s3* is Alice's
check restored
Bob redo delete effective=false
FAIL Bob's redo changed nothing

false !== true

```
