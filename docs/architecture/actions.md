# Actions

An action is one thing a person can ask the app to do, with one definition
that every surface uses: the File menu, the command menu, a keyboard shortcut,
a button (the header's, the Writer's, the Settings dialog's, the setup
wizard's, the Servers dialog's, the New Tab page's), and the desktop app's
native menu.

## The registry

`src/application/actions.ts` holds the registry. A definition has a stable
`id`, a `label`, a `group` (the command menu's heading), an optional `icon`,
`keys` (chords such as `mod+alt+h`; `mod` is Control or Command), search
`words`, an `availability(source)` and a `run(source)`.

`invoke(id, source)` checks availability and returns one of:

| Outcome | Meaning |
| --- | --- |
| `ran` | The handler ran |
| `unavailable` | Not allowed now; carries the reason a person is shown |
| `unknown` | No action has that id |
| `failed` | The handler threw; the registry's `report` function received the error |

A handler may return a promise (`run` returns `void | Promise<void>`). The
outcome is then `ran` as soon as it starts, and a rejection reaches `report`
with the action's id, so an asynchronous failure is reported the same way as
a synchronous one rather than disappearing into a discarded promise.

`availability` is told which surface asks. `view(id, source)` and
`list(source)` default to `"command-menu"`, the command menu being the one
reader of a view. An action is meant to be allowed and refused alike on every
surface, and almost every definition ignores the source. The exceptions keep
differences the surfaces had in 3.1, which 4.0 does not change:

| Action | Difference kept from 3.1 |
| --- | --- |
| `save` | Its buttons and the native menu (which clicked the header's Save) do not wait for the document to load; Ctrl+S does |
| `toggle-rundown-min` | The rundown's own button does not wait for the document to load; the File menu and the native menu do |
| `write` | In a review session the command menu reads "Viewing only — the writer changes the script"; the button and the native menu say "Viewing only — you can comment on this script, but not change it." |
| `find` | With the bar already open, Ctrl+F only puts the focus back in it and selects its query; the File menu, the command menu and the native Edit menu open the bar again, taking the selected words as the query (`run` looks at its source; `286-find-from-every-surface.txt`) |
| `command-menu` | Ctrl+K closes an open command menu; the native menu's Search commands leaves it open (`run` looks at its source). The header's Search button is refused without a reason, so nothing is shown, as `openCommandMenu()` returned quietly in 3.1 |

Two others differ by action rather than by surface, as in 3.1: the
Production and Gear buttons say "Still loading..." and the B-roll button does
not wait for the document at all. `tests/legacy/while-loading.test.ts` checks
the loading cases against the real definitions (the browser suites cannot
reach a page that is still loading); `278-commands-as-before.txt` checks the
rest, and passes against the code before the registry (4.0-development
47c0309) too.

Showing a refusal is a port of the registry. `presentRefusals(presenter)`
installs the one presenter and returns its disposer; `invoke` hands every
refusal to it with the surface that asked, and `view`/`list` never do. The
bootstrap installs `presentRefusal` (`src/bootstrap/actions.ts`), which shows
a refusal as a toast through `showRefusal()` (`12-dirty-toast.js`), ending
the reason with a full stop (a reason is written as a menu line, "Close the
open dialog first", and a toast is a sentence), for every surface but a
shortcut, which leaves the key to the browser. A refusal without a reason
shows nothing. So every caller in `src/js` just calls `appActions.invoke()`
and none of them imports the toast module for it, and no refusal is dropped:
the File menu, the header and Writer buttons, the rundown's button, the
Servers dialog's Collaborate button, the Settings and wizard buttons, the
native menu and a command run from the command menu all show theirs. The
command menu also shows a refusal greyed out with the reason before anything
runs. A key that a focused control already handled (`defaultPrevented`)
never reaches a global action.

Two definition options shape the shortcut binding. `claimKeys` keeps the key
from the browser even when the action is refused, so Ctrl+S and Ctrl+O never
open the browser's own Save page or Open file dialogs. `bindKeys` says, at the
moment of the key press, whether the page binds the keys at all: in the desktop
app the native menu's accelerators own Ctrl+S, Ctrl+Shift+S and Ctrl+O, so the
page leaves them alone and nothing runs twice. The command menu shows the keys
either way. `keys` may be a function, read each time: Help shows F1 only in
the desktop app, whose menu binds it.

An availability never reads what the page last rendered. The File menu
repaints its items only when it opens, so a shortcut, the command menu's own
reading or the desktop app's native menu would otherwise act on a stale
rendering. Where the File menu shows an item hidden, greyed out with a reason
or relabelled, one function in the module that owns that state decides it,
and both the menu's painting and the action's availability call it:

| State | Function |
| --- | --- |
| Paste a script, greyed out in a review session | `pasteItemState()`, `18b-file-menu.js` |
| Open from the server, Put this script on the server | `serverOpenItemState()`, `serverPublishItemState()`, `13-hosted.js` |
| Save to file, and its label | `saveBackItemState()`, `18-local-files.js` |
| Export again, and its label | `exportAgainItemState()`, `18c-export-dialog.js` |
| The Servers label | `serversMenuLabel()`, `20e-connect.js` |
| Present in browser, Chromium speech, Google Drive, Import app data | `canOpenPrompterInBrowser()`, `canOpenPrompterInChromium()`, `driveOpenShown()`, `appDataImportShown()`, `20f-desktop.js` |
| Autosave's switch | `autoSaveEnabled`, `14-export.js` |
| Save while a save is running | `saveInProgress()`, `src/legacy/screen-state.ts` |
| Collaborate | `collaborateBlockedReason()`, `13b-collaborate.js` |

`src/legacy/menu-items.ts` turns such a state into an availability. `label`
may be a function: Servers shows the connected host, Save to file the
imported file's name. `276-availability-follows-state.txt` changes the state
with the File menu closed and checks that the command menu and the native
menu follow it.

`visible: false` only keeps an action out of the command menu. It still runs
from a surface that has it: the desktop app's native menu reaches items the
File menu hides (Google Drive, Present in browser), and their handlers explain
the refusal themselves. Export again is never listed (its availability always
says `visible: false`), because the 3.1 command menu did not offer it.

## The command menu

`18d-command-menu.js` lists `appActions.list()` each time it renders, with
nothing cached between openings, plus the export formats, which are not
actions until milestone 5's format registry. `LIST_ORDER` there keeps the 3.1
order. An action it does not name is listed after the named ones, in the
order it was registered, under its own `group`; a group the command menu does
not know is listed after the known groups. So an action registered anywhere
shows up in the command menu with no edit to it. The command menu never lists
its own action, `command-menu`. `tests/legacy/command-palette.test.ts` checks
this against the real registry instance; `279-command-menu-listing.txt` pins
the whole listing, key chips, switch states and icons in the browser, a
review session and the desktop app, and passes against the code before the
registry (4.0-development 19c66f7 and 47c0309) too.

`src/application/shortcuts.ts` parses chords, names them canonically
(`chordKey()`) and finds the action a key event names; a key event with no
`key` (Chrome's autofill sends one) matches nothing. `register()` refuses a
chord another action already declares, so no first match can win silently.
A chord holds `mod` or `alt` unless its key is a function key (F1 to F24);
`parseChord()` refuses one like `k` or `shift+k`.
`src/features/shortcuts/bind-shortcuts.ts` binds that to a keydown target and
returns a function that removes the listener; `mount.ts` is the feature's
mount, which the bootstrap calls. The binder passes over a keydown with no
Control, Command or Alt held that is not a function key (`canBeShortcut()`)
before it asks the registry for its shortcuts, so typing never reaches the
lookup, and asks once for any other keydown. A key whose action ran, or
threw, is kept from the browser, as 3.1's handlers did by calling
`preventDefault` first; a refused one only when the action claims its keys.

## The legacy shim

Until the bootstrap of milestone 7 exists, one registry instance lives in
`src/legacy/app-actions.ts` for the numbered modules to share. Its `report`
rethrows the error on a microtask, so a failing action still reaches the
browser as an uncaught error, as it did before.

`src/legacy/this-document-actions.ts` (the command menu's "This document"
group), `file-actions.ts`, `view-actions.ts`, `help-actions.ts`,
`share-actions.ts` and `zoom-actions.ts` define the actions whose handlers are
still in `src/js`. `src/legacy/screen.ts` names what can refuse an action
(still loading, Present, the Writer, a dialog, the open command menu, the
tour) with the reason a person is shown; it imports nothing from `src/js`, so
the numbered modules can import it without joining their import cycle.

`src/legacy/screen-state.ts` is the one bridge to the global state `S`: it
answers `screenNow()` (still loading, Present, the Writer, the tour),
`inDesktopApp()` and `saveInProgress()`. No other file under `src/legacy/` imports `S`; an action
file that needs to know something `S` holds asks the bridge, so the day `S`
goes, one file changes.

A dialog (`dialog`, any open `.modal-backdrop`) and the open command menu
(`launcher`) are separate blockers, because the shortcuts never treated them
alike: Save, Save a copy, Open and Export are refused behind the command menu,
while Find and Hide shot scenes act behind it (Find then takes the focus, and
the command menu closes). While the command menu reads what to list, it asks
through `askingFromLauncher()`, so each action is judged as it will be once
the menu has closed to run it.

## Starting and stopping

`src/bootstrap/actions.ts` owns the lifetime and the composition.
`startActions(registry, keyTarget)` installs the refusal presenter, registers
every group of actions, hands the desktop app's native menu its runner
(`runMenuCommandsWith(nativeMenuRunner(registry))`) and mounts the shortcuts
feature (`mountShortcuts()` in `src/features/shortcuts/mount.ts`, one
`keydown` listener on the target). It keeps every disposer and returns the
function that undoes them all in reverse; `stopActions()` calls it. Starting
again while started is refused, so neither a listener nor an action can be
doubled. If a step throws (a group declaring an id or a chord already taken),
the steps already done are undone in reverse and the error is rethrown, so
the actions are left unstarted and can be started again. Each group
registers through `registerAll()` (`src/application/actions.ts`), whole or
not at all.

These are supplied here, rather than imported where they are used, so that no
numbered module gains an import inside their 60-module cycle: the toast module
reaches the registry as its presenter, and the native menu's routing (which
needs the File menu's close and `handleFileMenuAction`) reaches `20f-desktop.js`
as a runner. Two more rules follow the same principle. The setup wizard closes
when a File menu item is chosen by registering with `onFileMenuChoice()` in
`18-local-files.js`, which it already imported. The Settings dialog shows
Import app data when the `import-app-data` action is visible, asking the
registry rather than `20f-desktop.js`.
`src/js/_entry.js` calls `startActions(appActions, window)` after every
module's `__init`. It lives in the entry because `21-events.js` is inside the
60-module import cycle, and a migrated file imported from there would join it
(`npm run check:deps` refuses that). `tests/bootstrap/start-actions.test.ts`
starts, stops and starts again on the real definitions and finds one listener
and no leftover action each time; `tests/features/shortcuts/mount-shortcuts.test.ts`
does the same for the feature alone.

No listener left in `src/js` handles a chord the shortcuts feature binds:
the old Ctrl+S, Ctrl+Shift+S, Ctrl+O (`18b`), Ctrl+E (`18c`), Ctrl+K (`18d`),
Ctrl+F and Ctrl+Alt+H (`21-events.js`) listeners are gone, and a search of
every `keydown` listener finds no other one for those keys. One overlap is
older than the registry and kept: in Present, the prompter's own listener
flips the text on F whatever modifiers are held, so Ctrl+F there flips it and
opens Find, as in 3.1. In the desktop app, Ctrl+S, Ctrl+Shift+S and Ctrl+O
belong to the native menu's accelerators (the page does not bind them), Ctrl+E,
Ctrl+F and Ctrl+K to the page (their accelerators are not registered), and
Ctrl+Alt+H to both: the page runs it and keeps the key, and only when the page
refuses does the accelerator's command run, and refuse again with a toast.

## Refusals are the same on every surface

Decided 30 September 2026: an action is refused under the same conditions
whichever surface asks (but for the setup wizard, below), and those
conditions are the ones the keyboard shortcuts already used. Before this, the
desktop app's native menu and its accelerators went through the File menu
path, which checked only that a document had loaded, so they acted over an
open dialog, the Writer or Present where the browser shortcut refused. They
now refuse too, and the File menu path shows the reason as a toast. 3.1.x gets the same change from
#273 (`275-menu-refused-under-overlay.txt`), which passes on this code; it is
the only change of behavior the move to the registry keeps. As in #273, an
open dialog is checked first, so with a dialog over the writer or Present the
toast names the dialog ("Close the open dialog first."); the writer's reason
is "Close the writer first.". The toast that follows a link being turned off
offers Save a copy…, which calls `saveDoc({ saveAs: true })` itself rather
than the registry, so a dialog in front of it cannot refuse it.

One order from 3.1 is kept against the rule, for the setup wizard. Choosing
a File menu item, from the File menu or from the desktop app's native menu,
runs the `onFileMenuChoice()` listeners (`18-local-files.js`) before the
action is asked whether it can run, and the wizard's listener closes the
wizard. So with the wizard open, the native menu's Open (or any other File
menu item, Save a copy and Export among them) closes the wizard and runs,
while Ctrl+O is refused with the wizard as the open dialog. The wizard is the
only dialog that listens there. A native command that is not a File menu
item (the six header commands, the script zoom commands) does not take that
path. `280-other-surfaces.txt` pins the native Open against Ctrl+O, and
passes against 47c0309 too.

## The desktop app's native menu

`runDesktopMenuCommand` (`20f-desktop.js`) receives a command name from
`desktop/main.js` and hands it to the runner the bootstrap supplied,
`nativeMenuRunner()` in `src/legacy/native-menu.ts`, which runs the action of
that id with the source `"native-menu"`, reading no rendered state; a command
the runner does not know (an export format) clicks its File menu item as
before. Its six header commands
(`save`, `toggle-production`, `toggle-gear`, `toggle-comments`, `write`,
`present`) name the header buttons' actions and close an open File menu, as
the click on the button they used to send did. A command that is a File menu
item goes through `handleFileMenuAction(id, "native-menu")`, what choosing
that item does: it closes the setup wizard and the File menu, remembers an
export, and invokes the action. Any other registered command (the script
zoom commands) runs as itself. Refusals are shown as toasts, except where
the File menu would show the item greyed out (Collaborate for a link guest,
Paste a script in a review session, the server items, Save while a save
runs): the native menu cannot grey an item out, and in 3.1 it did nothing
there, so `greyedOut()` and `itemAvailability()` (`src/legacy/menu-items.ts`)
give such a refusal no reason for that source, and the native path does
nothing at all for a refusal without one. The export formats are not actions
yet (milestone 5) and keep the File menu item's own dispatch.

`280-other-surfaces.txt` checks the Settings buttons, the wizard's links and
these native menu rules, against the code before the registry
(4.0-development 47c0309) too.

One side effect of 3.1's synthetic clicks is not kept. Ctrl+S, Ctrl+Shift+S,
Ctrl+O, a native menu command and a command run from the command menu used to
reach their handler by clicking a button or menu item, and that click also
reached the page's document-level click listeners: the File menu's (kept
explicitly: Save, Save a copy, Open, Export and the native header commands
close an open File menu) and the Production panel's tag menu's, which closed
an open tag menu. That last one is not reproduced; an open tag menu now stays
open when a command runs from the keyboard or a menu.

## Migrated so far

| Action id | Surfaces | Old owner |
| --- | --- | --- |
| `toggle-hide-shot` | File menu, command menu, `mod+alt+h` (Shift held too, as before) | `18-local-files.js` dispatch, `18d-command-menu.js` menu mirror, a `21-events.js` keydown listener |
| `toggle-rundown-min` | File menu, command menu, the rundown's own button | `18-local-files.js`, `18d-command-menu.js`, `05f-rundown.js` click listener |
| `history` | File menu, command menu | `18-local-files.js`, `18d-command-menu.js` |
| `find` | File menu, command menu, `mod+f` (Shift or Alt held too, as before) | `18-local-files.js`, `18d-command-menu.js`, a `21-events.js` keydown listener |
| `export` | File menu, command menu, `mod+e` | `18-local-files.js`, `18d-command-menu.js`, an `18c-export-dialog.js` keydown listener |
| `command-menu` | File menu, header button, `mod+k` (opens and closes) | `18-local-files.js`, `18d-command-menu.js` click and keydown listeners |
| `save` | Header and Writer Save buttons, command menu, `mod+s`, desktop menu | `21-events.js` button listeners, `18d-command-menu.js` button mirror, an `18b-file-menu.js` keydown listener |
| `save-as` | File menu, command menu, `mod+shift+s`, desktop menu | `18-local-files.js`, `18d-command-menu.js`, `18b-file-menu.js` keydown |
| `open` | File menu, command menu, `mod+o`, desktop menu | `18-local-files.js`, `18d-command-menu.js`, `18b-file-menu.js` keydown |
| `panel-production`, `panel-gear`, `panel-broll`, `panel-comments` | Header buttons, command menu, desktop menu | `21-events.js` and `08d-broll-panel.js` click listeners, `18d-command-menu.js` button mirror |
| `write` | Header button, command menu, desktop menu | `21-events.js` click listener, `18d-command-menu.js` |
| `present` | Header button, command menu, desktop menu | `21-events.js` click listener, `18d-command-menu.js` |
| `settings`, `servers`, `help`, `tour`, `setup` | File menu, command menu, desktop menu (F1 for Help); Servers, Help and Tour also from the Settings dialog's and the setup wizard's buttons; Servers (Join a shared session) and Tour also from the New Tab page | Capture-phase File menu listeners in `20s-settings.js`, `20e-connect.js`, `20c-help.js` and `20b-onboarding.js`; `18d-command-menu.js`; direct calls in `20s-settings.js`, `20b-onboarding.js` and `20j-newtab.js` |
| `about`, `tagging-help`, `export-app-data`, `import-app-data` | File menu, command menu, desktop menu; Tagging reference and app data also from the Settings dialog | `18-local-files.js` dispatch, `18d-command-menu.js`, `20s-settings.js` direct calls and File menu clicks |
| `long-demo` | Command menu (the New Tab page's link stays its own) | `18d-command-menu.js` |
| `new`, `paste`, `gdoc-import`, `drive-open`, `save-back`, `autosave`, `export-again`, `server-open`, `server-publish` | File menu, command menu, desktop menu; Google Drive also from the Settings dialog | `18-local-files.js` dispatch, `18d-command-menu.js`, a `20s-settings.js` File menu click |
| `collaborate` | File menu, command menu, header Collab button, the Servers dialog's button | `18-local-files.js`, `18d-command-menu.js`, `13b-collaborate.js` and `20e-connect.js` click handlers |
| `set-target` | Command menu | `18d-command-menu.js` |
| `prompter-open-in-browser`, `prompter-open-in-chromium` | File menu, command menu, desktop menu (Ctrl+Shift+P) | `18-local-files.js`, `18d-command-menu.js` |
| `script-zoom-in`, `script-zoom-out`, `script-zoom-reset` | Desktop View menu, Ctrl + "+" / "-" / "0" (not listed in the command menu) | `20f-desktop.js` via `runScriptZoomCommand`, the `05s-script-zoom.js` keydown listener |

The File menu's export formats (`export-pdf` and the rest) still dispatch in
`18-local-files.js`; milestone 5's format registry takes them over. The New
Tab page's Tour and Join a shared session run the `tour` and `servers`
actions (source `button`; neither can be refused, so nothing changed for
them). Its other buttons are different actions (a blank new script, a
starter, paste as a new script, open into this tab) and stay its own.

The export dialog's Collaborate… link is kept as it was: it closes the
dialog and clicks the File menu's Collaborate item through
`runExportAction()`, as the dialog's formats do. So it does nothing, and says
nothing, when that item was last painted greyed out (a link guest), where
invoking `collaborate` would show the reason in a toast. It moves with the
formats in milestone 5.

Browser suites `268-actions-every-surface.txt`,
`269-file-actions-every-surface.txt`, `270-save-open-every-surface.txt`,
`272-view-actions-every-surface.txt`, `273-help-actions-every-surface.txt`,
`274-more-actions-every-surface.txt` and `286-find-from-every-surface.txt`
check each surface, and the shortcut refused under a dialog.
`276-availability-follows-state.txt`, `277-refusals-say-why.txt`,
`278-commands-as-before.txt`, `279-command-menu-listing.txt`,
`280-other-surfaces.txt` and `281-script-zoom-commands.txt` check the rules
above; all but 276 pass against the code before the registry
(4.0-development 47c0309) too, as do 270 and 286. The characterisation
suites milestone 1 adds for the next slices, `282-editor-operations.txt`,
`283-save-status-by-destination.txt`, `284-exports-from-a-fixture.txt` and
`285-save-buttons-one-state.txt`, pass against it as well. The File menu's
markup (label, `data-keys`) is still in `src/page.html`; the command menu
reads the definition.

## Adding an action

1. Define it where its handler lives, and register it from the entry or the
   feature that owns it. Keep the returned disposer if the owner can unmount.
2. Make every surface invoke it by id. Do not add a second listener for its
   shortcut.
3. Extend `268-actions-every-surface.txt`, or a suite of the feature, to run
   it from each surface.

The command menu lists a new action by itself, under its `group`, unless its
availability says `visible: false`; the desktop app's native menu runs any
registered id it is sent; the shortcut feature binds any `keys` it declares.

### Worked example: the script zoom commands

The three script zoom commands were the first existing commands moved onto
the registry after the File menu and header ones, as a check that adding an
action needs only its own files. Before, the desktop app's View menu reached
them through a special case at the top of `runDesktopMenuCommand`
(`runScriptZoomCommand`), and Ctrl + "+" / "-" / "0" through
`05s-script-zoom.js`'s own keydown listener, each calling
`stepScriptScale()` / `resetScriptScale()` directly.

Files the move touched:

| File | Change |
| --- | --- |
| `src/legacy/zoom-actions.ts` (new) | The three definitions. Availability: the keys act only in the editor view (`scriptViewActive()`, as their listener checked); the View menu acts anywhere, as before. `visible: false`, as 3.1's command menu did not list them |
| `src/bootstrap/actions.ts` | One line: `registerZoomActions(registry)` |
| `src/js/05s-script-zoom.js` | Its keydown listener stays where it is (a document capture listener that matches `+`, `=`, `-`, `0` and their key codes, which a chord cannot express) but invokes the action by id and keeps the key only when it ran; `scriptViewActive()` is exported for the definitions; `runScriptZoomCommand()` is gone |
| `src/js/20f-desktop.js` | The special case and its import are gone; the generic path runs the id |

No other surface, feature or the command menu changed. The one change made
for it outside those files, in its own commit before the move, taught the
native menu that a registered command which is not a File menu item runs as
itself (every registered native command until then was a File menu item or a
header button). The runtime import cycle shrank from 61 to 60 modules, since
`20f-desktop.js` no longer imports `05s-script-zoom.js`. That routing has
since moved out of `20f-desktop.js` into `src/legacy/native-menu.ts`, which
the bootstrap supplies; a command added there the same way needs no edit to
either.

Tests run: `281-script-zoom-commands.txt` (new: the View menu's three
commands, the keys, both in the Writer, and not listed; 20/20 against
4.0-development 19c66f7, before the move and after it), `172-script-zoom.txt`
41/41, `134-settings.txt` 74/74, `135-settings-reload.txt` 22/22,
`21-desktop-shim.txt` 78/78, `279-command-menu-listing.txt` 15/15,
`174-scene-length-phone.txt` 20/20, and the unit tests.
