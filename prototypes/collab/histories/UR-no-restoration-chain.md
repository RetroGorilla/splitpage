Without following restored identities, undoing the bold after undoing the delete changes nothing.

Replay: `node --test test/undo-records/cases.test.ts`.

# Older records do not follow restorations

Failure: format undone changed nothing

false !== true


```text
fixture B [{"id":"R1","text":"ab"}], order D2, defect no-restoration-record
enqueue B1 B->A 10 bytes
deliver B1 B->A copy 1
enqueue A2 A->B 10 bytes
enqueue A3 A->B 27 bytes
enqueue A4 A->B 6 bytes
deliver A2 A->B copy 1
deliver A3 A->B copy 1
deliver A4 A->B copy 1
check commands
enqueue A5 A->B 36 bytes
Alice undo delete effective=true consumed=1
deliver A5 A->B copy 1
check delete undone
Alice undo format effective=false consumed=1
FAIL format undone changed nothing

false !== true

```
