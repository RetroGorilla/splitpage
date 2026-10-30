# Agent work queue

A list of self-contained cleanup, test and doc tasks that agents can work through without direction from a person. Point an agent at this file and it should be able to start. Everything an agent needs is below: the rules (what it may merge and what it must stop on), how to claim a task so parallel agents do not collide, the tasks, and what to do when none are left.

This file is process, not product. Delete it when the queue stays empty.

## Start here (agent)

1. Read `AGENTS.md`, then this file down to the task list.
2. Run `git fetch origin 4.1-development` and read the **latest** version of this file from there.
2a. Before claiming a task, handle queue additions (next section): if an open PR titled `AQ-add: ...` exists, review and merge it first.
3. List PRs (`gh pr list --state all --limit 100`, or the GitHub API) and read the state of every PR whose title starts with `AQ-n`: an **open** PR means the task is claimed; a **merged** PR means it is done; a **closed report-only** PR (AQ-6, AQ-14) means it is done; any other **closed, unmerged** PR means the task is free again.
4. Pick the lowest-numbered task that is unticked (`[ ]`) and unclaimed, whose "Needs" line is satisfied, and that is not marked `STOPS FOR ADAM` unless nothing else is left. Claim it (next section). Do one task per chat.
5. Work it under the Autonomous run rules. Repeat from step 2 until the queue is empty.

## Queue additions (`AQ-add:`)

People and coordinating agents add tasks to this file. Such a PR is titled `AQ-add: <what>` and is handled by the queue agents themselves, without a person's merge, when **all** of these hold:

- it changes only `docs/AGENT-QUEUE.md`, and only inside the `## AQ-n` task sections (adding a new task with the next free id and a `[ ]` heading, or editing the text of an unclaimed task) or the one-line status notes in the "Task list" section;
- it does not change any other section: "Start here", "Claim protocol", "Report-only tasks", "When the queue is empty", "Autonomous run rules", "Common rules", the protected-path list, or this section;
- it edits only a task that is still `[ ]` and has no open or merged PR claiming it (a task in progress or done is never edited by an addition); it changes a heading to `[x]` or `[!]` only when that task's own PR has merged or stopped;
- it does not remove or weaken a `STOPS FOR ADAM` marker, a `Needs:` line or a report-only label, and no task text grants itself an exemption from any rule, from the protected-path list or from review (a task that does is protected);
- the PR comes from a branch in this repository, opened by a collaborator of the repository (not a fork);
- a new task has: an id, a one-line title, a "Needs" line, the files it touches, a `text` fenced brief, a Structure line, and it does not ask for a change to a protected path (a task may name a protected path only if it says `STOPS FOR ADAM`).

Handling: an agent that finds such a PR before claiming a task reviews it with a separate agent against the list above, posts one review comment, and merges it under the Autonomous run rules (green CI on the exact head, `--match-head-commit`). Later additions need no person's merge.

An `AQ-add:` PR that edits anything outside those limits, or any PR that edits the rules, the protected-path list or the claim protocol, is **protected**: review it, then stop and leave it for Adam.

## Claim protocol

- A task is claimed by opening a **draft PR whose title starts with its id**, for example `AQ-8: Add unit tests for untested application modules`. Open it as soon as you have a branch with one commit; an empty claim is fine. Do this **before** doing the work.
- Before claiming, re-check open PRs one more time. Whenever two open PRs claim the same id, the lower PR number keeps it; the other closes its PR and picks a different task.
- Branch name: `queue/aq-<n>-<short-name>`.
- A claim with no push for 24 hours is abandoned: another agent may claim the task, naming the old PR in its description and closing it.
- When the task is done, **in the same PR** change its heading from `[ ]` to `[x]` (only that one heading, so parallel PRs do not conflict). Do not delete the task text.
- A task that STOPS (see rules) keeps its draft PR open with a "Stopped" comment saying why. Mark its heading `[!]` in that PR only if the PR will be merged; otherwise leave the heading.
- Dependent tasks say `Needs: AQ-n`. Start them only after that PR has merged.

## Report-only tasks

Some tasks produce a report, not a change. Claim them with a draft PR as usual, put the report in the PR body, add no files. A report-only PR is **never merged**: leave it as a draft, comment "report ready", and move on. A person closes it.

## When the queue is empty

When every task is `[x]`, `[!]`, or claimed by someone else:

