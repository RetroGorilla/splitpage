One tag attribute loses the outer/inner stack on the same characters.

Replay: `node src/marks/report.ts` or `node --test test/marks/marks.test.ts`.

T20 nest/client1.rows[0].characters[8].marks.tag: expected "P", got "S"

```text
fixture [{"id":"R1","text":"the red mug"}], defect single-tag
enqueue A1 A->B 52 bytes
deliver A1 A->B copy 1
enqueue A2 A->B 30 bytes
enqueue B3 B->A 30 bytes
deliver A2 A->B copy 1
deliver B3 B->A copy 1
check T20 nest
FAIL T20 nest/client1.rows[0].characters[8].marks.tag: expected "P", got "S"
```
