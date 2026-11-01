# Roadmap

What is left for Splitpage 4.1 and the order it runs in. Checked on 2026-11-01 at `022d36a7`. "4.1" is the internal name for this work (the `4.1-development` branch); it ships publicly as **4.0.0** (Adam, 2026-10-30). Agents: this file says where the work is going; [AGENT-QUEUE.md](AGENT-QUEUE.md) still decides what a queue agent picks, and its rules and protected paths still apply.

## Where it stands

The 4.1 restructure is finished: `src/js/` and `src/legacy/` are gone, there are no import loops, and the build starts from `src/bootstrap/main.ts`. The server and collaboration features were removed, not moved.

Groups A, B and C below are done. Every queue task from AQ-1 to AQ-46 is merged or closed; AQ-29 was replaced by AQ-32. The run is recorded in summary PR #1037, which was closed without merging once it had been read. Adam also brought three new features into 4.1 (I-31, I-32, I-33), and they are merged. The JavaScript app files under `src/` are now strict TypeScript, apart from nine tracked below. Nothing is tagged yet.

## Done for 4.1

| Id | What | PRs |
| --- | --- | --- |
| A1 | Release builds expose no test hook (AQ-23, PRs 1 to 5), and history's fault-injection code is out of release builds too (AQ-46: two TypeScript conversions, then the move) | #974, #985, #990, #999, #1011, #1014, #1033, #1034, #1036 |
| A2 | I-20 (Save label after a late save) does not reproduce; its test stays as a regression test (AQ-28). I-6 is moot: import save-back is switched off and the code is marked deprecated (AQ-32, which replaced AQ-29) | #976, #982 |
| A3 | Flaky suite 266 (AQ-30) and desktop smoke #496 (AQ-31) fixed in the tests' timing; no assertion loosened | #975, #980 |
| B1 | Desktop split: IPC setup in seven parts (AQ-35), process lifecycle (AQ-36) and voice (AQ-37) moved out of `desktop/main.js`, now 1,810 lines | #1002, #1005 to #1010, #1013, #1016 |
| B2 | One owner decides when a save is complete (AQ-38) | #1019 |
| B3 | Storage re-exports gone (AQ-19); the `"server"` merge kind is now `"disk"` (AQ-33); startup slots decided (#954) | #993, #989 |
| C1 | Prompter and rundown in strict TypeScript, each with its state in one object (AQ-24 to AQ-27) | #959, #973, #988, #997 |
| C2 | Re-renders on stamp, hide and display settings measured: all under 65 ms, no fix needed (AQ-18) | #987 |
| C3 | CSS by purpose: 11 stylesheets named by what they style, cascade unchanged (AQ-34) | #986 |
| C4 | The remaining JavaScript app files under `src/` converted to strict TypeScript at Adam's request, types only, apart from the nine listed under "Still to do" | The run #1042 to #1079 |
| C5 | Stale tracker rows closed and the old `main` PRs listed for Adam (AQ-39); Adam closed the old `main` PRs #547, #488, #489 and #382 | #996 |
| C6 | PDF export as a print layout: script and list print pages (AQ-40, AQ-41), desktop `printToPDF` (AQ-42), browser print dialog (AQ-43), automatic layout checks in CI (AQ-45), the old PDF generator, font subsetter and Noto fonts deleted (AQ-44), plus Adam's print fixes (rows kept together, shot scenes as grey rows, desktop footer accepted as INV-61) | #994, #998, #1015, #1000, #1004, #1024, #1012, #1022, #1021 |
| I-1 | Rows animating when a document opens (#595): closed by Adam, who will open an issue if he sees it again | none |
| I-31 | Section Headers: divider rows between scenes, with a name and a running total; double Backspace removes a header. Model, editor, then print, PDF, Word, Markdown, rundown and Present output | #1028, #1029, #1031 |
| I-32 | The first save takes the script title, and a version tag such as "v3", from the file name | #1027 |
| I-33 | The tag button with nothing selected starts an open tag at the cursor | #1026 |
| Fixes | Desktop smoke no longer flakes on the moved-file "asks again" group: the test waits for the file to open before moving it (#1035). Row merge keeps a scene reorder made on one side when the other side did not reorder (#1030). Loading a document makes duplicate row ids unique, so a malformed file can no longer lose or repeat a row in a merge (#1041) | #1038, #1040, #1048 |
| | Also merged: Unicode PDF font (AQ-16), PDF text and JPEG fixes (AQ-15), release needs green CI (AQ-20), real-app tests on PRs (AQ-21), startup failure screen (AQ-22), CI uploads the built app on pushes only (#1032). Reports AQ-6 and AQ-14 read and closed by Adam | #969, #961, #963, #964, #965, #1032, #1001, #950 |

## Still to do for 4.1

| Item | What | State | Adam's input |
| --- | --- | --- | --- |
| C4 | Files over 1,000 lines, only when a change touches them (rule 11) | As touched | none |
| Nine JavaScript files | They stay JavaScript until the contracts they cross are typed: `session-merge` (#1062); `file-menu`, `export-dialog`, `features/file-menu/local-files` and `adapters/files/local-files` (#1071); `cell-clipboard`, `scene-clip`, `scene-select` and `imports` (#1072) | Filed | none |
| AQ-37 check | Real-microphone check of desktop voice (#1016), `WINDOWS-CHECKS.md` §3 | Waiting | Run it on his PC |
| #1049 | Rows with no id get a different id on every load, so draft recovery can duplicate them | Filed | Whether to fix it for 4.1 |
| #1039 | `perf-ab`'s images fixture calls a removed test hook, so the default run stops; `--only short,long` works | Filed | none |
| #1023 | Notes handwriting lines in printed PDFs are too close together | Parked by Adam for the later PDF layout work | none |

"Protected" means the task touches a protected path in [AGENT-QUEUE.md](AGENT-QUEUE.md#autonomous-run-rules), so it gets an independent review and the PC checks, then stops for Adam's merge.

## New features (not in 4.1 unless Adam says so)

- Collaboration rebuilt with Yjs. Held by Adam.

I-31, I-32 and I-33 were here; Adam brought them into 4.1 and they are listed under Done.

## Releasing 4.0.0 (last step, when Adam calls it)

1. Freeze agent-queue merges, so the checked commit is the tagged one.
2. Version bump PR: `VERSION`, `desktop/package.json` and its lockfile go to `4.0.0`, plus `sw.js`, the CHANGELOG heading, the Help heading and README. How to release: [RELEASING.md](RELEASING.md).
3. Full browser suites, PC desktop smoke and perf-ab on the bump commit, then tag.
