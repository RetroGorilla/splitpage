Deleting from the first to the last inserted identity also removes Bob's character typed inside it.

Replay: `node --test test/undo-records/cases.test.ts`.

# Undo deletes the whole inserted span

Failure: undone/client1.rows[0].characters[2]: expected {"identity":{"client":2,"clock":0},"notation":"b1","value":"Q","marks":{},"beat":"R1"}, got <missing>

```text
fixture B [{"id":"R1","text":"ab"}], order D2, defect span-delete
enqueue A1 A->B 12 bytes
deliver A1 A->B copy 1
enqueue B2 B->A 12 bytes
deliver B2 B->A copy 1
check typed
enqueue A3 A->B 10 bytes
Alice undo insert effective=true consumed=1
deliver A3 A->B copy 1
check undone
FAIL undone/client1.rows[0].characters[2]: expected {"identity":{"client":2,"clock":0},"notation":"b1","value":"Q","marks":{},"beat":"R1"}, got <missing>
```
