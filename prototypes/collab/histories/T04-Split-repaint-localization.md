Shows browser-observed native-write/focusout nesting: the prototype bubble handler causes the second render; app blur cleanup is harmless in the standalone and guarded controls.

Diagnostic builds are unminified with observational call probes/native Node wrappers. Handler source is read from the running browser's listener. Node suffixes are WeakMap identities, so equal targets mean the same Node object. Paths are redacted; frame line/column numbers are retained. Normal minified replay controls are in evidence.json.

binding/T04; source c67139b8806d04231d2f2c5bb89814370bab8ef6; source tree 6de8ffb655129b7d6d5844ba6153d730795da5d5; FAIL

```text
order: [["syncShown",0],["render",0],["commitRows",0],["commitRowPatch",0],["commitRowPatch",0],["syncShown",0],["syncShown",0],["syncShown",0],["binding.paint",0],["render",0],["commitRows",0],["commitRowPatch",0],["replaceChild:enter",0],["focusout:capture",1],["focusout-handler:enter",1],["focusout-handler:exit",1],["focusout-handler:enter",1],["editorBlur",1],["leftEditable",1],["focusout-handler:exit",1],["focusout-handler:enter",1],["binding.paint",1],["render",1],["commitRows",1],["commitRowPatch",1],["replaceChild:enter",1],["replaceChild:exit",1],["commitRowPatch",1],["focusout-handler:exit",1],["replaceChild:throw",1],["replaceChild:exit",0]]
replaceChild:enter depth=0 {"parent":"div.cell audio-cell[]@1","old":"div.field-wrap[]@2","fresh":"div.field-wrap[]@3"}
Error: replaceChild:enter
    at log (<anonymous>:9:51)
    at Node.replaceChild (<anonymous>:45:5)
    at <local>:42626:26
    at Array.forEach (<anonymous>)
    at commitRowPatch (<local>:42623:17)
    at <local>:42753:24
    at Array.map (<anonymous>)
    at commitRows (<local>:42752:30)
    at <local>:42886:7
    at withRowMotion (<local>:42345:5)
    at paintAll (<local>:42885:5)
    at <local>:42844:11
    at Object.whilePainting (<local>:21106:23)
    at render (<local>:42842:30)
    at Object.render (<local>:64089:23)
    at Object.repaint (split-binding.js:10406:26)
    at paint (split-binding.js:10483:12)
    at split-binding.js:10581:89
    at guarded (split-binding.js:10533:7)
    at HTMLDivElement.<anonymous> (split-binding.js:10580:44)
replaceChild:enter depth=1 {"parent":"div.cell audio-cell[]@1","old":"div.field-wrap[]@2","fresh":"div.field-wrap[]@5"}
Error: replaceChild:enter
    at log (<anonymous>:9:51)
    at Node.replaceChild (<anonymous>:45:5)
    at <local>:42626:26
    at Array.forEach (<anonymous>)
    at commitRowPatch (<local>:42623:17)
    at <local>:42753:24
    at Array.map (<anonymous>)
    at commitRows (<local>:42752:30)
    at <local>:42886:7
    at withRowMotion (<local>:42345:5)
    at paintAll (<local>:42885:5)
    at <local>:42844:11
    at Object.whilePainting (<local>:21106:23)
    at render (<local>:42842:30)
    at Object.render (<local>:64089:23)
    at Object.repaint (split-binding.js:10406:26)
    at paint (split-binding.js:10483:12)
    at split-binding.js:10581:89
    at guarded (split-binding.js:10533:7)
    at HTMLDivElement.<anonymous> (split-binding.js:10580:44)
    at HTMLDivElement.wrapped (<anonymous>:22:18)
    at Node.replaceChild (<anonymous>:48:22)
    at <local>:42626:26
    at Array.forEach (<anonymous>)
    at commitRowPatch (<local>:42623:17)
    at <local>:42753:24
    at Array.map (<anonymous>)
    at commitRows (<local>:42752:30)
    at <local>:42886:7
    at withRowMotion (<local>:42345:5)
    at paintAll (<local>:42885:5)
    at <local>:42844:11
    at Object.whilePainting (<local>:21106:23)
    at render (<local>:42842:30)
    at Object.render (<local>:64089:23)
    at Object.repaint (split-binding.js:10406:26)
    at paint (split-binding.js:10483:12)
    at split-binding.js:10581:89
    at guarded (split-binding.js:10533:7)
    at HTMLDivElement.<anonymous> (split-binding.js:10580:44)
runtime prototype listener: {"phase":3,"source":"(event) => guarded(() => {\n      if (bound && repaintOwed && !session().alice.dirty && !session().alice.composing) paint();\n      events.push({ phase: \"bubble\", ...capture(event) });\n      if (bound && bridge.model().generation !== generationAtReset) throw new Error(\"App whole-field command bypassed replica binding\");\n    })"}
runtime app cleanup stack:
Error: leftEditable
    at log (<anonymous>:9:51)
    at traceRealm.__splitCall (<anonymous>:12:5)
    at Object.leftEditable (<local>:64479:31)
    at HTMLDivElement.<anonymous> (<local>:53601:15)
    at HTMLDivElement.wrapped (<anonymous>:22:18)
    at Node.replaceChild (<anonymous>:48:22)
    at <local>:42626:26
    at Array.forEach (<anonymous>)
    at commitRowPatch (<local>:42623:17)
    at <local>:42753:24
    at Array.map (<anonymous>)
    at commitRows (<local>:42752:30)
    at <local>:42886:7
    at withRowMotion (<local>:42345:5)
    at paintAll (<local>:42885:5)
    at <local>:42844:11
    at Object.whilePainting (<local>:21106:23)
    at render (<local>:42842:30)
    at Object.render (<local>:64089:23)
    at Object.repaint (split-binding.js:10406:26)
    at paint (split-binding.js:10483:12)
    at split-binding.js:10581:89
    at guarded (split-binding.js:10533:7)
    at HTMLDivElement.<anonymous> (split-binding.js:10580:44)
nested render calls: 1
nested app sync/blurredCell: 0
```

