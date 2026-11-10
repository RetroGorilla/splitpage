# PROJ gallery B

Shows a merged domain-limit violation or omitted heading after two individually valid operations.

Seed 1; per-replica measures before delivery 61, 61; limit 61.
Client ids: A=2, B=1, seed=10.
Start with 60 pictures on R1, refs with integer hashes 1000 through 1059.
A adds gallery-1-A, ref 1998, rank 590; B adds gallery-1-B, ref 1999, rank 836.
enqueue A1 A->B 244 bytes
enqueue B2 B->A 244 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
Projection measure 62; after app load/save 61; resave stable true.
Retained shared objects: 62; full encoded state unchanged by projection.
Projected heading ids: none.

App normalization differences:
```json
[
  {
    "path": "$.rows.0.moreImages.60",
    "before": {
      "imageRef": {
        "sha256": "00000000000000000000000000000000000000000000000000000000000007cf",
        "width": 1,
        "height": 1,
        "mime": "image/png"
      }
    }
  }
]
```
