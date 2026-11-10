Owner: delivery. Minimized generator history (3 writers, acting on a replica that holds an out-of-order update); queue lines are omitted.

Replay: `node --test test/undo-records/generator.test.ts`.

# A replica holding one writer's later update before the earlier one cannot be read until the earlier one arrives

Failure: threw: Bob move: Cannot read properties of undefined (reading 'b')

```text
deliver A1 A->B copy 1
late-C full state from client 1
generated: 3 writers, one sender's updates may arrive out of order, fixture [{"id":"R1","text":"# Ab"},{"id":"H1","kind":"heading","text":"In"},{"id":"R2","text":"cde"},{"id":"R3","text":"fg"}]
Alice heading R1 becomes G1
Alice remove heading H1 as U2 before R2
Carol heading R1 becomes G3
deliver A4 A->B copy 1
VIOLATION threw: Bob move: Cannot read properties of undefined (reading 'b')
deliver A2 A->B copy 1
deliver A3 A->C copy 1
deliver A5 A->C copy 1
deliver C6 C->A copy 1
deliver C7 C->B copy 1
drained; fresh replica client 7 from Alice's encoded state
```
