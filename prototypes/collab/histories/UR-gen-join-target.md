Owner: reader. Minimized generator history (2 writers); queue lines are omitted.

Replay: `node --test test/undo-records/generator.test.ts`.

# Removing or moving the target of a join leaves the joined beat unreadable (Structural join target unavailable)

Failure: threw: reader on client 1: Structural join target unavailable

```text
deliver A1 A->B copy 1
generated: 2 writers, one sender's updates may arrive out of order, fixture [{"id":"R1","text":"# Ab"},{"id":"H1","kind":"heading","text":"In"},{"id":"R2","text":"cde"},{"id":"R3","text":"fg"}]
Bob move R1 before R3: moved
Bob join R1 into R2 (j1)
Bob remove R2 (x2)
deliver B2 B->A copy 1
deliver B3 B->A copy 1
deliver B4 B->A copy 1
drained; fresh replica client 7 from Alice's encoded state
VIOLATION threw: reader on client 1: Structural join target unavailable
VIOLATION threw: reader on client 2: Structural join target unavailable
VIOLATION threw: reader on client 7: Structural join target unavailable
```
