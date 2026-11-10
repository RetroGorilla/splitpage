The experimental selective-undo route bypasses the standalone owner's hold under every mechanism.

App: f807ca39dcc5feb03f5746209cb806ee66dab3f8 on proto/collab-1a-app-binding-throwaway; browser Edg/157.0.4341.42.

Reproduce: the app-binding runner under the smoke lock. The literal expected results are unchanged.

standalone undo hold bypass M1

```text
stage 0: DOM="the an" selection=[5,5] bufferDirty=false bufferComposition=false undoHold=1
session=[["R1","the an"]]
commits=["onInput:syncBeatEl"]
input(insertText) DOM="the a" nativeComposition=false
stage 1: DOM="the then" selection=[4,7] bufferDirty=false bufferComposition=false undoHold=1
session=[["R1","the then"]]
commits=["onInput:syncBeatEl","writer:selectiveUndo"]
```

standalone undo hold bypass M2

```text
stage 0: DOM="the an" selection=[5,5] bufferDirty=false bufferComposition=false undoHold=1
session=[["R1","the an"]]
commits=["onInput:syncBeatEl"]
input(insertText) DOM="the a" nativeComposition=false
stage 1: DOM="the then" selection=[4,7] bufferDirty=false bufferComposition=false undoHold=1
session=[["R1","the then"]]
commits=["onInput:syncBeatEl","writer:selectiveUndo"]
```

standalone undo hold bypass M3

```text
stage 0: DOM="the an" selection=[5,5] bufferDirty=false bufferComposition=false undoHold=1
session=[["R1","the an"]]
commits=["onInput:syncBeatEl"]
input(insertText) DOM="the a" nativeComposition=false
stage 1: DOM="the then" selection=[4,7] bufferDirty=false bufferComposition=false undoHold=1
session=[["R1","the then"]]
commits=["onInput:syncBeatEl","writer:selectiveUndo"]
```
