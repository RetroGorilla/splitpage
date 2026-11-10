Synchronous delivery after the app's target capture requires an early native-buffer hold; paste uses the app's command boundary because it has no native beforeinput/input pair.

App 935e618949a2e964198847daa2115d35e1da58ef; Edg/157.0.4341.42; machine DESKTOP-NEFVS90, AMD Ryzen 9 9950X3D2 16-Core Processor         , v24.22.1.

Generated from retained observations. New combinations use invariant checks, not newly invented visible-script oracles.

reentry-type / M1 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"Zabcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1929.6000000238419},{"phase":"app-repaint-request","ms":0.800000011920929,"at":1932.9000000357628},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1936.199999988079}] actualPaints=[{"phase":"start","at":1932.300000011921},{"phase":"end","at":1932.300000011921},{"phase":"start","at":1935.9000000357628},{"phase":"end","at":1935.9000000357628}] rawLocalMarks=[]
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
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1940.199999988079},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1942.199999988079},{"phase":"buffer-commit","ms":0.10000002384185791,"at":1942.800000011921},{"phase":"commit-and-projection","ms":0.20000004768371582,"at":1942.9000000357628},{"phase":"app-repaint-request","ms":0.800000011920929,"at":1943.800000011921},{"phase":"app-repaint-request","ms":0.20000004768371582,"at":1945.9000000357628}] actualPaints=[{"phase":"start","at":1942.1000000238419},{"phase":"end","at":1942.1000000238419},{"phase":"start","at":1943},{"phase":"end","at":1943.1000000238419},{"phase":"start","at":1945.699999988079},{"phase":"end","at":1945.699999988079}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
```

reentry-type / M1 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.20000004768371582,"at":1949.9000000357628},{"phase":"buffer-commit","ms":0.09999996423721313,"at":1952.199999988079},{"phase":"commit-and-projection","ms":0.09999996423721313,"at":1952.199999988079},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1952.800000011921},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1955.199999988079}] actualPaints=[{"phase":"start","at":1952.5},{"phase":"end","at":1952.5},{"phase":"start","at":1955},{"phase":"end","at":1955.1000000238419}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
```

reentry-type / M2 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"Zabcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":1959.5},{"phase":"app-repaint-request","ms":0.6000000238418579,"at":1961.9000000357628},{"phase":"app-repaint-request","ms":0.5,"at":1964.800000011921}] actualPaints=[{"phase":"start","at":1961.4000000357628},{"phase":"end","at":1961.4000000357628},{"phase":"start","at":1964.300000011921},{"phase":"end","at":1964.4000000357628}] rawLocalMarks=[]
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
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1969},{"phase":"app-repaint-request","ms":0.5,"at":1971.4000000357628}] actualPaints=[{"phase":"start","at":1970.9000000357628},{"phase":"end","at":1971.1000000238419}] rawLocalMarks=[]
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
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1978.300000011921},{"phase":"buffer-commit","ms":0.10000002384185791,"at":1980.4000000357628},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":1981},{"phase":"app-repaint-request","ms":0.20000004768371582,"at":1982.9000000357628}] actualPaints=[{"phase":"start","at":1980.699999988079},{"phase":"end","at":1980.699999988079},{"phase":"start","at":1982.800000011921},{"phase":"end","at":1982.800000011921}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
```

reentry-type / M3 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"Zabcd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.20000004768371582,"at":1986.9000000357628},{"phase":"app-repaint-request","ms":0.5,"at":1989.6000000238419},{"phase":"app-repaint-request","ms":0.5,"at":1992.800000011921}] actualPaints=[{"phase":"start","at":1989.1000000238419},{"phase":"end","at":1989.300000011921},{"phase":"start","at":1992.4000000357628},{"phase":"end","at":1992.5}] rawLocalMarks=[]
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
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.09999996423721313,"at":1996.5},{"phase":"app-repaint-request","ms":0.10000002384185791,"at":1998.6000000238419},{"phase":"buffer-commit","ms":0,"at":1999},{"phase":"commit-and-projection","ms":0.09999996423721313,"at":1999},{"phase":"app-repaint-request","ms":0.40000003576278687,"at":1999.6000000238419},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2001.800000011921}] actualPaints=[{"phase":"start","at":1998.5},{"phase":"end","at":1998.5},{"phase":"start","at":1999.199999988079},{"phase":"end","at":1999.300000011921},{"phase":"start","at":2001.6000000238419},{"phase":"end","at":2001.6000000238419}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
```

