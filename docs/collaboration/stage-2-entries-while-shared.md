# Entries while shared (C8)

## Entry decisions

- A rejected duplicate-identity stamp returns before changing the written-out
  flag, copying history, announcing an identity or showing the copy notice.
  The BroadcastChannel case is tested through the real session and identity
  wiring, beside unchanged standalone reassignment.
- Automatic last-file resume is not permitted while shared (rule 74). Its named
  `lastFile.permitted` port takes the central `lastFileResume` capability. The check runs before stored
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

The shared `documentEntry` port performs leave-first admission. Feature callers
receive it by name. The canonical `capabilities` port keeps exactly the mode-only
forwarding on main. `entryCapabilities` consults `sessionEntryRefusal()` before
the mode answer, and is provided only to content intake and replacement routes.
Its fields come from the existing mode capability names, so a later entry read
also receives the gate. No reader takes a flag to choose between these roles.

Mixed owners receive both named ports. Merge apply and states use entry permission;
the report of a landed merge uses mode permission. Draft take, apply and file
restore use entry permission; notification, capture and flush use mode permission.
Stash read and accept use entry permission; stash save, clear and reload-guard
cleanup use mode permission. Version restore, reload and automatic resume use
entry permission; history snapshot and touch, saves and autosave use mode permission.
The merge banner paints an admitted report with mode permission and starts its
restore with entry permission. Cancelled merge-review UI also reads mode only.

The wrapped transition owner explicitly lists all of its methods. `open` and
`startNew` take leave-first admission; `recover` and `restore` take the same
central entry permission before any migration, identity or replacement work.
`copyId` reads identity without replacing the document. Standalone transition
behavior keeps its existing reentrancy; the shared leave-and-entry boundary holds commands.

Entry admission reads the existing command-hold state before the owner mode.
An entry-only scope covers the whole enter or leave, including settlement,
microtasks, standalone replacement notifications and rollback. It uses the same
hold stack as command and undo protection, without a separate in-flight flag.
Entry-only scopes preserve command settlement and enclosing command refusals.
An external entry during that scope refuses as `session-switching`. A leave-first
entry resumes after the switch scope has released; its admitted transition calls
the original assignment directly, while public re-entry during the switch remains guarded.
The switch's own adoption and standalone landing use its existing internal owner
door, rather than the public transition wrapper.

The entry matrix runs every listed entry in both the enter `docId` callback and
the leave replacement notification. It requires a named capability refusal,
unchanged document and revision, zero picker, file, permission, history, reload
snapshot, draft, fetch, routing and import-dialog access, and successful switch
completion. After leave a normal entry succeeds. Its structural census compares
both runtime methods and declared methods (including inherited capability fields)
against literal classifications, so a new transition or capability needs an audit.
Close and Present keep their existing non-replacement behavior and composed tests.

The caller census classifies every permission call site and every binding of the
two canonical ports. It includes receiving field names, so swapping mode and entry
ports in a mixed owner fails the inventory. An additional caller of either read
fails. The classifications are literal data in `shared-entry-callers.json`.

Six regression literals were observed failing before this split: a landed merge
lost dirty accounting, settlement lost autosave scheduling, a due autosave was
dropped, draft flush answered success without writing, and both leave-first
transitions lost their requested history snapshot. They now retain that admitted
work even when shared entry fails. Draft notification starts from an empty pending
queue, so its assertion cannot be satisfied by an earlier notification.

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

Standalone decisions and results stay unchanged. Mode-only capability forwarding
is identical to main and performs no entry-hold read. Save, Save As, conflict
overwrite and copy keep those mode-only ports; they are not document entries.
Typing path: a keystroke reads nothing new. Real text and comment edits, including
autosave scheduling and desktop draft effects, perform zero entry-hold reads.
Command admission keeps its existing single null check.
Entry admission also reads the mode; a direct open or New reads it twice.
Direct recovery and restore read the entry permission before their existing work.
A file opening adds token/Set bookkeeping and promise-completion handlers.
These entries are rare and off the typing, undo and save execution paths.
The only text used by the new admission is the existing notice:
"This is not available in a shared session yet."
The quiet automatic-resume capability names its shared-mode refusal
`last-file-resume-shared`; a switch hold returns `session-switching`.

The browser suites for real file-entry interaction belong to the hook cut; this
cut uses composed application tests without starting a browser.

## Assumed product rules

None.
