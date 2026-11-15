# Split binding composition, C7 first part

`sharedSplitBindings(effects)` supplies the existing switch's `SharedBindings`
port. It mounts `mountSharedSplitBuffer` on entry, before hydration as the switch
requires, and disposes it on leave. A refused finish returns its named reason.
A refused dispose leaves the binding and shared ports in place. Re-entering the
same parts after that refusal does not mount twice. Failed entry releases the
binding and restores the kept standalone document and cold handlers. The switch
itself is unchanged.

The real hook now combines the Split and Writer bindings before the recovery
panel binding. Both enter with the same parts, settle through their existing
admission, and leave in reverse order while attempting both cleanups. Ordinary
and final abandonment reach both bindings even if a cleanup throws. The runtime
inventory is five registered steps: the four Writer surfaces and one Split cell
buffer. Successful leave unregisters all five. Title and scene callers remain
with the callers cut; the buffered-input factory registers when that cut mounts
an input, rather than adding an unused input here.

Both Split factories forward the abandonment port to their field. Ordinary
abandon first tries to finish, keeping committable text; it cancels a composition
or other unfinished edit only if that fails. Final abandon always reaches the
field, including while a commit drains, so finish and disposal can succeed.
A failed entry before hydration releases the mounted field before disposing it:
there is no document or text to commit, and ordinary ownership admission cannot
succeed yet. This leaves no listener or registration from the failed entry.

Before disposal forgets its stored space forms, it restores known native
nonbreaking stand-ins to their stored characters in the live DOM and removes
display spans. Otherwise a plain space typed just before leaving can escape
through a later standalone HTML copy as U+00A0. Both selection endpoints survive
that cleanup, including endpoints in different cells; it reuses the same DOM
placement as repaint. Stored U+00A0 remains U+00A0. No cold handler is changed
to recognize shared paint.

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

## Refusals

The composed Split binding refuses unserved native routes before the native
ownership check or finish. A pending edit or composition therefore stays as it
was; a drop cannot focus its target or change the selection before refusing.
The guard is supplied as a named port only when Split is shared.

| Route | States | Result |
| --- | --- | --- |
| Paste, cut, plain-text drop | Idle caret, idle selection, pending text, open composition; drops also target another cell | One notice, no clipboard access or standalone work, no stored/DOM/focus/selection change |
| Unsupported beforeinput: clipboard, drag, line/paragraph, format, history, list and transpose types | The same four states | The same refusal before settling |
| Enter, Ctrl/Alt+Enter, Alt+Up/Down, Ctrl+B/I/U, active person completion on Tab | The same four states; person completion in visual cells | The same refusal before the legacy key route |

The four `shared-split-refusals-{audio,visual}-{forward,reverse}-app.test.mjs` files drive 424 literal table rows through the
mounted hook, in both columns and both encoded delivery orders. Every public
standalone undo method is instrumented while each native event runs, and a
literal inventory pins the legacy key routes and undo access sites so additions
require classification. IME keydown remains with the native composition, and
ordinary navigation and copy remain served.

## Rule 29 announcements

| Commit outcome | Recovery writes | Announcement |
| --- | --- | --- |
| A successful buffered commit releases its hold and drains a removal that keeps its owner in removed-beat recovery | No new recovery write or entry | One recovered callback, notice and counter increment |

The adapter records the revision immediately before release. Only a changed
revision during that release needs the recovery-membership check; ordinary
typing does not run a new full projection. The successful commit reports the
result to the binding, which announces after repaint. Four literals pin both
columns and delivery orders, exact recovery text, both replicas and an encoded
late joiner. Repeated delivery announces nothing further. The Split and Writer
T01 tests retain their exact operations and recovery row, and now require this
announcement instead of the former silence.

## Evidence and event sources

`src/test/shared-split-app.test.mjs` boots the application, enters through the
real switch and adapter, exchanges encoded updates with a second real handle,
and compares complete projected documents with an encoded late joiner through
the agreement checker. Hand-written rows pin text, marks and column ownership.
The literals cover keyboard undo/redo, idle repeated-character carets in both
columns, typing at a direction's closing edge, compositions holding a remote
update, refused finish/dispose, re-entry, entry rollback and cold typing,
formatting, render tracking and composition after leave.
The native-terminal-space cases copy after leaving and require plain-space
HTML and text payloads. Four disposal literals cover two-cell selections in
both directions and both columns, with two replicas and an encoded late joiner.
The Split app file also pins ordinary abandon over pending text and composition,
then final abandon during commit drain, in both columns and through the real
buffered-input factory. The real hook route table adds stop during a pending
Split edit and stop during a Split composition in each column: pending text
lands, composition text does not, no surface remains, and re-entry succeeds.

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

The adapters stay separate. The hook's combined binding enters Writer then
Split, settles Writer then Split and returns the first refusal, and leaves Split
then Writer while attempting both cleanups if one throws. They share the
switch's session, author and undo owner. The switch owns every entry and exit;
the hook supplies callbacks and wraps no caller. Its opening port remains C8's
openingStatus. This adds no second caret mapping or assumed product rule.

The next C7 part supplies values, gallery and record ports, comment ports,
title/scene-name bindings, active-Split empty-script handling, and the visual
commit's B-roll and name-derived people records. Structure commands are merged;
their callers belong to that next part: pass named `sharedStructurePorts`, resolve minted ids in
`addRow`, `addRowAndFocus`, `splitField` and `splitCellField`, and retain equivalent
buffer and flow joins. A visual split is refused as
`visual-split-in-shared-session`, with one notice. Beat creation undo now follows
the merged [creation undo contract](stage-2-shared-undo.md#undo-of-beat-creation)
from #1590, replacing the earlier skipped segment-create limit. Until a caller
has its shared form, rule 73's visible
refusal remains. No additional product rule is assumed here.
