Synchronous delivery after the app's target capture requires an early native-buffer hold; paste uses the app's command boundary because it has no native beforeinput/input pair.

App 935e618949a2e964198847daa2115d35e1da58ef; Edg/157.0.4341.42; machine <machine>, AMD Ryzen 9 9950X3D2 16-Core Processor         , v24.22.1.

Generated from retained observations. New combinations use invariant checks, not newly invented visible-script oracles.

reentry-type / M1 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"Zabcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1465.8999999761581},{"phase":"app-repaint-request","ms":0.5,"at":1468.5},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1470.8999999761581}] actualPaints=[{"phase":"start","at":1468.1000000238419},{"phase":"end","at":1468.1000000238419},{"phase":"start","at":1470.5},{"phase":"end","at":1470.6000000238419}] rawLocalMarks=[] remoteDOM=[{"sameNodes":false}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[3,3]}
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: A.E: local text did not commit once with new identities
FAIL: B.E: local text did not commit once with new identities
```

reentry-type / M1 / D3 / retainBeforeInput=true / nativePaintGate=false: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1473.800000011921},{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1475.6000000238419},{"phase":"buffer-commit","ms":0,"at":1476.1000000238419},{"phase":"commit-and-projection","ms":0.09999996423721313,"at":1476.199999988079},{"phase":"app-repaint-request","ms":0.30000001192092896,"at":1476.800000011921},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1478.5}] actualPaints=[{"phase":"start","at":1475.5},{"phase":"end","at":1475.5},{"phase":"start","at":1476.5},{"phase":"end","at":1476.6000000238419},{"phase":"start","at":1478.3999999761581},{"phase":"end","at":1478.3999999761581}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
```

reentry-type / M1 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1481.300000011921},{"phase":"buffer-commit","ms":0.10000002384185791,"at":1483.1000000238419},{"phase":"commit-and-projection","ms":0.10000002384185791,"at":1483.1000000238419},{"phase":"app-repaint-request","ms":0.5,"at":1483.6000000238419},{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1485.6000000238419}] actualPaints=[{"phase":"start","at":1483.199999988079},{"phase":"end","at":1483.199999988079},{"phase":"start","at":1485.5},{"phase":"end","at":1485.5}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
```

reentry-type / M2 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"Zabcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1488.300000011921},{"phase":"app-repaint-request","ms":0.40000003576278687,"at":1490.1000000238419},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1492.699999988079}] actualPaints=[{"phase":"start","at":1489.699999988079},{"phase":"end","at":1489.800000011921},{"phase":"start","at":1492.3999999761581},{"phase":"end","at":1492.5}] rawLocalMarks=[] remoteDOM=[{"sameNodes":false}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[3,3]}
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: A.E: local text did not commit once with new identities
FAIL: B.E: local text did not commit once with new identities
```

reentry-type / M2 / D3 / retainBeforeInput=true / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":true,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":true,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1495.3999999761581},{"phase":"app-repaint-request","ms":0.30000001192092896,"at":1497}] actualPaints=[{"phase":"start","at":1496.699999988079},{"phase":"end","at":1496.800000011921}] rawLocalMarks=[] remoteDOM=[{"sameNodes":false}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"Zabcd","selection":[3,3]}
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: native buffer is not committed
FAIL: A.E: local text did not commit once with new identities
FAIL: B.E: local text did not commit once with new identities
FAIL: DOM differs from projection for R1
```

reentry-type / M2 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["input:stale-reentry"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["input:stale-reentry"],"errors":[]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1501.5},{"phase":"buffer-commit","ms":0.10000002384185791,"at":1503},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1503.5},{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1505}] actualPaints=[{"phase":"start","at":1503.199999988079},{"phase":"end","at":1503.199999988079},{"phase":"start","at":1504.8999999761581},{"phase":"end","at":1504.8999999761581}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
```

reentry-type / M3 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"Zabcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1508.5},{"phase":"app-repaint-request","ms":0.30000001192092896,"at":1510.5},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1512.699999988079}] actualPaints=[{"phase":"start","at":1510.300000011921},{"phase":"end","at":1510.3999999761581},{"phase":"start","at":1512.3999999761581},{"phase":"end","at":1512.3999999761581}] rawLocalMarks=[] remoteDOM=[{"sameNodes":false}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[3,3]}
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: A.E: local text did not commit once with new identities
FAIL: A.N: local text did not commit once with new identities
FAIL: B.E: local text did not commit once with new identities
FAIL: B.N: local text did not commit once with new identities
```

reentry-type / M3 / D3 / retainBeforeInput=true / nativePaintGate=false: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1515.800000011921},{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1517.3999999761581},{"phase":"buffer-commit","ms":0.09999996423721313,"at":1517.8999999761581},{"phase":"commit-and-projection","ms":0.09999996423721313,"at":1517.8999999761581},{"phase":"app-repaint-request","ms":0.5,"at":1518.5},{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1520.1000000238419}] actualPaints=[{"phase":"start","at":1517.300000011921},{"phase":"end","at":1517.3999999761581},{"phase":"start","at":1518.1000000238419},{"phase":"end","at":1518.199999988079},{"phase":"start","at":1520},{"phase":"end","at":1520}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
```

