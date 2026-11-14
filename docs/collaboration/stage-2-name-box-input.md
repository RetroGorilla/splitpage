# Native name-box input evidence

Recorded on 2026-11-13 in Edge 157 on Windows, using the repository browser
driver with an isolated headless profile and a plain `input[type=text]` in a
form. Keyboard actions used CDP `Input.dispatchKeyEvent`; clipboard setup used
`navigator.clipboard.writeText` with a user gesture. Listeners recorded event
type, key or input type, cancellation, data, value and selection. The helpers
in `tests/features/edge-input.ts` reproduce the native default between the
recorded events; they dispatch no synthetic events from production handlers.

| Action | Sequence after keydown, before keyup |
| --- | --- |
| Ctrl+V | paste; beforeinput(insertFromPaste); input(insertFromPaste) |
| Empty Ctrl+V at a caret | paste; beforeinput(insertFromPaste); input(insertFromPaste) |
| Empty Ctrl+V over a selection | paste; beforeinput(insertFromPaste); input(insertFromPaste) |
| Ctrl+X with a selection | cut; beforeinput(deleteByCut); input(deleteByCut) |
| Ctrl+X without a selection | cut |
| Ctrl+Z with native history | beforeinput(historyUndo); input(historyUndo) |
| Ctrl+Y with native history | beforeinput(historyRedo); input(historyRedo) |
| Escape | no intervening event |

Keyboard, clipboard and beforeinput events were cancelable; input was not.
There was no keypress for these actions and an input supplied no target ranges.
Undo after cutting `XY` from `aXYef` restored `aXYef` with selection `[1,3]`;
redo restored `aef` with caret `[1,1]`. The existing no-history recording sends
only keydown and keyup. Escape sent only keydown and keyup.

Pasting `XY` over `[1,4]` of `abcdef` gave `aXYef`, caret `[3,3]`, with `XY`
as the input data. Cutting `[1,3]` gave `aef`, caret `[1,1]`, with null data;
the clipboard update precedes deleteByCut. The shared binding accepts that
deletion only at beforeinput, retaining the native clipboard default.

Pasting `A\r\nB\nC\rD\tE\u0001F\u000bG\u007fH` gave clipboard and
beforeinput data with CRLF for every line break. The input data and value were
`A B C D\tE\u0001F\u000bG\u007fH`, caret `[15,15]`. Tabs and the sampled
control characters stayed; line breaks became spaces. The shared plain-input
path preserves that native text instead of passing it through cell run cleanup.
The shared stored scene-name rule still keeps edge spaces, as rule 59 requires.

With maxlength 10, the same paste kept `A B C D\tE\u0001`, caret `[10,10]`.
With `aaaaaaaZ`, caret 7, maxlength 10 and clipboard `X😀Q`, the result was
`aaaaaaaXZ`, caret 8: truncation keeps a prefix and never half a surrogate pair.
These observations passed three browser assertions. No native OS IME was used.

The empty-clipboard follow-up used the same isolated Edge 157 harness and
`navigator.clipboard.writeText("")`. At caret `[2,2]` in `Draft`, empty paste
sent paste, beforeinput and input before keyup, with null data on both input
events, leaving `Draft` and caret `[2,2]`. Over `[1,4]` it sent the same events
with null data, leaving `Dt` and caret `[1,1]`. Cutting with nothing selected
sent cut between keydown and keyup, with no beforeinput or input, leaving
`Draft` and caret `[2,2]`. The helpers reproduce these events, including the
trailing input for an empty paste at a caret.

The binding does not rely on that trailing input. A collapsed empty paste or
empty cut beforeinput opens no edit. Other clipboard beforeinputs remember that
they await input. At the next observed native or lifecycle event, paint, finish
or disposal, an unchanged native value discards only that waiting target and
settles its no-op, releasing queued updates. It does not turn a missing input
into an identical-text replacement. A pre-existing empty-name hold stays under
its existing rules. Regression tests cancel a native beforeinput after the
binding sees it, so the default mutation and its input do not happen; keyup or
paint then releases the hold, and another writer's `!` reaches `!Draft` on each
copy. These are cancellation tests, not an alternative claimed Edge sequence.
The follow-up passed three literal event, value and caret assertions.

## Rule 84

