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
| External review | Codex, an outside AI review session: keep the refactor | done; its one concern is closed by #321 |

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

## External review

[Section 8 of review.md](review.md#8-milestone-gates) requires an external
review of the integrated milestone, and requires it to state what kind of
review it was.

| | |
| --- | --- |
| Reviewer | Codex, an independent AI review session that took no part in building or reviewing milestone 2 |
| Kind | A fresh agent, the last of the kinds section 8 allows. Codex does not claim to be a different model from the earlier reviewers. |
| Snapshot | `cb60392` (this record's merge, #319), whose application code is the final milestone 2 tree |
| Date | 2026-10-01 |
| Record | A condensed copy of the review, which Adam received. The findings and numbers are as the reviewer gave them. |

**Verdict: keep the refactor.** In the cases it exercised, the review found no
new user-facing regression. It found no upward dependency and no cycle through
a migrated module. It raised one concern, about how the rules are enforced,
and one optional performance follow-up. It found nothing in the evidence that
justifies a rollback.

### Findings

| Finding | Severity | Closed by |
| --- | --- | --- |
| The dependency gate's `PLATFORM_GLOBALS` (`tools/dep-report.mjs`) omits DOM globals. The reviewer added an ambient `declare const DOMParser`, and a function calling `new DOMParser().parseFromString(...)`, to `src/core/document/text-policy.ts`. Lint, the type check, the dependency gate and `tests/core/environment.test.ts` all passed. A synthetic `XMLSerializer` use was missed too. The positive controls were caught: `Date.now`, `Math.random`, an ambient `Date`, an upward type-only import, a merge-to-production import and a type-only core cycle. No such dependency exists in the snapshot. | Concern | #321, "Dependency gate: forbid DOM globals in core, ambient declarations included", with fail-first tests for ambient declarations and bare references |
| Image-heavy load and merge. Each picture is hashed twice, and its bytes may be copied twice (`decodeImageDataUrl` and `pending()` in `src/core/document/media.ts`, `keepPending` in `src/legacy/document-ports.ts`, `intern` in `src/js/02c-blobs.js`). The reviewer ran an exploratory Node/jsdom probe of ten fresh 1 MiB pictures in comment bodies. The median was about 1,039 ms on milestone 1 and 1,165 ms on milestone 2. This was not a controlled browser benchmark. | Suggestion | #320. The plan's milestone 4 now sets its acceptance criterion. |

The integration assessment agreed with the milestone's own record:

- The metrics reproduced: 135 frontend modules, 58 migrated, a largest cycle of 53 modules and 415 cycle edges.
- The root composition respects the dependency direction.
- `STATE_FIELDS` is the canonical table, and an added field survives migration, merge and the file codec.
- `CellDecoder` and the merge and migrate decoders have coherent roles. Contract tests are still needed.
- The per-pass ingestion's `finally` persistence is sound and tested.
- The jsdom adapter tests preserve the browser behaviour they exercise.
- Keeping the pure HTML encoder in core is reasonable. INV-10's ownership check is still recorded as missing; it is now #327.

### The reviewer's own verification

- `npm run verify` on Node 22.23.2 passed all 144 test files. The server tests gave 615 passes and 1 POSIX-only skip.
- Headless browser suites: 11 suites, 612/612 checks.
- The reviewer rebuilt milestone 1 by reverse-applying `milestone-2.diff`.
- The reviewer ran a deterministic differential, milestone 1 against milestone 2, over 2,600 cases with zero differences: 1,000 migrations, 1,000 merges, 300 b-roll reads and 300 rich-text cases. It compared JSON and key order, input mutation, the next minted id and settled persistence calls.
- The reviewer ran the gate probes and the `DOMParser` mutation, then restored the source byte for byte.

The review did not rerun the following:

- the 181-suite browser run;
- the Electron and packaged smokes;
- ARM64, Linux or Node 24;
- the earlier reviewers' fuzz runs and mutation inventories;
- a full security audit;
- a controlled browser performance comparison.

This record's own runs above cover the first two items on Windows x64.
Hosted CI runs `verify` on Node 24 for every pull request. ARM64 and Linux
wait for the 4.0 release gate.

### Commitments

The reviewer asked for four follow-ups: some requirements need sharper
acceptance tests and named follow-ups. Each one now has a place:

| Commitment | Where |
| --- | --- |
| Fix the demonstrated DOM-global gate loophole | #321 |
| Define acceptance criteria for validated internal document types, and for who owns cached results | [Implementation plan](../IMPLEMENTATION-PLAN.md#3--deliver-one-sessioncommand-vertical-slice), milestone 3, with the blob registry's part in milestone 4 |
| Measure image-heavy load and merge performance | #320, an acceptance criterion in the plan's milestone 4 |
| Give every remaining pinned defect an explicit disposition, especially Unicode editing, undo key order and b-roll anchor/comment loss | [pinned-defects.md](pinned-defects.md) |

## Blockers for Adam

None once #321 merges. Milestone 2 is complete when #321 merges: every run
section 8 requires on this machine is recorded above, the ARM64 and Linux
checks are moved to the 4.0 release gate by decision, and the external review
is recorded with its concern closed by #321.
