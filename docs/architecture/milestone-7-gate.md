# Milestone 7 gate record

The recorded evidence that [the gate section of milestone 7](milestone-7.md#the-gate)
requires before milestone 7 closes, on the merged milestone 7 tree. The
milestone is described in [milestone-7.md](milestone-7.md).

Closing tree: `53dff02`, the merge of #633 into `4.0-development` on
2026-10-15. It is `cbab324` (the merge of M7 PR 2, #632) plus #633, which
changes only `desktop/test/smoke.mjs` (one added line). The Windows full runs
below ran on `cbab324`; the Electron smoke ran on `53dff02`
([why that is acceptable](#the-tree-each-run-covers)).

## Summary

| Gate requirement | Result | Status |
| --- | --- | --- |
| Completed frontend areas: acyclic dependencies, strict types, no authored comments, one document-mutation boundary | `npm run verify` green on Node 24.22.0 in the reviews of #630 and #632 and on this record's tree; `node tools/dep-report.mjs --metrics` on `53dff02`: one runtime cycle, 46 modules, 310 edges | passed |
| Wiring tests: startup, failed partial startup, cleanup | `tests/bootstrap/wiring.test.ts`, passing in every run below ([below](#wiring-and-shim-tests)) | passed |
| Nothing migrated imports or registers into the shim | `tests/bootstrap/legacy-shim.test.ts` passing; `_entry.js` specifiers equal the frozen set ([below](#shim-status-at-53dff02)) | passed |
| Remaining legacy exceptions exact and visible | baseline 515 entries before 7.2, 514 after; `npm run check:deps` 0 new, 0 resolved; no entry names milestone 7 ([below](#dependency-baseline)) | passed |
| Resource release on replacement | race matrix with `SPLITPAGE_M4_GATE=1` 181/181 and the 294-row remount test 4/4, in the reviews of #630 and #632; no matrix case demoted or weakened | passed |
| INV-30 | `13-onboarding.txt` passing in the browser suites of both reviews; the INV-30 bootstrap test in `wiring.test.ts` (three arrival kinds and the pristine controls) | passed |
| Full Windows browser run, plain | `cbab324`: 10393/10393 across 194 suites, first run | passed |
| Full Windows browser run, caches frozen (`SPLITPAGE_FREEZE_CACHES=1`) | `cbab324`: 10587/10587 across 194 suites, first run | passed |
| Electron smoke, dev target | `53dff02`: 974/974, 0 skipped, first run. 971/972 on `cbab324` and earlier heads, a test race fixed by #633 ([below](#the-531-smoke-case)) | passed |
| Windows x64 packaged check | not required: the build entry does not change and no packaging input moved | not required |
| CI on the merges | push runs for `9c39567`, `cbab324` and `53dff02` succeeded ([below](#ci-on-the-closing-tree)) | passed |
| External review | the 4.0 release review of milestones 5 and 7 (Astra, Codex CLI, on `53dff02`): 1 blocking and 1 should-fix finding for milestone 7, 1 should-fix for milestone 5; verdict no for both ([below](#external-review)) | finding 3 closed by #635 (`81ae567`); findings 1 and 2 only partly closed by #636 (`23b49a7`) per Sol's re-review, a further fix PR is open ([below](#re-review-of-the-fixes)); M5 PDF check open |
| Linux full run, native ARM64, Docker, portable, 3.1 exchange | the 4.0 release gate; see [release-4.0-checklist.md](release-4.0-checklist.md) | not part of this gate |

## Pull requests

| Step | PR | Merge commit | Review and merge record |
| --- | --- | --- | --- |
| Plan | #625 (plan), #628 (Astra plan review applied) | `e73dd98`, `51f30aa` | in the PRs |
| 7.1 The wiring step and legacy shim | #630 | `9c39567` | [review and merge record](https://github.com/RetroGorilla/splitpage/pull/630#issuecomment-6201981053) |
| 7.2 Finish the wiring | #632 | `cbab324` | [review findings](https://github.com/RetroGorilla/splitpage/pull/632#issuecomment-6203157858), [author's fixes](https://github.com/RetroGorilla/splitpage/pull/632#issuecomment-6203378625), [merge record](https://github.com/RetroGorilla/splitpage/pull/632#issuecomment-6203528223) |
| Smoke test fix | #633 | `53dff02` | [smoke evidence](https://github.com/RetroGorilla/splitpage/pull/633#issuecomment-6204156796), [review and merge record](https://github.com/RetroGorilla/splitpage/pull/633#issuecomment-6204371730) |

Each code PR passed CI and an independent review by a thread that did not
write it.

- **#630.** No blockers or concerns. The reviewer planted 14 bugs in a scratch
  copy (actions starting after the mounts, a cancel before DOM ready not
  releasing the wiring, no rollback on a failed step, unconditional undo
  uninstalls, a new shim import, 14e registering on load again, and others);
  each made a test fail. Three non-blocking nits were carried into 7.2: the
  survivor test did not name its survivors, "As built" should say the mounts
  still read the facades, and the session release could skip the undo
  uninstalls when `dispose()` threw. 7.2 closed all three.
- **#632.** One blocking finding: the seed-check port in
  `22f-startup-wiring.js` had no test, so a pristine copy could boot as a saved
  file without any test failing. Fixed in `aeee32f` with a booted-app test
  (`_initial-load-probe.mjs`) that checks a fresh id and `docIdWrittenOut`
  false for a pristine copy and the file's id for a saved page. Two optional
  findings were also fixed: a test for the session release's `try`/`finally`,
  and `startTestSession` throwing instead of ignoring its dependencies when a
  session is already running. Before the fix the reviewer's planted bugs were
  caught 7/7 by the load-order test, 4/4 by the INV-30 test and 7/7 by the
  wiring and startup tests; the four bugs re-planted after the fix were all
  caught.
- **7.2 beyond the plan's table.** The load-order test found two load-time
  registrations the plan did not list: `06-rows.js` registered
  `onDocumentReplaced(releaseSessionVideoUrls)` and `20c-help.js` called
  `handTourPauseTo(...)` at module evaluation. Both moved into their module's
  `__init`. The #632 review judged this in scope, since these are the
  configurations the test exists to catch.
- **#633.** No findings; one added line in `desktop/test/smoke.mjs`. See
  [the #531 smoke case](#the-531-smoke-case).

## Wiring and shim tests

- `tests/bootstrap/wiring.test.ts`: startup order; missing and throwing
  dependencies for every wiring step, with the owners already built disposed;
  every former provider and each of the five effects omitted in turn; the
  booted app's start and stop order, stop before DOM ready, an action-start
  failure, a mount failure and repeated starts; undo teardown and stale
  uninstalls; three wire, start and dispose cycles on a fake clock; the
  surviving app-lifetime listeners named by target and event; INV-30; the
  seed-check port on the booted app.
- `tests/bootstrap/legacy-shim.test.ts`: nothing in `src/application`,
  `src/features` or `src/bootstrap` imports `_entry.js`; the shim's specifiers
  are within the frozen set of 72; and the load-order check over all 79
  numbered modules (the ten load-only ones included), with a positive control
  and a guard that every configuration-named export is on the spy list.
- The #632 review ran `tests/bootstrap` at 39/39 on `c5615fc`; `npm run verify`
  on `aeee32f` (the merged head of #632) was green with tests 135/135 files.

## Windows runs

Windows 11 x64 PC, Node 24.22.0, Electron 44.4.5 (x64, from a separate
worktree through a temporary junction, since `desktop/.npmrc` pins ARM64).
Source: the [gate evidence comment on #632](https://github.com/RetroGorilla/splitpage/pull/632#issuecomment-6204446147).
Logs are kept under `D:\vibecoding\.scratch\m7gate\` on the gate machine.

| Head | Run | Result |
| --- | --- | --- |
| `cbab324` | Plain full run (`run-tests.ps1 -Parallel 12`) | 10393/10393, 194 suites, first run |
| `cbab324` | Frozen caches full run (`SPLITPAGE_FREEZE_CACHES=1`) | 10587/10587, 194 suites, first run |
| `cbab324` | Electron dev smoke, two full runs | 971/972 each; the #531 group failed |
| `6514716` (#633's head) | Smoke, `--only-group torn`, three runs | 19/19 each |
| `53dff02` | Electron dev smoke | 974/974, 0 skipped, first run |

The plain and frozen totals match the milestone 6 gate's (10393 and 10587
across 194 suites).

### The #531 smoke case

The one failing group on `cbab324` was "under --host, a tab torn off during the
last window's close keeps the stop-sharing prompt", with
`window.splitpageDesktop` undefined at `getSessionInfo()`. It failed the same
way on `9c39567` (the base of #632), on `2b891f8` (the milestone 6 closing
tree) and on `2d19032`, on a machine with nothing else running, so it is not a
milestone 7 regression.

The cause was in the test. `connectTab` waits only for the new tab's debugging
target to exist, not for its page to load, and the case read
`window.splitpageDesktop` straight after it, before the new tab's preload had
run. Every sibling `connectTab` case (the #509, #531 window and #532 cases)
already waits with `waitForRows`. #633 adds `await waitForRows(cdpB, 20000);`
after `connectTab`. It is a test race, not a product defect, and no assertion
was loosened.

The same race explains the milestone 6 record: its single pass of that group
and its earlier 1-of-2 failure on `2d19032`, listed under
[Flakes seen](milestone-6-gate.md#flakes-seen) as harness timing, were this
race, not a flake of unknown cause.

### The tree each run covers

The Windows full runs are from `cbab324` and the smoke is from `53dff02`. The
full runs were not repeated on `53dff02` because #633 changes only
`desktop/test/smoke.mjs`: no source, no browser suite and no build input
differs between the two trees, so the browser runs on `cbab324` cover the
closing tree's code.

## Shim status at `53dff02`

Counted in the repository at `53dff02` for this record:

| | Count | How |
| --- | --- | --- |
| `src/js/_entry.js` | 170 lines | `wc -l` |
| Import statements in `_entry.js` | 80 | lines starting with `import` |
| Unique import specifiers in `_entry.js` | 72, equal to the frozen set in `tests/bootstrap/legacy-shim.test.ts` (none missing, none extra) | parsed both files and compared the sets |
| Frozen set members | 72: 70 numbered modules (the 69 the shim starts and `14e-export-formats.js`) plus `../bootstrap/wiring.ts` and `../bootstrap/app.ts` | the test asserts 72 and 70 |
| Numbered modules in `src/js` | 79; the shim starts 69, ten load only as imports (`03c`, `14c`, `14d`, `14e`, `22a` to `22f`) | `ls`, `__init` imports in `_entry.js` |
| Bridge-style files in `src/legacy` | 23 files, 1,451 lines | `ls`, `wc -l` |
| Import statements from `legacy/` in `src/js` | 106, in 57 files; none in `_entry.js` | grep |
| Test files under `src/test` and `tests` naming `legacy/session-bridge` | 38 | `grep -rl` |
| Runtime import cycles | one, 46 modules, 310 edges | `node tools/dep-report.mjs --metrics` |

Rechecked at `23b49a7` after the review fixes: the same counts, except the
bridge files are 1,452 lines (#636 added one line to `save-bridge.ts`).

These match the [release-checklist inputs](milestone-7.md#release-checklist-inputs)
in milestone-7.md, except the session-bridge test count: that section says 35
files "reference the session bridge"; the 38 here is a plain text search over
`src/test` and `tests` and includes helpers such as `_app-session.mjs`. At
`2b891f8` (the milestone 6 record) there were 110 imports in 58 files and
1,387 bridge lines; 7.1 moved the shim's bridge imports into
`src/bootstrap/wiring.ts`, and 7.2 added the bridges' start and release code.

## Dependency baseline

On `53dff02`, `tools/dep-baseline.json` has 514 exceptions. None names
milestone 7; 21 name the 4.x composition root (the 20 state entries for `22a`,
`22b`, `22c`, `22d` and `22f` that 7.2 reworded, and an older `document-ports.ts`
entry that mentions it). 7.2 pruned the `02b-doc-id.js → 20b-onboarding.js` cycle edge (515 to
514); 7.1 left the file unchanged. Both reviews report `npm run check:deps` at
0 new and 0 resolved.

## CI on the closing tree

All three code merges' push runs on `4.0-development` completed with success,
and none was cancelled by a later docs merge:

| Merge | Run | Result |
| --- | --- | --- |
| `9c39567` (#630) | [38805062610](https://github.com/RetroGorilla/splitpage/actions/runs/38805062610) | success |
| `cbab324` (#632) | [38816948612](https://github.com/RetroGorilla/splitpage/actions/runs/38816948612) | success |
| `53dff02` (#633) | [38823412088](https://github.com/RetroGorilla/splitpage/actions/runs/38823412088) | success |

## Caveats carried forward

- **From milestone 6.** The milestone 6 record states that #629 changed code
  after its Windows runs and Electron smoke, which ran on `595c2c0` and
  `2d19032`, and that they were not repeated on `2b891f8`. Milestone 7's runs
  close that gap: the Windows full runs on `cbab324` and the smoke on `53dff02`
  include every #629 change.
- **Windows runs and smoke on different trees.** See
  [above](#the-tree-each-run-covers).
- **Accepted in 7.1.** 18c subscribes to `exportFormats.onChange` in its
  `__init`, so after a rewire in a test it stays attached to the first
  registry. Production never rewires.
- **Accepted in milestone 6.** A throwing cleanup step inside one feature skips
  that feature's remaining cleanup; nothing can throw there today.

## Moves to 4.x

Per [the plan](milestone-7.md#decisions-taken) and plan section 8:

- The roughly 100 remaining numbered-module imports of the bridges (106 at
  `53dff02`); the mounts still read the registries and session through the
  facades (decision 4).
- The composition root as the build entry; `_entry.js` keeps its path.
- `tools/modularize.mjs` stays untouched (decision 5); rerunning it would
  overwrite the shim.
- The two test nits from Sol's re-review of #629
  (`app-stop-errors-app.test.mjs` injects one shutdown failure;
  `rows-drag-dispose-app.test.mjs` never creates drop markers).
- One shared listener helper in place of the copy in eight features (6.8.5).

## External review

As the [2026-10-07 re-scope](milestones-4-7-rescope.md#updated-spec-for-the-rest-of-40)
decided and Adam reaffirmed on 2026-10-15, milestone 7's external review is
folded into the 4.0 release review, which covers milestones 5 and 7 together
(item 8 of [the release checklist](release-4.0-checklist.md)). That review ran
on the closing tree on the same day. The milestone 7 plan had its own external
review (Astra, Codex CLI, 2026-10-15), applied by #628.

| | |
| --- | --- |
| Reviewer | Astra (Codex CLI), a read-only session that took no part in building or reviewing milestones 5 or 7 |
| Scope | Source review of milestones 5 and 7 on an archive copy of `53dff02` |
| Date | 2026-10-15 |
| Verdict | "**Gate verdict: M5 — NO, required output-verification evidence remains missing; M7 — NO, teardown and dependency-validation requirements remain incomplete.**" |
| Limits | No files changed; no builds or tests ran. Historical PR diffs were not in the archive, so #633's one line was not attributed independently. Codec and layout code was inspected selectively. The Windows and Electron results above are supplied evidence, not verified by the reviewer. Linux and macOS runs, packaged applications, independent document viewers, the wider milestone 6 code and the deferred release matrix were not reviewed |

| # | Severity | Milestone | Finding | Decision |
| --- | --- | --- | --- | --- |
| 1 | blocking | 7 | Teardown leaves an active save running against released bridges. `src/legacy/save-bridge.ts:59` only clears the installed coordinator and does not stop its queue or continuations. After disposal, a held write that completes reaches the ownership check in `src/application/save/coordinator.ts:164`, which calls the now-unstarted transition bridge; that throws into a promise chain with no terminal rejection handler, so the original save request never reaches `current.settle` (`coordinator.ts:222`). After a rewire, old continuations can consult the replacement owners. Production does not call teardown, but the contract does not hold. Suggested: a coordinator shutdown that settles queued requests, guards active completions and keeps later callbacks away from released or replacement owners | Partly fixed in #636, merged as `23b49a7` on 2026-10-16 ([merge record](https://github.com/RetroGorilla/splitpage/pull/636#issuecomment-6205122166)), with the wiring test gaps; see [the re-review](#re-review-of-the-fixes) (R1) |
| 2 | should-fix | 7 | `wireApp` accepts incomplete dependency objects. `src/bootstrap/wiring.ts:117` validates the transition ports only as objects, so `{ live: {}, destination: {}, identity: {} }` passes and fails later at `src/application/transitions/transitions.ts:60`, after startup can proceed. Save-port factory results reach `save-bridge.ts:51` unchecked. Suggested: validate required nested methods and factory results before installing their owners and name the missing port in the `WiringError` | Partly fixed in #636 (`23b49a7`); see [the re-review](#re-review-of-the-fixes) (R2) |
| 3 | should-fix | 5 | An export can combine one exporter's bytes with another registration's filename. `src/js/18-local-files.js:170` keeps the selected exporter before awaiting assets and the build, but line 178 calls `exportFileName`, which looks the exporter up again in the mutable registry (line 145). Replacing or unregistering it while the build is pending changes the filename. Suggested: take the filename from the retained exporter's `fileName(...)`, using the finished product's `imageBundle` flag | **Fixed** in #635 "M5: derive the export filename from the retained exporter", merged as `81ae567` on 2026-10-16 with a held-build exporter swap test ([merge record](https://github.com/RetroGorilla/splitpage/pull/635#issuecomment-6204934037), no blocking findings). The reviewer noted a 4.x test gap: nothing checks the "(with images).zip" export name |

### After the fixes

#636 changes source (`src/application/save/coordinator.ts`,
`src/bootstrap/wiring.ts`, `src/legacy/save-bridge.ts`, `src/js/20b-onboarding.js`)
and tests; #635 changes `src/js/18-local-files.js` and one test. The tree after
them is `23b49a7`, the merge of #636. Evidence on it, from
the two merge records: CI and an independent review on each PR, with one
should-fix test gap in #636 fixed by a test-only follow-up before merge, and
the Electron dev smoke at 974/974 on #636's head `2566deb` on Adam's PC. The
Windows full browser runs were not repeated after the fixes; they cover
`cbab324`.

### Re-review of the fixes

| | |
| --- | --- |
| Reviewer | Sol (Codex CLI), a read-only session that took no part in writing #635 or #636 |
| Date | 2026-10-16 |
| Scope | #635 and #636 against findings 1 to 3 and the coverage gaps, on `23b49a7` |
| Verdict | Milestone 5: pass on the code side (finding 3 and its regression coverage closed). Milestone 7: no, findings 1 and 2 only partly closed |

| # | Severity | Finding | Decision |
| --- | --- | --- | --- |
| R1 | blocking | A hosted save held across dispose and a rewire with the same home still reaches the replacement owner: `src/js/13-hosted.js:1290` updates `home.rev` and calls `setBaseState` before the `job.owns()` check at line 1296, so the baseline is forwarded through `confirmBaseline` (`src/js/03-sync.js:821`) into the replacement coordinator via `save-bridge.ts:93` | to be fixed in a further fix PR |
| R2 | should-fix | Validation is still incomplete: `src/bootstrap/wiring.ts:89` checks `timers` only as an object (`effects.ts:44` calls `timers.now` later), and `wiring.ts:223` does not validate the recovery factory's `desktop` function (`draft-store-desktop.ts:12` defers the call) | to be fixed in the same PR as R1 |

Sol also confirmed the INV-30 probe gap closed: `20b-onboarding.js:361`
keeps the auto-show promise and the probe awaits it instead of a fixed window.

**Promised but not delivered**, as the review lists it:

- Milestone 5's independent output checks: plan section 5 (milestone 5)
  requires representative DOCX, XLSX and PDF reader or viewer checks and
  recorded project round trips; [milestone-5-gate.md](milestone-5-gate.md)
  lists them under "Not run". Passing byte fixtures do not supply this
  evidence. Run on Adam's PC at `53dff02` under the recommended option of
  his decision card ("Run now"; the other options were "Accept fixtures" and
  "Defer"): DOCX and XLSX pass in Word and Excel 16.0, the project round trips
  pass, and the PDF check is **open** until a person opens the PDFs, since the
  PC has no PDF reader. Details in
  [milestone-5-gate.md](milestone-5-gate.md#viewer-checks-and-round-trips-amendment-2026-10-15).
- Milestone 7's teardown and missing-dependency contracts, as findings 1 and 2
  show.
- The review accepts the deferred composition-root switch, bridge retirement
  and `S` cleanup as agreed scope reductions, not missing deliverables.

**Test coverage gaps** the review names:

- `tests/bootstrap/wiring.test.ts:401` covers timer and subscriber cleanup but
  never disposes the wiring with a save in flight and another queued. Wanted:
  held-write cases with and without a later rewire, asserting every promise
  settles and no replacement owner gets a callback.
- The missing-dependency cases (`wiring.test.ts:232`) remove whole ports, not
  methods inside a present object, and never return a malformed factory
  result.
- The export tests change the document and preferences during a build but
  never replace or unregister the selected exporter during a held build.
- The INV-30 probe watches for a fixed window of about 500 ms
  (`src/test/_onboarding-probe.mjs:53`); an explicit completion signal would
  make its negative assertions stronger and less sensitive to machine load.

The review text is kept with the project's files and on the maintainer's
machine; this section is the disposition.

## Blockers for Adam

- Milestone 7 stays open. Sol's re-review of the fixes at `23b49a7` closed
  finding 3 (#635) but found findings 1 and 2 only partly closed by #636 (R1
  blocking, R2 should-fix). A further fix PR is open; milestone 7 closes when
  it merges and Sol re-checks it.
- Milestone 5's PDF check still needs a person to open the crafted and
  `LONG_DEMO` script PDFs; DOCX, XLSX and the round trips passed.