The shared inputs keep native typing unrestricted by maxlength so the existing
200-character scene and 300-character title verdicts still see an over-limit
keystroke. Paste alone fits its native replacement into 200 or 300 UTF-16 units:
space available is the limit minus the unselected prefix and suffix. It writes
the longest prefix that fits, excluding a trailing half-pair, keeps the suffix,
and places the caret after that prefix. Truncation is silent, like native
maxlength. If no pasted text fits, a collapsed selection writes nothing; a
nonempty selection becomes a deletion, subject to the existing heading hold
and length verdicts. Concurrent writers can still produce an
over-limit stored name under the pre-existing rules.

The operations retain the buffer's insertion-before-deletion order at the
painted gap: one insertion for the kept text and one deletion naming only the
selected identities. An empty replacement has no insertion. Cutting the entire
scene name leaves the empty hold, with no shared deletion yet; pasting its next
name commits one replacement and releases held remote changes. Drop and native
history remain refused in this cut. No standalone listener is changed.

The seeded input histories exercise three native writers with replacement,
cut and insertion, rotating writers and normal, reversed and duplicated update
delivery, plus a fresh encoded-state joiner. Four literal histories from `abcdef`
cover separated and overlapping deletions, prefix removal, and insertion inside
the text or at its end, with results `aXfY`, `bPQefZ`, `XcYd` and `aXefY`.
Their declared-limits table is empty.

## Creating a scene from its name (rules 87 and 99)

Split's `add-section` opens a blank input directly above the selected beat;
`name-automatic` opens it on the automatic scene's first beat. Opening selects
the empty input, with caret zero and no default stored name. In standalone,
submit or blur saves a nonblank name. That path is unchanged.

In shared mode, the first nonblank `input` creates the heading; during IME it
waits for `compositionend`. Blank input, blank submit, blank blur and a cancelled
first composition store nothing. One `add-section` command contains ordinary
`heading-create` followed by its first `text-insert`, using a list-local heading
alias. The returned canonical writer/operation identity binds the same input to
the existing name-box buffer. The native input's first paste fits its prefix in
200 UTF-16 units without splitting a surrogate pair. After creation the existing
typing verdict, paste limit, stored whitespace, empty hold and caret mapping
apply. Enter closes over the stored name and focuses the scene-name button.
Drop and native history remain refused before and after creation.

Assumed rule 99 retains ordinary heading-create concurrency: when two people
name the same automatic scene, both names survive. The higher writer's heading
owns the beat; the lower writer's name becomes `scene-with-no-beats` in recovery.
The same rule applies to two add-sections above the same beat. Repaint closes
the losing form through the existing detached-heading lifecycle. A key already
in progress stays with its own heading in recovery. Before repaint, another key
on that stale form is prevented and reported as `buffer-unavailable`; the
existing ownership checks can report it more than once. It never targets the
winning heading. No new reconciliation or operation intent is introduced.

`scene-create.test.ts` compares complete projected documents and recovery on two
copies and an encoded late joiner under normal, reversed and duplicate delivery.
It pins both forms, typing in the first beat, removal of that beat, removal of
the last beat, exact emitted operations, limits and a first composition. Its
seeded three-writer histories also interleave naming, later typing, cut/paste
and neighbouring beat typing. Concatenating the two complete creation command
lists equals executing them separately. The undo-owner test records creation
once and pins `undo-unsupported:heading-create`, leaving its one entry intact.

Composition must give `mountSceneHeaders` both `sharedBufferedInputPorts` and
`sharedSceneCreation(handle, session, author)` from the shared wiring ports.
The author uses the existing clean operation-id source. The command runs once
through the shared session. C2 must pass its `add-section` description with
`typing: null` to the same `executeSharedCommand`/`SharedUndo.perform` path as
other commands; no after-the-fact recording or second undo stack is used here.

## Rule 85 dependency

Undo, redo and Escape wait for composition cut C2. `SharedPlan` currently carries
operations, base and the recovery undo exclusion; `ReplicaPort.execute` receives
only operations and base. The session's `undo.record` gets a change set and an
offset selection, after execution. The Writer heading buffer uses that same
path today. It does not produce the identity record that `SharedUndo.perform`
needs, and the missing before-state cannot be reconstructed from the change set.

C2 must carry a command description through the plan to replica execution, run
`executeSharedCommand` around the actual execution, and record its result in one
per-writer `SharedUndo.perform` stack. The description needs a label, anchored
selection, and typing text for a keystroke or null for cut, paste and Escape's
replacement. Recovery's `undo: false` must still bypass recording. C2 also supplies
the shared replay entry and routes it to that same owner from the Writer, inputs
and global shortcuts. The next cut can then test the boxes and Writer against
one stack, without a parallel undo history or a second execution to learn its
record. Escape additionally needs the stored opening name and a check that no
other writer changed it while the form was open.