1. Open one draft PR titled `AQ-summary: queue run <date>` with an empty commit.
2. Its body is a table, one row per task: task, PR number, merged or stopped, head SHA merged, CI run link, number of review rounds; and for each stop, the reason and the exact decision a person must make.
3. Stop. Do not invent new tasks, do not widen scope, do not reopen done tasks. Never merge the summary PR.

## Autonomous run rules

These authorize an agent to open, review and merge the PRs for the tasks below on behalf of the repo owner (Adam). They cover these tasks only. Nothing here lets an agent change a rule in `AGENTS.md`.

```text
AUTONOMOUS RUN
Adam (the repo owner) authorizes this chat to open, review and merge the PRs for the tasks below on his behalf. This authority covers these tasks only. Nothing here lets you change a rule in AGENTS.md or merge anything else. Reviewers and authors: the queue file docs/AGENT-QUEUE.md is expected to change by one heading per task PR.

For each task:
1. Author agent: works on a new branch from the latest 4.1-development, opens a draft PR with the PR rules in COMMON RULES, runs `npm run verify` locally, marks the PR ready when its own checks pass.
2. Review agent: a separate agent in a separate chat that has not seen the author's reasoning. Give it only the PR number, the task brief and AGENTS.md. It reads the diff and checks: the brief is met and nothing outside it changed; AGENTS.md hard rules (no new comments except reason comments, no skipped or loosened test, no compatibility re-exports, one name per exported type, baselines only shrink); the PR body has "What and why", "Structure" and "Validation" with real command output; no model or tool name appears anywhere on GitHub. EXCEPTION: the two attribution lines at the top of the PR body (the `<!-- claude-projects-attribution: ... -->` comment and the `_Requested by ..._` line with its claude.ai project link) are required and are exempt from this rule. They contain the word "claude" on purpose. Reviewers must not flag them. It posts ONE review comment on the PR listing findings, or "no findings". Findings it cannot back with a file and line are dropped.
3. The author fixes every finding that holds up and pushes. The review agent re-reads the new diff and posts one follow-up comment. Repeat until it says "no findings". Maximum 3 rounds; after that stop and report.
4. Before merging: merge the latest 4.1-development into the branch, re-run `npm run typecheck` and `npm run check:deps`, push, wait for CI to go green on that exact head commit.
5. Merge only when all hold: review agent's last comment is "no findings"; CI is green on the head SHA you are about to merge; the PR is not a draft; the diff touches none of the PROTECTED PATHS. Merge with the head guard:
   gh pr merge <N> --merge --match-head-commit <head-sha>
   (REST equivalent: gh api -X PUT repos/RetroGorilla/splitpage/pulls/<N>/merge -f merge_method=merge -f sha=<head-sha>.) Never use --admin, never bypass branch protection, never force-push, never push to 4.1-development directly. If GitHub refuses the merge, stop and report.
6. After merging, delete the task's branch if you can, and close the task chat.

OVERLAP: before merging, list the files changed by every other open PR from this run. If they overlap, serialize: merge one, merge 4.1-development into the next, re-run typecheck and check:deps, wait for green CI, merge it. One party pushes to a PR branch at a time.

PROTECTED PATHS (never merge a PR that touches these; stop, leave the PR open and report to Adam instead):
- anything for save, close, quit, recovery or drafts: src/application/save/, src/application/session/, src/application/recovery/, src/adapters/files/, src/adapters/storage/, src/adapters/desktop/
- desktop/ (main process, preload, IPC) and shared/ IPC contracts
- undo, editing and typing hot path: src/application/editing/, src/features/editing/, src/features/rows/render.js, the whole of src/core/document/ (edit operations, migration, document format)
- merging and the project file format: src/core/merge/, src/features/merge/, src/adapters/formats/project-file*, src/adapters/formats/splitpage-file*
- startup: src/bootstrap/main.* and src/bootstrap/wiring/startup*
- .github/workflows/, release.yml, package.json dependencies, eslint.config.mjs, tools/dep-report.mjs, tools/comment-gate.mjs, AGENTS.md
- docs/AGENT-QUEUE.md itself, except what "Queue additions" allows (task sections and status notes) and the one-heading tick in your own task PR
If a task's own brief needs to touch one of these, that is a STOP.

STOP and report (a short note in the PR) when:
- CI is red after two fix attempts, or the failure is in code the task did not touch.
- A suite fails that is on the known flaky list (186-autosave-panel-edits, the migrate-rows unit test, 247, 266, 173, 30, 134, desktop smoke #496): rerun once; if it fails again, stop.
- The review agent still has findings after 3 rounds.
- A test would have to be skipped, disabled or loosened to pass; or a baseline entry would have to be added.
- The change would alter behaviour a user can see.

SUMMARY: see "When the queue is empty".
```

