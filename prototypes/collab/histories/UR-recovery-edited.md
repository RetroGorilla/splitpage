Owner: reader.

Replay: `node --test test/undo-records/generator.test.ts`.

# Replicas name a different remover, splitter or edit list for the same recovery entry

Failure: both removed: replicas differ: client1: R2[s2]; recovery R1 by Alice edited=[] | client2: R2[s2]; recovery R1 by Bob edited=["a1"]

```text
fixture B [{"id":"R1","text":"a"},{"id":"R2","text":"z"}], order D1
enqueue A1 A->B 10 bytes
enqueue A2 A->B 187 bytes
enqueue B3 B->A 160 bytes
deliver A1 A->B copy 1
deliver A2 A->B copy 1
deliver B3 B->A copy 1
compare replicas both removed
FAIL both removed: replicas differ: client1: R2[s2]; recovery R1 by Alice edited=[] | client2: R2[s2]; recovery R1 by Bob edited=["a1"]
```
