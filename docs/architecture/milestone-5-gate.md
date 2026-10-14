# Milestone 5 gate record

The recorded runs that the [gate section of the plan](../IMPLEMENTATION-PLAN.md#5--make-formats-consume-captured-data-and-one-registry)
requires before milestone 5 closes, on the merged milestone 5 tree. The
milestone is described in [milestone-5.md](milestone-5.md).

Final milestone 5 tree: `dcfb92d977366ff53c2947a1676aff7c131b7f25`, the merge of
#582 (5.4, the format registry) into `4.0-development` on 2026-10-14. All code
steps are merged (see [the PR list](#pull-requests)). Every run below ran on
`dcfb92d` itself.

## Summary

| Gate requirement | Result | Status |
| --- | --- | --- |
| Full Windows browser run, plain | 10378/10378 checks across 194 suites | passed |
| Full Windows browser run, caches frozen (`SPLITPAGE_FREEZE_CACHES=1`) | 10572/10572 checks across 194 suites | passed |
| Electron smoke, dev target | one invocation: 974/974, 0 skipped | passed |
| `SPLITPAGE_M4_GATE=1 npm run verify` (race matrix, no case demoted) | exit 0; 255 type-check cases; `test:all` 262 of 262 files | passed |
| Capture-after-mutation, held-asset, import stored-bytes, INV-60 and exporter-route checks added by #574 | all located by content and passing ([below](#checks-added-by-574)) | passed |
| Windows x64 packaged check | stage and build exit 0; verify-dist 6/6; packaged smoke 974/974 | passed (run although the plan does not require it) |
| External review | Codex `gpt-6.1-sol` (xhigh), in progress | [pending](#external-review) |
| Linux full run and native ARM64 | moved to the 4.0 release gate | not run here |

Every run ran once, on `dcfb92d` itself, with no failure, flake or rerun.

## Pull requests

| Step | PR | Merge commit |
| --- | --- | --- |
| 5.1 The remaining writers take the captured document | #576 | `3e37ede` |
| 5.2 Byte helpers moved out of `14-export.js` | #577 | `1f096dd` |
| 5.2b Writers read the captured document (projection) | #579 | `74f6ecd` |
| 5.3 Import as a session command | #581 | `ab9e301` |
| 5.4 The format registry | #582 | `dcfb92d` |
| Tooling: `perf-ab` | #578 | |
| CI cleanup | #580 | |

The plan edits that added this gate's checks are #574. Node 24 (#583) is a
separate change and lands right after milestone 5 closes.

## Machine

| | |
| --- | --- |
| Commit | `dcfb92d977366ff53c2947a1676aff7c131b7f25` |
| Date | 2026-10-14 |
| Machine | Windows 11 Pro 10.0.26300, x64 |
| Tools | Node v22.23.2 (`.nvmrc` says 22.22.2), Electron 44.4.5 (x64, installed by hand because `desktop/.npmrc` pins ARM64), electron-builder 26.15.3 |
| Environment | 8 browser lanes, about 9 GB of RAM free and CPU near 10% at the start; the installed app was left alone; no source was changed |

## Full Windows browser runs

| Run | Result |
| --- | --- |
| Plain | `ALL PASS`, 10378/10378 checks, 194 suites |
| Frozen (`SPLITPAGE_FREEZE_CACHES=1`) | `ALL PASS`, 10572/10572 checks, 194 suites |

The counts equal the [milestone 4 gate](milestone-4-gate.md): milestone 5
added no browser suites.

## Fast gates

`SPLITPAGE_M4_GATE=1 npm run verify`: exit 0 in 246 s. The type-check cases ran
255 passed; `test:all` ran 262 of 262 files (frontend 140, tests 90, desktop
15, tools 17). No matrix case was demoted.

## Checks added by #574

PR #574 only edited the plan, so the checks were located by content in the node
tests and each file ran on its own with `SPLITPAGE_M4_GATE=1`. None is skipped
or todo.

| File | Result | Holds |
| --- | --- | --- |
| `m4-matrix-exports` | 17/17 | X18 (every export route builds from the one capture taken before its first await) and X19 (held local picture reads keep the captured pictures) |
| `m4-matrix-files` | 31/31 | the stored-byte import writeback cases (I3 to I6) |
| `export-registry-app` | 4/4 | a new exporter reaches the menu, palette, dialog and Export Again from one registration; the matrix lists every registered exporter |
| `export-capture-app` | 2/2 | the captured document's key list |
| `export-projections` | 4/4 | the shared projections |
| `import-rows` | 9/9 | the import session command |

Other export and import files, which also pass: `m4-matrix-hosted` 24/24,
`exports-golden` 5/5, `text-exports` 10/10, `xlsx-export` 8/8,
`docx-reimport` 16/16, `comment-images-export` 4/4, `export-kit` 10/10.

No test is named for INV-60 or capture-after-mutation, so they were matched by
content: the plan names `m4-matrix-exports` and `import-rows` for them, and
the tests' own labels are the evidence. The INV-60 different-times case was
not confirmed individually.

## Electron smoke (dev target)

`node test/smoke.mjs --only-target dev`, from `desktop/`, one invocation:
`ALL PASS - 974/974 desktop checks`, 0 skipped, 302 s.

## Windows x64 packaged check

The plan's gate does not require this check (packaging inputs, runtime loading
and the build entry did not change); it was run anyway.

| Step | Command | Result |
| --- | --- | --- |
| Stage | `node stage.mjs` | exit 0 |
| Build | `npx electron-builder --config electron-builder.yml --win --x64 --publish never` | exit 0 in 51 s |
| Verify | `node verify-dist.mjs --arch x64` | `ALL PASS - 6/6 architecture checks` |
| Smoke | `node test/smoke.mjs --only-target packaged-x64` | `ALL PASS - 974/974 desktop checks`, 0 skipped, 309 s |

## Not run

- Output from independent readers or viewers on representative DOCX, XLSX and
  PDF files, and the project round trips, which the plan's gate asks for. The
  deterministic byte fixtures, `docx-reimport` and the golden export tests
  pass in the runs above; the independent-viewer pass is not recorded here.
- The Linux full run and native ARM64, which wait for the 4.0 release gate.

## External review

A Codex `gpt-6.1-sol` (xhigh) code review of `2cc8bf2..dcfb92d` is in progress.
Adam decided that milestone 5 is done only after its findings are triaged
(blockers fixed, the rest filed as issues). The triage and the disposition
table are added here when the review lands.

## Blockers for Adam

None from the runs: every run passed on the exact merged tree. Milestone 5
closes when the external review's triage is recorded.
