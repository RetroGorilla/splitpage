# Agent work queue

A list of self-contained cleanup, test and doc tasks that agents can work through without direction from a person. Point an agent at this file and it should be able to start. Everything an agent needs is below: the rules (what it may merge and what it must stop on), how to claim a task so parallel agents do not collide, the tasks, and what to do when none are left.

This file is process, not product. Delete it when the queue stays empty.

## Start here (agent)

1. Read `AGENTS.md`, then [ROADMAP.md](ROADMAP.md) for where the work is going (this file still decides what you pick), then this file down to the task list.
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
- undo, editing and typing hot path: src/application/editing/, src/features/editing/, src/features/rows/render.*, the whole of src/core/document/ (edit operations, migration, document format)
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
- AQ-15 to AQ-23 are the PDF, CI, startup and test-hook tasks. Only AQ-18 can be merged by queue agents. AQ-15 to AQ-17 and AQ-19 to AQ-23 are **STOPS FOR ADAM** (AQ-16 needs AQ-15). AQ-15, AQ-16 and AQ-19 all edit `pdf.ts` or its imports: merge in the order AQ-15, AQ-19, AQ-16 and base-merge each time.
- AQ-25 needs AQ-24 and AQ-27 needs AQ-26 (prompter and rundown conversions to TypeScript, then their state into objects); the prompter pair and the rundown pair are independent. AQ-26 and AQ-27 need the PC perf-ab and stop if a limit is exceeded.
- AQ-28 to AQ-31 are wave 1 of [ROADMAP.md](ROADMAP.md) (known bugs and flaky tests). AQ-28, AQ-29 and AQ-31 are **STOPS FOR ADAM** and need an independent review. AQ-30 changes one suite file and can be merged by queue agents. AQ-29 needs AQ-28 (both touch saving; I-20 runs before I-6, as in ROADMAP.md).
- AQ-32 switches import save-back off and marks it deprecated; the code stays (Adam, 2026-10-30). It is **STOPS FOR ADAM** and runs on Opus with an independent review. It supersedes AQ-29: AQ-29's PR is not merged. Do not run it alongside B1's lifecycle PR or B2 (all touch saving or close).
- AQ-33 to AQ-35 are wave 2 and the first wave 3 step of [ROADMAP.md](ROADMAP.md). AQ-33 and AQ-35 are **STOPS FOR ADAM** (Opus, independent review): AQ-33 needs AQ-32 merged; AQ-35 needs AQ-32 and the first PR of AQ-23 merged. AQ-34 needs the first PR of AQ-23 merged (both touch the build) and can be merged by queue agents unless it touches a protected path.
- AQ-36 to AQ-44 cover wave 3: B1 lifecycle (AQ-36, after AQ-35) then voice (AQ-37); B2 save completion (AQ-38, after AQ-36; Adam lifted the hold 2026-10-30); C5 housekeeping (AQ-39); C6 PDF P1 to P5 (AQ-40 to AQ-44). AQ-36 to AQ-38 and AQ-42 to AQ-44 are **STOPS FOR ADAM**; AQ-36 to AQ-38, AQ-42 and AQ-44 run on Opus with independent review and PC smoke. AQ-40 and AQ-41 are not wired and may be merged by queue agents. AQ-42 needs AQ-35; AQ-44 needs AQ-19 and Adam's PC PDF check. The four old `main` PRs in AQ-39 are for Adam's decision only.
- AQ-45 (automatic PDF layout rules, Adam 2026-10-31) needs AQ-43 merged; test-only, stops for Adam only if it would need a workflow or dependency change.

## AQ-1 [x] Fix the flaky tests 186-autosave-panel-edits and migrate-rows

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

## AQ-2 [x] Mutation configs for the formats helpers

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
2. Skip src/features/rows/render.ts, src/features/editing/ and src/features/rows/routes.ts (protected or hot path). List any candidates you skipped there.
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

## AQ-5 [x] --accept can no longer grow a baseline (R2 leftover)

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

## AQ-7 [x] Export check runs each module in a child process (R2 leftover)

```text
Task: tests/application/owners-construct-nothing.test.ts has a runtime check over the exports of every src/application/ module. Read PRs #920 and #925 and the test itself to see what that check does today. The known gap: it loads every module in one process, so a module that runs code at import time can leave state behind that hides or causes a problem in another module. Today the test writes one script and runs it once in a single child process with `execFileSync(process.execPath, [file])` (around line 178), which loads every module in that one process. Change it to one child process per module, or per small batch of modules, running the same script shape, and assert the same things per module.

1. Keep every assertion the test makes today. Do not narrow the module scan. Print the module count before and after in the PR: it must not drop.
2. Keep the run time reasonable: spawn in parallel with a small pool (4), and report the test's time before and after. If it is more than 3x slower, batch modules (for example 10 per process) and say so.
3. If a module now fails when loaded alone, do not exclude it: stop and describe the failure in the PR (this is a real finding for Adam).

Files touched: that test file and a helper beside it if needed.

Structure section: "no structural change"; modules covered before/after; run time before/after.
```

## AQ-8 [x] Unit tests for src/application modules that have none

```text
Task: list the modules in src/application/ (not types/ports-only files) that no test imports, and add tests for them. Tests only.

1. grep tests/application/ and src/application/**/*.test.ts for each module. Put the tested/untested table in the PR.
2. For each untested module that holds logic, add a test file next to the existing ones in tests/application/ (mirror the folder). Test the real behaviour with the existing fakes (see tests/application/session-fakes.ts, raw-inputs.ts). No mocking of the module under test.
3. Do not change src/. If a module cannot be tested without changing src/, list it. If a test exposes a bug, leave that test out and describe the bug (input, expected, actual) in the PR.
4. Do not touch existing tests.

Structure section: "no structural change"; the tested/untested table before and after.
```

## AQ-9 [x] Mutation configs for pure src/application modules (after AQ-8 merges)

```text
Task: tools/mutants/ has configs for src/core areas. Add one for the pure, logic-only modules in src/application/ (for example src/application/commands/scenes.ts, rows.ts, cell-text.ts, split-join.ts, scene-length.ts, scene-status.ts, and src/application/save/autosave.ts and status.ts, plus shortcuts.ts if it is pure: choose modules with no I/O and no timers; src/application/save/ is read-only here, add tests and config only). Tests and config only.

1. Read two existing configs and the runner; copy their shape. Use the runner as it is after #932.
2. Add tools/mutants/application-pure.json. List the chosen modules and the tests that cover them in the PR.
3. Run it. For each surviving mutant add or strengthen a test in tests/application/ that kills it, or list it as equivalent with a one-line reason. No ignore-list entries unless existing configs use them.
4. Do not change src/. A surviving mutant that exposes a real bug: describe it in the PR, leave it unfixed.

Structure section: "no structural change"; mutants generated / killed / equivalent per module.
```

## AQ-10 [x] Unit tests for pure logic in src/features without a test

```text
Task: find modules under src/features/ (not mount.ts, not ports.ts) that contain pure logic (string, array or DOM-free computation) and have no test, and add tests. Tests only.

1. grep tests/features/ and src/features/**/*.test.ts for each module. Put the tested/untested table in the PR.
2. Skip src/features/rows/render.ts, src/features/editing/ and anything that needs a full app (those are browser-suite territory).
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

## AQ-12 [x] Fix drift in HANDOFF.md and invariants.md

```text
Task: docs/HANDOFF.md and docs/architecture/invariants.md name files, functions, tests and counts that may have changed. Fix statements that are false today. Docs only.

