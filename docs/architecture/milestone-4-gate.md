# Milestone 4 gate record

The recorded runs that [section 8 of review.md](review.md#8-milestone-gates)
require before milestone 4 closes, on the merged milestone 4 tree. The
milestone is described in [milestone-4.md](milestone-4.md), whose
[gate section](milestone-4.md#the-gate) lists the runs.

Final milestone 4 tree: `2cc8bf2`, the merge of #571 (4.22, the close-out) into
`4.0-development` on 2026-10-14. All 23 steps (4.0 to 4.22) are merged, and
the four fixes from the external review (#572) are in it. Every run below ran
on `2cc8bf2` itself.

## Summary

| Gate requirement | Result | Status |
| --- | --- | --- |
| Full Windows browser run, plain | 10378/10378 checks across 194 suites | passed |
| Full Windows browser run, caches frozen (`SPLITPAGE_FREEZE_CACHES=1`) | not run | **not run** |
| Electron smoke, dev target, every group | the groups below, each run alone, all passed | passed for the groups listed; the one-command `--only-target dev` run over every group was not made |
| Windows x64 packaged check (stage, build, `verify-dist.mjs --arch x64`, packaged-x64 smoke) | not run | **not run** |
| External review | Astra (Codex CLI), 2026-10-14: 6 bugs reported, 4 fixed in #572, 2 deferred; 4 modularity suggestions accepted and scheduled | recorded ([below](#external-review)) |
| Every matrix case `rightToday` | 110 cases, none `wrongToday` | passed |
| Lifecycle test (E9) and capture-contract tests (E8) | `m4-lifecycle.test.mjs` and `export-capture-app.test.mjs` pass in the matrix gate run and `npm run verify` of #571 | passed |
| Recovery tests (E7), browser and desktop | browser suites in the Windows run; desktop `draft:` and `session restore` groups below | passed |
| #320 case rerun on the closing tree, in `performance-record.md` | Linux rerun recorded by #571; Windows rerun below | passed |
| Existing five repaired defects stay fixed (D16) | their suites are in the Windows run (249, 261, 22, and `publish-in-flight` in `npm run verify`) | passed |
| Linux full run and native ARM64 | moved to the 4.0 release gate | not run here |

Two requirements of the plan's gate are open: the frozen-caches browser run
and the Windows x64 packaged check. Neither was run. They are listed under
[Blockers for Adam](#blockers-for-adam).

## Code

All 23 steps merged by 2026-10-14. The race matrix has 110 cases (see
[milestone-4.md, As built](milestone-4.md#as-built)), every one declared
`rightToday` and none a known bug. Run with `SPLITPAGE_M4_GATE=1`, which fails
any case still `wrongToday`. The matrix is in eight test files under
`src/test/` (the six case files, the harness `_m4-matrix.mjs` and its own
test). The count is as of #571 plus the external-review fixes in #572.

## Full Windows browser run (caches not frozen)

| | |
| --- | --- |
| Commit | `2cc8bf2c0a45cce8478c5fe0c190a6174fd538bc` |
| Date | 2026-10-14 |
| Machine | Windows 11 Pro 10.0.26300, x64 |
| Tools | Node v22.23.2, Electron 44.4.5 (x64, installed by hand because `desktop/.npmrc` pins ARM64) |
| Command | `.claude/skills/run-splitpage-app/run-tests.ps1` over every suite, with 5 browser lanes because of memory pressure from other applications |
| Result | 194 suites, 10378/10378 checks, all pass |
| Reruns | none |

The suites that were flaky or hot during the milestone passed: 77 (51/51), 92
(102/102), 257 (147/147) and 186, autosave (97/97). Suite 186 passed on its
first run; it had failed about one run in three earlier with a test-tool error
opening the starting file, and no rerun was needed here.

The frozen-caches run (milestone-4.md D1 and the gate list ask for both) was
not made.

## Electron smoke (dev target)

Each group ran alone, from `desktop/`, on the dev target, on `2cc8bf2`:

| Group | Result |
| --- | --- |
| per-tab connections | 78/78 |
| `draft:` server document | 20/20 |
| google drive | 53/53 |
| open/save | 15/15 |
| save-in-place | 6/6 |
| duplicate document id | 23/23 |
| `history:` | 157/157 |
| `draft:` | 204/204 |
| session restore | 31/31 |
| open/boot/security | 16/16 |
| teleprompter: open in browser | 34/34 |

There is no group named "import/open"; open/save covers the import and open
paths. These are the groups the milestone deferred to the gate, plus two more
that ran with them. The single `--only-target dev` command over every group
(milestone 3 recorded 809 checks that way) was not run, so there is no total
for the desktop smoke.

## Windows x64 packaged check

Not run. The stage, build, `verify-dist.mjs --arch x64` and packaged-x64 smoke
steps in [milestone-3-gate.md](milestone-3-gate.md#windows-x64-packaged-check)
have no counterpart for milestone 4.

## #320 performance rerun

The image-heavy case of `perf-record.mjs --only images`, Windows, median of
three runs, in ms:

| Case | `d18adde` | `c4d5944` | `2cc8bf2` |
| --- | --- | --- | --- |
| open, 10 pictures | 308.0 | 403.0 | 279.9 |
| load from IndexedDB, 10 pictures | 105.8 | 106.1 | 104.1 |
| merge, 10 + 10 pictures | 321.9 | 392.6 | 291.1 |

The closing tree against `d18adde`: open -9.1%, load -1.6%, merge -9.6%, all
inside E14's 10% line. The `d18adde` open runs spread by 14%, so the open
percentage is approximate: it shows "not slower", not a gain. The Linux rerun
in #571 recorded open -1.4%, merge -4.4% and load +2.6%
([performance-record.md](performance-record.md)).

## External review

[review.md section 8](review.md#8-milestone-gates) requires the review to state
what kind it was.

| | |
| --- | --- |
| Reviewer | Astra, a model in the Codex CLI on the maintainer's machine, as for milestone 3: an independent session that took no part in building or reviewing milestone 4, and a different model from the Opus reviewers of its PRs |
| Kind | A different model |
| Scope | Code review of `f66789a..` the merged tree (reviewed at `511dce0`, which has 4.13 and 4.18), read-only. Code review only; it did not run tests |
| Date | 2026-10-14 |
| Verdict | 6 bugs (4 high, 1 medium, 1 low); 4 fixed in #572 with 4 new matrix cases; 2 deferred. The "partly done" calls on 4.9 to 4.16 and 4.18 were accepted, and the fixes close most of them |
| Vetting | Every finding was checked against the code before the verdict |

The raw review and the triage are kept with the project's files
(`astra-review.md`, `astra-triage.md`); this table is the disposition.

| Finding | Disposition |
| --- | --- |
| A1: Save As re-targets Save mid-write; a parallel queue for the same file lets an older write land last | Fixed in #572 (case F5-saveas) |
| A2: queued saves run against whatever document is open when they reach the front | Fixed in #572 (F5-replaced) |
| A4: a file-draft merge adopts over a document opened during the backup wait | Fixed in #572 (K1b) |
| A6: a Save As that mints a new doc id warns "finished after you reopened it" | Fixed in #572 (F9-warn) |
| A3: server resume only checks the connection, so a document opened during the resume fetch can be replaced | Real, **deferred**. The safe fix changes the boot and draft-restore callers; it becomes a matrix-case follow-up |
| A5: reviewer comment writes do not carry the job's ownership | **Deferred** with review mode (label `review-mode-later`) |

Modularity suggestions, all agreed and none built:

1. One owner for save completion (writers return results, the coordinator alone updates baseline, dirty state and history). **M5**, the next consumer of the save path.
2. One shared boundary for async adoption (open, resume, recovery, backup waits), which also takes `applyMerge`'s `S.state` assignment toward the target of two. With the A3 follow-up, or early M5.
3. Extract the recovery workflow from `20g-drafts.js` into a constructed owner with ports. M5 or M7, wherever drafts are next touched.
4. Finish the collaboration extraction, with reviewer writes sharing operation ownership. With the review-mode rebuild.

Two of Astra's plan notes were judged not defects and are recorded in the
as-built docs: history restore calling `queueAutoSave`, and a late hosted save
advancing the restored destination's revision, both deliberate and pinned by
tests. The four `S.state` assigners (target two) are recorded in
[milestone-4.md, E4](milestone-4.md#where-the-exit-criteria-stand).

## Blockers for Adam

- **Frozen-caches browser run.** Not run on `2cc8bf2`. Milestone 3 ran both.
- **Windows x64 packaged check.** Not run.
- **One-command dev smoke total.** Optional: the groups above all passed, but
  the single run over every group was not made.
- **A3, the server-resume takeover race.** Open as a follow-up, not a gate
  blocker (milestone-4.md's bug rule).

Milestone 4 should not be called closed until the first two are run or Adam
decides to move them, as he did for ARM64 and Linux.