## Common rules

```text
COMMON RULES
- Repo RetroGorilla/splitpage. Read AGENTS.md first and follow it. Rule 11: convert JS to TS only before a substantial change to that file.
- Base and target branch: 4.1-development. New branch from the latest 4.1-development. Open a draft PR first; mark it ready when the author's checks pass.
- PR title: plain description of the change. No model or tool names anywhere on GitHub (title, body, commits, comments, branch names). EXCEPTION: the two attribution lines at the top of the PR body (the `<!-- claude-projects-attribution: ... -->` comment and the `_Requested by ..._` line with its claude.ai project link) are required and are exempt from this rule. They contain the word "claude" on purpose. Reviewers must not flag them.
- PR body starts with exactly these two lines:
<!-- claude-projects-attribution: {"github_login":"RetroGorilla"} -->
_Requested by **Adam** · [project thread](https://claude.ai/code/project/chan_01CgxiZCCWZoqSjdnadPapUk?thread=cmsg_01CgxiZCCWZoqSjdnadPapUkJXVb7uN7sYwMTvb28KirvQ)_
- Assign the PR to RetroGorilla.
- PR body sections: "What and why", "Structure" (which responsibility moves where and which dependency it removes; or "no structural change"), "Validation" (commands run and results).
- No behaviour change to the product. Nothing outside the files the brief names changes.
- Never skip, disable, loosen or delete a test. Assertions are not weakened to get green.
- tools/dep-baseline.json and tools/comment-baseline.json only shrink. No new exceptions, no --accept.
- No new code comments except the form AGENTS.md rule 1 allows.
- Every doc that names something you change is updated in the same PR.
- Node 24.22.0. Run `npm run verify` before marking the PR ready.
- Stay in scope. The one exception: change your own task heading in docs/AGENT-QUEUE.md from `[ ]` to `[x]`. Name other problems in the PR body; do not fix them.
```

## Task list

Tasks marked **STOPS FOR ADAM** are written and reviewed like any other, then left unmerged because they touch a protected path. Parallel notes are in each task's "Needs" line and in this order:

- No task needs another except AQ-9 (needs AQ-8) and AQ-1 to AQ-4 (none).
- AQ-7 and AQ-8 both add files under `tests/application/`: merge one, merge the base into the other, wait for green CI, merge.
- AQ-2 and AQ-3 touch different folders. AQ-4 and AQ-12 edit different docs.
- AQ-5 is **STOPS FOR ADAM**.
- AQ-6 and AQ-14 are report-only.

## AQ-1 [ ] Fix the flaky tests 186-autosave-panel-edits and migrate-rows

```text
Task: two tests are on the flaky list: the browser suite 186-autosave-panel-edits (spec in .claude/skills/run-splitpage-app/tests/) and the unit test src/test/migrate-rows.test.mjs. Find the cause of each and fix the test, not by retrying.

1. Find the suite and the test (testing.md says how browser suites run; the unit test runs with the other src/test files). Write their current names in the PR.
2. For each, run it at least 30 times in a loop, alone and then at 3 parallel lanes, and record the failure rate and the failing assertion.
3. Fix the root cause in the test: wait on the condition (an event, a DOM state, a promise) instead of a fixed delay; remove order or timing dependence; isolate shared storage between runs. Do not add retries, longer fixed sleeps, or looser assertions. Do not weaken or skip any assertion.
4. If the cause is a product race (the app, not the test, is wrong), stop on that suite and describe it in the PR; do not fix src/.
5. Re-run each fixed suite 30 times alone and at 3 lanes; all must pass.

Files touched: the three suite files and any test helper they share. Keep it to one PR per suite if the fixes are unrelated.

Validation section: before/after failure counts per suite for both run modes.
```

## AQ-2 [ ] Mutation configs for the formats helpers

