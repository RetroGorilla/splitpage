Owner: status rule. Minimized generator history (3 writers); queue lines are omitted.

Replay: `node --test test/undo-records/generator.test.ts`.

# Redo of a status change that had not applied (a conflict) makes it apply

Failure: undo then redo changed the model: Bob status: before R1[s1 s2 s3 s4] H1[s5 s6] R2(undefined)[s7 s8 s9] R3[s10 s11]; recovery none; notices Bob: concurrent status change did not apply, Carol: concurrent status change did not apply || after R1[s1 s2 s3 s4] H1[s5 s6] R2(ready)[s7 s8 s9] R3[s10 s11]; recovery none; notices Bob: concurrent status change did not apply, Carol: concurrent status change did not apply

```text
deliver A1 A->B copy 1
late-C full state from client 1
generated: 3 writers, each sender's updates arrive in order, fixture [{"id":"R1","text":"# Ab"},{"id":"H1","kind":"heading","text":"In"},{"id":"R2","text":"cde"},{"id":"R3","text":"fg"}]
Bob status R2 shot (e1)
Alice bold R2:2-3
Alice replace R3:0-R3:1 with ""
Carol status R2 todo (e3)
Bob status R2 ready (e4)
deliver C8 C->A copy 1
deliver C9 C->B copy 1
Bob undo status effective=true consumed=1
Bob redo status effective=true
VIOLATION undo then redo changed the model: Bob status: before R1[s1 s2 s3 s4] H1[s5 s6] R2(undefined)[s7 s8 s9] R3[s10 s11]; recovery none; notices Bob: concurrent status change did not apply, Carol: concurrent status change did not apply || after R1[s1 s2 s3 s4] H1[s5 s6] R2(ready)[s7 s8 s9] R3[s10 s11]; recovery none; notices Bob: concurrent status change did not apply, Carol: concurrent status change did not apply
deliver B2 B->A copy 1
deliver B3 B->C copy 1
deliver A4 A->B copy 1
deliver A5 A->C copy 1
deliver A6 A->B copy 1
deliver A7 A->C copy 1
deliver B10 B->A copy 1
deliver B11 B->C copy 1
deliver B12 B->A copy 1
deliver B13 B->C copy 1
deliver B14 B->A copy 1
deliver B15 B->C copy 1
drained; fresh replica client 7 from Alice's encoded state
```