reentry-type / M3 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1523.1000000238419},{"phase":"buffer-commit","ms":0.09999996423721313,"at":1525.699999988079},{"phase":"commit-and-projection","ms":0.19999998807907104,"at":1525.800000011921},{"phase":"app-repaint-request","ms":0.5,"at":1526.3999999761581},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1528}] actualPaints=[{"phase":"start","at":1526},{"phase":"end","at":1526.1000000238419},{"phase":"start","at":1527.8999999761581},{"phase":"end","at":1527.8999999761581}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
```

reentry-replace / M1 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"Zabcd","selection":[2,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1530.8999999761581},{"phase":"app-repaint-request","ms":0.5,"at":1532.699999988079},{"phase":"app-repaint-request","ms":0.5,"at":1535.3999999761581}] actualPaints=[{"phase":"start","at":1532.300000011921},{"phase":"end","at":1532.300000011921},{"phase":"start","at":1535},{"phase":"end","at":1535}] rawLocalMarks=[] remoteDOM=[{"sameNodes":false}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[2,4]}
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: A.E: local text did not commit once with new identities
FAIL: A.E: unexpected retained identity s2
FAIL: A.E: unexpected retained identity s3
FAIL: B.E: local text did not commit once with new identities
FAIL: B.E: unexpected retained identity s2
FAIL: B.E: unexpected retained identity s3
```

reentry-replace / M1 / D3 / retainBeforeInput=true / nativePaintGate=false: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1538.800000011921},{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1540.199999988079},{"phase":"buffer-commit","ms":0.10000002384185791,"at":1540.6000000238419},{"phase":"commit-and-projection","ms":0.19999998807907104,"at":1540.699999988079},{"phase":"app-repaint-request","ms":0.5,"at":1541.300000011921},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1543.8999999761581}] actualPaints=[{"phase":"start","at":1540.1000000238419},{"phase":"end","at":1540.1000000238419},{"phase":"start","at":1540.800000011921},{"phase":"end","at":1540.8999999761581},{"phase":"start","at":1543.699999988079},{"phase":"end","at":1543.699999988079}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-replace / M1 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1546.699999988079},{"phase":"buffer-commit","ms":0,"at":1548.3999999761581},{"phase":"commit-and-projection","ms":0.10000002384185791,"at":1548.5},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1549},{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1550.699999988079}] actualPaints=[{"phase":"start","at":1548.6000000238419},{"phase":"end","at":1548.6000000238419},{"phase":"start","at":1550.6000000238419},{"phase":"end","at":1550.6000000238419}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-replace / M2 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"Zabcd","selection":[2,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1553.8999999761581},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1555.699999988079},{"phase":"app-repaint-request","ms":0.30000001192092896,"at":1557.699999988079}] actualPaints=[{"phase":"start","at":1555.300000011921},{"phase":"end","at":1555.3999999761581},{"phase":"start","at":1557.3999999761581},{"phase":"end","at":1557.5}] rawLocalMarks=[] remoteDOM=[{"sameNodes":false}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[2,4]}
FAIL: binding errors: App changed DOM outside observed native target; App changed DOM outside observed native target
FAIL: A.E: local text did not commit once with new identities
FAIL: A.E: unexpected retained identity s2
FAIL: A.E: unexpected retained identity s3
FAIL: B.E: local text did not commit once with new identities
FAIL: B.E: unexpected retained identity s2
FAIL: B.E: unexpected retained identity s3
```

reentry-replace / M2 / D3 / retainBeforeInput=true / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":true,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":true,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1561.1000000238419},{"phase":"app-repaint-request","ms":0.30000001192092896,"at":1562.699999988079}] actualPaints=[{"phase":"start","at":1562.3999999761581},{"phase":"end","at":1562.3999999761581}] rawLocalMarks=[] remoteDOM=[{"sameNodes":false}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"Zabcd","selection":[1,3]}
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

reentry-replace / M2 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["input:stale-reentry"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["input:stale-reentry"],"errors":[]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1567.199999988079},{"phase":"buffer-commit","ms":0.10000002384185791,"at":1569.5},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1570},{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1571.699999988079}] actualPaints=[{"phase":"start","at":1569.699999988079},{"phase":"end","at":1569.699999988079},{"phase":"start","at":1571.6000000238419},{"phase":"end","at":1571.6000000238419}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-replace / M3 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"Zabcd","selection":[2,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1574.699999988079},{"phase":"app-repaint-request","ms":0.2999999523162842,"at":1576.8999999761581},{"phase":"app-repaint-request","ms":0.30000001192092896,"at":1579.1000000238419}] actualPaints=[{"phase":"start","at":1576.6000000238419},{"phase":"end","at":1576.699999988079},{"phase":"start","at":1578.800000011921},{"phase":"end","at":1578.8999999761581}] rawLocalMarks=[] remoteDOM=[{"sameNodes":false}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[2,4]}
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

reentry-replace / M3 / D3 / retainBeforeInput=true / nativePaintGate=false: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1582.300000011921},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1584.199999988079},{"phase":"buffer-commit","ms":0,"at":1584.5},{"phase":"commit-and-projection","ms":0.10000002384185791,"at":1584.6000000238419},{"phase":"app-repaint-request","ms":0.5,"at":1585.199999988079},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1587}] actualPaints=[{"phase":"start","at":1584},{"phase":"end","at":1584.1000000238419},{"phase":"start","at":1584.800000011921},{"phase":"end","at":1584.8999999761581},{"phase":"start","at":1586.800000011921},{"phase":"end","at":1586.800000011921}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-replace / M3 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1590},{"phase":"buffer-commit","ms":0,"at":1591.800000011921},{"phase":"commit-and-projection","ms":0,"at":1591.800000011921},{"phase":"app-repaint-request","ms":0.2999999523162842,"at":1592.3999999761581},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1594.3999999761581}] actualPaints=[{"phase":"start","at":1592.1000000238419},{"phase":"end","at":1592.1000000238419},{"phase":"start","at":1594.300000011921},{"phase":"end","at":1594.300000011921}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-paste / M1 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZQcd","identities":["b1","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZQcd","identities":["b1","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1597.5},{"phase":"app-repaint-request","ms":0.40000003576278687,"at":1602.300000011921},{"phase":"buffer-commit","ms":0,"at":1602.5},{"phase":"commit-and-projection","ms":0,"at":1602.5},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1602.8999999761581},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1605.5}] actualPaints=[{"phase":"start","at":1601.8999999761581},{"phase":"end","at":1602},{"phase":"start","at":1602.5},{"phase":"end","at":1602.6000000238419},{"phase":"start","at":1603},{"phase":"end","at":1603},{"phase":"start","at":1605.300000011921},{"phase":"end","at":1605.300000011921}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":false}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[2,4]}
FAIL: A.E: required identity/value s1 "a" missing or changed
FAIL: A.E: unexpected retained identity s3
FAIL: B.E: required identity/value s1 "a" missing or changed
FAIL: B.E: unexpected retained identity s3
```

