Shows the separate T02 binding extension failure: its declared stale focused cell is repainted before input; DOM caret 3 cannot be used against painted ab of length 2. No second repair attempted.

App 224b60c580dd03d2541f4edd58a9324b07ff389c; candidate B; mechanism M1; same corrected prototype bundle 75cffbeb7b51813541486143b68c2f4eae347fadae89a18a731538f28301aa72.

T02/D3: Error: Native selection outside painted text

```text
stage 0: {"text":"ab","selection":[2,2],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":[],"replicas":{"A.E":{"rows":[["R1","ab",["s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","ab",["s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":2}}}}
stage 1: {"text":"Xab","selection":[3,3],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":["Native selection outside painted text"],"replicas":{"A.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 2: {"text":"Xab","selection":[3,3],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":["Native selection outside painted text"],"replicas":{"A.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 3: {"text":"Xab","selection":[3,3],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":["Native selection outside painted text"],"replicas":{"A.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 4: {"text":"Xab","selection":[3,3],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":["Native selection outside painted text"],"replicas":{"A.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
```

T02/dup: Error: Native selection outside painted text

```text
stage 0: {"text":"ab","selection":[2,2],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":[],"replicas":{"A.E":{"rows":[["R1","ab",["s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","ab",["s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":2}}}}
stage 1: {"text":"Xab","selection":[3,3],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":["Native selection outside painted text"],"replicas":{"A.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 2: {"text":"Xab","selection":[3,3],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":["Native selection outside painted text"],"replicas":{"A.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 3: {"text":"Xab","selection":[3,3],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":["Native selection outside painted text"],"replicas":{"A.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 4: {"text":"Xab","selection":[3,3],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":["Native selection outside painted text"],"replicas":{"A.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
```

T02/late-C: Error: Native selection outside painted text

```text
stage 0: {"text":"ab","selection":[2,2],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":[],"replicas":{"A.E":{"rows":[["R1","ab",["s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","ab",["s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":2}}}}
stage 1: {"text":"Xab","selection":[3,3],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":["Native selection outside painted text"],"replicas":{"A.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 2: {"text":"Xab","selection":[3,3],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":["Native selection outside painted text"],"replicas":{"A.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 3: {"text":"Xab","selection":[3,3],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":["Native selection outside painted text"],"replicas":{"A.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 4: {"text":"Xab","selection":[3,3],"coordination":{"enabled":true,"reconciling":false,"nestedPaintsSuppressed":0},"commits":[],"errors":["Native selection outside painted text"],"replicas":{"A.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Xab",["b1","s1","s2"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
```
