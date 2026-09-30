# Actions

An action is one thing a person can ask the app to do, with one definition
that every surface uses: the File menu, the command menu, a keyboard shortcut,
a button (the header's, the Writer's, the Settings dialog's, the setup
wizard's, the Servers dialog's), and the desktop app's native menu.

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
| `command-menu` | Ctrl+K closes an open command menu; the native menu's Search commands leaves it open (`run` looks at its source) |

Two others differ by action rather than by surface, as in 3.1: the
Production and Gear buttons say "Still loading..." and the B-roll button does
not wait for the document at all. `tests/legacy/while-loading.test.ts` checks
the loading cases against the real definitions (the browser suites cannot
reach a page that is still loading); `278-commands-as-before.txt` checks the
rest, and passes against 3.1's code too.

Each surface decides how to show a refusal. A surface that says why calls
`invokeFrom(id, source)` (`12-dirty-toast.js`) rather than `invoke`: it
invokes the action and shows a refusal as a toast, ending the reason with a
full stop (a reason is written as a menu line, "Close the open dialog first",
and a toast is a sentence). The File menu, the header and Writer buttons, the
rundown's button, the Servers dialog's Collaborate button and a command run
from the command menu all use it, so no refusal is dropped. The command menu
shows a refusal greyed out with the reason before anything runs. Two
surfaces stay silent, as they were before the registry: a shortcut leaves the
key to the browser, and the header's Search button does nothing (in 3.1 it
called `openCommandMenu()`, which returned quietly). A key that a focused
control already handled (`defaultPrevented`) never reaches a global action.

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
review session and the desktop app, and passes against 3.1's code too.

`src/application/shortcuts.ts` parses chords and finds the action a key event
names. `src/features/shortcuts/bind-shortcuts.ts` binds that to a keydown
target and returns a function that removes the listener.

## The legacy shim

Until the bootstrap of milestone 7 exists, one registry instance lives in
`src/legacy/app-actions.ts` for the numbered modules to share. Its `report`
rethrows the error on a microtask, so a failing action still reaches the
browser as an uncaught error, as it did before.

`src/legacy/this-document-actions.ts` (the command menu's "This document"
group), `file-actions.ts`, `view-actions.ts`, `help-actions.ts` and
`share-actions.ts` define the actions whose handlers are still in `src/js`.
`src/legacy/screen.ts` names what can refuse an action (still loading,
Present, the Writer, a dialog, the tour) with the reason a person is shown; it
imports nothing from `src/js`, so the numbered modules can import it without
joining their import cycle.

`src/legacy/screen-state.ts` is the one bridge to the global state `S`: it
answers `screenNow()` (still loading, Present, the Writer, the tour) and
`inDesktopApp()`. No other file under `src/legacy/` imports `S`; an action
file that needs to know something `S` holds asks the bridge, so the day `S`
goes, one file changes.

A dialog (`dialog`, any open `.modal-backdrop`) and the open command menu
(`launcher`) are separate blockers, because the shortcuts never treated them
alike: Save, Save a copy, Open and Export are refused behind the command menu,
while Find and Hide shot scenes act behind it (Find then takes the focus, and
the command menu closes). While the command menu reads what to list, it asks
through `askingFromLauncher()`, so each action is judged as it will be once
the menu has closed to run it. `src/js/_entry.js` registers them and binds the shortcuts after
every module's `__init`. Registration lives in the entry because `21-events.js`
is inside the 63-module import cycle, and a migrated file imported from there
would join it (`npm run check:deps` refuses that).

## Refusals are the same on every surface

Decided 30 September 2026: an action is refused under the same conditions
whichever surface asks, and those conditions are the ones the keyboard
shortcuts already used. Before this, the desktop app's native menu and its
accelerators went through the File menu path, which checked only that a
document had loaded, so they acted over an open dialog, the Writer or
Present where the browser shortcut refused. They now refuse too, and the
File menu path shows the reason as a toast. 3.1.x gets the same change from
#273 (`275-menu-refused-under-overlay.txt`), which passes on this code; it is
the only change of behavior the move to the registry keeps.

