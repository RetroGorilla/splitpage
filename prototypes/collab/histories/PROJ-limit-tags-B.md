# PROJ tags B

Shows a merged domain-limit violation or omitted heading after two individually valid operations.

Seed 1; per-replica measures before delivery 1, 1; limit 1.
Client ids: A=2, B=1, seed=10.
Start with Cup, t_left/Left 1, t_right/Right 1, all prop; A renames t_left to New 1; B renames t_right to New 1.
enqueue A1 A->B 20 bytes
enqueue B2 B->A 20 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
Projection measure 2; after app load/save 2; resave stable true.
Retained shared objects: 3; full encoded state unchanged by projection.
Projected heading ids: none.

App normalization differences:
```json
[]
```
