# Splitpage review policy

This applies to every PR into `4.0-development`. No 3.1.x release is planned before 4.0, so `3.1.x-development` takes no more bug fixes; a bug that also exists on 3.1.x is fixed on 4.0 under §2.

**Fast path.** Two kinds of PR get the automated checks and a quick read instead of the full process:
- docs-only PRs (CI's change classifier marks them as prose)
- dependency-baseline prunes whose diff only removes entries from `tools/dep-baseline.json`, with no source changes, no new exceptions and no gate configuration changes

Every other PR goes through the full process below.

## 1. The PR

- Each PR has one coherent purpose, normally within one ownership boundary. It may cross boundaries when the change needs it (a shared contract, a composition step like 2.5 in [milestone-2.md](milestone-2.md)). In that case the description names every affected consumer and says how their integration was verified.
- A behavior fix stays separate from a broad extraction. Unrelated cleanup goes in its own PR.
- The description briefly states:
  - what changes, and what must stay the same
  - which modules and shared interfaces it touches (ports, contracts, the saved-data shape)
  - how it was verified (checks, suites, runs, with pass counts)
  - for a user-visible fix, a "Suggested CHANGELOG line" (§7)

## 2. Where bugs get fixed

| The bug… | Fix it |
|---|---|
| was introduced by the current PR | inside that PR, before merge |
| already existed, in code a pending PR or milestone step is moving | after the move lands, in its own PR on 4.0, in the module that now owns the code, with a regression test written to fail first |
| already existed, in code nothing is moving | in its own PR on 4.0, with a regression test written to fail first |

A PR that moves code keeps the bugs it moves. Each one is filed as an issue and fixed by a later PR, never folded into the move.

## 3. Automated checks

- **CI on PRs into 4.0 and main** (the `gate` job): lint, type check, dependency gate, comment gate, the build with its `sw.js` stamp check, `test:all`, the core, content-security-policy and persistence browser suites. `docker.yml` runs when app or server inputs change.
- **Locally before review:** the browser suites for the affected areas, chosen with the change table in [testing.md](testing.md#what-to-run-for-which-change).
- **Full browser run before merge** for:
  - changes to `02-state.js` or its shim, `build.mjs`, or the test harness or driver
  - any change where the affected suites can't be chosen with confidence
- **Desktop smoke locally** when `desktop/` or main-process code changes.
- **Desktop smoke groups locally** when renderer code that the desktop app relies on changes. Run each matching group with `node desktop/test/smoke.mjs --only-target dev --only-group "<group>"`, after `node build.mjs`. The group is a case-insensitive substring of the group names. This rule exists because #351 changed only `src/legacy/share-actions.ts`, yet broke opening a second server's document in a desktop tab (#361), and nothing ran the smoke until a later desktop PR.

  | Change touches | Groups |
  |---|---|
  | The action registry, menu items, or the screen and overlay rules (`src/legacy/*-actions.ts`, `menu-items.ts`, `screen.ts`, `screen-state.ts`) | `open/`, `per-tab connections`, `unsaved-changes close`, `teleprompter`, `google drive` |
  | Connect, hosted or collaboration code (`13-hosted.js`, `13b-collaborate.js`, `20e-connect.js`) | `per-tab connections`, `draft: server document` |
  | Saving, document ids, drafts, history or recovery (`02b-doc-id.js`, `14-export.js`, `18-local-files.js`, `20g-drafts.js`, `src/adapters/storage/draft-store-*.ts`, `src/application/recovery/`, `03a-history-store.js`, `03c-history-idb.js`) | `open/save`, `save-in-place`, `duplicate document id`, `draft:`, `history:` |

  When code moves to a new owner, the rule follows the code, not the old file name. The PR records the groups run and their counts. A failure that also fails on the base becomes an issue, as in §6.
- Milestone gates follow §8.

## 4. Review

One independent reviewer: a session or agent that did not write the change. They read the diff, the surrounding code, its callers and its tests.

| Area | Questions |
|---|---|
| Correctness | Does it do what was asked? Are defaults and boundary conditions right? |
| Failure handling | What happens with empty input, missing data, errors, cancellation, or a repeated action? |
| Integration | Do callers, consumers, saved data and shared interfaces still agree? For cross-boundary PRs, was every listed consumer verified? |
| Modularity | Is this the right module for it? Does it add coupling or duplicate logic? |
| Tests | Would they fail for a plausible bug? Do they check what the user sees, using waits rather than sleeps? Are they in the right area folder? |
| Suite selection | Do the suites that were run match the change table, including dependent areas? Is a full run needed under §3? |
| User experience | For UI changes: are loading, empty, error, keyboard, focus and overlay states handled? |
| Dependency direction | Do new imports respect the layers? Is every accepted gate exception justified? |
| Core purity | Nothing the dependency gate bans: no clock reads, no ambient randomness, no platform globals. Time and randomness come in through the ports. Pure date operations are fine. |
| No comments | No authored comments anywhere, including workflow and config files |
| Behavior preservation | Does the refactor change behavior? Is every intended change called out and routed per §2? |
| Goldens | Are golden files changed only in a dedicated commit on `4.0-development` via `src/test/golden-helpers.mjs`, with the diff explained? |
| User-facing text | Do toasts and refusal messages, and the PR's suggested CHANGELOG line, match what the code actually does? The PR does not edit CHANGELOG or help.md (§7). |

## 5. Extra verification by risk

Every extra check names the failure it is meant to catch. If it can't name one, skip it.

| Change | Additional verification |
|---|---|
| Copy, styling, mechanical cleanup | Relevant checks; a screenshot for visible changes |
| Ordinary feature or bug fix | Focused behavior tests; a regression test, written to fail first, for any reproducible bug |
| Code moved verbatim or translated mechanically (to TypeScript, `let`/`const`), imports re-pointed | Enough existing behavior coverage before the move; golden tests where the outputs suit snapshots |
| A rewrite: the logic itself changes, not only its location or syntax | A differential test: the base commit's implementation and the new one run on seeded generated inputs, and their results must match |
| Parsing or transformation (text normalisers, richtext, import/export) | Property-based tests or seeded fuzzing |
| New core policy, or reviewer doubts the tests | Mutation testing (below) |
| Persistence, `migrateRows`, `mergeStates`, the merge algorithms in `src/core/merge/`, hosted roles and auth, concurrency, shared contracts | Integration and failure-path tests (save during load, conflicts, reload). The differential test is **mandatory** for `migrateRows`, `mergeStates` and the merge algorithms, even when the code only moves. |

- **Mutation testing:** plant the bugs only in a scratch copy, never in the lane's worktree. Look into every bug the tests don't catch and close the meaningful gaps. Record caught/total, and why each remaining one was accepted (for example, a change that can't alter behavior).
- **Fuzzing:** runs are seeded so results reproduce. A failing seed becomes a permanent regression case.

## 6. Findings

Each finding gives its location, the failure scenario, the consequence, and a suggested fix or verification.

- **Blocker:** a concrete defect, a broken requirement, or a violated architectural rule. Fix before merge.
- **Concern:** a plausible, significant risk. Close it with evidence, a fix, or a recorded decision.
- **Suggestion:** optional. Does not block the merge. May become a follow-up issue.

Severity follows impact, not the size of the mistake.

**Who decides:**
- Technical concerns: the coordinating session, with its reasoning written in the PR comment.
- Product behavior, user-facing wording and input syntax: Adam.

**Problems that existed before the PR** become an issue, not extra scope for the PR. The exception: if the PR depends on the problem, exposes it, or makes it worse, the problem is a finding of this PR and is handled here.

## 7. Fixes, evidence and merge

The lane that wrote the code fixes the findings. The reviewer then re-checks the fix diff and the behavior it affects. A full re-review happens only if the fix changed the approach.

**Merge when:**
- blockers are fixed and concerns are closed
- the final changes have been reviewed
- the evidence matches the PR's own latest head: the CI `gate` is green on it, and the base has been merged in only when the base merges rule below calls for it
- a short PR comment records:
  - the findings and how each was closed
  - the verification, with counts
  - the head and base SHAs the evidence covers
  - any accepted limitations

**Base merges.** Adam approved this rule on 2026-10-02, to cut the testing bottleneck. Merge the base into a PR branch only when:
- GitHub reports a conflict, or
- the base has changed files the PR touches.

Otherwise merge with CI green on the PR's own head, even though the base has moved. The safety net is CI on `4.0-development` after every merge, plus the milestone gate's full run on the merged tree (§8). When the base is merged in, push, so CI runs on the new combined tree. A re-run alone isn't enough, because it reuses the old merge commit. Local run evidence counts only for the tree it ran on.

**CHANGELOG and help are not edited in fix PRs.** Adam approved this rule on 2026-10-02. `CHANGELOG.md` and `docs/help.md` stay as the base has them. A user-visible fix puts a "Suggested CHANGELOG line" section in its PR body, in the existing entry style, or says "No CHANGELOG entry" and why. The coordinator writes every entry in one docs PR, and Adam signs off the wording there once, under "Wording for Adam's sign-off".

**CI unavailable vs. failing.** Failing checks never merge. If CI is *unavailable*, merging on local evidence needs:
- the exact tested revision and its logs
- Adam's okay, noted in the PR comment

Merge with `gh pr merge N --merge --match-head-commit <sha>`.

**Stopping rule:** once these conditions are met, merge. Another round or another test needs a named unresolved risk.

## 8. Milestone gates

- The runs required by [section 4 of the implementation plan](../IMPLEMENTATION-PLAN.md#4-verification-baseline-and-ci-policy), on the exact merged tree:
  - full browser regression on Windows, at every gate; on Linux too at the 4.0 release gate only
  - real Electron smoke, dev target, at every gate
  - Windows x64 packaged check, at the gates of milestones 3 and 4, at the gate of a milestone that switches the build entry or changes packaging inputs, and at the 4.0 release gate; the native ARM64 one too at the 4.0 release gate only

  Their recorded output is attached to the closing PR. A run that can't be done here is recorded as a blocker, and Adam decides whether the milestone closes without it.
- **External review** of the integrated milestone, at the gates of milestones 3, 4 and 6 and at the 4.0 release gate (Adam, 2026-10-07): by a different model or a person where possible, otherwise by a fresh agent not involved in building or reviewing it. The review states which kind it was. It covers the integrated architecture, behavior across modules, and the milestone's requirements in the plan. Its findings are handled under §6. At the release gate it also covers the milestones that had no review of their own.
- The milestone doc's "as built" section is updated and the dependency baseline is pruned.
