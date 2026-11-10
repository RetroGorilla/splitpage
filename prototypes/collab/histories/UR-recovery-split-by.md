Owner: reader.

Replay: `node --test test/undo-records/generator.test.ts`.

# Only the replica that saw the split names its splitter in recovery

Failure: Ra removed: replicas differ: client1: R1[s1]; recovery Rb by Bob edited=[], Ra by Bob edited=[] | client2: R1[s1]; recovery Rb by Bob edited=[], Ra by Bob edited=[] splitBy=Alice

```text
fixture B [{"id":"R1","text":"abcd"}], order D1
enqueue A1 A->B 78 bytes
enqueue B2 B->A 76 bytes
enqueue B3 B->A 210 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
deliver B3 B->A copy 1
enqueue B4 B->A 187 bytes
deliver B4 B->A copy 1
compare replicas Ra removed
FAIL Ra removed: replicas differ: client1: R1[s1]; recovery Rb by Bob edited=[], Ra by Bob edited=[] | client2: R1[s1]; recovery Rb by Bob edited=[], Ra by Bob edited=[] splitBy=Alice
```
