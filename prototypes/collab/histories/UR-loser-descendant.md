Owner: undo.

Replay: `node --test test/undo-records/generator.test.ts`.

# Settling keeps a restoration of a losing restoration, so the character shows twice

Failure: settled/client1.rows[0].characters[2].identity.client: expected 10, got 2

```text
fixture B [{"id":"R1","text":"abc"}], order D1
enqueue A1 A->B 6 bytes
enqueue B2 B->A 6 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
enqueue A3 A->B 51 bytes
Alice undo delete effective=true consumed=1
enqueue B4 B->A 51 bytes
Bob undo delete effective=true consumed=1
enqueue B5 B->A 6 bytes
enqueue B6 B->A 51 bytes
Bob undo delete effective=true consumed=1
deliver A3 A->B copy 1
deliver B4 B->A copy 1
deliver B5 B->A copy 1
deliver B6 B->A copy 1
check settled
FAIL settled/client1.rows[0].characters[2].identity.client: expected 10, got 2
```
