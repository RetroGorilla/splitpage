Owner: library formatting.

Replay: `node --test test/undo-records/generator.test.ts`.

# A redone tag or comment highlight is lost when the writer's undo and redo updates arrive in reverse

Failure: redone/client2.rows[0].characters[0].marks.tag: expected "P", got <missing>

```text
fixture B [{"id":"R1","text":"ab"}], order rev, swapped client ids
enqueue A1 A->B 28 bytes
deliver A1 A->B copy 1
enqueue A2 A->B 48 bytes
enqueue B3 B->A 27 bytes
deliver B3 B->A copy 1
deliver A2 A->B copy 1
check marked
enqueue A4 A->B 6 bytes
Alice undo tag effective=true consumed=1
enqueue A5 A->B 48 bytes
Alice redo tag effective=true
deliver A5 A->B copy 1
enqueue B6 B->A 6 bytes
deliver A4 A->B copy 1
forward 1 update(s) the receivers wrote while integrating
deliver B6 B->A copy 1
check redone
FAIL redone/client2.rows[0].characters[0].marks.tag: expected "P", got <missing>
```
