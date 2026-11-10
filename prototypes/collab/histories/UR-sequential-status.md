Under main's status rule only frontier events retire, so a writer's second status undo changes nothing.

Replay: `node --test test/undo-records/cases.test.ts`.

# Second status undo by one writer

Failure: second undo/client1.rows[0].status: expected "todo", got "ready"

```text
fixture B [{"id":"R1","text":"ab"}], order D2
enqueue A1 A->B 23 bytes
deliver A1 A->B copy 1
enqueue A2 A->B 83 bytes
enqueue A3 A->B 88 bytes
deliver A2 A->B copy 1
deliver A3 A->B copy 1
check shot
enqueue A4 A->B 27 bytes
Alice undo status effective=true consumed=1
deliver A4 A->B copy 1
check first undo
Alice undo status effective=false consumed=1
second undo effective=false
check second undo
FAIL second undo/client1.rows[0].status: expected "todo", got "ready"
```
