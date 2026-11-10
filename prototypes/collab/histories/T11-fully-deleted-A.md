A fails T11 fully deleted: the surviving d acquires C1 after update delivery instead of leaving the fully deleted anchor in recovery. Expected data was not changed.

Replay: `node src/marks/report.ts` or `npm test`.

## late-C

T11 fully deleted.rows[0].characters[1].marks.c:C1: expected <missing>, got true

```text
seed R1 abcd=s1..s4; no undo managers; A comments C1 on original s2 s3
enqueue A1 A->B 135 bytes
deliver A1 A->B copy 1
B replies r1 to C1, then deletes original s2 s3 in one transaction
enqueue B2 B->A 84 bytes
enqueue B3 B->A 10 bytes
deliver B2 B->A copy 1
deliver B3 B->A copy 1
late-C full state from client 2
client1 {"rows":[{"id":"R1","characters":[{"identity":{"client":10,"clock":1},"notation":"s1","value":"a","marks":{},"beat":"R1"},{"identity":{"client":10,"clock":4},"notation":"s4","value":"d","marks":{"c:C1":true},"beat":"R1"}]}],"carets":{},"recovery":[],"records":{"comments":{"C1":{"author":"Alice","createdAt":0,"text":"","rowId":"R1","field":"audioText","recovery":false,"replies":[{"id":"r1","commentId":"C1","author":"Bob","createdAt":0,"text":""}]}},"recoveryReplies":[]}}
client2 {"rows":[{"id":"R1","characters":[{"identity":{"client":10,"clock":1},"notation":"s1","value":"a","marks":{},"beat":"R1"},{"identity":{"client":10,"clock":4},"notation":"s4","value":"d","marks":{"c:C1":true},"beat":"R1"}]}],"carets":{},"recovery":[],"records":{"comments":{"C1":{"author":"Alice","createdAt":0,"text":"","rowId":"R1","field":"audioText","recovery":false,"replies":[{"id":"r1","commentId":"C1","author":"Bob","createdAt":0,"text":""}]}},"recoveryReplies":[]}}
client3 {"rows":[{"id":"R1","characters":[{"identity":{"client":10,"clock":1},"notation":"s1","value":"a","marks":{},"beat":"R1"},{"identity":{"client":10,"clock":4},"notation":"s4","value":"d","marks":{"c:C1":true},"beat":"R1"}]}],"carets":{},"recovery":[],"records":{"comments":{"C1":{"author":"Alice","createdAt":0,"text":"","rowId":"R1","field":"audioText","recovery":false,"replies":[{"id":"r1","commentId":"C1","author":"Bob","createdAt":0,"text":""}]}},"recoveryReplies":[]}}
FAIL T11 fully deleted.rows[0].characters[1].marks.c:C1: expected <missing>, got true
```
