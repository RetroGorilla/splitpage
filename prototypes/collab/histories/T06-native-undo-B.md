Plain per-writer join undo leaves the other writer's join live, so the required unjoin fails.

Replay: `node --test test/structure.test.ts` (plain per-writer join undo).

## Normal client ids

T06 Alice undo/client1.rows[0].characters[2]: expected <missing>, got {"identity":null,"notation":"[glue]","value":" ","marks":{},"beat":"R1"}

```text
fixture [{"id":"R1","text":"ab"},{"id":"R2","text":"cd"}]
enqueue A1 A->B 464 bytes
deliver A1 A->B copy 1
enqueue A2 A->B 25 bytes
deliver A2 A->B copy 1
enqueue A3 A->B 32 bytes
enqueue B4 B->A 32 bytes
deliver A3 A->B copy 1
deliver B4 B->A copy 1
check T06
enqueue A5 A->B 6 bytes
deliver A5 A->B copy 1
check T06 Alice undo
FAIL T06 Alice undo/client1.rows[0].characters[2]: expected <missing>, got {"identity":null,"notation":"[glue]","value":" ","marks":{},"beat":"R1"}
```

## Swapped client ids

T06 Alice undo/client2.rows[0].characters[2]: expected <missing>, got {"identity":null,"notation":"[glue]","value":" ","marks":{},"beat":"R1"}

```text
fixture [{"id":"R1","text":"ab"},{"id":"R2","text":"cd"}]
enqueue A1 A->B 464 bytes
deliver A1 A->B copy 1
enqueue A2 A->B 25 bytes
deliver A2 A->B copy 1
enqueue A3 A->B 32 bytes
enqueue B4 B->A 32 bytes
deliver A3 A->B copy 1
deliver B4 B->A copy 1
check T06
enqueue A5 A->B 6 bytes
deliver A5 A->B copy 1
check T06 Alice undo
FAIL T06 Alice undo/client2.rows[0].characters[2]: expected <missing>, got {"identity":null,"notation":"[glue]","value":" ","marks":{},"beat":"R1"}
```