```text
Task: tools/mutants/ has configs for core areas (core-document, core-merge, core-production, core-text, core-migrate, core-merge-states). The pure helpers in src/adapters/formats/ have none. Add them and close the gaps they show. Tests and config only.

1. Read two existing configs and the runner (grep package.json and tools/ for "mutants"); copy their shape. Note PR #932 changed how the runner passes its file list; use the current runner as is.
2. Add tools/mutants/formats-text.json covering src/adapters/formats/csv.ts, markdown-table.ts, html-runs.ts and export-projections.ts with the tests that exercise them. Not pdf.ts, docx.ts, xlsx.ts or zip.ts.
3. Run it. For every surviving mutant add or strengthen a test under tests/adapters/formats/ that kills it. A mutant with no observable behaviour change is "equivalent": list it in the PR with one line of reason. Do not add an ignore list entry unless the existing configs already use one.
4. Do not change src/. A surviving mutant that shows a real bug: stop on that file and describe it in the PR.

Structure section: "no structural change"; mutants generated / killed / equivalent per file, before and after.
```

## AQ-3 [x] Unused exports in src/features

```text
Task: same job as the earlier cleanup of src/core and src/adapters/formats (PR #936), now for src/features/. Remove exports nothing uses.

1. For each export in src/features/ (all .ts and .js), grep the whole repo (src/, tests/, tools/, desktop/, shared/, build.mjs, docs/) by whole word. Unused anywhere: delete the code. Used only inside its own file: drop the `export` keyword. Dynamic use (import(), string-built names, namespace imports iterated) counts as use: leave and list.
2. Skip src/features/rows/render.js, src/features/editing/ and src/features/rows/routes.ts (protected or hot path). List any candidates you skipped there.
3. A test that exists only for a deleted function is deleted with it; name it. No other test is deleted or changed.
4. start<Name>, mount<Name>, and anything imported from src/bootstrap/ is used. The composition root imports each mount from its own wiring module; check bootstrap before judging.
5. Run npm run check:deps, node tools/code-map.mjs, lint, typecheck. Prune dep-baseline entries that resolved.

Structure section: table of symbol, file, action, grep result (as in #936); lines removed; protected files skipped.
```

## AQ-4 [x] Fix drift in four design docs

```text
Task: docs/architecture/feature-ports.md, docs/architecture/actions.md, docs/architecture/session.md and docs/DOCUMENT-MODEL.md describe code that has moved since they were written. Fix statements that are false today. Docs only.

1. For each file, take every concrete claim (a file or function name, an order, a count, a rule) and check it against 4.1-development. Do not rewrite for style. Do not add new sections.
2. Fix wrong names and paths; fix wrong counts and orders; delete a sentence only if the thing it describes is gone. If a claim is unclear, leave it and list it in the PR.
3. Do not edit AGENTS.md, README.md, saving.md, testing.md, dependencies.md, review.md, ci.md, invariants.md or HANDOFF.md.
4. Run npm run verify.

Structure section: "no structural change"; table of file, old statement, new statement, how you checked.
```

## AQ-5 [ ] --accept can no longer grow a baseline (R2 leftover)

```text
Task: AGENTS.md rule 8 says baselines only shrink, but `--accept` in tools/dep-report.mjs (and the matching flag in tools/comment-gate.mjs, if it has one) can still write new entries. Make the tools refuse.

1. Read how --accept and --prune work in both tools and their tests. Write the current behaviour in the PR.
2. Make --accept fail with a one-line message ("baselines only shrink; fix the violation") if it would add an entry that is not already in the file. Keep --prune. If --accept has no other legitimate use, remove the flag and every mention of it (grep docs/, AGENTS.md, CONTRIBUTING.md, .github/, package.json).
3. Update tools/test-dep-report.mjs and tools/test-comment-gate.mjs: a case where --accept would add an entry now fails; a case where nothing is added still passes. This is a deliberate rule enforcement Adam asked for; say so in the PR.
4. No change to what the checks report on the current tree.

THIS PR IS ON THE PROTECTED PATH LIST. Open it, run the review loop, get CI green, and then STOP: do not merge. Post "ready for Adam" in the PR and in the summary.

Structure section: "no structural change"; before/after behaviour with one example run of each.
```

## AQ-6 [ ] Audit: install slots that do nothing before setup (report only)

