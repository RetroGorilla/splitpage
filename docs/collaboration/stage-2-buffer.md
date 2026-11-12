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
counted port. Rule 29's write is the last dependent slice, in its own pull request
after the structure lane's removal handler is on main; this binding does not
implement that write or change removal state outside the operation entry.

Until that dependency lands, "rule 29 dependent slice: residual stale base shows
refusal and retains native text and hold, including disposal" pins the temporary
end: `report` receives the existing `stale-base` refusal, the native DOM and hold
stay live, and another local command, closing the Writer or disposing it cannot
discard them. Wiring must route `report` to the existing refusal display and count
each occurrence. Explicit composition cancellation remains cancellation.

The normal binding commits before another local command plans through
`SharedDocumentSession.run`: status, scalar and a structural split have named
command-admission tests. Writer replay entry also settles typing before choosing
an undo entry. Admission refuses while the native event has not supplied its
evidence, rather than letting another plan advance its revision. Consequently
the stale regression requires bypassing that entry with a raw local adapter
transaction; no normal bound command history is known to reach it. The final
rule 29 slice keeps the stated recovery end even for that boundary violation.

## Native binding

`sharedWriterBufferPorts` explicitly builds the painted source and buffer ports;
no running-app wiring calls it. The surface chooses shared handlers at creation;
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

Every shared native listener enters and leaves through `WriterBufferBinding.native`,
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

## Planned rule 29 operation list

This is the literal request for a plain `aZd` snapshot, source owner `R1`, painted
revision 7, current revision 9, writer 1 and two current visible rows. It will be
one session command at base 9. `draft_17` and `draft_segment_17` are aliases minted
by the first operation; the observed range and boundary in the second must
resolve `draft_17` through that same preparation's alias map. The visual id is the
creation path's actual id for writer 1 and operation `r17`, not another record.

```json
[
  {
    "kind": "segment-create", "id": "r17", "by": "Alice",
    "segment": "draft_segment_17", "beat": "draft_17",
    "at": { "left": null, "right": null, "affinity": "after" },
    "fields": { "audioText": "aZd", "bufferSourceOwner": "R1", "bufferPaintedBase": 7 }
  },
  {
    "kind": "remove", "id": "r17_remove", "by": "Alice", "removalKind": "beat",
    "targets": ["draft_17"],
    "observed": ["[\"flow-base\",\"draft_17\",\"audioText\",0,3]"],
    "boundaries": ["draft_17"],
    "components": ["structure_1_007200310037_visual_0"],
    "gallery": [], "comments": [], "at": 2
  }
]
```

Expected executor result: `{ "ok": true }`, with one transaction and no visible
new beat. The existing recovery projection must contain exactly one removed beat
`structure_1_007200310037_beat_0` holding `aZd` and the source/base metadata, on the
typist, the other copy and an encoded-state late joiner. The final helper must
suppress its undo record; a refusal keeps the original buffer/hold and is counted.
Normal T01 already commits into its original beat before the held removal drains,
so it must create no additional snapshot. Restore/discard remain package 11.

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
