Plain undo skips a remotely overwritten status step and removes the older Z insertion; top-item undo leaves Z intact.

Replay: `node --test test/structure.test.ts` (top-item-only undo). This library probe uses the literal LWW value shot, not the product's required status policy.

Plain undo: U-H1 top item.rows[0].characters[2]: expected {"identity":{"client":1,"clock":1},"notation":"a1","value":"Z","marks":{},"beat":"R1"}, got <missing>
Top-item undo: PASS

```text
enqueue A1 A->B 23 bytes
deliver A1 A->B copy 1
enqueue A2 A->B 10 bytes
enqueue A3 A->B 20 bytes
enqueue B4 B->A 19 bytes
deliver A2 A->B copy 1
deliver A3 A->B copy 1
deliver B4 B->A copy 1
undo overwritten status with plain undo
enqueue A5 A->B 6 bytes
deliver A5 A->B copy 1
FAIL U-H1 top item.rows[0].characters[2]: expected {"identity":{"client":1,"clock":1},"notation":"a1","value":"Z","marks":{},"beat":"R1"}, got <missing>
```
