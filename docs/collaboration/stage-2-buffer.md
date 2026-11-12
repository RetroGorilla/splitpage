# Buffered native text

M1 retains inbound updates while a native edit is open. `SharedTextBuffer` keeps
the painted revision, text and per-unit origin offsets. Each native target range
replaces those origins, including replacements with identical text. Its plan
contains only the changed spans; it does not infer targets by comparing strings.

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
dirty native typing before another local command enters the session, including
status, scalar and structural commands. Any remaining stale-base outcome has the
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
there; composition commits on completion or before another local command.

Paints wait while native intent is held. Successful commit releases the reason,
drains arrivals, maps the caret through native anchors, then repaints and refreshes
the base. Cancel releases and repaints even when the model string did not change.
An unproved native difference is reported and retained rather than guessed.
`composition.ts` is unchanged; the shared Writer handlers own this interval.

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