binding/T04 removed; source c67139b8806d04231d2f2c5bb89814370bab8ef6; source tree 6de8ffb655129b7d6d5844ba6153d730795da5d5; FAIL

```text
order: [["syncShown",0],["render",0],["commitRows",0],["commitRowPatch",0],["commitRowPatch",0],["syncShown",0],["syncShown",0],["syncShown",0],["binding.paint",0],["render",0],["commitRows",0],["removeChild:enter",0],["focusout:capture",1],["focusout-handler:enter",1],["focusout-handler:exit",1],["focusout-handler:enter",1],["editorBlur",1],["leftEditable",1],["focusout-handler:exit",1],["focusout-handler:enter",1],["binding.paint",1],["render",1],["commitRows",1],["removeChild:enter",1],["removeChild:exit",1],["commitRowPatch",1],["focusout-handler:exit",1],["removeChild:throw",1],["removeChild:exit",0]]
removeChild:enter depth=0 {"parent":"div#rows.[]@1","old":"div.row[R1]@2"}
Error: removeChild:enter
    at log (<anonymous>:9:51)
    at Node.removeChild (<anonymous>:60:5)
    at <local>:42750:45
    at Array.forEach (<anonymous>)
    at commitRows (<local>:42749:15)
    at <local>:42886:7
    at withRowMotion (<local>:42345:5)
    at paintAll (<local>:42885:5)
    at <local>:42844:11
    at Object.whilePainting (<local>:21106:23)
    at render (<local>:42842:30)
    at Object.render (<local>:64089:23)
    at Object.repaint (split-binding.js:10406:26)
    at paint (split-binding.js:10483:12)
    at split-binding.js:10581:89
    at guarded (split-binding.js:10533:7)
    at HTMLDivElement.<anonymous> (split-binding.js:10580:44)
removeChild:enter depth=1 {"parent":"div#rows.[]@1","old":"div.row[R1]@2"}
Error: removeChild:enter
    at log (<anonymous>:9:51)
    at Node.removeChild (<anonymous>:60:5)
    at <local>:42750:45
    at Array.forEach (<anonymous>)
    at commitRows (<local>:42749:15)
    at <local>:42886:7
    at withRowMotion (<local>:42345:5)
    at paintAll (<local>:42885:5)
    at <local>:42844:11
    at Object.whilePainting (<local>:21106:23)
    at render (<local>:42842:30)
    at Object.render (<local>:64089:23)
    at Object.repaint (split-binding.js:10406:26)
    at paint (split-binding.js:10483:12)
    at split-binding.js:10581:89
    at guarded (split-binding.js:10533:7)
    at HTMLDivElement.<anonymous> (split-binding.js:10580:44)
    at HTMLDivElement.wrapped (<anonymous>:22:18)
    at Node.removeChild (<anonymous>:63:21)
    at <local>:42750:45
    at Array.forEach (<anonymous>)
    at commitRows (<local>:42749:15)
    at <local>:42886:7
    at withRowMotion (<local>:42345:5)
    at paintAll (<local>:42885:5)
    at <local>:42844:11
    at Object.whilePainting (<local>:21106:23)
    at render (<local>:42842:30)
    at Object.render (<local>:64089:23)
    at Object.repaint (split-binding.js:10406:26)
    at paint (split-binding.js:10483:12)
    at split-binding.js:10581:89
    at guarded (split-binding.js:10533:7)
    at HTMLDivElement.<anonymous> (split-binding.js:10580:44)
runtime prototype listener: {"phase":3,"source":"(event) => guarded(() => {\n      if (bound && repaintOwed && !session().alice.dirty && !session().alice.composing) paint();\n      events.push({ phase: \"bubble\", ...capture(event) });\n      if (bound && bridge.model().generation !== generationAtReset) throw new Error(\"App whole-field command bypassed replica binding\");\n    })"}
runtime app cleanup stack:
Error: leftEditable
    at log (<anonymous>:9:51)
    at traceRealm.__splitCall (<anonymous>:12:5)
    at Object.leftEditable (<local>:64479:31)
    at HTMLDivElement.<anonymous> (<local>:53601:15)
    at HTMLDivElement.wrapped (<anonymous>:22:18)
    at Node.removeChild (<anonymous>:63:21)
    at <local>:42750:45
    at Array.forEach (<anonymous>)
    at commitRows (<local>:42749:15)
    at <local>:42886:7
    at withRowMotion (<local>:42345:5)
    at paintAll (<local>:42885:5)
    at <local>:42844:11
    at Object.whilePainting (<local>:21106:23)
    at render (<local>:42842:30)
    at Object.render (<local>:64089:23)
    at Object.repaint (split-binding.js:10406:26)
    at paint (split-binding.js:10483:12)
    at split-binding.js:10581:89
    at guarded (split-binding.js:10533:7)
    at HTMLDivElement.<anonymous> (split-binding.js:10580:44)
nested render calls: 1
nested app sync/blurredCell: 0
```

