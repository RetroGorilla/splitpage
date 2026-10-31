# Roadmap

What is left for Splitpage 4.1 now that the restructure is done, and the order it runs in. Checked on 2026-10-30 at `06553015`. "4.1" is the internal name for this work (the `4.1-development` branch); it ships publicly as **4.0.0** (Adam, 2026-10-30). Agents: this file says where the work is going; [AGENT-QUEUE.md](AGENT-QUEUE.md) still decides what a queue agent picks, and its rules and protected paths still apply.

## Where it stands

The 4.1 restructure is finished. `src/js/` and `src/legacy/` are gone, there are no import loops, and the build starts from `src/bootstrap/main.ts`. The server and collaboration features were removed, not moved. Since then, the work has been about shipping: save fixes, a startup failure screen (#965), a release that needs a green CI run (#963) and real-app tests on PRs (#964).

Wave 1 below is mostly done. Merged: AQ-15, AQ-16 (#969), AQ-17, AQ-20 (#963), AQ-21 (#964), AQ-22 (#965, #968), AQ-24 (#959), AQ-25 (#973), AQ-28 (#976), AQ-30 (#975). Ready for Adam, not merged: the first test-hook PR of AQ-23 (#974) and AQ-31 (#980). In progress: AQ-32, which switches off import save-back. AQ-28 found that I-20 does not reproduce and kept the test as a regression test. AQ-29 (I-6) is replaced by AQ-32 and will not merge. Still open in wave 1: the later AQ-23 PRs, AQ-18 and AQ-26.

## Still to do for 4.1

Adam (2026-10-30): nothing is tagged yet; A, B and C below go into 4.1. The Unicode font in PDF export (AQ-16) merged as #969; C6 below later replaces the whole PDF generator.

"Protected" means the task touches a protected path in [AGENT-QUEUE.md](AGENT-QUEUE.md#autonomous-run-rules) (saving, desktop, undo and editing, startup, the project file format, merge, build rules), so it gets an independent Opus review and the PC checks, then stops for Adam's merge.

### A. Safety and known bugs

| Id | Task | Why | Size |
| --- | --- | --- | --- |
| A1 | Test hooks out of release builds (AQ-23). 21 `window.__*Test` hooks plus `__splitpageFormats` ship in the app (the list is in #974's step 0); `__historyTest` can wipe the history database. A build-time flag leaves them out of release builds; test jobs build the test variant. PR 1 (#974) is ready for Adam. The approved split of the rest: PR 2 undo, `documentGuard` and `splitpageFormats`; PR 3 desktop and the fake backend; PR 4a and 4b feature hooks; PR 5 render and blobs, with perf-ab; PR 6 fault-injection code out of the release bundle | Only item that touches user data | Medium, protected |
| A2 | Deferred bugs: I-20 (Save label after a late save) is closed as not reproducing (AQ-28, #976; the test stays as a regression test). I-6 (`saveBackToFile` on desktop) is replaced by A4. I-1 (#595, rows animate on open, cosmetic) waits for Adam's fix-or-close decision | Known user-visible bugs | Small |
| A3 | Flaky suites: 266 (I-30) fixed in AQ-30 (#975); desktop smoke #496 (I-5) fixed in AQ-31 (#980, ready for Adam, not merged). Fix the test's timing; never loosen an assertion | Flakes slow merges and hide real failures | Done except the merge of AQ-31 |
| A4 | Switch off import save-back (AQ-32). An import starts a separate Splitpage script and Splitpage never writes to the imported file; the code stays, marked deprecated. Replaces I-6: AQ-29 will not merge and #979 closes when AQ-32 merges | The writing-back path is where I-6 and its follow-up bug lived | Medium, protected, in progress |

### B. Finishing the structure

| Id | Task | Why | Size |
| --- | --- | --- | --- |
| B1 | Rest of the desktop split: IPC setup (AQ-35), then process lifecycle (start, close, quit), then voice, out of `desktop/main.js` ([desktop-build.md](architecture/desktop-build.md)) | Last large file where one change can break an unrelated one | Large, protected, one PR at a time |
| B2 | One owner decides when a save is complete ([saving.md](architecture/saving.md)) | The writer and the coordinator still confirm the same save separately; not a known bug | Medium, protected, **held by Adam** |
| B3 | Storage re-exports (AQ-19); rename the `"server"` merge kind to `"disk"` (AQ-33). Startup slots are decided and done: `startupReady` stays as it is, and the other two do-nothing slots already throw (#954) | Rule 4, and names left from collaboration | Small each; AQ-19 protected; the rename touches session and undo |

### C. Keeping the code easy to work on

| Id | Task | Why | Size |
| --- | --- | --- | --- |
| C1 | Rundown to TypeScript (AQ-26), then its state in one object (AQ-27), as #957 did for the row renderer. The prompter is done (AQ-24, #959; AQ-25, #973) | About 38 module-level variables left, in the rundown | Medium; AQ-26 and AQ-27 need perf-ab |
| C2 | Measure re-renders on stamp, hide and display settings (AQ-18). A fix, if one is over 65 ms, is a separate Opus task with perf-ab | Never timed | Small |
| C3 | CSS by purpose (AQ-34): merge and rename the 59 `styles-*.css` files (39 of them only numbered, such as `styles-3.css`) by feature, with the computed cascade unchanged and the visual suites green | They only work in one fixed load order | Medium, visual |
| C4 | Files over 1,000 lines and the 58 remaining JavaScript files, only when a change touches them (rule 11); AQ-14 (#950) reports which come next | Upkeep | As touched |
| C5 | Close stale tracker rows; close or retarget the old PRs on `main` (#547, #488, #489, #382) | Housekeeping | Small; the PRs need Adam |
| C6 | Rebuild PDF export as a print layout (I-34, Adam 2026-10-30): one HTML print page for the script, packing lists and shot list; the desktop app saves it with Electron's `printToPDF`, the browser opens its print dialog ("Save as PDF"). Then delete the hand-drawn generator in `pdf.ts` (1,786 lines), the font subsetter and the Noto fonts. Five tasks: P1 script print page and P2 list print pages (not wired, queue agents merge); P3 desktop `printToPDF` (protected); P4 browser print dialog; P5 delete the old generator. P3 to P5 stop for Adam | Every language works with the computer's fonts; removes the second-largest file and ~1.2 MB of fonts. Costs: Chromium decides page breaks (no "cont." label on continued rows), bookmarks only on desktop, browser users pick "Save as PDF" | Large; P3 protected |

### D. New features (not in 4.1 unless Adam says so)

- I-31 Section Headers: organise a script's sections into scenes. Needs a design.
- I-32 Script title from the file name on first save, with a small version tag such as "v3". Protected (first save).
- I-33 Clicking the tag button with nothing selected inserts an open tag at the cursor. Editing path, needs perf-ab.
- Collaboration rebuilt with Yjs. Held by Adam.

## Game plan for A, B and C

All of A, B and C go through the agent queue, starting now. Lanes in one wave run at the same time because they do not share files. Each lane is one queue agent working its items in order. **Opus** means the agent runs on Opus: required for protected paths, the typing and undo path, and every review of that work. The protected-path rules still hold: a protected PR gets an independent review, then stops for Adam's merge. **PC** is a check only Adam's PC runs: desktop smoke (794 checks) or perf-ab.

| Wave | Lane | Work | Model and checks | Needs first | Adam's input |
| --- | --- | --- | --- | --- | --- |
| 1, mostly done | 1 | A1: step 0 lists every hook, then PR 1 (flag, `__historyTest`, release-build check), then follow-ups. PR 1 (#974) is ready for Adam | Opus; protected; PC smoke on test and release builds | none | Merge approval for #974 |
| 1 | 2 | A2: I-20 closed as not reproducing (AQ-28, #976). A4 (AQ-32) switches off import save-back and replaces I-6 (AQ-29 will not merge). I-1 waits for Adam | Opus; AQ-32 protected with PC smoke; I-1 perf-ab | none | Fix or close I-1; merge approval for AQ-32 |
| 1 | 3 | A3 suite 266 (AQ-30, #975, merged) and smoke #496 (AQ-31, #980, ready for Adam); C2 measure (AQ-18); C1 AQ-26 (AQ-25 merged, #973); C5 tracker | Any model; AQ-26 on Opus with perf-ab on the PC | none | Merge approval for AQ-31; close or retarget the old `main` PRs |
| 1 | 4 | AQ-16 Unicode font in PDF export (merged, #969); report-only AQ-6 and AQ-14 (#950) alongside | Any model | none | none left for AQ-16 |
| 2, after wave 1 | 1 | B3 rename `"server"` to `"disk"` (AQ-33). Startup slots are decided and done (#954), so no task | Opus (session and undo); protected; independent review | AQ-32 merged | Merge approval |
| 2 | 2 | B3 storage re-exports (AQ-19) | Any model; protected, Opus review | AQ-16 merged (both touch `pdf.ts`; met) | Merge approval |
| 2 | 3 | C1 AQ-27; C3 CSS by purpose (AQ-34) | AQ-27 on Opus with perf-ab; CSS visual suites | AQ-26 (AQ-27); A1's PR 1 merged (AQ-34, test-build switch) | none |
| 3, one at a time | 1 | B1 desktop split: IPC (AQ-35), then lifecycle, then voice | Opus; protected; PC smoke on every PR | A1's PR 1 and AQ-32 merged | Merge approval for each |
| 3 | 1 | B2 save completion owner, after B1's lifecycle PR | Opus; protected; PC smoke | AQ-32 merged | Lift or keep the hold |
| 3 | 2 | C2 fix if over budget; C4 as touched | A C2 fix on Opus with perf-ab | C2 measurement; AQ-14 | none |
| 3 | 3 | C6 PDF rebuild: P1 and P2, then P3 and P4, then P5 | Any model for P1, P2 and P4; Opus for P3 and its review; PC smoke on P3 | B1's IPC PR before P3 (both add desktop IPC); AQ-19 before P5 (both touch `pdf.ts`) | Merge approval for P3 to P5; check the new PDFs on the PC before P5 |

Merge order: PRs on different files merge freely; PRs sharing files merge one at a time, each taking the base branch first. A1 and C3 both touch the build; AQ-16, AQ-19 and C6 all touch `pdf.ts`; B1 and C6's P3 both touch desktop IPC; AQ-32, B2 and B1's lifecycle PR all touch saving or close, which is why they sit in different waves or one after another in the same lane.

Items without an `AQ-n` id yet (B1's lifecycle and voice steps, B2, C5, C6) are added to [AGENT-QUEUE.md](AGENT-QUEUE.md) with an `AQ-add:` PR when their wave starts, each with its "Needs" line, its model, and `STOPS FOR ADAM` where it is protected.

## Releasing 4.0.0 (last step, when Adam calls it)

1. Freeze agent-queue merges, so the checked commit is the tagged one.
2. Version bump PR: `VERSION`, `desktop/package.json` and its lockfile go to `4.0.0`, plus `sw.js`, the CHANGELOG heading, the Help heading and README. How to release: [RELEASING.md](RELEASING.md).
3. Full browser suites, PC desktop smoke and perf-ab on the bump commit, then tag.
