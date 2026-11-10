Owner: undo.

Replay: `node --test test/undo-records/generator.test.ts`.

# Settling deletes a comment anchor on the losing copy, sending the comment to recovery

Failure: settled/client1.rows[0].characters[1].marks.c:C1: expected true, got <missing>

```text
fixture B [{"id":"R1","text":"abc"}], order D1
late-C full state from client 1
enqueue A1 A->B 6 bytes
enqueue A2 A->C 6 bytes
enqueue B3 B->A 6 bytes
enqueue B4 B->C 6 bytes
deliver A1 A->B copy 1
deliver A2 A->C copy 1
deliver B3 B->A copy 1
deliver B4 B->C copy 1
enqueue A5 A->B 51 bytes
enqueue A6 A->C 51 bytes
Alice undo delete effective=true consumed=1
enqueue B7 B->A 51 bytes
enqueue B8 B->C 51 bytes
Bob undo delete effective=true consumed=1
deliver B8 B->C copy 1
enqueue C9 C->A 135 bytes
enqueue C10 C->B 135 bytes
Carol comments on the b she sees: s2**
deliver A5 A->B copy 1
deliver A6 A->C copy 1
deliver B7 B->A copy 1
deliver C9 C->A copy 1
deliver C10 C->B copy 1
enqueue A11 A->B 10 bytes
enqueue A12 A->C 10 bytes
client1 deleted losing restorations 2:0
enqueue B13 B->A 10 bytes
enqueue B14 B->C 10 bytes
client2 deleted losing restorations 2:0
enqueue C15 C->A 10 bytes
enqueue C16 C->B 10 bytes
client3 deleted losing restorations 2:0
deliver A11 A->B copy 1
deliver A12 A->C copy 1
deliver B13 B->A copy 1
deliver B14 B->C copy 1
deliver C15 C->A copy 1
deliver C16 C->B copy 1
check settled
FAIL settled/client1.rows[0].characters[1].marks.c:C1: expected true, got <missing>
```
