# Milestone 0 baseline runs

Recorded 30 September 2026 on `4.0-development` after the forward merge of
`3.1.x-development`, in a Linux cloud container (4 × Xeon 2.8 GHz, 15.7 GB,
Node 22.22.2, headless Chromium 141 from Playwright).

## Fast gates

| Check | Node 22.22.2 | Node 24.21.0 |
| --- | --- | --- |
| Clean `npm ci` | passed | passed |
| `npm run verify` (lint, typecheck, check:deps, check:comments, build, test:all) | passed | passed |
| Unit files (`src/test`) | 63 of 63, 908 tests | 63 of 63 |
| Desktop unit files | 11 of 11 | 11 of 11 |
| Tool test files | 7 of 7 | 7 of 7 |

## Browser suites, Linux

`node tools/run-suites.mjs <out> --lanes 3`: 162 of 162 suites ran, 159
passed. The three failures fail the same way, checks included, on the commit
before this work began (`57ff359`) and on a one-lane rerun, so they are not
caused by the milestone 0 changes:

| Suite | Result | Failing checks |
| --- | --- | --- |
| `102-rundown-lens.txt` | 91/94 | the focus lens does not engage; blocks 13 and 14 narrower than 80 and 60 px |
| `252-header-presence-fit.txt` | 12–15/18 (varies) | presence chips do not fit the header as asserted |
| `38-newtab-phone.txt` | 19/20 | a New Tab element overflows the phone viewport |

All three measure widths. In this container the app's web fonts do not load
(the script font measured as a fallback family in
[performance-record.md](performance-record.md)), which the run-splitpage-app
skill names as a cause of width disagreements. Rerunning with the fonts loaded
was not done here, so the cause is suspected, not confirmed.

## Not run

| Check | Why |
| --- | --- |
| Browser suites on Windows (`run-tests.ps1`) | no Windows machine in this environment |
| Electron smoke (`desktop/test/smoke.mjs`) | not run in this session |
| Windows x64 and ARM64 packaged checks | need the maintainer's devices |
| CI on a pull request | no pull request has been opened for this work yet |

Milestone 0's gate needs the Windows browser baseline or a recorded blocker,
and the platform runs, before milestone 1 moves behaviour.
