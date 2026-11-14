# Split binding composition, C7 first part

`sharedSplitBindings(effects)` supplies the existing switch's `SharedBindings`
port. It mounts `mountSharedSplitBuffer` on entry, before hydration as the switch
requires, and disposes it on leave. A refused finish returns its named reason.
A refused dispose leaves the binding and shared ports in place. Re-entering the
same parts after that refusal does not mount twice. Failed entry releases the
binding and restores the kept standalone document and cold handlers. The switch
itself is unchanged.

The composed entry supplies
`commandRefused: sharedCommandRefusalNotice(notices)` through the hook cut's
named switch port. That reports commands without a shared form once and marks
their outcome `notified`; the buffer report port respects that marker.

Shared entry selects ports that bypass `typeAtMarks` for Split cells (D16), skip
the old whole-field input/blur synchronization, and keep Split composition away
from standalone undo. The ordinary UI refresh after input remains. Render undo
tracking uses the common guard from the merged Writer cut, and the switch owns
its undo route's lifetime. C7 adds no read to the cold call path. An unused
adapter constructs no buffer and reads no shared text.

The rows input, keydown and drop handlers and the clipboard copy/cut and paste
handlers return when another handler has prevented the event (D17). The native
buffer reports through `sharedCommandReport`, including its existing `notified`
contract. R5's native formatting/history limits and currently unavailable Split
clipboard commands remain; a blocked paste, cut or drop during composition now
reaches no standalone clipboard work and gives one warning. This first part
does not supply their command builders.

## Evidence and event sources

`src/test/shared-split-app.test.mjs` boots the application, enters through the
real switch and adapter, exchanges encoded updates with a second real handle,
and compares complete projected documents with an encoded late joiner through
the agreement checker. Hand-written rows pin text, marks and column ownership.
The literals cover keyboard undo/redo, idle repeated-character carets in both
columns, typing at a direction's closing edge, compositions holding a remote
update, refused finish/dispose, re-entry, entry rollback and cold typing,
formatting, render tracking and composition after leave.

The ordinary typing helper uses the native sequence recorded in
[the Split caret record](stage-2-split-caret.md#trailing-space-native-edge-recording):
keydown, keypress, beforeinput, DOM change, input and keyup. A terminal native
space is U+00A0 in the DOM and U+0020 in the shared document. A handled Ctrl+Z or
Ctrl+Y stops at keydown, followed by keyup. IME follows the native Edge sequence
pinned by [suite 289](../../.claude/skills/run-splitpage-app/tests/289-script-cell-ime.txt):
compositionstart, compositionupdate, beforeinput and input with
`insertCompositionText`/`isComposing`, then the final update/input and
compositionend. No artificial Process key or post-composition input is added.

The six D17 handler cases are port-contract tests. In particular, the input
guard uses an already-prevented synthetic Event; real native input is not
cancelable. The composed typing literals use noncancelable InputEvents.
The existing standalone keystroke counts remain exact for two and fifty rows,
even when an unused binding adapter has been constructed. The space-form and
repaint-cost fixtures now use this production adapter too.

## Composition with the Writer and remaining callers

The Writer adapter stays separate. A combined binding port can enter Split then
Writer with the same parts, settle Split then Writer and return the first
refusal, and leave Writer then Split while attempting both cleanups if one
throws. They share the switch's session, author and undo owner. This cut imports
no unmerged Writer code and adds no second caret mapping.

The next C7 part supplies values, gallery and record ports, comment ports,
title/scene-name bindings, active-Split empty-script handling, and the visual
commit's B-roll and name-derived people records. Structure commands are merged;
their callers belong to that next part: pass named `sharedStructurePorts`, resolve minted ids in
`addRow`, `addRowAndFocus`, `splitField` and `splitCellField`, and retain equivalent
buffer and flow joins. A visual split is refused as
`visual-split-in-shared-session`; adding a beat has the skipped undo refusal
`undo-unsupported:segment-create`. Both notices must appear once when those
callers are connected. Until a caller has its shared form, rule 73's visible
refusal remains. No additional product rule is assumed here.
