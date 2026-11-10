Replacing the beat DOM interrupts the active composition; restoring selection does not restore its replacement range.

Observed in Edg/157.0.4341.42. Reproduce with `npm run slice` under the smoke lock.

whole repaint during composition

```text
stage 0: text="the xthe" selection=[5,5]
compositionstart data="" ranges=[] cancelable=true cancelled=false
compositionupdate data="x" ranges=[] cancelable=true cancelled=false
beforeinput(insertCompositionText) data="x" ranges=[[4,4]] cancelable=false cancelled=false
input(insertCompositionText) data="x" ranges=[] cancelable=false cancelled=false
stage 1: text="the xthe" selection=[0,0]
stage 2: text="xythe xthe" selection=[2,2]
compositionstart data="" ranges=[] cancelable=true cancelled=false
compositionupdate data="xy" ranges=[] cancelable=true cancelled=false
beforeinput(insertCompositionText) data="xy" ranges=[[0,0]] cancelable=false cancelled=false
input(insertCompositionText) data="xy" ranges=[] cancelable=false cancelled=false
compositionupdate data="xy" ranges=[] cancelable=true cancelled=false
beforeinput(insertCompositionText) data="xy" ranges=[[0,2]] cancelable=false cancelled=false
input(insertCompositionText) data="xy" ranges=[] cancelable=false cancelled=false
compositionend data="xy" ranges=[] cancelable=true cancelled=false
```

whole repaint during composition with selection restoration

```text
stage 0: text="the xthe" selection=[5,5]
compositionstart data="" ranges=[] cancelable=true cancelled=false
compositionupdate data="x" ranges=[] cancelable=true cancelled=false
beforeinput(insertCompositionText) data="x" ranges=[[4,4]] cancelable=false cancelled=false
input(insertCompositionText) data="x" ranges=[] cancelable=false cancelled=false
stage 1: text="the xthe" selection=[5,5]
stage 2: text="the xxythe" selection=[7,7]
compositionstart data="" ranges=[] cancelable=true cancelled=false
compositionupdate data="xy" ranges=[] cancelable=true cancelled=false
beforeinput(insertCompositionText) data="xy" ranges=[[5,5]] cancelable=false cancelled=false
input(insertCompositionText) data="xy" ranges=[] cancelable=false cancelled=false
compositionupdate data="xy" ranges=[] cancelable=true cancelled=false
beforeinput(insertCompositionText) data="xy" ranges=[[5,7]] cancelable=false cancelled=false
input(insertCompositionText) data="xy" ranges=[] cancelable=false cancelled=false
compositionend data="xy" ranges=[] cancelable=true cancelled=false
```
