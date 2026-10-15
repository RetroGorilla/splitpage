# Milestone 6 gate record

The recorded evidence that [the gate section of milestone 6](milestone-6.md#the-gate)
requires before milestone 6 closes, on the merged milestone 6 tree. The
milestone is described in [milestone-6.md](milestone-6.md).

Final milestone 6 tree: `9fcf363`, the merge of #626 (6.9 PR 2, which deletes
`21-events.js`) into `4.0-development` on 2026-10-15. Every code step is merged
(see [the PR list](#pull-requests)). The Windows runs below ran on the head of
#626 before its merge, on the two heads named in each row; #626 merged
`2d19032` unchanged, so `9fcf363` has the same files as `2d19032`.

## Summary

| Gate requirement | Result | Status |
| --- | --- | --- |
| Ledger: every one of the 294 rows in a feature mount | 294 rows, 204 registrations; `21-events.js` deleted in #626; `app-remount-app.test.mjs` proves stop removes and restart re-adds exactly the ledger's registrations ([below](#ledger-and-dispose-evidence)) | passed |
| Race matrix, `SPLITPAGE_M4_GATE=1`, no case demoted or weakened | 181/181; no matrix file changed in #626 | passed |
| M5 evidence retained, including INV-60 (`X22`) | matrix files unchanged; counts as recorded in the merged PRs ([below](#retained-evidence)) | passed |
| 6.2 and 6.3 replay evidence | recorded under "As built" in milestone-6.md and in the merged PR records (#596, #598) | passed |
| Full Windows browser run, plain | `2d19032`: 10393/10393 across 194 suites. `595c2c0`: 10391/10393 on the first run (suite 66 flake), 10393/10393 on the second | passed |
| Full Windows browser run, caches frozen (`SPLITPAGE_FREEZE_CACHES=1`) | `595c2c0`: 10587/10587 across 194 suites. Not repeated on `2d19032` | passed |
| Electron smoke, dev target | `595c2c0`: 974/974. `2d19032`: 971/972 on the first run (one group, flake), 974/974 on the second | passed |
| `npm run verify` on Linux (Node 24.22.0) | clean on `595c2c0` (reviewer) and `2d19032` (author); frontend 170/170, tests 133/133, desktop 15/15, tools 17/17 | passed |
| CI on the merge | push run for `9fcf363` (run 38791487677) succeeded | passed |
| External review | Astra (Codex CLI), 2026-10-15: 1 blocker, 3 concerns | **not passed yet**; fix PR pending ([below](#external-review)) |
| Linux full browser run, native ARM64, packaged check | the packaged check returns only if packaging or runtime inputs change; Linux full run and ARM64 go to the 4.0 release gate | not run here |

Two one-off failures occurred during the gate and are described under
[Flakes seen](#flakes-seen). Both passed on rerun and when run alone, and
neither is in code a milestone 6 PR changed.

## Pull requests

| Step | PRs | Merge commits |
| --- | --- | --- |
| Plan, ledger, review | #585 (Astra plan review), #587 (ledger), #591 (ledger precedence) | `0160cd7`, `5221ed5`, `6650ae7` |
| 6.1 Selection and composition | #588, #594, #597 | `cd621e7`, `c4a9266`, `b40ff19` |
| 6.2 Undo replay as a transaction | #596 | `ed06d36` |
| 6.3 `foldIntoEdit` | #598 | `e2fab0e` |
| 6.4 Editor commands and media | #602 (cell edit), #603 (rows), #605 (video), #607 (clipboard), #606 (writer), #604 (media typed HTML), #609 (remaining rows) | `413334d`, `9676ccc`, `fe7620a`, `bb52311`, `d5a9671`, `53d9ebf`, `8228989` |
| 6.5 Records and repair-on-read | #611, #612, #621 | `fcc729b`, `c21df03`, `18e08c8` |
| 6.6 The rest of `applyMerge` | #600 | `cb0f45b` |
| 6.7 CSS colour tokens | #589 | `2b747a1` |
| 6.8 CSS aggregation | #608 | `4b0c51c` |
| 6.8.1 Tags and production panels | #614 | `5b487e0` |
| 6.8.2 B-roll | #615 | `fb7e6d6` |
| 6.8.3 Comments | #616 | `6542044` |
| 6.8.4 Find | #617 | `ab72e53` |
| 6.8.5 Panels, settings, gallery, prompter | #619 | `7ca10ec` |
| 6.8.6 Overlay and focus ownership | #622 | `ab93357` |
| 6.9 Startup extraction, then deleting `21-events.js` | #613, #626 | `f0a56dc`, `9fcf363` |
| Fixes made during the milestone | #592 (suite 288 clock), #595 (suite 190), #599 and #601 (server-resume takeover race case and fix), #610 (undo keeps pictures and video), #620 (stale resume key), #623 (CI Node check and render-guard toast race) | `ece3437`, `803dc99`, `8634668`, `0b01317`, `e5bf21c`, `0d7777a`, `2e726fb` |
| Docs and CI audit | #618 (milestone-6.md corrections), #624 (CI audit follow-ups), #625 (milestone 7 plan) | `6e6e855`, `76769c5`, `e73dd98` |

Each code PR passed CI and an independent review by a thread that did not
write it; the findings and verification counts are in the review comment on each
PR.

## Ledger and dispose evidence

The inventory has 294 rows: 204 listener registrations, 57 delegated click
branches and 33 startup or resource rows. They were taken as follows (the same
table the remount test parses):

| Step | Rows | Removed by |
| --- | ---: | --- |
| 6.1 | 14 | 6.1 PRs |
| 6.2 | 5 | 6.2 PRs |
| 6.4 | 46 | 6.4 PRs |
| 6.6 | 3 | 6.6 PR |
| 6.8.1 | 54 | #614 |
| 6.8.2 | 1 (S28, which installs b-roll's 19 runtime listeners) | #615 |
| 6.8.3 | 36 | #616 |
| 6.8.4 | 12 | #617 |
| 6.8.5 | 95 | #619 |
| 6.8.6 | 6 | #622 |
| 6.9 | 22 | #613 |
| **Total** | **294** | |

Steps 6.3, 6.5 and 6.7 own no rows. Source: the ledger reconciliation in the
merge record of #626 (comment 6200158176).

- `21-events.js` is deleted in #626. `git grep` finds no import of it in code,
  tests, build inputs or workflows; the only mentions left are docs, dependency
  baseline reasons and the ledger regex in the remount test.
- `src/test/app-remount-app.test.mjs` stops and starts the booted app and
  asserts that stopping removes every listener and every root route, that each
  `(target, event, phase)` carries exactly the ledger's registrations plus the
  named resource rows, that the second mount equals the first, and that all
  thirteen click slots and the anchor slot are taken. Removing one step's stop
  from `startApp` fails it.
- `tests/features/routing/root-router.test.ts` pins the thirteen-slot click
  order (added in `2d19032` after review finding C1) and the one-slot mousedown
  order.
- The reviewer of #626 planted bugs in a scratch copy (a stop removed, a route
  dropped, the review gate dropped); each made a test fail.

## Retained evidence

- Race matrix: `SPLITPAGE_M4_GATE=1` over `src/test/m4-matrix-*.test.mjs`,
  181/181 on the reviewer's Linux run of #626 (Node 24.22.0) and on #620. No
  matrix file changed in #626. Milestone 6 added the server-resume takeover
  case in #599.
- Milestone 5 evidence (capture, asset, writeback and registry coverage, and
  INV-60 as `X22` in `m4-matrix-exports`) lives in the matrix and node test
  files from the [milestone 5 gate](milestone-5-gate.md#checks-added-by-574);
  those files pass inside the runs above.
- Replay evidence for 6.2 and 6.3: the "As built" entries in milestone-6.md name the tests (`session-replay.test.ts`, `undo-replay-app.test.mjs`, `fold-into-edit-app.test.mjs`); the review comment on #596 records them passing.

## Windows runs

Windows 11 x64 PC, 32 threads, Node v22.23.2 (the x64 Node under `tools\node`),
Electron 44.4.5 (x64, from a separate worktree, since `desktop/.npmrc` pins
ARM64), 18 browser lanes. Each run used a fresh scratch worktree; nothing was
fixed, pushed or merged. The comments are on #626.

| Head | Run | Result |
| --- | --- | --- |
| `595c2c0` | Plain full run | 10391/10393; suite 66 failed 2 checks |
| `595c2c0` | Suite 66 alone | 84/84 |
| `595c2c0` | Plain full run, second | 10393/10393, 194 suites |
| `595c2c0` | Frozen caches full run | 10587/10587, 194 suites (the +194 is the one extra check each suite adds in a freeze run) |
| `595c2c0` | Electron dev smoke | 974/974, 0 skipped |
| `2d19032` | Plain full run | 10393/10393, 194 suites |
| `2d19032` | Electron dev smoke, first | 971/972; one group failed |
| `2d19032` | That group alone | 6/6 |
| `2d19032` | Electron dev smoke, second | 974/974, 0 skipped |

Sources: comments 6198456449 and 6198540626 (`595c2c0`) and 6200149613
(`2d19032`).

`2d19032` changed one test and some prose after `595c2c0`, so the frozen run was
not repeated.

## Flakes seen

| Where | What failed | What happened next | Cause |
| --- | --- | --- | --- |
| Plain full run on `595c2c0` | Suite 66 `66-hosted-blobs`, 2 checks: an unrelated request was recorded between the suite clearing its call log and checking it, and `B.remoteMisses()` timed out | Passed alone (84/84), in the second plain run, the frozen run, all 8 reviewer runs and the plain run on `2d19032` | Not investigated. Reads as a load-sensitive race; #626 changes no hosted or blob code |
| Electron smoke on `2d19032`, first run | The #531 close-check group (a tab torn off during the last window's close, under `--host`): `window.splitpageDesktop` was undefined when the test read it | Passed alone (6/6) and in the second full run | Not investigated. Reads as harness timing; #626 changes no preload, IPC or `desktop/` code |

The full output of the suite 66 failure is in comment 6198540626 on #626. The
smoke failure output is in comment 6200149613. If either recurs, keep the full
log and investigate.

## Shim status at `9fcf363`

Counted in the repository at `9fcf363`:

| | Count |
| --- | --- |
| Numbered modules in `src/js` | 79 files |
| Modules `_entry.js` starts through `__init` | 69 (the other 10, including `22a` to `22f`, load only as imports) |
| Bridge-style files in `src/legacy` | 23 files, 1,387 lines; four are the `*-bridge.ts` files (recovery, save, session, transition) |
| Import statements from `legacy/` in `src/js` | 110, in 58 files |
| Files under `src` and `tests` that reference the session bridge | 34 |

These are the inputs to milestone 7, whose plan is in
[milestone-7.md](milestone-7.md). The review note on #626 (S2) records that
`milestone-7.md` still says four modules load only as imports, and places
`startApp` after the last `__init`; M7 PR 1 updates both.

## CI on the closing tree

The push run for `9fcf363` on `4.0-development` (run 38791487677) completed
with success. It was not cancelled by the docs merges that followed (#628 merged
as `51f30aa`; its own run, 38793635863, also succeeded).

## External review

| | |
| --- | --- |
| Reviewer | Astra (Codex CLI), an independent session that took no part in building or reviewing milestone 6 |
| Scope | Read-only source review of the closing tree `9fcf363`: the "As built" sections, the rescope document, the plan, the review rules, `src/features/`, `src/bootstrap/`, `_entry.js`, the CSS split files, the `css-feature-balance` test and the remount test from #626 |
| Date | 2026-10-15 |
| Verdict | **Does not pass yet.** 1 blocker, 3 concerns |
| Limits | No files changed and no tests ran. Historical byte equality and the closing-tree CI and race-matrix results were not independently verified |

Astra confirmed the normal startup sequence, the staged comment and overlay
ordering, the review gate running before all 13 click slots, b-roll as one
ledger row with 19 listeners, the CSS aggregation (shared ordered aggregate,
separators, missing, case and duplicate checks, fragment braces), and replay and
amend using the session transaction boundary without recording ordinary undo
entries. It notes that the remount test checks expanded registration counts and
route occupancy but not the release of every resource the 294 rows represent.

| # | Severity | Finding | Decision | Pinned by |
| --- | --- | --- | --- | --- |
| 1 | blocker | `src/features/rows/routes.ts:176`: disposal removes listeners but never clears the dragged row, markers or auto-scroll. Disposing during an edge drag leaves the animation in `06-rows.js:122` scrolling and updating the DOM, and a remount inherits `S.dragRowId` | Fix in #629 (merge commit to be added) | A held-animation disposal and remount case (to be added with the fix) |
| 2 | concern | `src/features/routing/owned.ts:29`: unregister functions are recorded only after the whole registration callback returns, so a later slot that throws leaves earlier slots occupied and a retry fails. The existing failure test throws before registering anything | Fix in #629 | A test where a later slot throws (to be added) |
| 3 | concern | `src/bootstrap/app.ts:68`: draining stops at the first throwing disposer, so earlier mounts and startup listeners survive and `running` stays set (line 130 is skipped). Comment cleanup dereferences required DOM nodes without checking | Fix in #629: drain every disposer, clear state in `finally`, report collected failures | A test with a throwing disposer (to be added) |
| 4 | concern | `milestone-6.md` records byte equality for the CSS splits, but the CSS evidence criteria require browser captures | Accepted by Adam on 2026-10-15 (19:15 UTC): the comparator's byte-identical output on each mechanical split stands in for the captures, and the criteria text now says so | The comparator checks recorded in the 6.7 and 6.8 PRs |

The fix PR for findings 1 to 3 is #629 (merge commit to be added). This record
stays a draft until it merges; then its counts and the push run result are
updated and the PR is marked ready.

The review text is kept with the project's files and on the maintainer's
machine; this table is the disposition.

## Blockers for Adam

The external review's blocker (finding 1) and two concerns (2, 3) are open until the fix PR merges. Finding 4 was accepted by Adam on 2026-10-15.
