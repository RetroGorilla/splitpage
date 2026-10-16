# Closing the 4.0 legacy shortfalls

A plan for the places where 4.0 fell short of [the implementation plan](../IMPLEMENTATION-PLAN.md). It is written for 4.1 and lives on `4.1-development`. It changes no 4.0 decision: the build entry, the bridges as a campaign and the unused `S` fields stay where plan §8 put them, except where a step below needs one of them.

Status: draft, revised after its external review (Astra, Codex CLI, on `ef704e0`: 3 blocking, 5 should-fix, 1 nit; the findings and the responses are on the PR). Waiting for the re-check. No step has started apart from L1, which another thread owns.

## The shortfalls

From the goals review of 2026-10-16 (`refactor-review/goals-scorecard.md` in the project's shared files), measured on `324171e` (4.0.0-beta.1):

| # | Shortfall | Measured on `324171e` | Plan rule it misses |
| --- | --- | --- | --- |
| F1 | The legacy layer is barely smaller | 79 numbered files in `src/js`, 38,853 lines (3.1: 72 files, 42,504 lines); one runtime cycle of 46 modules and 310 edges; 53 `S` importers; 1,172 `S.` references in `src/js` | §1: "describe remaining legacy debt honestly"; §3: completed areas acyclic |
| F2 | `21-events.js` became six wiring files | `22a`–`22f`, 1,452 lines of numbered JS; five of them read `S` (44 references to 23 fields) | M6: delete it "not by relocating it into another catch-all module" |
| F3 | Three `S.state` assigners, target two | `00-prelude.js:7`, `02b-doc-id.js:35` and `:68`, `03-sync.js:795` | M4 E4 |
| F4 | Typing speed not re-measured after M6 | **Re-measured 2026-10-16 on the x64 PC.** `main` matches the M4 tree. Against 3.1, typing p50 (median of three runs) is 3.4 → 4.0 ms on the short fixture and 5.3 → 5.9 ms on the long one: **+0.6 ms** on both. Logs: `D:\vibecoding\.scratch\perf-4x\` on the PC | §2: bounded per-keystroke work; "investigate material regression" |

F4 is now a measurement, not a gap in the record. The +0.6 ms is under 4% of a 16.7 ms frame and did not grow after milestone 4. This plan does not try to recover it. Its performance exit is that nothing in it makes typing slower than `324171e` (see [Performance](#performance)). Recovering the 0.6 ms would be a separate profiling task, if Adam wants it.

Every figure on this page can be reproduced with the procedures in the [appendix](#appendix-measurement-procedures).

## What the legacy layer is made of

| Group | Files | Lines | What they are |
| --- | --- | --- | --- |
| Movable leaves | 9: `00p`, `02c`, `02d`, `03c`, `04a`, `04b`, `05q`, `20i`, `20k` | 1,422 | Preferences, the blob registry, gallery helpers, the history database, and five small UI helpers. They read no `S`, sit outside the cycle, and import nothing an adapter or a feature is forbidden to import, apart from each other |
| Export writers | 8: `14b`–`14e`, `15`, `16`, `16b`, `17` | 4,682 | Read no `S` and sit outside the cycle, but import legacy singletons: the cached rich-text reader (`cellOf`, `inertBody`, `fromHtml`, `htmlToMarkdown` from `src/legacy/richtext.ts`), `productionReaders`, `htmlToPlainText`, `cacheSeal`, `readSession`, and `migrateRows` from `02-state.js`. `tools/dep-report.mjs` forbids an adapter to import any of those, so they cannot move until those become inputs (L4b) |
| Bridge faces | 3: `02-state`, `04-richtext`, `04c-doc-model` | 150 | Not plain re-exports. `02-state.js` reads the embedded `#state-data`, binds the document ports into migration and builds published HTML from `PAGE_SHELL`. `04-richtext.js` binds randomness into `safeId` and creates a caret node. `04c-doc-model.js` binds `cellOf` into anchor sync. They are the numbered-module face of `src/legacy/richtext.ts` and `document-ports.ts`, and they retire with those bridges (plan §8 item 2), not in this plan |
| The wiring files | `22a`–`22f` | 1,452 | Mount the features and pass them ports; read 23 `S` fields |
| The cycle and the `S` users | 46 modules in the cycle, plus the rest | about 31,000 | The app's live behaviour: hosted and collaboration, rendering, rows, panels, comments, the prompter, drafts, desktop glue |

Two more files are outside the cycle and read no `S`, but they are feature code tangled with cycle members, not leaves. `05r-read-time.js` imports `05-render`, `12-dirty-toast`, `12a-undo` and `13-hosted`, and `18d-command-menu.js` imports `05b`, `18`, `18b` and `18c`. They stay for L5.

A search for exported functions with no caller found six (`pictureBytes`, `galleryOverlayOpen`, `liveCutNonce`, `readTimeEditing`, `dataUrlToBytes`, `menuItemReason`), a few dozen lines in all. No larger part can be deleted outright. Each one goes in the PR that next touches its file.

**The cycle is held together by a few hub modules.** Five functions account for 36 of the 310 cycle edges: `showToast` and `showActionToast` (`12-dirty-toast.js`, in 37 import statements), `findRowIndex` (`03-sync.js`, 14) and `reviewMode` and `reviewBlocked` (`13-hosted.js`, 19). Moving them alone leaves all 46 modules in the cycle. A model of the import graph then removes, one PR at a time, every import a module makes of another cycle member, and measures what remains. The modules and the order below are the L3 PRs, in the order they run. The model is in the appendix.

| After | Largest cycle | Modules in any cycle | Cycles |
| --- | --- | --- | --- |
| `324171e` | 46 | 46 | 1 |
| L3a (the five functions) | 46 | 46 | 1 |
| L3b 1: `13-hosted` | 40 | 42 | 2 |
| L3b 2: `05-render`, `06-rows` | 30 | 34 | 3 |
| L3b 3: `07-production-tags`, `18-local-files` | 23 | 27 | 3 |
| L3b 4: `20e-connect`, `14-export` | 17 | 23 | 4 |
| L3b 5: `03b-side-panels`, `05f-rundown` | 12 | 20 | 5 |
| L3b 6: `12-dirty-toast`, `03-sync` | 5 | 18 | 7 |
| L3c 1: `20b-onboarding`, `05p-rundown-presence`, `01-scene-status` | 2 | 14 | 7 |
| L3c 2: `02b-doc-id`, `13a-presence`, `08c-broll` | 2 | 8 | 4 |
| L3c 3: `05e-gallery-overlay`, `20d-formats`, `20s-settings` | 2 | 2 | 1 |
| L3c 4: `20g-drafts` | 0 | 0 | 0 |

The cycle splits into small ones before it disappears. That is why every exit below counts the modules in any cycle as well as the largest one.

## Exit criteria for the plan

All are measured on the closing tree. Until L0 lands they are measured with the appendix procedures; after it, with `node tools/dep-report.mjs --legacy-metrics`, which prints each of them as one JSON number. "Now" is `324171e`.

| Metric | Now | At close |
| --- | --- | --- |
| Numbered files in `src/js` | 79 | 57 or fewer |
| Lines in numbered files | 38,853 | 32,000 or fewer (−25% against 3.1's 42,504); the moves remove 7,256, and L3's `install` functions and L3b-0's accessors add back a few hundred |
| Modules in any frontend runtime cycle | 46 | 0 |
| `S.state` assigners (`stateAssigners`) | 3 | 2 |
| `S` importers (`stateImporters`) | 53 | 48 or fewer |
| `S.` references in `src/bootstrap/` | none; the wiring is in `src/js` | 0, with the wiring in `src/bootstrap/` |
| A new `src/js` file, a rise in any file's `S.` count, or an `install…` imported outside `src/bootstrap/` | not checked | each fails `npm run check:deps` |
| Typing p50 against `324171e` | | no worse by more than 0.5 ms on either fixture ([Performance](#performance)) |
| Wiring lifecycle | 4.0's wiring tests | the injection contract's tests pass for every inverted module (L3) |
| Gate runs | | Windows full run (plain and frozen), Electron dev smoke, `npm run verify`, race matrix with `SPLITPAGE_M4_GATE=1` with no case demoted, the 294-row remount test, external review |

This plan's exit does not cover the remaining `S` references in the cycle modules (about 1,100). They are the app's behaviour, and removing them is a rewrite per area. L5 lists the areas and their sizes so they can be scheduled, and L0's ratchet makes sure the count only falls.

## Steps

Each step is one PR unless it says otherwise. Every code PR gets CI and one independent review, as [review.md](review.md) says. "Cloud" is a Claude thread in the project's cloud container. "Codex" is a Codex CLI job run through a Remote Control session on the x64 PC. "PC" is a run on the x64 PC (Windows, Edge, Electron), which the cloud cannot do. Each step's exit is local to that step, so it holds whatever else has merged. The plan's exit table needs every step.

### L0. Stop regrowth and publish the measurements (first; cloud, Sonnet; 1 PR)

`tools/dep-report.mjs` gains three baseline rules, recorded in `tools/dep-baseline.json` like the existing ones:

- `legacy-file`: one entry per file in `src/js`. A file that is not in the baseline fails. A removed file is pruned.
- `legacy-state-refs`: each `src/js` file's count of `S.` references. A count above the baseline fails. A lower count is pruned to the new value.
- `wiring-install`: an import of an `install…` export of a `src/js` module from anywhere but `src/bootstrap/` fails (L3's injection contract).

`--legacy-metrics` prints the exit table's numbers as JSON: numbered files, numbered lines, `S.` references in `src/js` and in `src/bootstrap/`, the largest cycle, modules in any cycle, the number of cycles, `S` importers and `S.state` assigners. `--cycle-model <modules…>` runs the appendix model from the current tree, so any step can regenerate its prediction. Line counts are reported but not gated, so a bug fix in a legacy file stays possible.

Exit: `tools/test-dep-report.mjs` has fail-first cases for a new `src/js` file, for one added `S.` reference, and for an `install…` import from `src/features/`. `--legacy-metrics` on `324171e` prints the "Now" column above. `npm run check:deps` passes with 0 new and 0 resolved.

### L1. One fewer document writer (in progress in the thread "One fewer global document writer")

Not planned again here. `03-sync.js`'s merge adoption goes through the live-document port in `02b-doc-id.js`.

Exit: `stateAssigners` is 2.

### L2. Move the wiring into `src/bootstrap/` (fixes F2)

**L2a. Give 19 of the 23 fields an owner** (cloud; 3 PRs, by area). Each of these fields moves out of `S` into the module that owns the behaviour, and every other reader uses that owner's accessor:

| PR | Fields | Other readers | Model |
| --- | --- | --- | --- |
| Editor | `dragRowId`, `pendingImageRowId`, `undoApplying`, `untaggedMutedFor`, `lastFocusedRowId`, `writerLastCell`, `lastMergeUndo` | `05f`, `06`, `05h`, `05e`, `00-prelude`, `05-render`, `07`, `20-teleprompter`, `19-writer`, `03-sync` | Opus (editing hot path, undo) |
| Production and comments | `tagExpanded`, `tagAddingPersonFor`, `productionGroupBy`, `findMatchCase`, `tagRenaming`, `gearGroupBy`, `commentSortMode` | `07`, `08`, `09`, `10` | Sonnet |
| Views | `prompterSkipShot`, `prompterOpen`, `prompterPlaying`, `voiceFollowActive`, `importModeTouched` | `20-teleprompter`, `00-prelude`, `11-import` | Sonnet |

`S.state`, `S.dirty`, `S.initialStateReady` and `S.DESKTOP` are not moved. The wiring reads them through ports that already exist: the live-document port, the session's dirty state, the startup's ready signal and the platform flag.

Exit per PR: the PR's fields have no `S.` reference anywhere (`grep -rE '\bS\.(field1|field2…)\b' src | wc -l` prints 0), and `legacy-state-refs` falls for every file that read them.

**L2b. Port the files** (2 PRs). `22a-editor-wiring.js` becomes `src/bootstrap/wiring/editor.ts` (cloud, Opus). After L2a, `22b`–`22f` become `production.ts`, `comments.ts`, `views.ts`, `overlay.ts` and `startup.ts` in the same folder (Codex, Sol xhigh). The port is in strict TypeScript, with no behaviour change and the slot order unchanged. The evidence is the 294-row remount test and the 14 root-route registrations (13 click slots and the tags-anchor mousedown).

Exit: no `src/js/22*.js`; `--legacy-metrics` reports 0 `S.` references in `src/bootstrap/`; a layer rule forbids `src/bootstrap/` to import `_state.js`, with a fail-first case; the step removes 6 numbered files and 1,452 numbered lines; `S` importers fall by 5; the remount test passes 4/4.

### L3. Break the cycle (fixes the core of F1)

**L3a. Move the hub functions** (3 PRs, one per bullet; can start after L0, beside L2a).

- `showToast` and `showActionToast` move to `src/features/notices/toast.ts`. They touch only the toast host and the undo-owner event, so the feature needs nothing it may not import. Numbered modules import them from there. (Sonnet, Codex)
- `findRowIndex(id)`, which reads `S.state`, becomes `rowIndexOf(doc, id)` in `src/core/document/`. Its 14 callers pass the document they already hold. (Sonnet, Codex)
- `reviewMode` and `reviewBlocked` move to `_home.js`, beside the connection they read. `_home.js` imports nothing from `src/js`, so it cannot create a cycle edge. The policy stays pure: `reviewMode` is `isReviewer(authorityOf(homeConn()))`, with the connection passed as a fact into `src/application/collaboration/authority.ts`, which stays free of legacy and feature imports. The effect stays out of the policy: `reviewBlocked` calls the policy, then `showToast` from `src/features/notices/`. `_home.js` gains two short functions, and that is the cost. A `src/legacy/` or `src/application/` destination would need an import the layer rules forbid. (Sonnet, cloud)

Exit: `runtimeCycleEdges` is 274 or fewer, and none of the five names is exported from a cycle member.

**L3b-0. Live values to accessors** (1 PR, Sonnet, cloud; before L3b). Nine exported mutable bindings are read by other modules: `hideShotScenes` (`01b`), `tagGhost` (`07`), `findOpen` (`09`), `linkTurnedOff` and `serverSessionExpired` (`13-hosted`), `autoSaveEnabled` and `autoSaveHalt` (`14-export`), `writerOpen` (`19`) and `draftRestorePending` (`20g`). Each becomes an accessor function, and its importers call it. A dependency passed in as a function cannot carry an ES live binding, so this must land before any of their importers is inverted. Exit: no `export var` or `export let` of a module in the cycle on `324171e` is both reassigned in its module and imported by another module. L0's metrics report that count, which starts at 9 and must reach 0. `_home.js`'s `home` and `conn` are reassigned too, but `_home.js` is outside the cycle, so the static imports of them stay as they are.

**The injection contract** (every L3b and L3c PR). An inverted module stops importing other cycle members. It does not become a class or an instance, and its own importers do not change:

1. *What changes.* The module's imports of cycle members are replaced by one module-private dependency record, unset at evaluation. Its exported functions and its own state stay where they are, so the modules that import it are untouched.
2. *Activation.* The module exports one `install<Name>(deps)`, called only by `wireApp` in `src/bootstrap/`, inside the single wiring step, before anything mounts. `install` checks that every dependency it names is a function. If one is missing or not a function, it throws a `WiringError` naming it, and it does so before assigning anything. `wireApp` installs every inverted module before the first mount. If an install throws, it uninstalls the ones already installed and refuses to mount, as it does today for the session bridge and the save coordinator.
3. *Before start and after stop.* While the record is unset, any call that needs a dependency throws "`<module>` is not wired yet", as the session accessors do ([session.md](session.md)). There is no permissive or no-op default.
4. *Live values.* The record carries functions only (L3b-0).
5. *Mutual dependencies.* Two inverted modules may depend on each other (`13-hosted` calls `saveDoc` in `14-export`, and `14-export` calls hosted functions). The record holds references to their module-level functions, which exist at evaluation, so the order of the `install` calls does not matter, and no call happens until the wiring step has finished.
6. *Disposal and restart.* `install` returns an uninstall, and `stopApp` calls it. A second `install` without an uninstall throws. A restart installs again. The module's other state is not reset, the same as a restart today.
7. *Enforcement.* L0's `wiring-install` rule. A test in `tests/bootstrap/` imports every `src/js` module without wiring and asserts that every inverted module is unwired, so no install runs at module evaluation.

This is a dependency record set once, so it is a slot. It differs from the `provide…` pattern milestone 7 removed in three ways, all tested: one caller, all-or-nothing validation with rollback, and throwing rather than permissive defaults. Passing constructed instances to every importer instead would mean converting all of each module's importers. That is the composition-root build entry of plan §8 item 1, and this plan does not take it on.

Tests in each L3b and L3c PR, for each module it inverts:
- *missing target*: one function removed from the record throws a `WiringError` naming it, and nothing is installed;
- *rollback*: when a later module's install throws, the earlier ones are uninstalled and nothing mounts;
- *use before start*: a call before wiring throws the named error;
- *restart*: stop, then start, works, and a double install throws.

The existing wiring tests, the remount test and the race matrix with `SPLITPAGE_M4_GATE=1` also run.

**L3b. Invert the hub modules** (6 PRs, the order and figures of the table above):

| PR | Modules | Model, who |
| --- | --- | --- |
| 1 | `13-hosted.js` | Opus (state ingress, saving), cloud |
| 2 | `05-render.js`, `06-rows.js` | Opus (editing hot path), cloud |
| 3 | `07-production-tags.js`, `18-local-files.js` | Opus (`18` reaches saving), cloud |
| 4 | `20e-connect.js`, `14-export.js` | Opus (saving), cloud |
| 5 | `03b-side-panels.js`, `05f-rundown.js` | Sonnet, Codex (Sol high) |
| 6 | `12-dirty-toast.js`, `03-sync.js` | Opus (session effects, merge), cloud |

**L3c. The last ten** (4 PRs, as in the table). PRs 1 and 3 are Codex (Sol high). PRs 2 and 4 hold `02b-doc-id` and `20g-drafts`, so they are Opus, in the cloud.

Exit for each L3b and L3c PR: the largest cycle and the modules in any cycle are at or below that PR's row in the table. The prediction is regenerated with `--cycle-model` on the PR's base, so an earlier deviation carries forward rather than being compounded. A PR that misses its row does not merge as it stands. Either it inverts the edge that kept the number up, or a docs commit in the same PR amends this table with the regenerated predictions for every later PR and names the edge and the reason. The reviewer checks that. Exit for L3c: modules in any cycle is 0, and `tools/test-dep-report.mjs` fails if any frontend runtime cycle returns.

### L4. Move the leaves and the writers out of `src/js` (F1, lines)

**L4a. The movable leaves** (3 PRs; Codex, Sol high; can start after L0). Destinations are chosen so that no adapter imports a feature or legacy code, and no feature imports another feature:

| PR | Files | Destination |
| --- | --- | --- |
| 1 | `02c-blobs`, `02d-gallery`, `03c-history-idb` | `src/adapters/storage/` (`02d` imports only `02c`, core and shared) |
| 2 | `00p-prefs` | Split: keys, read and write, and the clock and saved-status formatters go to `src/adapters/storage/prefs.ts`; `applyTheme`, `applyTagIcons` and its mount go to `src/features/settings/` |
| 3 | `04a-row-motion` with `20i-topbar` (its one importer outside `src/js`), `04b-busy`, `05q-cell-reach`, `20k-phone-bar` | Feature folders; `04a` and `20i` go to the same folder; the three mounts become feature mounts called from `src/bootstrap/` |

Exit: the 9 files are gone (−9 numbered files, −1,422 numbered lines) and `npm run check:deps` reports 0 new.

**L4b. The writers stop importing legacy** (2 PRs; Opus, cloud; after L2b and L4a PR 1). Plan §5 step 2 said the writers' remaining dependencies on legacy helpers "become explicit inputs or permitted adapters". This is that step:

1. An `ExportServices` type in `src/application/export/` holds the decoding the writers need (`cellOf`, `inertBody`, `fromHtml`, `htmlToMarkdown`, `htmlToPlainText`), `productionReaders` and `cacheSeal`. `src/bootstrap/` builds it from the legacy singletons and passes it to each provider at registration. The built-in registration (`14e-export-formats.js`) moves into the wiring step as `src/bootstrap/wiring/exporters.ts`. The cached reader and the frozen-cache behaviour are the same objects as today, so byte output and `SPLITPAGE_FREEZE_CACHES=1` are unchanged.
2. `14b-export-kit.js` splits. Its projection helpers take `ExportServices`, and they move with the writers in L4c. Its capture binding (`captureExportDocument`, `exportDocumentOf`, `capturePorts`), which reads the session and calls `migrateRows`, stays in `14b`, which is then the export capture binding only, until the session bridge retires (plan §8).

Exit: none of `14c`, `14d`, `15`, `16`, `16b` and `17` imports `src/legacy/` or `02-state.js`. `14e` is gone (−217 lines). The byte goldens, `export-capture-app.test.mjs` and the INV-60 cases pass unchanged, and a golden that changes stops the PR. The frozen-cache browser run passes on the PC.

**L4c. Move the writers** (2 PRs; Codex, Sol high): `14c`, `14d`, `16` and `16b`, then `15` and `17`, into `src/adapters/formats/`, in strict TypeScript. The same tests as L4b, unchanged.

Exit: the 6 files are gone (−6 numbered files, −4,165 numbered lines). With L4b, L4 removes 16 files and 5,804 lines, and with L2 the plan removes 22 files and 7,256 lines.

### L5. The behaviour areas (scheduled separately)

What remains after L4 is the app's behaviour. Each area is a port into `src/features/` and `src/application/` the size of an M6 step. Sizes are `S.` references and lines on `324171e`:

| Area | Modules | `S.` refs | Lines |
| --- | --- | --- | --- |
| Prompter and voice | `20-teleprompter` | 161 | 1,048 |
| Hosted and collaboration | `13-hosted`, `13a`, `13b`, `20e` | 170 | 4,374 |
| Production panels and tags | `07`, `08`, `08c`, `08d`, `07b` | 154 | 4,208 |
| Drafts and history | `20g`, `03a`, `20h` | 88 | 2,940 |
| Desktop glue | `20f` | 59 | 1,022 |
| Comments | `10` | 53 | 1,076 |
| Render, rows, rundown | `05`, `05f`, `05h`, `06`, `05e`, `05w`, `05g` | 98 | 5,255 |
| Read time and the command menu | `05r`, `18d` | 0 | 495 |
| Bridge faces | `02-state`, `04-richtext`, `04c-doc-model` | 0 | 150 |

This plan recommends taking each area when a 4.1 feature changes it, inside that feature's work, with L0's ratchet guaranteeing that the counts only fall. The alternative is to schedule the areas as milestones of their own before features. That is Adam's call.

## Order, ownership and parallelism

```
L0 ─┬─► L2a ──► L2b ─┬─► L3b-0 ──► L3b ──► L3c ──► gate
    ├─► L3a ─────────┘                              ▲
    └─► L4a ──► (after L2b) L4b ──► L4c ────────────┘
L1 runs now, in its own thread.
```

- L3a can run beside L2a, because it changes call sites, not the wiring.
- L3b waits for L2b, because its `install` calls are made from the TypeScript wiring.
- L4b waits for L2b, because the exporter registration moves into that wiring.

**One open PR per `src/js` file.** L3a, L3b-0 and L4a rewrite import lines in many files (`00p-prefs` alone has 18 importers), and those files overlap with L2 and L3b. A PR that would change a `src/js` file another open PR in this plan changes waits for it to merge, then merges the base. The coordinator holds that queue. Only one Codex job runs at a time on the PC.

Size: 27 PRs. 16 are cloud threads (11 of them Opus) and 11 are Codex jobs. The perf runs and the gate runs are on the PC.

## Performance

Fixtures: the short (seed, 2 scenes) and long (30 scenes) fixtures of `tools/perf-record.mjs`; typing is 55 keys at 60 ms, key-down to the next frame. Procedure, on the x64 PC with nothing else heavy running:

```
node tools/perf-ab.mjs <base> HEAD --only short,long --rounds 5
```

`perf-ab` alternates the two builds round by round. The figure compared is the median over the rounds of each round's typing p50, per fixture.

- Each hot-path PR (L2a's editor PR, L2b's editor PR, L3b PRs 2 and 6) runs it against its own base before merge. A head p50 more than 0.5 ms above the base on either fixture stops the PR for investigation.
- At the gate, it runs against `324171e`, and the same 0.5 ms bound applies. The 3.1 comparison (`v3.1.0`) is run and recorded too, for information. 4.0's +0.6 ms against 3.1 is the starting point, not a target.

## Gate

On the closing tree:
- `npm run verify`;
- the Windows full browser run, plain and with `SPLITPAGE_FREEZE_CACHES=1`;
- the Electron dev smoke;
- the race matrix with `SPLITPAGE_M4_GATE=1`, with no case demoted;
- the remount test;
- the performance run above;
- `--legacy-metrics` against the exit table;
- an external review (Astra).

The x64 packaged check is not required, because the build entry and the packaging inputs do not change. If a step changes what `build.mjs` bundles from outside `src/`, the check returns.

## Appendix: measurement procedures

All of these run from the repository root on `324171e` or later. L0 replaces them with `--legacy-metrics` and `--cycle-model`.

**Totals.**

```
ls src/js/[0-9]*.js | wc -l
cat src/js/[0-9]*.js | wc -l
grep -oE '\bS\.[A-Za-z_]+' src/js/*.js | wc -l
grep -roE '\bS\.[A-Za-z_]+' src/bootstrap | wc -l
node tools/dep-report.mjs --metrics
```

**3.1.**

```
git ls-tree -r --name-only v3.1.0 src/js | grep -E '^src/js/[0-9][^/]*\.js$' | wc -l
git ls-tree -r --name-only v3.1.0 src/js | grep -E '^src/js/[0-9][^/]*\.js$' | xargs -I{} git show v3.1.0:{} | wc -l
```

**Group totals.** Run `wc -l` over each group's file list in the table above. The `S.` count per file is `grep -oE '\bS\.[A-Za-z_]+' <file> | wc -l`, and cycle membership is the `cycle-edge` entries of `tools/dep-baseline.json`.

**Unused exports.** An exported function counts as unused when its name appears in no other file under `src`, `desktop`, `shared`, `tests` or `tools`, and only once in its own file:

```
for f in src/js/[0-9]*.js; do
  grep -oE "^export (async )?function [A-Za-z0-9_]+" "$f" | awk '{print $NF}' | while read n; do
    others=$(grep -rlw "$n" src desktop shared tests tools | grep -v "^$f$" | wc -l)
    own=$(grep -ow "$n" "$f" | wc -l)
    [ "$others" = 0 ] && [ "$own" -le 1 ] && echo "$f $n"
  done
done
```

**Cycle model.** It reads static imports between `src/js` modules (named, namespace, default and bare). It drops an edge whose imported names were all moved by L3a, then, for each PR in turn, drops every import that PR's modules make. Run as `node cycle-model.mjs '[["13-hosted.js"],["05-render.js","06-rows.js"]]'`, one inner list per PR:

```js
import fs from "fs";
const dir = "src/js/";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
const edges = [];
for (const f of files) {
  const t = fs.readFileSync(dir + f, "utf8");
  for (const m of t.matchAll(/import\s*(?:\{([^}]*)\}|\*\s+as\s+\w+|\w+)?\s*(?:from\s*)?["']\.\/([^"']+\.js)["']/g)) {
    const syms = m[1] ? m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) : ["*"];
    edges.push({ s: f, t: m[2], syms });
  }
}
function scc(es) {
  const adj = {};
  for (const e of es) (adj[e.s] ??= []).push(e.t);
  let idx = 0;
  const st = [], on = new Set(), ix = {}, low = {}, out = [];
  function visit(v) {
    ix[v] = low[v] = idx++; st.push(v); on.add(v);
    for (const w of adj[v] || []) {
      if (ix[w] === undefined) { visit(w); low[v] = Math.min(low[v], low[w]); }
      else if (on.has(w)) low[v] = Math.min(low[v], ix[w]);
    }
    if (low[v] === ix[v]) {
      const c = []; let w;
      do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v);
      if (c.length > 1) out.push(c);
    }
  }
  for (const f of files) if (ix[f] === undefined) visit(f);
  return out.sort((a, b) => b.length - a.length);
}
function report(label, es) {
  const c = scc(es);
  console.log(label, "largest", (c[0] || []).length, "inAnyCycle", c.reduce((n, x) => n + x.length, 0), "cycles", c.length);
}
const moved = new Set(["showToast", "showActionToast", "findRowIndex", "reviewMode", "reviewBlocked"]);
let es = edges;
report("now", es);
es = es.filter((e) => !e.syms.every((s) => moved.has(s)));
report("L3a", es);
for (const group of JSON.parse(process.argv[2] || "[]")) {
  es = es.filter((e) => !group.includes(e.s));
  report(group.join(" + "), es);
}
```

**Live bindings.** Find each `export var` or `export let` in `src/js` that is reassigned in its own file. Then search `src` for an `import { … name … } from` that module in any other file. Eleven are both reassigned and imported elsewhere. Two of them, `home` and `conn`, belong to `_home.js`, which is outside the cycle. The nine that belong to cycle members are listed in L3b-0.