1. For each concrete claim (a file or function name, a test name, an order, a count, an invariant's enforcing test) check it against 4.1-development.
2. Fix names, paths, counts. For an invariant, the invariant itself does not change: only the pointer to where it is enforced. If a named test no longer exists, find the test that now holds it; if none, list it in the PR and leave the sentence.
3. Do not add sections, do not restyle. Do not edit the four docs from the drift task (feature-ports.md, actions.md, session.md, DOCUMENT-MODEL.md), saving.md, testing.md, dependencies.md, review.md or AGENTS.md.
4. Run npm run verify.

Structure section: "no structural change"; table of file, old statement, new statement, how you checked.
```

## AQ-13 [x] Replace fixed sleeps in browser suites with condition waits

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

## AQ-15 [x] PDF text and JPEG fixes

Needs: none.
Files: src/adapters/formats/pdf.ts, its tests, PDF help text.
**STOPS FOR ADAM**: user-visible PDF change (output, a new export diagnostic and help text). Author, review, leave unmerged.


```text
Task: fix two PDF export bugs in src/adapters/formats/pdf.ts. Two commits in one PR: (1) text, (2) JPEG. Export only; nothing on the typing, undo or save path.

BUG 1 (text). Characters outside the PDF's single-byte encoding are written as "?" with no notice. Even the euro sign comes out as "?" because it is missing from WINANSI_MAP. See pdf.ts around lines 102-108 (WINANSI_MAP and the HELV_HIGH width table). Confirm with `grep -n "WINANSI_MAP\|HELV_HIGH" src/adapters/formats/pdf.ts`.

BUG 2 (JPEG). The image dictionary hard-codes /ColorSpace /DeviceRGB (around line 313) and stored JPEGs pass through unconverted (around line 433), so greyscale and CMYK JPEGs render wrong or fail. When the JPEG size cannot be read, the code falls back to a fixed 800x450 (docx.ts:123 has the same fallback; leave docx.ts alone).

DO
1. Map every Windows-1252 character in the 0x80-0x9F block: € ‚ ƒ „ … † ‡ ˆ ‰ Š ‹ Œ Ž ‘ ’ “ ” • – — ˜ ™ š › œ ž Ÿ. Add the matching entries to HELV_HIGH using the standard Helvetica widths (check each against the Adobe Helvetica AFM; do not guess). Add a test that every mapped character has a width and that text width calculation matches the bytes written.
2. Count the characters that still cannot be encoded. Report the count through the existing export diagnostics (find how docx/pdf export report problems today with `grep -rn "diagnostic" src/adapters/formats src/features | head`; reuse that path, do not invent a second one). Message shape: "N characters outside Latin can't be shown in PDF". Zero count = no message. The "?" substitution stays as it is.
3. Add one sentence to the PDF export section of the help text (find it under src/features/help or the help content source) saying that characters outside Latin may not appear in PDF.
4. JPEG: read the SOF marker's component count. 1 -> /DeviceGray, 3 -> /DeviceRGB, 4 -> /DeviceCMYK with /Decode [1 0 1 0 1 0 1 0] when the JPEG has an Adobe APP14 marker (inverted CMYK). If no SOF is found, keep today's behaviour for the colour space. When width/height cannot be read, use the decoded image size from the same canvas path the PNG branch uses instead of 800x450; if that path is not available at that point, leave the fallback and say so in the PR.
5. Tests (tests/ next to the existing pdf tests; find them with `grep -rln "pdf" tests | head`): golden-style fixtures for € , Cyrillic text and CJK text (assert "?" bytes plus the diagnostic count), and tiny hand-built JPEG byte fixtures for greyscale, RGB and CMYK (assert the /ColorSpace and /Decode entries). Do not change existing expectations.
6. Browser suites: node tools/run-suites.mjs <out> 'pdf|export'.

Do not touch other tasks' files: .github/, tools/ci-*.mjs, src/bootstrap/main.ts, src/bootstrap/startup/, build.mjs, tools/dep-report.mjs, src/adapters/storage/ (AQ-19 owns the pdf.ts import line near the top; leave line ~5 alone).

STRUCTURE SECTION MUST SAY
- Which behaviour changes (more characters encoded; a diagnostic; correct colour space) and what stays the same (unencodable characters still become "?"). Width table source. Where the diagnostic goes.
```

## AQ-16 [x] Embed a Unicode font in PDFs

Needs: AQ-15 merged.
Files: src/adapters/formats/ (new subsetter modules, pdf.ts), tests, licences file.
**STOPS FOR ADAM**: user-visible PDF change (embedded font). Author, review, leave unmerged. Also stop if the font cannot stay within +1.5 MB on index.html without changing sw.js, packaging or tools/package.mjs, and for the CJK decision.


```text
Task: PDF export should show non-Latin text (Cyrillic, Greek, accented Latin outside Windows-1252, and CJK where feasible) instead of "?". Adam approved this for 4.1. Build it on top of AQ-15: start from the AQ-15 branch (or from 4.1-development once AQ-15 is merged). AQ-15's Windows-1252 path stays as the fallback for characters the embedded font lacks, and AQ-15's diagnostic keeps counting what is still not shown.

Design target: subset a TrueType font at export time into a Type0 / CIDFontType2 font with Identity-H encoding, a CIDToGIDMap, a /W widths array and a /ToUnicode CMap, so the PDF text can be selected and searched. Only glyphs used in the document go in the file.

STEP 0 (do this first and write it in the PR body before building the rest):
- Font choice: an OFL-licensed font such as Noto Sans. Put the licence text in the repo where AGENTS.md says third-party notices go (search for an existing THIRD-PARTY or licenses file; if there is none, add `licenses/` with the OFL text and mention it in the PR).
- Size: how many bytes the font adds to (a) the built index.html, (b) the portable zip, (c) the desktop installer. The limit for this PR is +1.5 MB on index.html. If the Latin/Cyrillic/Greek font exceeds it when inlined, load it lazily from a separate file next to index.html (and make sw.js cache it and the desktop package include it), and say how. CJK: a CJK font is many megabytes. Do NOT bundle one. Report the options and sizes in the PR (lazy-loaded file, user-supplied font, leave CJK as a warning) and stop for Adam's decision on CJK; ship Latin/Cyrillic/Greek first.
- If the lazy-loading route needs a change to the service worker, the desktop packaging or tools/package.mjs, stop and say so before editing them: that is a bigger change than this task.

DO
1. TTF parser and subsetter in src/adapters/formats/ as new TypeScript modules (cmap format 4/12, glyf, loca, hmtx, head, hhea, maxp; composite glyph references included). No new npm runtime dependency unless AGENTS.md allows one; say in the PR if you wanted one.
2. pdf.ts uses the embedded font for runs that contain any character the font covers beyond Windows-1252, per text run or per character, whichever keeps widths and line wrapping correct. Text that is entirely Windows-1252 keeps using the built-in Helvetica path, so existing PDFs do not change byte for byte (assert this with an existing golden test).
3. Line breaking and width measurement use the font's real advance widths for those characters.
4. Tests: subsetter unit tests on a tiny test font committed under tests/ (or generated in the test), golden test for a Cyrillic line and a Greek line (assert Type0 font object, ToUnicode, widths), a regression test that Latin-only output is unchanged, and a test that a character missing from the font still falls back to "?" plus the diagnostic. Open the produced PDF in the Playwright Chromium PDF viewer or with a PDF parser available in the repo's tools to confirm it parses; say what you ran.
5. Browser suites: node tools/run-suites.mjs <out> 'pdf|export'.

Do not touch other tasks' files: .github/, tools/ci-*.mjs, src/bootstrap/main.ts, src/bootstrap/startup/, tools/dep-report.mjs. The import line in pdf.ts that AQ-19 changes: if AQ-19 has merged, use its version.

STRUCTURE SECTION MUST SAY
- Font, licence, size added to each artefact, how the font is loaded, what stays on the old path, what is still shown as "?" and the CJK decision needed from Adam.
```

## AQ-17 [x] Tighten RestoreAnswer

Needs: none.
Files: src/features/merge/banner.ts and callers.
**STOPS FOR ADAM**: src/features/merge/ is a protected path. Author it, review it, leave it unmerged.


```text
Task: src/features/merge/banner.ts declares `export type RestoreAnswer = "ok" | "busy" | "missing" | "corrupt" | "changed" | "no-backup" | string;`. The `| string` makes the listed values catch no typos. Remove it and fix what the compiler then reports. No behaviour change.

DO
1. Remove `| string`. Run npm run typecheck. Fix each reported caller by making the value it returns one of the listed members, by widening the union with a member that caller really returns (add it to the list and say so in the PR), or by narrowing at the boundary with the existing runtime check. Do not add casts to `string`, `any` or `as RestoreAnswer`; if one is unavoidable, list it in the PR with the reason.
2. Find the producers and consumers: `grep -rn "RestoreAnswer\|RestoreRequest" src tests`. The port that answers restore requests is built in src/bootstrap/ or src/application/session/; check what strings it can return today and make the type say exactly that.
3. Tests: tests/features/merge/banner.test.ts changes only if types force it (type annotations, not assertions). Add one type-level test or a typed fixture if the repo has a pattern for it; skip otherwise.
4. Browser suites: node tools/run-suites.mjs <out> 'merge|banner|restore|undo'.

Do not touch: pdf, CI, startup, build files.

STRUCTURE SECTION MUST SAY
- "Types only." The final member list, any member added and why, any cast left and why.
```

## AQ-18 [x] Measure full render() on stamp and hide

Needs: none.
Files: tools/perf-record.mjs, docs/architecture/testing.md.


```text
Task: measurement first. The review said the full render() runs on stamp and hide; nobody has timed it. Add scenarios to tools/perf-record.mjs (and tools/perf-ab if that is the A/B entry point; read docs/architecture/testing.md and docs/architecture/performance-record.md for how perf runs are recorded) on the long demo script, and record the numbers. Fix only if a scenario is over budget.

DO
1. Add three scenarios on the long script: stamp a row, hide a row (and unhide), and change a display preference that re-renders rows. Reuse the harness's existing scene/typing/undo scenario code for setup and timing; do not invent a second timing method.
2. Run them on the current 4.1-development, at least 5 runs each, and report median and worst. Budget: 65 ms (the new-scene limit) for each scenario. Also report the existing typing (8 ms limit), new scene (65 ms) and undo (45 ms short / 70 ms long) numbers from the same run so the machine's speed is visible.
3. Put the results table in the PR body (Validation section), in the style of docs/architecture/performance-record.md. The PR contains only the harness change, plus a docs note in docs/architecture/testing.md naming the new scenarios.
4. If every scenario is under budget: the PR is done; say so. If one is over: do NOT fix it in this PR. State which scenario, the numbers, and where the time goes (use a profile; name the function). A fix is a separate Opus task with perf-ab.
5. Existing perf scenarios and their results must not change.

Do not touch: src/ (unless the harness needs a stable hook that already exists), CI, pdf, startup, build files.

STRUCTURE SECTION MUST SAY
- The new scenarios, how setup is shared with the existing ones, the measured median/worst per scenario against the 65 ms budget, and a clear verdict: fine, or over budget with the cause.
```

## AQ-19 [x] Drop the storage re-exports

Needs: AQ-15 merged.
Files: src/adapters/storage/02d-gallery.js, 02c-blobs.js, importers, tools/dep-report.mjs.
**STOPS FOR ADAM**: src/adapters/storage/ and tools/dep-report.mjs are protected. The contracts-layer half already landed in #916; only the storage re-exports remain (check first).


```text
Task: two small structural clean-ups in one PR (two commits). Start after AQ-15 is merged (AQ-15 edits pdf.ts). The contracts-layer half already landed (#916): check first and do only the storage re-exports. No behaviour change.

3.2 STORAGE RE-EXPORTS. The storage adapter re-exports functions that belong to core: src/adapters/storage/02d-gallery.js (around lines 27-50) and src/adapters/storage/02c-blobs.js (around line 13). Because of that, src/adapters/formats/pdf.ts (around line 5) reaches core code through storage, which AGENTS.md rule 4 forbids. Point every consumer directly at its real home under src/core/document/, delete the re-export blocks, and update every importer.
- Find the names: read the re-export blocks; for each name find its defining file under src/core/ and every importer: `grep -rn "02d-gallery\|02c-blobs" src tests tools docs`.
- Importers include pdf.ts, docx.ts and export-text.ts under src/adapters/formats/; there may be others (features, tests, wiring). Update all of them, including tests (import paths only).
- If an importer is a feature, it must get the function through its named port, not by importing core directly if the layer rules forbid that; check docs/architecture/dependencies.md#layers and follow it. Say in the PR what you did for each importer.
- Do not move or rename any function. Do not leave a re-export behind.

3.3 `contracts` LAYER. tools/dep-report.mjs (around line 16) lists a `contracts` layer, but there is no src/contracts directory. Remove the layer from dep-report.mjs and from any test that mentions it (`grep -rn "contracts" tools tests docs/architecture AGENTS.md`). Leave AGENTS.md and README text alone: the docs scrub is a separate task. The dep-report output for the existing code must not change except for the removed empty layer; show before/after of `node tools/dep-report.mjs`.

DO
1. Both changes, then `node tools/dep-report.mjs --prune` and `node tools/code-map.mjs`.
2. Existing tests pass with import paths changed only.
3. Browser suites: node tools/run-suites.mjs <out> 'export|pdf|docx|gallery|blob|media'.

Do not touch other tasks' files: .github/, src/bootstrap/main.ts, src/bootstrap/startup/, build.mjs, and any PDF behaviour in pdf.ts beyond the import line.

STRUCTURE SECTION MUST SAY
- Each removed re-export and where each importer now imports from, the removed layer, dep-baseline count before/after.
```

## AQ-20 [x] Release needs a green CI run

Needs: none.
Files: .github/workflows/release.yml, tools/release-ci-check.mjs (new), docs/architecture/ci.md.
**STOPS FOR ADAM**: workflow file.


```text
Task: .github/workflows/release.yml builds and drafts a release for any pushed v* tag with no check that CI passed on that commit. Make the release refuse a commit without a passed CI run, and pin the actions to commit SHAs. Workflow and tooling only; no app code.

FILES TO READ
- .github/workflows/release.yml (jobs: build, draft).
- .github/workflows/ci.yml (the `gate` job writes an artifact `ci-passed-tree-<tree>` when a tree passes) and tools/ci-tested-tree.mjs (how the passed-tree lookup works, including docs-only changes that skip the test jobs).
- docs/architecture/ci.md.

DO
1. Add a first job `verify-ci` that the `build` job needs. For a tag push it must succeed only if the tagged commit has a successful run of the CI workflow's `gate` job (checks API: `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`, conclusion success for the check named `gate`), or the commit's tree has a `ci-passed-tree-<tree>` artifact (reuse tools/ci-tested-tree.mjs rather than reimplementing the tree lookup). Fail with an `::error::` message that says which commit and what was missing.
2. Put the logic in a script under tools/ (for example tools/release-ci-check.mjs) with unit tests under the same test runner the other tools use (`npm run test:all` must pick them up). Tests cover: gate success, gate failure, no run found, tree artifact found, API error (fail closed).
3. workflow_dispatch runs: run the same check against the dispatched commit but only warn (`::warning::`) on failure, since a dispatch is a dry run that drafts nothing (the `draft` job only runs for tags). State this in the PR.
4. Workflow permissions: add `actions: read` and `checks: read` to the verify job only; keep the workflow default at `contents: read`.
5. Pin every `uses:` in release.yml to a full commit SHA with the version as a trailing YAML comment (`# v7`). Look up the real SHAs from the actions' repositories; do not guess. Do not touch ci.yml pins (AQ-21 edits that file).
6. Run `npm run check:comments` and `actionlint` if available; say if it was not.
7. Update docs/architecture/ci.md with a short "Release gate" section (take the incoming version if AQ-21 edited the file and add your section).
8. You cannot push a tag. Say in the PR how it was validated (script tests, workflow syntax) and what only the first real tag will prove.

Do not touch other tasks' files: .github/workflows/ci.yml, src/, build.mjs, tools/ci-changes.mjs.

STRUCTURE SECTION MUST SAY
- What the release job checks, what it does on dispatch, which script holds the logic, which actions were pinned and to which SHAs.
```

## AQ-21 [x] Real-app tests on PRs

Needs: none.
Files: .github/workflows/ci.yml, tools/ci-changes.mjs, docs/architecture/ci.md.
**STOPS FOR ADAM**: workflow file.


```text
Task: PRs to 4.1-development run only browser suites 01-core and 52-csp (ci.yml, "Browser suites 01 (core) and 52" step). The Electron smoke (job `desktop-smoke`) runs only on pushes to main, so 4.1-development never gets it in CI. Adam OK'd more runner time. Add the desktop smoke and a fast subset of browser suites to PR CI.

FILES TO READ
- .github/workflows/ci.yml, tools/ci-changes.mjs (how `code` and `app` are classified), tools/run-suites.mjs and the suite list it reads, desktop/test/smoke.mjs and its group filters.
- docs/architecture/ci.md and docs/architecture/testing.md, including the known-flaky suite list (247 under load, 134, 266, 173/30 at 3 lanes). Do not put a known-flaky suite in the PR subset.

DO
1. Browser subset: add a step (or a second job) to PR CI that runs a tagged subset covering save, typing, undo and export. Pick the suites by name from the real suite list; list the chosen suites and the reason for each in the PR. Run them with `--lanes 2 --port-base "$PORT_BASE"` like the existing step, on the same self-hosted runner expression the `checks` job uses.
2. Time budget: measure the added time on the runners (run the workflow on your PR at least twice) and report the numbers. Target: the browser subset adds no more than 6 minutes to the `checks` job. If it needs more, trim the subset, not the timeout.
3. Desktop smoke: run `desktop-smoke` on pull_request and on pushes to 4.1-development and main, when tools/ci-changes.mjs says the change touches app or desktop code (add a `desktop` output if `app` is too broad; add tests for any classifier change in the existing ci-changes tests). Keep it on `ubuntu-latest` with Xvfb as it is now (the self-hosted Unraid runners should not need sudo/apt). Keep the 90-minute timeout; report the real duration.
4. The `gate` job must require the new jobs when they ran, and must not write the `ci-passed-tree` marker unless they passed. Skipped-because-not-needed stays acceptable the same way the existing jobs are.
5. A PR carrying the existing `ci-github` label keeps using GitHub-hosted runners for all jobs.
6. Update docs/architecture/ci.md (what runs when, expected times). If AQ-20 edited the file too, take the incoming version and re-add your lines.
7. Never skip or relax a test to make the new jobs green. If a suite in the subset is flaky, remove it from the subset and say so; do not add retries to the suite.

Do not touch other tasks' files: .github/workflows/release.yml, src/, tools/release-ci-check.mjs.

STRUCTURE SECTION MUST SAY
- Which suites run on PRs and why, what the smoke covers and when it runs, the measured added minutes, how the gate treats the new jobs.
```

## AQ-22 [x] Visible startup failure screen

Needs: none.
Files: src/bootstrap/main.ts, src/bootstrap/startup/failure-screen.ts (new), tests/bootstrap/.
**STOPS FOR ADAM**: startup path; needs the full Windows Electron smoke.


```text
Task: if the app fails to start, the user gets a blank page. src/bootstrap/main.ts wraps only the `wireLegacyApp(...)` call in try/catch and only calls `console.error`; any later `mount*` call that throws is uncaught, and the page stays empty. Show a plain "Splitpage couldn't start" panel instead. Success-path behaviour does not change.

FILES TO READ
- src/bootstrap/main.ts (the wiring call, then about 45 mount calls in a fixed order, then startAppWhenReady), src/bootstrap/startup/page-entry.ts, src/bootstrap/app.ts.
- tests/bootstrap/composition-root.test.ts (pins the mount order; it must pass unchanged), tests/bootstrap/ for how startup is tested.
- desktop/ smoke test (what it expects on screen at startup).

DO
1. New module src/bootstrap/startup/failure-screen.ts exporting one function that renders the panel into document.body. It has no imports from features, legacy or wiring. Style it with inline styles so it works when the app CSS never loaded. Content: the title "Splitpage couldn't start", one sentence saying the document data on disk is not touched, the error name and message in a code block, a "Copy details" button (error text + stack + app version if readable without importing anything heavy), and a "Reload" button.
2. In main.ts, run the whole boot sequence (wiring, every mount, startAppWhenReady) inside one try/catch so a throw anywhere shows the panel. Keep every call and its order exactly as it is. Also handle a rejected promise if startAppWhenReady returns one (check its return type first). Keep `console.error(error)`.
3. Hide or remove any half-built app UI shell elements only if they would overlap the panel; use the least invasive way and describe it in the PR.
4. Do not attempt a recovery UI. If a plain way exists to keep export or draft recovery reachable without new code paths, describe it in the PR as a follow-up idea; do not build it.
5. Tests: (a) a bootstrap test that makes wiring throw and checks the panel text, the buttons and that no further mount runs; (b) one that makes a late mount throw; (c) the success path leaves no panel. composition-root.test.ts passes unchanged. Use the same test harness style as the other tests/bootstrap tests.
6. Full Windows Electron smoke: node desktop/test/smoke.mjs --only-target dev, pass count in the PR.
7. Browser suites: node tools/run-suites.mjs <out> '01-core|startup|boot'.

Do not touch other tasks' files: .github/, src/adapters/formats/, src/adapters/storage/, build.mjs, tools/dep-report.mjs.

STRUCTURE SECTION MUST SAY
- Where the panel lives, that main.ts call order is unchanged, which failures are now caught, what the user sees, smoke count.
```

## AQ-23 [ ] Test hooks only in test builds

Needs: AQ-21 and AQ-22 merged.
Files: build.mjs, tools/, wiring files, CI.
**STOPS FOR ADAM**: touches history storage and CI; requires Opus review.


```text
Task: about 13 `window.__*Test` objects ship in the production app. The worst is `__historyTest` (src/bootstrap/wiring/history.ts around line 18), which can wipe the history database (adapters/storage history-backends.js around lines 458-466). Add a build flag so release builds leave out the test hooks and storage fault injection; the browser suites and the desktop smoke build the test variant. Do not weaken any test. Run after AQ-21 and AQ-22 have merged. An Opus review is required before merge because this touches history storage.

FILES TO READ
- build.mjs (how index.html is built, and how sw.js is stamped), tools/package.mjs, desktop/ packaging (dist:win and verify-dist), tools/run-suites.mjs, .github/workflows/ci.yml (which jobs build and which use the built page), desktop/test/smoke.mjs.
- `grep -rn "window\.__[A-Za-z]*Test\|__[A-Za-z]*Test\b" src desktop tools tests | head -80` for the full list; also search for storage fault-injection switches (`grep -rniE "inject|failNext|faultOnce" src/adapters | head`).

DO
1. STEP 0 in the PR body: the full list of hooks and fault-injection points found, which suites/smoke use each, and the plan for each. Do __historyTest first.
2. A build-time flag (for example `SPLITPAGE_BUILD=test` or `node build.mjs --test`) that is false by default. Hooks are registered through one small helper in src/bootstrap/ (for example `exposeTestHook(name, value)`) that is compiled to nothing in the default build; do not scatter `if (flag)` checks. The flag must be a build-time constant so the unused code is removed from the output, not just skipped at run time.
3. The default `node build.mjs` output (the release build, used by tools/package.mjs and desktop dist:win) contains none of the hook names or fault-injection code. Add a test that builds the default variant and asserts that no `__*Test` name appears in the output, and run the same check inside verify-dist or tools/package.mjs so a release cannot ship with a hook.
4. The test variant is what tools/run-suites.mjs, the CI browser suites, the desktop smoke and the PC smoke use. Update those to build the test variant. The committed sw.js cache stamp must be identical for both variants, so the "sw.js is committed with the current VERSION stamp" CI step still passes; do not make the two variants write different sw.js files.
5. If converting all ~13 hooks makes one PR too large to review, ship it as: this PR = flag + helper + __historyTest + the release-build assertion, and list the remaining hooks in the PR as a numbered follow-up list; the same chat continues with follow-up PRs. Stop and describe the proposed split in the PR before splitting.
6. Existing suites must keep passing unchanged. Never relax an assertion. If a suite loses its hook because it ran against the release build, switch the suite to the test build.
7. Full Windows Electron smoke: node desktop/test/smoke.mjs --only-target dev, using the test variant; plus run it against the release variant to show the app starts (pass count and the group you ran).
8. Browser suites: the full set the PR CI runs, plus node tools/run-suites.mjs <out> 'history|undo|storage|recovery'.

Do not touch: eslint.config.mjs; unrelated wiring; the history storage logic itself (only how the hook is exposed).

STRUCTURE SECTION MUST SAY
- The hook list and where each now lives, the flag name and default, what the release bundle no longer contains (with the grep result), which jobs build the test variant, smoke counts for both variants.
```

## AQ-24 [x] Convert the prompter to strict TypeScript

Needs: none. Files: src/features/prompter/prompter.js -> prompter.ts, its importers (src/bootstrap/wiring/prompter.ts, src/test/*prompter*.test.mjs and the other src/test files that import it, tests/features/prompter/, tests/bootstrap/load-order/prompter.json), docs that name prompter.js.

```text
Task: improvement plan item 4.3, step 1 for the prompter (AGENTS.md rule 11). Convert src/features/prompter/prompter.js to strict TypeScript: types only, no behaviour change. Model: #955, which did the same for src/features/rows/render.js; read its diff and PR body first.

1. git mv the file to prompter.ts. Update every importer to the .ts path (git grep "prompter/prompter.js"), including src/test/*.mjs, tests/, tests/bootstrap/load-order/prompter.json and docs. Leave no file that re-exports the old path.
2. Type every function, parameter and module-level variable. Use types from ports.ts and from the owners it names; narrow with Pick. If a port type in ports.ts is missing a field the code already calls, add it there (type-only) and say so in the PR body.
3. Allowed mechanical changes, each listed in the PR body: var -> let/const (TypeScript checks the block scoping), `delete obj[key]` -> Reflect.deleteProperty (lint no-dynamic-delete), a local variable to narrow a value instead of a cast. Nothing else may change what runs or in what order.
4. Known traps: the lint config is typescript-eslint strict, so `!` non-null assertions are banned and inline eslint-disable comments are off in src/features. `npm run typecheck` (not plain tsc) also runs the brand check, which refuses any `as` cast to a type that reaches the validated document (for example `x as DocumentView`, or `null as unknown as` a function type that returns one). Declare a slot `let x: T;` with no initializer and clear it with `(x as unknown) = null`, as newtab.ts does.
5. Run `npm run verify`, then `node build.mjs` and the prompter browser suites: node tools/run-suites.mjs <out-dir> '^(04|32|49|58|71|88|142|156|309)-' --lanes 6. Put the results in Validation.

Structure section: "no responsibility moves; types only". Name every file outside prompter.ts that changed and why.
```

## AQ-25 [x] Hold the prompter's state in one object (after AQ-24 merges)

Needs: AQ-24. Files: src/features/prompter/prompter.ts only (plus docs that describe its state, if any).

```text
Task: improvement plan item 4.3, step 2 for the prompter. prompter.ts keeps about 48 module-level variables of state next to its one `ports` variable. Group the mutable state into one object built from a `freshState()` function, the way #957 did for src/features/rows/render.ts; read its diff and PR body first. No behaviour change.

1. List every module-level let/var. Constants that never change stay constants. Each mutable one becomes a field of an interface `PrompterState` and of the object freshState() returns, with the same starting value it had.
2. Wherever the old code reset a variable to its starting value (stop, dispose, close), check that the reset list equals the starting values field for field. Only then replace it with `state = freshState()`. Otherwise keep the individual resets. Keep the order relative to any DOM cleanup or callback that runs next to it.
3. Leave anything that must outlive one start (listener lists the tests pin, lifetime tokens) as its own variable, and say why in the PR body.
4. Do not change importers, exported names or what start returns. Do not make the prompter a per-instance owner; name that as a possible later step in the PR body.
5. Watch for word-boundary replacements inside strings (#957 hit "on screen" in a placeholder). Review your own diff for changed string literals.
6. Run `npm run verify`, then `node build.mjs` and the prompter suites: node tools/run-suites.mjs <out-dir> '^(04|32|49|58|71|88|142|156|309)-' --lanes 6.

Structure section: which variables moved into the state object and which stayed out, and why.
```

## AQ-26 [x] Convert the rundown to strict TypeScript

Needs: none. Files: src/features/rundown/rundown.js -> rundown.ts, its importers (src/bootstrap/wiring/rundown.ts and panels.ts, src/test/rundown.test.mjs and the other src/test files that import it, tests/features/rundown/, tests/bootstrap/load-order/rundown.json), docs that name rundown.js. Leave target.js alone.

```text
Task: improvement plan item 4.3, step 1 for the rundown (AGENTS.md rule 11). Same task as AQ-24, for src/features/rundown/rundown.js. Model: #955.

Follow AQ-24 steps 1 to 4 with rundown in place of prompter.
5. renderRundown runs after every screen paint (panels.ts, onScriptStats), so this file is near the typing path. Besides `npm run verify` and the rundown browser suites (node build.mjs, then node tools/run-suites.mjs <out-dir> '^(100|101|102|103|104|105|106|140|141)-' --lanes 6), run the performance comparison on the PC: node tools/perf-ab.mjs against 4.1-development, 15 rounds (see docs/architecture/performance-record.md). STOP if typing > 8 ms, a new scene > 65 ms, or undo > 45 ms short / 70 ms long. Put the numbers in Validation and in a PR comment.

Structure section: "no responsibility moves; types only". Name every file outside rundown.ts that changed and why.
```

## AQ-27 [x] Hold the rundown's state in one object (after AQ-26 merges)

Needs: AQ-26. Files: src/features/rundown/rundown.ts only.

```text
Task: improvement plan item 4.3, step 2 for the rundown. Same task as AQ-25, for src/features/rundown/rundown.ts (about 38 module-level variables). Model: #957.

Follow AQ-25 steps 1 to 5 with rundown in place of prompter.
6. Run `npm run verify`, the rundown suites (node build.mjs, then node tools/run-suites.mjs <out-dir> '^(100|101|102|103|104|105|106|140|141)-' --lanes 6), and the perf-ab comparison with the limits in AQ-26 step 5. STOP if any limit is exceeded.

Structure section: which variables moved into the state object and which stayed out, and why.
```

## AQ-28 [x] Save button label after a late save (tracker I-20)

Needs: none.
Files: src/application/save/ (status.ts, coordinator.ts, or whichever writes the label), src/features/title/save-status.js, their tests, a new browser suite under .claude/skills/run-splitpage-app/tests/.
**STOPS FOR ADAM**: save path, and it changes what the user sees. Independent review.

```text
Task: tracker I-20, "Late-save Save button label does not reset". When a save finishes late (after the user has edited again, or after another save started), the Save button label can stay on the old state instead of returning to what the current document state says. Fix it so the label always matches saveStatus() once the save settles. This is a bug fix: the label change is the intended behaviour change; nothing else changes.

FILES TO READ
- docs/architecture/saving.md ("The Save buttons are a projection", "One status selector"), docs/architecture/invariants.md, docs/HANDOFF.md (AGENTS.md rule 9).
- src/application/save/status.ts (saveStatus, saveButtonView), coordinator.ts, src/features/title/save-status.js, and setSaveButtons.
- git log --oneline -i --grep="late" -- src/application/save for earlier late-save fixes (#673 and the commits before it).

DO
1. STEP 0, before any fix: reproduce it. Write a failing unit test (or browser suite) that starts a save, edits or starts a second save before the first finishes, lets the first finish, and checks the label. If you cannot make it fail on the current 4.1-development, stop: post what you tried in the PR and mark the PR as "does not reproduce". Do not change product code in that case.
2. Fix at the one place the label is decided (the projection), not by adding a second writer of the label. Keep the save coordinator the owner.
3. If the file you change is .js and the fix is more than a few lines, convert it to TypeScript in a separate PR first (AGENTS.md rule 11), and stop to report.
4. `npm run verify`; browser suites: node tools/run-suites.mjs <out> 'save|autosave|title' --lanes 6.
5. Full Windows Electron smoke on the PC: node desktop/test/smoke.mjs --only-target dev, pass count in the PR.

STRUCTURE SECTION MUST SAY
- "no structural change", the root cause in one or two sentences, the failing test before the fix and passing after, smoke count.
```

## AQ-29 [ ] Save-back on desktop reads the file once (tracker I-6)

Needs: AQ-28 merged. Start from a base that includes it.
Files: src/application/save/import-saving.ts, its tests, docs/architecture/saving.md; for part B also the save coordinator's confirm step it calls (src/application/save/) and a browser suite.
**STOPS FOR ADAM**: save path, and part B changes what the user sees. Independent review; PC smoke.

```text
Task: tracker I-6. After writing an imported file back in place, saveBackToFile (src/application/save/import-saving.ts) calls `writable.close()` and then reads the file again (`ports.files.read`) to record its new lastModified and size. On the desktop, close() already answers the stamp that main took right after its atomic write (docs/architecture/saving.md, "The desktop shim", and the line "It still reads the file a second time after writing ... a one-line change left for later"). A second read can see a later change made by another program and record that as ours, which can hide a real conflict or raise a false one. Use the stamp from close() when it has one; read the file only when it does not (the browser path). That is part A.

Part B (found while working AQ-28, PR #976; Adam folded it into this task on 2026-10-30): after an import save-back succeeds, the import home reads written back (`dirty: false`, file menu "Up to date"), but the Save button and status line still show `Save •` / "Unsaved changes", because save-back never confirms the document as saved (it never reaches `confirmSavedNow`). It does not depend on timing. After a successful save-back, confirm the document as saved through the coordinator's existing confirm step, with the same guard a normal save uses (only when no edit came in after the capture, `changes() === seqAtSave`), so the Save button, the status line and the file menu agree. Nothing else changes.

FILES TO READ
- docs/architecture/saving.md (the import save-back section), invariants.md, HANDOFF.md (AGENTS.md rule 9).
- src/application/save/import-saving.ts (completion.landed and completion.landedUnread), src/adapters/desktop/desktop-handle.ts (what close() answers), the import-saving tests.

DO
1. STEP 0: confirm the current code still reads after close() on the desktop path. If it no longer does, stop and report "already fixed" with the commit that fixed it.
2. Change the order so a close() stamp with lastModified is recorded through the same completion step the read path uses; keep the read for a close() that answers nothing. Keep every stillWritingBack check in its place.
3. Tests: desktop-style handle (close() answers a stamp) records that stamp and does not read; browser-style handle (close() answers nothing) still reads; a file changed by someone else between close() and the old read: record what the next save reports before and after the change, and describe it in the PR. Do not change existing assertions.
4. Update the saving.md line that calls this "left for later".
5. Part B, STEP 0: reproduce it with a failing test (save-back succeeds, no edit after the capture, then check saveStatus() and the Save button). Read saving.md section 4, which says the unsaved flag and a destination's dirty can differ: if it says this case is intended, stop part B and describe it in the PR for Adam; part A continues on its own. Otherwise fix it at the confirm step (one writer of the saved state; do not add a second one), and add tests: save-back with no later edit reads saved; save-back with an edit after the capture still reads unsaved. Make part B its own commit.
6. `npm run verify`; browser suites: node tools/run-suites.mjs <out> 'import|save|conflict|title' --lanes 6; full Windows Electron smoke on the PC (node desktop/test/smoke.mjs --only-target dev), pass count in the PR.

STRUCTURE SECTION MUST SAY
- "no structural change", which stamp is now recorded on each platform, what part B changes for the user (or why it stopped), the test names, smoke count.
```

## AQ-30 [x] Fix the flaky suite 266-header-collab-condense (tracker I-30)

Needs: none.
Files: .claude/skills/run-splitpage-app/tests/266-header-collab-condense.txt only.

```text
Task: tracker I-30. Suite 266 fails about 40% of the time, also when run alone. Its 1310px expand check samples the Production label's width every frame and asserts `window.__mid >= 3`, where __mid counts frames with a width between 1 and 70 px. The label's full width is about 70 px, and sometimes the first sampled frame is already at 69.7 to 72.6 px, so only 0 to 2 frames count. The product is fine (the label ends fully expanded and nothing overlaps); the test's timing is wrong.

DO
1. Run the suite alone 10 times on the current base and record the pass count: node tools/run-suites.mjs <out> '^266-'.
2. Fix the measurement, not the threshold: start recording before the width change can land (for example, take the first frame's width before setting the new width, then count frames strictly between the start width and the end width), or compare against the label's measured full width instead of the fixed 70. The check must still fail if the label snaps open with no animation. Show that: temporarily disable the transition locally, run the suite, confirm it fails, and put that output in Validation. Do not commit that change.
3. Never lower `>= 3` or widen the window to make it pass. The 1290px collapse check must keep its meaning; apply the same fix there only if it has the same problem.
4. Run the suite alone 20 times after the fix; all must pass. Also run node tools/run-suites.mjs <out> 'header|collab' --lanes 6.

STRUCTURE SECTION MUST SAY
- "no structural change; test only", what the old check measured wrong, what it measures now, pass counts before (of 10) and after (of 20), and the snap-open run that fails.
```

## AQ-31 [x] Fix the flaky desktop smoke check #496 (tracker I-5)

Needs: none.
Files: desktop/test/smoke.mjs only.
**STOPS FOR ADAM**: desktop/ is protected. Independent review; runs on the PC.

```text
Task: tracker I-5. The desktop smoke check "quit asks again when a moved file's copy is late" (#496) fails now and then. Find out whether the test waits on a fixed time or on a condition that can come too early, and make it wait on the real condition. Product code does not change.

DO
1. Find the check in desktop/test/smoke.mjs (grep "copy is late"). Read what it does step by step and what it waits for. Read issue #496.
2. Run that check 20 times on the PC on the current base (node desktop/test/smoke.mjs --only-target dev with the narrowest filter the script offers) and record the pass count and each failure's output.
3. If the failure is in the test's timing: replace fixed waits with waits on the condition the check needs, with a time limit that fails loudly. Do not remove an expectation or loosen one.
4. If the failure shows a product bug (quit really does not ask again), stop: do not change product code; describe the evidence in the PR and leave it for Adam.
5. Run the check 20 times after the fix (all must pass), then the full smoke once, pass count in the PR.

STRUCTURE SECTION MUST SAY
- "no structural change; test only", the cause, what the check waits on now, pass counts before and after.
```

## AQ-32 [x] Switch off import save-back (keep the code, mark it deprecated)

Needs: none. Supersedes AQ-29 (its PR stays unmerged and is closed when this task merges).
Files: the entry points that reach `saveBackToFile` (src/application/save/import-saving.ts): the save-back action and its file menu item (src/features/file-menu/, src/bootstrap/actions.ts, src/bootstrap/wiring/local-files.ts) and the conflict retry that calls it; their tests and browser suites; the docs that describe save-back.
**STOPS FOR ADAM**: saving and the file menu are protected, and it changes what the user sees. Run on Opus; independent review; PC smoke.

```text
Task: switch import save-back off (Adam, 2026-10-30). Today, after a user imports a .docx, .csv or .txt, a separate save-back action (and the conflict retry it offers) writes the script back into that original file through saveBackToFile (src/application/save/import-saving.ts; save kinds "writeback" and "writebackForce"; the "import home"; exporters marked `writeback: true` in src/bootstrap/wiring/exporters.ts). Ordinary Save and its shortcut (saveDoc; saveKind in src/bootstrap/wiring/save-owners.ts) never pick those kinds: on a script whose home is an import they already ask for a new project destination. From now on an import starts a separate Splitpage script and Splitpage never writes to the imported file. A user who wants a .docx, .csv or .txt makes a new one with Export. The save-back code stays in the repo, unreachable from the app, and is marked deprecated in the docs; removing it is a later decision, not this task.

WHAT THE USER SEES AFTER
- Importing a file opens its content as a script that has no Splitpage file yet, like a new untitled script, with the imported file's name as the suggested name.
- Save on that script is unchanged: it works like Save on any script that has no file yet, with the existing Save choices and default format. No menu item, shortcut, command-menu entry, toast, prompt or status line offers or mentions writing back to the imported file.
- Export (including "Export again") is unchanged and always writes a file the user picks.
- The unsaved warning on close, the leave-page warning and the crash-recovery draft behave as for any unsaved script.

OLD DATA
- A stored location, recent-file entry or recovery draft that still records an import home must load without an error and without losing the document, and Save must treat it as a script with no Splitpage file unless it also has one. Never write to the old imported file. Do not delete the stored field; just stop acting on it.

DO
1. STEP 0, before any code change: list every caller of saveBackToFile and every way a user reaches one (file menu item, command-menu action, shortcut, toast or status-line button, conflict retry prompt, desktop menu), and confirm that ordinary Save, its shortcut and autosave never reach it. Put that list and the chosen switch points in the PR body. If switching it off needs a change in more than a few places, or in desktop/ or src/application/recovery/, stop and reply with the list before changing code.
2. Read docs/HANDOFF.md, docs/architecture/invariants.md and docs/architecture/saving.md first (AGENTS.md rule 9). Every invariant holds unchanged; invariants and race-matrix cases about save-back (for example milestone 4's E5 and case I2 in src/test/m4-matrix-files.test.mjs) keep testing the save-back owner directly, since the code stays.
3. Switch it off at those entry points: remove or hide the save-back action, its menu item and the conflict retry that calls it, so nothing in the app reaches saveBackToFile. Ordinary Save stays exactly as it is. Do not delete the save-back owner, its save kinds, its location/recovery fields or the desktop code; they stay unused.
4. Tests: unit tests of the save-back owner itself stay and keep passing. Tests and browser suites that drive save-back through the app are updated to assert the new behaviour (AGENTS.md rule 2: the behaviour is meant to change); list each one in the PR with old and new expectation. Never weaken an assertion about anything else. Add tests: after an import, Save asks for a new project destination with the existing choices and default (unchanged behaviour, now pinned); the imported file is never written (assert no write to its handle or path) through Save, autosave, the file menu or any action; a location or draft with an old import home loads and Save treats it as having no project file; no menu item, action or prompt offers save-back.
5. Mark it deprecated in the docs: a short "Deprecated: import save-back" note in docs/architecture/saving.md (switched off on 2026-10-30, code kept, which files hold it, removal to be decided later), matching lines in HANDOFF.md and pinned-defects.md, the Help text updated so it no longer describes saving back to an imported file, and a CHANGELOG line. No code comments beyond the reason form AGENTS.md rule 1 allows.
6. `npm run verify`; browser suites node tools/run-suites.mjs <out> 'import|save|file-menu|home|conflict|export|title' --lanes 3 (build with `node build.mjs --test` once the base has that flag); full Windows Electron smoke on the PC (node desktop/test/smoke.mjs --only-target dev), pass count in the PR.

STRUCTURE SECTION MUST SAY
- "no structural change; save-back switched off, code kept", every entry point found and how each is now unreachable, that ordinary Save is unchanged, what the user sees now, the old-data handling, every test or suite whose expectation changed, smoke count.
```

## AQ-33 [x] Rename the "server" merge kind to "disk"

Needs: AQ-32 merged (both touch src/application/session/). Start from a base that includes it.
Files: src/application/session/ (apply-merge.ts, change-set.ts, document-session.ts, document-merge.ts, ports.ts, session-merge-ports.ts, session-merge.js), src/bootstrap/wiring/ (session-owner.ts, undo.ts, ports/session-merge.ts), src/bootstrap/wiring.ts, src/features/file-menu/local-files.js, the tests and docs that name the kind (found in step 0).
**STOPS FOR ADAM**: session and undo are protected paths. Run on Opus; independent review; PC smoke.

```text
Task: roadmap B3. Collaboration was removed, so "server" no longer names anything. The word still labels how a merge of a changed document lands in the session: the transaction kind `"server"` that subscribers see, `MergeKind`, `AbsorbedKind`, and the functions named after it (`absorbServer`, `noteServerUpdate`). Rename it to "disk". Names and strings only: no behaviour, order or logic changes.

FILES TO READ
- docs/HANDOFF.md, docs/architecture/invariants.md and docs/architecture/session.md (AGENTS.md rule 9). Every invariant holds unchanged.
- Where the kind lives today: src/application/session/change-set.ts (TransactionKind), apply-merge.ts (MergeKind, mergeKind), document-session.ts (AbsorbedKind, absorb, take, absorbMerged, absorbServer), document-merge.ts (`ports.view.absorbed(o.kind || "server")`), ports.ts (UndoPort.absorbServer), session-merge-ports.ts and session-merge.js (noteServerUpdate); src/bootstrap/wiring/session-owner.ts, undo.ts, ports/session-merge.ts and wiring.ts (UNDO_ADAPTER_METHODS); the subscriber src/features/file-menu/local-files.js (`change.kind === "server"`). Start from `grep -rn '"server"\|absorbServer\|noteServerUpdate\|publish:server\|undo.server' src tests desktop tools docs`.

DO
1. STEP 0, before any change, in the PR body: sort every hit of that grep into (a) the merge kind itself (the value in change.kind, the type unions, the `absorbed(kind)` and `noteMerged`/`absorbMerged` parameters, every subscriber that compares it), (b) names built on it (absorbServer, noteServerUpdate, test log labels such as `undo.server` and `publish:server`), (c) unrelated "server" that stays. Known (c), leave each unchanged and say why: the migration source `{ kind: "server", serverId }` in src/core/migrate.ts (it derives a document id from "splitpage-server-doc", so renaming it would change ids of old documents); the stored `server` origin and source shapes used as old-data fixtures (tests/application/recovery/, desktop/test/desktop-state.test.mjs, desktop/test/smoke.mjs); the `setHome("server", ...)` unknown-kind refusal in the location tests; the `server/` layer name in tools/dep-report.mjs. Anything else in (c) is listed with its reason. If a rename needs more than identifiers and string values, stop and reply with what it needs.
2. Rename (a) to "disk" and (b) to match (absorbServer to absorbDisk, noteServerUpdate to noteDiskUpdate), in one pass; list every renamed identifier and value in the PR. No alias for the old name and no re-export (AGENTS.md rule 4). One name per exported type.
3. OLD SAVED DATA, answered in step 0 with evidence: the kind is a value that lives inside one running session (change events, merge options). Show by grep and by reading the draft, history, storage and desktop-state writers that it is never written to a draft, history record, local storage, desktop state or file. If that holds, say "no persisted copy" and show the grep; nothing needs migrating, and nothing in saved projects, drafts or recents can carry the old name. If any writer does persist it: stop and reply with that list before changing code; the fix then is one reader that accepts the old "server" and maps it to "disk", with a test that loads old-name data.
4. Tests: update the strings and identifiers in existing tests and browser suites to the new names (AGENTS.md rule 2: the name is meant to change; no assertion is weakened, removed or skipped). Add one test that a merge publishes kind "disk" to a session subscriber and that the file-menu subscriber still refreshes on it.
5. Docs: update every doc that names the kind or the functions: docs/architecture/session.md (transaction kinds, the absorbServer rows, UndoPort, the undo adapter) and the "server updates" line in docs/architecture/invariants.md. Check with `grep -rn 'absorbServer\|noteServerUpdate\|"server"' docs`.
6. `npm run verify`; browser suites: node tools/run-suites.mjs <out> 'undo|merge|session|recovery|save|import|history|file-menu' --lanes 3 (build with `node build.mjs --test` once the base has that flag); full Windows Electron smoke on the PC (node desktop/test/smoke.mjs --only-target dev), pass count in the PR. If the diff changes anything but names, also run node tools/perf-ab.mjs and stop if a limit is exceeded; otherwise say that only names changed.

Do not touch: behaviour, call order, src/core/migrate.ts, the stored-shape fixtures in (c), desktop/ beyond the tests named above.

STRUCTURE SECTION MUST SAY
- "no structural change; names only", every renamed identifier and value, every "server" left and why, how old saved data loads (no persisted copy, with the grep, or the one reader), the tests changed, smoke count.
```

## AQ-34 [x] CSS by purpose

Needs: AQ-23's first PR merged (flag, helper, `__historyTest`, release-build check; both touch the build).
Files: src/styles/, the `styles-*.css` files under src/features/, tools/css-inputs.json, the tests that pin the CSS list (src/test/css-aggregation.test.mjs, src/test/css-feature-balance.test.mjs, tools/css-colours.mjs), docs that name the files.
Not protected: none of these paths is on the protected list (no file under src/features/merge/, src/features/editing/ or src/features/rows/render.* holds a stylesheet). If the work needs a protected path, stop and say so. Split it into several PRs if one is too large to review; each PR keeps the proof below.

```text
Task: roadmap C3. The app's CSS is 59 `styles-*.css` files under src/features/ (39 are only numbered, such as src/features/file-menu/styles-3.css) plus src/styles/, concatenated in one fixed order. Merge and rename them by feature and purpose (for example `styles-badge.css` stays a name; `styles-3.css` becomes a name that says what is in it), with the computed cascade unchanged. This changes no visible pixel. The proof is the point of the task.

FILES TO READ
- build.mjs (`appCss` from tools/css-inputs.mjs fills the `/*{{APP_CSS}}*/` placeholder in src/page.html; the --check mode) and tools/css-inputs.mjs (it reads each file and joins them with a single "\n").
- tools/css-inputs.json: the 84 ordered inputs. Order is the cascade: a later rule wins on equal specificity.
- src/test/css-aggregation.test.mjs (pins the exact list and order), src/test/css-feature-balance.test.mjs, tools/css-colours.mjs, docs/architecture/dependencies.md and docs/architecture/testing.md where they name CSS files.
- tools/comment-gate.mjs: CSS comments are checked. A merged file may keep only reason comments of the `/* why: ... */` form; moving a comment must not add a baseline entry.

DO
1. STEP 0 in the PR body: the table of all 59 files with lines, what each holds, and the proposed new name and group. Mark every merge that joins files which are NOT adjacent in tools/css-inputs.json: those can change the cascade and need extra proof (step 3). Prefer groupings that keep the order, so a merge joins neighbours only.
2. Rename and merge with git mv and concatenation, so history follows. A merge of neighbours is the first file's text, a "\n", then the second file's text, exactly what the build does today, so the built CSS stays byte for byte the same. Update tools/css-inputs.json (same order), the pinned list in src/test/css-aggregation.test.mjs (the list changes because the names change; the order check stays as strict) and every doc that names a renamed file. Leave no old file behind and no re-export.
3. PROOF that the computed cascade is unchanged, in the Validation section, with the command output:
   a. Before changing anything, build on the base (`node build.mjs`) and save the CSS that goes into the page: `node -e "import('./tools/css-inputs.mjs').then(m => process.stdout.write(m.appCss()))" > <out>/css-before.css`. After the change, save css-after.css the same way. For merges of neighbours and pure renames the two files must be identical (`git diff --no-index --stat` shows nothing; also print their SHA-256). That alone proves the cascade, because the page receives the same bytes.
   b. For any merge that joins non-adjacent files, so the bytes differ: say exactly which rules moved and why the order between conflicting rules is kept (same specificity, same selector overlap), and then prove it with a computed-style comparison: with the harness, load the built page in the states the visual suites reach and dump `getComputedStyle` for every element for the properties the stylesheets set, before and after, and show they are equal. Keep that script out of the repository and put its output summary in the PR. If you cannot show equality for a move, do not make the move.
   c. The visual browser suites pass. Take the list for style changes from docs/architecture/testing.md ("What to run for which change") and run it with node tools/run-suites.mjs <out> '<regex>' --lanes 3, adding the suites of every feature whose stylesheet you touched (settings, file menu, comments, panels, prompter, gallery, tags, find, overlay, history, imports, writer), in light and dark mode as those suites do. Build with `node build.mjs --test` once the base has that flag. A suite that fails on the base too is on the flaky list: rerun once, then stop.
4. `npm run verify` (it runs the CSS tests, including the colour checks that read the built CSS), `npm run check:comments`, and `git diff --exit-code -- sw.js` (the committed cache stamp must not change; if the built file list changes it, regenerate with the build and say so).
5. Do not change a selector, a declaration, a value, a media query or a comment's meaning. No clean-up of unused rules in this task (name them in the PR for a later one).

Do not touch: src/ outside the stylesheets and the tests named above, build.mjs beyond what the file renames force (it should need nothing), .github/, tools/dep-report.mjs.

STRUCTURE SECTION MUST SAY
- "no structural change; stylesheets renamed and merged", the table of old file to new file, which merges joined neighbours and which did not, the SHA-256 of the CSS before and after (equal), the computed-style comparison for any non-adjacent merge, the suites run, and that no rule was added, removed or reordered (or exactly which moved).
```

## AQ-35 [ ] Desktop split, step 1: IPC setup out of desktop/main.js

Needs: AQ-23's first PR and AQ-32 merged. Start from a base that includes both.
Files: desktop/main.js, desktop/ipc-setup.js (new), desktop/electron-builder.yml and desktop/package.json (file and test lists), desktop/test/ipc-table.test.mjs, docs/architecture/desktop-build.md.
**STOPS FOR ADAM**: desktop/ is protected. Run on Opus; independent review; full PC Electron smoke.

```text
Task: roadmap B1, step 1. desktop/main.js is over 2,500 lines. Its IPC setup is one block: the registration wrappers `ipcHandle`, `ipcOn` and `ipcOnSync` (about line 2084, with `ipcChannelRow`, `ipcRefusalReason` and `logIpcRefusal` just above) and `registerIpc()` (about line 2143 to the call near line 2770). Move the IPC setup into its own module. One PR, no behaviour change. Process lifecycle (start, close, quit) and voice follow as later tasks; do not start them here.

FILES TO READ
- docs/architecture/desktop-build.md: why each module is listed in `files`, and the rule that every `./module` main.js requires must be added to the list (desktop/test/ipc-table.test.mjs fails if one is missing).
- desktop/main.js: the IPC block above, and what each handler uses from main.js (tabs, windows, drafts, recents, state, dialogs). The earlier extractions are the pattern: desktop/recents.js, tab-registry.js, restore-notice.js and unsaved-dialog.js each take what they need as arguments and return functions; main.js keeps the state.
- desktop/ipc-channels.js (the channel table), desktop/preload.js, desktop/tabstrip-preload.js, desktop/test/ipc-table.test.mjs (it reads main.js as text and checks that nothing registers through ipcMain directly, that every registered channel is in the table with its direction, that every inbound row is registered exactly once).
- desktop/electron-builder.yml (the `files` list) and desktop/package.json (the `test` script, which lists each desktop test), desktop/verify-dist.mjs.
- docs/HANDOFF.md and docs/architecture/invariants.md for anything the handlers touch (saving, closing).

DO
1. STEP 0 in the PR body: before any change, print the list of (channel, direction) pairs main.js registers today, in registration order, with their count by direction. Then list what the handlers use from main.js and choose the cut. The module takes those dependencies as one object argument; main.js builds it. If the dependency object would need more than about 30 members, stop and reply with a proposed split by handler group, before changing code. Handler bodies move as they are, or stay in main.js as functions passed in; this task moves the registration and the wrappers, not the logic of a handler.
2. Create desktop/ipc-setup.js (plain CommonJS like its neighbours) holding the wrappers and registerIpc. Same channels, same registration order, same origin and argument checks, same refusal results, same log lines. main.js requires it and calls it where it calls registerIpc() today. Leave no wrapper copy and no re-export in main.js (AGENTS.md rule 4).
3. Update every list that names modules: the `files` list in desktop/electron-builder.yml, desktop/package.json's test script if a test file is added, docs/architecture/desktop-build.md (a row for the new module: what it holds and what stays in main.js), and desktop/test/ipc-table.test.mjs so that it reads the new module where it read main.js. Its assertions keep their meaning (no direct ipcMain registration, every channel in the table with that direction, every inbound row exactly once); none is weakened.
4. Test: record the step 0 list of (channel, direction) pairs, in order, as a test that compares it to what the new module registers against a fake ipcMain. It must pass on the moved code and would fail on a missing, extra or reordered channel.
5. `npm run verify`; `npm run test:desktop`; `node build.mjs`; the packaged payload check: from desktop/, build a fresh package with `npm run dist:win`, then list the new package's app.asar (for example `npx @electron/asar list <path to the new app.asar>`) and show that `ipc-setup.js` is in it; put that output in the PR. If a fresh package cannot be built on this machine, stop and report; do not accept `node stage.mjs` or `node verify-dist.mjs` on existing artifacts instead, because they do not prove the new module ships. Full Windows Electron smoke on the PC: node desktop/test/smoke.mjs --only-target dev, pass count in the PR (all checks, not a group). Browser suites are not needed because no renderer code changes; say so.
6. If a handler can only move by changing what it does, leave that handler in main.js and name it in the PR.

Do not touch: renderer code, preload files, desktop/ipc-channels.js (the table stays as it is), the process lifecycle and voice code, and any other desktop module.

STRUCTURE SECTION MUST SAY
- "no behaviour change", what moved from main.js to desktop/ipc-setup.js and what the module needs from main.js (the dependency list), the line count of main.js before and after, the (channel, direction) list before and after (equal), the lists updated, smoke count. Name lifecycle and voice as the later steps.
```

## AQ-36 [ ] Desktop split, step 2: process lifecycle out of desktop/main.js

Needs: AQ-35 merged. Start from a base that includes it; do not run alongside AQ-38.
Files: desktop/main.js, new CommonJS lifecycle module(s) under desktop/, desktop/test/ (lifecycle tests and smoke.mjs if needed), desktop/electron-builder.yml, desktop/package.json, docs/architecture/desktop-build.md and docs that name the moved code.
**STOPS FOR ADAM**: desktop/, close and quit are protected. Run on Opus; independent review; full PC Electron smoke.

```text
Task: roadmap B1, step 2. Move process lifecycle (start, close, quit) out of desktop/main.js after the IPC extraction. One PR, no behaviour change. Voice is AQ-37; save completion is AQ-38.

FILES TO READ
- AGENTS.md, docs/HANDOFF.md (desktop shell), docs/architecture/invariants.md (especially drafts and close/quit), docs/architecture/desktop-build.md.
- desktop/main.js: createTabWindow's close and session-end handlers, requestCloseTab, askBeforeClosing, settleDraftsForClose, restoreSessionAtLaunch, the app startup and quit handlers, and the flags they share. Read the IPC module produced by AQ-35 for the calls it makes into lifecycle code.
- desktop/close-keep.js, quit-watchdog.js, unsaved-dialog.js, tab-registry.js, desktop-state.js, drafts.js; desktop/test/close-keep.test.mjs, quit-watchdog.test.mjs, desktop-state.test.mjs, ipc-table.test.mjs and smoke.mjs.
- desktop/electron-builder.yml, desktop/package.json, desktop/verify-dist.mjs.

DO
1. STEP 0 before moving anything: list the startup, tab close, window close, session-end and quit paths, the callbacks and flags each uses, and their current order. Include cancellation, review, a gone file whose kept copy is late, a new edit while close waits, installer quit and macOS activation. Choose the module boundary and list the dependencies main passes in as one named object; stop with a proposed smaller split if the extraction cannot preserve the order.
2. BEFORE the move, add a test that pins the close/quit order on the existing code with fake app/window events and an event log. It must cover question, kept-copy wait, recheck, draft settlement, session-write freeze and final close/quit, plus cancellation and session-end. Show it passes before the move and fails when a critical pair is deliberately reversed locally; do not commit that reversal. Run the same assertions against the extracted code. Do not rely only on source-text checks.
3. Extract the lifecycle orchestration as CommonJS like its neighbours. Preserve registration and call order, synchronous versus asynchronous boundaries, flags, question wording, draft holds/discards, persistence, cancellation and error handling. Keep state with one owner and pass functions where that avoids moving unrelated logic. No compatibility wrapper or re-export remains at the old location. Do not change the voice implementation or IPC contracts.
4. Add every new required module to desktop/electron-builder.yml and the module table in desktop-build.md; add tests to desktop/package.json's test list. Keep ipc-table.test.mjs's registration and packaged-module assertions as strict as before.
5. Run npm run verify and npm run test:desktop. Build with node build.mjs --test, then full Windows Electron smoke on the PC: node desktop/test/smoke.mjs --only-target dev (all checks, count in the PR). No renderer change means no browser suites are needed; if a renderer change becomes necessary, stop and report rather than widening this extraction. Browser suites, if required by an agreed follow-up, use node tools/run-suites.mjs <out> '<regex>' --lanes 3.
6. From desktop/, build a fresh package with npm run dist:win and list its new app.asar to prove every extracted module ships. Existing staged artifacts do not prove that; if packaging or the PC checks cannot run, stop and report.

STRUCTURE SECTION MUST SAY
- "no behaviour change", which lifecycle responsibility moved where, which dependencies main no longer owns, the dependency object, main.js line counts before/after, the pinned close/quit order before/after (equal), lists updated, fresh package evidence and full smoke count. Name any lifecycle code left behind and why.
```

## AQ-37 [ ] Desktop split, step 3: voice out of desktop/main.js

Needs: AQ-36 merged. Start from a base that includes it.
Files: desktop/main.js, new CommonJS voice composition module(s) under desktop/, desktop/test/ voice tests, desktop/electron-builder.yml, desktop/package.json, docs/architecture/desktop-build.md and docs that name the moved code.
**STOPS FOR ADAM**: desktop/ is protected. Run on Opus; independent review; full PC Electron smoke.

```text
Task: roadmap B1, step 3. Move the remaining voice composition out of desktop/main.js. desktop/voice-helper.js already owns the listener process; do not rewrite it. No behaviour change.

FILES TO READ
- docs/HANDOFF.md (desktop voice), docs/architecture/invariants.md (INV-45 to INV-47), docs/architecture/desktop-build.md, docs/WINDOWS-CHECKS.md.
- desktop/main.js: VOICE_SCRIPT, voiceCommand, VOICE_RELAY_PREFIX, voiceHelperInstance, prompterShareInstance, prompterRelaysVoice, forgetTab and the shutdown call; the IPC and lifecycle modules from AQ-35 and AQ-36 for their voice callbacks.
- desktop/voice-helper.js, desktop/voice/listen.ps1, desktop/prompter-share.js, desktop/test/voice-helper.test.mjs, voice-grace.test.mjs, fake-voice-helper.mjs, ipc-table.test.mjs and smoke.mjs.
- desktop/electron-builder.yml, desktop/package.json, desktop/stage.mjs and desktop/verify-dist.mjs.

DO
1. STEP 0: list voice creation, command selection, tab events, relay events, start/stop/status, tab cleanup and app cleanup, with every caller and dependency. Record the development and packaged script paths and the test-helper environment path before changing them.
2. Extract only this composition, taking named dependencies from main. Preserve lazy creation, tab ownership, the relay prefix and event routing, test-mode command, platform checks and stop/forget order. Keep the existing listener and PowerShell script as they are; registration stays in the AQ-35 IPC module and shutdown stays ordered by AQ-36.
3. Pin those boundaries with fake-helper tests: ordinary and relay events reach only their owner, closing a tab forgets both identities, quitting stops the helper, and neither status nor teardown accidentally starts a listener. Preserve all existing voice assertions. No re-export or second voice owner.
4. Update the package files list, test list and desktop-build.md module table, plus any doc naming the moved composition. Build a fresh desktop package with npm run dist:win and show the new module in its app.asar and the listener script in the staged resources. Stop if that cannot be proved.
5. npm run verify; npm run test:desktop; node build.mjs --test; browser suites node tools/run-suites.mjs <out> 'voice|prompter' --lanes 3; full Windows Electron smoke on the PC: node desktop/test/smoke.mjs --only-target dev, full pass count in the PR. Record Adam's real-microphone check from WINDOWS-CHECKS.md separately from the fake-helper smoke; do not claim a real voice was tested by the fake.

STRUCTURE SECTION MUST SAY
- "no behaviour change", what moved and which dependency it removes from main, the named dependencies and voice lifetime owner, main.js line counts, unchanged script paths and routing, package evidence, suite and smoke counts, and the real-microphone check status.
```

## AQ-38 [ ] One owner decides when a save is complete

Needs: AQ-36 merged. Adam lifted the B2 hold on 2026-10-30. Do not overlap lifecycle work on close or saving.
Files: src/application/save/, src/bootstrap/wiring/save-owners.ts and file-saving.ts, callers found in step 0, their tests and save race suites, docs/architecture/saving.md and docs that describe completion.
**STOPS FOR ADAM**: save, session and file paths are protected. Run on Opus; independent review; PC smoke. No behaviour change visible to users.

```text
Task: roadmap B2, the timing gap in saving.md's "Known gaps and exceptions". file-saving.ts's writeDoc calls confirmWrite through save-completion.ts while coordinator.ts's judge separately advances the destination's confirmed generation. One owner must decide when a landed save is complete. The completion owner already holds the steps; this task unifies the decision to run them. No user-visible behaviour change and no revival of deprecated import save-back.

FILES TO READ
- docs/HANDOFF.md, docs/architecture/invariants.md and all of docs/architecture/saving.md, especially the known gaps, obsolete saves, save identity, capture and import deprecation.
- src/application/save/coordinator.ts, save-completion.ts, file-saving.ts, file-saving-ports.ts, import-saving.ts, save-state.ts and destinations.ts; src/bootstrap/wiring/save-owners.ts, file-saving.ts and local-files.ts.
- tests/application/save-coordinator.test.ts, save-completion.test.ts, file-saving.test.ts, import-saving.test.ts and save-destinations.test.ts; src/test/save-coordinator-app.test.mjs, save-label-late-app.test.mjs, save-unstamped-write-app.test.mjs and m4-matrix-files.test.mjs.

DO
1. STEP 0, before design or edits: list EVERY save path and who confirms it today. Include Save, Save As/copy, force, autosave, picked browser handle, desktop handle, download fallback and the kept but unreachable import writeback kinds. Separately list open/adoption, restore/recovery and export so they cannot accidentally become saves. For each, show capture, ownership/epoch checks, landed-write evidence, baseline, confirmed generation, clean flag, destination/identity updates, history and user notice, with file/function pointers and order.
2. Propose the one completion decision and its writer result contract in the PR body. BEFORE changing the implementation, add race tests that pin the agreed existing behaviour: later edits; a queued second save; same-id reopen and replacement; Save As identity/destination changes; cancellation, refusal and failure; a landed obsolete write; disposal during a write; and history that never resolves. Assert baseline, generation, dirty state, target/id and notice as well as the outcome. Tests pass before and after. If the desired single decision would change an agreed outcome, stop for Adam to decide before implementing it.
3. Move the decision to that owner and make every reachable save path use it exactly once. Preserve synchronous capture, per-destination ordering, job.owns/stillOwns protection, seqAtSave handling, obsolete-write reporting, history timing and all close/recovery invariants. Do not equate a landed obsolete write with a current acknowledged save. Adoption and export keep their own meaning; deprecated import code stays unreachable and its direct owner tests stay.
4. Keep the application layer import-inert, use the existing named ports and owner types, and leave no compatibility re-exports or second confirmation path. If a substantial edit to a JS caller is needed, obey AGENTS.md rule 11 in a separate types-only PR first and report that prerequisite; do not fold a conversion into this PR.
5. Update saving.md's known-gap bullets to the final responsibility and timing, and every doc naming a changed API. No unrelated save fix or user-visible label change.
6. npm run verify; node build.mjs --test; browser suites node tools/run-suites.mjs <out> 'save|autosave|conflict|permission|recovery|history|import|title' --lanes 3; full Windows Electron smoke on the PC: node desktop/test/smoke.mjs --only-target dev, all-check pass count in the PR. Stop if the races or PC checks cannot be run; never relax an assertion.

STRUCTURE SECTION MUST SAY
- "no user-visible behaviour change", the step 0 path/confirmation table, which decision moved from the writers to which owner and which dependency it removes, the completion contract and exact order before/after, the race tests pinning it, the deprecated paths left unreachable, suite and full smoke counts.
```

## AQ-39 [x] Close stale tracker rows and list old main PRs for Adam

Needs: none. Check the latest merged base and tracker state before closing any row.
Files: no product files; GitHub tracker rows and the evidence table in the PR body; docs/AGENT-QUEUE.md only for this task's completion heading.

```text
Task: roadmap C5. Close tracker rows only when the merged code and its regression coverage prove the work is done, or Adam has explicitly closed the item. The old main PRs #547, #488, #489 and #382 are for Adam's decision ONLY. Never close, reopen, retarget or merge those PRs.

FILES TO READ
- docs/ROADMAP.md, docs/AGENT-QUEUE.md, docs/HANDOFF.md ("Where to pick up" identifies GitHub Issues as the tracker), docs/architecture/pinned-defects.md as evidence pointers, not as a new task list.
- The current issue/PR record, merged fix and named regression tests for every candidate. Re-check the code on origin/4.1-development, not an unmerged branch or a task's heading alone.

DO
1. STEP 0: table of candidate row, current state, resolution, merged PR/commit, regression test and proposed action. Treat undecided, unreproduced or partly fixed work as open unless Adam explicitly decided otherwise. Do not investigate or fix a new product bug here.
2. Close only rows supported by that evidence or Adam's recorded decision, leaving a concise resolution with links. Do not delete tracker history, change product code, or edit other queue tasks or rules. Re-read each row immediately before changing it so another person's update is respected.
3. In a separate decision-only table list #547, #488, #489 and #382, each one's CURRENT state, target branch, overlap with merged work and the decision Adam would need to make. Do not assume all four are still open; do not act on any of them.
4. Run npm ci, npm run check:comments and git diff --check; include git diff --name-only and the hunk headers proving the task's own heading is the only file edit. Run npm run verify before ready. No app change: browser suites, node build.mjs --test and PC smoke are not needed for this housekeeping; if later product work is proposed, give it a separate task with node tools/run-suites.mjs <out> '<regex>' --lanes 3 and its required smoke.

STRUCTURE SECTION MUST SAY
- "no structural change; tracker housekeeping only", each closed row and its evidence, each row kept open and why, and the four old main PRs listed for Adam with no action taken on them.
```

## AQ-40 [x] PDF rebuild P1: script HTML print page, not wired

Needs: none. Coordinate shared print files with AQ-41; P3 and P4 wire the output later.
Files: new TypeScript print-layout modules under src/adapters/formats/, their tests and test-only fixtures/suites, docs describing the new layout. No production export wiring changes.
Queue agents may merge this task if it stays outside protected paths and has no user-visible effect.

```text
Task: roadmap C6, P1. Build the script part of one HTML print page from a captured export. It is NOT wired into the app yet. Keep the old PDF export working unchanged. Chromium will paginate the new layout using the computer's fonts; no hand-drawn page-break algorithm and no bundled replacement font.

FILES TO READ
- docs/ROADMAP.md (C6 and its costs), docs/architecture/saving.md (capture), docs/architecture/invariants.md (exports), docs/architecture/testing.md.
- src/adapters/formats/pdf.ts (buildPdf and its script content), export-kit.ts, export-projections.ts, export-assets.ts, print-colors.ts and html-runs.ts; src/core/document/export-document.ts; src/application/export/assets.ts.
- src/bootstrap/wiring/exporters.ts (current PDF registration; read only), src/test/pdf-script.test.mjs, pdf-layout.test.mjs, comment-images-export.test.mjs and m4-matrix-exports.test.mjs.

DO
1. STEP 0: inventory what buildPdf prints today and the captured facts/assets each part uses. Propose new module names and a shared page shell usable by AQ-41. List the intentional print-layout differences from C6: Chromium page breaks, no "cont." label on continued rows, desktop-only bookmarks later, browser "Save as PDF" later.
2. Implement the script HTML and print CSS in new strict TypeScript modules. Reuse export facts, runs, scene/comment projections and captured assets; never read the live editor or stored preferences during rendering. Escape content, use safe image references and keep scripts/remote fetches out of the printable document. Preserve content and export options, including pictures, comments and non-Latin text. The list sections are AQ-41, not another PDF writer here.
3. Test the generated document with fixtures for rich text, tags, comments, images, missing assets, empty/long scripts and non-Latin text. Test a capture followed by edits: the print page still holds the captured content. Add print-media layout coverage for multipage content, wrapping and clipping using a test-only fixture; nothing is registered in the release app.
4. npm run verify; node build.mjs --test; run the new print-page suites and existing export coverage with node tools/run-suites.mjs <out> 'print|export' --lanes 3. Record printed-page inspection results. No desktop change or live wiring: PC Electron smoke is not needed here. Stop if implementation needs protected paths or production wiring.

STRUCTURE SECTION MUST SAY
- The new print modules and their captured input contract, "not wired; no user-visible change", the shared shell for P2, content coverage and deliberate C6 pagination differences, suites and print inspection results. The old generator is retained until P5.
```

## AQ-41 [x] PDF rebuild P2: list HTML print pages, not wired

Needs: AQ-40 merged for its shared print-page shell. P3 and P4 wait for both print-layout tasks.
Files: the print-layout modules introduced by AQ-40, new list print modules under src/adapters/formats/, their tests and test-only fixtures/suites, docs describing the layout. No production export wiring changes.
Queue agents may merge this task if it stays outside protected paths and has no user-visible effect.

```text
Task: roadmap C6, P2. Add packing lists and the B-roll shot list to the same HTML print-page system as P1, both standalone and as the script's list sections where applicable. NOT wired into the app. Keep the old PDF export unchanged.

FILES TO READ
- docs/ROADMAP.md (C6), docs/architecture/saving.md (capture), docs/architecture/invariants.md (exports); the AQ-40 modules, fixtures and input contract.
- src/adapters/formats/pdf.ts (buildPackingListPdf, buildShotListPdf, shotListAppendixPages and buildPdf's list sections), export-kit.ts (breakdownGroups), export-projections.ts (brollShotListForPrint), print-colors.ts.
- src/bootstrap/wiring/exporters.ts (gear/prop packing and B-roll PDF registrations, read only), src/test/list-pdfs.test.mjs, export-projections.test.mjs and m4-matrix-exports.test.mjs.

DO
1. STEP 0: table of each existing list output, its options/filters/grouping, columns, status marks, counts and captured facts. Compare standalone and script appendix content so neither is silently lost.
2. Render those lists through P1's shell and print CSS, using the existing projections. Keep gear and prop packing outputs, B-roll filter/group options, empty states, checkboxes, signatures/notes space and captured dates/content. Let Chromium break pages; no manual PDF drawing or "cont." label on continued rows. No duplicate fact calculation or bundled fonts.
3. Add content and print-media tests for standalone lists and the composed script page, empty and long lists, long labels, non-Latin text and filters/grouping. Confirm lists use the held capture after a live edit. Existing PDF tests stay unchanged because the live path still uses the old writer.
4. npm run verify; node build.mjs --test; node tools/run-suites.mjs <out> 'print|export' --lanes 3, including the new fixtures. Record multipage print inspection for both list types. No desktop or live wiring changes: no PC Electron smoke here. Stop on any need for a protected path or live export wiring.

STRUCTURE SECTION MUST SAY
- Which list responsibilities the new modules hold and which shared P1 parts they use, "not wired; no user-visible change", standalone/appendix coverage, the options and facts preserved, print inspection and suite results. The old generator stays until P5.
```

## AQ-42 [ ] PDF rebuild P3: desktop printToPDF

Needs: AQ-40 and AQ-41 merged; AQ-35 IPC extraction merged before adding desktop IPC. Take the latest base after any B1 desktop change.
Files: desktop/ print composition and IPC module from AQ-35, desktop/preload.js, desktop/ipc-channels.js, desktop/test/, desktop/electron-builder.yml and desktop/package.json if new modules/tests ship; src/adapters/desktop/, export ports/wiring and tests, docs describing desktop PDF export.
**STOPS FOR ADAM**: desktop, IPC and file delivery are protected. Run on Opus; independent review; PC Electron smoke and PC PDF inspection.

```text
Task: roadmap C6, P3. The desktop app saves P1/P2's HTML print page as a PDF with Electron's printToPDF. Wire all desktop PDF products: script, gear/prop packing lists and B-roll shot list. Browser export stays on the old path until P4; the old generator is not deleted until P5. This is the PDF output change Adam requested, not a change to project saving.

FILES TO READ
- docs/ROADMAP.md (C6), docs/HANDOFF.md, docs/architecture/invariants.md, docs/architecture/saving.md (capture and export), docs/architecture/desktop-build.md, docs/WINDOWS-CHECKS.md.
- AQ-40/AQ-41 print modules; src/bootstrap/wiring/exporters.ts; src/application/export/registry.ts; src/features/file-menu/ports.ts and local-files.js (current buildFileData/export flow); src/adapters/files/deliver.ts and src/adapters/desktop/ for the bridge pattern.
- desktop/main.js, the AQ-35 IPC module, desktop/preload.js, desktop/ipc-channels.js, desktop/test/ipc-table.test.mjs and smoke.mjs, desktop/electron-builder.yml and desktop/package.json. Verify printToPDF options against the Electron version in that package.

DO
1. STEP 0: list each PDF entry point and its captured layout/options, the desktop request/result contract, trust boundary, print-window lifetime and delivery/cancellation path. Describe how desktop bookmarks will be produced and tested. Identify any conflict with the old byte-level PDF/metadata/footer tests or invariants and obtain Adam's decision before changing those expectations.
2. Add the smallest desktop print adapter and named export port. Main owns the print window and native delivery; render the captured HTML with its assets ready before printToPDF. Keep the renderer sandbox and IPC origin/argument checks; renderer input never grants arbitrary path access. Destroy print windows and release temporary assets on success, cancel, failure and app quit. Do not change the main editor, document identity, dirty state, save confirmation or autosave.
3. Route desktop PDF exports through it, preserving export choices, diagnostics and filename suggestions. Keep non-PDF formats unchanged. Add tests for each PDF product, font/image readiness, malformed/untrusted requests, cancellation/failure, cleanup, captured content after a document switch and desktop bookmarks. If a substantial JS feature/adapter edit is needed, do its strict TypeScript conversion in a separate types-only PR first (rule 11).
4. Update IPC direction/schema tests, package/test lists and docs for every new module; no compatibility re-export. Build a fresh package with npm run dist:win and prove the print module ships in its app.asar.
5. npm run verify; npm run test:desktop; node build.mjs --test; node tools/run-suites.mjs <out> 'print|export' --lanes 3; full Windows Electron smoke on the PC: node desktop/test/smoke.mjs --only-target dev, all-check count in the PR. Adam checks actual PDFs on the PC for script and both list types, Unicode, pictures, long rows, page breaks and bookmarks. Stop if those checks cannot be completed; do not delete the old writer.

STRUCTURE SECTION MUST SAY
- Which responsibilities move from the byte generator/export wiring to the print adapter, the capture/IPC/result contract and trust checks, window/asset cleanup, exact intended C6 output differences, desktop bookmark evidence, package evidence, suite/smoke counts and Adam's PDF check status.
```

## AQ-43 [x] PDF rebuild P4: browser print dialog

Needs: AQ-40 and AQ-41 merged. Coordinate export wiring with AQ-42; if it is open on the same files, merge one and take its base before the other.
Files: browser print adapter under src/adapters/, named export ports and src/bootstrap/wiring/exporters.ts, src/features/file-menu/ only as needed for the print result, their tests/suites, Help and export docs.
**STOPS FOR ADAM**: user-visible export workflow changes; any file-delivery changes are protected. Independent review; Adam checks the browser print workflow on the PC.

```text
Task: roadmap C6, P4. In the browser, open the print dialog for the P1/P2 HTML page; users choose "Save as PDF" there. Cover script, gear/prop packing lists and B-roll shot list. Keep desktop printToPDF from P3 and every non-PDF export working. P5 removes the old generator later.

FILES TO READ
- docs/ROADMAP.md (C6's browser cost and desktop-only bookmarks), docs/architecture/saving.md (capture/export), docs/architecture/invariants.md, docs/architecture/testing.md.
- AQ-40/AQ-41 modules and AQ-42's export contract if merged; src/bootstrap/wiring/exporters.ts, src/application/export/registry.ts, src/features/file-menu/ports.ts and local-files.js, src/adapters/files/deliver.ts; src/test/export-registry-app.test.mjs, export-capture-app.test.mjs and m4-matrix-exports.test.mjs.
- .claude/skills/run-splitpage-app/tests/03-exports.txt, 41-export-polish.txt, 98-export-dialog.txt and 284-exports-from-a-fixture.txt; existing Help/export wording found by searching the PDF entries.

DO
1. STEP 0: list every browser PDF action (including Export again), the captured data/options and the old download expectations. Design a print-dialog result that does not falsely report a file saved or treat a cancelled dialog as a document save. List any invariant/test expectation needing Adam's decision before changing it.
2. Open the print document from a user action without losing the capture while fonts/assets load, then invoke its print dialog. Handle a blocked popup and failed preparation clearly; clean up windows/frames and object URLs after the print flow without closing them before the dialog is done. Use the computer's fonts, Chromium page breaks and no "cont." label; do not promise browser bookmarks or an automatic PDF download.
3. Route only browser PDF exports to this flow through named ports. No live editor/preference reads during rendering, no dirty/baseline/identity change and no alteration to project Save. Follow rule 11 with a separate types-only prerequisite if a JS module needs substantial edits.
4. Update Help/export wording to say the browser opens the print dialog and the user chooses "Save as PDF"; describe desktop bookmarks only for desktop. Tests cover all PDF actions, Export again, popup failure, delayed assets, document switch, cancellation and cleanup. Change old PDF download assertions only for this intended workflow change; preserve content assertions and all non-PDF assertions.
5. npm run verify; node build.mjs --test; node tools/run-suites.mjs <out> 'print|export' --lanes 3. Automate preparation and print invocation; Adam checks the real dialog, cancellation and Save as PDF for script and lists on the PC. If desktop export wiring changed, also run npm run test:desktop and full PC Electron smoke: node desktop/test/smoke.mjs --only-target dev, count in the PR; otherwise state why Electron smoke is not needed. Stop for Adam in either case.

STRUCTURE SECTION MUST SAY
- The browser print adapter and its named contract, the PDF-only workflow change and user wording, capture and cleanup rules, each updated download assertion and replacement coverage, suite results and Adam's real-dialog/PDF check status. The old writer is kept until P5.
```

## AQ-44 [ ] PDF rebuild P5: delete old generator, subsetter and Noto fonts

Needs: AQ-42 and AQ-43 merged; AQ-19 merged (both touch pdf.ts); Adam has checked the new desktop and browser PDFs on the PC and approved removing the old path. Start only after that check is recorded.
Files: src/adapters/formats/pdf.ts, pdf-unicode.ts, truetype.ts, pdf-fonts/noto-sans-regular.ts, pdf-fonts/noto-sans-bold.ts and pdf-fonts/noto-emoji.ts; tools/pdf-font-module.mjs, licenses/OFL-noto-sans.txt, licenses/OFL-noto-emoji.txt and licenses/README.md where no remaining use needs them; tests audited but never deleted by the agent, remaining importers/wiring and docs found in step 0.
**STOPS FOR ADAM**: final PDF replacement and deletion after the PC check; any protected importers remain protected. Run on Opus; independent review; PC regression checks.

```text
Task: roadmap C6, P5. Delete the hand-drawn PDF generator, its TrueType subsetter and the bundled Noto fonts once the print paths replace every PDF product. No new output or workflow change here: P3/P4 already made it. AQ-19 must merge first; never race its pdf.ts import cleanup.

FILES TO READ
- docs/ROADMAP.md (C6), docs/architecture/invariants.md (export facts, capture and PDF expectations), docs/architecture/saving.md, Adam's recorded PC PDF check on P3/P4.
- src/adapters/formats/pdf.ts, pdf-unicode.ts, truetype.ts, the three modules under pdf-fonts/, tools/pdf-font-module.mjs, licenses/README.md and the two Noto OFL files; src/bootstrap/wiring/exporters.ts and every reference found below.
- src/test/pdf-script.test.mjs, pdf-layout.test.mjs, pdf-text.test.mjs, pdf-jpeg.test.mjs, pdf-unicode.test.mjs, list-pdfs.test.mjs, tests/adapters/formats/truetype.test.mjs, the P1-P4 tests and src/test/m4-matrix-exports.test.mjs.

DO
1. STEP 0: grep the entire repository for every old generator export, pdf.ts/pdf-unicode.ts/truetype.ts, font module/constant and font-generation tool. Table each reference as delete, replace or still used, with its actual path. Confirm all four PDF products use print on both platforms and show Adam's PC approval. If a live path or other consumer still needs the old code/fonts, stop and describe it before deleting.
2. Delete the generator, Unicode PDF layer, subsetter and all three bundled Noto font modules. Remove font-generation tooling and licence files only if the reference audit proves they serve only the deleted assets; otherwise keep them with a reason. Remove every old importer; no shim, fallback copy or compatibility re-export. Leave unrelated format helpers and other fonts alone.
3. No test is deleted by the agent. List every test that only covers the deleted generator, subsetter or fonts in the PR body: its file, what it covers and the new test that replaces its coverage, if any. Stop for Adam to decide on those tests; no file is pre-approved for deletion. Retain product coverage for content, capture, lists, Unicode, images, print failures and cleanup against the new paths. Never discard a product assertion just because it inspected old PDF bytes; show its replacement or the deliberate P3/P4 behaviour decision. Update all docs still describing the old generator or bundled fonts, including the applicable invariant implementation/test pointers without weakening their rule.
4. npm run verify; node build.mjs --test; node tools/run-suites.mjs <out> 'print|export' --lanes 3; npm run test:desktop; full PC Electron smoke: node desktop/test/smoke.mjs --only-target dev, full count in the PR. Recheck printed output for script, gear/prop packing and shot lists on desktop and browser; show the new bundle no longer contains the old font payloads. If packaging changes, build a fresh package and inspect it too.

STRUCTURE SECTION MUST SAY
- "no structural change beyond removal of the replaced PDF path", every deleted module/asset/tool and its audited consumers, the test inventory awaiting Adam's decision and product coverage retained/replaced (no test deleted by the agent), licence disposition, code and bundle bytes removed, AQ-19 merge evidence, Adam's prior PC PDF approval, suite and full smoke results. Stop for Adam; do not merge.
```

## AQ-45 [x] Automatic layout rules for printed PDFs

Needs: AQ-43 merged (the browser print path and its fixtures). Adam asked for this on 2026-10-31 after checking exported PDFs by eye.
Files: tests/adapters/formats/fixtures/inspect-script-print.mjs and its print fixtures, one new test or browser suite that an existing CI job already runs, docs/architecture/print-layout.md and docs/architecture/testing.md.
**STOPS FOR ADAM only if** the check cannot run in an existing CI job without changing .github/workflows/ or adding a package.json dependency (both protected): then stop and report the options.

```text
Task: roadmap C6 follow-up. Printed PDFs are Chromium output of the P1/P2 HTML print pages (browser P4 now, desktop P3 later). inspect-script-print.mjs already prints the 18 script and list fixtures with Page.printToPDF and checks print media, horizontal clipping, cell wrapping, image bounds, page counts and page sizes, but only when someone runs it by hand. Turn it into an automatic check that runs in CI and add the layout rules below. No product or print CSS change in this task.

FILES TO READ
- docs/architecture/print-layout.md (layout rules, footers, page-break notes), docs/architecture/testing.md (how suites and CI pick tests), docs/architecture/ci.md.
- tests/adapters/formats/fixtures/inspect-script-print.mjs and the print fixtures it loads; the P1/P2 print page modules it renders.

DO
1. STEP 0: decide how to read the printed PDF's pages (text and its position per page). Use only what the repo already has (node:zlib for streams, the ToUnicode maps, the tagged-PDF structure Chromium writes with generateTaggedPDF, or Chromium itself). No new dependency. Say which in the PR body, and show it reads one fixture's pages correctly before writing rules.
2. Rules, each one checked on every fixture that can trigger it:
   a. No stranded heading: a scene heading, list group heading or section heading is never the last line of a page; the first line it introduces is on the same page.
   b. No split rows: a script row or list/table row starts and ends on the same page, unless that row alone is taller than a page (then say so in the result).
   c. Continued tables repeat their header row on every page they continue onto.
   d. Nothing clipped: every text line lies inside the page's printable area, on all four sides.
   e. No missing characters: no .notdef glyphs, and the fixture's text, including its non-Latin and emoji samples, appears in the PDF text.
   f. Footer page numbers and running title, where the print page defines them: present on every page and in order.
   g. Keep the existing checks: page counts, page size and orientation (portrait script, landscape shot list), print media, clipping, wrapping, images.
3. Prove each rule fails first: break one fixture or a scratch copy of the print CSS locally for each rule (for example, remove a keep-with-next or make a row too wide), show the failure, then revert. List the probes in the PR body.
4. Run it in CI on the Linux runners through an existing job (suite list or unit test that CI already runs). Keep Windows and Linux font differences from causing false failures: rules compare positions and order, never pixel images.
5. If a rule fails on today's output, do not loosen it and do not change the print CSS: stop, attach the failing fixture's PDF page and screenshot, and report it for Adam.
6. npm run verify; node build.mjs --test; the new check locally and in CI; node tools/run-suites.mjs <out> 'print|export' --lanes 3.

STRUCTURE SECTION MUST SAY
- "test-only, no product change", how the PDF pages are read, each rule and its fail-first probe, which CI job runs it and its run time, any rule failing on today's output (reported, not fixed).
```
