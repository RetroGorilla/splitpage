# Roadmap

Where Splitpage is going after the 4.1 restructure, and the order the remaining work runs in. Checked on 2026-10-30 at `c98f71d1`. Agents: this file says where the work is going; [AGENT-QUEUE.md](AGENT-QUEUE.md) still decides what a queue agent picks, and its rules and protected paths still apply.

## Where it stands

The 4.1 restructure is finished. `src/js/` and `src/legacy/` are gone, there are no import loops, and the build starts from `src/bootstrap/main.ts`. The server and collaboration features were removed, not moved. Since then, the work has been about shipping: save fixes, a startup failure screen (#965), a release that needs a green CI run (#963) and real-app tests on PRs (#964).

## Before the 4.1.0 tag

1. Unicode font in PDF export (AQ-16). Adam put it in 4.1. It is not started.
2. Freeze agent-queue merges, so the checked commit is the tagged one.
3. Version bump PR: `VERSION`, `desktop/package.json` and its lockfile go to `4.1.0`, plus `sw.js`, the CHANGELOG heading, the Help heading and README. How to release: [RELEASING.md](RELEASING.md).
4. Full browser suites, PC desktop smoke and perf-ab on the bump commit, then tag.

No item below starts before the tag, except the report-only tasks in wave 0.

## After 4.1

"Protected" means the task touches a protected path in [AGENT-QUEUE.md](AGENT-QUEUE.md#autonomous-run-rules) (saving, desktop, undo and editing, startup, the project file format, merge, build rules), so it stops for Adam, an Opus review and the PC checks.

### A. Safety and known bugs

| Id | Task | Why | Size |
| --- | --- | --- | --- |
| A1 | Test hooks out of release builds (AQ-23). About 13 `window.__*Test` hooks ship in the app; `__historyTest` can wipe the history database. A build-time flag leaves them out of release builds; test jobs build the test variant | Only item that touches user data | Medium, protected |
| A2 | Deferred bugs, one PR each: I-20 (Save label after a late save), I-6 (`saveBackToFile` on desktop), I-1 (#595, rows animate on open, cosmetic) | Known user-visible bugs | Small each; I-6 protected |
| A3 | Flaky suites: 266 fails about 40% alone (I-30); desktop smoke #496 (I-5). Fix the test's timing; never loosen an assertion | Flakes slow merges and hide real failures | Small each |

### B. Finishing the structure

| Id | Task | Why | Size |
| --- | --- | --- | --- |
| B1 | Rest of the desktop split: IPC setup, then process lifecycle (start, close, quit), then voice, out of `desktop/main.js` ([desktop-build.md](architecture/desktop-build.md)) | Last large file where one change can break an unrelated one | Large, protected, one PR at a time |
| B2 | One owner decides when a save is complete ([saving.md](architecture/saving.md)) | The writer and the coordinator still confirm the same save separately; not a known bug | Medium, protected, **held by Adam** |
| B3 | Storage re-exports (AQ-19); rename the `"server"` merge kind to `"disk"`; startup slots after the AQ-6 report | Rule 4, and names left from collaboration | Small each; AQ-19 protected; the rename touches session and undo |

### C. Keeping the code easy to work on

| Id | Task | Why | Size |
| --- | --- | --- | --- |
| C1 | Rundown to TypeScript (AQ-26), then prompter and rundown state each in one object (AQ-25, AQ-27), as #957 did for the row renderer | About 48 and 38 module-level variables | Medium; AQ-26 and AQ-27 need perf-ab |
| C2 | Measure re-renders on stamp, hide and display settings (AQ-18). A fix, if one is over 65 ms, is a separate Opus task with perf-ab | Never timed | Small |
| C3 | CSS by purpose: merge and rename the 59 `styles-*.css` files (39 of them only numbered, such as `styles-3.css`) by feature, with the computed cascade unchanged and the visual suites green | They only work in one fixed load order | Medium, visual |
| C4 | Files over 1,000 lines and the 58 remaining JavaScript files, only when a change touches them (rule 11); AQ-14 (#950) reports which come next | Upkeep | As touched |
| C5 | Close stale tracker rows; close or retarget the old PRs on `main` (#547, #488, #489, #382) | Housekeeping | Small; the PRs need Adam |

### D. New features (not planned yet)

- I-31 Section Headers: organise a script's sections into scenes. Needs a design.
- I-32 Script title from the file name on first save, with a small version tag such as "v3". Protected (first save).
- I-33 Clicking the tag button with nothing selected inserts an open tag at the cursor. Editing path, needs perf-ab.
- Collaboration rebuilt with Yjs. Held by Adam.

## Game plan for A, B and C

Three waves after the tag. Lanes in one wave run at the same time because they do not share files. **T3** is the agent queue (unprotected work it merges itself). **Opus** is an Opus thread (protected paths, every protected review, the typing and undo path). **PC** is a check only Adam's PC runs: desktop smoke (794 checks) or perf-ab.

**Wave 0, now (during the freeze):** report-only tasks AQ-6 (startup slots) and AQ-14 (#950). They change no code. Their reports feed B3 and C4.

| Wave | Lane | Work | Who | Needs first | Adam's input |
| --- | --- | --- | --- | --- | --- |
| 1, after the tag | Opus 1 | A1: step 0 lists every hook, then PR 1 (flag, `__historyTest`, release-build check), then follow-ups | Opus; PC smoke on test and release builds | 4.1 tagged | Merge approval; the PR split after step 0 |
| 1 | Opus 2 | A2: I-20, then I-6; I-1 only if Adam wants it | Opus; I-6 PC smoke; I-1 perf-ab | none | Fix or close I-1; merge approval for I-6 |
| 1 | T3 | A3 suite 266; C2 measure (AQ-18); C1 AQ-26 then AQ-25; C5 tracker | T3; AQ-26 perf-ab on the PC | none | Close or retarget the old `main` PRs |
| 2, after wave 1 | Opus 1 | B3 rename `"server"` to `"disk"`; then startup slots per AQ-6 | Opus | I-6 merged; AQ-6 report | `startupReady`: leave it, or change the prompter launch |
| 2 | T3 + Opus review | B3 storage re-exports (AQ-19) | T3 writes, Opus reviews | none | Merge approval |
| 2 | T3 | C1 AQ-27; C3 CSS by purpose | T3; AQ-27 perf-ab; CSS visual suites | AQ-26; A1 merged (test-build switch) | none |
| 3, one at a time | Opus | B1 desktop split: IPC, then lifecycle, then voice | Opus; PC smoke on every PR | A1 and I-6 merged | Merge approval for each |
| 3 | Opus | B2 save completion owner | Opus; PC smoke | I-6 merged; not alongside B1's lifecycle PR | Lift or keep the hold |
| 3 | any | C2 fix if over budget; C4 as touched | Opus + perf-ab for a C2 fix | C2 measurement; AQ-14 | none |

Merge order: PRs on different files merge freely; PRs sharing files merge one at a time, each taking the base branch first. A1 and C3 both touch the build; I-6, B2 and B1's lifecycle PR all touch saving or close, which is why they sit in different waves.

Tasks in this plan that have no `AQ-n` id yet (A2, A3, B3's rename and startup slots, C3, C5, B1, B2) are added to the queue with an `AQ-add:` PR when their wave starts, or given to an Opus thread.
