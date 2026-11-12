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
A stale-base refusal or failed command also retains the edit for retry or cancel.
Cancel discards local native intent and releases held arrivals. Destruction clears
the gate without applying held updates. Crash recovery is outside this in-memory
package; no durable continuation is claimed.

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
