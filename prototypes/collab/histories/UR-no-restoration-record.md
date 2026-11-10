Without the shared map of restorations, Bob's later undo restores a character Alice already restored.

Replay: `node --test test/undo-records/cases.test.ts`.

# No shared restoration record

Failure: both undone/client1.rows[0].characters[3].identity.client: expected 10, got 2

```text
fixture B [{"id":"R1","text":"abcd"}], order D1, defect no-restoration-record
enqueue A1 A->B 6 bytes
enqueue B2 B->A 6 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
check deleted
enqueue A3 A->B 19 bytes
Alice undo delete effective=true consumed=1
deliver A3 A->B copy 1
after Alice's undo R1 = s1 s2* s3* s4
enqueue B4 B->A 12 bytes
Bob undo delete effective=true consumed=1
Bob's undo effective=true
deliver B4 B->A copy 1
check both undone
FAIL both undone/client1.rows[0].characters[3].identity.client: expected 10, got 2
```
