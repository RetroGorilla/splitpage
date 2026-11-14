# Entries while shared (C8)

## Completed independently of the leave port

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

## Blocked leave-first integration

The requested base is switch head `2f4927822`. Its
`leaveSharedSession(ports: SharedSwitchPorts)` needs the caller's ports, including
the binding lifecycle, standalone capabilities, migration and id source. The
switch retains no caller ports, `sharedSessionParts()` returns only handle,
session, undo and author, and no app factory builds `SharedSwitchPorts`.
Consequently `documentTransitions()` and the file-entry wiring cannot obtain
the current switch's leave operation.

C8 needs a current-session leave callback backed by the ports used for entry,
or an explicit way for the switch caller to supply that callback to the entry
wiring for the session's lifetime. The switch is unchanged. No replacement
leave sequence or default refusal policy is introduced here.

Open, New, inbound open, plain Open and manual resume still need that connection,
their failure/refusal tests and their deliberate-defect mutants. This includes
external prompter links that open a file; reading the current projection through
Present is already covered. No PR is opened until C4 is merged and this branch
has merged `origin/main`.

## Assumed product rules

None.
