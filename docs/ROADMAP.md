# Roadmap

First refresh pass checked against GitHub, source and merge history at `fa88f976` on 2026-11-08. GitHub issues hold the current backlog. Recheck them before starting work. A second documentation pass is planned just before 0.4.3; this page describes only merged behaviour as done.

## Current release

Splitpage **0.4.1** was released on **2026-11-02**, tagged [v0.4.1](https://github.com/RetroGorilla/splitpage/releases/tag/v0.4.1). `VERSION` and `desktop/package.json` still say `0.4.1`. Changes merged after that tag are development work; they are not in the published release.

The next release is **0.4.3**. It has no release date here. The old plans used “3.x”, “4.0” and “4.1” as milestone names. The remote tags now use `v0.3.*` and `v0.4.*`. Use the remote tags and [releases](https://github.com/RetroGorilla/splitpage/releases), rather than old plan headings, for shipped versions.

## Completed foundation

| Work | Evidence |
| --- | --- |
| Architecture milestones 0–7 and the later legacy reduction. The build starts at `src/bootstrap/main.ts`; `src/js/` and `src/legacy/` are gone. Server and collaboration features were removed. | #906, #905; [implementation record](IMPLEMENTATION-PLAN.md) |
| Queue AQ-1–AQ-46 completed or closed. AQ-29 was replaced by AQ-32. Desktop voice extraction AQ-37 is merged, not waiting. | #1037 (closed summary); #982, #1016 |
| Shipped source converted to strict TypeScript. Generated JavaScript and `sw.js` remain. | #1042–#1079, #1082–#1118; [performance record](architecture/performance-record.md#typescript-conversion-e44e1d03-to-fd29b083) |
| Print-based PDF output and automatic layout checks replaced the old PDF generator. | #994, #998, #1015, #1000, #1004, #1024 |
| Scene headers, first-save title/version naming, and open tags. | #1028, #1029, #1031, #1027, #1026 |
| The default performance run reaches its images fixture again. | #1039, fixed by #1121 |

## Merged since 0.4.1, not yet released

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
| Browser target activation and stale browser-suite selectors fixed. | #1304, #1315, #1316 |
| Comment identity preferences update everywhere; unnamed-scene labels use their letter. | #1299, #1298 |
| Microphone selection, desktop-to-browser relay choice, and `@Name` assignment while tagging. | #1256, #1258, #1259, #1292 |
| Export dialog and Help explain Create bundle before exporting outside files. | #260 item 4; #1329 |
| Local media-heavy test bundle generator (developer tooling, not a starter or release asset). | #1325 via #1330; [usage](DEVELOPING.md#media-heavy-test-bundles) |

Scene descriptions (#1171) were closed as not planned. They are not queued work.

## Planned before 0.4.3

- [#1264](https://github.com/RetroGorilla/splitpage/issues/1264): awaiting-tag underline at the caret.
- [#1159](https://github.com/RetroGorilla/splitpage/issues/1159): Shoot view scene cells.
- [#1201](https://github.com/RetroGorilla/splitpage/issues/1201): nested tags, planned as three PRs.
- [#1163](https://github.com/RetroGorilla/splitpage/issues/1163): Settings revamp and File menu placement.
- [#1326](https://github.com/RetroGorilla/splitpage/issues/1326): keep the Scene prep detail open and focused during rename.
- [#1023](https://github.com/RetroGorilla/splitpage/issues/1023): more writing space in printed lists' Notes cells.
- [#1288](https://github.com/RetroGorilla/splitpage/issues/1288): bind the desktop installer to its release metadata.
- [#1327](https://github.com/RetroGorilla/splitpage/issues/1327): this documentation refresh, with a second pass just before release.

These are plans, not descriptions of the current app. Do not document their unmerged behaviour as available.

## Parked and manual checks

[#1177](https://github.com/RetroGorilla/splitpage/issues/1177) (Follow My Voice responsiveness) and the [review-mode-later issues](https://github.com/RetroGorilla/splitpage/issues?q=is%3Aissue%20state%3Aopen%20label%3Areview-mode-later) are parked. Review mode and collaboration remain removed.

Real-microphone verification remains a manual check: the automated relay/device tests do not prove recognition with a physical microphone. Keep the outstanding platform checks in [WINDOWS-CHECKS.md](WINDOWS-CHECKS.md) explicit when preparing the release.

## Before starting

Read `AGENTS.md`, the issue and its latest owner decisions. The [old queue](AGENT-QUEUE.md) is finished. Historical plans and test records do not authorize new work. Use [RELEASING.md](RELEASING.md) when Adam calls a release.
