# PROJ heading B

Shows a merged domain-limit violation or omitted heading after two individually valid operations.

Seed 1; per-replica measures before delivery 1, 1; limit 1.
Client ids: A=2, B=1, seed=10.
Start R1/a and R2/b without headers; A inserts H-1-A/Heading 1-A before R1; B inserts H-1-B/Heading 1-B before R1.
enqueue A1 A->B 147 bytes
enqueue B2 B->A 147 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
Projection measure 1; after app load/save 1; resave stable true.
Retained shared objects: 2; full encoded state unchanged by projection.
Projected heading ids: H-1-A.

App normalization differences:
```json
[]
```