guarded/T04; source 224b60c580dd03d2541f4edd58a9324b07ff389c; source tree 6de8ffb655129b7d6d5844ba6153d730795da5d5; completed

```text
order: [["syncShown",0],["render",0],["commitRows",0],["commitRowPatch",0],["commitRowPatch",0],["syncShown",0],["syncShown",0],["syncShown",0],["binding.paint",0],["render",0],["commitRows",0],["commitRowPatch",0],["replaceChild:enter",0],["focusout:capture",1],["focusout-handler:enter",1],["focusout-handler:exit",1],["focusout-handler:enter",1],["editorBlur",1],["leftEditable",1],["focusout-handler:exit",1],["focusout-handler:enter",1],["binding.paint",1],["focusout-handler:exit",1],["focusout:window-bubble",1],["replaceChild:exit",0],["commitRowPatch",0],["binding.paint",0],["render",0],["commitRows",0],["commitRowPatch",0],["commitRowPatch",0]]
replaceChild:enter depth=0 {"parent":"div.cell audio-cell[]@1","old":"div.field-wrap[]@2","fresh":"div.field-wrap[]@3"}
Error: replaceChild:enter
    at log (<anonymous>:9:51)
    at Node.replaceChild (<anonymous>:45:5)
    at <local>:42626:26
    at Array.forEach (<anonymous>)
    at commitRowPatch (<local>:42623:17)
    at <local>:42753:24
    at Array.map (<anonymous>)
    at commitRows (<local>:42752:30)
    at <local>:42886:7
    at withRowMotion (<local>:42345:5)
    at paintAll (<local>:42885:5)
    at <local>:42844:11
    at Object.whilePainting (<local>:21106:23)
    at render (<local>:42842:30)
    at Object.render (<local>:64089:23)
    at Object.repaint (split-binding.js:10406:26)
    at paint (split-binding.js:10492:14)
    at split-binding.js:10593:89
    at guarded (split-binding.js:10545:7)
    at HTMLDivElement.<anonymous> (split-binding.js:10592:44)
runtime prototype listener: {"phase":3,"source":"(event) => guarded(() => {\n      if (bound && repaintOwed && !session().alice.dirty && !session().alice.composing) paint();\n      events.push({ phase: \"bubble\", ...capture(event) });\n      if (bound && bridge.model().generation !== generationAtReset) throw new Error(\"App whole-field command bypassed replica binding\");\n    })"}
runtime app cleanup stack:
Error: leftEditable
    at log (<anonymous>:9:51)
    at traceRealm.__splitCall (<anonymous>:12:5)
    at Object.leftEditable (<local>:64479:31)
    at HTMLDivElement.<anonymous> (<local>:53601:15)
    at HTMLDivElement.wrapped (<anonymous>:22:18)
    at Node.replaceChild (<anonymous>:48:22)
    at <local>:42626:26
    at Array.forEach (<anonymous>)
    at commitRowPatch (<local>:42623:17)
    at <local>:42753:24
    at Array.map (<anonymous>)
    at commitRows (<local>:42752:30)
    at <local>:42886:7
    at withRowMotion (<local>:42345:5)
    at paintAll (<local>:42885:5)
    at <local>:42844:11
    at Object.whilePainting (<local>:21106:23)
    at render (<local>:42842:30)
    at Object.render (<local>:64089:23)
    at Object.repaint (split-binding.js:10406:26)
    at paint (split-binding.js:10492:14)
    at split-binding.js:10593:89
    at guarded (split-binding.js:10545:7)
    at HTMLDivElement.<anonymous> (split-binding.js:10592:44)
nested render calls: 0
nested app sync/blurredCell: 0
```

