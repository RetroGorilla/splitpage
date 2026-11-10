# Command-record undo before an identical concurrent removal arrives

Finding while porting the early=true branch of test/reader-order/readers.test.ts to retained command records. Expected results are unchanged. This is not added to declaredLimits.

Base: #1421 head 04253f24b01d1caa5052d9c00f0b406ff15f357e. Regression: test/undo-records/early-removal.test.ts.

Minimized history, layout B, one empty beat R1:

1. Alice removes R1 as entry a, using removeBeat on her CommandHistory.
2. Bob concurrently removes R1 as entry b. Neither writer receives the other's update.
3. Alice undoes her removal before receiving b; effective=true.
4. Deliver the queued updates in reverse, then load a third replica from Alice's encoded state.

Literal expected from the original reader-order case:

```json
{"rows":["R1"],"recovery":[]}
```

Observed before the fix on Alice, Bob and the encoded late joiner:

```json
{"rows":[],"recovery":[{"id":"R1","by":"Bob","edited":[]}]}
```

Replay:

```text
node --test test/undo-records/early-removal.test.ts test/reader-order/removal-controls.test.ts
```

Before the fix: 1 failure, 3 passing controls. The same history passed with the original removeWithUndo/undoRemoval command pair; command records passed if Bob's removal was delivered before Alice undid, or if Bob's removal was omitted. The second empty beat in the original fixture is unnecessary.

Cause: src/undo-records/history.ts reverseRemoval deletes the removal entries currently visible to Alice, so it leaves no cancellation when b arrives later. src/readers/removal-commands.ts undoRemoval instead preserves a=false; removalIds interprets that as cancellation of the identical removal even if another entry arrives later. The command-record undo and reader rule therefore differ in this early-delivery case.

Resolved: reverseRemoval and undoRemoval now call one cancelRemoval helper. The retained false entry cancels the delayed identical removal. The literal above passes on both writers and an encoded late joiner in D1, D2, D3, dup, rev and late-C. The three controls also pass in each order: 24 tests across the two replay files. Existing undo expectations and declared limits are unchanged. The retained reader-order families separately cover either writer undoing first, both id pairs/client-id orders and re-removal.
