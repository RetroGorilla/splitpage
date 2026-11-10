# T21 comment: reply collation is not a total order

Shows replica-dependent reply order from a comparator that treats distinct keys as equal. This reader is unchanged in the status PR.

Seed: one empty R1 beat, comment C1. Alice (client 1) adds reply id U+00E9 (`é`), Bob (client 2) concurrently adds id U+0065 U+0301 (`é`); both have `createdAt: 0`. Deliver the two updates, then load a third replica from Alice's encoded state.

`"\u00e9".localeCompare("e\u0301") === 0`. Sorting `(createdAt, id.localeCompare)` therefore preserves the original map iteration order for these distinct keys.

| Reader | Reply ids as escaped strings |
| --- | --- |
| Alice | `["\u00e9", "e\u0301"]` |
| Bob | `["e\u0301", "\u00e9"]` |
| Encoded-state late joiner | `["e\u0301", "\u00e9"]` |

Alice and Bob encode to byte-identical state. Reproduce without a browser: `node --test test/marks/review-histories.test.ts`. The status PR records the finding; the stacked reader-order PR owns its repair and a total UTF-16 code-unit comparator.

The reader-order fix now returns `["e\u0301", "\u00e9"]` on every replica, using a total comparison by UTF-16 code units. The old comparator and the original observations remain in the tests. The general convergence checker injects a separate equal-time pair into every structure/marks checkpoint, with forward/reverse delivery and encoded reload, and rejects the old comparator even in a history with no authored replies.
