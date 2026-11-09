# Roadmap

Final pre-0.4.3 documentation pass checked against GitHub, source and merge history at `8d607637` on 2026-11-09. GitHub issues hold the current backlog. Recheck them before starting work. This page describes only merged behaviour as done.

## Current release

Splitpage **0.4.3** was released on **2026-11-09**, tagged [v0.4.3](https://github.com/RetroGorilla/splitpage/releases/tag/v0.4.3). There is no 0.4.2; 0.4.1 was released on 2026-11-02. Changes merged after the v0.4.3 tag are development work; they are not in the published release.

The old plans used “3.x”, “4.0” and “4.1” as milestone names. The remote tags now use `v0.3.*` and `v0.4.*`. Use the remote tags and [releases](https://github.com/RetroGorilla/splitpage/releases), rather than old plan headings, for shipped versions.

## Completed foundation

| Work | Evidence |
| --- | --- |
| Architecture milestones 0–7 and the later legacy reduction. The build starts at `src/bootstrap/main.ts`; `src/js/` and `src/legacy/` are gone. Server and collaboration features were removed. | #906, #905; [implementation record](IMPLEMENTATION-PLAN.md) |
| Queue AQ-1–AQ-46 completed or closed. AQ-29 was replaced by AQ-32. Desktop voice extraction AQ-37 is merged, not waiting. | #1037 (closed summary); #982, #1016 |
| Shipped source converted to strict TypeScript. Generated JavaScript and `sw.js` remain. | #1042–#1079, #1082–#1118; [performance record](architecture/performance-record.md#typescript-conversion-e44e1d03-to-fd29b083) |
| Print-based PDF output and automatic layout checks replaced the old PDF generator. | #994, #998, #1015, #1000, #1004, #1024 |
| Scene headers, first-save title/version naming, and open tags. | #1028, #1029, #1031, #1027, #1026 |
| The default performance run reaches its images fixture again. | #1039, fixed by #1121 |

## Released in 0.4.3

| Work | Evidence |
| --- | --- |
| Scene/beat terminology and numbering; Scene prep production outline. | #1186, #1190, #1191, #1215 |
| Flow Writer replaced the old Writer. | #264, #1238; [design and measured results](WRITER-FLOW-PLAN.md) |
| The shared top bar meets all six requests, including the save status. #1167 is closed as completed. | [Adam's decision](https://github.com/RetroGorilla/splitpage/issues/1167#issuecomment-6730027512) |
| Attach files, copy local files beside the script, and carry bundled files on Save As. | #1277, #1267, #1281 |
| Export with files and confirmed Replace. Attach offers Copy / Move / Leave. Create bundle gathers outside files. | #260 items 1–3; #1294, #1310, #1311, #1319 |
| Scene header styling and in-place naming. | #1168 via #1313; #1166 via #1318 |
| By scene grouping in B-roll, Comments, Production and Gear. Items repeat in every scene that uses them; unplaced entries follow under No scene. | #1170; #1317, #1322 |
| Open-tag highlight, keyword suggestions, video-merge review, save/undo ownership, and thumbnail-merge fixes. | #1303, #1308, #1309, #1312, #1314 |
| An underline marks an open tag awaiting its name at the caret. | #1264 via #1331 |
| Browser target activation and stale browser-suite selectors fixed. | #1304, #1315, #1316 |
| Comment identity preferences update everywhere; unnamed-scene labels use their letter. | #1299, #1298 |
| Microphone selection, desktop-to-browser relay choice, and `@Name` assignment while tagging. | #1256, #1258, #1259, #1292 |
| Export dialog and Help explain Create bundle before exporting outside files. | #260 item 4; #1329 |
| Local media-heavy test bundle generator (developer tooling, not a starter or release asset). | #1325 via #1330; [usage](DEVELOPING.md#media-heavy-test-bundles) |
| Shoot view beats grouped under scenes in responsive cells, with filmed and current indicators. | #1159 via #1332 |
| Nested tags preserved through saves, clipboard, undo and merge; shown in production and exports; created while typing or through Edit tag / Done. | #1201 via #1336, #1343, #1346 |
| Hide filmed beats beside the filmed count, Minimise / Show rundown, and Present ▸ Present in browser…; regrouped File menu and Help submenu. | #1163 via #1338, #1345 |
| Scene prep keeps an item's detail open and focus on the item after renaming. | #1326 via #1337 |
| Printed shot-list Notes lines spaced 8 mm apart for handwriting. | #1023 via #1334 |
| Desktop updates verify installer release name, tag, API digest and size. | #1288 via #1335 |
| Production and Gear By-scene views reuse cached document numbering. | #1344 via #1347 |
| Printed-output wording and beat multi-selection browser suites brought up to date. | #1339 via #1340; #1341 via #1342 |
| Roadmap, Help and contributor documentation refreshes. | #1327 via #1333, #1349 |

Scene descriptions (#1171) were closed as not planned. They are not queued work.

## Parked and manual checks

[#1177](https://github.com/RetroGorilla/splitpage/issues/1177) (Follow My Voice responsiveness) and the [review-mode-later issues](https://github.com/RetroGorilla/splitpage/issues?q=is%3Aissue%20state%3Aopen%20label%3Areview-mode-later) are parked. Review mode and collaboration remain removed.

Collaboration has started with the Stage 0 audit ([#1364](https://github.com/RetroGorilla/splitpage/issues/1364)); its artifacts are collected in [collaboration/stage-0](collaboration/stage-0/README.md). Nothing is built. [COLLABORATION-PLAN.md](COLLABORATION-PLAN.md) is the plan of record, Yjs on a self-hosted server.

Real-microphone verification remains a manual check: the automated relay/device tests do not prove recognition with a physical microphone. Keep the outstanding platform checks in [WINDOWS-CHECKS.md](WINDOWS-CHECKS.md) explicit when preparing the release.

## Before starting

Read `AGENTS.md`, the issue and its latest owner decisions. The [old queue](AGENT-QUEUE.md) is finished. Historical plans and test records do not authorize new work. Use [RELEASING.md](RELEASING.md) when Adam calls a release.
