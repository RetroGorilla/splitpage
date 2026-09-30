# Actions

An action is one thing a person can ask the app to do, with one definition
that every surface uses: the File menu, the command menu, a keyboard shortcut,
a button, and the desktop app's native menu (which clicks the File menu item).

## The registry

`src/application/actions.ts` holds the registry. A definition has a stable
`id`, a `label`, a `group` (the command menu's heading), an optional `icon`,
`keys` (chords such as `mod+alt+h`; `mod` is Control or Command), search
`words`, an `availability()` and a `run(source)`.

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

Each surface decides how to show a refusal. The File menu and the buttons
show it as a toast through `showRefusal()` (`12-dirty-toast.js`), which ends
the reason with a full stop: a reason is written as a menu line ("Close the
open dialog first") and a toast is a sentence. The command menu shows it greyed out with the reason. A shortcut
leaves the key to the browser. A key that a focused control already handled
(`defaultPrevented`) never reaches a global action.

Two definition options shape the shortcut binding. `claimKeys` keeps the key
from the browser even when the action is refused, so Ctrl+S and Ctrl+O never
open the browser's own Save page or Open file dialogs. `bindKeys` says, at the
moment of the key press, whether the page binds the keys at all: in the desktop
app the native menu's accelerators own Ctrl+S, Ctrl+Shift+S and Ctrl+O, so the
page leaves them alone and nothing runs twice. The command menu shows the keys
either way. `keys` may be a function, read each time: Help shows F1 only in
the desktop app, whose menu binds it.

`src/legacy/menu-items.ts` reads a File menu item's hidden and disabled state
(and the reason it shows), and its current label, for actions whose
availability the menu still decides. `label` may be a function too: Servers
shows the connected host, Save to file the imported file's name.

`visible: false` only keeps an action out of the command menu. It still runs
from a surface that has it: the desktop app's native menu reaches items the
File menu hides (Google Drive, Present in browser), and their handlers explain
the refusal themselves.

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
File menu path shows the reason as a toast.

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
| `settings`, `servers`, `help`, `tour`, `setup` | File menu, command menu, desktop menu (F1 for Help) | Capture-phase File menu listeners in `20s-settings.js`, `20e-connect.js`, `20c-help.js` and `20b-onboarding.js`; `18d-command-menu.js` |
| `about`, `tagging-help`, `export-app-data`, `import-app-data` | File menu, command menu, desktop menu | `18-local-files.js` dispatch, `18d-command-menu.js` |
| `long-demo` | Command menu (the New Tab page's link stays its own) | `18d-command-menu.js` |
| `new`, `paste`, `gdoc-import`, `drive-open`, `save-back`, `autosave`, `export-again`, `server-open`, `server-publish` | File menu, command menu, desktop menu | `18-local-files.js` dispatch, `18d-command-menu.js` |
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
