# Roadmap

What is left for Splitpage 4.1 and the order it runs in. Checked on 2026-10-31 at `99cc8bfd`. "4.1" is the internal name for this work (the `4.1-development` branch); it ships publicly as **4.0.0** (Adam, 2026-10-30). Agents: this file says where the work is going; [AGENT-QUEUE.md](AGENT-QUEUE.md) still decides what a queue agent picks, and its rules and protected paths still apply.

## Where it stands

The 4.1 restructure is finished: `src/js/` and `src/legacy/` are gone, there are no import loops, and the build starts from `src/bootstrap/main.ts`. The server and collaboration features were removed, not moved.

Groups A, B and C below are done except the last PDF step (AQ-44) and AQ-46, which Adam placed last in line. Every queue task from AQ-1 to AQ-45 is merged or closed except AQ-44; AQ-29 was replaced by AQ-32. Nothing is tagged yet.

## Done for 4.1

| Id | What | PRs |
| --- | --- | --- |
| A1 | Release builds expose no test hook (AQ-23, PRs 1 to 5). The history fault-injection code still ships unreachable; moving it out is AQ-46 | #974, #985, #990, #999, #1011, #1014 |
| A2 | I-20 (Save label after a late save) does not reproduce; its test stays as a regression test (AQ-28). I-6 is moot: import save-back is switched off and the code is marked deprecated (AQ-32, which replaced AQ-29) | #976, #982 |
| A3 | Flaky suite 266 (AQ-30) and desktop smoke #496 (AQ-31) fixed in the tests' timing; no assertion loosened | #975, #980 |
| B1 | Desktop split: IPC setup in seven parts (AQ-35), process lifecycle (AQ-36) and voice (AQ-37) moved out of `desktop/main.js`, now 1,810 lines | #1002, #1005 to #1010, #1013, #1016 |
| B2 | One owner decides when a save is complete (AQ-38) | #1019 |
| B3 | Storage re-exports gone (AQ-19); the `"server"` merge kind is now `"disk"` (AQ-33); startup slots decided (#954) | #993, #989 |
| C1 | Prompter and rundown in strict TypeScript, each with its state in one object (AQ-24 to AQ-27) | #959, #973, #988, #997 |
| C2 | Re-renders on stamp, hide and display settings measured: all under 65 ms, no fix needed (AQ-18) | #987 |
| C3 | CSS by purpose: 11 stylesheets named by what they style, cascade unchanged (AQ-34) | #986 |
| C5 | Stale tracker rows closed and the old `main` PRs listed for Adam (AQ-39) | #996 |
| C6 | PDF export as a print layout: script and list print pages (AQ-40, AQ-41), desktop `printToPDF` (AQ-42), browser print dialog (AQ-43), automatic layout checks in CI (AQ-45), plus Adam's print fixes (rows kept together, shot scenes as grey rows, desktop footer accepted as INV-61) | #994, #998, #1015, #1000, #1004, #1012, #1022, #1021 |
| | Also merged: Unicode PDF font (AQ-16), PDF text and JPEG fixes (AQ-15), release needs green CI (AQ-20), real-app tests on PRs (AQ-21), startup failure screen (AQ-22). Reports AQ-6 and AQ-14 read and closed by Adam | #969, #961, #963, #964, #965, #1001, #950 |

## Still to do for 4.1

| Item | What | State | Adam's input |
| --- | --- | --- | --- |
| C6 P5 | Delete the old PDF generator in `pdf.ts` (1,787 lines), the font subsetter and the Noto fonts (AQ-44). Adam checked the new PDFs on browser and desktop on 2026-10-31 | In progress, #1024 (draft); protected | Decide on the old-generator tests it lists; merge approval |
| A1 end | History fault injection out of release builds (AQ-46): two TypeScript conversions, then the move | Last in line, after AQ-44; protected | Merge approval for each PR |
| C4 | Files over 1,000 lines and the 57 remaining JavaScript files, only when a change touches them (rule 11) | As touched | none |
| C5 end | Old PRs on `main`: #547, #488 and #489 are still open (#382 is closed) | Waiting | Close or retarget them |
| I-1 | Rows animate when a document opens (#595), cosmetic | Waiting | Fix or close |

"Protected" means the task touches a protected path in [AGENT-QUEUE.md](AGENT-QUEUE.md#autonomous-run-rules), so it gets an independent review and the PC checks, then stops for Adam's merge.

## New features (not in 4.1 unless Adam says so)

- I-31 Section Headers: organise a script's sections into scenes. Needs a design.
- I-32 Script title from the file name on first save, with a small version tag such as "v3". Protected (first save).
- I-33 Clicking the tag button with nothing selected inserts an open tag at the cursor. Editing path, needs perf-ab.
- Collaboration rebuilt with Yjs. Held by Adam.

## Releasing 4.0.0 (last step, when Adam calls it)

1. Freeze agent-queue merges, so the checked commit is the tagged one.
2. Version bump PR: `VERSION`, `desktop/package.json` and its lockfile go to `4.0.0`, plus `sw.js`, the CHANGELOG heading, the Help heading and README. How to release: [RELEASING.md](RELEASING.md).
3. Full browser suites, PC desktop smoke and perf-ab on the bump commit, then tag.
