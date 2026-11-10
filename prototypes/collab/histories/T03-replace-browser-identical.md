PASS: replacing selected repeated text with identical text commits new identities under M1/M2/M3; undo selects the restored word.

Observed in Edg/157.0.4341.42. Reproduce with `npm run slice` under the smoke lock.

T03 replace identical text M1

```text
stage 0: text="the the" selection=[7,7]
beforeinput(insertText) data="the" ranges=[[4,7]] cancelable=true cancelled=false
input(insertText) data="the" ranges=[] cancelable=false cancelled=false
settled dirty=false commits=["input"]
R1 identities=s1 s2 s3 s4 a1 a2 a3
A commit active insert-first delete [s5 s6 s7] insert "the" [a1 a2 a3]
stage 1: text="the the" selection=[4,7]
beforeinput(historyUndo) data=null ranges=[[7,7]] cancelable=true cancelled=true
settled dirty=false commits=["input","beforeinput:historyUndo"]
R1 identities=s1 s2 s3 s4 s5* s6* s7*
A commit active insert-first delete [s5 s6 s7] insert "the" [a1 a2 a3]
A undo local action and reanchor selection to restored identities
```

T03 replace identical text M2

```text
stage 0: text="the the" selection=[7,7]
beforeinput(insertText) data="the" ranges=[[4,7]] cancelable=true cancelled=false
input(insertText) data="the" ranges=[] cancelable=false cancelled=false
settled dirty=false commits=["input"]
R1 identities=s1 s2 s3 s4 a1 a2 a3
A commit active insert-first delete [s5 s6 s7] insert "the" [a1 a2 a3]
stage 1: text="the the" selection=[4,7]
beforeinput(historyUndo) data=null ranges=[[7,7]] cancelable=true cancelled=true
settled dirty=false commits=["input","beforeinput:historyUndo"]
R1 identities=s1 s2 s3 s4 s5* s6* s7*
A commit active insert-first delete [s5 s6 s7] insert "the" [a1 a2 a3]
A undo local action and reanchor selection to restored identities
```

T03 replace identical text M3

```text
stage 0: text="the the" selection=[7,7]
beforeinput(insertText) data="the" ranges=[[4,7]] cancelable=true cancelled=false
input(insertText) data="the" ranges=[] cancelable=false cancelled=false
settled dirty=false commits=["input"]
R1 identities=s1 s2 s3 s4 a1 a2 a3
A commit active insert-first delete [s5 s6 s7] insert "the" [a1 a2 a3]
stage 1: text="the the" selection=[4,7]
beforeinput(historyUndo) data=null ranges=[[7,7]] cancelable=true cancelled=true
settled dirty=false commits=["input","beforeinput:historyUndo"]
R1 identities=s1 s2 s3 s4 s5* s6* s7*
A commit active insert-first delete [s5 s6 s7] insert "the" [a1 a2 a3]
A undo local action and reanchor selection to restored identities
```
