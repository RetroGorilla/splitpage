# Milestone 2 gate record

The recorded runs that [section 8 of review.md](review.md#8-milestone-gates)
and [section 4 of the implementation plan](../IMPLEMENTATION-PLAN.md#4-verification-baseline-and-ci-policy)
require before milestone 2 closes, on the merged milestone 2 tree. The
milestone itself is described in [milestone-2.md](milestone-2.md).

Final milestone 2 tree: `c4d5944`, the merge of #318, which is `823cde0` (the
merge of #317, `m2/close`) plus one change to `desktop/test/smoke.mjs`. Each
check below states the commit it ran on. The browser run and the x64 build ran
on `823cde0` and still stand for `c4d5944`: the only file that differs between
the two is `desktop/test/smoke.mjs`, which no browser suite uses and which is
not part of the packaged app. The smoke reruns ran from this branch's merge of
`c4d5944` (`6318c58`), whose application code is identical to `c4d5944`.

Machine for every run below: Windows x64, Ryzen 9 9950X3D2 (Windows 11 Pro
10.0.26300, Node 22.23.2).

## Summary

| Check | Result | Status |
| --- | --- | --- |
| Full Windows browser run | 9574/9574 checks across 181 suites | passed |
| Electron smoke, dev target | 806/806 desktop checks | passed |
| Windows x64 packaged check | verify-dist 6/6; packaged smoke 806/806 on the rerun | passed |
| Windows ARM64 packaged check | native check moved to the 4.0 release gate | not run here |
| Linux full browser run | moved to the 4.0 release gate (#314) | not run here |
| External review | with an outside reviewer | open, see "Blockers for Adam" |

## Full Windows browser run

| | |
| --- | --- |
| Commit | `823cde0` |
| Date | 2026-10-01 |
| Machine | Windows x64, Ryzen 9 9950X3D2 |
| Command | `run-tests.ps1` with 18 lanes |
| Result | `ALL PASS - 9574/9574 checks across 181 suite(s)` |
| Duration | about 3 minutes |
| Reruns | none |

The smoke-test fix (#318, "Electron smoke: dismiss the conflict dialog before
Save As; pin the refusal") changed only `desktop/test/smoke.mjs`, which no
browser suite uses, so this run stands for the final tree `c4d5944`.

## Electron smoke (dev target)

| | |
| --- | --- |
| Commit | `6318c58` (this branch: `c4d5944`, the merge of #318, merged in) |
| Date | 2026-10-01 |
| Machine | Windows x64, Ryzen 9 9950X3D2 |
| Command | from `desktop/`: `node test/smoke.mjs --only-target dev` |
| Result | `ALL PASS - 806/806 desktop checks`, 0 skipped |
| Duration | 234.0 s (3.9 min) |
| Reruns | none |

## Windows x64 packaged check

| | |
| --- | --- |
| Commit | `823cde0` |
| Date | 2026-10-01 |
| Machine | Windows x64, Ryzen 9 9950X3D2 |
| Tools | Node 22.23.2, Electron 44.3.0, electron-builder 26.15.3 |
| Environment | `npm_config_arch=x64` (`desktop/.npmrc` pins `arch=arm64`) and `CSC_IDENTITY_AUTO_DISCOVERY=false` (see [ci.md](ci.md)); nothing published or uploaded |

Run from `desktop/` after `npm ci` at the root and in `desktop/`:

| Step | Command | Result | Duration |
| --- | --- | --- | --- |
| Stage | `node stage.mjs` | exit 0, version 3.1.0 | 0.8 s |
| Build | `npx electron-builder --config electron-builder.yml --win --x64 --publish never` | exit 0; `dist/win-unpacked`, `SplitpageDesktopSetup-3.1.0-x64.exe` (153,946,935 bytes); `Splitpage.exe` is `NotSigned` | 69.1 s |
| Verify | `node verify-dist.mjs --arch x64` | `ALL PASS - 6/6 architecture checks (x64, version 3.1.0)` | 2.3 s |
| Smoke (first run, history) | `node test/smoke.mjs --only-target packaged-x64` | `800/802 desktop checks passed`, 0 skipped, exit 1 | 261.2 s (4.4 min) |

The build also produced the arm64 unpacked folder and both arm64 installers,
because `electron-builder.yml` lists both architectures under `win.target` and
`--x64` did not narrow it. They were not verified or run; building an ARM64
artifact on x64 is not an ARM64 runtime check (plan section 7).

The first smoke run, on `823cde0`, had two failures, in the
"open/save/conflict/save-as/export" group: `Save As (answered dialog) writes
the new file` and `export-md writes a .md file`. A stale test left the conflict
modal open, and the app correctly refused Save As under a dialog. #318 fixed
the test; the app was not changed. Every other check passed.

| Step | Command | Result | Duration |
| --- | --- | --- | --- |
| Smoke (rerun) | `node test/smoke.mjs --only-target packaged-x64` against the same `dist/win-unpacked`, not rebuilt | `ALL PASS - 806/806 desktop checks`, 0 skipped, run from commit `6318c58` on 2026-10-01 | 227.1 s (3.8 min) |

The build and `verify-dist` above ran on `823cde0` and stand for `c4d5944`:
the packaged app contains none of the changed file.

## Windows ARM64 packaged check

Moved to the 4.0 release gate (Adam, 2026-10-01). Windows on ARM can run the
x64 build under emulation in the meantime, and the native ARM64 package is
still checked at the 4.0 release gate, with the ARM64 device and the full
`verify-dist.mjs --arch arm64` and packaged-arm64 smoke.

## Linux full browser run

Moved to the 4.0 release gate (#314), where `tools/run-suites.mjs` runs the
full regression on Linux. Hosted CI keeps running on Linux on every pull
request.

## Blockers for Adam

- The external review of the integrated milestone, which Adam is taking to an
  outside reviewer. The milestone does not close until it is done (review.md
  section 8).
