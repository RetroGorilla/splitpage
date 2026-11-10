The real Writer's unbound whole-beat composition sync overwrites Bob's insertion and restores his deletion.

App: f807ca39dcc5feb03f5746209cb806ee66dab3f8 on proto/collab-1a-app-binding-throwaway; browser Edg/157.0.4341.42.

Reproduce: the app-binding runner under the smoke lock. The literal expected results are unchanged.

unbound whole-beat reconciliation overwrites remote

```text
stage 0: DOM="abxcd" selection=[3,3] bufferDirty=false bufferComposition=false undoHold=0
session=[["R1","abcd"],["R2","ef"]]
commits=[]
compositionstart DOM="abcd" nativeComposition=false
input(insertCompositionText) DOM="abxcd" nativeComposition=true
stage 1: DOM="abxcd" selection=[3,3] bufferDirty=false bufferComposition=false undoHold=0
session=[["R1","Zabc"],["R2","ef"]]
commits=[]
stage 2: DOM="abxycd" selection=[4,4] bufferDirty=false bufferComposition=false undoHold=0
session=[["R1","abxycd"],["R2","ef"]]
commits=[]
input(insertCompositionText) DOM="abxycd" nativeComposition=true
input(insertCompositionText) DOM="abxycd" nativeComposition=true
compositionend DOM="abxycd" nativeComposition=false
```
