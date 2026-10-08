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
| External review | Codex, GPT-6-Astra (High), on `645df99`: keep the refactor; 3 should-fix findings and 1 suggestion, all accepted (#477 to #480); no new regression, nothing warranting a rollback | recorded ([below](#external-review)) |

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
- Typing performance after #456 is covered by two comparisons, and this gate
  did not take a separate re-measure (coordinator decision). #456's own typing
  comparison against its base (round 1) showed no difference beyond run-to-run
  noise. #466's comparison against `645df99` gives short p50 5.3 to 5.5 ms and
  p95 14.9 to 15.6 ms, and long p50 7.3 to 7.7 ms and p95 20.2 to 15.8 ms.
  These are within the run-to-run spread, with no long tasks. #453 does not
  touch the typing path.
- Suite 67 (`67-render-perf.txt`) passed in both full runs above (43/43 plain,
  44/44 frozen), but that is a pass/fail check, not the p50 and p95
  comparison.

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
| Reviewer | Codex (GPT-6-Astra, reasoning effort High): an independent AI review session that took no part in building or reviewing milestone 3, and a different model from the Opus reviewers of its PRs |
| Kind | A different model, the first of the kinds section 8 allows |
| Snapshot | `645df99`, a read-only copy with this gate record supplied as an untracked file. The reviewer read source, tests, docs and history; it did not install dependencies or run tests, and says so. Files were left unchanged |
| Date | 2026-10-08 |
| Verdict | Keep the refactor. "A successful partial migration, not yet a single-owner editor." Three should-fix findings and one suggestion; no new milestone 3 regression; nothing warranting a rollback. The text commands' undo and anchor behaviour was covered (E2, E3 and E9 below) |
| Vetting | Fable, 2026-10-08, for the coordinator: every claim checked against the base at `2b3aa86` (#466, #467, #472 and #474 merged after the snapshot); F2's re-entrant path reproduced in jsdom. The verdicts below, issues #477 to #480 and this record are the disposition under section 6 of review.md |

The review's architecture opinion matches the milestone's own record: environment-independent core, explicit command ports, bounded rollback, transactional anchor reconciliation and owned caches are real, and its qualifications (`migrateRows` migrates in place, `ValidatedDocument` proves passage through migration, `DocumentView` is a compile-time type, the bridge is a module-evaluation singleton with permissive defaults, undo replay and the legacy writers mutate outside the transaction, and #391, #459 and #460 stand) are the ones [session.md](session.md) sections 1, 3 and 8 already state. Its risk ranking puts render and browser events first, undo second, save and recovery third, which is the order the findings and milestone 4 follow.

### Findings

| ID | Severity | Finding | Verified | Verdict |
| --- | --- | --- | --- | --- |
| F1 | should-fix | A delayed media paste or drop (`insertIntoScriptCell`, `21-events.js`) keeps only the row id, the field and the old element; when the files finish reading it resolves the target in whatever document is live, and reads the selection then, not when the paste began | Confirmed on `2b3aa86`. Inherited: the same continuation exists at the milestone 3 start; `handleImageFile` (`06-rows.js`) has the same shape | Accept: #478, fixed in milestone 4 under operation identity ([plan §5, milestone 4](../IMPLEMENTATION-PLAN.md#4--centralize-save-completion-session-transitions-and-recovery)) |
| F2 | should-fix | A render's own focus changes fire `focusout` on editable cells, and `focusout` commits the cell's DOM through the typing command: `restoreRenderFocus` focuses the grid cell under a focused Writer paragraph, and `paintRow` and `renderWriter` remove focused cells. `syncFieldFromDom`'s guard knows disconnection, `undoApplying` and a stale screen, not a render in progress | Confirmed, in edit mode (#466 refuses it only in review mode). In jsdom one `render()` with a Writer paragraph focused made two edit transactions, the first writing the paragraph's old text over the incoming change, and left focus on the page body. Chromium also fires `focusout` on a removed focused node (verified by the #466 review), which makes the overwrite persistent in the grid and in the Writer's first paragraph. Plausible loss of a collaborator's change, saved back under this editor's name | Accept, as a bug fix now, not a milestone item: #477. #463 (milestone 4) keeps the invariant, which [plan §6](../IMPLEMENTATION-PLAN.md#6-required-ownershiprace-invariants) now states |
| F3 | should-fix | The dirty effect calls `recordMyColor`, which writes `personColors` (`12-dirty-toast.js`, `13a-presence.js`): persisted, merged document data that no command declares, written after the transaction, outside the rollback, unseen by `runConfined` | Confirmed. Harmless today, since nothing reads declared fields; one visible effect is that the first edit after setting a colour undoes the colour with it | Accept: #479, in milestone 4 with the dirty and save effect rework |
| F4 | suggestion | `runConfined` compares the document before and after the whole command, so a `plan` that writes a declared field and returns an empty `apply` passes, and the rollback point is taken after `plan` | Confirmed; no production command does it | Accept, tests only: #480. session.md's sentence is narrowed in this PR |

### Acceptance criteria

| The review's point | Verdict |
| --- | --- |
| E2 and E3: "one history entry" and "every failure stage" need qualification. `UndoPort.record` delegates to 12a's deferred diff, so one call is not by itself one entry, and a throw in undo recording, an effect or publication happens after the mutation, outside the rollback | Accept-doc. E2's evidence is the fake-port tests plus the booted tests that count 12a's entries (session.md §7), which the as-built row names. The post-commit failure becomes a distinct, reported outcome in milestone 4 (plan §5) |
| E4: assignment-based recovery published as `adopt` is a compatibility decision, not full separation | Already recorded (session.md §2 and §8). No change |
| E5: the plan's "no migrated view imports `S`" was narrowed to the commands and session modules; the participating views still import it | Accept-doc. Milestone 3 migrated no view: its target layout keeps 05r, 01, `syncFieldFromDom`, 06, 19 and 05c as legacy views calling commands, and the full form is milestone 6's gate. The as-built row in milestone-3.md now says so |
| E8: the literal "no document-wide work per keystroke" is not shown. 12a's `flushEdits` runs `diffStates(base, S.state)` over every row after each edit, and suite 67 counts renders and derivations, not that scan | Accept-doc. INV-06 and the E8 row now name the retained scan with its measured cost: 0.58 ms median and 1.32 ms p95 per edit on the 30-scene demo in jsdom (`flushEdits`, diff and base update, on `2b3aa86`); the browser typing p50 of 4 to 7 ms in the [performance record](performance-record.md) includes it. The scan goes with milestone 6's undo transaction |
| The review policy should keep its exception for inherited defects a PR depends on or exposes; "preserve behaviour during extraction" must not certify a boundary more strongly than its integration permits | Agreed; review.md §6 already says the first, and this record practises the second. No change |

What the gates still miss, in the review's words, is coverage composition: incoming updates while an editable cell owns focus, focus events generated by rendering, delayed media reads followed by document replacement, commands run with the real effects and non-default preferences, failures in post-commit effects, and production disposal. Each has an owner: #477 and #471 (the harness's focus emulation), #478, #479, the milestone 4 outcome above, and milestone 4's lifecycle test.

### Advice for milestones 4 to 7

| Advice | Verdict |
| --- | --- |
| M4, first: pull the explicit session construction, readiness and disposal forward from milestone 7, so the new save owner cannot run with the bridge's permissive and no-op defaults | Partly accept. Milestone 4's lifecycle test already requires the session's own dispose. The plan now says the owners milestone 4 adds are constructed by explicit functions that take their ports, never as module-evaluation singletons with defaults; the wiring step itself stays in milestone 7 as Adam approved. Pulling the whole step forward reorders the approved scope and is left for Adam (below) |
| M4, second: epoch ownership for delayed clipboard work, thumbnails, recovery and other document-scoped callbacks, not only saves | Accept: plan §5 milestone 4 names them (#478) |
| M4, third: remove document mutation from effects; capture the read models before asynchronous work | Accept (#479). The capture half is the existing capture contract |
| M4, fourth: destination-specific queues, acknowledgements and recovery ownership | Already milestone 4 as written |
| M4, fifth: render failure isolation and browser coverage. For #463, define the invariant before the mechanism; a detached render plan does not stop synchronous focus events during the commit; use a guarded commit, explicit focus restoration and a recoverable presentation failure; do not rebuild every editable node | Accept: the invariant is in plan §6 and on #463, #477 is today's bug, #471 is the harness |
| M4: pull #325's transaction ownership of render-time repairs forward where capture depends on it | Defer to milestone 6 as planned. The b-roll repair runs in the scheduler's refresh before any capture, and the capture contract snapshots the derived read models, so capture does not depend on moving it |
| M5: captured exporters before the registry; independence from live mutation, options, image availability and connection changes during awaits; independent readers; a measured cycle exit | Already the approved order and gate wording. No change |
| M6: selection and capability foundations first. #464's selection defines the epoch, scene and field, direction and affinity, atoms, mapping through edits, split and join, undo and incoming changes, and the vanished scene; focus is separate from selection; composition gets a lifetime tied to its cell and session | Accept-doc: the points are on #464, and plan §5 milestone 6 puts the selection model and the undo/redo transaction before the panel and CSS moves. That is an order inside the approved scope, not a change to it |
| M6: undo/redo through the boundary early; fix or disposition #391, #450, #451, #459 and #460 before claiming editor ownership complete | #460 is fixed (#467), #450 is fixed (#466), #391 is in PR #469, #451 is open for milestone 6, #459 is a recorded limit. The order is in the plan |
| M6: separate reviewer annotation from unrestricted text editing | Defer to milestone 6's comments migration. #466 already refuses every non-anchor change without edit capability; a distinct annotate command replaces that exception when comments migrate (plan §5 milestone 6) |
| M7: keep the narrowed scope; prove partial startup and cleanup; remove bridges with their last consumer; keep the inventory of remaining legacy | Already the approved scope. No change |

## Blockers for Adam

None from the runs: every run section 8 requires on this machine passed on the
exact merged tree, and the ARM64 and Linux checks are moved to the 4.0 release
gate by decision. The external review is recorded above and its findings have
their disposition (#477 to #480 and this record), so milestone 3 closes with
this PR.

One question from the review's advice, not applied: whether milestone 7's
explicit wiring step (constructing the session, the bridge, the commands and
the registries from `src/bootstrap/`) should move into milestone 4, before the
save coordinator is built. The plan keeps the approved order, with the
construction rule above as the compromise, until Adam says otherwise.
