Shows the B Writer's retained mapper failure, deliberate re-entry controls, T21 mismatch and mark observations under the unchanged mechanism interface.

App c67139b8806d04231d2f2c5bb89814370bab8ef6. Counts and observations only.

split-before/M2/D3/retain=false/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":3}}}}}
stage 1: {"dirty":true,"composing":true,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":3}}}}}
stage 2: {"dirty":true,"composing":true,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","a",["s1"]],["Rb","bcd",["s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"Rb","offset":1,"selection":{"beat":"Rb","from":1,"to":2}}},"B.E":{"rows":[["R1","a",["s1"]],["Rb","bcd",["s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"Rb","offset":1,"selection":{"beat":"Rb","from":1,"to":2}}}}}
stage 3: {"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","axy",["s1","a1","a2"]],["Rb","bd",["s2","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","a",["s1"]],["Rb","bcd",["s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[]}}}
stage 4: {"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","axy",["s1","a1","a2"]],["Rb","bd",["s2","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","axy",["s1","a1","a2"]],["Rb","bd",["s2","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
FAIL: A.E: local text moved away from its painted left identity s2
FAIL: B.E: local text moved away from its painted left identity s2
```

split-before/M2/dup/retain=false/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":3}}}}}
stage 1: {"dirty":true,"composing":true,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":3}}}}}
stage 2: {"dirty":true,"composing":true,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","a",["s1"]],["Rb","bcd",["s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"Rb","offset":1,"selection":{"beat":"Rb","from":1,"to":2}}},"B.E":{"rows":[["R1","a",["s1"]],["Rb","bcd",["s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"Rb","offset":1,"selection":{"beat":"Rb","from":1,"to":2}}}}}
stage 3: {"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","axy",["s1","a1","a2"]],["Rb","bd",["s2","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","a",["s1"]],["Rb","bcd",["s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[]}}}
stage 4: {"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","axy",["s1","a1","a2"]],["Rb","bd",["s2","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","axy",["s1","a1","a2"]],["Rb","bd",["s2","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
FAIL: A.E: local text moved away from its painted left identity s2
FAIL: B.E: local text moved away from its painted left identity s2
```

split-before/M2/late-C/retain=false/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":3}}}}}
stage 1: {"dirty":true,"composing":true,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":3}}}}}
stage 2: {"dirty":true,"composing":true,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","a",["s1"]],["Rb","bcd",["s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"Rb","offset":1,"selection":{"beat":"Rb","from":1,"to":2}}},"B.E":{"rows":[["R1","a",["s1"]],["Rb","bcd",["s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"Rb","offset":1,"selection":{"beat":"Rb","from":1,"to":2}}}}}
stage 3: {"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","axy",["s1","a1","a2"]],["Rb","bd",["s2","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","a",["s1"]],["Rb","bcd",["s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[]}}}
stage 4: {"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","axy",["s1","a1","a2"]],["Rb","bd",["s2","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","axy",["s1","a1","a2"]],["Rb","bd",["s2","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"C.E":{"rows":[["R1","axy",["s1","a1","a2"]],["Rb","bd",["s2","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
FAIL: A.E: local text moved away from its painted left identity s2
FAIL: B.E: local text moved away from its painted left identity s2
FAIL: C.E: local text moved away from its painted left identity s2
```

join-previous/M1/D3/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"B.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

join-previous/M1/dup/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"B.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

join-previous/M1/late-C/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"B.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"C.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

join-previous/M2/D3/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"B.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

join-previous/M2/dup/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"B.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

join-previous/M2/late-C/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"B.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"C.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

join-previous/M3/D3/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"A.N":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"B.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"B.N":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

join-previous/M3/dup/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"A.N":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"B.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"B.N":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

join-previous/M3/late-C/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"A.N":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"B.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"B.N":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"C.E":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}},"C.N":{"rows":[["R1","abcd exyf",["s1","s2","s3","s4","[glue]","s5","a1","a2","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":8}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

bold/M1/D3/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{"b":true}},{"name":"a2","marks":{"b":true}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

bold/M1/dup/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{"b":true}},{"name":"a2","marks":{"b":true}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

bold/M1/late-C/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"C.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{"b":true}},{"name":"a2","marks":{"b":true}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

bold/M2/D3/retain=false/gate=false: PASS; T21 MISMATCH on new xy (outside scoped checker)

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

bold/M2/dup/retain=false/gate=false: PASS; T21 MISMATCH on new xy (outside scoped checker)

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

bold/M2/late-C/retain=false/gate=false: PASS; T21 MISMATCH on new xy (outside scoped checker)

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"C.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

bold/M3/D3/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"A.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{"b":true}},{"name":"a2","marks":{"b":true}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

bold/M3/dup/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"A.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{"b":true}},{"name":"a2","marks":{"b":true}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

bold/M3/late-C/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"A.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"C.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"C.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{"b":true}},{"name":"a2","marks":{"b":true}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

comment-tag/M1/D3/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{"t:oB":"P","c:C1":true}},{"name":"a2","marks":{"t:oB":"P","c:C1":true}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

comment-tag/M1/dup/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{"t:oB":"P","c:C1":true}},{"name":"a2","marks":{"t:oB":"P","c:C1":true}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

comment-tag/M1/late-C/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"C.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{"t:oB":"P","c:C1":true}},{"name":"a2","marks":{"t:oB":"P","c:C1":true}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

comment-tag/M2/D3/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

comment-tag/M2/dup/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

comment-tag/M2/late-C/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"C.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

comment-tag/M3/D3/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"A.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{"t:oB":"P","c:C1":true}},{"name":"a2","marks":{"t:oB":"P","c:C1":true}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

comment-tag/M3/dup/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"A.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{"t:oB":"P","c:C1":true}},{"name":"a2","marks":{"t:oB":"P","c:C1":true}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

comment-tag/M3/late-C/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"A.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"C.E":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}},"C.N":{"rows":[["R1","abxycd",["s1","s2","a1","a2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{"t:oB":"P","c:C1":true}},{"name":"a2","marks":{"t:oB":"P","c:C1":true}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

long/M1/D3/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

long/M1/dup/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

long/M1/late-C/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"C.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

long/M2/D3/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

long/M2/dup/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

long/M2/late-C/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"C.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

long/M3/D3/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"A.N":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.N":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

long/M3/dup/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"A.N":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.N":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

long/M3/late-C/retain=false/gate=false: PASS

```text
{"dirty":false,"composing":false,"errors":[],"commits":["syncComposition:syncBeatEl"],"replicas":{"A.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"A.N":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"B.N":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"C.E":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}},"C.N":{"rows":[["R1","abxycdQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",46],["R2","efRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR",42]],"recovery":[],"caret":{"beat":"R1","offset":4}}}}
raw new marks: [{"name":"a1","marks":{}},{"name":"a2","marks":{}}]; composing DOM: [{"sameNodes":true}]; reentry: []
```

reentry-type/M1/D3/retain=false/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}}}}
stage 1: {"dirty":false,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 2: {"dirty":false,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
raw new marks: []; composing DOM: [{"sameNodes":false}]; reentry: [{"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"},{"where":"after-app-beforeinput","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[2,2]},{"where":"after-app-beforeinput","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[3,3]}]
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: A.E: local text did not commit once with new identities
FAIL: B.E: local text did not commit once with new identities
```

reentry-type/M2/D3/retain=false/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}}}}
stage 1: {"dirty":false,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 2: {"dirty":false,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
raw new marks: []; composing DOM: [{"sameNodes":false}]; reentry: [{"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"},{"where":"after-app-beforeinput","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[2,2]},{"where":"after-app-beforeinput","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[3,3]}]
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: A.E: local text did not commit once with new identities
FAIL: B.E: local text did not commit once with new identities
```

reentry-type/M2/D3/retain=true/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}}}}
stage 1: {"dirty":true,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 2: {"dirty":true,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
raw new marks: []; composing DOM: [{"sameNodes":false}]; reentry: [{"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"},{"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[2,2]},{"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"Zabcd","selection":[3,3]}]
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: native buffer is not committed
FAIL: A.E: local text did not commit once with new identities
FAIL: B.E: local text did not commit once with new identities
FAIL: DOM differs from projection for R1
```

reentry-type/M3/D3/retain=false/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"A.N":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.N":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}}}}
stage 1: {"dirty":false,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"A.N":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.N":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
stage 2: {"dirty":false,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"A.N":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}},"B.N":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":3}}}}
raw new marks: []; composing DOM: [{"sameNodes":false}]; reentry: [{"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"},{"where":"after-app-beforeinput","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[2,2]},{"where":"after-app-beforeinput","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[3,3]}]
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: A.E: local text did not commit once with new identities
FAIL: A.N: local text did not commit once with new identities
FAIL: B.E: local text did not commit once with new identities
FAIL: B.N: local text did not commit once with new identities
```

reentry-replace/M1/D3/retain=false/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}}}}
stage 1: {"dirty":false,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}}}}
stage 2: {"dirty":false,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}}}}
raw new marks: []; composing DOM: [{"sameNodes":false}]; reentry: [{"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"},{"where":"after-app-beforeinput","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[1,3]},{"where":"after-app-beforeinput","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[2,4]}]
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: A.E: local text did not commit once with new identities
FAIL: A.E: unexpected retained identity s2
FAIL: A.E: unexpected retained identity s3
FAIL: B.E: local text did not commit once with new identities
FAIL: B.E: unexpected retained identity s2
FAIL: B.E: unexpected retained identity s3
```

reentry-replace/M2/D3/retain=false/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}}}}
stage 1: {"dirty":false,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}}}}
stage 2: {"dirty":false,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}}}}
raw new marks: []; composing DOM: [{"sameNodes":false}]; reentry: [{"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"},{"where":"after-app-beforeinput","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[1,3]},{"where":"after-app-beforeinput","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[2,4]}]
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: A.E: local text did not commit once with new identities
FAIL: A.E: unexpected retained identity s2
FAIL: A.E: unexpected retained identity s3
FAIL: B.E: local text did not commit once with new identities
FAIL: B.E: unexpected retained identity s2
FAIL: B.E: unexpected retained identity s3
```

reentry-replace/M2/D3/retain=true/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}}}}
stage 1: {"dirty":true,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}}}}
stage 2: {"dirty":true,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}}}}
raw new marks: []; composing DOM: [{"sameNodes":false}]; reentry: [{"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"},{"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]},{"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"Zabcd","selection":[1,3]}]
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: native buffer is not committed
FAIL: A.E: local text did not commit once with new identities
FAIL: A.E: unexpected retained identity s2
FAIL: A.E: unexpected retained identity s3
FAIL: B.E: local text did not commit once with new identities
FAIL: B.E: unexpected retained identity s2
FAIL: B.E: unexpected retained identity s3
FAIL: DOM differs from projection for R1
```

reentry-replace/M3/D3/retain=false/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}},"A.N":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}},"B.N":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}}}}
stage 1: {"dirty":false,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}},"A.N":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}},"B.N":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}}}}
stage 2: {"dirty":false,"composing":false,"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"],"commits":[],"replicas":{"A.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}},"A.N":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}},"B.N":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2,"selection":{"beat":"R1","from":2,"to":4}}}}}
raw new marks: []; composing DOM: [{"sameNodes":false}]; reentry: [{"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"},{"where":"after-app-beforeinput","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[1,3]},{"where":"after-app-beforeinput","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[2,4]}]
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: A.E: local text did not commit once with new identities
FAIL: A.E: unexpected retained identity s2
FAIL: A.E: unexpected retained identity s3
FAIL: A.N: local text did not commit once with new identities
FAIL: A.N: unexpected retained identity s2
FAIL: A.N: unexpected retained identity s3
FAIL: B.E: local text did not commit once with new identities
FAIL: B.E: unexpected retained identity s2
FAIL: B.E: unexpected retained identity s3
FAIL: B.N: local text did not commit once with new identities
FAIL: B.N: unexpected retained identity s2
FAIL: B.N: unexpected retained identity s3
```

reentry-paste/M1/D3/retain=false/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}}}}
stage 1: {"dirty":false,"composing":false,"errors":[],"commits":["paste:command-override"],"replicas":{"A.E":{"rows":[["R1","ZQcd",["b1","a1","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[]}}}
stage 2: {"dirty":false,"composing":false,"errors":[],"commits":["paste:command-override"],"replicas":{"A.E":{"rows":[["R1","ZQcd",["b1","a1","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","ZQcd",["b1","a1","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}}}}
raw new marks: [{"name":"a1","marks":{}}]; composing DOM: [{"sameNodes":false}]; reentry: [{"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[1,3]},{"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[2,4]}]
FAIL: A.E: required identity/value s1 "a" missing or changed
FAIL: A.E: unexpected retained identity s3
FAIL: B.E: required identity/value s1 "a" missing or changed
FAIL: B.E: unexpected retained identity s3
```

reentry-paste/M2/D3/retain=false/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}}}}
stage 1: {"dirty":false,"composing":false,"errors":[],"commits":["paste:command-override"],"replicas":{"A.E":{"rows":[["R1","ZQcd",["b1","a1","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[]}}}
stage 2: {"dirty":false,"composing":false,"errors":[],"commits":["paste:command-override"],"replicas":{"A.E":{"rows":[["R1","ZQcd",["b1","a1","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","ZQcd",["b1","a1","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}}}}
raw new marks: [{"name":"a1","marks":{}}]; composing DOM: [{"sameNodes":false}]; reentry: [{"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[1,3]},{"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[2,4]}]
FAIL: A.E: required identity/value s1 "a" missing or changed
FAIL: A.E: unexpected retained identity s3
FAIL: B.E: required identity/value s1 "a" missing or changed
FAIL: B.E: unexpected retained identity s3
```

reentry-paste/M3/D3/retain=false/gate=false: FAIL

```text
stage 0: {"dirty":false,"composing":false,"errors":[],"commits":[],"replicas":{"A.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}},"A.N":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}},"B.E":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}},"B.N":{"rows":[["R1","abcd",["s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":1,"selection":{"beat":"R1","from":1,"to":3}}}}}
stage 1: {"dirty":false,"composing":false,"errors":[],"commits":["paste:command-override"],"replicas":{"A.E":{"rows":[["R1","ZQcd",["b1","a1","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"A.N":{"rows":[["R1","ZQcd",["b1","a1","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[]},"B.N":{"rows":[["R1","Zabcd",["b1","s1","s2","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[]}}}
stage 2: {"dirty":false,"composing":false,"errors":[],"commits":["paste:command-override"],"replicas":{"A.E":{"rows":[["R1","ZQcd",["b1","a1","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"A.N":{"rows":[["R1","ZQcd",["b1","a1","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.E":{"rows":[["R1","ZQcd",["b1","a1","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}},"B.N":{"rows":[["R1","ZQcd",["b1","a1","s3","s4"]],["R2","ef",["s5","s6"]]],"recovery":[],"caret":{"beat":"R1","offset":2}}}}
raw new marks: [{"name":"a1","marks":{}}]; composing DOM: [{"sameNodes":false}]; reentry: [{"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[1,3]},{"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[2,4]}]
FAIL: A.E: required identity/value s1 "a" missing or changed
FAIL: A.E: unexpected retained identity s3
FAIL: A.N: required identity/value s1 "a" missing or changed
FAIL: A.N: unexpected retained identity s3
FAIL: B.E: required identity/value s1 "a" missing or changed
FAIL: B.E: unexpected retained identity s3
FAIL: B.N: required identity/value s1 "a" missing or changed
FAIL: B.N: unexpected retained identity s3
```
