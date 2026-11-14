# Entries while shared (C8)

## Entry decisions

- A rejected duplicate-identity stamp returns before changing the written-out
  flag, copying history, announcing an identity or showing the copy notice.
  The BroadcastChannel case is tested through the real session and identity
  wiring, beside unchanged standalone reassignment.
- Automatic last-file resume is not permitted while shared (rule 74). Its named
  `lastFile.permitted` port reads the current owner. The check runs before stored
  handle lookup and after handle lookup, permission and file reading. The same
  check reaches `openProjectFile` and `loadFileIntoEditor`, including a switch
  while project or import parsing waits (D12). This automatic startup work shows
  no notice, following the automatic-step rule in the merge/stash disable plan.
- The composed D13 test reaches `restoreMergeSnapshot` and the history card
  through real wiring. Both refuse before history access or a transition, and
  the card shows the existing history reason. Draft recovery stays refused and
  kept, with identical shared bytes and undo.
- Present opens the prompter from the shared projection without leaving or
  changing shared bytes or undo.

- Open, New, starters, the demo, import, drop, recent files, inbound files,
  desktop open-with, manual resume and external prompter links leave first
  (rule 77). A held binding refuses the entry before history, reset, identity,
  local file access or fetching an external script. The existing shared-mode
  notice is shown and the shared document and undo are unchanged.
- Reload remains refused before local file access. Shared edits do not mark a
  local file unsaved and do not ask an unsaved question on close (rule 60).

## Structure

The switch retains the ports used by its successful entry.
`leaveRunningSharedSession()` delegates to its existing leave sequence without
requiring entry callers to reproduce those ports. An explicit leave with other
ports also uses the retained ports: they own the mounted bindings. Rollback and
completed leave release them; a refused or pre-landing failed leave keeps the
running session and its ports for a retry, as the existing fault model requires.

The shared `documentEntry` port performs that admission. Feature callers receive
it by name. `documentTransitions().open` and `startNew` also use it, so a direct
caller cannot adopt over a shared owner. Standalone transition behavior keeps its
existing reentrancy; the shared leave-and-entry boundary holds commands.

Pending openings belong to the existing transition `Started` lifetime. Each
tracked operation has an epoch token, retired on completion, failure, cancellation
or document replacement. Old completion cannot clear a later operation's token
or a new lifetime. Synchronous results and promise identity stay unchanged.
`openingStatus` exposes only the read through a `Pick`. The switch reads that
port before settling and after its microtask, refusing with `opening-pending`
before constructing a shared document. File open, import, draft resume and
desktop open-with have composed pending-to-landing literals; manual resume,
plain Open, Recent reads and the external prompter fetch use the same lifetime.

## Hook connection

The hook must provide `openingStatus` as `SharedSwitchPorts.opening`. The pending
check is currently composed in the switch's `refusedNow`; the hook's remaining
entry refusals continue through its `refusal` port. The switch owns the leave
ports, so file-entry callers need no hook-owned accessor or binding defaults.

## Standalone and interface text

No standalone typing, undo or save path gains work. Opening paths gain admission
and transient opening metadata, without changing their decisions or results.
The only text used by the new admission is the existing notice:
"This is not available in a shared session yet."

The browser suites for real file-entry interaction belong to the hook cut; this
cut uses composed application tests without starting a browser.

## Assumed product rules

None.
