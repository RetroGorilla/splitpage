Alice bolds ab; Bob unbolds then bolds bc; Alice's undo removes Bob's bold from b. Expected (decided row: a person undoes only their own changes): b keeps Bob's bold.

Replay: `node --test test/undo-records/cases.test.ts`.

# Format undo over the other writer's later formatting

Failure: Alice undone/client1.rows[0].characters[1].marks.b: expected true, got <missing>

```text
fixture B [{"id":"R1","text":"abcd"}], order D1
enqueue A1 A->B 27 bytes
deliver A1 A->B copy 1
enqueue B2 B->A 21 bytes
enqueue B3 B->A 21 bytes
deliver B2 B->A copy 1
deliver B3 B->A copy 1
check Bob bolded
enqueue A4 A->B 21 bytes
Alice undo format effective=true consumed=1
deliver A4 A->B copy 1
check Alice undone
FAIL Alice undone/client1.rows[0].characters[1].marks.b: expected true, got <missing>
```
