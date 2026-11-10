Owner: undo.

Replay: `node --test test/undo-records/generator.test.ts`.

# A format undo overwrites the other writer's later formatting of the same characters

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
