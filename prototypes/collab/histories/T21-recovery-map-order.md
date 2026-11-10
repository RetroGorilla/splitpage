# T21: recovery fields depend on the first matching removal

These command histories have no undo. Both layouts run every D1/D2/D3/duplicate/reverse/late-C delivery and an encoded-state late join. Replicas finish with byte-identical encoded state.

1. Seed R1 `a`, R2 `q`. Alice inserts `x` after `a` (identity a1), then removes R1 as rA. Bob concurrently removes R1 as rB without x. Synchronize. Alice reports recovery `edited=[]`; Bob and the encoded late joiner report `edited=["a1"]`. Authors also differ, Alice/Bob/Bob.
2. Seed R1 `abcd`, R2 `e`. Alice splits R1 at 2 into Ra, recording Alice as splitter. Bob concurrently splits R1 at 1 into Rb and removes Rb as rB. Synchronize. Bob removes Ra directly as rC. Synchronize. Ra's `splitBy` is absent on Alice, and Alice on Bob and the encoded late joiner. Its content and the removal set agree.

The exact observations are literal data in `test/reader-order/histories.ts`; `general.test.ts` requires each named full-output failure to remain detected. The general gate also checks all existing structure/marks histories and seeded valid-command histories. These readers are still failing in the first check-only PR revision.

Artifact 8 T10/T11 define recovery after one observed removal and a split into removed content. They do not explicitly decide how to combine these fields when multiple removers observed different sets or when a later direct removal overlaps an earlier inherited removal. Retained options: edited identities observed by no remover (union of observed sets, yielding `[]`) versus identities absent from any remover's set (yielding `["a1"]`); omit split attribution after a direct removal versus retain Alice because the earlier inherited removal still applies. Both choices must be replica-independent. No product row is changed or silently inferred here.

The coordinator subsequently selected the information-preserving assumptions recorded under “Assumed, for the product review” in `reader-order-results.md`. History 1 now reads `edited=["a1"]`; history 2 reads `splitBy:"Alice"` on every replica. The archived structural reader still reproduces all original observations above, and the general strict checker rejects it. These are coordinator assumptions for product review, not changes to a Stage 0 decision.
