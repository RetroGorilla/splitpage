# Milestone 7: wire frontend owners explicitly and verify 4.0

The working notes for milestone 7 of [the implementation plan](../IMPLEMENTATION-PLAN.md#7--wire-frontend-owners-explicitly-and-verify-40), narrowed by [the 2026-10-07 re-scope](milestones-4-7-rescope.md#milestone-7-keep-the-contract-drop-the-rewrite-adam-2026-10-07). The plan holds the scope and the gate. This file holds the two PRs, their file lists and tests, the gate evidence, the inputs plan §7's release checklist asks for, and, once each PR merges, what it built.

Status: planned. Derived from `ab93357`. Milestone 6's last code step, 6.9's second PR (deleting `21-events.js`, adding an app-level start and dispose), is in progress; this plan is written against its end state, and every place that depends on it says so. Nothing in milestone 7 starts before that PR merges.

## Goal

Every migrated owner is constructed by one explicit wiring step in `src/bootstrap/` that takes its dependencies as arguments, and nothing mounts until that step has finished. A missing or throwing dependency stops startup with a report instead of leaving a session that accepts edits and fans out nothing. The step's teardown releases what it built. `_entry.js` is named and documented as the legacy initializer shim, and a test keeps new code out of it.

Out of scope, as Adam decided on 2026-10-07 and reaffirmed on 2026-10-15: the composition root as build entry, removing unused `S` fields, a bridge-retirement campaign, and every other item in plan §8. They stay 4.x follow-ups. No user-visible behaviour changes.

## Models

Both PRs are Opus: they construct the session (state ingress) and own teardown (close and quit code). Each gets one independent Opus review. Neither touches preload or IPC.

## What milestone 6 leaves behind

Measured on `ab93357` with `node tools/dep-report.mjs --metrics`, `wc -l` and grep. Where 6.9's second PR changes a number, the expected value after it is given and 7.2 re-measures it.

**The shim.** `src/js/_entry.js` is 154 lines. It imports 70 numbered modules' `__init` and calls them in numbered order. Around those calls it does four pieces of wiring by hand: `startSaves(legacySavePorts(...))` before the first `__init`, then `startTransitions(...)`, `startRecovery(draftRecoveryPorts())` and `startActions(appActions, window)` after the last. Of the 74 numbered modules under `src/js/`, four are not started by the shim and load only as imports: `03c-history-idb.js`, `14c-export-projections.js`, `14d-export-text.js` and `14e-export-formats.js`. After 6.9's second PR deletes `21-events.js`, the shim starts 69 of 73.

**`src/bootstrap/` today.** `actions.ts` (52 lines): `startActions(registry, keyTarget)` registers the action groups, the native menu runner and the shortcut mount, undoes a partial start on a throw, and refuses a second start until stopped. `startup.ts` (65 lines) and `startup/` (four files, 134 lines), from 6.9's first PR (#613): `beginStartup(ports)` orders the desktop draft, the initial document, the page-lifetime registrations and desktop start, and `whenDocumentReady` dispatches it on DOM ready. 6.9's second PR adds the app-level start that mounts the features and owns the DOM-ready canceller. This plan calls it `startApp`; the name follows whatever that PR lands.

**The feature mounts.** 27 files under `src/features/` export a mount (`mount.ts`, `routes.ts` or a named owner such as `editing/focus.ts`). On `ab93357`, `21-events.js`'s `init()` constructs most of them with their ports; the exceptions are `mountBroll` (in `08d-broll-panel.js`), `mountTagEntityContainer` (in `20-teleprompter.js`) and `mountShortcuts` (in `src/bootstrap/actions.ts`). After 6.9's second PR, `startApp` constructs them. Milestone 7 does not move a mount; it gives `startApp` the wired owners it needs.

**What is still configured by load order.** These are the parts milestone 7 changes:

| Owner | Where it is created or configured today | How |
| --- | --- | --- |
| The document session | `src/legacy/session-bridge.ts`, module evaluation | `let current = startSession(...)` with ports that forward to a mutable `given` object |
| The session's dirty, draft, save, edit-capability and attribution effects | `12-dirty-toast.js`, module evaluation | `provideSessionEffects({...})` |
| The session's editor name | `03-sync.js`, module evaluation | `provideSessionEffects({ editorName })` |
| The idle refresh runner | `07-production-tags.js`, module evaluation | `provideRefreshRunner(runIdleRefresh)` |
| The derived-records reconciler | `08c-broll.js`, module evaluation | `provideRecordsReconciler(derivedRecordsPlan)`; the bridge's default returns `null`, so a missing provider is silent |
| Undo routing and adoption | `session-bridge.ts`, module evaluation | `routeReplays(...)` and `watchUndoAdoption(...)` into `12a-undo.js` through `undo-adapter.ts` |
| The command ports (`sessionStamps`, `sessionTextPorts`) | `session-bridge.ts`, module evaluation | frozen objects whose editor name reads `given` |
| The action registry | `src/legacy/app-actions.ts`, module evaluation | `export const appActions = createActionRegistry(...)` |
| The export registry and the built-in exporters | `src/legacy/export-formats.ts` and `14e-export-formats.js`, module evaluation | `createExportRegistry()`, then `registerBuiltInExporters()` at the bottom of 14e |
| The save coordinator, transitions and draft recovery | `_entry.js` | `start…(ports)` calls around the `__init`s |

Since 4.7 a session port that was never provided throws "The session's … port was not provided" ([session.md](session.md)) instead of doing nothing, so the re-scope's "accepts edits and fans out nothing" is now "throws on the first edit". The order problem is the same: correctness depends on which modules happened to load, and a test that loads part of the app must remember to wire what it uses (`wireSession` in `src/test/_fanout-stubs.mjs`).

## The steps, in order

| Step | Scope | Prerequisites | Model |
| --- | --- | --- | --- |
| 7.1 | The wiring step: construct the session, the bridges, the command ports and the registries with dependencies passed in; startup, partial-failure and cleanup tests; `_entry.js` named as the shim, with its test | 6.9's second PR merged, M6 gate recorded | Opus |
| 7.2 | Finish the wiring: remove every load-order configuration in the table above, INV-30's bootstrap test, docs, the release-checklist inventory; then the gate runs | 7.1 | Opus |
| Gate record | `milestone-7-gate.md`, a docs-only PR, as for milestones 3 to 6 | 7.2, the gate runs | Sonnet |

### 7.1 The wiring step

**Shape.** `wireApp(deps)` in `src/bootstrap/wiring.ts` returns a `Wiring` (the constructed owners) and its `dispose()`. `_entry.js` calls it once, before the first `__init`, where `startSaves` is called today, and passes the result to `startApp` after the last `__init`. `startApp(wiring)` takes the wiring as an argument, so nothing can mount before the wiring exists; that is the structural half of "every owner is wired before anything mounts", and the startup test is the executable half.

`wireApp` constructs, in this order, and records a disposer for each:

1. The action registry and the export registry (`createActionRegistry`, `createExportRegistry`), installed into the legacy facades below.
2. The session: `startSessionBridge(ports)` replaces the module-evaluation `startSession` call. The ports are passed in: entry (`migrateRows`), undo adapter, effects, capability, reconcilers, attribution, report and timers.
3. The command ports built from the same effects. `sessionStamps` and `sessionTextPorts` stay stable forwarding objects exported by the bridge, because numbered modules import them as bindings: their identity never changes across rewires, and what they forward to is the wiring's current effects.
4. Undo routing and adoption (`routeReplays`, `watchUndoAdoption`), called by `startSessionBridge` rather than at module evaluation.
5. The save coordinator, the transitions and the draft recovery, through the existing `startSaves`, `startTransitions` and `startRecovery`, moved out of `_entry.js` in their current order relative to each other.

`startActions` stays in `startApp`, because registering the action groups and mounting the shortcuts is a mount.

**Legacy facades.** The numbered modules keep their imports: 17 import `session-bridge.ts`, 15 `transition-bridge.ts`, 13 `app-actions.ts` and 4 `export-formats.ts` (counts include `21-events.js` and `_entry.js` on `ab93357`). `appActions`, `exportFormats` and the session bridge's exports become facades over the wired instances that throw "not started yet" before `wireApp` has run and after its `dispose()`, which is the pattern the save, transition and recovery bridges already follow (milestone 4). Rewriting those importers is 4.x.

**The built-in exporters.** `14e-export-formats.js` stops calling `registerBuiltInExporters()` at module evaluation, and `registerBuiltInExporters(registry)` takes the registry it fills. `_entry.js` passes it to `wireApp`, which calls it on the registry it built. This has to be in 7.1: once `exportFormats` throws before `wireApp`, the call at the bottom of 14e would throw while the bundle evaluates and the app would not load. It is the only module-evaluation use of `appActions`, `exportFormats`, `sessionStamps` or `sessionTextPorts` on `ab93357` (the review of this plan parsed every numbered module's top-level statements).

**Interim check for the load-order providers.** In 7.1 the four `provide…` calls still run at module evaluation. `wireApp` checks that each one has run before it constructs the session, and refuses otherwise, so 7.1 already meets the partial-failure contract. 7.2 removes the providers.

**Failure.** `wireApp` validates every dependency before constructing anything: a missing dependency throws a `WiringError` naming it. A dependency that throws while an owner is being constructed is caught, the owners already built are disposed in reverse order (as `startActions` does), and a `WiringError` naming the step and carrying the cause is thrown. `_entry.js` then reports it through `console.error` and does not call `startApp` or any `__init`, so no feature mounts. No new user-facing message is added (plan §1: no new features); see [decision 2](#decisions-taken).

**Cleanup.** `dispose()` releases in reverse construction order: the recovery, transition and save starts' stop functions; the session's `dispose()` (its subscribers and timers); undo routing; the registries emptied and uninstalled from the facades. After it, every facade throws "not started yet" and `wireApp` can run again.

**The shim.** `_entry.js` keeps its path (moving it would change the build entry, which is 4.x). It is named "the legacy initializer shim" in `dependencies.md`, `session.md`, `saving.md` and `actions.md`. `dependencies.md` gains a section with one row per module the shim starts (69 after 6.9's second PR): the module, the owner it is waiting for in 4.x (a feature folder, an adapter, or "composition root"), and the bridges it imports.

**Files.**

| File | Change |
| --- | --- |
| `src/bootstrap/wiring.ts` | new: `wireApp`, `Wiring`, `WiringError` |
| `src/js/_entry.js` | calls `wireApp` before the `__init`s and passes the wiring to `startApp`; its four hand-wired `start…` calls go |
| `src/legacy/session-bridge.ts` | `startSessionBridge(ports)` and its stop; no session, no undo routing at module evaluation; facade exports throw before start |
| `src/legacy/app-actions.ts`, `src/legacy/export-formats.ts` | facades over the wired registries |
| 6.9's `startApp` module in `src/bootstrap/` | takes `Wiring` and passes the registries and session to the mounts that need them |
| `src/js/14e-export-formats.js` | no registration at module evaluation; `registerBuiltInExporters(registry)` |
| `src/test/_app-boot.mjs`, `src/test/_fanout-stubs.mjs` | boot through `wireApp`; `wireSession` wires through `startSessionBridge` |
| the 34 test files under `src/test/` and `tests/` that import `legacy/session-bridge.ts` | each one that reads the session or runs a command without booting the app calls `wireSession` first; no assertion changes. The count of files actually changed is recorded in the PR |
| the 5 test files that import 14e, `export-formats.ts` or `app-actions.ts` (`export-registry-app`, `m4-matrix-exports`, `tour-interrupt-app`, `views-mount-app`, `tests/legacy/command-palette.test.ts`) | wire the registries they use through `wireApp` or a registry helper |
| `docs/architecture/dependencies.md` | the shim section and its owner table |
| `docs/architecture/milestone-7.md` | "As built" for 7.1 |

**Tests.**

- `tests/bootstrap/wiring.test.ts`
  - *Startup.* With fake ports, `wireApp` constructs every owner in the order above; `startApp` receives the wiring, and a probe mount registered by the test sees a started session, both registries and all three bridges started. The facades throw before `wireApp` and after `dispose()`.
  - *Failed partial startup.* For each dependency, a run with it missing and a run with it throwing: `WiringError` names it, every owner built before it is disposed (counted by the fakes), no facade is left started, and `startApp` is never reached. The interim check: a run where a `provide…` call has not happened refuses in the same way.
  - *Cleanup.* Wire, start, dispose, three times: one handler per window registration, no session subscriber or timer left (fake clock advanced and pending work settled before asserting, under milestone 4's production-cleanup rule), registries empty after each dispose, and the same owners after each rewire. App-lifetime subscriptions that legitimately survive are named in the test.
- `tests/bootstrap/legacy-shim.test.ts`: no file under `src/application`, `src/features` or `src/bootstrap` imports `src/js/_entry.js`, resolved through `tools/dep-report.mjs`'s resolver rather than a text search; and the shim's set of import specifiers is a subset of a frozen set, so nothing new registers into it (the set may only shrink). The frozen set, after 7.1 and unchanged by 7.2, has 72 members: the 69 numbered modules it starts, `14e-export-formats.js` (for `registerBuiltInExporters`), `../bootstrap/wiring.ts` and `startApp`'s module. Everything `_entry.js` passes to `wireApp` comes from those numbered modules (`legacySavePorts` from 14, `draftRecoveryPorts` from 20g, the document ports from 02b and 03, and in 7.2 the effects from 03, 07, 08c and 12); its imports of `app-actions.ts` and the three start bridges move into `wiring.ts`. The set compares specifiers, not imported names, so 7.2 adding a named import from 03 does not change it. This is [decision 1](#decisions-taken).
- Existing tests kept green unchanged in their assertions: `tests/bootstrap/start-actions.test.ts`, `tests/bootstrap/startup.test.ts`, `src/test/session-bridge-unwired.test.mjs` (its expectation moves from "port not provided" to "not started yet", with the same throwing behaviour), the boot tests (`*-boot*.test.mjs`, `session-bridge-app.test.mjs`), and the race matrix under `SPLITPAGE_M4_GATE=1`.

**Local evidence in the PR.** `npm run verify` on Node 24.22.0; `SPLITPAGE_M4_GATE=1 npm run verify`; the boot and startup suites of [testing.md](testing.md)'s change table for bootstrap changes, plain and with `SPLITPAGE_FREEZE_CACHES=1`.

### 7.2 Finish the wiring

**Scope.** No numbered module configures an owner as a side effect of being loaded:

- `12-dirty-toast.js` and `03-sync.js` export their session effects (`legacySessionEffects()`, `getEditorName`), `07-production-tags.js` exports `runIdleRefresh`, `08c-broll.js` exports `derivedRecordsPlan` (it already does), and `_entry.js` passes them to `wireApp`. The four `provide…` calls go, and so do `provideSessionEffects`, `provideRefreshRunner`, `provideRecordsReconciler` and the bridge's `given` object. 7.1's interim check goes with them. The records reconciler becomes a required dependency, so a missing one is reported instead of silently returning `null`.
- The initial load stops reaching into onboarding: `loadInitialDocument` in `02b-doc-id.js` reads `seedCheckPasses` from `20b-onboarding.js` today, which is the cycle edge recorded in `tools/dep-baseline.json` as "goes when bootstrap owns the initial load (milestone 7)". The seed check becomes a port of `openInitialDocument` (6.9's `startup/initial-document.ts`), passed in by the wiring, `02b` drops the import and `node tools/dep-report.mjs --prune` removes the entry. If 6.9's second PR leaves the load shaped so that this is not a port change, 7.2 instead rewords the entry's reason to name plan §8's composition root, and says so; either way no exception names milestone 7 after it.
- Tests that relied on module-evaluation providers (9 files call a `provide…` function, 3 use `wireSession`) wire explicitly through `wireSession` or `wireApp`.

**INV-30.** Its acceptance in [invariants.md](invariants.md#inv-30--the-setup-wizard-appears-only-over-a-pristine-copy) names this milestone: `13-onboarding.txt` passes with the wiring step, and a bootstrap test shows the wizard is never constructed when a document arrives by file, link or restore. The test goes in `tests/bootstrap/wiring.test.ts`, driving `startApp` with each arrival kind.

**Docs.** `session.md` (the bridge section: construction by the wiring step, the providers gone), `saving.md` (the start calls now in `src/bootstrap/wiring.ts`), `actions.md` ("The legacy shim" section), `milestone-4.md`'s note that milestone 7 moves the start calls, this file's "As built" for 7.2, and [the release-checklist inventory](#release-checklist-inputs) re-measured on 7.2's tree.

**Files.** `src/bootstrap/wiring.ts`, `src/js/_entry.js`, `src/legacy/session-bridge.ts`, `src/js/03-sync.js`, `src/js/07-production-tags.js`, `src/js/08c-broll.js`, `src/js/12-dirty-toast.js`, `src/js/02b-doc-id.js`, `src/bootstrap/startup/initial-document.ts`, `tools/dep-baseline.json`, `src/test/_fanout-stubs.mjs` and the test files that called a provider, `tests/bootstrap/wiring.test.ts`, and the docs above.

**Tests added.** In `wiring.test.ts`: each former provider omitted in turn is reported by `wireApp` (the records reconciler included); a session built by `wireApp` uses exactly the effects passed in (a probe effect counts one call per edit); INV-30's three arrival kinds. In `legacy-shim.test.ts`: no numbered module calls a bridge's configuration function at module evaluation, checked by importing each started module alone and asserting that no owner became started.

**Then the gate.** On 7.2's merged tree, with the record as its own docs PR.

## The gate

From plan §5 (milestone 7) and §4, on the closing tree. Evidence attached to the gate record:

| Requirement | Evidence |
| --- | --- |
| Completed frontend areas: acyclic dependencies, strict types, no authored comments, one document-mutation boundary | `npm run verify` on Node 24.22.0 (lint, typecheck, `check:deps`, `check:comments`, build, `sw.js` stamp, `test:all`) and `node tools/dep-report.mjs --metrics` output |
| Wiring tests: startup, failed partial startup, cleanup | `tests/bootstrap/wiring.test.ts` located by name and passing |
| Nothing migrated imports or registers into the shim | `tests/bootstrap/legacy-shim.test.ts` passing |
| Remaining legacy exceptions exact and visible | the dependency baseline unchanged or smaller, no new exception, no exception whose reason names milestone 7, and the inventory below |
| Resource release on replacement | carried from the milestone 4 and 6 gates; the race matrix with `SPLITPAGE_M4_GATE=1`, no previously passing case demoted or weakened |
| INV-30 | `13-onboarding.txt` and the bootstrap test passing |
| Full Windows browser runs | `run-tests.ps1`, plain and with `SPLITPAGE_FREEZE_CACHES=1`; `summary.txt` and `digest.txt` of both |
| Electron dev smoke | `node desktop/test/smoke.mjs` log, dev target |
| Windows x64 packaged check | not required: the build entry does not change and no packaging input moves. If either changes, it is required |
| External review | not part of this gate. Milestone 7's external review is folded into the 4.0 release gate's review, which covers milestones 5 and 7 together with milestone 6's own: the [re-scope Adam approved on 2026-10-07](milestones-4-7-rescope.md#updated-spec-for-the-rest-of-40) says so, plan §7 lists it, and Adam reaffirmed it on 2026-10-15 |
| Linux full run, native ARM64, Docker, portable, 3.1 exchange | the 4.0 release gate, not this one |

Then plan §7's release matrix runs before 4.0 is declared ready.

## Release-checklist inputs

Plan §7 asks the release to name the shim, the count of numbered modules it still starts, and the bridge files that remain with their owners. Measured on `ab93357`; 7.2 re-measures on its own tree and replaces these numbers.

**The shim:** `src/js/_entry.js`, "the legacy initializer shim". It starts 70 numbered modules on `ab93357` (69 once 6.9's second PR deletes `21-events.js`); four more numbered modules load only as imports. Runtime cycle: one, 48 modules and 357 edges. `S` assigners: 3 (`00-prelude.js`, `02b-doc-id.js`, `03-sync.js`).

**The bridges:** 23 files under `src/legacy/`, 1,379 lines. "Importers" counts numbered modules (and `_entry.js`); the right column is what keeps the file alive.

| File | Lines | Imported by | Kept by |
| --- | --- | --- | --- |
| `richtext.ts` | 60 | 23 numbered modules, 3 bridges | the editor and format modules still under `src/js/` |
| `session-bridge.ts` | 207 | 17 numbered (incl. `21-events.js`), `transition-bridge.ts` | every numbered module that edits or reads the session |
| `transition-bridge.ts` | 89 | 14 numbered (incl. `21-events.js`), `_entry.js`, `recovery-bridge.ts` | open, new, restore and publish callers in `src/js/` |
| `app-actions.ts` | 7 | 12 numbered (incl. `21-events.js`), `_entry.js` | numbered modules invoking actions by id |
| `document-ports.ts` | 42 | 7 numbered | state entry and format modules (`02`, `02b`, `03`, `07`, `14b`, `14c`, `15`) |
| `plain-text.ts` | 7 | 6 numbered | `08c`, `14b`, `14c`, `15`, `18a`, `19` |
| `save-bridge.ts` | 107 | 5 numbered, `_entry.js`, `transition-bridge.ts` | `03`, `12`, `13`, `14`, `18` |
| `export-formats.ts` | 3 | 4 numbered, `native-menu.ts` | `14e`, `18`, `18c`, `18d` |
| `review-wording.ts` | 1 | 4 numbered | `05h`, `06`, `13`, `19` |
| `cache-freeze.ts` | 18 | 3 numbered, 2 bridges | `05f`, `07`, `14b` |
| `recovery-bridge.ts` | 86 | 2 numbered, `_entry.js` | `03`, `20g` |
| `tour-pause.ts` | 18 | 2 numbered | `20c`, `20e` |
| `screen.ts` | 69 | 1 numbered, 7 bridges | `18d` and the action bridges |
| `screen-state.ts` | 26 | 6 bridges | the action bridges |
| `undo-adapter.ts` | 27 | `session-bridge.ts` | `12a-undo.js` |
| `menu-items.ts` | 21 | `share-actions.ts` | the share actions |
| `file-actions.ts`, `help-actions.ts`, `share-actions.ts`, `this-document-actions.ts`, `view-actions.ts`, `zoom-actions.ts`, `native-menu.ts` | 99, 121, 166, 55, 82, 20, 48 | `src/bootstrap/actions.ts` | action definitions that call numbered modules |

Owners: every bridge is owned by the integration owner until 4.x's bridge work (plan §8 item 2), which removes each with the legacy modules that keep it. The per-module owner table is `dependencies.md`'s shim section (7.1).

## Open question

For the external plan review.

**Where the wiring runs.** This plan takes: before the first `__init`, where `startSaves` is today, so the session exists before any module's init runs. Moving `startTransitions` and `startRecovery` ahead of the `__init`s is a reorder; their ports are built from module-evaluation values on `ab93357` (`liveDocumentPort`, `draftRecoveryPorts()` with its module-level writer id), and 7.1's boot tests confirm it. If one is found to need an initialized module, 7.1 splits the wiring into construct (before) and start (after), both inside `wireApp`'s lifetime.

## Decisions taken

Settled in this plan and its review; not reopened by the plan review.

1. **"Registers into the shim"** means the shim's set of import specifiers may only shrink (the frozen set in 7.1's tests), and, from 7.2, no numbered module configures a bridge at module evaluation. It is a test, not a dep-report rule, so a breach fails instead of becoming a baseline entry.
2. **A failed startup** reports the `WiringError` through `console.error` and leaves the static page with nothing mounted, as an exception in `_entry.js` does today (inferred, not measured). A visible message would be a new feature (plan §1).
3. **Production does not call the teardown.** The page's unload already releases everything; `dispose()` exists for the cleanup tests, the boot helper and the 4.x composition root. Calling it on `pagehide` or desktop tab close would change close and quit behaviour.
4. **Facades, not rewritten importers.** The roughly 100 numbered-module imports of the bridges stay; rewriting them to receive the wiring is plan §8's 4.x work.
5. **`tools/modularize.mjs`** stays untouched. It generated `_entry.js` and would overwrite the shim, comments included, if rerun; the shim section of `dependencies.md` says so.
6. **The gate record** is its own docs-only PR after 7.2, as for milestones 3 to 6, not a third code PR.

## As built

Filled in as each PR merges.
