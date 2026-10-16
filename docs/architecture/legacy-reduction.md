# Closing the 4.0 legacy shortfalls

A plan for the three places where 4.0 fell short of [the implementation plan](../IMPLEMENTATION-PLAN.md). It is written for 4.1 and lives on `4.1-development`. It changes no 4.0 decision: the build entry, the bridges as a campaign and the unused `S` fields stay where plan §8 put them, except where a step below needs one of them.

Status: draft, waiting for its external review (Astra, Codex CLI). No step has started apart from the one owned by another thread (L1).

## The shortfalls

From the goals review of 2026-10-16 (`refactor-review/goals-scorecard.md` in the project's shared files), measured on `324171e` (4.0.0-beta.1):

| # | Shortfall | Measured now | Plan rule it misses |
| --- | --- | --- | --- |
| F1 | The legacy layer is barely smaller | 79 numbered files in `src/js`, 38,853 lines (3.1: 72 files, 42,504 lines); one runtime cycle of 46 modules and 310 edges; 53 `S` importers; 1,172 `S.` references in `src/js` | §1: "describe remaining legacy debt honestly"; §3: completed areas acyclic |
| F2 | `21-events.js` became six wiring files | `22a`–`22f`, 1,452 lines of numbered JS; five read `S` (44 references to 23 fields) | M6: delete it "not by relocating it into another catch-all module" |
| F3 | Three `S.state` assigners, target two | `00-prelude.js:7`, `02b-doc-id.js:35` and `:68`, `03-sync.js:795` | M4 E4 |
| F4 | Typing speed not re-measured after M6 | **Closed 2026-10-16.** On the x64 PC, `main` matches the M4 tree and is within 0.5 ms of 3.1 at p50 (logs: `D:\vibecoding\.scratch\perf-4x\` on the PC) | §2 constraint on per-keystroke work |

Commands for every figure in this page:

```
ls src/js/[0-9]*.js | wc -l
cat src/js/[0-9]*.js | wc -l
node tools/dep-report.mjs --metrics
grep -oE '\bS\.[A-Za-z_]+' src/js/*.js | wc -l
```

## What the legacy layer is made of

Every `src/js` file falls into one of three groups. The grouping decides what each step costs.

| Group | Files | Lines | What they are | Cost to retire |
| --- | --- | --- | --- | --- |
| Clean leaves | 22 numbered files with no `S` reference and outside the cycle | 6,749 | The export writers (`14b`–`14e`, `15`, `16`, `16b`, `17`), the history database and blob registry (`03c`, `02c`), three thin re-export files over `src/core` (`02-state`, `04-richtext`, `04c-doc-model`) and nine small UI helpers (`00p`, `02d`, `04a`, `04b`, `05q`, `05r`, `18d`, `20i`, `20k`) | Low: a move into `src/adapters/` or a feature folder; byte goldens pin the writers |
| The wiring files | `22a`–`22f` | 1,452 | Mount the features and pass them ports; read 23 `S` fields | Medium: the fields need owners first |
| The cycle and the `S` users | 46 modules in the cycle, plus the rest | about 31,000 | The app's live behaviour: hosted and collaboration, rendering, rows, panels, comments, the prompter, drafts, desktop glue | High if rewritten; medium if only their imports are inverted (L3) |

A dead-code search found six unused functions, a few dozen lines. Nothing larger can be deleted outright.

**The cycle is held together by a few hub modules.** Five functions account for 36 of the 310 cycle edges: `showToast` and `showActionToast` (`12-dirty-toast.js`, in 42 import statements), `findRowIndex` (`03-sync.js`, 13), `reviewMode` and `reviewBlocked` (`13-hosted.js`, 24 statements). Moving them breaks those edges, but the cycle keeps all 46 modules. Modelled on the import graph with Tarjan's strongly connected components, removing the numbered-module imports of 11 hub modules, in this order, shrinks the cycle to 5 modules:

| Order | Module | Lines | Largest cycle after |
| --- | --- | --- | --- |
| 1 | `13-hosted.js` | 2,527 | 40 |
| 2 | `05-render.js` | 1,246 | 35 |
| 3 | `06-rows.js` | 462 | 30 |
| 4 | `07-production-tags.js` | 944 | 26 |
| 5 | `18-local-files.js` | 761 | 23 |
| 6 | `20e-connect.js` | 588 | 20 |
| 7 | `14-export.js` | 483 | 17 |
| 8 | `03b-side-panels.js` | 159 | 15 |
| 9 | `05f-rundown.js` | 1,047 | 12 |
| 10 | `12-dirty-toast.js` | 228 | 9 |
| 11 | `03-sync.js` | 845 | 5 |

Ten more (`20b`, `05p`, `01`, `02b`, `13a`, `08c`, `05e`, `20g`, `20d`, `20s`; 4,161 lines) take it to zero. The model counts static named imports and is rechecked after each PR with `dep-report --metrics`. The numbers in the table are predictions, not exit criteria; the exit criteria are in each step.

## Exit criteria for the plan

All measured on the closing tree with the commands above. "Now" is `324171e`.

| Metric | Now | At close |
| --- | --- | --- |
| Numbered files in `src/js` | 79 | 51 or fewer |
| Lines in numbered files | 38,853 | 30,700 or fewer (−28% against 3.1's 42,504) |
| Frontend runtime cycles (`frontendRuntimeCycles`) | 1 (46 modules, 310 edges) | 0 |
| `S.state` assigners (`stateAssigners`) | 3 | 2 |
| `S` importers (`stateImporters`) | 53 | 48 or fewer |
| `S.` references in `src/bootstrap/` | 0 (the wiring is in `src/js`) | 0, with the wiring in `src/bootstrap/` |
| A new file in `src/js`, or a rise in any file's `S.` count | not checked | fails `npm run check:deps` |
| Typing p50, x64 PC, `tools/perf-record.mjs` | within 0.5 ms of 3.1 | still within 0.5 ms of 3.1 |
| Gate runs | | Windows full run (plain and frozen), Electron dev smoke, `npm run verify`, race matrix with `SPLITPAGE_M4_GATE=1` with no case demoted, external review |

Out of this plan's exit, and why: the remaining `S` references in the cycle modules (about 1,100) are the app's behaviour, and removing them is a rewrite per area. L5 lists the areas and their sizes so they can be scheduled; the ratchet in L0 makes sure the number only falls.

## Steps

Each step is one PR unless it says otherwise. Every code PR gets CI and one independent review, as [review.md](review.md) says. "Cloud" is a Claude thread in the project's cloud container; "Codex" is a Codex CLI job run through a Remote Control session on the x64 PC; "PC" is a run on the x64 PC (Windows, Edge, Electron), which the cloud cannot do.

### L0. Stop regrowth (first; cloud, Sonnet; 1 PR)

`tools/dep-report.mjs` gains two baseline rules, recorded in `tools/dep-baseline.json` like the existing ones:

- `legacy-file`: one entry per file in `src/js`. A file that is not in the baseline fails; a removed file is pruned.
- `legacy-state-refs`: each `src/js` file's count of `S.` references. A count above the baseline fails; a lower count is pruned to the new value.

Line counts are reported by `--metrics` but not gated, so a bug fix in a legacy file stays possible. A `--cycle-model` option prints the hub ordering above, so the model can be re-run by anyone.

Exit: `tools/test-dep-report.mjs` has fail-first cases for a new `src/js` file and for one added `S.` reference in an existing file; `npm run check:deps` passes on the PR's tree with 0 new and 0 resolved.

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

`S.state`, `S.dirty`, `S.initialStateReady` and `S.DESKTOP` are not moved: the wiring reads them through the ports that already exist (the live-document port, the session's dirty state, the startup's ready signal, the platform flag).

**L2b. Port the files** (2 PRs). `22a-editor-wiring.js` becomes `src/bootstrap/wiring/editor.ts` (cloud, Opus). `22b`–`22f` become `production.ts`, `comments.ts`, `views.ts`, `overlay.ts` and `startup.ts` in the same folder (Codex, Sol xhigh, after L2a). Strict TypeScript, no behaviour change, slot order unchanged; the 294-row remount test and the 14 click-slot registrations are the evidence.

Exit: no `src/js/22*.js`; `grep -c 'S\.' src/bootstrap -r` is 0; a layer rule forbids `src/bootstrap/` importing `_state.js`, with a fail-first case; numbered files 73 or fewer; `S` importers 48 or fewer; the remount test 4/4.

### L3. Break the cycle (fixes the core of F1)

**L3a. Move the hub helpers** (cloud or Codex, Sonnet; 2 PRs). `showToast` and `showActionToast` move to `src/features/notices/`; `findRowIndex` becomes a session selector; `reviewMode` and `reviewBlocked` move next to `isReviewer` in `src/application/collaboration/authority.ts`. Exit: `runtimeCycleEdges` 274 or fewer.

**L3b. Invert the hub modules' imports** (11 modules, about 6 PRs). Each module in the table above stops importing other numbered modules. It exports a constructor that takes those functions as dependencies, and `src/bootstrap/` calls it, as `wireApp` does since milestone 7: the dependencies are passed in, a missing one stops startup with a `WiringError`, and nothing is supplied by module evaluation or a `provide…` call. No logic moves and no behaviour changes. The modules keep their files in `src/js` until a feature migrates them.

| PR | Modules | Model, who |
| --- | --- | --- |
| 1 | `13-hosted.js` | Opus (state ingress, saving), cloud |
| 2 | `05-render.js`, `06-rows.js` | Opus (editing hot path), cloud |
| 3 | `07-production-tags.js`, `14-export.js` | Sonnet, Codex (Sol high) |
| 4 | `18-local-files.js`, `20e-connect.js` | Opus (saving), cloud |
| 5 | `03b-side-panels.js`, `05f-rundown.js` | Sonnet, Codex (Sol high) |
| 6 | `12-dirty-toast.js`, `03-sync.js` | Opus (session effects, merge), cloud |

Exit for each PR: `largestFrontendRuntimeCycle` at or below the model's figure for its last module, or the PR records which edge kept it higher. Exit for L3b: largest cycle 5 or fewer.

**L3c. The last ten** (`20b`, `05p`, `01`, `02b`, `13a`, `08c`, `05e`, `20g`, `20d`, `20s`; about 4 PRs, Codex for all but `02b` and `20g`, which are Opus). Exit: `frontendRuntimeCycles` 0, and `tools/test-dep-report.mjs` fails if any frontend runtime cycle returns.

The hot-path PRs (L3b 2 and 6) each get a PC perf run with `tools/perf-ab.mjs` against their base before merge.

### L4. Move the clean leaves out of `src/js` (F1, lines; Codex, Sol high; 4 PRs; can run beside L2 and L3)

The 22 files in the first group. This is the cheapest line reduction available: nothing in them reads `S` or sits in the cycle, and the writers are pinned byte for byte.

| PR | Files | Destination |
| --- | --- | --- |
| 1 | `02-state`, `04-richtext`, `04c-doc-model` (re-exports) | Deleted; importers import `src/core/` directly |
| 2 | `14b`, `14c`, `14d`, `14e`, `16`, `16b` | `src/adapters/formats/` |
| 3 | `15-docx`, `17-pdf` | `src/adapters/formats/` |
| 4 | `03c`, `02c`, `00p`, `02d`, `04a`, `04b`, `05q`, `05r`, `18d`, `20i`, `20k` | `src/adapters/storage/` for `03c`, `02c` and `00p`; the owning feature folder for the rest |

Strict TypeScript. Byte goldens, `export-capture-app.test.mjs` and the INV-60 cases must pass unchanged; a golden that changes stops the PR. Exit: the 22 files are gone; numbered files 51 or fewer; numbered lines 30,700 or fewer.

### L5. The behaviour areas (scheduled separately)

What remains after L4 is the app's behaviour. Each area is a port into `src/features/` and `src/application/` the size of an M6 step. Sizes are `S.` references and lines today:

| Area | Modules | `S.` refs | Lines |
| --- | --- | --- | --- |
| Prompter and voice | `20-teleprompter` | 161 | 1,048 |
| Hosted and collaboration | `13-hosted`, `13a`, `13b`, `20e` | 170 | 4,374 |
| Production panels and tags | `07`, `08`, `08c`, `08d`, `07b` | 154 | 4,208 |
| Drafts and history | `20g`, `03a`, `20h` | 88 | 2,940 |
| Desktop glue | `20f` | 59 | 1,022 |
| Comments | `10` | 53 | 1,076 |
| Render, rows, rundown | `05`, `05f`, `05h`, `06`, `05e`, `05w`, `05g` | 98 | 5,255 |

This plan recommends taking each area when a 4.1 feature changes it, inside that feature's work, with L0's ratchet guaranteeing the counts only fall. The alternative is to schedule the areas as milestones of their own before features. That is Adam's call.

## Order and parallelism

```
L0 ──► L2a ──► L2b ──► L3a ──► L3b ──► L3c ──► gate
 │                                              ▲
 └──► L4 (beside L2 and L3, disjoint files) ────┘
L1 runs now, in its own thread.
```

L2 comes before L3 because L3b's constructors are called from the wiring, which should already be TypeScript in `src/bootstrap/`. One Codex job at a time on the PC: L4's four PRs and L2b's Codex part queue behind each other.

Size: about 22 PRs, roughly 10 of them Codex jobs and 12 cloud threads, and the gate and the perf runs are on the PC.

## Gate

On the closing tree: `npm run verify`; the Windows full browser run, plain and with `SPLITPAGE_FREEZE_CACHES=1`; the Electron dev smoke; the race matrix with `SPLITPAGE_M4_GATE=1` and no case demoted; the remount test; `tools/perf-record.mjs` on the PC against 3.1 and `324171e`; the exit table above; and an external review (Astra). The x64 packaged check is not required: the build entry and the packaging inputs do not change. If L4 or L3 changes what `build.mjs` bundles from outside `src/`, the check returns.

## How this plan was built

The figures come from the source, not the gate records: `dep-report --metrics` and `tools/dep-baseline.json` for the cycle and the `S` users, a per-file count of `S.` references, `wc -l`, and a search for exported functions with no caller. The cycle ordering is a greedy model over the static import graph (Tarjan's strongly connected components, removing one module's outgoing numbered-module imports at a time and keeping the step that shrinks the largest component most). L0 commits that model as `--cycle-model`. The checks that make the result verifiable without trusting the authors: the exit table, re-run by anyone with the commands above; L0's ratchet in CI; the PC perf runs; and the external review.
