# Features: ports and wiring

How a feature folder connects to the rest of the app: the rules for its ports, its wiring and its actions, and the shared ports it builds from. The L5 migration that moved every numbered file into feature folders is finished; its proposal, move order and per-file inventory are in git history (`git show c73b1f8b:docs/architecture/feature-ports.md`).

## In short

- A feature folder takes everything it needs through named ports passed to its mount, and never imports another feature (Rule 5).
- Connections many features share (read the document, show a notice, read a preference) are built once as **shared ports** under `src/bootstrap/wiring/ports/`. A feature builds its ports from them and designs only the connections that are really its own (Rule 2).
- The wiring module for each feature builds those ports from the real owners and mounts it; the composition root mounts every feature in a fixed order (Rule 4).

## Words used here

| Word | Meaning |
| --- | --- |
| Numbered file | A file in `src/js/` whose name starts with a number, such as `05-render.js`: the old app code |
| Bridge | A file in `src/legacy/` that handed numbered files an owner through a function call, such as `currentDocument()` or `showToast()`, and threw before the app started. Each went when its last numbered importer did, and the rest when the wiring took the owners from ports (plan §8). One is left: `app-actions.ts` |
| Owner | The one module that holds a piece of state and is the only way to change it: the document session, the preferences, the save coordinator, the row drag. Owners live in `src/application/` |
| Feature | A folder in `src/features/` for one part of the screen. It may import `src/core/`, `shared/`, `src/application/` and `src/features/common/`. It may not import a bridge, a numbered file, an adapter or another feature (`layerAllows` in `tools/dep-report.mjs`) |
| Port | What a feature needs from outside, written as a TypeScript interface the feature declares. The feature says what it needs and doesn't know who provides it |
| Shared port | A port type several features use, defined once |
| Wiring | The code in `src/bootstrap/wiring/` that builds a feature's ports from the real owners and starts the feature ("mounts" it). Mounting returns a `dispose` function that removes the feature's listeners |
| Action | A named thing the app can do, such as `script-zoom-in` or `go-to-scene`, registered in the action registry (`src/application/actions.ts`) and run from menus, keys, the command menu or code |
| Fake | A small stand-in for a port in a test, such as a notices fake that records messages instead of drawing them |
| Crossing | One import between a moved file and something it may no longer import. Each crossing becomes a shared port, an owner port, an action, a callback or a common helper |

## The pattern

### Rule 1. A move keeps the file's code

A move PR changes how a file is connected, not how it works, so it keeps the diff readable and the behaviour unchanged. A moved file may keep its module variables, but:

- its ports arrive only through its mount (`start<Name>(ports)` in a moved file, where `<Name>` says what it starts, such as `startFind` or `startTagPanels`; never `__init`, which numbered files in `src/js/` still use), and `dispose` removes its listeners and timers and clears the ports;
- every export other than the mount is either a pure helper (no state and no ports; better placed in `src/core/`, `shared/` or `src/features/common/`) or used only by files in the same feature folder and by tests.

Code written new in a feature uses a factory instead: `create<Name>(ports)` returns an object with the feature's methods and `dispose`, and keeps its state inside, as `createSidePanels` does in L3f. Turning a moved 1,000-line file into a factory is its own later PR, not part of the move.

### Rule 2. A port is built from shared ports, owner types and the feature's own needs

A feature's `ports.ts` has three kinds of field:

