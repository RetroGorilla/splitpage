Native undo reports the current caret, not the identities it reverses; a beforeinput range alone is insufficient.

Observed in Edg/157.0.4341.42. On repeated text, insert a at offset 7, then Ctrl+Z.

```text
beforeinput(historyUndo) text="the thea" ranges=[[8,8]] selection=[8,8]
input(historyUndo) text="the the" ranges=[] selection=[7,7]
```

The binding cancels historyUndo and uses its selective operation history in all main trace undo checks.
