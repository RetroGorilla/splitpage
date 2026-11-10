# T21 scalar: replica-dependent status fallback

Shows the unchanged legacy reader returning ready and shot for identical encoded state after different delivery orders, with and without deleting/recreating c.

Input: one R1 beat with status todo; branch A writes a=ready/prior todo then c=shot/prior ready, parents=[a]; branch B writes b=shot/prior todo then d=ready/prior shot, parents=[b].
First reader receives a,c,b,d; second receives d,b,c,a; third joins from the first reader's encoded state. Recreation deletes c then writes its unchanged value after delivery. No legacy status code is changed.

```json
{
  "clients": [
    1,
    2
  ],
  "delivery": [
    "a",
    "c",
    "b",
    "d"
  ],
  "reverseDelivery": [
    "d",
    "b",
    "c",
    "a"
  ],
  "recreate": false,
  "stateSha256": "aa51651c9ea439cc284811a1cede2e108ff0b9bc2b052840a4f0155bed9d2068",
  "identicalEncodedState": true,
  "records": [
    [
      "a",
      {
        "target": "R1",
        "value": "ready",
        "prior": "todo",
        "parents": []
      }
    ],
    [
      "b",
      {
        "target": "R1",
        "value": "shot",
        "prior": "todo",
        "parents": []
      }
    ],
    [
      "c",
      {
        "target": "R1",
        "value": "shot",
        "prior": "ready",
        "parents": [
          "a"
        ]
      }
    ],
    [
      "d",
      {
        "target": "R1",
        "value": "ready",
        "prior": "shot",
        "parents": [
          "b"
        ]
      }
    ]
  ],
  "observations": [
    {
      "replica": "first",
      "keys": [
        "a",
        "c",
        "b",
        "d"
      ],
      "status": "ready"
    },
    {
      "replica": "reverse",
      "keys": [
        "b",
        "d",
        "a",
        "c"
      ],
      "status": "shot"
    },
    {
      "replica": "late",
      "keys": [
        "b",
        "d",
        "a",
        "c"
      ],
      "status": "shot"
    }
  ],
  "agrees": false
}
```

```json
{
  "clients": [
    1,
    2
  ],
  "delivery": [
    "a",
    "c",
    "b",
    "d"
  ],
  "reverseDelivery": [
    "d",
    "b",
    "c",
    "a"
  ],
  "recreate": true,
  "stateSha256": "50d67d8f19732f556972eb5c8168f9692d1d2cf55045a94dc2b9762ee5048e30",
  "identicalEncodedState": true,
  "records": [
    [
      "a",
      {
        "target": "R1",
        "value": "ready",
        "prior": "todo",
        "parents": []
      }
    ],
    [
      "b",
      {
        "target": "R1",
        "value": "shot",
        "prior": "todo",
        "parents": []
      }
    ],
    [
      "c",
      {
        "target": "R1",
        "value": "shot",
        "prior": "ready",
        "parents": [
          "a"
        ]
      }
    ],
    [
      "d",
      {
        "target": "R1",
        "value": "ready",
        "prior": "shot",
        "parents": [
          "b"
        ]
      }
    ]
  ],
  "observations": [
    {
      "replica": "first",
      "keys": [
        "a",
        "c",
        "b",
        "d"
      ],
      "status": "ready"
    },
    {
      "replica": "reverse",
      "keys": [
        "b",
        "d",
        "a",
        "c"
      ],
      "status": "shot"
    },
    {
      "replica": "late",
      "keys": [
        "b",
        "d",
        "a",
        "c"
      ],
      "status": "shot"
    }
  ],
  "agrees": false
}
```

Matrix: 96 runs (24 delivery permutations × two author-id assignments × with/without recreation); 80 runs disagree across the three readers despite byte-identical encoded state on the first two.

Yjs map key/value convergence does not make this observed iteration-based fallback replica-independent. This is a T21 scalar/status-design finding, not a performance-index repair. No replacement resolution policy is chosen here.

Reproduce: node src/perf/lifetime/status-order.ts --write, from prototypes/collab. The generated JSON retains every order and observed key sequence.
