A formatted root was hydrated before its Y.Text constructor was declared; later promotion resets _hasFormatting, leaving C1 on surviving d. This is a root-initialization defect, not undo retention or a layout property.

The literal expected result is unchanged. Replay: `node src/marks/report.ts` or `node --test test/marks/root-initialization.test.ts`.

## late-C

T11 fully deleted.rows[0].characters[1].marks.c:C1: expected <missing>, got true

```text
seed R1 abcd=s1..s4; root control gc-off
A comments C1 on original s2 s3
enqueue A1 A->B 135 bytes
deliver A1 A->B copy 1
enqueue B2 B->A 84 bytes
deliver B2 B->A copy 1
client2 deletes original s2 s3 in one transaction
before promotion: AbstractType, _hasFormatting=true
enqueue B3 B->A 10 bytes
after promotion/deletion: YText, _hasFormatting=false
deliver B3 B->A copy 1
late-C full state from client 2
client1 {"rows":[{"id":"R1","characters":[{"identity":{"client":10,"clock":1},"notation":"s1","value":"a","marks":{},"beat":"R1"},{"identity":{"client":10,"clock":4},"notation":"s4","value":"d","marks":{"c:C1":true},"beat":"R1"}]}],"carets":{},"recovery":[],"records":{"comments":{"C1":{"author":"Alice","createdAt":0,"text":"","rowId":"R1","field":"audioText","recovery":false,"replies":[{"id":"r1","commentId":"C1","author":"Bob","createdAt":0,"text":""}]}},"recoveryReplies":[]}}
client2 {"rows":[{"id":"R1","characters":[{"identity":{"client":10,"clock":1},"notation":"s1","value":"a","marks":{},"beat":"R1"},{"identity":{"client":10,"clock":4},"notation":"s4","value":"d","marks":{"c:C1":true},"beat":"R1"}]}],"carets":{},"recovery":[],"records":{"comments":{"C1":{"author":"Alice","createdAt":0,"text":"","rowId":"R1","field":"audioText","recovery":false,"replies":[{"id":"r1","commentId":"C1","author":"Bob","createdAt":0,"text":""}]}},"recoveryReplies":[]}}
client3 {"rows":[{"id":"R1","characters":[{"identity":{"client":10,"clock":1},"notation":"s1","value":"a","marks":{},"beat":"R1"},{"identity":{"client":10,"clock":4},"notation":"s4","value":"d","marks":{"c:C1":true},"beat":"R1"}]}],"carets":{},"recovery":[],"records":{"comments":{"C1":{"author":"Alice","createdAt":0,"text":"","rowId":"R1","field":"audioText","recovery":false,"replies":[{"id":"r1","commentId":"C1","author":"Bob","createdAt":0,"text":""}]}},"recoveryReplies":[]}}
FAIL T11 fully deleted.rows[0].characters[1].marks.c:C1: expected <missing>, got true
```