| Kind | Example | Rule |
| --- | --- | --- |
| Shared port | `document: DocumentReader`, `notices: NoticePort` | Use the type from the [catalog](#the-shared-ports), narrowed with `Pick` to what the feature calls |
| Owner type | `rowDrag: Pick<RowDrag, "dragging" \| "end">` | Use the owner's own interface, narrowed. Never retype an owner's methods by hand |
| The feature's own | `onPainted: (what: Painted) => void` | Named for what the feature needs or tells, not for where the wiring gets it |

A port never carries:

- a pure helper or a constant: the feature imports it from `src/core/`, `shared/` or `src/features/common/`;
- a function of another feature or a numbered file: that becomes an action, an owner or a callback ([Rule 5](#rule-5-features-reach-each-other-four-ways)), or, while that numbered file hasn't moved yet, a field shaped for the need (Rule 5, "Calls into a file that moves later");
- storage keys, DOM event names or `storage` events: those are the owner's business, and the feature hears about changes through the owner's `onChange`;
- a field the feature doesn't use. The typecheck can't catch this, so the reviewer does.

The two moves, reworked:

| Move | Now | With the pattern |
| --- | --- | --- |
| Script zoom (#730) | `hasDocument`, `prompterIsOpen`, `runAction`, `scriptScale`, `setScriptScale`, `clearScriptScale`, `isScriptScaleKey`, `preferenceEvent`, `writerOpen` | `screen` (loading, prompter and writer, from [P6](#the-shared-ports)), `actions: Pick<ActionRegistry, "invoke">`, `scale: Pick<Preferences, "scriptScale" \| "setScriptScale" \| "clearScriptScale">`, `changes: PreferenceChanges` |
| Rundown | 17 fields: `currentDocument`, `readSession`, `productionReaders`, `cellOf`, `cacheSeal`, `cssAttr`, `revealRow`, `clearDropMarkers`, `draggingRow`, `endRowDrag`, `moveRow`, `reviewMode`, `runAction`, `rundownMin`, `setRundownMin`, `isRundownMinKey`, `preferenceEvent` | 8 fields: `document: DocumentReader`, `text: Pick<TextServices, "cellOf" \| "productionReaders" \| "cacheSeal">`, `rowDrag: Pick<RowDrag, "dragging" \| "end">`, `cells: Pick<CellEditing, "moveRow">`, `review: Pick<ReviewFacts, "reviewing">`, `actions: Pick<ActionRegistry, "invoke">`, `minimized: Pick<Preferences, "rundownMin" \| "setRundownMin">`, `changes: PreferenceChanges`. `cssAttr` comes from `features/common/`. `revealRow` becomes a `reveal-row` action the rows register, which the rundown runs through `actions`. `clearDropMarkers` leaves the port: the row-drag owner announces when a drag ends (`onEnd`), and the rows clear their own markers then. Today the rundown calls `rowDrag().end()` and `clearDropMarkers()` back to back (`05f-rundown.js:930`) |

### Rule 3. Where ports live

| What | Where |
| --- | --- |
| A port only one feature uses | `src/features/<name>/ports.ts` |
| A shared port whose owner already has an interface | The owner's own type, imported from where the owner defines it, such as `NoticePort` in `application/effects/ports.ts`, `Preferences` in `application/preferences/preferences.ts`, `ActionRegistry` in `application/actions.ts`, `SidePanels` in `application/side-panels.ts` (L3f) |
| A shared port with no owner interface yet | A new interface beside its owner in `src/application/` |
| Something an adapter provides (the desktop, the picture store) | An interface in `src/application/` shaped for what features need, which the adapter satisfies. A feature may not import even a type from `src/adapters/` |
| Markup and page helpers with no state that two features need | `src/features/common/` |

There is no separate catalog folder. This document's [catalog](#the-shared-ports) is the index, and each entry names where its type lives.

A feature imports from `src/application/` only types and pure functions, such as command builders (`sceneLengthCommand`) and rules. Owners with state, such as `prompter-state.ts`, come in through ports, so a test can fake them.

### Rule 4. How the wiring mounts

- **One wiring module per feature**, `src/bootstrap/wiring/<name>.ts`. It exports `mount<Name>Feature()` and `stop<Name>Feature()`, built on `owned()`, and the feature's action definitions if it has any ([Rule 6](#rule-6-features-own-their-action-definitions-bootstrap-owns-their-order)). It doesn't export `__init` and doesn't re-export the feature's functions.
- **Shared ports are built by responsibility** under `src/bootstrap/wiring/ports/`. Feature wiring imports the individual objects it needs directly from their modules; there is no central builder or compatibility barrel. Each object forwards to its owner or bridge at call time, so it can be built once and still follows a restart. Importing a port module does not start an owner, install a listener, or configure a bridge. The bootstrap load manifest tests every module in isolation.

  | Module | Ports |
  | --- | --- |
  | `actions.ts` | Action invocation and availability |
  | `document.ts` | Document reads and subscriptions |
  | `editing.ts` | Document edits, undo control and editor selection |
  | `text.ts` | Rich-text services and tag-body rewriting |
  | `preferences.ts` | Preference changes, view flags and preference values |
  | `screen.ts` | Current screen facts |
  | `effects.ts` | Notices, menu items and clipboard |
  | `location.ts` | Document location and review facts |
  | `saving.ts` | Save state and operation ownership |
  | `transitions.ts` | Document transitions |
  | `files.ts` | Export registry, last file and file delivery |
  | `desktop.ts` | External links, recent files and launch facts |
  | `pictures.ts` | Picture storage |
  | `production.ts` | Production index and delete confirmation |
  | `panels.ts` | Side-panel control |
  | `startup.ts` | Startup readiness, draft resume and seed checking |
  | `identity.ts` | IDs and clock |

  The split preserves the existing implementations, including `text.ts`'s tag-body rewriting. Moving that logic to its final owner remains a separate audit follow-up. Port contract types remain with their application or core owners. The remaining `06-rows.js` video-file functions are now owned by the gallery feature and supplied through an explicit bootstrap port; see [rows-video-files.md](rows-video-files.md). The retired `sharedPorts()` references in the original wave schedule below describe how those PRs first landed, rather than an API for new work.
- **Start position.** A moved file's slot in the composition root's start list (`src/bootstrap/main.ts`) is replaced, at the same position, by a call to its wiring's mount, imported from that wiring module. `tests/bootstrap/composition-root.test.ts` pins the list. (Until the composition root replaced `_entry.js`, the entry reached each mount through a named re-export in `bootstrap/wiring.ts`; those re-exports are gone.) A move PR doesn't move the mount into `startApp` (`bootstrap/app.ts`): that would change when the feature starts, which is a behaviour change.
- **Stopping.** Features mounted from the composition root's list are not stopped by `stopApp`, just as the numbered files they replace were not. The last L5 step turns that list into a wiring step, which stops them in reverse order.

### Rule 5. Features reach each other four ways

A feature never imports another feature, and nothing outside its own folder, the wiring and the tests imports it. When one feature needs another, it is one of four things:

| It needs to | Way | Examples |
| --- | --- | --- |
| Make another feature do something | Run that feature's action by id through `actions.invoke(id, source, input)` (the `input` argument arrives with L3g), or use the side-panels port for panels | `go-to-scene`, `annotate-picture` (L3g); `sidePanels.open("comments-panel")` (L3f); the new `reveal-row` |
| Know some state | Read the state's owner through a port. If only a feature holds the state today, it moves to an owner first, as L3b did for area state | rundown minimised: `preferences.rundownMin()`; a person's colour: the person-colours port; find open: `viewFlags.findOpen()` |
| React when something happens elsewhere | Subscribe to the owner's announcement, or, when one feature produces the event, give it an output callback (`onPainted`) that the wiring connects to the other feature | the session's change announcements; the render's paint announcements from L3e PR 4 (#714), which the wiring passes on to the panels |
| Use the same markup | A stateless helper in `src/features/common/` | `cssAttr`; the stateless parts of `editableCellHtml` and `slotPoster` |

A quick test: if feature B is about to call `a.something()`, then A does something (an action), A knows something (an owner), or A tells something (a callback).

### Rule 6. Features own their action definitions; bootstrap owns their order

- A feature's action definitions (id, label, icon, words, keys, availability, run) live in `src/features/<name>/actions.ts`, as a function that takes what the actions control and returns `ActionDefinition[]`. For the rundown that is `rundownActions(rundown: { minimized(): boolean; toggle(): void })`, with the `RundownMinimizer` interface moving from `legacy/this-document-actions.ts` into the feature. Availability uses the screen port ([P6](#the-shared-ports)) and the pure rules from `application/screen.ts`.
- The action registry lists actions in the order they were registered (`list()` reads a `Map`), and the command menu shows that order. So `src/bootstrap/actions.ts` holds the one ordered list, and puts each feature's definitions where they were before. The legacy `register…Actions(registry)` functions become `…Actions(): ActionDefinition[]` as they are touched, so bootstrap can place a feature's definitions between two legacy ones without splitting files.
- A test pins the order: `tests/bootstrap/action-order.test.ts` (new, in Wave 0) checks the registered ids, in order, against today's list. A move that changes the order fails it.
- An action's `run` reaches the feature through its wiring's `owned()` holder. While the feature isn't mounted, the action's availability is `{ enabled: false }`, so the registry refuses it instead of calling into nothing.

### Rule 7. Tests build features with fakes

- Each moved feature gets `tests/features/<name>/mount.test.ts`, which builds the feature with fakes and jsdom (`tests/features/editing/jsdom.mjs`, or `tests/features/view-harness.ts` for the full page) and no app, as `tests/features/script-zoom/mount.test.ts` does. The test runner already requires a test beside every feature folder that holds TypeScript.
- Fakes for the shared ports are written once, in `tests/features/fakes.ts` (new): a document reader holding a given document, notices that record what they were asked to show, preferences in memory that announce changes, an action runner that records what it ran, ids from a counter, a fixed clock. They implement the shared types, so the typecheck keeps them in step with the real ports.
- The app-level tests in `src/test/` keep checking the real wiring end to end. A move changes only their import paths and its own `tests/bootstrap/load-order/<area>.json` manifest, never their assertions. The manifest's `expectedLoads` pins its isolated-import coverage; the shared test files and area catalog do not change for moves within an existing area.

### Rule 8. What a move PR contains

1. Before the move, in its own PR: if other areas read state the file holds, that state moves to an owner (Rule 5). A move PR doesn't create owners.
2. `git mv` of the file to its destination, kept as JavaScript (with its path added to the browser-globals list in `eslint.config.mjs`). Converting it to TypeScript is a separate PR.
3. `ports.ts` built per [Rule 2](#rule-2-a-port-is-built-from-shared-ports-owner-types-and-the-features-own-needs), using shared ports that exist, or adding the ones it is the first user of ([catalog](#the-shared-ports)).
4. The wiring module, the composition root slot and the action definitions per Rules 4 and 6.
5. Every importer of the moved code updated in the same PR (no re-exports, AGENTS.md rule 4).
6. `tests/features/<name>/mount.test.ts`, plus fakes for any new shared port.
7. `tools/dep-baseline.json`: resolved entries pruned; nothing added.
8. The "Structure" section: which responsibility moves where and which dependency it removes.
9. Gates: lint, types, `check:deps`, `check:comments` and the file's tests; one perf-ab run if the file is on the typing path (Adam's lighter rule of 2026-10-23); the desktop smoke if it calls the desktop port.

**Opus or Codex.** A move is Opus when the moved code *does* one of: run on the typing path, record or replay undo, save, recover or keep drafts, bring a document in (open, import, paste, merge, server, starters), talk to the preload bridge, or handle close and quit. A move is Codex-safe when the code only *calls* those through a port that has already landed, unchanged. The PR lists each such call so the reviewer, who is Opus anyway, can check it.

## The shared ports

Each is built in its responsibility module under `src/bootstrap/wiring/ports/` from the owners and, until they retire, the bridges. Each lands with the first move that needs it, not on its own, because a port nobody uses yet moves no responsibility. A port marked Opus lands in an Opus PR: with the first Opus move that needs it, or, when Codex moves need it first, in its own Opus PR before them. A Codex move only uses an Opus port after it has landed. "Files" counts the numbered files that import the bridge names it replaces.

| Port | Type and where it lives | What a feature gets | Built from | Files | Lands with | Who |
| --- | --- | --- | --- | --- | --- | --- |
| P1 Document reader | `DocumentReader`, new, `application/session/document-reader.ts` | `current()`, `read(select)`, `onChange(listener)`, `onReplaced(listener)`, `onRefresh(listener)` | session bridge: `currentDocument` (which returns the document guard's read-only view when the guard is on), `readSession`, `onSessionChange`, `onDocumentReplaced`, `onRefresh` | 40 | rundown | Opus: it is how 40 files will read the document, and it must keep the guard's view |
| P2 Notices, menu items, clipboard | `NoticePort`, `MenuItemPort`, `ClipboardPort`, which exist in `application/effects/ports.ts` | as they are | effects bridge | 29 | help | Codex |
| P3 Preferences | `Preferences` and `ViewFlags`, which exist, narrowed with `Pick`; plus `PreferenceChanges`, new beside them: `onChange(listener)` with `{ name, value, elsewhere }`, where `elsewhere` is true when another window made the change | | preferences bridge. The `splitpage:pref` and `storage` listeners move into the port; each subscription adds the same two listeners the feature added before, so order and timing don't change | 28 | script zoom | Codex, with Opus review and three gates, because this is cross-window input over stored settings: browser suite `133-clock-format` (it changes the clock by sending a raw `splitpage:pref` event), `src/test/preferences-callers.test.mjs`, and a new test that one raw `splitpage:pref` event and one `storage` event each reach a `PreferenceChanges` subscriber exactly once |
| P4 Actions | `Pick<ActionRegistry, "invoke" \| "view">`, which exists | | `appActions` | 11 | script zoom | Codex |
| P5 Review | `ReviewFacts`, new, `application/collaboration/review.ts`: `reviewing()`, `refuseInReview()` (shows the viewing-only notice and returns true, as `reviewBlocked` does). `VIEWING_ONLY` moves there from `legacy/review-wording.ts` | | location bridge | 19 | rundown | Codex |
| P6 Screen | `ScreenState` and its pure rules (`availableUnless`, `inFront`, `everyOverlayBut`, `firstRefusal`, `EVERY_OVERLAY`) move from `legacy/screen.ts` to `application/screen.ts`; the port is `screen(): ScreenState` | | `screenNow()` (`legacy/screen-state.ts`), which the wiring assembles | 5 legacy action files, the native menu and the command menu, and script zoom | script zoom | Codex |
| P7 Ids and clock | `IdSource` and `Clock`, which exist in `core/document/ports.ts` | | `adapters/identity/ids.ts` | 17 | first user | Codex |
| P8 Text services | `TextServices`, which generalises `ExportServices` (`application/export/services.ts`) into `application/text/services.ts`: `cellOf`, `scriptCellOf`, `fromHtml`, `inertBody`, `sanitize`, `storedHtmlFromDom`, `imageRefOf`, `htmlToMarkdown`, `htmlToPlainText`, `videoCard`, `productionReaders`, `cacheSeal`. `ExportServices` becomes a `Pick` of it | | richtext, plain-text, document-ports and cache-freeze bridges. The same objects as today, so caches and the frozen-cache run behave as before, as in L4b | 24 | rundown | Opus: cell decoding runs on the typing path |
| P9 Document edits | `DocumentEdits`, new, `application/session/document-edits.ts`: `run(command)`, `edit(command)` (throws on failure, as `runDocumentEdit` does), `allowed()`, `stamps`, `text` | | session bridge: `runCommand`, `runDocumentEdit`, `editAllowed`, `sessionStamps`, `sessionTextPorts`, `REVIEW_ONLY` | 17 | read time | Opus: edits and undo |
| P10 Editing page | The owner types that exist in `application/editing/`: `CellEditing`, `PaintGuard`, `EditorSelection`, `RowDrag` (gains `onEnd`), `FocusMemory`, `DeleteConfirmation` | narrowed | editor and production-editing bridges | 18 | rundown | Opus: the editing hot path |
| P11 Undo control | `UndoControl`, new, `application/editing/undo-control.ts`: `breakCoalescing()`, `flush()`, `undo()`, `redo()`, `last()` | | `12a-undo` until it becomes the undo owner (Wave 2) | 13 | read time | Opus: undo |
| P12 Operation ownership | `Operations` (`capture`, `stillOwns`), which exists in `application/session/operation.ts`: whether an async job still owns the document it started on | | transition bridge | 8 | its own Opus PR before `05w` (Codex), since `05e` waits on P11 | Opus: async work against a replaced document |
| P13 Picture store | `PictureStore`, new, `application/media/picture-store.ts`: intern, persist, read and render stored pictures | | `adapters/storage/02c-blobs.js` | 16 | its own Opus PR before `05w` (Codex), since `05e` waits on P11 | Opus: durable storage |
| P14 Side panels | `SidePanels`, from L3f (`application/side-panels.ts`) | | panels bridge | 6 | help | done in L3f |
| P15 Save status | `SaveState`, `application/save/save-state.ts` (named so because `SaveStatus` is the status line's view in `status.ts`): `unsaved()`, `busy()`, `onChange(listener)`, `dueNow()`, `resume()`; `sharedPorts().saves` | read only, plus "autosave now" and "resume autosave" | save bridge | 16 | its own PR; first used by copy, paste and scene selection (`05h` asks for an autosave now) | Opus |
| P16 Document place | `DocumentPlace`, new, `application/location/`: where the document lives, the server's status, and `arrivingOnLink()` (whether this page opened from a share link, used by `20a`, `20b` and `20j`), read only | | location bridge, and `arrivingOnLink` from `13-hosted` until it moves | 30 | its own PR at the start of Wave 3, since the first Wave 3 users (`13a`, `13b`, `20b`) are Codex | Opus |
| P17 File delivery | `FileDelivery`, new, `application/files/file-delivery.ts`: `deliver(filename, data, options)` saves a file for the person and says whether it was saved, with the same saved or failed notice | | file-delivery bridge, which calls `adapters/files/deliver.ts` | 6 | onboarding (`20b`) | Codex, with the desktop smoke: on the desktop the adapter saves through the preload bridge, and the port only forwards to it |
| P18 Draft resume | `DraftResume`, which exists in `application/recovery/draft-resume.ts`, narrowed. Onboarding and new tab need only `restorePending()` | | recovery bridge (`draftResume()`), forwarded at call time | 5 | onboarding (`20b`) | Codex for the read-only `restorePending()`. The Opus moves of `13`, `20f` and `20g` widen the `Pick` |
| P19 Seed check | `SeedCheck`, new, beside `seedCheckMatches` in `application/preferences/seed-check.ts`: `passes()`, true while the page still holds its untouched starting document | | seed-check bridge | 3 | onboarding (`20b`) | Codex |
| P20 Document transitions | `Transitions` (`application/transitions/transitions.ts`), narrowed. The destination type and `NO_DESTINATION` move from `legacy/transition-bridge.ts` to `application/transitions/ports.ts` | | transition bridge (`documentTransitions`) | 6 | its own Opus PR, before `18b` and `20j` (Wave 3) | Opus: bringing a document in |
| P21 Production index | `ProductionIndexOwner` (`core/production/index.ts`), narrowed | | production-index bridge, as `sharedPorts().production`, which forwards each call at call time | 4 | its own PR; first used by b-roll records (`08c`) | Opus: the tag ghost reads it on every keystroke |
| P22 Export formats | `ExportRegistry` (`application/export/registry.ts`), narrowed | | export-formats bridge | 3 | the first of `18c` and `18d` | Codex |
| P23 Startup signal | `StartupSignal` moves from `legacy/startup-bridge.ts` to `application/startup-signal.ts`: `ready()` | | startup bridge (`startupReady`) | 3 | the first of `20` and `20j` | Opus, with that move |
| P24 Launch facts | `LaunchFacts`, new, beside `runningOnDesktop` in `application/desktop-presence.ts`: `firstTabOfLaunch()`, `hadPriorSession()`, `launchIntent()`, `hasDraftToRestore()`, `appVersion()` (`20h`), and `sessionInfo()` (`getSessionInfo`, `13b` and `20f`), read only | | `desktopPort()` (`adapters/desktop/desktop-port.ts`), read at call time | 6 (`13b`, `20b`, `20f`, `20g`, `20h`, `20j`) | onboarding (`20b`) | Codex, with the desktop smoke |
| P25 Last file | `LastFile`, new, `application/files/last-file.ts`: `load()`, the file handle stored from the last session. The Opus moves of `14` and `18` add `remember(handle)` | | `loadLastFileHandle` in `00-prelude` until it moves (Wave 4) | 3 (`18`, `20b`, `20j`) | onboarding (`20b`) | Codex for the read-only `load()` |
| P26 External links | `ExternalLinks`, new, beside `runningOnDesktop` in `application/desktop-presence.ts`: `available()` (the desktop offers `openExternal`) and `open(url)`, which opens the address in the system browser. Callers keep their own `runningOnDesktop()` checks and browser fallbacks | | `desktopPort().openExternal`, read at call time | 4 (`06`, `11`, `13`, `20a`) | the first of `06` and `20a` | Codex, with the desktop smoke |
| P27 Recent files | `RecentFiles`, new, `application/files/recent-files.ts`: `list()`, `remove(fileId)`, `clear()`, `read(id)` and `routeOpen(request)` | | `desktopPort()`: `listRecents`, `removeRecent`, `clearRecents`, `readFile`, `routeOpen` | 4 (`18`, `18b`, `20f`, `20j`) | the first of `18b` and `20j` | Opus: opening files brings a document in |
| P28 Desktop video | `DesktopVideo`, new, beside P13 in `application/media/`: `grant(file)`, `open(token)`, `thumbnail(host, ref)` | | `desktopPort()`: `grantVideoFile`, `openVideoFile`, `videoThumbnail` | 2 (`05v`, `06`) | gallery (`05v`) | Opus, with the gallery |
