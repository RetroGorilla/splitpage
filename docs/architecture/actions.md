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

Each surface decides how to show a refusal. The File menu shows the reason as
a toast. The command menu shows it greyed out with the reason. A shortcut
leaves the key to the browser.

`src/application/shortcuts.ts` parses chords and finds the action a key event
names. `src/features/shortcuts/bind-shortcuts.ts` binds that to a keydown
target and returns a function that removes the listener.

## The legacy shim

Until the bootstrap of milestone 7 exists, one registry instance lives in
`src/legacy/app-actions.ts` for the numbered modules to share. Its `report`
rethrows the error on a microtask, so a failing action still reaches the
browser as an uncaught error, as it did before.

`src/legacy/document-actions.ts` defines the actions whose handlers are still
in `src/js`. `src/js/_entry.js` registers them and binds the shortcuts after
every module's `__init`. Registration lives in the entry because `21-events.js`
is inside the 63-module import cycle, and a migrated file imported from there
would join it (`npm run check:deps` refuses that).

## Migrated so far

| Action id | Surfaces | Old owner |
| --- | --- | --- |
| `toggle-hide-shot` | File menu, command menu, `mod+alt+h` | `18-local-files.js` dispatch, `18d-command-menu.js` menu mirror, a `21-events.js` keydown listener |
| `toggle-rundown-min` | File menu, command menu, the rundown's own button | `18-local-files.js`, `18d-command-menu.js`, `05f-rundown.js` click listener |
| `history` | File menu, command menu | `18-local-files.js`, `18d-command-menu.js` |

Browser suite `268-actions-every-surface.txt` checks each surface, and the
shortcut refused under a dialog. The File menu's markup (label, `data-keys`)
is still in `src/page.html`; the command menu reads the definition.

## Adding an action

1. Define it where its handler lives, and register it from the entry or the
   feature that owns it. Keep the returned disposer if the owner can unmount.
2. Make every surface invoke it by id. Do not add a second listener for its
   shortcut.
3. Extend `268-actions-every-surface.txt`, or a suite of the feature, to run
   it from each surface.
