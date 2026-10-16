# Milestone 7: wire frontend owners explicitly and verify 4.0

The working notes for milestone 7 of [the implementation plan](../IMPLEMENTATION-PLAN.md#7--wire-frontend-owners-explicitly-and-verify-40), narrowed by [the 2026-10-07 re-scope](milestones-4-7-rescope.md#milestone-7-keep-the-contract-drop-the-rewrite-adam-2026-10-07). The plan holds the scope and the gate. This file holds the two PRs, their file lists and tests, the gate evidence, the inputs plan §7's release checklist asks for, and, once each PR merges, what it built.

Status: 7.1 merged (#630, `9c39567`) and 7.2 merged (#632, `cbab324`). The gate runs passed on `53dff02` (the merge of #633, a smoke test fix). The 4.0 release review's milestone 7 findings (a blocking teardown defect, a should-fix in dependency validation) were partly fixed by #636 (`23b49a7`, 2026-10-16); Sol's re-review found one blocking and one should-fix gap left, fixed by #637 (`89d309f`), and Sol's re-check of #637 passed on 2026-10-16. Milestone 7 is closed on `89d309f`; see [milestone-7-gate.md](milestone-7-gate.md). Derived from `ab93357`, with the milestone 6 baseline refreshed on `9fcf363`, where 6.9's second PR (#626, deleting `21-events.js`, adding `startApp`, `stopApp` and `startAppWhenReady` in `src/bootstrap/app.ts`) merged. The external review of this plan (Astra, 2026-10-15) is applied below. Nothing in milestone 7 starts before the milestone 6 gate is recorded.

## Goal

Every migrated owner is constructed by one explicit wiring step in `src/bootstrap/` that takes its dependencies as arguments, and nothing mounts until that step has finished. A missing or throwing dependency stops startup with a report instead of leaving a session that accepts edits and fans out nothing. The step's teardown releases what it built. `_entry.js` is named and documented as the legacy initializer shim, and a test keeps new code out of it.

Out of scope, as Adam decided on 2026-10-07 and reaffirmed on 2026-10-15: the composition root as build entry, removing unused `S` fields, a bridge-retirement campaign, and every other item in plan §8. They stay 4.x follow-ups. No user-visible behaviour changes.

## Models

Both PRs are Opus: they construct the session (state ingress) and own teardown (close and quit code). Each gets one independent Opus review. Neither touches preload or IPC.

## What milestone 6 leaves behind

Measured on `9fcf363` (the merge of 6.9's second PR) with `node tools/dep-report.mjs --metrics`, `wc -l` and grep. 7.2 re-measures it.

**The shim.** `src/js/_entry.js` is 154 lines. It imports 69 numbered modules' `__init` and calls them in numbered order. Around those calls it does five pieces of wiring by hand: `startSaves(legacySavePorts(...))` before the first `__init`, then, after the last, `startAppWhenReady(document)`, `startTransitions(...)`, `startRecovery(draftRecoveryPorts())` and, separately, `startActions(appActions, window)` (line 154). Of the 79 numbered modules under `src/js/`, ten are not started by the shim and load only as imports: `03c-history-idb.js`, `14c-export-projections.js`, `14d-export-text.js`, `14e-export-formats.js` and M6's six wiring modules, `22a-editor-wiring.js` to `22f-startup-wiring.js`. The shim starts 69 of 79.

**`src/bootstrap/` today.** `actions.ts` (52 lines): `startActions(registry, keyTarget)` registers the action groups, the native menu runner and the shortcut mount, undoes a partial start on a throw, and refuses a second start until stopped. `startup.ts` (65 lines) and `startup/` (four files, 134 lines), from 6.9's first PR (#613): `beginStartup(ports)` orders the desktop draft, the initial document, the page-lifetime registrations and desktop start, and `whenDocumentReady` dispatches it on DOM ready. `app.ts`, from 6.9's second PR: `startApp()` mounts the features and returns a stop function, `stopApp()` stops them, and `startAppWhenReady(document)` waits for DOM ready, owns the cancellation of a pending start, and is what `_entry.js` calls.

**The feature mounts.** 27 files under `src/features/` export a mount (`mount.ts`, `routes.ts` or a named owner such as `editing/focus.ts`). On `9fcf363`, `startApp` mounts them through the M6 wiring modules `22a` to `22f`, with their ports; the exceptions are `mountBroll` (in `08d-broll-panel.js`), `mountTagEntityContainer` (in `20-teleprompter.js`) and `mountShortcuts` (in `src/bootstrap/actions.ts`, started by `startActions`). Milestone 7 does not move a mount; it gives `startApp` the wired owners it needs.

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
| The action registry's start | `_entry.js:154` | `startActions(appActions, window)`, outside `startApp` and outside the DOM-ready wait |

Since 4.7 a session port that was never provided throws "The session's … port was not provided" ([session.md](session.md)) instead of doing nothing, so the re-scope's "accepts edits and fans out nothing" is now "throws on the first edit". The order problem is the same: correctness depends on which modules happened to load, and a test that loads part of the app must remember to wire what it uses (`wireSession` in `src/test/_fanout-stubs.mjs`).

## The steps, in order

| Step | Scope | Prerequisites | Model |
| --- | --- | --- | --- |
| 7.1 | The wiring step: construct the session, the bridges, the command ports and the registries with dependencies passed in; startup, partial-failure and cleanup tests; `_entry.js` named as the shim, with its test | 6.9's second PR merged, M6 gate recorded | Opus |
| 7.2 | Finish the wiring: remove every load-order configuration in the table above, INV-30's bootstrap test, docs, the release-checklist inventory; then the gate runs | 7.1 | Opus |
| Gate record | `milestone-7-gate.md`, a docs-only PR, as for milestones 3 to 6 | 7.2, the gate runs | Sonnet |

### 7.1 The wiring step

**Shape.** `wireApp(deps)` in `src/bootstrap/wiring.ts` returns a `Wiring` (the constructed owners) and its `dispose()`. `_entry.js` calls it once, before the first `__init`, where `startSaves` is called today, and passes the result to `startAppWhenReady` after the last `__init`. `startApp(wiring)` takes the wiring as an argument, so nothing can mount before the wiring exists; that is the structural half of "every owner is wired before anything mounts", and the startup test is the executable half.

**One lifecycle.** Wiring, DOM readiness, actions and feature mounts form one owned lifecycle with one stop. `startActions` moves out of `_entry.js` into it (today it runs separately at `_entry.js:154`, outside `startApp` and outside the DOM-ready wait). Order inside the lifecycle: the actions start first, after the wiring and before `beginStartup` and the first feature mount, and stop last, after the mounts (reverse order). That keeps today's order, in which the action groups, native menu runner and shortcuts are registered before startup and every mount. One thing changes: the actions are registered when DOM ready fires, not while the script evaluates (the script is inline at the end of the body, so `startApp` is deferred to `DOMContentLoaded`). 7.1 confirms that nothing runs an action in that gap, and a test checks the start and stop order. Wiring passes through `startAppWhenReady`: it owns the cancellation of a pending start, so a stop before DOM ready means nothing mounts afterwards. Teardown runs in this order: cancel any pending startup; stop the actions and the feature mounts (`stopApp`); then release what they depended on, in reverse construction order (below). Nothing is released while something that uses it is still running or can still start. Where wiring runs relative to the `__init`s is settled in [decision 7](#decisions-taken): `wireApp` before the first `__init`, the initialization-sensitive ports and the mounts after the initializers, through the DOM-ready wrapper, and `PAGE_SHELL` captured before any DOM mutation.

`wireApp` constructs, in this order, and records a disposer for each:

1. The action registry and the export registry (`createActionRegistry`, `createExportRegistry`), installed into the legacy facades below.
2. The session: `startSessionBridge(ports)` replaces the module-evaluation `startSession` call. The ports are passed in: entry (`migrateRows`), undo adapter, effects, capability, reconcilers, attribution, report and timers.
3. The command ports built from the same effects. `sessionStamps` and `sessionTextPorts` stay stable forwarding objects exported by the bridge, because numbered modules import them as bindings: their identity never changes across rewires, and what they forward to is the wiring's current effects.
4. Undo routing and adoption (`routeReplays`, `watchUndoAdoption`), called by `startSessionBridge` rather than at module evaluation. Both return `void` today and install callbacks through the legacy undo module (`undo-adapter.ts:15`), so this step includes an uninstall path: `routeReplays` and `watchUndoAdoption` return an uninstall function, `configureUndo` and `routeUndoReplays` in `12a-undo.js` gain a matching release, and an uninstall removes only the installation that returned it, so a stale disposal cannot clear a newer installation.
5. The save coordinator, the transitions and the draft recovery, through the existing `startSaves`, `startTransitions` and `startRecovery`, moved out of `_entry.js` in their current order relative to each other.

**Legacy facades.** The numbered modules keep their imports: 17 numbered modules import `session-bridge.ts`, 17 `transition-bridge.ts`, 14 `app-actions.ts` and 4 `export-formats.ts` (on `9fcf363`, `_entry.js` aside). `appActions`, `exportFormats` and the session bridge's exports become facades over the wired instances that throw "not started yet" before `wireApp` has run and after its `dispose()`, which is the pattern the save, transition and recovery bridges already follow (milestone 4). Rewriting those importers is 4.x.

**The built-in exporters.** `14e-export-formats.js` stops calling `registerBuiltInExporters()` at module evaluation, and `registerBuiltInExporters(registry)` takes the registry it fills. `_entry.js` passes it to `wireApp`, which calls it on the registry it built. This has to be in 7.1: once `exportFormats` throws before `wireApp`, the call at the bottom of 14e would throw while the bundle evaluates and the app would not load. It was the only module-evaluation use of `appActions`, `exportFormats`, `sessionStamps` or `sessionTextPorts` on `ab93357` (the review of this plan parsed every numbered module's top-level statements); 7.1 re-checks it on `9fcf363`, including `22a` to `22f`.

**Interim check for the load-order providers.** In 7.1 the four `provide…` calls still run at module evaluation. `wireApp` checks that each one has run before it constructs the session, and refuses otherwise, so 7.1 already meets the partial-failure contract. 7.2 removes the providers.

**Failure.** `wireApp` validates every dependency before constructing anything: a missing dependency throws a `WiringError` naming it. A dependency that throws while an owner is being constructed is caught, the owners already built are disposed in reverse order (as `startActions` does), and a `WiringError` naming the step and carrying the cause is thrown. `_entry.js` then reports it through `console.error` and does not call `startApp` or any `__init`, so no feature mounts. No new user-facing message is added (plan §1: no new features); see [decision 2](#decisions-taken).

**Cleanup.** `dispose()` releases in reverse construction order, after the lifecycle above has stopped pending startup, mounts and actions: the recovery, transition and save starts' stop functions; the session's `dispose()` (its subscribers and timers); undo routing (the uninstall paths above); the registries emptied and uninstalled from the facades. After it, every facade throws "not started yet" and `wireApp` can run again.

**The shim.** `_entry.js` keeps its path (moving it would change the build entry, which is 4.x). It is named "the legacy initializer shim" in `dependencies.md`, `session.md`, `saving.md` and `actions.md`. `dependencies.md` gains a section with one row per module the shim starts (69 after 6.9's second PR): the module, the owner it is waiting for in 4.x (a feature folder, an adapter, or "composition root"), and the bridges it imports.

**Files.**

| File | Change |
| --- | --- |
| `src/bootstrap/wiring.ts` | new: `wireApp`, `Wiring`, `WiringError` |
| `src/js/_entry.js` | calls `wireApp` before the `__init`s and passes the wiring to `startAppWhenReady`; its hand-wired `start…` calls, `startActions` included, go |
| `src/legacy/session-bridge.ts` | `startSessionBridge(ports)` and its stop; no session, no undo routing at module evaluation; facade exports throw before start |
| `src/legacy/app-actions.ts`, `src/legacy/export-formats.ts` | facades over the wired registries |
| `src/legacy/undo-adapter.ts`, `src/js/12a-undo.js` | `routeReplays` and `watchUndoAdoption` return an uninstall function; `configureUndo` and `routeUndoReplays` can release what they installed |
| `src/bootstrap/app.ts`, `src/bootstrap/actions.ts` | `startApp` and `startAppWhenReady` take `Wiring`, start the actions inside the owned lifecycle, and pass the registries and session to the mounts that need them; one stop covers pending startup, mounts and actions |
| `src/js/14e-export-formats.js` | no registration at module evaluation; `registerBuiltInExporters(registry)` |
| `src/test/_app-boot.mjs`, `src/test/_fanout-stubs.mjs` | boot through `wireApp`; `wireSession` wires through `startSessionBridge` |
| the 34 test files under `src/test/` and `tests/` that import `legacy/session-bridge.ts` (34 on `9fcf363`) | each one that reads the session or runs a command without booting the app calls `wireSession` first; no assertion changes. The count of files actually changed is recorded in the PR |
| the 5 test files that import 14e, `export-formats.ts` or `app-actions.ts` (`export-registry-app`, `m4-matrix-exports`, `tour-interrupt-app`, `views-mount-app`, `tests/legacy/command-palette.test.ts`) | wire the registries they use through `wireApp` or a registry helper |
| `docs/architecture/dependencies.md` | the shim section and its owner table |
| `docs/architecture/milestone-7.md` | "As built" for 7.1 |

**Tests.**

- `tests/bootstrap/wiring.test.ts`
  - *Startup.* With fake ports, `wireApp` constructs every owner in the order above; `startApp` receives the wiring, and a probe mount registered by the test sees a started session, both registries and all three bridges started. The facades throw before `wireApp` and after `dispose()`.
  - *Failed partial startup.* For each dependency, a run with it missing and a run with it throwing: `WiringError` names it, every owner built before it is disposed (counted by the fakes), no facade is left started, and `startApp` is never reached. The interim check: a run where a `provide…` call has not happened refuses in the same way.
  - *Lifecycle.* Order: the actions start before startup and the first mount, and stop after the last mount. Stop before DOM ready: nothing mounts afterwards, no action is started, and the wiring is released. Rollback after a failure: a mount that throws, and separately an action start that throws, stop everything already started and release the wiring, leaving every facade "not started yet". Repeated successful starts: start, stop, start again, with the same owners each time and no doubled handler.
  - *Undo teardown.* After `dispose()`, a callback retained from the undo routing does nothing, and an old uninstall run after a rewire leaves the new installation in place.
  - *Cleanup.* Wire, start, dispose, three times: one handler per window registration, no session subscriber or timer left (fake clock advanced and pending work settled before asserting, under milestone 4's production-cleanup rule), registries empty after each dispose, and the same owners after each rewire. App-lifetime subscriptions that legitimately survive are named in the test.
- `tests/bootstrap/legacy-shim.test.ts`: no file under `src/application`, `src/features` or `src/bootstrap` imports `src/js/_entry.js`, resolved through `tools/dep-report.mjs`'s resolver rather than a text search; and the shim's set of import specifiers is a subset of a frozen set, so nothing new registers into it (the set may only shrink). The frozen set, after 7.1 and unchanged by 7.2, has 72 members: the 69 numbered modules it starts, `14e-export-formats.js` (for `registerBuiltInExporters`), `../bootstrap/wiring.ts` and `../bootstrap/app.ts`. Everything `_entry.js` passes to `wireApp` comes from those numbered modules (`legacySavePorts` from 14, `draftRecoveryPorts` from 20g, the document ports from 02b and 03, and in 7.2 the effects from 03, 07, 08c and 12); its imports of `app-actions.ts` and the three start bridges move into `wiring.ts`. The set compares specifiers, not imported names, so 7.2 adding a named import from 03 does not change it. This is [decision 1](#decisions-taken).
- Existing tests kept green unchanged in their assertions: `tests/bootstrap/start-actions.test.ts`, `tests/bootstrap/startup.test.ts`, `src/test/session-bridge-unwired.test.mjs` (its expectation moves from "port not provided" to "not started yet", with the same throwing behaviour), the boot tests (`*-boot*.test.mjs`, `session-bridge-app.test.mjs`), and the race matrix under `SPLITPAGE_M4_GATE=1`.

**Local evidence in the PR.** `npm run verify` on Node 24.22.0; `SPLITPAGE_M4_GATE=1 npm run verify`; the boot and startup suites of [testing.md](testing.md)'s change table for bootstrap changes, plain and with `SPLITPAGE_FREEZE_CACHES=1`.

### 7.2 Finish the wiring

**Scope.** No numbered module configures an owner as a side effect of being loaded:

- `12-dirty-toast.js` and `03-sync.js` export their session effects (`legacySessionEffects()`, `getEditorName`), `07-production-tags.js` exports `runIdleRefresh`, `08c-broll.js` exports `derivedRecordsPlan` (it already does), and `_entry.js` passes them to `wireApp`. The four `provide…` calls go, and so do `provideSessionEffects`, `provideRefreshRunner`, `provideRecordsReconciler` and the bridge's `given` object. 7.1's interim check goes with them. The records reconciler becomes a required dependency, so a missing one is reported instead of silently returning `null`.
- The initial load stops reaching into onboarding: `loadInitialState` in `02b-doc-id.js` (called by `loadInitialDocument`) reads `seedCheckPasses` from `20b-onboarding.js` today, which is the cycle edge recorded in `tools/dep-baseline.json` as "goes when bootstrap owns the initial load (milestone 7)". The seed check becomes a port of `openInitialDocument` (6.9's `startup/initial-document.ts`), passed in by the wiring (the load callback it feeds is supplied from `22f-startup-wiring.js:32`, so the change is made there), `02b` drops the import and `node tools/dep-report.mjs --prune` removes the entry. If 6.9's second PR leaves the load shaped so that this is not a port change, 7.2 instead rewords the entry's reason to name plan §8's composition root, and says so; either way this entry no longer names milestone 7.
- The other 20 baseline exceptions that name milestone 7 are the state-import and state-write entries for `22a`, `22b`, `22c`, `22d` and `22f`, whose reason reads "goes with the composition root in milestone 7". The composition root is 4.x work (plan §8), so 7.2 rewords those 20 reasons to name plan §8's 4.x composition root, in `tools/dep-baseline.json`. Together with the cycle edge above, all 21 entries that name milestone 7 on `9fcf363` are handled, and the gate row's "no exception whose reason names milestone 7" can hold.
- Tests that relied on module-evaluation providers (9 files call a `provide…` function; two tests call `wireSession`, which `src/test/_fanout-stubs.mjs` defines) wire explicitly through `wireSession` or `wireApp`.

**INV-30.** Its acceptance in [invariants.md](invariants.md#inv-30--the-setup-wizard-appears-only-over-a-pristine-copy) names this milestone: `13-onboarding.txt` passes with the wiring step, and a bootstrap test shows the wizard does not open when a document arrives by file, link or restore. "Never constructed" is not the right test: the modal is wired regardless of whether it is eligible to show. The observable is that it does not open automatically. Driving `startApp` alone proves nothing, because the onboarding initializer installs its modal listeners and calls `maybeAutoShowOnboarding` (`20b-onboarding.js:301`, called from line 361) in the initializers, before app startup. The test therefore runs the real initializer and startup sequence, the shim's order with the wiring, for each arrival kind (file, link, restore), and observes whether onboarding opened. It includes a positive control: the same sequence over a pristine copy must open it, so a path that never ran onboarding cannot pass. The test goes in `tests/bootstrap/wiring.test.ts`.

**Docs.** `session.md` (the bridge section: construction by the wiring step, the providers gone), `saving.md` (the start calls now in `src/bootstrap/wiring.ts`), `actions.md` ("The legacy shim" section), `milestone-4.md`'s note that milestone 7 moves the start calls, this file's "As built" for 7.2, and [the release-checklist inventory](#release-checklist-inputs) re-measured on 7.2's tree.

**Files.** `src/bootstrap/wiring.ts`, `src/js/_entry.js`, `src/legacy/session-bridge.ts`, `src/js/22f-startup-wiring.js`, `src/js/03-sync.js`, `src/js/07-production-tags.js`, `src/js/08c-broll.js`, `src/js/12-dirty-toast.js`, `src/js/02b-doc-id.js`, `src/bootstrap/startup/initial-document.ts`, `tools/dep-baseline.json`, `src/test/_fanout-stubs.mjs` and the test files that called a provider, `tests/bootstrap/wiring.test.ts`, and the docs above.

**Tests added.** In `wiring.test.ts`: each former provider omitted in turn is reported by `wireApp` (the records reconciler included); a session built by `wireApp` uses exactly the effects passed in (a probe effect counts one call per edit); INV-30's three arrival kinds and the pristine positive control. In `legacy-shim.test.ts`: no numbered module configures a bridge at module evaluation. The check observes the configuration calls and mutations directly (a spy on each bridge's configuration functions, including those that only store a callback or effect, such as the `provide…` functions, `configureUndo` and the registry installers), importing each module alone with fresh module state for each case. It covers every numbered module that loads without being started, `14e-export-formats.js` and `22a` to `22f` included, as well as the modules the shim initializes. An assertion that no owner became started is not enough on its own, since a stored callback starts nothing.

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

Plan §7 asks the release to name the shim, the count of numbered modules it still starts, and the bridge files that remain with their owners. Re-measured on 7.2's tree (`node tools/dep-report.mjs`, `wc -l` and grep), replacing the `9fcf363` numbers.

**The shim:** `src/js/_entry.js`, "the legacy initializer shim", 170 lines. It calls `wireApp` with the dependencies it imports from numbered modules, then starts 69 of the 79 numbered modules; ten load only as imports (`03c`, `14c`, `14d`, `14e` and `22a` to `22f`). Runtime cycle: one, 46 modules and 310 edges (7.2 removed `02b-doc-id.js → 20b-onboarding.js`). `S` assigners: 3 (`00-prelude.js`, `02b-doc-id.js`, `03-sync.js`).

**The bridges:** 23 files under `src/legacy/`, 1,452 lines (1,451 when 7.2 merged; #636 added a line to `save-bridge.ts`); 106 imports of them from 57 numbered modules and none from `_entry.js` (since 7.1 `src/bootstrap/wiring.ts` imports the ones it starts); 35 test files reference the session bridge. "Imported by" counts numbered modules (and the bootstrap files); the right column is what keeps the file alive.

| File | Lines | Imported by | Kept by |
| --- | --- | --- | --- |
| `richtext.ts` | 60 | 23 numbered modules, 3 bridges | the editor and format modules still under `src/js/` |
| `session-bridge.ts` | 218 | 17 numbered, `transition-bridge.ts`, `wiring.ts` | every numbered module that edits or reads the session |
| `transition-bridge.ts` | 89 | 17 numbered, `wiring.ts`, `recovery-bridge.ts` | open, new, restore and publish callers in `src/js/` |
| `app-actions.ts` | 43 | 14 numbered, `wiring.ts` | numbered modules invoking actions by id |
| `document-ports.ts` | 42 | 7 numbered | state entry and format modules (`02`, `02b`, `03`, `07`, `14b`, `14c`, `15`) |
| `plain-text.ts` | 7 | 6 numbered | `08c`, `14b`, `14c`, `15`, `18a`, `19` |
| `save-bridge.ts` | 108 | 5 numbered, `wiring.ts`, `transition-bridge.ts` | `03`, `12`, `13`, `14`, `18` |
| `export-formats.ts` | 28 | 4 numbered, `native-menu.ts`, `wiring.ts` | `14e`, `18`, `18c`, `18d` |
| `review-wording.ts` | 1 | 4 numbered | `05h`, `06`, `13`, `19` |
| `cache-freeze.ts` | 18 | 3 numbered, 2 bridges | `05f`, `07`, `14b` |
| `recovery-bridge.ts` | 86 | 2 numbered, `wiring.ts` | `03`, `20g` |
| `tour-pause.ts` | 18 | 2 numbered | `20c`, `20e` |
| `screen.ts` | 69 | 1 numbered, 7 bridges | `18d` and the action bridges |
| `screen-state.ts` | 26 | 6 bridges | the action bridges |
| `undo-adapter.ts` | 27 | `session-bridge.ts`, `wiring.ts` | `12a-undo.js` |
| `menu-items.ts` | 21 | `share-actions.ts` | the share actions |
| `file-actions.ts`, `help-actions.ts`, `share-actions.ts`, `this-document-actions.ts`, `view-actions.ts`, `zoom-actions.ts`, `native-menu.ts` | 99, 121, 166, 55, 82, 20, 48 | `src/bootstrap/actions.ts` | action definitions that call numbered modules |

Owners: every bridge is owned by the integration owner until 4.x's bridge work (plan §8 item 2), which removes each with the legacy modules that keep it. The per-module owner table is `dependencies.md`'s shim section (7.1).

## Open question

None. The one question put to the external plan review, where the wiring runs, is settled as [decision 7](#decisions-taken).

## Decisions taken

Settled in this plan and its review; not reopened by the plan review.

1. **"Registers into the shim"** means the shim's set of import specifiers may only shrink (the frozen set in 7.1's tests), and, from 7.2, no numbered module configures a bridge at module evaluation. It is a test, not a dep-report rule, so a breach fails instead of becoming a baseline entry.
2. **A failed startup** reports the `WiringError` through `console.error` and leaves the static page with nothing mounted, as an exception in `_entry.js` does today (inferred, not measured). A visible message would be a new feature (plan §1).
3. **Production does not call the teardown.** The page's unload already releases everything; `dispose()` exists for the cleanup tests, the boot helper and the 4.x composition root. Calling it on `pagehide` or desktop tab close would change close and quit behaviour.
4. **Facades, not rewritten importers.** The roughly 100 numbered-module imports of the bridges stay; rewriting them to receive the wiring is plan §8's 4.x work.
5. **`tools/modularize.mjs`** stays untouched. It generated `_entry.js` and would overwrite the shim, comments included, if rerun; the shim section of `dependencies.md` says so.
6. **The gate record** is its own docs-only PR after 7.2, as for milestones 3 to 6, not a third code PR.
7. **Where the wiring runs** (the plan review's ruling): `wireApp` runs before the first module `__init`; there is no separate build and start split. The transition constructor retains deferred operations, and recovery's writer id already exists at module evaluation; its desktop port reads `S.DESKTOP` lazily. Initialization-sensitive startup ports and the mounts stay after the initializers, through the DOM-ready wrapper (`startAppWhenReady`), and `PAGE_SHELL` is captured before any DOM mutation. 7.1's boot tests confirm it.

## As built

Filled in as each PR merges.

### 7.1 The wiring step

- **Wiring.** `wireApp(deps)` in `src/bootstrap/wiring.ts` validates its dependencies (the six required ones, the four optional ones, the three transition ports, the three undo ports when given), then runs the interim check: if any load-order provider has not run (`unprovidedSessionEffects()` lists dirty, draft, save, edit capability, editor name, attribution, refresh runner, records reconciler), it throws `WiringError` with step `"session effects"` before building anything. It then builds seven steps in order (`WIRING_STEPS`): action registry, export registry, built-in exporters, session, saves, transitions, recovery. A step that throws drains the disposers already recorded in reverse and throws `WiringError(step)` with the cause (an `AggregateError` when the rollback also failed). `dispose()` is idempotent, runs every disposer even when one throws, and reports failures as one `AggregateError`.
- **Session bridge.** `startSessionBridge(ports)` creates the session and installs `watchUndoAdoption` and `routeReplays` from its undo ports; there is no session or undo routing at module evaluation. Its stop disposes the session and runs both uninstalls. A replay or adoption callback retained from an earlier wiring returns a no-op. `readSession`, `runCommand`, `adoptReplacement`, `noteReload`, `editAllowed` and the `sessionStamps` editor name read the started instance and throw "The document session is not started yet" otherwise. `sessionStamps` and `sessionTextPorts` keep their identity across rewires. `onDocumentReplaced` listeners stay module-level, as before.
- **Facades.** `appActions` and `exportFormats` forward to the installed registry and throw "The action registry is not started yet" / "The export registry is not started yet" before `wireApp` and after `dispose()`. An install refuses a second one; its release removes only its own install.
- **Undo uninstall.** `routeReplays` and `watchUndoAdoption` return an uninstall function. `routeUndoReplays` in `12a-undo.js` returns one that restores the unrouted default only if its own installation is still current; `configureUndo`'s release clears the `adopted` hook only if it is still the one it set.
- **Exporters.** `registerBuiltInExporters(registry)` fills the registry it is given and returns a disposer; 14e no longer registers at module evaluation. Re-checked on `2b891f8`: no other numbered module (`22a` to `22f` included) uses a facade at module evaluation.
- **Lifecycle.** `startApp(wiring)` starts the actions first (`startActions(wiring.actions, wiring.keyTarget)`), then startup and the mounts; its stop list begins with `wiring.dispose`, so one stop releases the mounts, then the actions, then the wiring. A failed mount or action start runs the same drained stop. `startAppWhenReady(document, wiring)` releases the wiring when a pending start is cancelled. Between script evaluation and DOM ready the actions are not yet registered; a probe of every facade call in that gap found only 18c's `exportFormats.exporters` and `onChange` from its `__init`, no action call (inferred from the probe; `actions.md` notes it).
- **The shim.** `_entry.js` calls `wireApp` before the first `__init`; if it throws, the shim logs the error and runs no `__init` and no `startAppWhenReady`. Its 72 import specifiers are the frozen set of `tests/bootstrap/legacy-shim.test.ts`. `dependencies.md` has the shim section with one row per started module (69).
- **Mounts and the registries.** `startApp` passes the wiring's action registry and key target to `startActions`; the mounts still read the action registry, the export registry and the session through the shared facades (`appActions`, `exportFormats`, the session bridge) rather than being handed them, as [decision 4](#decisions-taken) allows. Handing them to the mounts is plan §8's 4.x work.
- **Known limit.** 18c subscribes to `exportFormats.onChange` in its `__init`, which runs once per page, so after a rewire in a test it stays attached to the first registry. Production never rewires (decision 3), so this is left for 4.x with the other `__init` subscriptions.
- **Dependency baseline.** Unchanged: `npm run check:deps` reports 0 new and 0 resolved exceptions. The 21 entries that name milestone 7 are 7.2's (the load-order providers).
- **Tests changed.** Of the 34 test files that import `legacy/session-bridge.ts` on the base, 5 changed (`_fanout-stubs.mjs`'s `wireSession` now starts the bridge through the new `src/test/_session.mjs`; `session-bridge-unwired` now expects "not started yet" and gains a case that starts the bridge first, its other expectations unchanged; `transition-bridge-unwired` and `m4-matrix-session` start the session or skip the probe before it exists; `session-recovery-boot` subscribes in the new `beforeStart` boot hook). Five files that read the session through other modules without booting (`production-golden`, `publish-in-flight`, three `undo-owner-*`) call `startTestSession()`. The remount test (`app-remount-app`) lists one more resource row, the window keydown shortcuts, because the actions now stop with the app; `app-remount-app` and `app-stop-errors-app` start through `rewireApp()`. `start-actions` and `command-palette` wire the registries through `src/test/_registries.mjs`. No assertion was weakened.
- **Evidence.** `tests/bootstrap/wiring.test.ts` (13 tests: startup order, missing and throwing dependencies for every step, the interim check, undo teardown, three wire/start/dispose cycles on a fake clock, and on the booted app the start and stop order, stop before DOM ready, an action-start failure, a mount failure, repeated starts and the surviving subscriptions) and `tests/bootstrap/legacy-shim.test.ts` (4 tests). On Node 24.22.0 in the Linux container: `npm run verify` and `SPLITPAGE_M4_GATE=1 npm run verify` green (2518 + 1325 unit tests, every frontend, tests, desktop and tools file); the race matrix under `SPLITPAGE_M4_GATE=1` 181/181; the 294-row remount test 4/4; the boot, app and bootstrap tests (773) green; 35 browser suites (boot, onboarding, document id, history, drafts, autosave, saving, exports, the action and lifecycle suites 268 to 291, 307 and 380) green plain and with `SPLITPAGE_FREEZE_CACHES=1`.

### 7.2 Finish the wiring

- **Providers gone.** `12-dirty-toast.js` exports `legacySessionEffects()` (dirty, draft, save, the edit capability, the attribution), `07-production-tags.js` exports `runIdleRefresh`, and `03-sync.js` (`getEditorName`) and `08c-broll.js` (`derivedRecordsPlan`) already exported theirs. `_entry.js` imports them from those four modules, already in its frozen set, and passes them to `wireApp` as `effects`, `editorName`, `refresh` and `records`. `provideSessionEffects`, `provideRefreshRunner`, `provideRecordsReconciler`, `providedSessionEffects`, `unprovidedSessionEffects`, the bridge's `given` object and 7.1's interim check are deleted. `wireApp` validates the four with the other required dependencies, and each of `effects`' five functions, before it builds anything; the records reconciler is now required, so a missing one is a `WiringError` instead of a silent `null`. `legacySessionPorts(deps)` in `wiring.ts` builds the bridge's ports from them.
- **Two more load-time registrations.** The load-order test found two configurations the plan's table did not list: `06-rows.js` registered `onDocumentReplaced(releaseSessionVideoUrls)` and `20c-help.js` called `handTourPauseTo(...)` at module evaluation. Both moved into their module's `__init`, which the shim calls once after the wiring and before any document is replaced or any dialog can open.
- **The initial load and onboarding.** `InitialDocumentPorts` has a `pristine` port; `openInitialDocument` asks it once, as the load starts, and hands the answer to `load(pristine)`. `22f-startup-wiring.js` supplies `seedCheckPasses` from `20b-onboarding.js`, and `loadInitialDocument(pristine)` and `loadInitialState(pristine)` in `02b-doc-id.js` take it, so 02b no longer imports 20b. `node tools/dep-report.mjs --prune` removed the cycle edge.
- **Dependency baseline.** 515 entries before, 514 after: the `02b → 20b` cycle edge is pruned, and the 20 `22a`, `22b`, `22c`, `22d` and `22f` state entries now read "goes with the 4.x composition root (plan §8)". No entry names milestone 7; `npm run check:deps` reports 0 new and 0 resolved.
- **Lifecycle.** `startSessionBridge`'s release disposes the session in a `try` and runs the undo uninstalls in its `finally`, so a throwing dispose no longer skips them (the #630 review's third nit).
- **Tests changed.** The 16 files that called a provider or relied on one: five that load the real modules (`production-golden`, `publish-in-flight`, three `undo-owner-*`) start the bridge with `appSessionDeps()` from the new `src/test/_app-session.mjs`; `session-bridge-unwired` and `transition-bridge-unwired` start it with `unwiredSessionDeps()` (ports that throw "The session's … port was not provided", which the tests then fill in one by one, with the same assertions as before); `wireSession` (`scene-effects-order`, `scene-effects-undo`) returns the stub effects it started the session with, so a test can swap one; five booted-app tests (`rows-commands-app`, `undo-replay-app`, `fold-into-edit-app`, `m4-lifecycle`, `m4-matrix-session`) restart the booted app once on a switchable effect through `rewireRunningApp(overrides)` in `src/test/_app-boot.mjs`. Before, the refresh-runner swaps in `m4-lifecycle` and `m4-matrix-session` were never undone, and `rows-commands-app` restored an always-allowed edit capability instead of the app's; now each test restores the app's own effect. `last-edited-by` passes `false` to `loadInitialState`. No assertion was weakened; the case counts per file are unchanged.
- **Tests added.** `tests/bootstrap/wiring.test.ts`: every one of the four former providers and each of the five effects omitted in turn is reported and nothing is built; a session built by `wireApp` runs exactly the effects passed in (a probe counts one call of each per legacy edit and per command, the stamp carries the editor name passed in, a due refresh reaches the runner passed in); INV-30 (below); the surviving app-lifetime listeners named by target and event (the #630 review's first nit); a session dispose that throws (a timer stop failing under an armed refresh) still uninstalls the undo routing and watch; and the booted app's initial load gets the seed check through its port (`src/test/_initial-load-probe.mjs` boots a saved page in a fresh process: with a matching seed check it is a fresh document, not written out, without one it opens as its file; forcing the port to `false` fails it). `startTestSession` throws when a session is already running, so dependencies passed to it are never silently ignored. `tests/bootstrap/startup.test.ts`: the seed check is asked once, when the load starts, and its answer reaches the load. `tests/bootstrap/legacy-shim.test.ts`: the load-order check below, a positive control, and a guard that every bridge or bootstrap export named like a configuration function (`start…`, `install…`, `register…`, `provide…`, `configure…`, `route…`, `watch…`, `hand…`, `use…`, `on…`) is on the spy list.
- **The load-order check.** `src/test/_load-order-probe.mjs` imports one module in a fresh Node process, with module hooks (`src/test/_load-order-hooks.mjs`) that wrap the configuration functions of the bridges and of `src/bootstrap/` (the session bridge's start and `onDocumentReplaced`, the undo routing and adoption watch and 12a's `configureUndo` and `routeUndoReplays`, the registry installers and the facades' `register`, `defineCard`, `onChange` and `presentRefusals`, the save, transition and recovery starts, `useBrowserDraftFactory`, `handTourPauseTo`, the six action-group registrations, `registerBuiltInExporters`, `wireApp`, `startApp`, `startAppWhenReady`, `startActions` and the two page-lifetime registrations). It reports every call made while the module graph evaluates, with the module that made it, and whether any owner (session, saves, recovery, transitions, actions, exports) is started afterwards. The test runs it for all 79 numbered modules, the ten load-only ones included, and expects no call, no import error and nothing started; a fixture module that stores a tour callback and installs an export registry at load is caught by name. Putting `06-rows.js`'s registration back at module evaluation fails it, naming `06-rows.js`.
- **INV-30.** `src/test/_onboarding-probe.mjs` boots the real shim (wiring, every `__init`, startup) in a fresh process over a pristine copy with the seed check passing, and reports whether the wizard opened. Over a plain browser copy and a desktop first tab it opens (the positive controls); with a remembered file handle, a `?doc=` link, or a desktop draft to restore it stays shut. Removing the remembered-file check from `onboardEligibleForAutoShow` fails the test.
- **Evidence.** On Node 24.22.0 in the Linux container: `npm run verify` green; the race matrix with `SPLITPAGE_M4_GATE=1`; the 294-row remount test; the browser suites that touch startup, plain and with `SPLITPAGE_FREEZE_CACHES=1`. Counts are in the PR. The Windows full runs and the Electron dev smoke are the gate's, on the merged tree.

## External review

Astra (Codex CLI), 2026-10-15, on `9fcf363`. The two-PR scope and the gate hold. Applied above: the single lifecycle contract with its lifecycle tests (blocker); the INV-30 test over the real initializer and startup sequence with a pristine-copy control; the load-order test over configuration calls, load-only modules included; the undo uninstall path in 7.1; the refreshed M6 baseline and corrected names (`src/js/_entry.js`, `loadInitialState`). Ruling: `wireApp` runs before the first `__init`, with no build and start split ([decision 7](#decisions-taken)).