reentry-paste / M1 / D3 / retainBeforeInput=true / nativePaintGate=false: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1608.3999999761581},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1611.199999988079},{"phase":"buffer-commit","ms":0.10000002384185791,"at":1611.300000011921},{"phase":"commit-and-projection","ms":0.10000002384185791,"at":1611.300000011921},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1611.699999988079},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1614}] actualPaints=[{"phase":"start","at":1611},{"phase":"end","at":1611},{"phase":"start","at":1611.300000011921},{"phase":"end","at":1611.300000011921},{"phase":"start","at":1611.8999999761581},{"phase":"end","at":1611.8999999761581},{"phase":"start","at":1613.800000011921},{"phase":"end","at":1613.8999999761581}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-paste / M1 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1617},{"phase":"buffer-commit","ms":0,"at":1619.5},{"phase":"commit-and-projection","ms":0.10000002384185791,"at":1619.6000000238419},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1620},{"phase":"app-repaint-request","ms":0.20000004768371582,"at":1622.1000000238419}] actualPaints=[{"phase":"start","at":1619.6000000238419},{"phase":"end","at":1619.699999988079},{"phase":"start","at":1620.1000000238419},{"phase":"end","at":1620.199999988079},{"phase":"start","at":1621.8999999761581},{"phase":"end","at":1621.8999999761581}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-paste / M2 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZQcd","identities":["b1","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZQcd","identities":["b1","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1625.1000000238419},{"phase":"app-repaint-request","ms":0.40000003576278687,"at":1628.1000000238419},{"phase":"buffer-commit","ms":0,"at":1628.300000011921},{"phase":"commit-and-projection","ms":0,"at":1628.300000011921},{"phase":"app-repaint-request","ms":0.30000001192092896,"at":1628.699999988079},{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1630.8999999761581}] actualPaints=[{"phase":"start","at":1627.699999988079},{"phase":"end","at":1627.800000011921},{"phase":"start","at":1628.3999999761581},{"phase":"end","at":1628.5},{"phase":"start","at":1628.800000011921},{"phase":"end","at":1628.800000011921},{"phase":"start","at":1630.800000011921},{"phase":"end","at":1630.800000011921}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":false}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[2,4]}
FAIL: A.E: required identity/value s1 "a" missing or changed
FAIL: A.E: unexpected retained identity s3
FAIL: B.E: required identity/value s1 "a" missing or changed
FAIL: B.E: unexpected retained identity s3
```

reentry-paste / M2 / D3 / retainBeforeInput=true / nativePaintGate=false: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:stale-reentry"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:stale-reentry"],"errors":[]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1634},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1636.3999999761581},{"phase":"buffer-commit","ms":0.10000002384185791,"at":1636.5},{"phase":"app-repaint-request","ms":0.2999999523162842,"at":1636.8999999761581},{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1639.5}] actualPaints=[{"phase":"start","at":1636},{"phase":"end","at":1636.1000000238419},{"phase":"start","at":1636.6000000238419},{"phase":"end","at":1636.6000000238419},{"phase":"start","at":1637.1000000238419},{"phase":"end","at":1637.199999988079},{"phase":"start","at":1639.3999999761581},{"phase":"end","at":1639.5}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":false}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":true,"dom":"Zabcd","selection":[1,3]}
```

reentry-paste / M2 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:stale-reentry"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:stale-reentry"],"errors":[]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1642.3999999761581},{"phase":"buffer-commit","ms":0.10000002384185791,"at":1645.1000000238419},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1645.5},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1647.699999988079}] actualPaints=[{"phase":"start","at":1645.1000000238419},{"phase":"end","at":1645.199999988079},{"phase":"start","at":1645.6000000238419},{"phase":"end","at":1645.6000000238419},{"phase":"start","at":1647.6000000238419},{"phase":"end","at":1647.6000000238419}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-paste / M3 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZQcd","identities":["b1","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZQcd","identities":["b1","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1650.8999999761581},{"phase":"app-repaint-request","ms":0.40000003576278687,"at":1653.800000011921},{"phase":"buffer-commit","ms":0.10000002384185791,"at":1654},{"phase":"commit-and-projection","ms":0.10000002384185791,"at":1654},{"phase":"app-repaint-request","ms":0.5,"at":1654.5},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1657}] actualPaints=[{"phase":"start","at":1653.3999999761581},{"phase":"end","at":1653.5},{"phase":"start","at":1654},{"phase":"end","at":1654.199999988079},{"phase":"start","at":1654.6000000238419},{"phase":"end","at":1654.699999988079},{"phase":"start","at":1656.800000011921},{"phase":"end","at":1656.800000011921}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":false}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":false,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":false,"dom":"Zabcd","selection":[2,4]}
FAIL: A.E: required identity/value s1 "a" missing or changed
FAIL: A.E: unexpected retained identity s3
FAIL: A.N: required identity/value s1 "a" missing or changed
FAIL: A.N: unexpected retained identity s3
FAIL: B.E: required identity/value s1 "a" missing or changed
FAIL: B.E: unexpected retained identity s3
FAIL: B.N: required identity/value s1 "a" missing or changed
FAIL: B.N: unexpected retained identity s3
```

reentry-paste / M3 / D3 / retainBeforeInput=true / nativePaintGate=false: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1660.300000011921},{"phase":"app-repaint-request","ms":0,"at":1662.800000011921},{"phase":"buffer-commit","ms":0,"at":1662.8999999761581},{"phase":"commit-and-projection","ms":0.10000002384185791,"at":1663},{"phase":"app-repaint-request","ms":0.30000001192092896,"at":1663.300000011921},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1665.699999988079}] actualPaints=[{"phase":"start","at":1662.800000011921},{"phase":"end","at":1662.800000011921},{"phase":"start","at":1663},{"phase":"end","at":1663.1000000238419},{"phase":"start","at":1663.5},{"phase":"end","at":1663.5},{"phase":"start","at":1665.6000000238419},{"phase":"end","at":1665.6000000238419}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-paste / M3 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1669.300000011921},{"phase":"buffer-commit","ms":0.10000002384185791,"at":1671.800000011921},{"phase":"commit-and-projection","ms":0.19999998807907104,"at":1671.8999999761581},{"phase":"app-repaint-request","ms":0.40000003576278687,"at":1672.300000011921},{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1674.8999999761581}] actualPaints=[{"phase":"start","at":1671.8999999761581},{"phase":"end","at":1671.8999999761581},{"phase":"start","at":1672.300000011921},{"phase":"end","at":1672.3999999761581},{"phase":"start","at":1674.800000011921},{"phase":"end","at":1674.8999999761581}] rawLocalMarks=[{"name":"a1","marks":{}}] remoteDOM=[{"sameNodes":true}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```
