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
counted port. Rule 29 is implemented in the Writer binding slice, not this mapper.

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