reentry-type / M3 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZabQcd","identities":["b1","s1","s2","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZabQcd","selection":[4,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2006.6000000238419},{"phase":"buffer-commit","ms":0.09999996423721313,"at":2009.199999988079},{"phase":"commit-and-projection","ms":0.09999996423721313,"at":2009.199999988079},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":2009.699999988079},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2011.6000000238419}] actualPaints=[{"phase":"start","at":2009.300000011921},{"phase":"end","at":2009.4000000357628},{"phase":"start","at":2011.5},{"phase":"end","at":2011.5}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[2,2]}
```

reentry-replace / M1 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"Zabcd","selection":[2,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2017},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":2019},{"phase":"app-repaint-request","ms":0.5,"at":2023.4000000357628}] actualPaints=[{"phase":"start","at":2018.6000000238419},{"phase":"end","at":2018.699999988079},{"phase":"start","at":2022.9000000357628},{"phase":"end","at":2023}] rawLocalMarks=[]
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
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":2028.1000000238419},{"phase":"app-repaint-request","ms":0.10000002384185791,"at":2029.800000011921},{"phase":"buffer-commit","ms":0.09999996423721313,"at":2030.199999988079},{"phase":"commit-and-projection","ms":0.09999996423721313,"at":2030.199999988079},{"phase":"app-repaint-request","ms":0.2999999523162842,"at":2030.699999988079},{"phase":"app-repaint-request","ms":0.20000004768371582,"at":2033.4000000357628}] actualPaints=[{"phase":"start","at":2029.699999988079},{"phase":"end","at":2029.699999988079},{"phase":"start","at":2030.4000000357628},{"phase":"end","at":2030.4000000357628},{"phase":"start","at":2033.199999988079},{"phase":"end","at":2033.300000011921}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-replace / M1 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2038.1000000238419},{"phase":"buffer-commit","ms":0,"at":2040.699999988079},{"phase":"commit-and-projection","ms":0.10000002384185791,"at":2040.800000011921},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":2041.300000011921},{"phase":"app-repaint-request","ms":0.10000002384185791,"at":2043.800000011921}] actualPaints=[{"phase":"start","at":2040.9000000357628},{"phase":"end","at":2041},{"phase":"start","at":2043.699999988079},{"phase":"end","at":2043.699999988079}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-replace / M2 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"Zabcd","selection":[2,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2047.800000011921},{"phase":"app-repaint-request","ms":0.5,"at":2050.5},{"phase":"app-repaint-request","ms":0.40000003576278687,"at":2053.400000035763}] actualPaints=[{"phase":"start","at":2050},{"phase":"end","at":2050.100000023842},{"phase":"start","at":2053},{"phase":"end","at":2053.100000023842}] rawLocalMarks=[]
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
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2057.699999988079},{"phase":"app-repaint-request","ms":0.40000003576278687,"at":2059.900000035763}] actualPaints=[{"phase":"start","at":2059.699999988079},{"phase":"end","at":2059.699999988079}] rawLocalMarks=[]
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
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":2065.900000035763},{"phase":"buffer-commit","ms":0,"at":2068.800000011921},{"phase":"app-repaint-request","ms":0.40000003576278687,"at":2069.400000035763},{"phase":"app-repaint-request","ms":0.20000004768371582,"at":2071.400000035763}] actualPaints=[{"phase":"start","at":2069},{"phase":"end","at":2069.100000023842},{"phase":"start","at":2071.300000011921},{"phase":"end","at":2071.300000011921}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-replace / M3 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
stage 2: {"rows":[{"id":"R1","text":"Zabcd","identities":["b1","s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"Zabcd","selection":[2,4]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":["App changed DOM outside observed native target","App changed DOM outside observed native target"]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.09999996423721313,"at":2076},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":2078.699999988079},{"phase":"app-repaint-request","ms":0.5,"at":2082.100000023842}] actualPaints=[{"phase":"start","at":2078.300000011921},{"phase":"end","at":2078.300000011921},{"phase":"start","at":2081.699999988079},{"phase":"end","at":2081.800000011921}] rawLocalMarks=[]
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
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2087.600000023842},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2090.199999988079},{"phase":"buffer-commit","ms":0.19999998807907104,"at":2090.600000023842},{"phase":"commit-and-projection","ms":0.19999998807907104,"at":2090.600000023842},{"phase":"app-repaint-request","ms":0.30000001192092896,"at":2091},{"phase":"app-repaint-request","ms":0.10000002384185791,"at":2093.100000023842}] actualPaints=[{"phase":"start","at":2090},{"phase":"end","at":2090},{"phase":"start","at":2090.699999988079},{"phase":"end","at":2090.800000011921},{"phase":"start","at":2093.100000023842},{"phase":"end","at":2093.100000023842}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-replace / M3 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["onInput:syncBeatEl"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2097.800000011921},{"phase":"buffer-commit","ms":0.09999996423721313,"at":2100.699999988079},{"phase":"commit-and-projection","ms":0.19999998807907104,"at":2100.800000011921},{"phase":"app-repaint-request","ms":0.5,"at":2101.400000035763},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2104.300000011921}] actualPaints=[{"phase":"start","at":2100.900000035763},{"phase":"end","at":2101},{"phase":"start","at":2104.199999988079},{"phase":"end","at":2104.199999988079}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"after-app-beforeinput","defaultPrevented":false,"trusted":true,"inputType":"insertText"}
re-entry {"where":"after-app-beforeinput","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"after-app-beforeinput","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-paste / M1 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZQcd","identities":["b1","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZQcd","identities":["b1","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":2108.300000011921},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":2113.300000011921},{"phase":"buffer-commit","ms":0.10000002384185791,"at":2113.800000011921},{"phase":"commit-and-projection","ms":0.10000002384185791,"at":2113.800000011921},{"phase":"app-repaint-request","ms":0.5,"at":2114.300000011921},{"phase":"app-repaint-request","ms":0.2999999523162842,"at":2117.699999988079}] actualPaints=[{"phase":"start","at":2113},{"phase":"end","at":2113.100000023842},{"phase":"start","at":2113.800000011921},{"phase":"end","at":2113.900000035763},{"phase":"start","at":2114.400000035763},{"phase":"end","at":2114.400000035763},{"phase":"start","at":2117.5},{"phase":"end","at":2117.5}] rawLocalMarks=[{"name":"a1","marks":{}}]
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
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2121.800000011921},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2125.699999988079},{"phase":"buffer-commit","ms":0.10000002384185791,"at":2125.800000011921},{"phase":"commit-and-projection","ms":0.20000004768371582,"at":2125.900000035763},{"phase":"app-repaint-request","ms":0.5999999642372131,"at":2126.5},{"phase":"app-repaint-request","ms":0.30000001192092896,"at":2130.800000011921}] actualPaints=[{"phase":"start","at":2125.5},{"phase":"end","at":2125.5},{"phase":"start","at":2125.900000035763},{"phase":"end","at":2126},{"phase":"start","at":2126.800000011921},{"phase":"end","at":2126.800000011921},{"phase":"start","at":2130.699999988079},{"phase":"end","at":2130.699999988079}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-paste / M1 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.10000002384185791,"at":2146.900000035763},{"phase":"buffer-commit","ms":0,"at":2155.100000023842},{"phase":"commit-and-projection","ms":0.10000002384185791,"at":2155.100000023842},{"phase":"app-repaint-request","ms":0.5,"at":2155.699999988079},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2161}] actualPaints=[{"phase":"start","at":2155.199999988079},{"phase":"end","at":2155.199999988079},{"phase":"start","at":2156},{"phase":"end","at":2156},{"phase":"start","at":2160.800000011921},{"phase":"end","at":2160.900000035763}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-paste / M2 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZQcd","identities":["b1","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZQcd","identities":["b1","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2165.300000011921},{"phase":"app-repaint-request","ms":0.5,"at":2168.900000035763},{"phase":"buffer-commit","ms":0,"at":2169.100000023842},{"phase":"commit-and-projection","ms":0.09999996423721313,"at":2169.199999988079},{"phase":"app-repaint-request","ms":0.40000003576278687,"at":2169.600000023842},{"phase":"app-repaint-request","ms":0.09999996423721313,"at":2172.699999988079}] actualPaints=[{"phase":"start","at":2168.5},{"phase":"end","at":2168.5},{"phase":"start","at":2169.300000011921},{"phase":"end","at":2169.300000011921},{"phase":"start","at":2169.699999988079},{"phase":"end","at":2169.699999988079},{"phase":"start","at":2172.600000023842},{"phase":"end","at":2172.600000023842}] rawLocalMarks=[{"name":"a1","marks":{}}]
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
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.20000004768371582,"at":2176.400000035763},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":2179.5},{"phase":"buffer-commit","ms":0,"at":2179.5},{"phase":"app-repaint-request","ms":0.5,"at":2180.100000023842},{"phase":"app-repaint-request","ms":0.30000001192092896,"at":2183.800000011921}] actualPaints=[{"phase":"start","at":2179.100000023842},{"phase":"end","at":2179.199999988079},{"phase":"start","at":2179.600000023842},{"phase":"end","at":2179.600000023842},{"phase":"start","at":2180.199999988079},{"phase":"end","at":2180.300000011921},{"phase":"start","at":2183.600000023842},{"phase":"end","at":2183.600000023842}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":true,"dom":"Zabcd","selection":[1,3]}
```

