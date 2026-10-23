# Script zoom ports

## Structure

`src/features/script-zoom/script-zoom.js` keeps the zoom math, key handling, wheel handling, anchoring and readout in JavaScript. Its mount receives four ports and returns its controls and a disposer. Disposal removes the listeners, preference subscription, animation frames and readout timer, and clears the ports.

`src/bootstrap/wiring/shared-ports.ts` builds the three shared ports once. Every call reaches the current owner through its bridge:

| Feature port | Type | Owner and wiring |
| --- | --- | --- |
| `screen` | `() => ScreenState` | `screenNow()` assembles the session, prompter, view flags and overlay state |
| `actions` | `Pick<ActionRegistry, "invoke">` | The shared `invoke` and `view` port forwards through `appActions` to the installed registry |
| `scale` | `Pick<Preferences, "scriptScale" \| "setScriptScale" \| "clearScriptScale">` | The feature wiring forwards to the current preferences owner |
| `changes` | `PreferenceChanges` | Each subscription installs the existing preference and storage listeners in the shared wiring and translates keys to preference names |

`PreferenceChanges` and `PreferenceNotice` live beside `Preferences`. Notices contain `name`, `value` and `elsewhere`. Script zoom reads the owner again for changes from another window and keeps suppressing its own synchronous persistence notice.

The screen types, constants and pure availability rules move from `src/legacy/screen.ts` to `src/application/screen.ts`. The stateful launcher context and DOM queries stay in legacy. All existing rule importers point to application directly.

The feature imports no bridge, numbered file, adapter or other feature. Its former preference storage details and separate document, prompter and writer reads are replaced by the ports. There are no numbered importers to convert in this rework; the initial move already removed them.

`src/features/script-zoom/actions.ts` owns the three definitions. Their controls come through the wiring's `owned()` holder. Actions are unavailable before mounting and after stopping. Bootstrap registers them after Share in the existing order: `script-zoom-in`, `script-zoom-out`, `script-zoom-reset`. The action-order test pins the complete existing registration order.

The named `mountScriptZoomFeature` re-export replaces the wiring alias. Its entry call remains between read time and target. `stopApp` does not stop this entry-mounted feature.

The feature mount tests use shared fakes and jsdom without starting the app. Existing app-level assertions are retained. The load-only target count increases from 81 to 84 for the new application rules, feature definitions and shared wiring; numbered-module and frozen-import counts remain exact at 55 and 59.

## Rule 8 status

The JavaScript move and its ESLint browser-globals entry were already present. The dependency baseline already contains no script-zoom `legacy-file`, `loop-import` or `cycle-edge` entries, so there is nothing to prune and no exception is added.

The numbered-file count stays at 55. No typing-path or desktop-port call is introduced by this rework.
