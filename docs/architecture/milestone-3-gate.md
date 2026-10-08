# Milestone 3 gate record

The recorded runs that [section 8 of review.md](review.md#8-milestone-gates)
and [section 4 of the implementation plan](../IMPLEMENTATION-PLAN.md#4-verification-baseline-and-ci-policy)
require before milestone 3 closes, on the merged milestone 3 tree. The
milestone itself is described in [milestone-3.md](milestone-3.md), whose
[gate section](milestone-3.md#the-gate) lists the runs.

Final milestone 3 tree: `645df99`, the merge of #462 (the as-built docs, the
metrics and the performance record) into `4.0-development`. Its application
code is `391bda6` (3.14 and #448) plus #453 and #456. Every check below
ran on `645df99` itself, from a clean worktree (`npm ci` at the root and in
`desktop/`, then `node build.mjs`). Nothing was fixed, rebuilt or rerun to get
a pass: each check ran once.

Machine for every run below: Windows x64, Ryzen 9 9950X3D2 (16 cores, 30.9 GB
RAM), Windows 11 Pro 10.0.26300, Node 22.23.2, Edge 154.0.4258.62 (the
harness's browser, headless). The machine also ran the maintainer's other
applications and a WSL CI runner, so the browser runs used `-Parallel 4`
(about 5 GB of RAM was free at the start of each) rather than the 18 lanes
milestone 2 used. The browser durations below are therefore not comparable
with milestone 2's "about 3 minutes".

## Summary

| Check | Result | Status |
| --- | --- | --- |
| `npm run verify` | exit 0; 202 test files (frontend 104, tests 72, desktop 12, tools 14) | passed |
| Full Windows browser run 1, caches not frozen | 10282/10282 checks across 191 suites | passed |
| Full Windows browser run 2, caches frozen (`SPLITPAGE_FREEZE_CACHES=1`) | 10473/10473 checks across 191 suites | passed |
| Electron smoke, dev target | 809/809 desktop checks | passed |
| Windows x64 packaged check | verify-dist 6/6; packaged smoke 809/809 | passed |
| Measured metrics | dependency metrics re-run on `645df99`; typing performance referenced from [milestone-3.md, 3.15](milestone-3.md#as-built) (measured at `391bda6`, see below) | referenced |
| Windows ARM64 packaged check | native check moved to the 4.0 release gate | not run here |
| Linux full browser run | moved to the 4.0 release gate (#314) | not run here |
| External review | Codex (decision D7) | Pending: external review (Codex, coordinator) |

No flake and no rerun in any step.

## Fast gates

| | |
| --- | --- |
| Commit | `645df99` |
| Date | 2026-10-08 |
| Machine | Windows x64, Ryzen 9 9950X3D2 |
| Command | `npm run verify` |
| Result | exit 0: lint, types, dependency gate, comment gate, build, `git diff --exit-code -- sw.js` and `npm run test:all` all passed. `test:all` ran 202 of 202 files: frontend 104, tests 72, desktop 12, tools 14, all passed |
| Duration | 252.7 s (4.2 min) |
| Reruns | none |

## Full Windows browser run 1 (caches not frozen)

| | |
| --- | --- |
| Commit | `645df99` |
| Date | 2026-10-08 |
| Machine | Windows x64, Ryzen 9 9950X3D2 |
| Command | `.claude/skills/run-splitpage-app/run-tests.ps1 -Port 13000 -Parallel 4`, over every suite (no `-Only`) |
| Result | `ALL PASS - 10282/10282 checks across 191 suite(s)` |
| Duration | 687.3 s (11.5 min) |
| Reruns | none |

## Full Windows browser run 2 (caches frozen)

[Decision D4](milestone-3.md#decisions) asks for both full runs, freeze off and
freeze on, and E7 puts the freeze-on run in the gate. This is a fresh full run
of all 191 suites, not a rerun of anything.

| | |
| --- | --- |
| Commit | `645df99` |
| Date | 2026-10-08 |
| Machine | Windows x64, Ryzen 9 9950X3D2 |
| Command | `SPLITPAGE_FREEZE_CACHES=1`, then `.claude/skills/run-splitpage-app/run-tests.ps1 -Port 13200 -Parallel 4`, over every suite. The harness printed `caches were frozen (freeze-caches=1) for every suite` |
| Result | `ALL PASS - 10473/10473 checks across 191 suite(s)` |
| Duration | 723.1 s (12.1 min) |
| Reruns | none |

The two runs differ by 191 checks, one for each suite. Every suite reports one
more check when the caches are frozen than when they are not, and suite 380
(the frozen-caches suite) reports 5 against 4. Every other count is
identical.

## Electron smoke (dev target)

| | |
| --- | --- |
| Commit | `645df99` |
| Date | 2026-10-08 |
| Machine | Windows x64, Ryzen 9 9950X3D2 |
| Command | from `desktop/`, after `node build.mjs`: `node test/smoke.mjs --only-target dev` (every group) |
| Result | `ALL PASS - 809/809 desktop checks`, 0 skipped |
| Duration | 304.7 s (5.1 min) |
| Reruns | none |

Milestone 2's dev smoke was 806 checks in 234.0 s.

## Windows x64 packaged check

| | |
| --- | --- |
| Commit | `645df99` |
| Date | 2026-10-08 |
| Machine | Windows x64, Ryzen 9 9950X3D2 |
| Tools | Node 22.23.2, Electron 44.4.5, electron-builder 26.15.3 |
| Environment | `npm_config_arch=x64` (`desktop/.npmrc` pins `arch=arm64`) and `CSC_IDENTITY_AUTO_DISCOVERY=false` (see [ci.md](ci.md)); nothing published or uploaded |

Run from `desktop/` after `npm ci` at the root and in `desktop/` (the Electron
binary was missing after `npm ci`, so `node desktop/node_modules/electron/install.js`
ran once):

| Step | Command | Result | Duration |
| --- | --- | --- | --- |
| Stage | `node stage.mjs` | exit 0, version 3.1.0 | 0.3 s |
| Build | `npx electron-builder --config electron-builder.yml --win --x64 --publish never` | exit 0; `dist/win-unpacked`, `SplitpageDesktopSetup-3.1.0-x64.exe` (153,988,689 bytes); `Splitpage.exe` is `NotSigned` | 60.0 s |
| Verify | `node verify-dist.mjs --arch x64` | `ALL PASS - 6/6 architecture checks (x64, version 3.1.0)` | 2.4 s |
| Smoke | `node test/smoke.mjs --only-target packaged-x64` | `ALL PASS - 809/809 desktop checks`, 0 skipped | 256.9 s (4.3 min) |

As in milestone 2, the build also produced the arm64 unpacked folder and both
arm64 installers, because `electron-builder.yml` lists both architectures
under `win.target` and `--x64` does not narrow it. They were not verified or
run; building an ARM64 artifact on x64 is not an ARM64 runtime check (plan
section 7). The electron-builder log shows `signtool.exe` signing steps for
the installers' uninstallers; `Splitpage.exe` itself is unsigned, as in
milestone 2.

## Measured metrics

[Milestone-3.md's exit criteria](milestone-3.md#exit-criteria-plan-5-milestone-3)
name two measured quantities: E5 (the dependency metrics) and E8 (no
document-wide work per keystroke, with `67-render-perf.txt`). Both are
recorded in the [As built section](milestone-3.md#as-built) (3.15: "Measured"
and "Performance", with the [performance record](performance-record.md)), at
`391bda6`. Two pull requests with application changes merged after `391bda6`
and before `645df99`: #453 ("Bound what the HTML parser can add to a paste before sanitising",
`src/adapters/richtext/`) and #456 ("Block editing on a stale screen until
Redraw draws", in `src/js/05-render.js`, `05b-cell-edit.js` and
`21-events.js`). This gate therefore did the following:

- Re-ran `node tools/dep-report.mjs --metrics` on `645df99`: 153 frontend
  modules, 76 migrated, one runtime cycle of 53 modules and 411 edges, `S`
  with 54 importers, 31 writers, 26 field writers and 9 `S.state` assigners.
  Against 3.15's end column, the only differences are one more frontend module
  and one more migrated module (`parse-bound.ts`, #453). The dependency gate
  passed in `npm run verify`.
- Did not re-run the typing performance record. Typing p50 and p95 are
  recorded at `391bda6`, not at `645df99`, and #456 touched the render path (the full runs and smokes above did run on that code).
  Suite 67 (`67-render-perf.txt`) passed in both full runs above (43/43 plain,
  44/44 frozen), but that is a pass/fail check, not the p50 and p95
  comparison. Whether to re-measure is the coordinator's call.

## Closing suite set

The browser suites that pin the text commands are the 40 suites listed in
[milestone-3.md, "The text-command suite set"](milestone-3.md#the-text-command-suite-set)
(`^(02|06|09|19|20|28|43|45|46|52|65|67|68|69|73|75|76|77|78|80|81|84|86|91|92|155|160|185|186|187|190|241|245|246|262|267|288|289|322)-`).
The gate does not run only that set: both full runs above ran all 191 suites,
and so ran every one of the 40.

## Windows ARM64 packaged check

Moved to the 4.0 release gate (Adam, 2026-10-01), as for milestone 2. Windows
on ARM can run the x64 build under emulation in the meantime.

## Linux full browser run

Moved to the 4.0 release gate (#314), where `tools/run-suites.mjs` runs the
full regression on Linux. Hosted CI keeps running on Linux on every pull
request.

## External review

[Decision D7](milestone-3.md#decisions) names Codex as the external reviewer of
the integrated milestone, and [section 8 of review.md](review.md#8-milestone-gates)
requires the review to state what kind it was and to include the text
commands' undo and anchor behaviour.

| | |
| --- | --- |
| Reviewer | Pending: external review (Codex, coordinator) |
| Kind | Not yet stated |
| Snapshot | `645df99` |
| Date | Not yet |
| Verdict | Not yet |

## Blockers for Adam

None from the runs: every run section 8 requires on this machine passed on the
exact merged tree, and the ARM64 and Linux checks are moved to the 4.0 release
gate by decision. Milestone 3 closes when the external review above is
recorded and its findings are handled under section 6 of review.md.
