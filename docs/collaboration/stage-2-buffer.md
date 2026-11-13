# Buffered native text

M1 retains inbound updates while a native edit is open. `SharedTextBuffer` keeps
the painted revision, text and per-unit origin offsets. Each native target range
replaces those origins, including replacements with identical text. Its plan
contains only the changed spans. When `beforeinput` supplied a range, that range
is the evidence, including a replacement with identical text. An unreported
native change is instead adopted as the code-point-safe difference between the
painted text and DOM, as ruled for the ownership invariant below.

`bufferedTextOperations` names deletion units through the painted identities.
Inserted runs use the existing flow insertion policy for atoms and marks. Each
replacement inserts at its painted gap before deleting its observed units. The
adapter's `createSharedBufferedText` calls the shared session's command entry
with that painted revision, then releases the buffer reason. It has no inbound
queue; the handle's ingress gate owns the only queue and drain.

The adapter refuses to open against a different revision. If a commit moment
falls inside delivery, it returns `buffer-delivery` before calling the session,
retains the native edit and hold, and requires an explicit retry after delivery.
That retry succeeds only when the revision has not advanced. A revision-changing
local command makes the bare adapter's retry `stale-base`; text and hold remain
until its caller handles that result. The regression named "a revision-changing
local notification makes retry stale" pins this boundary. A failed command also
retains the edit for explicit handling or cancel.
Cancel discards local native intent and releases held arrivals. Destruction clears
the gate without applying held updates. Crash recovery is outside this in-memory
package; no durable continuation is claimed.

