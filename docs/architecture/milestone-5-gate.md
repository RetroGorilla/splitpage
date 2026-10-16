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
| External review | Sol (Codex CLI), 2026-10-14: 0 blockers, 3 should-fix, 1 nit; all fixed in #586 (`6993fcf`) | recorded ([below](#external-review)) |
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
| 5.5 Sol review fixes | #586 | `6993fcf` |
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
| `m4-matrix-exports` | 17/17 | X18 (every export route builds from the one capture taken before its first await), X19 (held local picture reads keep the captured pictures) and X22 (INV-60, captures at different times) |
| `m4-matrix-files` | 31/31 | the stored-byte import writeback cases (I3 to I6) |
| `export-registry-app` | 4/4 | a new exporter reaches the menu, palette, dialog and Export Again from one registration; the matrix lists every registered exporter |
| `export-capture-app` | 2/2 | the captured document's key list |
| `export-projections` | 4/4 | the shared projections |
| `import-rows` | 9/9 | the import session command |

Other export and import files, which also pass: `m4-matrix-hosted` 24/24,
`exports-golden` 5/5, `text-exports` 10/10, `xlsx-export` 8/8,
`docx-reimport` 16/16, `comment-images-export` 4/4, `export-kit` 10/10.

No test is named for capture-after-mutation, so it was matched by content: the
plan names `m4-matrix-exports` and `import-rows`, and the tests' own labels are
the evidence. INV-60's different-times check is X22 in `m4-matrix-exports`
(17/17 above).

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

## Viewer checks and round trips (amendment, 2026-10-15)

Run on `53dff02` (the milestone 7 closing tree) on the maintainer's Windows PC
after the 4.0 release review named the missing viewer pass
([milestone 7 gate record](milestone-7-gate.md#external-review)). The six
PDFs, the crafted DOCX and XLSX, `report.json` and the two check scripts are
kept under `D:\vibecoding\.scratch\m5-viewer-check\` on that machine; the
`LONG_DEMO` DOCX and XLSX were not kept.

| Check | Result |
| --- | --- |
| DOCX (script and narration) and XLSX (script, breakdown, b-roll) of the golden "crafted" fixture and `LONG_DEMO` | **PASS**: every file opened in Word 16.0 and Excel 16.0 with no repair prompt. Crafted content compared with the fixture (scenes, tags, breakdown, b-roll, comments with a reply and resolved state; XLSX cell text matched). `LONG_DEMO` checked by page and word counts and sheet ranges only |
| Project round trips (`.splitpage` and Markdown project, build then parse) | **PASS**: no structural differences; identical image SHA-256 for all three images; exporting left the live document unchanged |
| Existing export tests | 79/79 on Node 24.22.0 |
| PDF | **Open**: the PC has no PDF reader (no Acrobat, no LibreOffice). The six PDFs are structurally valid (`%PDF-1.4` header, `%%EOF`, page counts 4, 1, 1 for crafted and 10, 2, 1 for `LONG_DEMO`), and `crafted.pdf` loaded in Edge, confirmed by window title only. A person still has to open the crafted and `LONG_DEMO` script PDFs |

Notes, not findings: Excel showed no pictures in any sheet (whether the
exporter embeds any was not checked), and `crafted.pdf` has one embedded image
object although the document has three images (not investigated).

## External review

| | |
| --- | --- |
| Reviewer | Sol (Codex CLI), model `gpt-6.1-sol` at xhigh effort, on the maintainer's machine: an independent session that took no part in building or reviewing milestone 5 |
| Kind | A different model. Adam chose Sol over Astra for this milestone because it was small and its plan had already been reviewed by Astra |
| Scope | Code review of `2cc8bf2..dcfb92d`, read-only |
| Date | 2026-10-14 |
| Verdict | 0 blockers, 3 should-fix, 1 nit, all in the text exporters; all four fixed in PR #586 (merge `6993fcf`) |
| Vetting | Each finding was checked against the code before the verdict. Sol ran 17 focused application and core tests on Node 22.23.2 and confirmed findings 1 to 3 and the locale mismatch in finding 4 by running the source functions in isolation. It could not run the app tests or the race matrix in its read-only checkout (`jsdom` and `fake-indexeddb` were absent), and ran no build or browser suites; those runs are the gate runs above |

The raw review is kept with the project's files (`sol-m5-review.md`); this
table is the disposition.

| # | Severity | Finding | Decision | Pinned by |
| --- | --- | --- | --- | --- |
| 1 | should-fix | `14d-export-text.js`: picture-only Markdown exports throw, because `markdownHasPicture` needs `assets` and the call omits it | Fixed in #586 (`c461669`) | `export-text-captures.test.mjs`, picture-only scene with the bytes held and missing |
| 2 | should-fix | `14d-export-text.js`: plain-text serialization and the human half of project Markdown read the live clock preference instead of the captured `clockMode` | Fixed in #586 (`c461669`) | `export-text-captures.test.mjs`, preference changed after capture |
| 3 | should-fix | `14d-export-text.js`: two-column Markdown reads the shared blob cache, not the operation's asset map | Fixed in #586 (`c461669`) | `export-text-captures.test.mjs`, shared cache cleared after capture. The new `md-table` variant of X19 in `m4-matrix-exports` also passes on the old code, so the unit test, not the matrix case, pins this bug |
| 4 | nit | `export-projections.test.mjs`: the clock assertion depends on the machine's locale | Fixed in #586 (`c461669`) | `export-projections.test.mjs`, preference set to 12-hour before capture and 24-hour after |

Sol checked these and found them sound: append and replace import (one session
transaction, rows copied and stamped once, anchors reconciled, a failed scan
rolls back, new-document scanning before adoption); the registry (action IDs,
filenames and persisted Export Again values preserved); import writeback
ownership checks and hosted Save As; PDF, DOCX, XLSX and ZIP dates derived from
the capture, with golden fixture payloads unchanged; and the `perf-ab` fixture's
`node_modules` ignore entry.

## Blockers for Adam

None. Every run passed on the exact merged tree, and the external review's
findings are fixed. The gate runs were made on `dcfb92d`, before the review
fixes; #586 changed only the text exporters and their tests (five files), and
its own CI and independent review ran on it.