```text
Task: some owners in src/application/ hold an "install slot" (an empty `let x: T | null = null` filled later by wiring). While empty, most throw; three are known to do nothing instead: desktop menu-commands (`runMenuCommand` returns false), settings-actions (`openSettings` does nothing), startup-signal (`startupReady` returns null). Find out whether that matters. Report only: change no code.

1. Find every install slot in src/application/ (grep `| null = null`). For each: what it does while empty (throws / returns a default / does nothing).
2. For the do-nothing ones: list every caller and say whether any caller can run before wiring has filled the slot (read src/bootstrap/main.ts mount order and src/bootstrap/wiring/). Quote file and line.
3. Give a recommendation per slot: leave as is (with the reason), or make it throw (and list what would need to change). Do not recommend anything that changes visible behaviour without saying so.
4. Write the report to the PR body of your claim PR (a report-only PR; see "Report-only tasks"). Keep it under 60 lines.
```

## AQ-7 [ ] Export check runs each module in a child process (R2 leftover)

```text
Task: tests/application/owners-construct-nothing.test.ts has a runtime check over the exports of every src/application/ module. Read PRs #920 and #925 and the test itself to see what that check does today. The known gap: it loads every module in one process, so a module that runs code at import time can leave state behind that hides or causes a problem in another module. Today the test writes one script and runs it once in a single child process with `execFileSync(process.execPath, [file])` (around line 178), which loads every module in that one process. Change it to one child process per module, or per small batch of modules, running the same script shape, and assert the same things per module.

1. Keep every assertion the test makes today. Do not narrow the module scan. Print the module count before and after in the PR: it must not drop.
2. Keep the run time reasonable: spawn in parallel with a small pool (4), and report the test's time before and after. If it is more than 3x slower, batch modules (for example 10 per process) and say so.
3. If a module now fails when loaded alone, do not exclude it: stop and describe the failure in the PR (this is a real finding for Adam).

Files touched: that test file and a helper beside it if needed.

Structure section: "no structural change"; modules covered before/after; run time before/after.
```

## AQ-8 [ ] Unit tests for src/application modules that have none

```text
Task: list the modules in src/application/ (not types/ports-only files) that no test imports, and add tests for them. Tests only.

1. grep tests/application/ and src/application/**/*.test.ts for each module. Put the tested/untested table in the PR.
2. For each untested module that holds logic, add a test file next to the existing ones in tests/application/ (mirror the folder). Test the real behaviour with the existing fakes (see tests/application/session-fakes.ts, raw-inputs.ts). No mocking of the module under test.
3. Do not change src/. If a module cannot be tested without changing src/, list it. If a test exposes a bug, leave that test out and describe the bug (input, expected, actual) in the PR.
4. Do not touch existing tests.

Structure section: "no structural change"; the tested/untested table before and after.
```

## AQ-9 [ ] Mutation configs for pure src/application modules (after AQ-8 merges)

```text
Task: tools/mutants/ has configs for src/core areas. Add one for the pure, logic-only modules in src/application/ (for example src/application/commands/scenes.ts, rows.ts, cell-text.ts, split-join.ts, scene-length.ts, scene-status.ts, and src/application/save/autosave.ts and status.ts, plus shortcuts.ts if it is pure: choose modules with no I/O and no timers; src/application/save/ is read-only here, add tests and config only). Tests and config only.

1. Read two existing configs and the runner; copy their shape. Use the runner as it is after #932.
2. Add tools/mutants/application-pure.json. List the chosen modules and the tests that cover them in the PR.
3. Run it. For each surviving mutant add or strengthen a test in tests/application/ that kills it, or list it as equivalent with a one-line reason. No ignore-list entries unless existing configs use them.
4. Do not change src/. A surviving mutant that exposes a real bug: describe it in the PR, leave it unfixed.

Structure section: "no structural change"; mutants generated / killed / equivalent per module.
```

## AQ-10 [ ] Unit tests for pure logic in src/features without a test

```text
Task: find modules under src/features/ (not mount.ts, not ports.ts) that contain pure logic (string, array or DOM-free computation) and have no test, and add tests. Tests only.

1. grep tests/features/ and src/features/**/*.test.ts for each module. Put the tested/untested table in the PR.
2. Skip src/features/rows/render.js, src/features/editing/ and anything that needs a full app (those are browser-suite territory).
3. Add tests under tests/features/<feature>/ using the existing DOM setup and fakes (tests/features/fakes.ts). Test real behaviour, no mocks of the unit under test.
4. Do not change src/. If a test exposes a bug, leave that test out and describe it in the PR.
5. If the AQ-3 PR is still open, skip any module it touches.

Structure section: "no structural change"; the tested/untested table before and after.
```