## The desktop app's native menu

`runDesktopMenuCommand` (`20f-desktop.js`) receives a command name from
`desktop/main.js` and runs the action of that id with the source
`"native-menu"`, reading no rendered state. Its six header commands
(`save`, `toggle-production`, `toggle-gear`, `toggle-comments`, `write`,
`present`) name the header buttons' actions and close an open File menu, as
the click on the button they used to send did. Every other command goes
through `handleFileMenuAction(id, "native-menu")`, what choosing the File
menu item does: it closes the setup wizard and the File menu, remembers an
export, and invokes the action. Refusals are shown as toasts, except where
the File menu would show the item greyed out (Collaborate for a link guest,
Paste a script in a review session, the server items, Save while a save
runs): the native menu cannot grey an item out, and in 3.1 it did nothing
there, so `greyedOut()` and `itemAvailability()` (`src/legacy/menu-items.ts`)
give such a refusal no reason for that source, and the native path does
nothing at all for a refusal without one. The script zoom commands and the
export formats are not actions yet and keep their own paths.

`280-other-surfaces.txt` checks the Settings buttons, the wizard's links and
these native menu rules, against 3.1's code too.

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
| `settings`, `servers`, `help`, `tour`, `setup` | File menu, command menu, desktop menu (F1 for Help); Servers, Help and Tour also from the Settings dialog's and the setup wizard's buttons | Capture-phase File menu listeners in `20s-settings.js`, `20e-connect.js`, `20c-help.js` and `20b-onboarding.js`; `18d-command-menu.js`; direct calls in `20s-settings.js` and `20b-onboarding.js` |
| `about`, `tagging-help`, `export-app-data`, `import-app-data` | File menu, command menu, desktop menu; Tagging reference and app data also from the Settings dialog | `18-local-files.js` dispatch, `18d-command-menu.js`, `20s-settings.js` direct calls and File menu clicks |
| `long-demo` | Command menu (the New Tab page's link stays its own) | `18d-command-menu.js` |
| `new`, `paste`, `gdoc-import`, `drive-open`, `save-back`, `autosave`, `export-again`, `server-open`, `server-publish` | File menu, command menu, desktop menu; Google Drive also from the Settings dialog | `18-local-files.js` dispatch, `18d-command-menu.js`, a `20s-settings.js` File menu click |
| `collaborate` | File menu, command menu, header Collab button, the Servers dialog's button | `18-local-files.js`, `18d-command-menu.js`, `13b-collaborate.js` and `20e-connect.js` click handlers |
| `set-target` | Command menu | `18d-command-menu.js` |
| `prompter-open-in-browser`, `prompter-open-in-chromium` | File menu, command menu, desktop menu (Ctrl+Shift+P) | `18-local-files.js`, `18d-command-menu.js` |

The File menu's export formats (`export-pdf` and the rest) still dispatch in
`18-local-files.js`; milestone 5's format registry takes them over. The New
Tab page's buttons are different actions (a blank new script, paste as a new
script, open into this tab) and stay its own.

Browser suites `268-actions-every-surface.txt`,
`269-file-actions-every-surface.txt`, `270-save-open-every-surface.txt` and
`272-view-actions-every-surface.txt`, `273-help-actions-every-surface.txt` and
`274-more-actions-every-surface.txt` check each surface, and the
shortcut refused under a dialog. The File menu's markup (label, `data-keys`)
is still in `src/page.html`; the command menu reads the definition.

## Adding an action

1. Define it where its handler lives, and register it from the entry or the
   feature that owns it. Keep the returned disposer if the owner can unmount.
2. Make every surface invoke it by id. Do not add a second listener for its
   shortcut.
3. Extend `268-actions-every-surface.txt`, or a suite of the feature, to run
   it from each surface.
