Removing the real Writer sync hook is detected; a later driver commit cannot endorse this run.

App: f807ca39dcc5feb03f5746209cb806ee66dab3f8 on proto/collab-1a-app-binding-throwaway; browser Edg/157.0.4341.42.

Reproduce: the app-binding runner under the smoke lock. The literal expected results are unchanged.

sync hook removed

```text
stage 0: DOM="the a" selection=[5,5] bufferDirty=true bufferComposition=false undoHold=0
session=[["R1","the a"]]
commits=[]
STOP: App whole-field command bypassed replica binding
input(insertText) DOM="the a" nativeComposition=false
```