guarded/T04 removed; source 224b60c580dd03d2541f4edd58a9324b07ff389c; source tree 6de8ffb655129b7d6d5844ba6153d730795da5d5; completed

```text
order: [["syncShown",0],["render",0],["commitRows",0],["commitRowPatch",0],["commitRowPatch",0],["syncShown",0],["syncShown",0],["syncShown",0],["binding.paint",0],["render",0],["commitRows",0],["removeChild:enter",0],["focusout:capture",1],["focusout-handler:enter",1],["focusout-handler:exit",1],["focusout-handler:enter",1],["editorBlur",1],["leftEditable",1],["focusout-handler:exit",1],["focusout-handler:enter",1],["binding.paint",1],["focusout-handler:exit",1],["focusout:window-bubble",1],["removeChild:exit",0],["commitRowPatch",0],["binding.paint",0],["render",0],["commitRows",0],["commitRowPatch",0]]
removeChild:enter depth=0 {"parent":"div#rows.[]@1","old":"div.row[R1]@2"}
Error: removeChild:enter
    at log (<anonymous>:9:51)
    at Node.removeChild (<anonymous>:60:5)
    at <local>:42750:45
    at Array.forEach (<anonymous>)
    at commitRows (<local>:42749:15)
    at <local>:42886:7
    at withRowMotion (<local>:42345:5)
    at paintAll (<local>:42885:5)
    at <local>:42844:11
    at Object.whilePainting (<local>:21106:23)
    at render (<local>:42842:30)
    at Object.render (<local>:64089:23)
    at Object.repaint (split-binding.js:10406:26)
    at paint (split-binding.js:10492:14)
    at split-binding.js:10593:89
    at guarded (split-binding.js:10545:7)
    at HTMLDivElement.<anonymous> (split-binding.js:10592:44)
runtime prototype listener: {"phase":3,"source":"(event) => guarded(() => {\n      if (bound && repaintOwed && !session().alice.dirty && !session().alice.composing) paint();\n      events.push({ phase: \"bubble\", ...capture(event) });\n      if (bound && bridge.model().generation !== generationAtReset) throw new Error(\"App whole-field command bypassed replica binding\");\n    })"}
runtime app cleanup stack:
Error: leftEditable
    at log (<anonymous>:9:51)
    at traceRealm.__splitCall (<anonymous>:12:5)
    at Object.leftEditable (<local>:64479:31)
    at HTMLDivElement.<anonymous> (<local>:53601:15)
    at HTMLDivElement.wrapped (<anonymous>:22:18)
    at Node.removeChild (<anonymous>:63:21)
    at <local>:42750:45
    at Array.forEach (<anonymous>)
    at commitRows (<local>:42749:15)
    at <local>:42886:7
    at withRowMotion (<local>:42345:5)
    at paintAll (<local>:42885:5)
    at <local>:42844:11
    at Object.whilePainting (<local>:21106:23)
    at render (<local>:42842:30)
    at Object.render (<local>:64089:23)
    at Object.repaint (split-binding.js:10406:26)
    at paint (split-binding.js:10492:14)
    at split-binding.js:10593:89
    at guarded (split-binding.js:10545:7)
    at HTMLDivElement.<anonymous> (split-binding.js:10592:44)
nested render calls: 0
nested app sync/blurredCell: 0
```

standalone/composition-and-blur; source efcd94c21a12585d232e9012a603b92031ce0b21; source tree c7ac90370f24a969a4ca86ac1567e2d9fa34ddb6; completed

