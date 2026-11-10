# PROJ poster B

Shows a merged domain-limit violation or omitted heading after two individually valid operations.

Seed 1; per-replica measures before delivery 1, 1; limit 1.
Client ids: A=2, B=1, seed=10.
Start R1 links https://example.com/1/a and /b, neither a poster; A marks /a; B marks /b.
enqueue A1 A->B 18 bytes
enqueue B2 B->A 18 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
Projection measure 2; after app load/save 1; resave stable true.
Retained shared objects: 2; full encoded state unchanged by projection.
Projected heading ids: none.

App normalization differences:
```json
[
  {
    "path": "$.rows.0.imageLinks.1.poster",
    "before": true
  }
]
```