reentry-paste / M2 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:stale-reentry"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:stale-reentry"],"errors":[]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.09999996423721313,"at":2187.5},{"phase":"buffer-commit","ms":0,"at":2190.5},{"phase":"app-repaint-request","ms":0.5,"at":2191.100000023842},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2194.5}] actualPaints=[{"phase":"start","at":2190.600000023842},{"phase":"end","at":2190.600000023842},{"phase":"start","at":2191.300000011921},{"phase":"end","at":2191.300000011921},{"phase":"start","at":2194.300000011921},{"phase":"end","at":2194.300000011921}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-paste / M3 / D3 / retainBeforeInput=false / nativePaintGate=false: FAIL

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZQcd","identities":["b1","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZQcd","identities":["b1","a1","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZQcd","selection":[2,2]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
peak={"bytes":0,"messages":0,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2198.300000011921},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":2201.800000011921},{"phase":"buffer-commit","ms":0.09999996423721313,"at":2202},{"phase":"commit-and-projection","ms":0.09999996423721313,"at":2202},{"phase":"app-repaint-request","ms":0.3999999761581421,"at":2202.5},{"phase":"app-repaint-request","ms":0.09999996423721313,"at":2205.699999988079}] actualPaints=[{"phase":"start","at":2201.400000035763},{"phase":"end","at":2201.400000035763},{"phase":"start","at":2202.100000023842},{"phase":"end","at":2202.100000023842},{"phase":"start","at":2202.600000023842},{"phase":"end","at":2202.699999988079},{"phase":"start","at":2205.699999988079},{"phase":"end","at":2205.699999988079}] rawLocalMarks=[{"name":"a1","marks":{}}]
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
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.30000001192092896,"at":2209.600000023842},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2212.699999988079},{"phase":"buffer-commit","ms":0.10000002384185791,"at":2212.900000035763},{"phase":"commit-and-projection","ms":0.10000002384185791,"at":2212.900000035763},{"phase":"app-repaint-request","ms":0.40000003576278687,"at":2213.400000035763},{"phase":"app-repaint-request","ms":0.2999999523162842,"at":2216.699999988079}] actualPaints=[{"phase":"start","at":2212.600000023842},{"phase":"end","at":2212.600000023842},{"phase":"start","at":2213},{"phase":"end","at":2213},{"phase":"start","at":2213.600000023842},{"phase":"end","at":2213.600000023842},{"phase":"start","at":2216.400000035763},{"phase":"end","at":2216.5}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```

reentry-paste / M3 / D3 / retainBeforeInput=true / nativePaintGate=true: PASS

```text
stage 0: {"rows":[{"id":"R1","text":"abcd","identities":["s1","s2","s3","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"s2","text":"b","beat":"R1","marks":{}},{"id":"s3","text":"c","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"abcd","selection":[1,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":[],"errors":[]}
stage 1: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
stage 2: {"rows":[{"id":"R1","text":"ZaQd","identities":["b1","s1","a1","s4"]},{"id":"R2","text":"ef","identities":["s5","s6"]}],"recovery":[],"localAndMarked":[{"id":"a1","text":"Q","beat":"R1","marks":{}}],"dom":[{"id":"R1","text":"ZaQd","selection":[3,3]},{"id":"R2","text":"ef","selection":null}],"dirty":false,"composing":false,"heldBytes":0,"heldMessages":0,"commits":["paste:command-override"],"errors":[]}
peak={"bytes":12,"messages":1,"transportMessages":1} timings=[{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2220.699999988079},{"phase":"buffer-commit","ms":0.09999996423721313,"at":2224},{"phase":"commit-and-projection","ms":0.19999998807907104,"at":2224.100000023842},{"phase":"app-repaint-request","ms":0.5,"at":2224.600000023842},{"phase":"app-repaint-request","ms":0.19999998807907104,"at":2228.5}] actualPaints=[{"phase":"start","at":2224.100000023842},{"phase":"end","at":2224.199999988079},{"phase":"start","at":2224.800000011921},{"phase":"end","at":2224.800000011921},{"phase":"start","at":2228.400000035763},{"phase":"end","at":2228.5}] rawLocalMarks=[{"name":"a1","marks":{}}]
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"before-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
re-entry {"where":"inside-flow-writer-commit-after-paste-range-captured","phase":"after-delivery","dirty":true,"dom":"abcd","selection":[1,3]}
```
