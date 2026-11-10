With one occurrence key per writer, identical simultaneous tags show as a tag nested in itself.

Replay: `node --test test/undo-records/cases.test.ts`.

# Per-writer tag occurrence keys

Failure: tagged/client1.rows[0].characters[4].marks.innerTags: expected <missing>, got ["P"]

```text
fixture B [{"id":"R1","text":"the red mug"},{"id":"R2","text":"ok"}], order D1
enqueue A1 A->B 28 bytes
enqueue A2 A->B 10 bytes
enqueue B3 B->A 10 bytes
deliver A1 A->B copy 1
deliver A2 A->B copy 1
deliver B3 B->A copy 1
enqueue A4 A->B 32 bytes
enqueue B5 B->A 32 bytes
tag occurrence keys t:oA, t:oB
deliver A4 A->B copy 1
deliver B5 B->A copy 1
check tagged
FAIL tagged/client1.rows[0].characters[4].marks.innerTags: expected <missing>, got ["P"]
```