```text
order: [["syncShown",0],["render",0],["commitRows",0],["commitRowPatch",0],["replaceChild:enter",0],["replaceChild:exit",0],["commitRowPatch",0],["syncShown",0],["syncShown",0],["render",0],["commitRows",0],["commitRowPatch",0],["commitRowPatch",0],["focusout:capture",0],["focusout-handler:enter",0],["editorBlur",0],["leftEditable",0],["blurredCell",0],["syncShown",0],["focusout-handler:exit",0],["focusout:window-bubble",0]]
nested render calls: 0
nested app sync/blurredCell: 0
```

standalone/delete-focused-row; source efcd94c21a12585d232e9012a603b92031ce0b21; source tree c7ac90370f24a969a4ca86ac1567e2d9fa34ddb6; completed

```text
order: [["syncShown",0],["syncShown",0],["syncShown",0],["syncShown",0],["render",0],["commitRows",0],["removeChild:enter",0],["removeChild:exit",0],["removeChild:enter",0],["focusout:capture",1],["focusout-handler:enter",1],["editorBlur",1],["leftEditable",1],["focusout-handler:exit",1],["focusout:window-bubble",1],["removeChild:exit",0],["commitRowPatch",0],["replaceChild:enter",0],["replaceChild:exit",0]]
removeChild:enter depth=0 {"parent":"div#rows.[]@1","old":"header.section-header[]@2"}
Error: removeChild:enter
    at log (<anonymous>:9:51)
    at Node.removeChild (<anonymous>:60:5)
    at <local>:42716:45
    at Array.forEach (<anonymous>)
    at commitRows (<local>:42715:15)
    at <local>:42852:7
    at withRowMotion (<local>:42311:5)
    at paintAll (<local>:42851:5)
    at <local>:42810:11
    at Object.whilePainting (<local>:21082:23)
    at render (<local>:42808:30)
    at Object.paintSessionChange [as listener] (<local>:43050:7)
    at <local>:18248:29
    at <local>:15768:11
    at attempt (<local>:15565:7)
    at <local>:15767:9
    at Array.forEach (<anonymous>)
    at publish (<local>:15766:26)
    at commit (<local>:15788:7)
    at transact (<local>:15918:21)
    at Object.run (<local>:15862:14)
    at Object.run (<local>:18364:39)
    at Object.runCommand [as run] (<local>:18462:20)
    at runRowCommand (<local>:50514:35)
    at deleteRow (<local>:50633:5)
    at Object.armDelete (<local>:50657:7)
    at Object.armDelete2 [as armDelete] (<local>:50755:20)
    at Object.menuClick (<local>:54278:19)
    at <local>:64114:27
    at Object.handle (<local>:53310:26)
    at Object.onRootClick [as click] (<local>:63792:16)
    at HTMLDivElement.onClick3 (<local>:54041:26)
    at <anonymous>:1:106
runtime app cleanup stack:
Error: leftEditable
    at log (<anonymous>:9:51)
    at traceRealm.__splitCall (<anonymous>:12:5)
    at Object.leftEditable (<local>:64285:31)
    at HTMLDivElement.<anonymous> (<local>:53565:15)
    at HTMLDivElement.wrapped (<anonymous>:22:18)
    at Node.removeChild (<anonymous>:63:21)
    at <local>:42716:45
    at Array.forEach (<anonymous>)
    at commitRows (<local>:42715:15)
    at <local>:42852:7
    at withRowMotion (<local>:42311:5)
    at paintAll (<local>:42851:5)
    at <local>:42810:11
    at Object.whilePainting (<local>:21082:23)
    at render (<local>:42808:30)
    at Object.paintSessionChange [as listener] (<local>:43050:7)
    at <local>:18248:29
    at <local>:15768:11
    at attempt (<local>:15565:7)
    at <local>:15767:9
    at Array.forEach (<anonymous>)
    at publish (<local>:15766:26)
    at commit (<local>:15788:7)
    at transact (<local>:15918:21)
    at Object.run (<local>:15862:14)
    at Object.run (<local>:18364:39)
    at Object.runCommand [as run] (<local>:18462:20)
    at runRowCommand (<local>:50514:35)
    at deleteRow (<local>:50633:5)
    at Object.armDelete (<local>:50657:7)
    at Object.armDelete2 [as armDelete] (<local>:50755:20)
    at Object.menuClick (<local>:54278:19)
    at <local>:64114:27
    at Object.handle (<local>:53310:26)
    at Object.onRootClick [as click] (<local>:63792:16)
    at HTMLDivElement.onClick3 (<local>:54041:26)
    at <anonymous>:1:106
nested render calls: 0
nested app sync/blurredCell: 0
```
