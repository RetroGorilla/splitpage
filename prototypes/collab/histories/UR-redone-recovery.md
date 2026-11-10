Owner: reader.

Replay: `node --test test/undo-records/generator.test.ts`.

# Recovery lists a character undone and redone inside a removed beat as edited after the removal

Failure: recovery after undo and redo/client1.recovery[0].edited[0]: expected <missing>, got "a1*"

```text
fixture B [{"id":"R1","text":"ab"},{"id":"R2","text":"cd"}], order D1
enqueue A1 A->B 12 bytes
deliver A1 A->B copy 1
enqueue B2 B->A 210 bytes
deliver B2 B->A copy 1
enqueue A3 A->B 6 bytes
Alice undo insert effective=true consumed=1
enqueue A4 A->B 57 bytes
Alice redo insert effective=true
deliver A3 A->B copy 1
deliver A4 A->B copy 1
check recovery after undo and redo
FAIL recovery after undo and redo/client1.recovery[0].edited[0]: expected <missing>, got "a1*"
```