The Writer binding must make that local-command history unreachable: it commits
ordinary dirty native typing before another local command enters the session,
including status, scalar and structural commands. During composition it refuses
the command until compositionend instead of settling preedit. Any remaining stale-base outcome has the
stated end in assumed rule 29 on #1414: a fresh soft-removed recovery beat keeps
the whole native field and source owner/base metadata, through existing shared
operations and the existing recovery reader, with no undo entry. Successful
recovery releases the hold; refused recovery retains it and reports through the
counted port. [The rule 29 recovery write](#the-rule-29-recovery-write) describes it.
Explicit composition cancellation remains cancellation.

The normal binding commits before another local command plans through
`SharedDocumentSession.run`: status, scalar and a structural split have named
command-admission tests. Writer replay entry also settles typing before choosing
an undo entry. Admission refuses while the native event has not supplied its
evidence, rather than letting another plan advance its revision. Consequently
the stale regression requires bypassing that entry with a raw local adapter
transaction; no normal bound command history is known to reach it. The recovery
write keeps the stated end even for that boundary violation.

## Native binding

`sharedBufferPorts` explicitly builds the painted source and buffer ports;
no running-app wiring calls it. The binding itself is `createBufferedField` in
`src/application/editing/buffered-field.ts`; it reads the shown fields only
through its surface port, and the Writer supplies its beats through
`createWriterBuffer` in `src/features/writer/flow-buffer.ts`. The surface chooses shared handlers at creation;
standalone listeners keep their existing handler functions. Native `beforeinput`
records its target and closes the buffer reason before the DOM changes. `input`
checks the unchanged prefix and suffix against that target and records the native
replacement; it never sends an unproved whole-field edit. Ordinary input commits
there; composition commits only on completion. Outside composition, clipboard
handlers settle before capturing the range, both through the mounted clipboard
port and direct root listeners. Native `deleteByCut` and `deleteByDrag`
retain the existing refusal/delegation policy, so a refused paste/drop cannot
leave a newly accepted source deletion behind.
Collapsed Backspace/Delete at a beat boundary delegates to the existing
structural command port after settlement; it opens no empty native buffer.

Assumed rule 31 on #1414 routes ordinary cross-beat insert/delete targets through
that command port after settlement. A refusal prevents the native mutation and
keeps the document and selection, with the existing refusal shown. The two tests
named "rule 31 dependency: whole-start cross-beat ... until removal/join handlers
land" pin the current refused end; their expected outcome must be updated visibly
when the structure handlers arrive. The composition case is a declared limit:
IME/dead keys starting over beats are refused without a write or opening a hold,
including their trailing native commit. A new ordinary key or a new composition
inside one beat starts a new attempt. "rule 31 declared limit: cross-beat
composition and its late commit are refused without writes or a hold" pins it.
This limit is not assigned to package 14; only the maintainer can reopen it.

Paints wait while native intent is held. Successful commit releases the reason,
drains arrivals, maps the caret through native anchors, then repaints and refreshes
the base. Cancel releases and repaints even when the model string did not change.
An unproved native difference is reported and retained rather than guessed.
`composition.ts` is unchanged; the shared Writer handlers own this interval.

Selection restoration resolves the locally captured native anchors through the
same projected blocks and join grouping as the document. Each endpoint carries
its projected owner and offset; it is never clamped to the opening beat. A caret
after typed text follows that text's final unit, including a split at that gap.
If removal makes the endpoint invisible, there is no restored edit selection:
the surface explicitly lands at offset zero of the first remaining beat. The
typed snapshot remains in the original beat's recovery; this is not a second
recovery entry. `buffer-review.test.ts` pins before, after, exact-gap and prefix
splits plus removal, two and three writers, normal/reversed/duplicated delivery,
literal owner/offset and a further native character, and an encoded late joiner.

The surface's composition flag is the sole in-progress flag used by both native
bindings. Shared key dispatch admits no command while it is set or a key carries
`isComposing` or key code 229. The paired shared/standalone composition tests
keep the final replacement across Enter, boundary Backspace/Delete, Tab, undo,
redo, status, movement, join, heading and formatting chords.

A native mutation requires this surface's open edit. Open refusal or throw
prevents the mutation and reports through the existing port; another surface's
hold grants no ownership. The ownership invariant test checks each step through
throws, refusals, rule 27, queue overflow and two surfaces. `BufferedTextEdit.isOpen`
is the adapter's authority for completion: a no-op that closes before a throwing
drain is reported, repainted and forgotten, so the next key opens a fresh edit.

## Native ownership and composition invariants

Every shared native listener enters and leaves through `BufferedFieldBinding.native`,
including mounted clipboard handlers, focus, pointer and selection events. Paint
and programmatic settlement also use the ownership checkpoint. It compares every
shown beat with its last painted text; that text is retained even when no valid
painted identities were available. A difference with no owned open edit opens one
against its painted base and records the native replacement. An `input` without
`beforeinput` therefore follows the same commit path for insertion, deletion and
replacement. If the base or edit is unavailable, the field is reset from the
model immediately and the existing refusal is reported. Resetting one field does
not replace another field's owned preedit. A second differing field is refused
while the surface owns its one edit; no additional buffer or queue is introduced.

`settle` is the single write gate: while the composition flag is set it reports
`buffer-composition` and returns without reconciling, committing, cancelling,
closing or replacing the owned edit. This applies to local command admission,
clipboard mutation, non-text beforeinput, formatting, close, undo and disposal.
Copy reads the selected native DOM text to the plain-text clipboard without
settling. Focus loss does not settle. If no compositionend arrives after blur,
the hold stays under rule 26's byte bound; focus return continues that composition.
Only a later compositionend commits it, or compositionend with empty data cancels
it. There is no timeout or focus-return commit.

`buffer-invariants.test.ts` checks ownership after event histories with omitted
beforeinput, failed acquisition, rule 27, a full queue and another surface; it
checks each composition request followed by the final `你` replacement. Existing
ordinary command/clipboard tests now hold a pending non-composition native input
instead of treating preedit as ordinary typing. `standalone-native-cases.ts`
extends the 138 key/lifecycle comparisons with 108 clipboard, focus and non-text
beforeinput cases against main, comparing document, DOM, selection and event
outcomes byte for byte. Standalone listener functions remain unchanged.

## The rule 29 recovery write

`BufferedTextEdit.recover(runs)` writes the native field to recovery. It answers
`null` unless the edit is open and its last `commit` was refused in one of two
ways: the session adopted another document (`buffer-epoch`), or the session
admitted the command and the document refused its list (`stale-base`, or a
handler's reason). A commit that was not admitted (delivery in progress, no edit
permission, re-entry, a disposed session) or that threw leaves nothing to recover:
it can be asked again, and `commit` itself is unchanged.

The write is one session command at the current revision whose plan declares
`undo: false`, so the session publishes one edit with its effect pass and does not
tell the undo port. `bufferedRecoveryOperations` builds the list. For a plain `aZd`
field, source owner `R1`, painted revision 7, current revision 9, writer 1,
operation id `r17` and two visible rows it is literally:

```json
[
  {
    "kind": "segment-create", "id": "r17", "by": "Alice",
    "segment": "draft_segment_r17", "beat": "draft_r17",
    "at": { "left": null, "right": null, "affinity": "after" },
    "fields": { "audioText": "aZd", "bufferSourceOwner": "R1", "bufferPaintedBase": 7 }
  },
  {
    "kind": "remove", "id": "r17_remove", "by": "Alice", "removalKind": "beat",
    "targets": ["draft_r17"],
    "observed": ["[\"flow-base\",\"draft_r17\",\"audioText\",0,3]"],
    "boundaries": ["draft_r17"],
    "components": ["structure_1_007200310037_visual_0"],
    "gallery": [], "comments": [], "at": 2
  }
]
```

The operation id is the `author` port's id and the removal's is that id with
`_remove`; `draft_<id>` and `draft_segment_<id>` are aliases that exist only inside
the list. The author id must therefore be one the structure executor accepts as an
operation id (letters, digits, `_` and `-`); another id refuses the write with
`invalid-structure-operation-id` and keeps the edit. The composition's author port
(`sharedAuthorPort` in `src/bootstrap/wiring/ports/shared-author.ts`) gives
`w<client number>_<serial>`: the replica's sync-library client number, so two
copies never give the same id, and `by` is the editor name. It answers null in a
standalone session. `audioText` is the whole
native field as stored HTML, with its formatting and inline markers; an emptied
field writes an empty entry and observes nothing. The component is the creation's
own visual id for this writer and operation, supplied as a checked observation.

A successful write closes the edit and releases the hold before it forgets the
native text, so a paint during the drain finds a closed edit whose text is still
the field's and resets the field instead of adopting it. No new row is visible,
recovery holds exactly one removed beat with the field and the source owner and
painted base, on the typist, the other copy and a late joiner. A refused write
changes nothing and keeps the edit and its hold. `tests/collab/buffer-recovery.test.ts`
holds the literal, the refusals, the adopted document, a formatted field and T01
with the removal command, where typing committed before a held removal joins that
beat's recovery and adds no entry of its own.

The Writer binding asks for the write inside settlement, when a commit left its
edit open. On success it forgets the edit, repaints the field from the document,
puts the caret back at its offset (the surface clamps it to the repainted text),
calls `recovered(rowId)` once and reports nothing else; settlement then counts as
done, so the local command, close or disposal that asked for it goes on against
the repainted document. A refused write is reported through `report` with its own
reason, and the native text and hold stay: "rule 29: a refused recovery write shows
its refusal and retains native text and hold, including disposal". Wiring must
route `recovered` to a notice and count it. `tests/features/writer/buffer-recovery.test.ts`
holds the composition, ordinary typing, command admission and disposal cases.
Restore and discard remain package 11.

Two cases the write does not cover, both as before it: a commit that threw (among
them a write that landed and could not be projected) keeps its edit, and assumed
rule 26's bound never interrupts typing, so it leads to no recovery entry.

## The space form (assumed rule 55)

A cell that does not keep its spaces (the Split view; the Writer uses
`pre-wrap`) lets the browser show a space as U+00A0, and back again, outside the
native target. Stage 1 trace T03 failed on exactly that: after the third
Backspace on `the the` the DOM reads `the `. A surface that passes
`foldSpaceForm: true` to `createBufferedField` compares the DOM with the buffer and with
the painted text counting U+0020 and U+00A0 as one character
(`sameUpToSpaceForm` in `src/core/collab/buffer.ts`):

- a unit outside the native target keeps its identity and its stored form,
  whatever form the browser shows (`foldedNativeSplice`, and
  `foldedNativeReplacement` for input without a target);
- typed text is stored as the native data when the two differ only in space
  form, so a typed space is U+0020 and a typed U+00A0 stays U+00A0, also when
  it is typed over a selected space of the other form. Input with no native data
  (a spellcheck replacement, or input without `beforeinput`) is stored as the
  browser shows it, U+00A0 included;
- the runs a commit sends are aligned to the buffered text (`alignSpaceForm`),
  so the mapper's evidence check holds. The rule 29 recovery write keeps the
  field as shown.

Any other difference outside the target is still refused as native evidence.
The Writer passes no `foldSpaceForm` and keeps exact comparison. The literal cases are in
`tests/core/collab/buffer.test.ts` and
`tests/application/editing/buffered-field.test.ts`; the Writer's own pin is
"rule 55: the Writer keeps exact comparison, ..." in
`tests/features/writer/buffer-binding.test.ts`. The Split view binding below
passes `foldSpaceForm`.

## Split view binding

`mountCellBuffer` in `src/features/editing/cell-buffer.ts` binds the Split
view's narration and visual cells (package 9e) to the same `createBufferedField`, with
`foldSpaceForm: true`. It gets the binding factory, the painted record and
everything it needs from the rows renderer through `CellBufferPorts`;
`mountSharedSplitBuffer` in `src/bootstrap/wiring/split-buffer.ts` builds them.
Nothing in the running app calls it yet (package 14); a test pins that.

- One capture listener on the rows root sends every `beforeinput`, `input`,
  composition, `keydown`, `cut`, `paste`, `drop` and `focusout` through the
  binding's ownership check and settlement gate. The check after the event runs
  when the binding's own step ends, before the standalone handlers further down;
  their changes are caught at the next native event, settlement or paint. A
  paint for a session change that did not come from the screen first runs the
  binding's `canPaint` through the rows renderer's `onBeforePaint`, so a cell
  changed outside the binding is adopted or put back, and reported, before a
  received update replaces it. The hook has no subscriber in a standalone session
  and is never reached by a standalone keystroke.
- A visual cell is a field of the same binding under its own key: the row id,
  U+FFFD and `visualText` (`bufferedFieldKey`). `readBufferedFieldKey` reads the
  text after the last U+FFFD as the field and accepts only `visualText`; any other
  key is a narration row id. A row id that holds U+FFFD fails
  `isStableSharedIdentity`, so every target built from such a key is refused by
  the executor; the parser relies on that refusal, not on such ids being absent.
  So there is one open edit, one composition and one admission gate across both
  columns. The adapter reads the field from the key: the text address is
  `{ owner: row, segment: row, field: "visualText" }`, which resolves to the
  beat's visual, and the caret after a visual commit follows the visual's own
  offsets. A narration key is the bare row id, so narration is unchanged.
- An adopted change is settled after the event only when the event left no
  native target waiting for its `input`; otherwise the event's own edit settled
  it already, and settling again would report a false `buffer-pending`.
- Each event runs inside the paint guard's `whileShown`, so the commit's own
  change does not replace the focused cell. After a commit the binding rewrites
  the cell in place only when the stored text differs from what is shown other
  than in space form, notes the cell as painted, and asks the renderer for a
  render so that updates released after the commit paint in the other rows.
- The painted record is refreshed at every rows paint for each narration and visual cell
  whose row signature matches the shown document (`paintedFromRow` in the rows
  renderer reads the signature and changes nothing).
- Assumed rule 55 on #1414: native formatting, history
  and other input that is not text is refused after settling
  (`buffer-unsupported-input`) (R5). Enter, row commands, paste into a cell and
  formatting from the toolbar settle typing through command admission and then
  run their existing command (R5). The caret after someone else's change while
  nobody is typing is put back by the renderer, by offset (R7).

The rule 29 recovery write is the binding's own: when the document refuses a
commit at its painted base, settlement writes the whole cell as shown to
recovery through `BufferedTextEdit.recover`, exactly as for the Writer, and the
Split view only supplies the repaint, the clamped caret and the `recovered`
announcement. Its cases follow assumed rules 29, 38 and 55 and are named in
`tests/features/editing/cell-buffer-recovery.test.ts`: a composition or ordinary
typing refused on a stale base, the cell kept as shown (a U+00A0 the browser
showed stays U+00A0 in the entry), the local command that found the edit going on
after the write, unmounting, a paint during the drain, a refused recovery write
keeping the text and the hold, and typing over someone else's removal joining
that beat's recovery with no write. A refused visual edit goes into the same
kind of draft, with the cell as shown in the draft's visual and its narration
empty (`tests/features/editing/cell-buffer-visual.test.ts`). The refused commit needs a write to the
replica that bypassed the hold; a removal, join or other change from someone else
is held while the cell is edited and the typing lands by its identities.

The named tests are in `tests/features/editing/cell-buffer.test.ts`, including
"rule 55, T03 Split native whitespace (D1 and D3) ...", which checks the copied
Stage 1 literal on every replica. `tests/features/editing/cell-buffer-cost.test.ts`
pins the standalone Split keystroke in narration and in the visual column: one
edit, one decode, no paint check and no repaint per key with 2 and 50 rows, and no buffered field, painted record or cell buffer
built. Shared-only cost per native event: the ownership scan over every
narration and visual cell, as in the Writer, and a render after each commit; and
one ownership scan before each paint for a received or other non-screen change.

### The visual column (package 9e)

Visual typing commits like narration: a text insert or delete on the beat's
visual and the beat's stamp, one commit per key, or one per composition. What
else a commit derives from the visual text, per
[the commit-time writers](stage-2-commit-time-writers.md):

- The stamp is written, and the commit runs the same tag check as narration
  (`sharedTagsIntroducedByText` reads either field). Typing alone adds no tag
  mark, though: a typed `SFX:` line stays plain text, because the cue shortcut
  that marks it in a normal script is a model edit package 14 composes, so the
  check registers nothing.
- People from a typed `@Name`, and shots and keys from a typed B-roll line, are
  not written: their builders have no caller until package 14, so in a shared
  session the line keeps the typed text only (assumed for package 9e, for the
  plan review).
- A tag's owner from an `@Name` pairing and a sound cue's entry following its
  words stay off; both are undetermined.

Declared limits, each pinned by a literal in
`tests/features/editing/cell-buffer-visual.test.ts`:

- The visual cell of a joined row shows both visuals, and its painted record is
  one visual, so typing there is refused and repainted, as rule 27 does, until a
  later cut binds a joined visual.
- A beat split off in a shared session has no visual yet: `split` creates none,
  and no existing operation gives an existing beat its visual text
  (`record-create` on `visuals` refuses the `text` field). Typing in that visual
  cell is refused with `buffer-no-visual`, reported to the person, and writes
  nothing; the beat's narration takes typing. Follow-up: an operation that gives
  an existing beat its visual record and text in one list, so the first commit in
  such a cell can create it.

## Scene headings in the Writer

A buffered field is named by a key: a narration field by its row id, a visual
cell by its row id, U+FFFD and `visualText` (`bufferedFieldKey`), a scene heading
by `heading:<scene id>` (`headingFieldKey`). Row and scene ids are cleaned to
`[A-Za-z0-9_-]`, so a key with a colon is never a beat cell's.
`bufferedFieldTarget` in `src/application/editing/buffered-field-key.ts` turns a
key into its owner and field, handing a key without a colon to
`readBufferedFieldKey`, so there is one parser for every key. The painted record,
`PaintedTextSource.read`, `sharedBufferedTarget`, the commit's change set, the
selection after a commit and the recovery write all read the key through it. The
binding asks the surface for a position's key (`key`) and for the position at a
key's offset (`position`); without them it takes beats only, so the Split view is
unchanged. The Writer gives its `.wr-heading` elements to the same binding, so
there is still one edit per surface and one ownership walk. A heading commit
writes the existing `text-insert` and `text-delete` on the `heading` field, with
the change set of a scene rename (`sections`) and no beat stamp. The caret after
it is mapped through the heading's own anchors (`collabProjectedHeadingPoint`),
never into the next beat. The painted record holds each shown heading at every
paint, and `PaintedTextSource.read` answers the `heading` field.

Assumed rules, for the plan review (numbers as in the lane's report on #1414):

- Typing, deletion and composition inside one heading go through the buffer.
- A selection from a heading into anything else is the rule 31 case: typing is
  settled, then the existing command runs; composition over it is refused.
- Enter, paste, cut, formatting and Backspace at a heading's start settle typing
  and then run their existing command. With the split and removal handlers
  registered, Enter, paste, cut and that Backspace are applied, and formatting plans nothing.
- A heading with no visible text is not settled: the edit stays open and holds
  received updates while the person is in it, and the next keystroke that gives
  it text settles as one replacement. If the edit ends while empty (settlement,
  focus loss, another command, unmounting) the stored name is put back and the
  person is told once (`buffer-heading-empty`). A keydown never ends the hold;
  the hold ends on what happens: a `beforeinput` that is not an insertion or
  composition into that heading, a command about to run (the session's
  `beforeCommand` admission), the selection leaving the heading (`moved`, called
  at `selectionchange` and `mouseup`, and only while a heading is held), or focus
  loss. Each ends it the same way. A key, input, paste, cut or drop that ends the
  hold is consumed: its default is prevented and no command runs, so it never acts
  on the restored name the person did not see. That covers Backspace and Delete
  (also with a target range reaching into the next beat), Enter, paste, cut, drop,
  `historyUndo`/`historyRedo` and the undo and redo shortcuts; the surface's own
  commands check the hold before they write. Selection leaving and focus loss have
  nothing to consume. An insertion settles as one replacement with no report, and
  a change adopted with no `beforeinput` or found by a paint keeps the hold. Paste
  is not an insertion: emptying a name and then pasting a new one ends the hold
  with the report, while selecting the name and pasting over it replaces it. A
  removal of the heading by someone else waits behind the hold and lands once it
  ends. A composition records
  at `compositionstart` whether it began in a heading held empty; cancelling it
  then puts the name back with the one report, whatever text the cancel leaves.
  A composition that began elsewhere and is cancelled is a plain cancel.
- In a shared session the projected scene name is the stored text, character for
  character, spaces at its edges included, so the screen, the painted record,
  Find and Replace, copy and every flow command count on one string. The session's
  entry port must keep each scene name as projected: the file loader
  (`migrateRows`) trims names, and the stand-in entry in
  `tests/application/session/shared-session-support.ts` puts the projected names
  back. Removing edge spaces is a write that belongs to heading finalization
  (package 10); until then a shared name may carry them. Places that already trim
  a name when printing it (outline, numbering, export, through `normalizeScenes`)
  still do.
- A keystroke that takes a heading past 200 characters is refused and put back
  (`buffer-heading-length`); what was settled before stays.
- Heading text the document refuses goes to recovery through the rule 29 write,
  unchanged: one removed beat holding the name as narration, with
  `bufferSourceOwner` the scene id, placed at the end because its source is not a
  beat. `recovered` receives the heading's key.

`tests/features/writer/buffer-heading.test.ts` holds each case, including a
remote change mid-typing, mid-composition and while the heading is held empty,
compared on the typist, the other copy and a late joiner. "standalone heading
keystroke" in `tests/features/writer/buffer-cost.test.ts` pins that the
standalone rename builds no buffer or painted record and reads no key. The
title is not bound yet.

### The Split view's rename form (package 9d, cut 1b)

In a shared session the Split view's rename form binds its input to the same
buffered field under the heading's key (`bindSceneName` in
`src/features/rows/scene-name-buffer.ts`, given by `sharedSceneNamePorts` in the
wiring). Each keystroke settles as the heading's `text-insert` or `text-delete`;
the form runs no rename command, and closing it (Enter, Escape, focus loss)
closes it over what is already shared and repaints the rows once. The form shows
the stored name (`storedSceneName`, edge spaces included), and the empty and
200-character verdicts are the Writer's (`unsettledHeading`). Assumed rules, for
the plan review:

- An input gives no target range, so a collapsed Backspace or Delete is left to
  the browser and adopted at its `input` event. Paste, drop, `historyUndo`,
  `historyRedo` and other input types are refused with `buffer-unsupported-input`,
  after settling typing; a refused undo restores nothing.
- Enter on a settled name lets its `insertLineBreak` through, so the form's
  submit closes it. A shared form sets no native `maxlength`: the binding refuses
  the 201st character at its `input` event (rule 5), which native truncation
  would suppress.
- A name held empty ends as in the Writer (rule 59 as merged): a command
  admitted, a cancelled composition that began held, or the input losing focus
  (any blur that a same-task refocus, as a repaint's re-homing, does not undo) or
  the document selection leaving the form, each with the stored name back and one
  report. Enter, cut and paste (on their clipboard events, since a cut with
  nothing selected sends no `beforeinput`), drop, `historyUndo` and `historyRedo`
  end it the same way and are consumed: nothing else happens and the form stays
  open on the stored name; Escape then closes it. A focus transfer to another
  element also closes the form. Backspace and Delete have nothing to delete in an
  empty input, so the hold stays. Paste is not an insertion: emptying a name and
  then pasting a new one gives the report, while selecting the name and pasting is
  refused as any paste is.
- A paint during an edit re-homes the form into the rebuilt header. The caret and
  selection, with their direction, follow the shared units: each end stays after
  the unit it followed, so text others insert at either side or between equal
  letters does not move it.
- Adding a scene, or naming an automatic one, opens no form in a shared session
  and tells the person (`not shared`): scene creation has no shared operation yet.
- Name text the document refuses goes to recovery through the rule 29 write, as
  in the Writer.

`tests/features/rows/scene-name-buffer.test.ts` holds each case, compared on
the typist, the other copy and a late joiner. It drives the input through
`tests/features/edge-input.ts`, one helper per user action, each dispatching the
sequence Edge sends for an `<input>`; `tests/features/rows/scene-controls.test.ts`
pins the standalone form, which binds nothing.

## Mapping and coverage

Mapping normalizes the supplied native runs once, then slices the prepared units
only for insertions. With N native units, S splices and C changed units, text
traversal is O(N + S + C); mark policy and encoding each changed unit's painted
identity have their own costs. The mapper's work-bound tests count supplied text reads for
100 separated replacements and deletions; the rescan mutant fails those tests.

`tests/collab/buffer-commit.test.ts` covers same-beat and next-beat edits, native
identical-text replacement, marks, empty and end gaps, and delivery re-entry.
Its named **stale base (T01)** removal histories keep `aZd` in the removed beat's
recovery row and leave the next beat `ef`, across normal, reversed, duplicate and
late-join schedules. Removal is written through the adapter transaction using
the projection's removal flag contract while the structure executor is in review.
`buffer-generator.test.ts` interleaves three native writers and encoded reloads
with a literal expected result and an empty table of declared limits.

Assumed rule 26 is documented in [the ingress gate](stage-2-ingress-gate.md#bounded-buffered-arrivals).
Assumed rule 27 on [#1414](https://github.com/RetroGorilla/splitpage/issues/1414#issuecomment-6814123286)
requires refusing native input without a painted base, counting the occurrence
through a port and requesting a repaint; the Writer binding supplies that policy.
Nothing constructs this buffer in the running app yet; package 14 activates it.
