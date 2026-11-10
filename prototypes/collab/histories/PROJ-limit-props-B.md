# PROJ props B

Shows a merged domain-limit violation or omitted heading after two individually valid operations.

Seed 1; per-replica measures before delivery 40, 40; limit 40.
Client ids: A=2, B=1, seed=10.
Start s1 with 39 free-name props prop-1-0 onward; A adds new-1-A at rank 860; B adds new-1-B at rank 326.
enqueue A1 A->B 74 bytes
enqueue B2 B->A 74 bytes
deliver A1 A->B copy 1
deliver B2 B->A copy 1
Projection measure 41; after app load/save 40; resave stable true.
Retained shared objects: 41; full encoded state unchanged by projection.
Projected heading ids: none.

App normalization differences:
```json
[
  {
    "path": "$.brollShots.0.props.40",
    "before": {
      "id": "",
      "name": "new-1-A"
    }
  }
]
```
