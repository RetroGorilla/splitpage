One LWW status key chooses shot instead of retaining the earlier todo status.

Replay: `node src/marks/report.ts` or `node --test test/marks/marks.test.ts`.

T21 scalar/client1.rows[0].status: expected "todo", got "shot"

```text
fixture [{"id":"R1","text":"ab"}], defect lww-status
enqueue A1 A->B 23 bytes
deliver A1 A->B copy 1
enqueue A2 A->B 10 bytes
enqueue A3 A->B 20 bytes
enqueue B4 B->A 19 bytes
deliver A2 A->B copy 1
deliver A3 A->B copy 1
deliver B4 B->A copy 1
check T21 scalar
FAIL T21 scalar/client1.rows[0].status: expected "todo", got "shot"
```