## AQ-11 [x] Delete unreferenced files

```text
Task: find files in the repo that nothing references and delete them.

1. Candidates: images, fonts, fixtures, sample documents, scripts under tools/ and .github/, and top-level files. For each, grep the whole repo by file name AND by path AND by the build's asset globs (build.mjs, package.json "files", electron-builder config, tools/css-inputs.json, service worker list sw.js). Reference from docs/ counts as a reference only if the doc says the file is used today.
2. Delete a file only when no code, config, build step or test refers to it. Do not delete: anything under node_modules, tools/modularize.mjs, tools/mutants/, release assets, icons the desktop packaging uses, LICENSE-type files, .claude/ skills.
3. Do not delete a file in a PROTECTED PATH. List such candidates in the PR instead.
4. After deleting: node build.mjs, then npm run verify and npm run test:desktop must pass; git diff --exit-code -- sw.js must show no change unless a deleted file was cached there (then regenerate and say so).

Structure section: table of each deleted file, size, and the grep that showed no reference; files kept and why.
```

## AQ-12 [ ] Fix drift in HANDOFF.md and invariants.md

```text
Task: docs/HANDOFF.md and docs/architecture/invariants.md name files, functions, tests and counts that may have changed. Fix statements that are false today. Docs only.

1. For each concrete claim (a file or function name, a test name, an order, a count, an invariant's enforcing test) check it against 4.1-development.
2. Fix names, paths, counts. For an invariant, the invariant itself does not change: only the pointer to where it is enforced. If a named test no longer exists, find the test that now holds it; if none, list it in the PR and leave the sentence.
3. Do not add sections, do not restyle. Do not edit the four docs from the drift task (feature-ports.md, actions.md, session.md, DOCUMENT-MODEL.md), saving.md, testing.md, dependencies.md, review.md or AGENTS.md.
4. Run npm run verify.

Structure section: "no structural change"; table of file, old statement, new statement, how you checked.
```

## AQ-13 [ ] Replace fixed sleeps in browser suites with condition waits

```text
Task: browser suites that wait a fixed time (a literal `setTimeout`/`sleep`/`waitForTimeout` with a number) are slow and flaky. Replace them with waits on the thing they wait for. Tests only. Maximum 10 suites in this PR (pick the ones with the most fixed sleeps).

1. Find the suites (see testing.md for where they live) and count fixed sleeps per suite. Put the counts in the PR. Skip suite 186-autosave-panel-edits and the migrate-rows unit test (AQ-1 owns them).
2. For each sleep, find what it waits for (a DOM state, an event, a promise, a stored value) and wait on that with the suite's existing wait helper (add one small shared helper only if none exists). Keep a fixed delay only where the thing waited for is time itself (a debounce or a timeout that is under test); say so.
3. Never loosen an assertion. Never raise a timeout to get green.
4. Run each changed suite 10 times alone with `node tools/run-suites.mjs <out-dir> '<regex>'`; all 10 must pass. Report suite time before and after.
5. If a suite fails and the cause is a product race, revert that suite's change and describe the race in the PR.

Structure section: "no structural change"; table of suite, sleeps before/after, run time before/after.
```

## AQ-14 [ ] Report: JS files that rule 11 will force to TypeScript next (report only)

```text
Task: AGENTS.md rule 11 says a JS file under src/features/, src/application/ or src/adapters/ is converted to TypeScript before any substantial change. Produce a short report so Adam can see what that will cost. Report only: change no code.

1. List every .js file under those three folders with: lines, number of module-level `let`/`var`, number of exports, number of tests that import it, number of commits touching it in the last 90 days (git log), and whether it is on the typing, undo or save path.
2. Rank by (commits in 90 days) x lines. Show the top 15.
3. For the top 5, give an estimate of conversion size (small / medium / large) with a one-line reason, and name the biggest obstacle (for example many untyped DOM lookups, module-level state).
4. Write it to the PR body of your claim PR (a report-only PR; see "Report-only tasks"). Under 80 lines.
```

