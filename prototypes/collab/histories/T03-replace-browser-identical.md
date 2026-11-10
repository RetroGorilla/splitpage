Replacing selected repeated text with identical text supplies an exact target, but the minimal-string-splice contract cannot represent it.

Observed in Edg/157.0.4341.42. Reproduce with `npm run slice` under the smoke lock.

T03 replace identical text M1

```text
stage 0: text="the the" selection=[7,7]
beforeinput(insertText) data="the" ranges=[[4,7]] cancelable=true cancelled=false
input(insertText) data="the" ranges=[] cancelable=false cancelled=false
STOP: Ambiguous native diff: 0 minimal splices; target evidence present
```

T03 replace identical text M2

```text
stage 0: text="the the" selection=[7,7]
beforeinput(insertText) data="the" ranges=[[4,7]] cancelable=true cancelled=false
input(insertText) data="the" ranges=[] cancelable=false cancelled=false
STOP: Ambiguous native diff: 0 minimal splices; target evidence present
```

T03 replace identical text M3

```text
stage 0: text="the the" selection=[7,7]
beforeinput(insertText) data="the" ranges=[[4,7]] cancelable=true cancelled=false
input(insertText) data="the" ranges=[] cancelable=false cancelled=false
STOP: Ambiguous native diff: 0 minimal splices; target evidence present
```
