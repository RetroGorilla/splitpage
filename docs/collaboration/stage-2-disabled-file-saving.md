# Shared sessions and local file saving

Package 13 detaches save destinations and file autosave through `CapabilityPort`.
`SHARED_SESSION_DISABLED` declares their refusal reasons. The running app still
creates standalone sessions; this package does not activate the shared owner.

## Session and save lifetimes

A session's mode never changes. `startSessionBridge` captures its mode answers,
and `currentCapabilities` returns the same frozen port and frozen answer objects
throughout that session's life. Common `edit` and `comment` answers remain live.
Replacing the session through `adoptReplacement` can install another captured
capability port. Mutating a supplied port cannot change the mode of a live session.

A save takes its mode answers at entry. Later checks inside that save use those
answers, including the Save As path after waiting for bundle copies. Import
write-back and conflict-copy continuations retain their entry permission and
their existing ownership checks. They do not consult the replacement's mode.

Replacement does not wait for saving. An already captured standalone file save
finishes with its captured document, selected target and registered writer.
The coordinator judges its landing obsolete through ownership and epoch. The
replacement does not receive the old save's stamps, baseline, target or handle
reminder. Retarget rollback also requires ownership. A Save As replaced while
bundle copies drain has not captured yet: it cancels before holding undo or
capturing the replacement document. An existing undo hold releases according to
the undo owner's original document and epoch, as on standalone replacement.

Late conflict presentation checks the session epoch, not the destination captured
when the request queued: Save As can move a queued Save to its new target without
replacing the session. That queued Save still presents its own conflict.

`save/session-replacement.test.ts` exercises the real `documentTransitions().open`
and `adoptReplacement` path for save, force, auto, autosave, Save As, a late picker
and a pending bundle drain. The session-answer test pins the immutable public
surface. Switching a live session's mode answers during `ensureBytes` is therefore
not reachable through that surface. Replacement during `ensureBytes` is supported
and finishes the captured write; it does not drop that write on a capability recheck.

Existing late automatic-save conflict and failure paths may halt the current
autosave policy and show the old save's diagnostic after standalone replacement.
They neither schedule a write nor adopt a target. This package preserves that
existing behavior; shared scheduling independently refuses through its capability.

## Package 14 obligations

Entering or leaving a shared session must replace the session through the
`adoptReplacement` lifetime boundary, selecting its owner and concrete mode
capabilities together. It must not mutate a live session's answers or give the
session the forwarding port that reads the active bridge. Shared entry detaches
the previous local destination and cancels its pending autosave scheduling.

Keep the existing transition and save ownership rules: no new settlement step,
no asynchronous mode-transition requirement, and no cancellation of a file write
that has already captured. Old save completion cannot adopt a target, remember a
handle or update the new shared session. New shared save attempts refuse before
capture, destination selection, timers, standalone undo or file access.

## Inventory and limits

`standalone-save-callers.test.ts` inventories destination and autosave boundaries
by declaration, including `AutoSavePolicyPorts.timers` and `TimerPort.start`.
A new scheduling caller
names its file in the failure. Reflective writer lookup returning an untyped
callback is a declared limit beside the typed scanner's other limits, with a
literal test in `standalone-untyped-callers.test.ts`.
