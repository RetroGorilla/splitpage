Owner: reader. Minimized generator history (3 writers); queue lines are omitted.

Replay: `node --test test/undo-records/generator.test.ts`.

# Replicas name a different remover, splitter or edit list for the same recovery entry

Failure: replicas differ: only in recovery attribution: client1: H1[s5 s6] R2[s7 s8 s9] R3[s10 s11]; recovery R1 by Carol edited=[] | client2: H1[s5 s6] R2[s7 s8 s9] R3[s10 s11]; recovery R1 by Bob edited=[] | client3: H1[s5 s6] R2[s7 s8 s9] R3[s10 s11]; recovery R1 by Carol edited=[] | client7: H1[s5 s6] R2[s7 s8 s9] R3[s10 s11]; recovery R1 by Carol edited=[]

```text
deliver A1 A->B copy 1
late-C full state from client 1
generated: 3 writers, each sender's updates arrive in order, fixture [{"id":"R1","text":"# Ab"},{"id":"H1","kind":"heading","text":"In"},{"id":"R2","text":"cde"},{"id":"R3","text":"fg"}]
Carol remove R1 (x1)
Bob remove R1 (x2)
deliver C2 C->A copy 1
deliver C3 C->B copy 1
deliver B4 B->A copy 1
deliver B5 B->C copy 1
drained; fresh replica client 7 from Alice's encoded state
VIOLATION replicas differ: only in recovery attribution: client1: H1[s5 s6] R2[s7 s8 s9] R3[s10 s11]; recovery R1 by Carol edited=[] | client2: H1[s5 s6] R2[s7 s8 s9] R3[s10 s11]; recovery R1 by Bob edited=[] | client3: H1[s5 s6] R2[s7 s8 s9] R3[s10 s11]; recovery R1 by Carol edited=[] | client7: H1[s5 s6] R2[s7 s8 s9] R3[s10 s11]; recovery R1 by Carol edited=[]
```

Fixed by this pull request (#1421): the original failure above is retained; the literal reader regression now passes in test/undo-records/cases.test.ts and generator.test.ts.
